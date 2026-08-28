const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const journal = require("../../build/eez-studio-shared/extensions/extension-install-journal");
const lifecycle = require("../../build/eez-studio-shared/extensions/extension-lifecycle");
const installation = require("../../build/eez-studio-shared/extensions/extension-installation");

async function tempRoot() {
    return fs.promises.mkdtemp(path.join(os.tmpdir(), "eez-install-journal-"));
}

async function writeState(folderPath, state) {
    await fs.promises.mkdir(folderPath, { recursive: true });
    await fs.promises.writeFile(path.join(folderPath, "state"), state, "utf8");
}

async function readState(folderPath) {
    try {
        return await fs.promises.readFile(path.join(folderPath, "state"), "utf8");
    } catch (error) {
        if (error.code == "ENOENT") return undefined;
        throw error;
    }
}

function stateDigest(state) {
    return crypto
        .createHash("sha256")
        .update("f\0")
        .update("state")
        .update("\0")
        .update(state)
        .update("\0")
        .digest("hex");
}

async function createRecoveryFixture(root, operation, state, transactionId) {
    const extensionId = `com.example.${operation}.${transactionId}`;
    const targetPath = installation.extensionFolderPath(root, extensionId);
    const incomingPath = installation.incomingExtensionFolderPath(
        root,
        transactionId
    );
    const backupPath =
        operation == "uninstall"
            ? installation.uninstallExtensionFolderPath(
                  root,
                  extensionId,
                  transactionId
              )
            : installation.backupExtensionFolderPath(
                  root,
                  extensionId,
                  transactionId
              );
    const pendingPath = installation.pendingExtensionInstallPath(
        root,
        extensionId,
        transactionId
    );
    const removedPath = installation.removedExtensionFolderPath(
        root,
        extensionId,
        transactionId
    );
    const relative = folderPath => path.relative(root, folderPath);

    await journal.beginExtensionInstallJournal(root, {
        transactionId,
        extensionId,
        operation,
        targetRelativePath: relative(targetPath),
        incomingRelativePath:
            operation == "uninstall" ? undefined : relative(incomingPath),
        backupRelativePath: relative(backupPath),
        oldDigest: operation == "install" ? undefined : stateDigest("old"),
        newDigest: operation == "uninstall" ? undefined : stateDigest("new")
    });

    const transitions =
        operation == "uninstall"
            ? state == "rolled-back"
                ? ["backup-moved", "rolled-back"]
                : ["backup-moved", "committed"]
            : state == "rolled-back"
              ? [
                    "incoming-verified",
                    "backup-moved",
                    "target-installed",
                    "rolled-back"
                ]
              : [
                  "incoming-verified",
                  "backup-moved",
                  "target-installed",
                  "committed"
                ];
    for (const transition of transitions) {
        if (state == "prepared") break;
        await journal.advanceExtensionInstallJournal(
            root,
            transactionId,
            transition
        );
        if (transition == state) break;
    }

    if (operation == "install") {
        if (state == "prepared" || state == "incoming-verified") {
            await writeState(incomingPath, "new");
        } else if (state == "backup-moved") {
            await writeState(incomingPath, "new");
            await fs.promises.mkdir(pendingPath, { recursive: true });
        } else {
            await writeState(targetPath, "new");
            if (
                state == "target-installed" ||
                state == "committed" ||
                state == "rolled-back"
            ) {
                await fs.promises.mkdir(pendingPath, { recursive: true });
            }
        }
    } else if (operation == "update") {
        if (state == "prepared" || state == "incoming-verified") {
            await writeState(targetPath, "old");
            await writeState(incomingPath, "new");
        } else if (state == "backup-moved") {
            await writeState(backupPath, "old");
            await writeState(incomingPath, "new");
        } else {
            await writeState(backupPath, "old");
            await writeState(targetPath, "new");
        }
    } else if (state == "prepared") {
        await writeState(targetPath, "old");
    } else if (state == "backup-moved" || state == "rolled-back") {
        await writeState(backupPath, "old");
    } else {
        // The uninstall directory is renamed before the committed journal
        // transition and may remain when its best-effort cleanup is interrupted.
        await writeState(removedPath, "old");
    }

    return {
        extensionId,
        targetPath,
        incomingPath,
        backupPath,
        pendingPath,
        removedPath,
        journalPath: journal.extensionInstallJournalPath(root, transactionId)
    };
}

test(
    "Windows reports degraded durability when directory handles cannot be synced",
    { skip: process.platform !== "win32" },
    async () => {
        const root = await tempRoot();
        try {
            journal.setExtensionDurabilityAdapter(undefined);
            assert.equal(journal.isExtensionInstallDurabilityDegraded(), false);
            await journal.beginExtensionInstallJournal(root, {
                transactionId: "windows-fsync",
                extensionId: "com.example.windows-fsync",
                operation: "install",
                targetRelativePath: "com.example.windows-fsync",
                incomingRelativePath: "cache/.staging/incoming.windows-fsync"
            });
            assert.equal(journal.isExtensionInstallDurabilityDegraded(), true);
        } finally {
            await fs.promises.rm(root, { recursive: true, force: true });
        }
    }
);

test("install journal persists ordered transitions and removes atomically", async () => {
    const root = await tempRoot();
    const record = await journal.beginExtensionInstallJournal(root, {
        transactionId: "tx1",
        extensionId: "com.example.test",
        operation: "install",
        targetRelativePath: "com.example.test",
        incomingRelativePath: "cache/.staging/incoming.tx1"
    });
    assert.equal(record.state, "prepared");
    const advanced = await journal.advanceExtensionInstallJournal(
        root,
        "tx1",
        "incoming-verified"
    );
    assert.equal(advanced.sequence, 1);
    assert.equal((await journal.listExtensionInstallJournals(root)).length, 1);
    await journal.removeExtensionInstallJournal(root, "tx1");
    assert.equal((await journal.listExtensionInstallJournals(root)).length, 0);
});

test("journal checksum tampering is rejected", async () => {
    const root = await tempRoot();
    await journal.beginExtensionInstallJournal(root, {
        transactionId: "tx2",
        extensionId: "com.example.test",
        operation: "uninstall",
        targetRelativePath: "com.example.test",
        backupRelativePath: "cache/.staging/uninstall.tx2"
    });
    const journalPath = journal.extensionInstallJournalPath(root, "tx2");
    const value = JSON.parse(await fs.promises.readFile(journalPath, "utf8"));
    value.state = "committed";
    await fs.promises.writeFile(journalPath, JSON.stringify(value));
    await assert.rejects(
        journal.listExtensionInstallJournals(root),
        /checksum mismatch/
    );
});

test("durable recovery reconciles install, update and uninstall crash states idempotently", async t => {
    const cases = [
        ["install", "prepared"],
        ["install", "incoming-verified"],
        ["install", "backup-moved"],
        ["install", "target-installed"],
        ["install", "committed"],
        ["install", "rolled-back"],
        ["update", "prepared"],
        ["update", "incoming-verified"],
        ["update", "backup-moved"],
        ["update", "target-installed"],
        ["update", "committed"],
        ["update", "rolled-back"],
        ["uninstall", "prepared"],
        ["uninstall", "backup-moved"],
        ["uninstall", "committed"],
        ["uninstall", "rolled-back"]
    ];

    for (const [index, [operation, state]] of cases.entries()) {
        await t.test(`${operation} recovers from ${state}`, async () => {
            const root = await tempRoot();
            try {
                const fixture = await createRecoveryFixture(
                    root,
                    operation,
                    state,
                    `matrix${index}`
                );
                const expected =
                    state == "committed"
                        ? operation == "uninstall"
                            ? undefined
                            : "new"
                        : operation == "install"
                          ? undefined
                          : "old";

                await installation.recoverExtensionStaging(root);
                assert.equal(await readState(fixture.targetPath), expected);
                assert.equal(fs.existsSync(fixture.incomingPath), false);
                assert.equal(fs.existsSync(fixture.backupPath), false);
                assert.equal(fs.existsSync(fixture.pendingPath), false);
                assert.equal(fs.existsSync(fixture.removedPath), false);
                assert.equal(fs.existsSync(fixture.journalPath), false);

                await installation.recoverExtensionStaging(root);
                assert.equal(await readState(fixture.targetPath), expected);
                assert.deepEqual(
                    await fs.promises.readdir(
                        installation.extensionStagingFolderPath(root)
                    ),
                    []
                );
            } finally {
                await fs.promises.rm(root, { recursive: true, force: true });
            }
        });
    }
});

test("production transaction executors recover after real subprocess termination", async t => {
    const cases = [
        ["install", "prepared"],
        ["install", "incoming-verified"],
        ["install", "backup-moved"],
        ["install", "target-installed"],
        ["install", "committed"],
        ["install", "rolled-back"],
        ["update", "prepared"],
        ["update", "incoming-verified"],
        ["update", "backup-moved"],
        ["update", "target-installed"],
        ["update", "committed"],
        ["update", "rolled-back"],
        ["uninstall", "prepared"],
        ["uninstall", "backup-moved"],
        ["uninstall", "committed"],
        ["uninstall", "rolled-back"]
    ];
    const workerPath = path.join(__dirname, "install-journal-crash-worker.js");

    for (const [operation, crashCheckpoint] of cases) {
        await t.test(`${operation} exits after ${crashCheckpoint}`, async () => {
            const root = await tempRoot();
            try {
                const child = childProcess.spawnSync(
                    process.execPath,
                    [workerPath, root, operation, crashCheckpoint],
                    { encoding: "utf8" }
                );
                assert.equal(
                    child.status,
                    86,
                    `worker output:\n${child.stdout}\n${child.stderr}`
                );

                const extensionId = `com.example.crash.${operation}`;
                const targetPath = installation.extensionFolderPath(
                    root,
                    extensionId
                );
                const transactionId = "crashworker";
                const journalPath = journal.extensionInstallJournalPath(
                    root,
                    transactionId
                );
                const backupPath =
                    operation == "uninstall"
                        ? installation.uninstallExtensionFolderPath(
                              root,
                              extensionId,
                              transactionId
                          )
                        : installation.backupExtensionFolderPath(
                              root,
                              extensionId,
                              transactionId
                          );
                const expected =
                    crashCheckpoint == "committed"
                        ? operation == "uninstall"
                            ? undefined
                            : "new"
                        : operation == "install"
                          ? undefined
                          : "old";

                assert.equal(fs.existsSync(journalPath), true);
                if (crashCheckpoint == "committed") {
                    assert.equal(
                        await readState(targetPath),
                        operation == "uninstall" ? undefined : "new"
                    );
                    if (operation == "install") {
                        assert.equal(fs.existsSync(backupPath), false);
                        assert.equal(
                            fs.existsSync(
                                installation.pendingExtensionInstallPath(
                                    root,
                                    extensionId,
                                    transactionId
                                )
                            ),
                            true
                        );
                    } else {
                        assert.equal(await readState(backupPath), "old");
                    }
                }

                await installation.recoverExtensionStaging(root);
                assert.equal(await readState(targetPath), expected);
                await installation.recoverExtensionStaging(root);
                assert.equal(await readState(targetPath), expected);
                assert.deepEqual(
                    await fs.promises.readdir(
                        installation.extensionStagingFolderPath(root)
                    ),
                    []
                );
            } finally {
                await fs.promises.rm(root, { recursive: true, force: true });
            }
        });
    }
});

test("transaction executors complete normally without a checkpoint hook", async t => {
    for (const operation of ["install", "update", "uninstall"]) {
        await t.test(operation, async () => {
            const root = await tempRoot();
            try {
                const transactionId = `success${operation}`;
                const extensionId = `com.example.success.${operation}`;
                const targetPath = installation.extensionFolderPath(
                    root,
                    extensionId
                );
                const backupPath =
                    operation == "uninstall"
                        ? installation.uninstallExtensionFolderPath(
                              root,
                              extensionId,
                              transactionId
                          )
                        : installation.backupExtensionFolderPath(
                              root,
                              extensionId,
                              transactionId
                          );
                const removeDirectory = folderPath =>
                    fs.promises.rm(folderPath, {
                        recursive: true,
                        force: true
                    });
                if (operation == "update" || operation == "uninstall") {
                    await writeState(targetPath, "old");
                }

                if (operation == "uninstall") {
                    await journal.runDurableExtensionUninstall({
                        root,
                        transactionId,
                        extensionId,
                        targetPath,
                        backupPath,
                        removedPath: installation.removedExtensionFolderPath(
                            root,
                            extensionId,
                            transactionId
                        ),
                        commit: async () => undefined,
                        removeDirectory
                    });
                    assert.equal(await readState(targetPath), undefined);
                } else {
                    const incomingPath =
                        installation.incomingExtensionFolderPath(
                            root,
                            transactionId
                        );
                    await writeState(incomingPath, "new");
                    assert.equal(
                        await journal.runDurableExtensionInstall({
                            root,
                            transactionId,
                            extensionId,
                            operation,
                            targetPath,
                            incomingPath,
                            backupPath,
                            committedBackupPath:
                                installation.committedExtensionFolderPath(
                                    root,
                                    extensionId,
                                    transactionId
                                ),
                            pendingInstallPath:
                                installation.pendingExtensionInstallPath(
                                    root,
                                    extensionId,
                                    transactionId
                                ),
                            installedMarkerPath:
                                installation.installedExtensionMarkerPath(
                                    root,
                                    extensionId,
                                    transactionId
                                ),
                            commit: async () => "committed",
                            removeDirectory
                        }),
                        "committed"
                    );
                    assert.equal(await readState(targetPath), "new");
                }
                assert.deepEqual(
                    await fs.promises.readdir(
                        installation.extensionStagingFolderPath(root)
                    ),
                    []
                );
            } finally {
                await fs.promises.rm(root, { recursive: true, force: true });
            }
        });
    }
});

test("update executor treats a missing existing target as a new filesystem install", async () => {
    const root = await tempRoot();
    try {
        const transactionId = "missingtarget";
        const extensionId = "com.example.missing-target";
        const targetPath = installation.extensionFolderPath(root, extensionId);
        const incomingPath = installation.incomingExtensionFolderPath(
            root,
            transactionId
        );
        const backupPath = installation.backupExtensionFolderPath(
            root,
            extensionId,
            transactionId
        );
        await writeState(incomingPath, "new");
        let rollbackContext;

        await assert.rejects(
            journal.runDurableExtensionInstall({
                root,
                transactionId,
                extensionId,
                operation: "update",
                targetPath,
                incomingPath,
                backupPath,
                committedBackupPath: installation.committedExtensionFolderPath(
                    root,
                    extensionId,
                    transactionId
                ),
                pendingInstallPath: installation.pendingExtensionInstallPath(
                    root,
                    extensionId,
                    transactionId
                ),
                installedMarkerPath: installation.installedExtensionMarkerPath(
                    root,
                    extensionId,
                    transactionId
                ),
                commit: async () => {
                    throw new Error("injected validation failure");
                },
                rollback: async context => {
                    rollbackContext = context;
                },
                removeDirectory: folderPath =>
                    fs.promises.rm(folderPath, {
                        recursive: true,
                        force: true
                    })
            }),
            /injected validation failure/
        );
        assert.deepEqual(rollbackContext, { previousTargetAvailable: false });
        assert.equal(await readState(targetPath), undefined);
        assert.equal(fs.existsSync(incomingPath), false);
        assert.equal(fs.existsSync(backupPath), false);

        await installation.recoverExtensionStaging(root);
        assert.equal(await readState(targetPath), undefined);
        assert.deepEqual(
            await fs.promises.readdir(
                installation.extensionStagingFolderPath(root)
            ),
            []
        );
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test("update executor exposes the old target when backup rename fails", async () => {
    const root = await tempRoot();
    try {
        const transactionId = "renamefailure";
        const extensionId = "com.example.rename-failure";
        const targetPath = installation.extensionFolderPath(root, extensionId);
        const incomingPath = installation.incomingExtensionFolderPath(
            root,
            transactionId
        );
        const backupPath = path.join(
            installation.extensionStagingFolderPath(root),
            "missing-parent",
            "backup"
        );
        await writeState(targetPath, "old");
        await writeState(incomingPath, "new");
        let rollbackContext;

        await assert.rejects(
            journal.runDurableExtensionInstall({
                root,
                transactionId,
                extensionId,
                operation: "update",
                targetPath,
                incomingPath,
                backupPath,
                committedBackupPath: path.join(
                    installation.extensionStagingFolderPath(root),
                    "unused-committed"
                ),
                pendingInstallPath: path.join(
                    installation.extensionStagingFolderPath(root),
                    "unused-pending"
                ),
                installedMarkerPath: path.join(
                    installation.extensionStagingFolderPath(root),
                    "unused-installed"
                ),
                commit: async () => undefined,
                rollback: async context => {
                    rollbackContext = context;
                },
                removeDirectory: folderPath =>
                    fs.promises.rm(folderPath, {
                        recursive: true,
                        force: true
                    })
            }),
            error => error.code == "ENOENT"
        );
        assert.deepEqual(rollbackContext, { previousTargetAvailable: true });
        assert.equal(await readState(targetPath), "old");
        assert.equal(fs.existsSync(incomingPath), false);

        await installation.recoverExtensionStaging(root);
        assert.equal(await readState(targetPath), "old");
        assert.deepEqual(
            await fs.promises.readdir(
                installation.extensionStagingFolderPath(root)
            ),
            []
        );
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test("checksum corruption fails closed and preserves all recovery evidence", async () => {
    const root = await tempRoot();
    try {
        const fixture = await createRecoveryFixture(
            root,
            "update",
            "target-installed",
            "corrupt1"
        );
        const value = JSON.parse(
            await fs.promises.readFile(fixture.journalPath, "utf8")
        );
        value.state = "committed";
        await fs.promises.writeFile(fixture.journalPath, JSON.stringify(value));

        for (let attempt = 0; attempt < 2; attempt++) {
            await assert.rejects(
                installation.recoverExtensionStaging(root),
                error => {
                    assert(
                        error instanceof installation.ExtensionStagingRecoveryError
                    );
                    assert.match(
                        String(error.errors[0].cause),
                        /checksum mismatch/
                    );
                    return true;
                }
            );
            assert.equal(await readState(fixture.targetPath), "new");
            assert.equal(await readState(fixture.backupPath), "old");
            assert.equal(fs.existsSync(fixture.journalPath), true);
        }
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test("committed cleanup failure cannot roll an update back and is retryable", async () => {
    const root = await tempRoot();
    try {
        const fixture = await createRecoveryFixture(
            root,
            "update",
            "committed",
            "cleanup1"
        );
        let failCleanup = true;
        await assert.rejects(
            installation.recoverExtensionStaging(root, {
                removeDirectory: async folderPath => {
                    if (folderPath == fixture.backupPath && failCleanup) {
                        failCleanup = false;
                        throw new Error("injected committed cleanup failure");
                    }
                    await fs.promises.rm(folderPath, {
                        recursive: true,
                        force: true
                    });
                }
            }),
            installation.ExtensionStagingRecoveryError
        );
        assert.equal(await readState(fixture.targetPath), "new");
        assert.equal(await readState(fixture.backupPath), "old");
        assert.equal(fs.existsSync(fixture.journalPath), true);

        await installation.recoverExtensionStaging(root);
        assert.equal(await readState(fixture.targetPath), "new");
        assert.equal(fs.existsSync(fixture.backupPath), false);
        assert.equal(fs.existsSync(fixture.journalPath), false);
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test("rollback cleanup failure persists terminal state before retry", async () => {
    const root = await tempRoot();
    try {
        const fixture = await createRecoveryFixture(
            root,
            "update",
            "prepared",
            "rollback1"
        );
        let failCleanup = true;
        await assert.rejects(
            installation.recoverExtensionStaging(root, {
                removeDirectory: async folderPath => {
                    if (folderPath == fixture.incomingPath && failCleanup) {
                        failCleanup = false;
                        throw new Error("injected rollback cleanup failure");
                    }
                    await fs.promises.rm(folderPath, {
                        recursive: true,
                        force: true
                    });
                }
            }),
            installation.ExtensionStagingRecoveryError
        );
        assert.equal(await readState(fixture.targetPath), "old");
        assert.equal(await readState(fixture.incomingPath), "new");
        assert.equal(
            (await journal.readExtensionInstallJournal(root, "rollback1")).state,
            "rolled-back"
        );

        await installation.recoverExtensionStaging(root);
        assert.equal(await readState(fixture.targetPath), "old");
        assert.equal(fs.existsSync(fixture.incomingPath), false);
        assert.equal(fs.existsSync(fixture.journalPath), false);
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
});

test("directory hashing is deterministic and rejects symlinks", async () => {
    const root = await tempRoot();
    const folder = path.join(root, "extension");
    await fs.promises.mkdir(path.join(folder, "nested"), { recursive: true });
    await fs.promises.writeFile(path.join(folder, "nested", "a.txt"), "a");
    const first = await journal.hashExtensionDirectory(folder);
    await fs.promises.writeFile(path.join(folder, "b.txt"), "b");
    const second = await journal.hashExtensionDirectory(folder);
    assert.notEqual(first, second);
    await fs.promises.symlink(path.join(folder, "b.txt"), path.join(folder, "link"));
    await assert.rejects(journal.hashExtensionDirectory(folder), /symbolic link/);
});

test("lifecycle coordinator executes concurrent cleanup exactly once per generation", async () => {
    const coordinator = new lifecycle.ExtensionLifecycleCoordinator();
    const firstGeneration = {};
    const secondGeneration = {};
    let cleanupCount = 0;
    await Promise.all([
        coordinator.cleanupOnce(firstGeneration, async () => cleanupCount++),
        coordinator.cleanupOnce(firstGeneration, async () => cleanupCount++),
        coordinator.cleanupOnce(secondGeneration, async () => cleanupCount++)
    ]);
    assert.equal(cleanupCount, 2);
});
