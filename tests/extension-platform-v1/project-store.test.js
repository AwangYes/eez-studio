"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const projectRoot = path.resolve(__dirname, "../..");
const undoManagerModule = require(path.join(
    projectRoot,
    "build/project-editor/store/undo-manager.js"
));
const atomicWriteModule = require(path.join(
    projectRoot,
    "build/project-editor/store/atomic-write.js"
));
const projectServiceUtils = require(path.join(
    projectRoot,
    "build/home/extensions-v1/project-service-utils.js"
));

function createUndoHarness(UndoManager) {
    const initialRevision = Symbol("initial");
    const undoLog = [];
    const store = {
        value: 0,
        publicRevision: 0,
        savedRevision: initialRevision,
        lastRevision: initialRevision,
        lastRevisionStable: initialRevision,
        get isModified() {
            return this.lastRevision !== this.savedRevision;
        },
        project: {
            enableTabs() {}
        },
        setModified(revision) {
            const previousRevision = this.lastRevision;
            this.lastRevision = revision;
            if (!this.undoManager.combineCommands) {
                this.lastRevisionStable = revision;
            }
            return previousRevision;
        },
        restoreModifiedRevision(lastRevision, lastRevisionStable) {
            this.lastRevision = lastRevision;
            this.lastRevisionStable = lastRevisionStable;
        },
        updateLastRevisionStable() {
            this.lastRevisionStable = this.lastRevision;
        },
        advanceRevision() {
            this.publicRevision++;
        }
    };
    store.undoManager = new UndoManager(store);

    function command(delta, description = `add ${delta}`, undoError) {
        return {
            description,
            execute() {
                store.value += delta;
            },
            undo() {
                undoLog.push(description);
                store.value -= delta;
                if (undoError) {
                    throw undoError;
                }
            }
        };
    }

    return {
        store,
        undoManager: store.undoManager,
        command,
        undoLog
    };
}

async function withTemporaryDirectory(operation) {
    const directoryPath = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "eez-project-store-test-")
    );
    try {
        return await operation(directoryPath);
    } finally {
        await fs.promises.rm(directoryPath, {
            recursive: true,
            force: true
        });
    }
}

test("nested transactions commit as one labelled undo and one revision", async () => {
    const { UndoManager } = undoManagerModule;
    const { store, undoManager, command } = createUndoHarness(UndoManager);

    const result = undoManager.runTransaction("outer transaction", () => {
        undoManager.executeCommand(command(1));
        undoManager.runTransaction("inner transaction", () => {
            undoManager.executeCommand(command(2));
        });
        undoManager.executeCommand(command(3));
        return "committed";
    });

    assert.equal(result, "committed");
    assert.equal(store.value, 6);
    assert.equal(store.publicRevision, 1);
    assert.equal(undoManager.undoStack.length, 1);
    assert.equal(undoManager.undoDescription, "outer transaction");

    undoManager.undo();
    assert.equal(store.value, 0);
    assert.equal(store.publicRevision, 2);
    assert.equal(undoManager.redoDescription, "outer transaction");

    undoManager.redo();
    assert.equal(store.value, 6);
    assert.equal(store.publicRevision, 3);
    assert.equal(undoManager.undoDescription, "outer transaction");
});

test("a merged transaction update undoes to the original clean revision", () => {
    const { UndoManager } = undoManagerModule;
    const { store, undoManager } = createUndoHarness(UndoManager);
    const object = { value: 0 };

    undoManager.runTransaction("merged update", () => {
        const first = {
            description: "first update",
            execute() {
                object.value = 1;
            },
            undo() {
                object.value = 0;
            }
        };
        undoManager.executeCommand(first);

        undoManager.commands.pop();
        undoManager.executeCommand({
            previousRevision: first.previousRevision,
            description: "merged update",
            execute() {
                object.value = 2;
            },
            undo() {
                object.value = 0;
            }
        });
    });

    assert.equal(object.value, 2);
    assert.equal(store.isModified, true);

    undoManager.undo();
    assert.equal(object.value, 0);
    assert.equal(store.isModified, false);
});

test("a caught nested error rolls back the outer transaction in reverse order", async () => {
    const { UndoManager } = undoManagerModule;
    const { store, undoManager, command, undoLog } =
        createUndoHarness(UndoManager);
    const lastRevision = store.lastRevision;
    const lastRevisionStable = store.lastRevisionStable;

    assert.throws(
        () =>
            undoManager.runTransaction("outer transaction", () => {
                undoManager.executeCommand(command(1, "first"));
                try {
                    undoManager.runTransaction("inner transaction", () => {
                        undoManager.executeCommand(command(2, "second"));
                        throw new Error("nested failure");
                    });
                } catch (error) {
                    assert.equal(error.message, "nested failure");
                }
                undoManager.executeCommand(command(3, "third"));
            }),
        /nested failure/
    );

    assert.deepEqual(undoLog, ["third", "second", "first"]);
    assert.equal(store.value, 0);
    assert.equal(store.publicRevision, 0);
    assert.equal(store.lastRevision, lastRevision);
    assert.equal(store.lastRevisionStable, lastRevisionStable);
    assert.equal(undoManager.canUndo, false);
    assert.equal(undoManager.undoStack.length, 0);
    assert.equal(undoManager.commands.length, 0);
});

test("rollback restores commands that were pending before the transaction", async () => {
    const { UndoManager } = undoManagerModule;
    const { store, undoManager, command } = createUndoHarness(UndoManager);

    undoManager.executeCommand(command(1, "pending command"));
    const revisionBeforeTransaction = store.publicRevision;
    const modifiedRevisionBeforeTransaction = store.lastRevision;

    assert.throws(
        () =>
            undoManager.runTransaction("failing transaction", () => {
                undoManager.executeCommand(command(2));
                throw new Error("transaction failure");
            }),
        /transaction failure/
    );

    assert.equal(store.value, 1);
    assert.equal(store.publicRevision, revisionBeforeTransaction);
    assert.equal(store.lastRevision, modifiedRevisionBeforeTransaction);
    assert.equal(undoManager.commands.length, 1);
    assert.equal(undoManager.undoStack.length, 0);
    assert.equal(undoManager.undoDescription, "pending command");

    undoManager.undo();
    assert.equal(store.value, 0);
    assert.equal(store.publicRevision, revisionBeforeTransaction + 1);
});

test("transaction rejects asynchronous work and active legacy combining", async () => {
    const { UndoManager } = undoManagerModule;
    const { store, undoManager, command } = createUndoHarness(UndoManager);

    assert.throws(
        () =>
            undoManager.runTransaction("async transaction", () =>
                Promise.resolve()
            ),
        /must be synchronous/
    );
    assert.equal(undoManager.canUndo, false);
    assert.equal(store.publicRevision, 0);

    undoManager.setCombineCommands(true);
    assert.throws(
        () =>
            undoManager.runTransaction("blocked transaction", () => {
                undoManager.executeCommand(command(1));
            }),
        /legacy command combination/
    );
    assert.equal(store.value, 0);
    assert.equal(undoManager.combineCommands, true);
});

test("legacy command grouping invalidates the public revision per mutation", () => {
    const { UndoManager } = undoManagerModule;
    const { store, undoManager, command } = createUndoHarness(UndoManager);

    undoManager.setCombineCommands(true);
    undoManager.executeCommand(command(1));
    const revisionAfterFirstMutation = store.publicRevision;
    undoManager.executeCommand(command(2));

    assert.equal(revisionAfterFirstMutation, 1);
    assert.equal(store.publicRevision, 2);

    undoManager.setCombineCommands(false);
    assert.equal(store.publicRevision, 2);
});

test("rollback failures expose both the transaction and undo errors", async () => {
    const { TransactionRollbackError, UndoManager } = undoManagerModule;
    const { store, undoManager, command } = createUndoHarness(UndoManager);
    const transactionError = new Error("transaction failed");
    const undoError = new Error("undo failed");

    assert.throws(
        () =>
            undoManager.runTransaction("failing rollback", () => {
                undoManager.executeCommand(
                    command(1, "cannot undo", undoError)
                );
                throw transactionError;
            }),
        error => {
            assert(error instanceof TransactionRollbackError);
            assert.equal(error.code, "PROJECT_TRANSACTION_ROLLBACK_FAILED");
            assert.equal(error.transactionError, transactionError);
            assert.deepEqual(error.rollbackErrors, [undoError]);
            return true;
        }
    );
    assert.equal(store.publicRevision, 1);
    assert.equal(store.isModified, true);
    assert.equal(undoManager.canUndo, false);
});

test("failed undo invalidates revision and clears unsafe history", () => {
    const { TransactionRollbackError, UndoManager } = undoManagerModule;
    const { store, undoManager, command } = createUndoHarness(UndoManager);

    undoManager.executeCommand(command(1, "cannot undo", new Error("undo failed")));
    const revisionBeforeUndo = store.publicRevision;

    assert.throws(
        () => undoManager.undo(),
        error => error instanceof TransactionRollbackError
    );
    assert.equal(store.publicRevision, revisionBeforeUndo + 1);
    assert.equal(store.isModified, true);
    assert.equal(undoManager.canUndo, false);
    assert.equal(undoManager.canRedo, false);
});

test("a command that mutates and then throws invalidates model history", () => {
    const { TransactionRollbackError, UndoManager } = undoManagerModule;
    const { store, undoManager } = createUndoHarness(UndoManager);

    assert.throws(
        () =>
            undoManager.runTransaction("partial command", () => {
                undoManager.executeCommand({
                    description: "partial command",
                    execute() {
                        store.value = 99;
                        throw new Error("execute failed");
                    },
                    undo() {
                        store.value = 0;
                    }
                });
            }),
        error => error instanceof TransactionRollbackError
    );

    assert.equal(store.value, 99);
    assert.equal(store.isModified, true);
    assert.equal(store.publicRevision, 1);
    assert.equal(undoManager.canUndo, false);
    assert.equal(undoManager.canRedo, false);
});

test("atomic writes hash content and reject a stale disk hash", async () => {
    const {
        DiskHashConflictError,
        atomicWriteFile,
        getFileHash,
        hashContent
    } = atomicWriteModule;

    await withTemporaryDirectory(async directoryPath => {
        const filePath = path.join(directoryPath, "project.eez-project");
        await fs.promises.writeFile(filePath, "initial", "utf8");
        const initialHash = await getFileHash(filePath);

        assert.equal(initialHash, hashContent("initial"));
        assert.equal(
            await atomicWriteFile(filePath, "saved", {
                expectedDiskHash: initialHash
            }),
            hashContent("saved")
        );
        assert.equal(await fs.promises.readFile(filePath, "utf8"), "saved");

        await assert.rejects(
            atomicWriteFile(filePath, "stale overwrite", {
                expectedDiskHash: initialHash
            }),
            error => {
                assert(error instanceof DiskHashConflictError);
                assert.equal(error.code, "PROJECT_DISK_HASH_CONFLICT");
                assert.equal(error.expectedDiskHash, initialHash);
                assert.equal(error.actualDiskHash, hashContent("saved"));
                return true;
            }
        );
        assert.equal(await fs.promises.readFile(filePath, "utf8"), "saved");
        assert.deepEqual(
            (await fs.promises.readdir(directoryPath)).filter(fileName =>
                fileName.endsWith(".tmp")
            ),
            []
        );
    });
});

test("the per-path queue gives concurrent writes compare-and-swap semantics", async () => {
    const { atomicWriteFile, getFileHash } = atomicWriteModule;

    await withTemporaryDirectory(async directoryPath => {
        const filePath = path.join(directoryPath, "project.eez-project");
        await fs.promises.writeFile(filePath, "initial", "utf8");
        const initialHash = await getFileHash(filePath);

        const results = await Promise.allSettled([
            atomicWriteFile(filePath, "first writer", {
                expectedDiskHash: initialHash
            }),
            atomicWriteFile(filePath, "second writer", {
                expectedDiskHash: initialHash
            })
        ]);

        assert.equal(
            results.filter(result => result.status === "fulfilled").length,
            1
        );
        assert.equal(
            results.filter(result => result.status === "rejected").length,
            1
        );
        assert([
            "first writer",
            "second writer"
        ].includes(await fs.promises.readFile(filePath, "utf8")));
        assert.deepEqual(
            (await fs.promises.readdir(directoryPath)).filter(fileName =>
                fileName.endsWith(".tmp")
            ),
            []
        );
    });
});

test("the project save queue uses the latest disk hash for consecutive saves", async () => {
    const {
        ProjectSaveQueue,
        atomicWriteFile,
        getFileHash,
        hashContent
    } = atomicWriteModule;

    await withTemporaryDirectory(async directoryPath => {
        const filePath = path.join(directoryPath, "project.eez-project");
        await fs.promises.writeFile(filePath, "initial", "utf8");
        const state = { diskHash: await getFileHash(filePath) };
        const queue = new ProjectSaveQueue();

        const save = content =>
            queue.enqueue(async () => {
                const diskHash = await atomicWriteFile(filePath, content, {
                    expectedDiskHash: state.diskHash
                });
                state.diskHash = diskHash;
            });

        await Promise.all([save("first"), save("second")]);

        assert.equal(await fs.promises.readFile(filePath, "utf8"), "second");
        assert.equal(state.diskHash, hashContent("second"));
    });
});

test("the project save queue continues after a failed save", async () => {
    const { ProjectSaveQueue } = atomicWriteModule;
    const queue = new ProjectSaveQueue();
    const operations = [];

    const failed = queue.enqueue(async () => {
        operations.push("failed");
        throw new Error("save failed");
    });
    const succeeded = queue.enqueue(async () => {
        operations.push("succeeded");
        return 42;
    });

    await assert.rejects(failed, /save failed/);
    assert.equal(await succeeded, 42);
    assert.deepEqual(operations, ["failed", "succeeded"]);
});

test("a post-commit auxiliary save failure does not reject the project save", async () => {
    const { runPostCommitAuxiliarySave } = atomicWriteModule;
    const auxiliaryError = new Error("font cache failed");
    let reportedError;

    await runPostCommitAuxiliarySave(
        async () => {
            throw auxiliaryError;
        },
        error => (reportedError = error)
    );

    assert.equal(reportedError, auxiliaryError);
});


test("queued save revision guards run when the save actually starts", async () => {
    const { ProjectSaveQueue } = atomicWriteModule;
    const queue = new ProjectSaveQueue();
    let releaseFirst;
    let markFirstStarted;
    const firstStarted = new Promise(resolve => (markFirstStarted = resolve));
    const waitForRelease = new Promise(resolve => (releaseFirst = resolve));
    let revision = "revision-1";
    const expectedRevision = revision;
    let secondSaveRan = false;

    const first = queue.enqueue(async () => {
        markFirstStarted();
        await waitForRelease;
    });
    const second = queue.enqueue(async () => {
        if (revision != expectedRevision) {
            const error = new Error("revision conflict");
            error.code = "PROJECT_REVISION_CONFLICT";
            throw error;
        }
        secondSaveRan = true;
    });

    await firstStarted;
    revision = "revision-2";
    releaseFirst();
    await first;
    await assert.rejects(
        second,
        error => error.code == "PROJECT_REVISION_CONFLICT"
    );
    assert.equal(secondSaveRan, false);
});

test("Save As clears the target hash and restores path and hash on failure", async () => {
    const { withProjectSaveTarget } = atomicWriteModule;
    const state = {
        filePath: "/projects/original.eez-project",
        diskHash: "original-hash"
    };

    await assert.rejects(
        withProjectSaveTarget(
            { ...state },
            "/projects/copy.eez-project",
            nextState => Object.assign(state, nextState),
            async () => {
                assert.deepEqual(state, {
                    filePath: "/projects/copy.eez-project",
                    diskHash: undefined
                });
                throw new Error("write failed");
            }
        ),
        /write failed/
    );

    assert.deepEqual(state, {
        filePath: "/projects/original.eez-project",
        diskHash: "original-hash"
    });
});

test("Save As keeps the new path and hash after a successful write", async () => {
    const { withProjectSaveTarget } = atomicWriteModule;
    const state = {
        filePath: "/projects/original.eez-project",
        diskHash: "original-hash"
    };

    const result = await withProjectSaveTarget(
        { ...state },
        "/projects/copy.eez-project",
        nextState => Object.assign(state, nextState),
        async () => {
            assert.deepEqual(state, {
                filePath: "/projects/copy.eez-project",
                diskHash: undefined
            });
            state.diskHash = "copy-hash";
            return "saved";
        }
    );

    assert.equal(result, "saved");
    assert.deepEqual(state, {
        filePath: "/projects/copy.eez-project",
        diskHash: "copy-hash"
    });
});

test("public object lookup uses objID and never exposes the internal id", () => {
    class TestObject {
        constructor(objID, internalId) {
            this.objID = objID;
            this._eez_id = internalId;
        }
    }

    const object = new TestObject("persistent-object-id", "17");
    assert.equal(
        projectServiceUtils.findObjectByObjID(
            [object],
            "persistent-object-id"
        ),
        object
    );
    assert.equal(projectServiceUtils.findObjectByObjID([object], "17"), undefined);
});

test("v1 mutation validation rejects structured updates and false child arrays", () => {
    const {
        isChildCollectionSchema,
        isValidStudioCreateValue,
        isValidStudioScalarValue
    } = projectServiceUtils;

    assert.equal(isValidStudioScalarValue("Number", 12), true);
    assert.equal(isValidStudioScalarValue("Number", "12"), false);
    assert.equal(isValidStudioScalarValue("Boolean", "false"), false);
    assert.equal(isValidStudioScalarValue("Array", []), false);
    assert.equal(isValidStudioScalarValue("Object", {}), false);
    assert.equal(isValidStudioScalarValue("StringArray", []), false);
    assert.equal(isValidStudioCreateValue("Array", {}, true), false);
    assert.equal(isValidStudioCreateValue("Array", [], true), true);
    assert.equal(isChildCollectionSchema("Array", true), true);
    assert.equal(isChildCollectionSchema("Array", false), false);
    assert.equal(isChildCollectionSchema("StringArray", false), false);
});
