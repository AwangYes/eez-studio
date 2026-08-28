import fs from "fs";
import path from "path";
import crypto from "crypto";

import {
    type ExtensionV1Configuration,
    validateExtensionV1PackageManifest
} from "../extensions-v1/manifest";
import {
    type ExtensionSignaturePolicy,
    verifyExtensionPackageSignature
} from "../extensions-v1/package-signature";
import {
    durableRename,
    listExtensionInstallJournals,
    removeExtensionInstallJournal
} from "./extension-install-journal";

const SAFE_EXTENSION_FOLDER_NAME = /^[a-z0-9][a-z0-9._-]{0,119}$/;
const OPAQUE_EXTENSION_FOLDER_NAME = /^%id-[0-9a-f]{64}$/;
const RESERVED_EXTENSION_FOLDER_NAMES = new Set(["cache", "node_modules"]);
const WINDOWS_RESERVED_FOLDER_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const STAGED_TRANSACTION_ID = /^[A-Za-z0-9_-]+$/;
const STAGED_BACKUP_NAME = /^backup\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;
const STAGED_COMMITTED_NAME = /^committed\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;
const STAGED_PENDING_NAME = /^pending\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;
const STAGED_INSTALLED_NAME = /^installed\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;
const STAGED_UNINSTALL_NAME = /^uninstall\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;
const STAGED_REMOVED_NAME = /^removed\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;
const DURABLE_JOURNAL_FILE = /^journal\.[A-Za-z0-9_-]+\.json$/;
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;

export const EXTENSION_STAGING_FOLDER_NAME = ".staging";

export class ExtensionStagingRecoveryError extends Error {
    readonly errors: readonly unknown[];

    constructor(errors: readonly unknown[]) {
        super("Failed to recover one or more extension staging transactions");
        this.name = "ExtensionStagingRecoveryError";
        this.errors = errors;
    }
}

export type ExtensionInstallType =
    | "built-in"
    | "iext"
    | "pext"
    | "extension-v1"
    | "measurement-functions";

export interface ExtensionInstallExpectation {
    readonly id: string;
    readonly version: string;
    readonly extensionType: ExtensionInstallType;
    /** SHA-256 SPKI fingerprint pinned by authoritative catalog metadata. */
    readonly publisherFingerprint?: string;
}

export interface PreparedExtensionPackage {
    readonly packageJson: any;
    readonly manifest?: ExtensionV1Configuration;
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly extensionType: "extension-v1" | "legacy";
    readonly staticExtensionType?: ExtensionInstallType;
    readonly hasEezStudioConfiguration: boolean;
    readonly publisherKeyId?: string;
    readonly publisherFingerprint?: string;
}

export interface PrepareExtensionPackageOptions extends ExtensionSignaturePolicy {
    readonly expected?: ExtensionInstallExpectation;
}

export interface ExtensionLoader<T> {
    loadExtension?: (folderPath: string) => T | undefined | Promise<T | undefined>;
}

export function assertPublisherIdentityCanReplace(
    existing: { publisherFingerprint?: string },
    replacement: { publisherFingerprint?: string },
    extensionId: string
) {
    if (
        existing.publisherFingerprint !== replacement.publisherFingerprint
    ) {
        throw new Error(
            `Extension publisher identity mismatch for ${extensionId}; uninstall the existing extension before changing publisher identity`
        );
    }
}

function opaqueFolderName(extensionId: string) {
    return `%id-${crypto
        .createHash("sha256")
        .update(extensionId, "utf8")
        .digest("hex")}`;
}

function encodeTargetFolderName(extensionId: string) {
    return Buffer.from(extensionIdToFolderName(extensionId), "utf8").toString(
        "base64url"
    );
}

function decodeTargetFolderName(value: string) {
    return Buffer.from(value, "base64url").toString("utf8");
}

export function extensionIdToFolderName(extensionId: string) {
    if (
        typeof extensionId != "string" ||
        extensionId.length == 0 ||
        extensionId.length > 1024
    ) {
        throw new Error("Extension ID must be a non-empty string");
    }
    if (
        SAFE_EXTENSION_FOLDER_NAME.test(extensionId) &&
        Buffer.byteLength(extensionId, "utf8") <= 120 &&
        !extensionId.endsWith(".") &&
        !WINDOWS_RESERVED_FOLDER_NAME.test(extensionId) &&
        !RESERVED_EXTENSION_FOLDER_NAMES.has(extensionId)
    ) {
        return extensionId;
    }
    return opaqueFolderName(extensionId);
}

export function extensionFolderPath(root: string, extensionId: string) {
    return path.join(root, extensionIdToFolderName(extensionId));
}

export function extensionStagingFolderPath(root: string) {
    return path.join(root, "cache", EXTENSION_STAGING_FOLDER_NAME);
}

function assertTransactionId(transactionId: string) {
    if (!STAGED_TRANSACTION_ID.test(transactionId)) {
        throw new Error("Invalid extension staging transaction ID");
    }
}

export function incomingExtensionFolderPath(root: string, transactionId: string) {
    assertTransactionId(transactionId);
    return path.join(extensionStagingFolderPath(root), `incoming.${transactionId}`);
}

export function backupExtensionFolderPath(
    root: string,
    extensionId: string,
    transactionId: string
) {
    assertTransactionId(transactionId);
    return path.join(
        extensionStagingFolderPath(root),
        `backup.${encodeTargetFolderName(extensionId)}.${transactionId}`
    );
}

export function committedExtensionFolderPath(
    root: string,
    extensionId: string,
    transactionId: string
) {
    assertTransactionId(transactionId);
    return path.join(
        extensionStagingFolderPath(root),
        `committed.${encodeTargetFolderName(extensionId)}.${transactionId}`
    );
}

export function pendingExtensionInstallPath(
    root: string,
    extensionId: string,
    transactionId: string
) {
    assertTransactionId(transactionId);
    return path.join(
        extensionStagingFolderPath(root),
        `pending.${encodeTargetFolderName(extensionId)}.${transactionId}`
    );
}

export function installedExtensionMarkerPath(
    root: string,
    extensionId: string,
    transactionId: string
) {
    assertTransactionId(transactionId);
    return path.join(
        extensionStagingFolderPath(root),
        `installed.${encodeTargetFolderName(extensionId)}.${transactionId}`
    );
}

export function uninstallExtensionFolderPath(
    root: string,
    extensionId: string,
    transactionId: string
) {
    assertTransactionId(transactionId);
    return path.join(
        extensionStagingFolderPath(root),
        `uninstall.${encodeTargetFolderName(extensionId)}.${transactionId}`
    );
}

export function removedExtensionFolderPath(
    root: string,
    extensionId: string,
    transactionId: string
) {
    assertTransactionId(transactionId);
    return path.join(
        extensionStagingFolderPath(root),
        `removed.${encodeTargetFolderName(extensionId)}.${transactionId}`
    );
}

export async function recoverExtensionStaging(
    root: string,
    options: {
        removeDirectory?: (folderPath: string) => Promise<void>;
        targetExtensionId?: string;
    } = {}
) {
    const stagingRoot = extensionStagingFolderPath(root);
    await fs.promises.mkdir(stagingRoot, { recursive: true });
    const removeDirectory =
        options.removeDirectory ??
        (folderPath => fs.promises.rm(folderPath, { recursive: true, force: true }));
    const recoveryErrors: unknown[] = [];

    // Journal recovery runs before legacy marker recovery. A valid journal is
    // authoritative for its transaction and is removed only after all cleanup
    // operations complete successfully. This makes restart recovery idempotent.
    // Keep malformed journals in place for forensic recovery, but allow
    // independent staging transactions to be reconciled on this startup.
    const journals = await listExtensionInstallJournals(root, {
        onError(error, filePath) {
            const wrapped = new Error(
                `Failed to read extension install journal ${filePath}`
            ) as Error & { cause?: unknown };
            wrapped.cause = error;
            recoveryErrors.push(wrapped);
        }
    });
    const activeJournalByExtension = new Map<string, string>();
    const conflictingJournalExtensions = new Set<string>();
    for (const journal of journals) {
        if (journal.state == "committed" || journal.state == "rolled-back") {
            continue;
        }
        const previous = activeJournalByExtension.get(journal.extensionId);
        if (previous && previous != journal.transactionId) {
            conflictingJournalExtensions.add(journal.extensionId);
            recoveryErrors.push(
                new Error(
                    `Conflicting durable extension transactions: ${journal.extensionId}`
                )
            );
        } else {
            activeJournalByExtension.set(journal.extensionId, journal.transactionId);
        }
    }
    for (const journal of journals) {
        if (conflictingJournalExtensions.has(journal.extensionId)) {
            continue;
        }
        const targetFolderName = extensionIdToFolderName(journal.extensionId);
        if (
            options.targetExtensionId != undefined &&
            targetFolderName != extensionIdToFolderName(options.targetExtensionId)
        ) {
            continue;
        }
        const resolveJournalPath = (relativePath: string | undefined) =>
            relativePath == undefined ? undefined : path.resolve(root, relativePath);
        const targetPath = resolveJournalPath(journal.targetRelativePath)!;
        const incomingPath = resolveJournalPath(journal.incomingRelativePath);
        const backupPath = resolveJournalPath(journal.backupRelativePath);
        const stagingPrefix = path.resolve(stagingRoot) + path.sep;
        if (
            path.resolve(targetPath) != path.resolve(root, targetFolderName) ||
            (incomingPath && !path.resolve(incomingPath).startsWith(stagingPrefix)) ||
            (backupPath && !path.resolve(backupPath).startsWith(stagingPrefix))
        ) {
            recoveryErrors.push(
                new Error(`Extension journal paths do not match ${journal.extensionId}`)
            );
            continue;
        }
        const exists = async (candidatePath: string | undefined) => {
            if (!candidatePath) return false;
            try {
                await fs.promises.lstat(candidatePath);
                return true;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code == "ENOENT") return false;
                throw error;
            }
        };
        try {
            const targetExists = await exists(targetPath);
            if (journal.state == "committed") {
                // A committed install/update keeps the target; committed
                // uninstall keeps it absent unless a later reinstall exists.
                if (journal.operation != "uninstall" && !targetExists) {
                    throw new Error(
                        `Committed extension target is missing: ${journal.extensionId}`
                    );
                }
                if (incomingPath) await removeDirectory(incomingPath);
                if (backupPath) await removeDirectory(backupPath);
            } else if (journal.state == "rolled-back") {
                if (incomingPath) await removeDirectory(incomingPath);
                if (backupPath) await removeDirectory(backupPath);
            } else if (journal.operation == "uninstall") {
                // The old package is parked at backupRelativePath until the
                // uninstall reaches committed. Restore it on interruption.
                if (!targetExists && backupPath && (await exists(backupPath))) {
                    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
                    await durableRename(backupPath, targetPath);
                } else if (backupPath) {
                    await removeDirectory(backupPath);
                }
                if (incomingPath) await removeDirectory(incomingPath);
            } else if (journal.state == "target-installed") {
                if (targetExists) await removeDirectory(targetPath);
                if (backupPath && (await exists(backupPath))) {
                    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
                    await durableRename(backupPath, targetPath);
                }
                if (incomingPath) await removeDirectory(incomingPath);
            } else {
                // prepared/incoming-verified/backup-moved: restore an existing
                // backup and discard the uncommitted incoming package.
                if (!targetExists && backupPath && (await exists(backupPath))) {
                    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
                    await durableRename(backupPath, targetPath);
                } else if (backupPath) {
                    await removeDirectory(backupPath);
                }
                if (incomingPath) await removeDirectory(incomingPath);
            }
            await removeExtensionInstallJournal(root, journal.transactionId);
        } catch (error) {
            recoveryErrors.push(error);
        }
    }
    const entries = await fs.promises.readdir(stagingRoot, {
        withFileTypes: true
    });

    async function exists(candidatePath: string) {
        try {
            await fs.promises.lstat(candidatePath);
            return true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code == "ENOENT") {
                return false;
            }
            throw error;
        }
    }

    type StagedEntry = {
        kind:
            | "backup"
            | "committed"
            | "pending"
            | "installed"
            | "uninstall"
            | "removed";
        path: string;
    };

    const stagedByTarget = new Map<string, StagedEntry[]>();
    const requestedTargetFolderName =
        options.targetExtensionId == undefined
            ? undefined
            : extensionIdToFolderName(options.targetExtensionId);

    for (const entry of entries.sort((left, right) =>
        Buffer.compare(Buffer.from(left.name), Buffer.from(right.name))
    )) {
        try {
            const stagedPath = path.join(stagingRoot, entry.name);
            // Durable journal files are handled above. Keep an unreadable or
            // unrecoverable journal for the next startup instead of deleting
            // evidence needed for deterministic recovery.
            if (DURABLE_JOURNAL_FILE.test(entry.name)) {
                continue;
            }
            if (!entry.isDirectory()) {
                if (requestedTargetFolderName == undefined) {
                    await removeDirectory(stagedPath);
                }
                continue;
            }

            const backup = STAGED_BACKUP_NAME.exec(entry.name);
            const committed = STAGED_COMMITTED_NAME.exec(entry.name);
            const pending = STAGED_PENDING_NAME.exec(entry.name);
            const installed = STAGED_INSTALLED_NAME.exec(entry.name);
            const uninstall = STAGED_UNINSTALL_NAME.exec(entry.name);
            const removed = STAGED_REMOVED_NAME.exec(entry.name);
            const transaction =
                backup ||
                committed ||
                pending ||
                installed ||
                uninstall ||
                removed;
            if (!transaction) {
                if (requestedTargetFolderName == undefined) {
                    await removeDirectory(stagedPath);
                }
                continue;
            }

            const targetFolderName = decodeTargetFolderName(transaction[1]);
            if (
                (!SAFE_EXTENSION_FOLDER_NAME.test(targetFolderName) &&
                    !OPAQUE_EXTENSION_FOLDER_NAME.test(targetFolderName)) ||
                WINDOWS_RESERVED_FOLDER_NAME.test(targetFolderName) ||
                RESERVED_EXTENSION_FOLDER_NAMES.has(targetFolderName)
            ) {
                throw new Error("Invalid extension staging target");
            }
            if (
                requestedTargetFolderName != undefined &&
                targetFolderName != requestedTargetFolderName
            ) {
                continue;
            }

            const kind: StagedEntry["kind"] = backup
                ? "backup"
                : committed
                  ? "committed"
                  : pending
                    ? "pending"
                    : installed
                      ? "installed"
                      : uninstall
                        ? "uninstall"
                        : "removed";
            const targetEntries = stagedByTarget.get(targetFolderName) ?? [];
            targetEntries.push({
                kind,
                path: stagedPath
            });
            stagedByTarget.set(targetFolderName, targetEntries);
        } catch (error) {
            recoveryErrors.push(error);
        }
    }

    for (const [targetFolderName, targetEntries] of stagedByTarget) {
        try {
            const targetPath = path.join(root, targetFolderName);
            const targetExists = await exists(targetPath);
            const hasInstalledState = targetEntries.some(
                entry => entry.kind == "committed" || entry.kind == "installed"
            );
            const hasRemovedState = targetEntries.some(
                entry => entry.kind == "removed"
            );
            const removeWithTerminalStateLast = async () => {
                const orderedEntries = [...targetEntries].sort((left, right) => {
                    const leftTerminal =
                        left.kind == "committed" ||
                        left.kind == "installed" ||
                        left.kind == "removed";
                    const rightTerminal =
                        right.kind == "committed" ||
                        right.kind == "installed" ||
                        right.kind == "removed";
                    return Number(leftTerminal) - Number(rightTerminal);
                });
                for (const entry of orderedEntries) {
                    await removeDirectory(entry.path);
                }
            };

            // A committed state is authoritative for the matching target. Any
            // older rollback marker is stale and must not overwrite or remove
            // the successfully installed package. A committed uninstall is
            // authoritative only while the target remains absent; if a target
            // exists it belongs to a later reinstall and is preserved.
            if (hasInstalledState && targetExists) {
                await removeWithTerminalStateLast();
                continue;
            }
            if (hasRemovedState && !targetExists) {
                await removeWithTerminalStateLast();
                continue;
            }
            if (hasRemovedState && targetExists) {
                await removeWithTerminalStateLast();
                continue;
            }
            if (hasInstalledState && !targetExists) {
                throw new Error(
                    `Committed extension target is missing: ${targetFolderName}`
                );
            }

            if (targetEntries.length != 1) {
                throw new Error(
                    `Conflicting extension staging transactions: ${targetFolderName}`
                );
            }

            const [entry] = targetEntries;
            if (entry.kind == "backup") {
                if (targetExists) {
                    await removeDirectory(targetPath);
                }
                await fs.promises.rename(entry.path, targetPath);
            } else if (entry.kind == "pending") {
                if (targetExists) {
                    await removeDirectory(targetPath);
                }
                await removeDirectory(entry.path);
            } else if (entry.kind == "uninstall") {
                if (targetExists) {
                    await removeDirectory(entry.path);
                } else {
                    await fs.promises.rename(entry.path, targetPath);
                }
            } else {
                await removeDirectory(entry.path);
            }
        } catch (error) {
            recoveryErrors.push(error);
        }
    }
    if (recoveryErrors.length > 0) {
        throw new ExtensionStagingRecoveryError(recoveryErrors);
    }
}

export async function inspectExtensionPackageStatic(
    packageRoot: string
): Promise<PreparedExtensionPackage | undefined> {
    const packageJsonPath = path.join(packageRoot, "package.json");
    let packageJsonText: string;
    try {
        const stat = await fs.promises.stat(packageJsonPath);
        if (!stat.isFile() || stat.size > MAX_PACKAGE_JSON_BYTES) {
            throw new Error("Extension package.json exceeds the 1 MiB limit");
        }
        packageJsonText = await fs.promises.readFile(packageJsonPath, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code == "ENOENT") {
            return undefined;
        }
        throw error;
    }

    const packageJson = JSON.parse(packageJsonText);
    const configuration = packageJson?.["eez-studio"];
    if (
        configuration !== undefined &&
        (!configuration || typeof configuration != "object")
    ) {
        throw new Error("Extension eez-studio configuration must be an object");
    }

    if (configuration?.apiVersion != undefined) {
        const manifest = validateExtensionV1PackageManifest(packageJson);
        return {
            packageJson: manifest,
            manifest: manifest.eezStudio,
            id: manifest.id,
            name: manifest.name,
            version: manifest.version,
            extensionType: "extension-v1",
            staticExtensionType: "extension-v1",
            hasEezStudioConfiguration: true
        };
    }

    const id = packageJson.id ?? packageJson.name;
    if (
        typeof id != "string" ||
        id.length == 0 ||
        typeof packageJson.name != "string" ||
        packageJson.name.length == 0 ||
        typeof packageJson.version != "string" ||
        packageJson.version.length == 0
    ) {
        throw new Error("Legacy extension package identity is incomplete");
    }
    return {
        packageJson,
        id,
        name: packageJson.name,
        version: packageJson.version,
        extensionType: "legacy",
        staticExtensionType:
            configuration?.main != undefined
                ? "measurement-functions"
                : configuration?.["node-module"]
                  ? "pext"
                  : undefined,
        hasEezStudioConfiguration: configuration !== undefined
    };
}

function assertExpectedPackage(
    inspection: PreparedExtensionPackage,
    expected: ExtensionInstallExpectation
) {
    if (
        expected.publisherFingerprint != undefined &&
        !/^[0-9a-f]{64}$/.test(expected.publisherFingerprint)
    ) {
        throw new Error("Catalog publisher fingerprint must be a SHA-256 digest");
    }
    if (inspection.id != expected.id) {
        throw new Error(
            `Extension package ID mismatch: expected ${expected.id}, got ${inspection.id}`
        );
    }
    if (inspection.version != expected.version) {
        throw new Error(
            `Extension package version mismatch: expected ${expected.version}, got ${inspection.version}`
        );
    }
    const expectedV1 = expected.extensionType == "extension-v1";
    const actualV1 = inspection.extensionType == "extension-v1";
    if (expectedV1 != actualV1) {
        throw new Error(
            expectedV1
                ? "Catalog entry requires an Extension Platform V1 package"
                : "Catalog entry explicitly declares a legacy package"
        );
    }
    if (
        inspection.staticExtensionType != undefined &&
        inspection.staticExtensionType != expected.extensionType
    ) {
        throw new Error(
            `Extension package type mismatch: expected ${expected.extensionType}, got ${inspection.staticExtensionType}`
        );
    }
}

export function assertLoadedExtensionMatchesExpectation(
    extension: {
        id: string;
        version: string;
        extensionType: ExtensionInstallType;
        publisherFingerprint?: string;
    },
    expected: ExtensionInstallExpectation
) {
    if (
        extension.id != expected.id ||
        extension.version != expected.version ||
        extension.extensionType != expected.extensionType ||
        (expected.publisherFingerprint != undefined &&
            extension.publisherFingerprint != expected.publisherFingerprint)
    ) {
        throw new Error(
            `Loaded extension does not match catalog entry ${expected.id}@${expected.version} (${expected.extensionType})`
        );
    }
}

export async function loadExtensionUsingLoaders<T>(
    folderPath: string,
    loaders: Iterable<ExtensionLoader<T>>
) {
    for (const loader of loaders) {
        if (loader.loadExtension) {
            const extension = await loader.loadExtension(folderPath);
            if (extension) {
                return extension;
            }
        }
    }
    return undefined;
}

export async function prepareExtensionPackageForInstall(
    packageRoot: string,
    options: PrepareExtensionPackageOptions
) {
    const inspection = await inspectExtensionPackageStatic(packageRoot);
    if (!inspection) {
        return undefined;
    }
    if (options.source == "catalog" && !options.expected) {
        throw new Error("Catalog extension installs require expected package metadata");
    }
    if (options.expected) {
        assertExpectedPackage(inspection, options.expected);
        if (
            options.source == "catalog" &&
            options.expected.extensionType == "extension-v1" &&
            options.expected.publisherFingerprint == undefined
        ) {
            throw new Error(
                "Catalog V1 entries must pin a publisher fingerprint"
            );
        }
    }

    if (inspection.extensionType == "extension-v1") {
        const signature = await verifyExtensionPackageSignature(packageRoot, options);
        const publisherFingerprint = signature.signed
            ? signature.publisherFingerprint
            : undefined;
        if (
            options.expected?.publisherFingerprint != undefined &&
            publisherFingerprint != options.expected.publisherFingerprint
        ) {
            throw new Error(
                `Extension publisher fingerprint mismatch for ${inspection.id}`
            );
        }
        return {
            ...inspection,
            publisherKeyId: signature.signed ? signature.keyId : undefined,
            publisherFingerprint
        };
    }
    return inspection;
}
