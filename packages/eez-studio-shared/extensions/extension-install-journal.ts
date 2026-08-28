import crypto from "crypto";
import fs from "fs";
import path from "path";

export const EXTENSION_INSTALL_JOURNAL_VERSION = 1;

export type ExtensionInstallJournalOperation = "install" | "update" | "uninstall";
export type ExtensionInstallJournalState =
    | "prepared"
    | "incoming-verified"
    | "backup-moved"
    | "target-installed"
    | "committed"
    | "rolled-back";

export interface ExtensionInstallJournalRecord {
    version: typeof EXTENSION_INSTALL_JOURNAL_VERSION;
    transactionId: string;
    extensionId: string;
    operation: ExtensionInstallJournalOperation;
    state: ExtensionInstallJournalState;
    sequence: number;
    targetRelativePath: string;
    incomingRelativePath?: string;
    backupRelativePath?: string;
    oldDigest?: string;
    newDigest?: string;
    publisherFingerprint?: string;
    updatedAt: string;
    checksum: string;
}

export type ExtensionInstallJournalDraft = Omit<
    ExtensionInstallJournalRecord,
    "version" | "state" | "sequence" | "updatedAt" | "checksum"
>;

const TRANSACTION_ID = /^[A-Za-z0-9_-]+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const JOURNAL_FILE = /^journal\.([A-Za-z0-9_-]+)\.json$/;
const STATE_ORDER: Record<ExtensionInstallJournalState, number> = {
    prepared: 0,
    "incoming-verified": 1,
    "backup-moved": 2,
    "target-installed": 3,
    committed: 4,
    "rolled-back": 4
};

let durabilityDegraded = false;
export function isExtensionInstallDurabilityDegraded() {
    return durabilityDegraded;
}

export interface ExtensionDurabilityAdapter {
    syncDirectory(directoryPath: string): Promise<void>;
}

export type ExtensionInstallCheckpoint =
    | "prepared"
    | "incoming-verified"
    | "backup-moved"
    | "target-installed"
    | "committed"
    | "rolled-back";

export type ExtensionInstallCheckpointHandler = (
    checkpoint: ExtensionInstallCheckpoint,
    record: ExtensionInstallJournalRecord
) => Promise<void>;

let durabilityAdapter: ExtensionDurabilityAdapter | undefined;
export function setExtensionDurabilityAdapter(
    adapter: ExtensionDurabilityAdapter | undefined
) {
    durabilityAdapter = adapter;
}

async function checkpoint(
    handler: ExtensionInstallCheckpointHandler | undefined,
    record: ExtensionInstallJournalRecord
) {
    await handler?.(record.state, record);
}

function payload(record: Omit<ExtensionInstallJournalRecord, "checksum">) {
    return JSON.stringify({
        version: record.version,
        transactionId: record.transactionId,
        extensionId: record.extensionId,
        operation: record.operation,
        state: record.state,
        sequence: record.sequence,
        targetRelativePath: record.targetRelativePath,
        incomingRelativePath: record.incomingRelativePath,
        backupRelativePath: record.backupRelativePath,
        oldDigest: record.oldDigest,
        newDigest: record.newDigest,
        publisherFingerprint: record.publisherFingerprint,
        updatedAt: record.updatedAt
    });
}

function withChecksum(
    record: Omit<ExtensionInstallJournalRecord, "checksum">
): ExtensionInstallJournalRecord {
    return {
        ...record,
        checksum: crypto.createHash("sha256").update(payload(record)).digest("hex")
    };
}

function assertRelativePath(root: string, relativePath: string, field: string) {
    if (
        !relativePath ||
        path.isAbsolute(relativePath) ||
        relativePath.includes("\0")
    ) {
        throw new Error(`Invalid extension journal ${field}`);
    }
    const resolvedRoot = path.resolve(root);
    const resolved = path.resolve(root, relativePath);
    const relative = path.relative(resolvedRoot, resolved);
    if (
        relative == ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
    ) {
        throw new Error(`Extension journal ${field} escapes the extension root`);
    }
}

function validateRecord(root: string, value: any): ExtensionInstallJournalRecord {
    if (
        value?.version !== EXTENSION_INSTALL_JOURNAL_VERSION ||
        !TRANSACTION_ID.test(value.transactionId) ||
        typeof value.extensionId != "string" ||
        value.extensionId.length == 0 ||
        !(value.operation == "install" ||
            value.operation == "update" ||
            value.operation == "uninstall") ||
        !(value.state in STATE_ORDER) ||
        !Number.isSafeInteger(value.sequence) ||
        value.sequence < 0 ||
        typeof value.updatedAt != "string" ||
        !SHA256.test(value.checksum) ||
        (value.oldDigest != undefined && !SHA256.test(value.oldDigest)) ||
        (value.newDigest != undefined && !SHA256.test(value.newDigest)) ||
        (value.publisherFingerprint != undefined &&
            !SHA256.test(value.publisherFingerprint))
    ) {
        throw new Error("Invalid extension install journal record");
    }
    assertRelativePath(root, value.targetRelativePath, "targetRelativePath");
    if (value.incomingRelativePath != undefined) {
        assertRelativePath(root, value.incomingRelativePath, "incomingRelativePath");
    }
    if (value.backupRelativePath != undefined) {
        assertRelativePath(root, value.backupRelativePath, "backupRelativePath");
    }
    const { checksum, ...unsigned } = value;
    const expected = withChecksum(unsigned as any).checksum;
    if (!crypto.timingSafeEqual(Buffer.from(checksum), Buffer.from(expected))) {
        throw new Error("Extension install journal checksum mismatch");
    }
    return value;
}

async function syncDirectory(directoryPath: string) {
    if (durabilityAdapter) {
        await durabilityAdapter.syncDirectory(directoryPath);
        return;
    }
    let handle: fs.promises.FileHandle | undefined;
    try {
        handle = await fs.promises.open(directoryPath, "r");
        await handle.sync();
    } catch (error) {
        // Node cannot open directory handles on Windows. Files are still
        // flushed before rename; Windows production packaging can replace
        // this primitive with a native FlushFileBuffers adapter.
        if (process.platform != "win32") {
            throw error;
        }
        durabilityDegraded = true;
    } finally {
        await handle?.close();
    }
}

async function syncFileHandle(handle: fs.promises.FileHandle) {
    try {
        await handle.sync();
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (
            process.platform != "win32" ||
            (code != "EPERM" && code != "EINVAL" && code != "ENOTSUP")
        ) {
            throw error;
        }
        durabilityDegraded = true;
    }
}

async function durableWrite(filePath: string, contents: string) {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${crypto
        .randomBytes(8)
        .toString("hex")}.tmp`;
    let handle: fs.promises.FileHandle | undefined;
    try {
        handle = await fs.promises.open(temporaryPath, "wx", 0o600);
        await handle.writeFile(contents, "utf8");
        await syncFileHandle(handle);
        await handle.close();
        handle = undefined;
        await fs.promises.rename(temporaryPath, filePath);
        await syncDirectory(path.dirname(filePath));
    } catch (error) {
        await handle?.close();
        await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
    }
}

export function extensionInstallJournalPath(root: string, transactionId: string) {
    if (!TRANSACTION_ID.test(transactionId)) {
        throw new Error("Invalid extension install journal transaction ID");
    }
    return path.join(root, "cache", ".staging", `journal.${transactionId}.json`);
}

export async function beginExtensionInstallJournal(
    root: string,
    draft: ExtensionInstallJournalDraft
) {
    if (!TRANSACTION_ID.test(draft.transactionId)) {
        throw new Error("Invalid extension install journal transaction ID");
    }
    const journalPath = extensionInstallJournalPath(root, draft.transactionId);
    try {
        await fs.promises.lstat(journalPath);
        throw new Error("Extension install journal transaction already exists");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code != "ENOENT") {
            throw error;
        }
    }
    const record = withChecksum({
        ...draft,
        version: EXTENSION_INSTALL_JOURNAL_VERSION,
        state: "prepared",
        sequence: 0,
        updatedAt: new Date().toISOString()
    });
    validateRecord(root, record);
    await durableWrite(journalPath, `${JSON.stringify(record)}\n`);
    return record;
}

export async function readExtensionInstallJournal(
    root: string,
    transactionId: string
) {
    const text = await fs.promises.readFile(
        extensionInstallJournalPath(root, transactionId),
        "utf8"
    );
    if (Buffer.byteLength(text, "utf8") > 64 * 1024) {
        throw new Error("Extension install journal exceeds 64 KiB");
    }
    return validateRecord(root, JSON.parse(text));
}

export async function advanceExtensionInstallJournal(
    root: string,
    transactionId: string,
    state: ExtensionInstallJournalState
) {
    const current = await readExtensionInstallJournal(root, transactionId);
    if (
        current.state == "committed" ||
        current.state == "rolled-back" ||
        STATE_ORDER[state] < STATE_ORDER[current.state]
    ) {
        throw new Error(
            `Invalid extension journal transition ${current.state} -> ${state}`
        );
    }
    const next = withChecksum({
        ...current,
        state,
        sequence: current.sequence + 1,
        updatedAt: new Date().toISOString()
    });
    await durableWrite(
        extensionInstallJournalPath(root, transactionId),
        `${JSON.stringify(next)}\n`
    );
    return next;
}

export async function removeExtensionInstallJournal(
    root: string,
    transactionId: string
) {
    await fs.promises.rm(extensionInstallJournalPath(root, transactionId), {
        force: true
    });
    await syncDirectory(path.join(root, "cache", ".staging"));
}

export async function listExtensionInstallJournals(
    root: string,
    options: { onError?: (error: unknown, filePath: string) => void } = {}
) {
    const staging = path.join(root, "cache", ".staging");
    await fs.promises.mkdir(staging, { recursive: true });
    const entries = await fs.promises.readdir(staging, { withFileTypes: true });
    const records: ExtensionInstallJournalRecord[] = [];
    for (const entry of entries) {
        const match = JOURNAL_FILE.exec(entry.name);
        if (!match) {
            continue;
        }
        if (!entry.isFile()) {
            throw new Error(`Extension install journal is not a file: ${entry.name}`);
        }
        try {
            records.push(await readExtensionInstallJournal(root, match[1]));
        } catch (error) {
            if (!options.onError) {
                throw error;
            }
            options.onError(error, path.join(staging, entry.name));
        }
    }
    return records.sort((left, right) => left.sequence - right.sequence);
}

export async function hashExtensionDirectory(directoryPath: string) {
    const hash = crypto.createHash("sha256");
    async function visit(currentPath: string, relativePath: string) {
        const entries = await fs.promises.readdir(currentPath, {
            withFileTypes: true
        });
        entries.sort((left, right) =>
            Buffer.compare(Buffer.from(left.name), Buffer.from(right.name))
        );
        for (const entry of entries) {
            const normalizedRelativePath = path
                .join(relativePath, entry.name)
                .split(path.sep)
                .join("/")
                .normalize("NFC");
            const entryPath = path.join(currentPath, entry.name);
            if (entry.isSymbolicLink()) {
                throw new Error("Extension package contains a symbolic link");
            }
            hash.update(entry.isDirectory() ? "d\0" : "f\0");
            hash.update(normalizedRelativePath, "utf8");
            hash.update("\0");
            if (entry.isDirectory()) {
                await visit(entryPath, normalizedRelativePath);
            } else if (entry.isFile()) {
                hash.update(await fs.promises.readFile(entryPath));
            } else {
                throw new Error("Extension package contains an unsupported entry");
            }
            hash.update("\0");
        }
    }
    await visit(directoryPath, "");
    return hash.digest("hex");
}

export async function durableRename(sourcePath: string, destinationPath: string) {
    await fs.promises.rename(sourcePath, destinationPath);
    await syncDirectory(path.dirname(sourcePath));
    if (path.dirname(sourcePath) != path.dirname(destinationPath)) {
        await syncDirectory(path.dirname(destinationPath));
    }
}

/** Flush every regular file and directory in an extracted package before it
 * becomes visible at the installed target path. */
export async function syncExtensionTree(directoryPath: string) {
    async function visit(currentPath: string) {
        const entries = await fs.promises.readdir(currentPath, {
            withFileTypes: true
        });
        for (const entry of entries) {
            const entryPath = path.join(currentPath, entry.name);
            if (entry.isSymbolicLink()) {
                throw new Error("Extension package contains a symbolic link");
            }
            if (entry.isDirectory()) {
                await visit(entryPath);
            } else if (entry.isFile()) {
                const handle = await fs.promises.open(entryPath, "r");
                try {
                    await syncFileHandle(handle);
                } finally {
                    await handle.close();
                }
            } else {
                throw new Error("Extension package contains an unsupported entry");
            }
        }
        await syncDirectory(currentPath);
    }
    await visit(directoryPath);
}

async function pathExists(candidatePath: string) {
    try {
        await fs.promises.lstat(candidatePath);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code == "ENOENT") return false;
        throw error;
    }
}

export interface DurableExtensionInstallOptions<T> {
    root: string;
    transactionId: string;
    extensionId: string;
    operation: "install" | "update";
    targetPath: string;
    incomingPath: string;
    backupPath: string;
    committedBackupPath: string;
    pendingInstallPath: string;
    installedMarkerPath: string;
    publisherFingerprint?: string;
    beforeTargetSwap?: () => Promise<void>;
    commit: () => Promise<T>;
    rollback?: (context: { previousTargetAvailable: boolean }) => Promise<void>;
    removeDirectory: (folderPath: string) => Promise<void>;
    reportCleanupError?: (error: unknown, folderPath: string) => void;
    checkpoint?: ExtensionInstallCheckpointHandler;
}

/** Execute the durable filesystem portion of the production install/update path. */
export async function runDurableExtensionInstall<T>(
    options: DurableExtensionInstallOptions<T>
) {
    const relativePath = (value: string) => path.relative(options.root, value);
    const oldDigest =
        options.operation == "update" && (await pathExists(options.targetPath))
            ? await hashExtensionDirectory(options.targetPath)
            : undefined;
    const newDigest = await hashExtensionDirectory(options.incomingPath);
    await syncExtensionTree(options.incomingPath);
    let record = await beginExtensionInstallJournal(options.root, {
        transactionId: options.transactionId,
        extensionId: options.extensionId,
        operation: options.operation,
        targetRelativePath: relativePath(options.targetPath),
        incomingRelativePath: relativePath(options.incomingPath),
        backupRelativePath: relativePath(options.backupPath),
        oldDigest,
        newDigest,
        publisherFingerprint: options.publisherFingerprint
    });
    await checkpoint(options.checkpoint, record);

    let backupCreated = false;
    let pendingInstallCreated = false;
    let replacementInstalled = false;
    let committed = false;
    try {
        record = await advanceExtensionInstallJournal(
            options.root,
            options.transactionId,
            "incoming-verified"
        );
        await checkpoint(options.checkpoint, record);
        await options.beforeTargetSwap?.();

        if (await pathExists(options.targetPath)) {
            await durableRename(options.targetPath, options.backupPath);
            backupCreated = true;
        } else {
            await fs.promises.mkdir(options.pendingInstallPath, {
                recursive: false
            });
            pendingInstallCreated = true;
        }
        record = await advanceExtensionInstallJournal(
            options.root,
            options.transactionId,
            "backup-moved"
        );
        await checkpoint(options.checkpoint, record);

        await durableRename(options.incomingPath, options.targetPath);
        replacementInstalled = true;
        record = await advanceExtensionInstallJournal(
            options.root,
            options.transactionId,
            "target-installed"
        );
        await checkpoint(options.checkpoint, record);

        const result = await options.commit();
        record = await advanceExtensionInstallJournal(
            options.root,
            options.transactionId,
            "committed"
        );
        committed = true;
        await checkpoint(options.checkpoint, record);

        if (backupCreated) {
            await durableRename(options.backupPath, options.committedBackupPath);
            backupCreated = false;
            try {
                await options.removeDirectory(options.committedBackupPath);
            } catch (error) {
                options.reportCleanupError?.(error, options.committedBackupPath);
            }
        } else if (pendingInstallCreated) {
            await durableRename(options.pendingInstallPath, options.installedMarkerPath);
            pendingInstallCreated = false;
            try {
                await options.removeDirectory(options.installedMarkerPath);
            } catch (error) {
                options.reportCleanupError?.(error, options.installedMarkerPath);
            }
        }
        await removeExtensionInstallJournal(options.root, options.transactionId);
        return result;
    } catch (error) {
        if (committed) throw error;
        record = await advanceExtensionInstallJournal(
            options.root,
            options.transactionId,
            "rolled-back"
        );
        await checkpoint(options.checkpoint, record);
        if (replacementInstalled && (await pathExists(options.targetPath))) {
            await options.removeDirectory(options.targetPath);
        } else if (await pathExists(options.incomingPath)) {
            await options.removeDirectory(options.incomingPath);
        }
        let previousTargetAvailable = false;
        if (backupCreated && (await pathExists(options.backupPath))) {
            await durableRename(options.backupPath, options.targetPath);
            previousTargetAvailable = true;
        } else if (
            pendingInstallCreated &&
            (await pathExists(options.pendingInstallPath))
        ) {
            await options.removeDirectory(options.pendingInstallPath);
        }
        if (
            options.operation == "update" &&
            (await pathExists(options.targetPath))
        ) {
            previousTargetAvailable = true;
        }
        await options.rollback?.({ previousTargetAvailable });
        throw error;
    }
}

export interface DurableExtensionUninstallOptions {
    root: string;
    transactionId: string;
    extensionId: string;
    targetPath: string;
    backupPath: string;
    removedPath: string;
    publisherFingerprint?: string;
    commit: () => Promise<void>;
    rollback?: () => Promise<void>;
    removeDirectory: (folderPath: string) => Promise<void>;
    reportCleanupError?: (error: unknown, folderPath: string) => void;
    checkpoint?: ExtensionInstallCheckpointHandler;
}

/** Execute the durable filesystem portion of the production uninstall path. */
export async function runDurableExtensionUninstall(
    options: DurableExtensionUninstallOptions
) {
    const targetExists = await pathExists(options.targetPath);
    let record = await beginExtensionInstallJournal(options.root, {
        transactionId: options.transactionId,
        extensionId: options.extensionId,
        operation: "uninstall",
        targetRelativePath: path.relative(options.root, options.targetPath),
        backupRelativePath: path.relative(options.root, options.backupPath),
        oldDigest: targetExists
            ? await hashExtensionDirectory(options.targetPath)
            : undefined,
        publisherFingerprint: options.publisherFingerprint
    });
    await checkpoint(options.checkpoint, record);

    let moved = false;
    let committed = false;
    try {
        if (targetExists) {
            await durableRename(options.targetPath, options.backupPath);
            moved = true;
        }
        record = await advanceExtensionInstallJournal(
            options.root,
            options.transactionId,
            "backup-moved"
        );
        await checkpoint(options.checkpoint, record);

        await options.commit();
        record = await advanceExtensionInstallJournal(
            options.root,
            options.transactionId,
            "committed"
        );
        committed = true;
        await checkpoint(options.checkpoint, record);

        if (moved) {
            await durableRename(options.backupPath, options.removedPath);
            moved = false;
            try {
                await options.removeDirectory(options.removedPath);
            } catch (error) {
                options.reportCleanupError?.(error, options.removedPath);
            }
        }
        await removeExtensionInstallJournal(options.root, options.transactionId);
    } catch (error) {
        if (committed) throw error;
        record = await advanceExtensionInstallJournal(
            options.root,
            options.transactionId,
            "rolled-back"
        );
        await checkpoint(options.checkpoint, record);
        if (moved && (await pathExists(options.backupPath))) {
            await durableRename(options.backupPath, options.targetPath);
        }
        await options.rollback?.();
        throw error;
    }
}
