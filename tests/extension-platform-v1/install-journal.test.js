const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const journal = require("../../build/eez-studio-shared/extensions/extension-install-journal");
const lifecycle = require("../../build/eez-studio-shared/extensions/extension-lifecycle");

async function tempRoot() {
    return fs.promises.mkdtemp(path.join(os.tmpdir(), "eez-install-journal-"));
}

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
