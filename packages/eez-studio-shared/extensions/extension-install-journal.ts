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

let durabilityAdapter: ExtensionDurabilityAdapter | undefined;
export function setExtensionDurabilityAdapter(
    adapter: ExtensionDurabilityAdapter | undefined
) {
    durabilityAdapter = adapter;
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

async function durableWrite(filePath: string, contents: string) {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${crypto
        .randomBytes(8)
        .toString("hex")}.tmp`;
    let handle: fs.promises.FileHandle | undefined;
    try {
        handle = await fs.promises.open(temporaryPath, "wx", 0o600);
        await handle.writeFile(contents, "utf8");
        await handle.sync();
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
                    await handle.sync();
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
