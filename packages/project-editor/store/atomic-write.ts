import crypto from "crypto";
import fs from "fs";
import path from "path";

export interface AtomicWriteOptions {
    expectedDiskHash?: string;
}

export interface ProjectSaveTargetState {
    filePath: string | undefined;
    diskHash: string | undefined;
}

export class ProjectSaveQueue {
    private pending: Promise<void> = Promise.resolve();

    enqueue<T>(operation: () => Promise<T>) {
        const result = this.pending.then(operation);
        this.pending = result.then(
            () => undefined,
            () => undefined
        );
        return result;
    }
}

export async function runPostCommitAuxiliarySave(
    operation: () => Promise<void>,
    onError: (error: unknown) => void = error =>
        console.warn("Post-commit project save task failed", error)
) {
    try {
        await operation();
    } catch (error) {
        onError(error);
    }
}

export async function withProjectSaveTarget<T>(
    previousState: ProjectSaveTargetState,
    targetFilePath: string,
    setState: (state: ProjectSaveTargetState) => void,
    operation: () => Promise<T>
) {
    setState({ filePath: targetFilePath, diskHash: undefined });
    try {
        return await operation();
    } catch (error) {
        setState(previousState);
        throw error;
    }
}

export class DiskHashConflictError extends Error {
    readonly code = "PROJECT_DISK_HASH_CONFLICT";

    constructor(
        public filePath: string,
        public expectedDiskHash: string,
        public actualDiskHash: string | undefined
    ) {
        super(
            `Project file changed on disk: expected ${expectedDiskHash}, got ${
                actualDiskHash ?? "<missing>"
            }`
        );
        this.name = "DiskHashConflictError";
    }
}

export function hashContent(content: string | Buffer) {
    return crypto.createHash("sha256").update(content).digest("hex");
}

export async function getFileHash(filePath: string) {
    try {
        return hashContent(await fs.promises.readFile(filePath));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code == "ENOENT") {
            return undefined;
        }
        throw error;
    }
}

export function assertExpectedDiskHash(
    filePath: string,
    expectedDiskHash: string | undefined,
    actualDiskHash: string | undefined
) {
    if (
        expectedDiskHash != undefined &&
        expectedDiskHash != actualDiskHash
    ) {
        throw new DiskHashConflictError(
            filePath,
            expectedDiskHash,
            actualDiskHash
        );
    }
}

export function getAtomicTempFilePath(filePath: string, nonce: string) {
    return path.join(
        path.dirname(filePath),
        `.${path.basename(filePath)}.${nonce}.tmp`
    );
}

const pendingWrites = new Map<string, Promise<string>>();

async function syncDirectory(directoryPath: string) {
    let directory: fs.promises.FileHandle | undefined;
    try {
        directory = await fs.promises.open(directoryPath, "r");
        await directory.sync();
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (
            code != "EINVAL" &&
            code != "EPERM" &&
            code != "EISDIR" &&
            code != "ENOTSUP"
        ) {
            throw error;
        }
    } finally {
        await directory?.close();
    }
}

async function renameReplacing(sourcePath: string, destinationPath: string) {
    for (let attempt = 0; ; attempt++) {
        try {
            // Both paths are in the same directory. libuv uses replace-existing
            // rename semantics on Windows, so no non-atomic unlink fallback is
            // needed or permitted here.
            await fs.promises.rename(sourcePath, destinationPath);
            return;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (
                process.platform != "win32" ||
                attempt >= 4 ||
                (code != "EACCES" && code != "EPERM" && code != "EBUSY")
            ) {
                throw error;
            }
            await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)));
        }
    }
}

async function atomicWriteFileUnlocked(
    filePath: string,
    content: string | Buffer,
    options: AtomicWriteOptions
) {
    const actualDiskHash = await getFileHash(filePath);
    assertExpectedDiskHash(
        filePath,
        options.expectedDiskHash,
        actualDiskHash
    );

    const directoryPath = path.dirname(filePath);
    const tempFilePath = getAtomicTempFilePath(
        filePath,
        `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    let tempFile: fs.promises.FileHandle | undefined;

    try {
        tempFile = await fs.promises.open(tempFilePath, "wx");
        await tempFile.writeFile(content, "utf8");
        await tempFile.sync();
        await tempFile.close();
        tempFile = undefined;

        // Check again immediately before replace. The per-path queue makes this
        // a true CAS for concurrent saves in this process.
        assertExpectedDiskHash(
            filePath,
            options.expectedDiskHash,
            await getFileHash(filePath)
        );

        await renameReplacing(tempFilePath, filePath);
        try {
            await syncDirectory(directoryPath);
        } catch (error) {
            // The replacement has already committed. Reporting a normal save
            // failure here would leave ProjectStore's path and hash stale even
            // though the target contains the new content.
            console.warn(
                `Project file was replaced but its directory could not be flushed: ${directoryPath}`,
                error
            );
        }
        return hashContent(content);
    } catch (error) {
        await tempFile?.close();
        try {
            await fs.promises.unlink(tempFilePath);
        } catch (unlinkError) {
            if ((unlinkError as NodeJS.ErrnoException).code != "ENOENT") {
                throw unlinkError;
            }
        }
        throw error;
    }
}

export function atomicWriteFile(
    filePath: string,
    content: string | Buffer,
    options: AtomicWriteOptions = {}
) {
    const normalizedFilePath = path.resolve(filePath);
    const previousWrite = pendingWrites.get(normalizedFilePath);
    const write = (previousWrite ?? Promise.resolve("")).then(
        () => atomicWriteFileUnlocked(normalizedFilePath, content, options),
        () => atomicWriteFileUnlocked(normalizedFilePath, content, options)
    );
    pendingWrites.set(normalizedFilePath, write);

    return write.finally(() => {
        if (pendingWrites.get(normalizedFilePath) == write) {
            pendingWrites.delete(normalizedFilePath);
        }
    });
}
