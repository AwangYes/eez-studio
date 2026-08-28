"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const installation = require(
    "../../build/eez-studio-shared/extensions/extension-installation"
);
const lifecycle = require(
    "../../build/eez-studio-shared/extensions/extension-lifecycle"
);
const { ManagedExtensionContext } = require(
    "../../build/eez-studio-shared/extensions/extension-context"
);
const { ExtensionOperationQueue } = require(
    "../../build/eez-studio-shared/extensions/extension-operation-queue"
);

async function withTemporaryDirectory(operation) {
    const directoryPath = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "eez-extension-transaction-test-")
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

async function writeLegacyPackage(packageRoot, overrides = {}) {
    const markerPath = path.join(packageRoot, "executed.marker");
    await fs.promises.mkdir(packageRoot, { recursive: true });
    await fs.promises.writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({
            name: "@example/legacy-extension",
            version: "1.0.0",
            "eez-studio": { main: "index.js" },
            ...overrides
        }),
        "utf8"
    );
    await fs.promises.writeFile(
        path.join(packageRoot, "index.js"),
        `require("node:fs").writeFileSync(${JSON.stringify(
            markerPath
        )}, "executed");\nmodule.exports.default = {};\n`,
        "utf8"
    );
    return markerPath;
}

test("scoped extension IDs map to stable single-level folders", async () => {
    await withTemporaryDirectory(async root => {
        const scopedId = "@example/extension";
        const folderName = installation.extensionIdToFolderName(scopedId);
        assert.equal(installation.extensionIdToFolderName("com.example"), "com.example");
        for (const nonPortableId of [
            "con",
            "NUL.txt",
            "name.",
            "cache",
            "node_modules"
        ]) {
            assert.match(
                installation.extensionIdToFolderName(nonPortableId),
                /^%id-/
            );
        }
        assert.equal(path.basename(folderName), folderName);
        assert.equal(folderName.includes("/"), false);
        assert.notEqual(folderName, installation.extensionIdToFolderName("example-extension"));
        assert.notEqual(
            installation.extensionIdToFolderName("@@@"),
            installation.extensionIdToFolderName("@@Z")
        );
        assert.equal(
            installation.extensionIdToFolderName("@@@").toLowerCase(),
            installation.extensionIdToFolderName("@@@")
        );

        const longId = `@scope/${"a".repeat(205)}`;
        const longTarget = installation.extensionFolderPath(root, longId);
        const longPending = installation.pendingExtensionInstallPath(
            root,
            longId,
            "long1"
        );
        assert(Buffer.byteLength(path.basename(longTarget), "utf8") <= 255);
        assert(Buffer.byteLength(path.basename(longPending), "utf8") <= 255);

        const incoming = installation.incomingExtensionFolderPath(root, "tx1");
        const target = installation.extensionFolderPath(root, scopedId);
        await fs.promises.mkdir(incoming, { recursive: true });
        await fs.promises.writeFile(
            path.join(incoming, "package.json"),
            JSON.stringify({
                name: scopedId,
                version: "1.0.0",
                "eez-studio": { main: "index.js" }
            })
        );
        await fs.promises.rename(incoming, target);

        assert.equal(path.dirname(target), root);
        const reloaded = await installation.inspectExtensionPackageStatic(target);
        assert.equal(reloaded.id, scopedId);
        assert.equal(reloaded.version, "1.0.0");
        assert.equal(reloaded.extensionType, "legacy");
    });
});

test("publisher identity cannot change during an in-place replacement", () => {
    const signed = { publisherFingerprint: "a".repeat(64) };
    assert.doesNotThrow(() =>
        installation.assertPublisherIdentityCanReplace(
            signed,
            { publisherFingerprint: "a".repeat(64) },
            "com.example.extension"
        )
    );
    assert.throws(
        () =>
            installation.assertPublisherIdentityCanReplace(
                signed,
                { publisherFingerprint: "b".repeat(64) },
                "com.example.extension"
            ),
        /publisher identity mismatch/
    );
    assert.throws(
        () =>
            installation.assertPublisherIdentityCanReplace(
                signed,
                {},
                "com.example.extension"
            ),
        /publisher identity mismatch/
    );
});

test("staging recovery restores backups and removes completed transactions", async () => {
    await withTemporaryDirectory(async root => {
        const restoredId = "@example/restored";
        const restoredTarget = installation.extensionFolderPath(root, restoredId);
        const restoredBackup = installation.backupExtensionFolderPath(
            root,
            restoredId,
            "restore1"
        );
        await fs.promises.mkdir(restoredBackup, { recursive: true });
        await fs.promises.writeFile(path.join(restoredBackup, "state"), "old");

        const pendingUpdateId = "@example/pending-update";
        const pendingUpdateTarget = installation.extensionFolderPath(
            root,
            pendingUpdateId
        );
        const pendingUpdateBackup = installation.backupExtensionFolderPath(
            root,
            pendingUpdateId,
            "rollback1"
        );
        await fs.promises.mkdir(pendingUpdateTarget, { recursive: true });
        await fs.promises.writeFile(
            path.join(pendingUpdateTarget, "state"),
            "new"
        );
        await fs.promises.mkdir(pendingUpdateBackup, { recursive: true });
        await fs.promises.writeFile(
            path.join(pendingUpdateBackup, "state"),
            "old"
        );

        const committedId = "@example/committed";
        const committedTarget = installation.extensionFolderPath(root, committedId);
        const committedBackup = installation.committedExtensionFolderPath(
            root,
            committedId,
            "commit1"
        );
        await fs.promises.mkdir(committedTarget, { recursive: true });
        await fs.promises.writeFile(path.join(committedTarget, "state"), "new");
        await fs.promises.mkdir(committedBackup, { recursive: true });
        await fs.promises.writeFile(path.join(committedBackup, "state"), "old");

        const pendingInstallId = "@example/pending-install";
        const pendingInstallTarget = installation.extensionFolderPath(
            root,
            pendingInstallId
        );
        const pendingInstallMarker = installation.pendingExtensionInstallPath(
            root,
            pendingInstallId,
            "pending1"
        );
        await fs.promises.mkdir(pendingInstallTarget, { recursive: true });
        await fs.promises.mkdir(pendingInstallMarker, { recursive: true });

        const installedId = "@example/installed";
        const installedTarget = installation.extensionFolderPath(root, installedId);
        const installedMarker = installation.installedExtensionMarkerPath(
            root,
            installedId,
            "installed1"
        );
        await fs.promises.mkdir(installedTarget, { recursive: true });
        await fs.promises.mkdir(installedMarker, { recursive: true });

        const incoming = installation.incomingExtensionFolderPath(root, "incoming1");
        const uninstallId = "@example/uninstall-pending";
        const uninstallTarget = installation.extensionFolderPath(root, uninstallId);
        const uninstall = installation.uninstallExtensionFolderPath(
            root,
            uninstallId,
            "uninstall1"
        );
        const removedId = "@example/uninstall-committed";
        const removedTarget = installation.extensionFolderPath(root, removedId);
        const removed = installation.removedExtensionFolderPath(
            root,
            removedId,
            "removed1"
        );
        await fs.promises.mkdir(incoming, { recursive: true });
        await fs.promises.mkdir(uninstall, { recursive: true });
        await fs.promises.writeFile(path.join(uninstall, "state"), "installed");
        await fs.promises.mkdir(removed, { recursive: true });

        await installation.recoverExtensionStaging(root);

        assert.equal(
            await fs.promises.readFile(path.join(restoredTarget, "state"), "utf8"),
            "old"
        );
        assert.equal(fs.existsSync(restoredBackup), false);
        assert.equal(
            await fs.promises.readFile(
                path.join(pendingUpdateTarget, "state"),
                "utf8"
            ),
            "old"
        );
        assert.equal(fs.existsSync(pendingUpdateBackup), false);
        assert.equal(
            await fs.promises.readFile(path.join(committedTarget, "state"), "utf8"),
            "new"
        );
        assert.equal(fs.existsSync(committedBackup), false);
        assert.equal(fs.existsSync(pendingInstallTarget), false);
        assert.equal(fs.existsSync(pendingInstallMarker), false);
        assert.equal(fs.existsSync(installedTarget), true);
        assert.equal(fs.existsSync(installedMarker), false);
        assert.equal(fs.existsSync(incoming), false);
        assert.equal(fs.existsSync(uninstall), false);
        assert.equal(
            await fs.promises.readFile(path.join(uninstallTarget, "state"), "utf8"),
            "installed"
        );
        assert.equal(fs.existsSync(removed), false);
        assert.equal(fs.existsSync(removedTarget), false);
    });
});

test("stale committed backups never resurrect an uninstalled extension", async () => {
    await withTemporaryDirectory(async root => {
        const extensionId = "@example/removed-after-update";
        const committed = installation.committedExtensionFolderPath(
            root,
            extensionId,
            "oldcommit"
        );
        const removed = installation.removedExtensionFolderPath(
            root,
            extensionId,
            "newremove"
        );
        await fs.promises.mkdir(committed, { recursive: true });
        await fs.promises.writeFile(path.join(committed, "state"), "old");
        await fs.promises.mkdir(removed, { recursive: true });

        await installation.recoverExtensionStaging(root);

        assert.equal(
            fs.existsSync(installation.extensionFolderPath(root, extensionId)),
            false
        );
        assert.equal(fs.existsSync(committed), false);
        assert.equal(fs.existsSync(removed), false);
    });
});

test("committed target state dominates stale rollback markers for the same extension", async () => {
    await withTemporaryDirectory(async root => {
        const extensionId = "@example/retried-install";
        const target = installation.extensionFolderPath(root, extensionId);
        const stalePending = installation.pendingExtensionInstallPath(
            root,
            extensionId,
            "oldpending"
        );
        const installed = installation.installedExtensionMarkerPath(
            root,
            extensionId,
            "newinstalled"
        );
        await fs.promises.mkdir(target, { recursive: true });
        await fs.promises.writeFile(path.join(target, "state"), "new");
        await fs.promises.mkdir(stalePending, { recursive: true });
        await fs.promises.mkdir(installed, { recursive: true });

        await installation.recoverExtensionStaging(root);

        assert.equal(
            await fs.promises.readFile(path.join(target, "state"), "utf8"),
            "new"
        );
        assert.equal(fs.existsSync(stalePending), false);
        assert.equal(fs.existsSync(installed), false);
    });
});

test("partial cleanup retains terminal state so recovery remains idempotent", async () => {
    await withTemporaryDirectory(async root => {
        const extensionId = "@example/partial-cleanup";
        const target = installation.extensionFolderPath(root, extensionId);
        const stalePending = installation.pendingExtensionInstallPath(
            root,
            extensionId,
            "oldpending"
        );
        const installed = installation.installedExtensionMarkerPath(
            root,
            extensionId,
            "newinstalled"
        );
        await fs.promises.mkdir(target, { recursive: true });
        await fs.promises.writeFile(path.join(target, "state"), "new");
        await fs.promises.mkdir(stalePending, { recursive: true });
        await fs.promises.mkdir(installed, { recursive: true });

        await assert.rejects(
            installation.recoverExtensionStaging(root, {
                removeDirectory: async folderPath => {
                    if (folderPath === stalePending) {
                        throw new Error("cleanup interrupted");
                    }
                    await fs.promises.rm(folderPath, {
                        recursive: true,
                        force: true
                    });
                }
            }),
            installation.ExtensionStagingRecoveryError
        );
        assert.equal(fs.existsSync(installed), true);
        assert.equal(fs.existsSync(target), true);

        await installation.recoverExtensionStaging(root);
        assert.equal(fs.existsSync(installed), false);
        assert.equal(fs.existsSync(stalePending), false);
        assert.equal(
            await fs.promises.readFile(path.join(target, "state"), "utf8"),
            "new"
        );
    });
});

test("committed update state prevents a stale backup from rolling back a newer target", async () => {
    await withTemporaryDirectory(async root => {
        const extensionId = "@example/retried-update";
        const target = installation.extensionFolderPath(root, extensionId);
        const staleBackup = installation.backupExtensionFolderPath(
            root,
            extensionId,
            "oldbackup"
        );
        const committed = installation.committedExtensionFolderPath(
            root,
            extensionId,
            "newcommit"
        );
        await fs.promises.mkdir(target, { recursive: true });
        await fs.promises.writeFile(path.join(target, "state"), "new");
        await fs.promises.mkdir(staleBackup, { recursive: true });
        await fs.promises.writeFile(path.join(staleBackup, "state"), "old");
        await fs.promises.mkdir(committed, { recursive: true });

        await installation.recoverExtensionStaging(root);

        assert.equal(
            await fs.promises.readFile(path.join(target, "state"), "utf8"),
            "new"
        );
        assert.equal(fs.existsSync(staleBackup), false);
        assert.equal(fs.existsSync(committed), false);
    });
});

test("conflicting uncommitted transactions fail without choosing destructive recovery", async () => {
    await withTemporaryDirectory(async root => {
        const extensionId = "@example/conflict";
        const firstBackup = installation.backupExtensionFolderPath(
            root,
            extensionId,
            "backupone"
        );
        const secondBackup = installation.backupExtensionFolderPath(
            root,
            extensionId,
            "backuptwo"
        );
        await fs.promises.mkdir(firstBackup, { recursive: true });
        await fs.promises.mkdir(secondBackup, { recursive: true });

        await assert.rejects(
            installation.recoverExtensionStaging(root),
            error => {
                assert(
                    error instanceof installation.ExtensionStagingRecoveryError
                );
                assert.match(String(error.errors[0]), /Conflicting/);
                return true;
            }
        );
        assert.equal(fs.existsSync(firstBackup), true);
        assert.equal(fs.existsSync(secondBackup), true);
    });
});

test("staging recovery propagates cleanup failures", async () => {
    await withTemporaryDirectory(async root => {
        const incoming = installation.incomingExtensionFolderPath(root, "failed1");
        await fs.promises.mkdir(incoming, { recursive: true });
        const cleanupError = new Error("cleanup denied");

        await assert.rejects(
            installation.recoverExtensionStaging(root, {
                removeDirectory: async () => {
                    throw cleanupError;
                }
            }),
            error => {
                assert(
                    error instanceof installation.ExtensionStagingRecoveryError
                );
                assert(error.errors.includes(cleanupError));
                return true;
            }
        );
    });
});

test("failed staging recovery prevents installed extension scanning", () => {
    const source = fs.readFileSync(
        path.join(
            __dirname,
            "../../packages/eez-studio-shared/extensions/extensions.ts"
        ),
        "utf8"
    );
    const start = source.indexOf("export async function loadExtensions(");
    const end = source.indexOf("export async function loadPreinstalledExtension", start);
    assert(start >= 0 && end > start);
    const loadExtensionsSource = source.slice(start, end);

    assert.match(
        loadExtensionsSource,
        /catch \(err\) \{\s*installedExtensionsSafeToLoad = false;/
    );
    assert.match(
        loadExtensionsSource,
        /if \(!installedExtensionsSafeToLoad\) \{\s*installedExtensionFolders = \[\];/
    );
});

test("removeFolder propagates rimraf callback errors", async () => {
    const utilElectronPath = require.resolve(
        "../../build/eez-studio-shared/util-electron"
    );
    const originalLoad = Module._load;
    let removeFolder;
    try {
        Module._load = function (request, parent, isMain) {
            if (request === "electron") {
                return { app: { getPath: () => os.tmpdir() } };
            }
            return originalLoad.call(this, request, parent, isMain);
        };
        delete require.cache[utilElectronPath];
        ({ removeFolder } = require(utilElectronPath));
    } finally {
        Module._load = originalLoad;
    }

    const rimrafPath = require.resolve("rimraf");
    const originalRimraf = require(rimrafPath);
    try {
        require.cache[rimrafPath].exports = (_folderPath, callback) => {
            callback(new Error("rimraf failed"));
        };
        await assert.rejects(removeFolder("unused"), /rimraf failed/);
    } finally {
        require.cache[rimrafPath].exports = originalRimraf;
        delete require.cache[utilElectronPath];
    }
});

test("catalog V1 entries cannot downgrade to executable legacy packages", async () => {
    await withTemporaryDirectory(async packageRoot => {
        const markerPath = await writeLegacyPackage(packageRoot, {
            "eez-studio": {}
        });
        await assert.rejects(
            installation.prepareExtensionPackageForInstall(packageRoot, {
                source: "catalog",
                developerMode: false,
                trustedKeys: {},
                expected: {
                    id: "@example/legacy-extension",
                    version: "1.0.0",
                    extensionType: "extension-v1"
                }
            }),
            /requires an Extension Platform V1 package/
        );
        assert.equal(fs.existsSync(markerPath), false);
    });
});

test("catalog V1 entries require a publisher fingerprint pin", async () => {
    await withTemporaryDirectory(async packageRoot => {
        await fs.promises.mkdir(path.join(packageRoot, "dist"), {
            recursive: true
        });
        await fs.promises.writeFile(
            path.join(packageRoot, "package.json"),
            JSON.stringify({
                name: "@example/catalog-v1",
                version: "1.0.0",
                "eez-studio": {
                    apiVersion: "1.0",
                    host: "sandbox",
                    browser: "dist/main.js"
                }
            })
        );
        await fs.promises.writeFile(
            path.join(packageRoot, "dist/main.js"),
            ""
        );
        await assert.rejects(
            installation.prepareExtensionPackageForInstall(packageRoot, {
                source: "catalog",
                developerMode: false,
                trustedKeys: {},
                expected: {
                    id: "@example/catalog-v1",
                    version: "1.0.0",
                    extensionType: "extension-v1"
                }
            }),
            /publisher fingerprint/
        );
    });
});

test("catalog identity mismatches fail before legacy execution", async () => {
    await withTemporaryDirectory(async packageRoot => {
        const markerPath = await writeLegacyPackage(packageRoot);
        const policy = {
            source: "catalog",
            developerMode: false,
            trustedKeys: {}
        };

        await assert.rejects(
            installation.prepareExtensionPackageForInstall(packageRoot, {
                ...policy,
                expected: {
                    id: "@example/different-extension",
                    version: "1.0.0",
                    extensionType: "measurement-functions"
                }
            }),
            /package ID mismatch/
        );
        await assert.rejects(
            installation.prepareExtensionPackageForInstall(packageRoot, {
                ...policy,
                expected: {
                    id: "@example/legacy-extension",
                    version: "2.0.0",
                    extensionType: "measurement-functions"
                }
            }),
            /package version mismatch/
        );
        assert.equal(fs.existsSync(markerPath), false);
    });
});

test("catalog legacy type mismatches fail before executable entry loading", async () => {
    await withTemporaryDirectory(async packageRoot => {
        const markerPath = await writeLegacyPackage(packageRoot);

        await assert.rejects(
            installation.prepareExtensionPackageForInstall(packageRoot, {
                source: "catalog",
                developerMode: false,
                trustedKeys: {},
                expected: {
                    id: "@example/legacy-extension",
                    version: "1.0.0",
                    extensionType: "iext"
                }
            }),
            /package type mismatch/
        );
        assert.equal(fs.existsSync(markerPath), false);
    });
});

test("explicit legacy catalog metadata can use the existing custom loader path", async () => {
    await withTemporaryDirectory(async packageRoot => {
        const markerPath = await writeLegacyPackage(packageRoot, {
            "eez-studio": {}
        });
        const expected = {
            id: "@example/legacy-extension",
            version: "1.0.0",
            extensionType: "iext"
        };
        const prepared = await installation.prepareExtensionPackageForInstall(
            packageRoot,
            {
                source: "catalog",
                developerMode: false,
                trustedKeys: {},
                expected
            }
        );

        assert.equal(prepared.extensionType, "legacy");
        assert.equal(prepared.hasEezStudioConfiguration, true);
        let loaderCalls = 0;
        const loaded = await installation.loadExtensionUsingLoaders(
            packageRoot,
            [
                {},
                {
                    loadExtension(folderPath) {
                        loaderCalls++;
                        require(folderPath);
                        return {
                            id: expected.id,
                            version: expected.version,
                            extensionType: "iext"
                        };
                    }
                }
            ]
        );
        installation.assertLoadedExtensionMatchesExpectation(
            loaded,
            expected
        );
        assert.equal(loaderCalls, 1);
        assert.equal(fs.existsSync(markerPath), true);
    });
});

test("recognized or invalid packages cannot fall through to extension loaders", () => {
    const source = fs.readFileSync(
        path.join(
            __dirname,
            "../../packages/eez-studio-shared/extensions/extensions.ts"
        ),
        "utf8"
    );
    const start = source.indexOf("async function loadExtension(");
    const end = source.indexOf("async function deactivateExtension(", start);
    assert(start >= 0 && end > start);
    const loaderSource = source.slice(start, end);

    assert.match(
        loaderSource,
        /if \(!extensionPackage\) \{\s*mayUseExtensionLoaderFallback = requiredV1Id == undefined;/
    );
    assert.match(
        source,
        /export async function reloadExtensionV1\(folder: string, expectedId: string\) \{\s*return reloadExtensionInternal\(folder, expectedId\);/
    );
    assert.match(
        loaderSource,
        /catch \(err\) \{\s*console\.error\(err\);\s*return undefined;/
    );
    assert.match(
        loaderSource,
        /if \(!mayUseExtensionLoaderFallback\) \{\s*return undefined;/
    );
    assert.match(
        loaderSource,
        /else \{\s*\/\/ Instrument and other legacy package formats[\s\S]*?mayUseExtensionLoaderFallback = true;/
    );
    assert.match(loaderSource, /return loadExtensionUsingLoaders\(/);
});

test("lifecycle operations and subscription cleanup have bounded deadlines", async () => {
    const startedAt = Date.now();
    await assert.rejects(
        lifecycle.runExtensionLifecycleOperation(
            "@example/slow-extension",
            "activation",
            20,
            () => new Promise(() => {})
        ),
        error => {
            assert(error instanceof lifecycle.ExtensionLifecycleTimeoutError);
            assert.equal(error.code, "EXTENSION_LIFECYCLE_TIMEOUT");
            return true;
        }
    );
    assert(Date.now() - startedAt < 1000);

    const context = new ManagedExtensionContext(
        "@example/slow-extension",
        "1.0.0",
        "1.0"
    );
    let completedCleanup = false;
    context.log.error = () => {};
    context.subscriptions.push(
        { dispose: () => new Promise(() => {}) },
        {
            dispose: () => {
                completedCleanup = true;
            }
        }
    );
    await context.dispose(20);
    assert.equal(context.signal.aborted, true);
    assert.equal(completedCleanup, true);
    assert(Date.now() - startedAt < 1000);
});

test("per-extension operation queues serialize and continue after failure", async () => {
    const queue = new ExtensionOperationQueue();
    const events = [];
    let releaseFirst;
    const firstGate = new Promise(resolve => {
        releaseFirst = resolve;
    });
    const first = queue.run("@example/serialized", async () => {
        events.push("first:start");
        await firstGate;
        events.push("first:end");
        throw new Error("first failed");
    });
    const firstRejected = assert.rejects(first, /first failed/);
    const second = queue.run("@example/serialized", async () => {
        events.push("second:start");
        return "second completed";
    });

    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events, ["first:start"]);
    releaseFirst();
    await firstRejected;
    assert.equal(await second, "second completed");
    assert.deepEqual(events, ["first:start", "first:end", "second:start"]);
});
