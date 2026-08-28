import fs from "fs";
import path from "path";

export class UnsafeBuildPathError extends Error {
    readonly code = "UNSAFE_BUILD_PATH";

    constructor(public relativePath: string) {
        super(`Unsafe build output path: ${relativePath}`);
        this.name = "UnsafeBuildPathError";
    }
}

function isContainedPath(rootPath: string, candidatePath: string) {
    const relativePath = path.relative(rootPath, candidatePath);
    return (
        relativePath == "" ||
        (!relativePath.startsWith(`..${path.sep}`) &&
            relativePath != ".." &&
            !path.isAbsolute(relativePath))
    );
}

function assertExistingPathComponentsContained(
    rootPath: string,
    candidatePath: string,
    relativePath: string
) {
    if (!fs.existsSync(rootPath)) {
        return;
    }

    const realRootPath = fs.realpathSync(rootPath);
    let currentPath = rootPath;
    const pathFromRoot = path.relative(rootPath, candidatePath);
    for (const component of pathFromRoot.split(path.sep)) {
        if (!component) {
            continue;
        }
        currentPath = path.join(currentPath, component);
        if (!fs.existsSync(currentPath)) {
            break;
        }
        if (!isContainedPath(realRootPath, fs.realpathSync(currentPath))) {
            throw new UnsafeBuildPathError(relativePath);
        }
    }
}

export function resolveBuildOutputPath(
    destinationFolderPath: string,
    relativePath: string
) {
    if (
        typeof relativePath != "string" ||
        relativePath.length == 0 ||
        relativePath.indexOf("\0") != -1
    ) {
        throw new UnsafeBuildPathError(String(relativePath));
    }

    const portablePath = relativePath.replace(/\\/g, "/");
    if (
        path.posix.isAbsolute(portablePath) ||
        path.win32.isAbsolute(relativePath) ||
        portablePath.split("/").some(component => component == "..")
    ) {
        throw new UnsafeBuildPathError(relativePath);
    }

    const rootPath = path.resolve(destinationFolderPath);
    const candidatePath = path.resolve(
        rootPath,
        ...portablePath.split("/").filter(component => component != "")
    );
    if (!isContainedPath(rootPath, candidatePath) || candidatePath == rootPath) {
        throw new UnsafeBuildPathError(relativePath);
    }
    assertExistingPathComponentsContained(rootPath, candidatePath, relativePath);
    return candidatePath;
}

export function validateBuildManifestFiles(
    destinationFolderPath: string,
    files: unknown
) {
    if (
        !Array.isArray(files) ||
        files.some(file => typeof file != "string")
    ) {
        throw new UnsafeBuildPathError("<invalid manifest>");
    }
    return files.map(file => {
        resolveBuildOutputPath(destinationFolderPath, file);
        return file.replace(/\\/g, "/");
    });
}

export async function createBuildStagingFolder(destinationFolderPath: string) {
    const destinationPath = path.resolve(destinationFolderPath);
    const parentPath = path.dirname(destinationPath);
    await fs.promises.mkdir(parentPath, { recursive: true });
    return fs.promises.mkdtemp(
        path.join(parentPath, `.${path.basename(destinationPath)}.eez-stage-`)
    );
}

function listStagedFiles(stagingFolderPath: string, directoryPath: string) {
    const files: string[] = [];
    for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
        const entryPath = path.join(directoryPath, entry.name);
        if (entry.isSymbolicLink()) {
            throw new UnsafeBuildPathError(
                path.relative(stagingFolderPath, entryPath)
            );
        }
        if (entry.isDirectory()) {
            files.push(...listStagedFiles(stagingFolderPath, entryPath));
        } else if (entry.isFile()) {
            files.push(entryPath);
        } else {
            throw new UnsafeBuildPathError(
                path.relative(stagingFolderPath, entryPath)
            );
        }
    }
    return files;
}

/**
 * This deliberately uses synchronous operations. The caller performs its final
 * cancellation and revision checks immediately before entering this function,
 * so renderer events cannot invalidate that guard halfway through the commit.
 */
export function commitStagedBuildSync(
    stagingFolderPath: string,
    destinationFolderPath: string,
    orphanedFiles: readonly string[] = []
) {
    const destinationPath = path.resolve(destinationFolderPath);
    const stagedFiles = listStagedFiles(stagingFolderPath, stagingFolderPath);

    fs.mkdirSync(destinationPath, { recursive: true });
    for (const stagedFilePath of stagedFiles) {
        const relativePath = path.relative(stagingFolderPath, stagedFilePath);
        const destinationFilePath = resolveBuildOutputPath(
            destinationPath,
            relativePath
        );
        fs.mkdirSync(path.dirname(destinationFilePath), { recursive: true });
        fs.renameSync(stagedFilePath, destinationFilePath);
    }

    for (const orphanedFile of orphanedFiles) {
        const orphanedFilePath = resolveBuildOutputPath(
            destinationPath,
            orphanedFile
        );
        try {
            fs.unlinkSync(orphanedFilePath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code != "ENOENT") {
                throw error;
            }
        }
    }
}

export function commitGuardedStagedBuildSync(
    stagingFolderPath: string,
    destinationFolderPath: string,
    orphanedFiles: readonly string[],
    assertCanCommit: () => void
) {
    assertCanCommit();
    commitStagedBuildSync(
        stagingFolderPath,
        destinationFolderPath,
        orphanedFiles
    );
}

export async function removeBuildStagingFolder(stagingFolderPath?: string) {
    if (stagingFolderPath) {
        await fs.promises.rm(stagingFolderPath, {
            recursive: true,
            force: true
        });
    }
}
