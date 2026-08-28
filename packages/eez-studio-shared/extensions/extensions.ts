import { observable, action } from "mobx";
import fs from "fs";

import { delay } from "eez-studio-shared/util";
import {
    localPathToFileUrl,
    fileExists,
    copyFile,
    removeFolder,
    renameFile,
    readFolder
} from "eez-studio-shared/util-electron";
import { guid } from "eez-studio-shared/guid";
import { firstWord } from "eez-studio-shared/string";

import { registerSource, sendMessage, watch } from "eez-studio-shared/notify";

import {
    ExtensionDeactivationReason,
    ExtensionManifest,
    IExtension,
    IExtensionProperties,
    ExtensionType
} from "eez-studio-shared/extensions/extension";
import { ManagedExtensionContext } from "eez-studio-shared/extensions/extension-context";
import {
    type ExtensionSignaturePolicy,
    verifyExtensionPackageSignature
} from "eez-studio-shared/extensions-v1/package-signature";
import { TRUSTED_EXTENSION_PUBLISHERS } from "eez-studio-shared/extensions-v1/trusted-publishers";
import { extractExtensionArchiveSafely } from "eez-studio-shared/extensions-v1/archive";
import {
    assertLoadedExtensionMatchesExpectation,
    assertPublisherIdentityCanReplace,
    backupExtensionFolderPath,
    committedExtensionFolderPath,
    type ExtensionInstallExpectation,
    incomingExtensionFolderPath,
    inspectExtensionPackageStatic,
    installedExtensionMarkerPath,
    loadExtensionUsingLoaders,
    pendingExtensionInstallPath,
    prepareExtensionPackageForInstall,
    recoverExtensionStaging,
    removedExtensionFolderPath,
    uninstallExtensionFolderPath
} from "eez-studio-shared/extensions/extension-installation";
import {
    EXTENSION_ACTIVATION_TIMEOUT_MS,
    EXTENSION_CLEANUP_TIMEOUT_MS,
    ExtensionLifecycleCoordinator,
    runExtensionLifecycleOperation
} from "eez-studio-shared/extensions/extension-lifecycle";
import { ExtensionOperationQueue } from "eez-studio-shared/extensions/extension-operation-queue";
import {
    advanceExtensionInstallJournal,
    beginExtensionInstallJournal,
    durableRename,
    hashExtensionDirectory,
    removeExtensionInstallJournal,
    syncExtensionTree
} from "eez-studio-shared/extensions/extension-install-journal";

import {
    preInstalledExtensionsFolderPath,
    extensionsFolderPath,
    getExtensionFolderPath
} from "eez-studio-shared/extensions/extension-folder";

import type * as ShortcutsStoreModule from "shortcuts/shortcuts-store";
import path from "path";

import { yarnUninstall } from "eez-studio-shared/extensions/yarn";

export const CONF_EEZ_STUDIO_PROPERTY_NAME = "eez-studio";
export const CONF_MAIN_SCRIPT_PROPERTY_NAME = "main";
export const CONF_NODE_MODULE_PROPERTY_NAME = "node-module";

interface ExtensionPackage {
    packageJson: any;
    manifest: ExtensionManifest | undefined;
}

interface ActivatedExtension {
    extension: IExtension;
    context?: ManagedExtensionContext;
}

const activatedExtensions = new Map<string, ActivatedExtension>();
// Deactivation is keyed by object identity so concurrent reload/uninstall
// requests share one bounded cleanup operation. A new generation with the
// same extension ID cannot be removed by an older generation's finally block.
const lifecycleCoordinator = new ExtensionLifecycleCoordinator();
const extensionOperationQueue = new ExtensionOperationQueue();

function isPathInsideOrEqual(candidatePath: string, rootPath: string) {
    const relativePath = path.relative(
        path.resolve(rootPath),
        path.resolve(candidatePath)
    );
    return (
        relativePath == "" ||
        (relativePath != ".." &&
            !relativePath.startsWith(`..${path.sep}`) &&
            !path.isAbsolute(relativePath))
    );
}

function isExtensionDeveloperModeEnabled() {
    return (
        process.env.EEZ_STUDIO_EXTENSION_DEVELOPER_MODE == "1" ||
        process.argv.includes("--extension-developer-mode")
    );
}

function getInstalledExtensionSignaturePolicy(): ExtensionSignaturePolicy {
    return {
        source: "local",
        developerMode: isExtensionDeveloperModeEnabled(),
        trustedKeys: TRUSTED_EXTENSION_PUBLISHERS
    };
}

async function readExtensionPackage(
    extensionFolderPath: string,
    requiredV1Id?: string
): Promise<ExtensionPackage | undefined> {
    const inspection = await inspectExtensionPackageStatic(extensionFolderPath);
    if (
        requiredV1Id != undefined &&
        (inspection?.extensionType != "extension-v1" ||
            inspection.id != requiredV1Id)
    ) {
        return undefined;
    }
    return inspection?.hasEezStudioConfiguration
        ? {
              packageJson: inspection.packageJson,
              manifest: inspection.manifest
          }
        : undefined;
}

function clearExtensionRequireCache(extensionFolderPath: string) {
    const folderPaths = [path.resolve(extensionFolderPath)];
    try {
        folderPaths.push(fs.realpathSync(extensionFolderPath));
    } catch (err) {}

    for (const modulePath of Object.keys(require.cache)) {
        if (
            folderPaths.some(
                folderPath =>
                    modulePath == folderPath ||
                    modulePath.startsWith(folderPath + path.sep)
            )
        ) {
            delete require.cache[modulePath];
        }
    }
}

function normalizeAuthor(author: unknown) {
    if (typeof author == "string") {
        return author;
    }
    if (author && typeof author == "object" && "name" in author) {
        return String((author as { name: unknown }).name);
    }
    return "";
}

async function applyPackageMetadata(
    extension: IExtension,
    extensionPackage: ExtensionPackage,
    extensionFolderPath: string,
    extensionType: ExtensionType
) {
    const { packageJson, manifest } = extensionPackage;
    const eezStudio =
        manifest || packageJson[CONF_EEZ_STUDIO_PROPERTY_NAME];

    extension.id = packageJson.id || packageJson.name;
    extension.extensionType = extensionType;
    extension.name = packageJson.name;
    extension.displayName = packageJson.displayName;
    extension.version = packageJson.version;
    extension.author = manifest
        ? normalizeAuthor(packageJson.author)
        : packageJson.author;
    extension.description = packageJson.description;
    extension.moreDescription = eezStudio.moreDescription;
    extension.download = packageJson.download;
    extension.sha256 = packageJson.sha256;
    extension.installationFolderPath = extensionFolderPath;
    extension.apiVersion = manifest?.apiVersion;
    extension.manifest = manifest;
    if (manifest) {
        extension.preInstalled = isPathInsideOrEqual(
            extensionFolderPath,
            preInstalledExtensionsFolderPath
        );
    }

    extension.image = packageJson.image;
    if (extension.image) {
        const imageFilePath = path.join(
            extensionFolderPath,
            extension.image
        );
        if (await fileExists(imageFilePath)) {
            extension.image = localPathToFileUrl(imageFilePath);
        }
    }

    return extension;
}

async function loadExtension(
    extensionFolderPath: string,
    signaturePolicy = getInstalledExtensionSignaturePolicy(),
    requiredV1Id?: string
): Promise<IExtension | undefined> {
    let mayUseExtensionLoaderFallback = false;
    try {
        const extensionPackage = await readExtensionPackage(
            extensionFolderPath,
            requiredV1Id
        );
        if (!extensionPackage) {
            mayUseExtensionLoaderFallback = requiredV1Id == undefined;
        } else {
            const { packageJson, manifest } = extensionPackage;
            const eezStudio = packageJson[CONF_EEZ_STUDIO_PROPERTY_NAME];

            let extension: IExtension | undefined;
            let extensionType: ExtensionType | undefined;
            let publisherKeyId: string | undefined;
            let publisherFingerprint: string | undefined;
            if (manifest) {
                // Reverify on every process load/reload. Persistent grants are
                // keyed by extension identity, so trusting installation-time
                // verification alone would allow post-install replacement.
                const signature = await verifyExtensionPackageSignature(
                    extensionFolderPath,
                    signaturePolicy
                );
                publisherKeyId = signature.signed
                    ? signature.keyId
                    : undefined;
                publisherFingerprint = signature.signed
                    ? signature.publisherFingerprint
                    : undefined;
                // V1 code is activated exclusively by the sandbox host. The
                // legacy loader only registers its statically parsed metadata.
                extension = {} as IExtension;
                extensionType = "extension-v1";
            } else {
                const mainScript =
                    eezStudio[CONF_MAIN_SCRIPT_PROPERTY_NAME];
                if (mainScript) {
                    extensionType = "measurement-functions";
                    extension = require(extensionFolderPath +
                        "/" +
                        mainScript).default;
                } else if (
                    eezStudio[CONF_NODE_MODULE_PROPERTY_NAME]
                ) {
                    extensionType = "pext";
                    extension = require(extensionFolderPath).default;
                } else {
                    // Instrument and other legacy package formats are handled
                    // by registered compatibility loaders.
                    mayUseExtensionLoaderFallback = true;
                }
            }

            if (extension && extensionType) {
                const registeredExtension = await applyPackageMetadata(
                    extension,
                    extensionPackage,
                    extensionFolderPath,
                    extensionType
                );
                registeredExtension.publisherKeyId = publisherKeyId;
                registeredExtension.publisherFingerprint = publisherFingerprint;
                return registeredExtension;
            }
        }
    } catch (err) {
        console.error(err);
        return undefined;
    }

    if (!mayUseExtensionLoaderFallback) {
        return undefined;
    }

    if (
        isPathInsideOrEqual(
            extensionFolderPath,
            preInstalledExtensionsFolderPath
        )
    ) {
        return undefined;
    }

    return loadExtensionUsingLoaders(extensionFolderPath, extensions.values());
}

async function deactivateExtension(
    extension: IExtension,
    reason: ExtensionDeactivationReason
) {
    await lifecycleCoordinator.cleanupOnce(extension as object, async () => {
    const state = activatedExtensions.get(extension.id);
    if (state?.context) {
        state.context.abort();
    }

    try {
        if (extension.deactivate) {
            await runExtensionLifecycleOperation(
                extension.id,
                "deactivation",
                EXTENSION_CLEANUP_TIMEOUT_MS,
                () => extension.deactivate!(reason)
            );
        } else if (extension.destroy) {
            await runExtensionLifecycleOperation(
                extension.id,
                "destruction",
                EXTENSION_CLEANUP_TIMEOUT_MS,
                () => extension.destroy!()
            );
        }
    } catch (err) {
        console.error(`Failed to deactivate extension ${extension.id}`, err);
    }

    if (state?.context) {
        await state.context.dispose(EXTENSION_CLEANUP_TIMEOUT_MS);
    }

    if (activatedExtensions.get(extension.id)?.extension === extension) {
        activatedExtensions.delete(extension.id);
    }
    });
}

export async function registerExtension(
    extension: IExtension,
    replaceReason: ExtensionDeactivationReason = "replace"
) {
    const existingExtension = extensions.get(extension.id);
    if (existingExtension) {
        await deactivateExtension(existingExtension, replaceReason);
        action(() => extensions.delete(extension.id))();
    }

    let context: ManagedExtensionContext | undefined;
    try {
        if (extension.activate) {
            context = new ManagedExtensionContext(
                extension.id,
                extension.version,
                extension.apiVersion || extension.manifest?.apiVersion || "1.0"
            );
            const activationDisposable = await runExtensionLifecycleOperation(
                extension.id,
                "activation",
                EXTENSION_ACTIVATION_TIMEOUT_MS,
                () => extension.activate!(context!)
            );
            if (activationDisposable) {
                context.subscriptions.push(activationDisposable);
            }
        } else if (extension.init) {
            await runExtensionLifecycleOperation(
                extension.id,
                "initialization",
                EXTENSION_ACTIVATION_TIMEOUT_MS,
                () => extension.init!()
            );
        }
    } catch (err) {
        if (context) {
            context.abort();
            try {
                if (extension.deactivate) {
                    await runExtensionLifecycleOperation(
                        extension.id,
                        "activation-error deactivation",
                        EXTENSION_CLEANUP_TIMEOUT_MS,
                        () => extension.deactivate!("activation-error")
                    );
                }
            } catch (deactivationError) {
                console.error(
                    `Failed to clean up extension ${extension.id} after activation error`,
                    deactivationError
                );
            }
            await context.dispose(EXTENSION_CLEANUP_TIMEOUT_MS);
        } else if (extension.destroy) {
            try {
                await runExtensionLifecycleOperation(
                    extension.id,
                    "initialization-error destruction",
                    EXTENSION_CLEANUP_TIMEOUT_MS,
                    () => extension.destroy!()
                );
            } catch (destroyError) {
                console.error(
                    `Failed to clean up extension ${extension.id} after initialization error`,
                    destroyError
                );
            }
        }
        throw err;
    }

    activatedExtensions.set(extension.id, { extension, context });
    action(() => extensions.set(extension.id, extension))();
    return extension;
}

const loadExtensionTasks = new Map<
    string,
    Promise<IExtension | undefined>
>();

async function loadAndRegisterExtension(folder: string) {
    const loadExtensionTask = loadExtensionTasks.get(folder);
    if (loadExtensionTask) {
        return loadExtensionTask;
    }

    const newLoadExtensionTask = (async () => {
        let extension = await loadExtension(folder);
        if (extension) {
            extension = await registerExtension(extension);
        }
        return extension;
    })();
    loadExtensionTasks.set(folder, newLoadExtensionTask);

    try {
        return await newLoadExtensionTask;
    } catch (err) {
        loadExtensionTasks.delete(folder);
        throw err;
    }
}

///////////////////////////////////////////////////////////////////////////////

export async function reloadExtension(folder: string) {
    return reloadExtensionInternal(folder);
}

export async function reloadExtensionV1(folder: string, expectedId: string) {
    return reloadExtensionInternal(folder, expectedId);
}

async function reloadExtensionInternal(folder: string, requiredV1Id?: string) {
    const normalizedFolder = path.resolve(folder);
    const existingExtension = Array.from(extensions.values()).find(
        extension =>
            extension.installationFolderPath != undefined &&
            path.resolve(extension.installationFolderPath) == normalizedFolder
    );
    if (existingExtension) {
        await deactivateExtension(existingExtension, "reload");
        action(() => extensions.delete(existingExtension.id))();
    }

    loadExtensionTasks.delete(folder);
    clearExtensionRequireCache(folder);
    let extension = await loadExtension(
        folder,
        getInstalledExtensionSignaturePolicy(),
        requiredV1Id
    );
    if (extension) {
        extension = await registerExtension(extension, "reload");
    }
    return extension;
}

///////////////////////////////////////////////////////////////////////////////

export async function loadExtensions(nodeModuleFolders: string[]) {
    let installedExtensionsSafeToLoad = true;
    try {
        await recoverExtensionStaging(extensionsFolderPath, {
            removeDirectory: removeFolder
        });
    } catch (err) {
        installedExtensionsSafeToLoad = false;
        console.error("Failed to recover extension staging transactions", err);
    }

    let preinstalledExtensionFolders = await readFolder(
        preInstalledExtensionsFolderPath
    );

    let installedExtensionFolders: string[];
    if (!installedExtensionsSafeToLoad) {
        installedExtensionFolders = [];
    } else {
        try {
            installedExtensionFolders = await readFolder(extensionsFolderPath);

            installedExtensionFolders = installedExtensionFolders.filter(
                extensionFolderPath => {
                    if (fs.lstatSync(extensionFolderPath).isFile()) {
                        return false;
                    }
                    const basename = path.basename(extensionFolderPath);
                    if (basename == "node_modules" || basename == "cache") {
                        return false;
                    }
                    return true;
                }
            );
        } catch (err) {
            console.info(
                `Extensions folder "${extensionsFolderPath}" doesn't exists.`
            );
            installedExtensionFolders = [];
        }
    }

    for (let folder of [
        ...preinstalledExtensionFolders,
        ...installedExtensionFolders,
        ...nodeModuleFolders
    ]) {
        try {
            await loadAndRegisterExtension(folder);
        } catch (err) {
            console.error(err);
        }
    }
}

export async function loadPreinstalledExtension(name: string) {
    let extensionFolderPath = preInstalledExtensionsFolderPath + "/" + name;
    let extension = await loadAndRegisterExtension(extensionFolderPath);
    return extension;
}

export async function loadExtensionById(id: string) {
    let extensionFolderPath = getExtensionFolderPath(id);
    let extension = await loadAndRegisterExtension(extensionFolderPath);
    return extension;
}

export async function importExtensionToFolder(
    extensionFilePath: string,
    extensionFolderPath: string
) {
    // extract extension zip file to the temp folder
    await extractExtensionArchiveSafely(extensionFilePath, extensionFolderPath);

    // load extension from the temp folder
    return await loadExtension(extensionFolderPath);
}

export async function importExtensionToTempFolder(
    extensionFilePath: string,
    securityOptions: InstallExtensionSecurityOptions = {}
) {
    const transactionId = guid();
    const tmpExtensionFolderPath = incomingExtensionFolderPath(
        extensionsFolderPath,
        transactionId
    );
    try {
        await fs.promises.mkdir(path.dirname(tmpExtensionFolderPath), {
            recursive: true
        });
        await extractExtensionArchiveSafely(
            extensionFilePath,
            tmpExtensionFolderPath
        );
        const signaturePolicy: ExtensionSignaturePolicy = {
            source: securityOptions.source ?? "local",
            developerMode:
                securityOptions.developerMode ??
                isExtensionDeveloperModeEnabled(),
            trustedKeys:
                securityOptions.trustedPublisherKeys ??
                TRUSTED_EXTENSION_PUBLISHERS
        };
        const prepared = await prepareExtensionPackageForInstall(
            tmpExtensionFolderPath,
            {
                ...signaturePolicy,
                expected: securityOptions.expected
            }
        );

        let extension: IExtension | undefined;
        if (!prepared) {
            if (signaturePolicy.source == "catalog") {
                await removeFolder(tmpExtensionFolderPath);
                return undefined;
            }
            // Local legacy loaders include IDF archives that create their
            // package metadata while being imported.
            extension = await loadExtension(
                tmpExtensionFolderPath,
                signaturePolicy
            );
        } else if (prepared.extensionType == "extension-v1") {
            extension = await applyPackageMetadata(
                {} as IExtension,
                {
                    packageJson: prepared.packageJson,
                    manifest: prepared.manifest
                },
                tmpExtensionFolderPath,
                "extension-v1"
            );
            extension.publisherKeyId = prepared.publisherKeyId;
            extension.publisherFingerprint = prepared.publisherFingerprint;
        } else {
            extension = await loadExtension(
                tmpExtensionFolderPath,
                signaturePolicy
            );
        }

        if (!extension) {
            await removeFolder(tmpExtensionFolderPath);
            return undefined;
        }
        if (securityOptions.expected) {
            assertLoadedExtensionMatchesExpectation(
                extension,
                securityOptions.expected
            );
        }

        return {
            tmpExtensionFolderPath,
            extension
        };
    } catch (err) {
        await removeFolder(tmpExtensionFolderPath);
        throw err;
    }
}

async function finishImportExtensionFromTempFolder({
    tmpExtensionFolderPath,
    extension
}: {
    tmpExtensionFolderPath: string;
    extension: IExtension;
}, signaturePolicy = getInstalledExtensionSignaturePolicy()) {
    if (extension.extensionType == "extension-v1") {
        const extensionFolderPath = getExtensionFolderPath(extension.id);
        const transactionId = guid();
        const backupFolderPath = backupExtensionFolderPath(
            extensionsFolderPath,
            extension.id,
            transactionId
        );
        const committedFolderPath = committedExtensionFolderPath(
            extensionsFolderPath,
            extension.id,
            transactionId
        );
        const pendingInstallPath = pendingExtensionInstallPath(
            extensionsFolderPath,
            extension.id,
            transactionId
        );
        const installedMarkerPath = installedExtensionMarkerPath(
            extensionsFolderPath,
            extension.id,
            transactionId
        );
        const existingExtension = extensions.get(extension.id);
        if (existingExtension) {
            try {
                assertPublisherIdentityCanReplace(
                    existingExtension,
                    extension,
                    extension.id
                );
            } catch (error) {
                await removeFolder(tmpExtensionFolderPath);
                throw error;
            }
        }
        const journalTransactionId = guid();
        const relativePath = (value: string) => path.relative(extensionsFolderPath, value);
        let journal;
        try {
            const oldDigest =
                existingExtension && (await fileExists(extensionFolderPath))
                    ? await hashExtensionDirectory(extensionFolderPath)
                    : undefined;
            const newDigest = await hashExtensionDirectory(tmpExtensionFolderPath);
            await syncExtensionTree(tmpExtensionFolderPath);
            journal = await beginExtensionInstallJournal(extensionsFolderPath, {
                transactionId: journalTransactionId,
                extensionId: extension.id,
                operation: existingExtension ? "update" : "install",
                targetRelativePath: relativePath(extensionFolderPath),
                incomingRelativePath: relativePath(tmpExtensionFolderPath),
                backupRelativePath: relativePath(backupFolderPath),
                oldDigest,
                newDigest,
                publisherFingerprint: extension.publisherFingerprint
            });
        } catch (error) {
            await removeFolder(tmpExtensionFolderPath).catch(cleanupError =>
                console.error(
                    `Failed to remove unjournaled extension staging folder for ${extension.id}`,
                    cleanupError
                )
            );
            throw error;
        }
        let backupCreated = false;
        let pendingInstallCreated = false;
        let replacementInstalled = false;
        try {
            await advanceExtensionInstallJournal(
                extensionsFolderPath,
                journal.transactionId,
                "incoming-verified"
            );
            if (existingExtension) {
                await deactivateExtension(existingExtension, "replace");
                action(() => extensions.delete(existingExtension.id))();
            }
            if (await fileExists(extensionFolderPath)) {
                await durableRename(extensionFolderPath, backupFolderPath);
                backupCreated = true;
            } else {
                await fs.promises.mkdir(pendingInstallPath, {
                    recursive: false
                });
                pendingInstallCreated = true;
            }
            await advanceExtensionInstallJournal(
                extensionsFolderPath,
                journal.transactionId,
                "backup-moved"
            );
            await durableRename(tmpExtensionFolderPath, extensionFolderPath);
            replacementInstalled = true;
            await advanceExtensionInstallJournal(
                extensionsFolderPath,
                journal.transactionId,
                "target-installed"
            );

            const reloadedExtension = await loadExtension(
                extensionFolderPath,
                signaturePolicy
            );
            if (!reloadedExtension) {
                throw new Error("Installed extension failed static validation");
            }
            loadExtensionTasks.delete(extensionFolderPath);
            await notifyExtensionV1Changed("install", reloadedExtension.id);
            const registered = await registerExtension(reloadedExtension);
            await advanceExtensionInstallJournal(
                extensionsFolderPath,
                journal.transactionId,
                "committed"
            );
            if (backupCreated) {
                await durableRename(backupFolderPath, committedFolderPath);
                backupCreated = false;
                try {
                    await removeFolder(committedFolderPath);
                } catch (cleanupError) {
                    console.error(
                        `Failed to remove committed backup for extension ${extension.id}`,
                        cleanupError
                    );
                }
            } else if (pendingInstallCreated) {
                await durableRename(pendingInstallPath, installedMarkerPath);
                pendingInstallCreated = false;
                try {
                    await removeFolder(installedMarkerPath);
                } catch (cleanupError) {
                    console.error(
                        `Failed to remove install marker for extension ${extension.id}`,
                        cleanupError
                    );
                }
            }
            await removeExtensionInstallJournal(
                extensionsFolderPath,
                journal.transactionId
            );
            return registered;
        } catch (error) {
            await advanceExtensionInstallJournal(
                extensionsFolderPath,
                journal.transactionId,
                "rolled-back"
            ).catch(() => undefined);
            const failedExtension = extensions.get(extension.id);
            if (failedExtension) {
                await deactivateExtension(failedExtension, "activation-error");
                action(() => extensions.delete(extension.id))();
            }
            if (replacementInstalled) {
                await removeFolder(extensionFolderPath);
            } else {
                await removeFolder(tmpExtensionFolderPath);
            }
            if (backupCreated) {
                await durableRename(backupFolderPath, extensionFolderPath);
                clearExtensionRequireCache(extensionFolderPath);
                const restored = await loadExtension(
                    extensionFolderPath,
                    signaturePolicy
                );
                if (restored) {
                    await notifyExtensionV1Changed("install", restored.id);
                    await registerExtension(restored);
                } else {
                    throw new Error(
                        `Extension installation failed and backup restoration could not be registered: ${String(
                            error
                        )}`
                    );
                }
            } else {
                if (
                    pendingInstallCreated &&
                    (await fileExists(pendingInstallPath))
                ) {
                    await removeFolder(pendingInstallPath);
                }
                await notifyExtensionV1Changed("uninstall", extension.id);
            }
            throw error;
        }
    }

    try {
        // uninstall extension if already exist
        await uninstallExtensionUnlocked(extension.id);

        clearExtensionRequireCache(tmpExtensionFolderPath);

        // rename temp folder to extension folder
        let extensionFolderPath = getExtensionFolderPath(extension.id);

        try {
            await renameFile(tmpExtensionFolderPath, extensionFolderPath);
        } catch (err) {
            // try again
            await delay(100);
            await renameFile(tmpExtensionFolderPath, extensionFolderPath);
        }

        // reload extension from real folder
        const reloadedExtension = await loadExtension(extensionFolderPath);
        if (!reloadedExtension) {
            await removeFolder(extensionFolderPath);
            throw "Import failed";
        }

        loadExtensionTasks.delete(extensionFolderPath);

        return await registerExtension(reloadedExtension);
    } catch (err) {
        await removeFolder(tmpExtensionFolderPath);
        throw err;
    }
}

export interface InstallExtensionSecurityOptions {
    source?: "catalog" | "local";
    developerMode?: boolean;
    trustedPublisherKeys?: Readonly<Record<string, string>>;
    expected?: ExtensionInstallExpectation;
}

async function notifyExtensionV1Changed(
    actionType: "install" | "uninstall",
    extensionId: string
) {
    if (process.type == "renderer") {
        const { ipcRenderer } = require("electron") as typeof import("electron");
        await ipcRenderer.invoke("eez-extension-v1/change-request", {
            action: actionType,
            extensionId
        });
    }
}

export async function destroyExtensions() {
    const loadedExtensions = Array.from(extensions.values());
    await Promise.all(
        loadedExtensions.map(async extension => {
            try {
                await deactivateExtension(extension, "shutdown");
            } catch (err) {
                console.error(
                    `Failed to destroy extension ${extension.id}`,
                    err
                );
            } finally {
                action(() => extensions.delete(extension.id))();
            }
        })
    );
    loadExtensionTasks.clear();
}

////////////////////////////////////////////////////////////////////////////////

function compareVersions(versionString1: string, versionString2: string) {
    let parts1 = versionString1.split(".");
    let parts2 = versionString2.split(".");
    for (let i = 0; i < parts1.length && i < parts2.length; i++) {
        let v1 = parseInt(parts1[i]);
        let v2 = parseInt(parts2[i]);
        if (isNaN(v1) || isNaN(v2)) {
            if (parts1[i] < parts2[i]) {
                return -1;
            }
            if (parts1[i] > parts2[i]) {
                return 1;
            }
        } else {
            if (v1 < v2) {
                return -1;
            } else if (v1 > v2) {
                return 1;
            }
        }
    }

    if (versionString1.length < versionString2.length) {
        return -1;
    }

    if (versionString1.length > versionString2.length) {
        return 1;
    }

    return 0;
}

export async function installExtension(
    extensionFilePath: string,
    {
        checkExtensionType,
        notFound,
        confirmReplaceNewerVersion,
        confirmReplaceOlderVersion,
        confirmReplaceTheSameVersion,
        source = "local",
        developerMode =
            isExtensionDeveloperModeEnabled(),
        trustedPublisherKeys = TRUSTED_EXTENSION_PUBLISHERS,
        expected
    }: {
        checkExtensionType?: (type: string) => boolean;
        notFound(): void;
        confirmReplaceNewerVersion(
            newExtension: IExtension,
            existingExtension: IExtension
        ): Promise<boolean>;
        confirmReplaceOlderVersion(
            newExtension: IExtension,
            existingExtension: IExtension
        ): Promise<boolean>;
        confirmReplaceTheSameVersion(
            newExtension: IExtension,
            existingExtension: IExtension
        ): Promise<boolean>;
    } & InstallExtensionSecurityOptions
) {
    const result = await importExtensionToTempFolder(extensionFilePath, {
        source,
        developerMode,
        trustedPublisherKeys,
        expected
    });
    if (!result) {
        notFound();
        return undefined;
    }

    if (
        checkExtensionType &&
        !checkExtensionType(result.extension.extensionType)
    ) {
        await removeFolder(result.tmpExtensionFolderPath);
        return undefined;
    }

    return extensionOperationQueue.run(result.extension.id, async () => {
        try {
            await recoverExtensionStaging(extensionsFolderPath, {
                removeDirectory: removeFolder,
                targetExtensionId: result.extension.id
            });
        } catch (error) {
            await removeFolder(result.tmpExtensionFolderPath);
            throw error;
        }
        const installedSignaturePolicy: ExtensionSignaturePolicy = {
            source: "local",
            developerMode,
            trustedKeys: trustedPublisherKeys
        };
        const existingExtension = extensions.get(result.extension.id);
        if (existingExtension) {
            try {
                assertPublisherIdentityCanReplace(
                    existingExtension,
                    result.extension,
                    result.extension.id
                );
            } catch (error) {
                await removeFolder(result.tmpExtensionFolderPath);
                throw error;
            }
            const compareVersionResult = compareVersions(
                result.extension.version,
                existingExtension.version
            );
            let confirmed;
            try {
                if (compareVersionResult < 0) {
                    confirmed = await confirmReplaceNewerVersion(
                        result.extension,
                        existingExtension
                    );
                } else if (compareVersionResult > 0) {
                    confirmed = await confirmReplaceOlderVersion(
                        result.extension,
                        existingExtension
                    );
                } else {
                    confirmed = await confirmReplaceTheSameVersion(
                        result.extension,
                        existingExtension
                    );
                }
            } catch (error) {
                await removeFolder(result.tmpExtensionFolderPath);
                throw error;
            }

            if (!confirmed) {
                await removeFolder(result.tmpExtensionFolderPath);
                return undefined;
            }
        }

        const installedExtension = await finishImportExtensionFromTempFolder(
            result,
            installedSignaturePolicy
        );

        if (
            installedExtension.properties &&
            installedExtension.properties.shortcuts
        ) {
            installedExtension.properties.shortcuts.forEach(shortcut => {
                const {
                    addShortcut,
                    SHORTCUTS_GROUP_NAME_FOR_EXTENSION_PREFIX
                } =
                    require("shortcuts/shortcuts-store") as typeof ShortcutsStoreModule;

                addShortcut(
                    Object.assign({}, shortcut, {
                        id: undefined,
                        groupName:
                            SHORTCUTS_GROUP_NAME_FOR_EXTENSION_PREFIX +
                            installedExtension.id,
                        originalId: shortcut.id
                    })
                );
            });
        }

        return installedExtension;
    });
}

////////////////////////////////////////////////////////////////////////////////

export function uninstallExtension(extensionId: string) {
    return extensionOperationQueue.run(extensionId, async () => {
        await recoverExtensionStaging(extensionsFolderPath, {
            removeDirectory: removeFolder,
            targetExtensionId: extensionId
        });
        return uninstallExtensionUnlocked(extensionId);
    });
}

async function uninstallExtensionUnlocked(extensionId: string) {
    const extension = extensions.get(extensionId);
    if (extension) {
        await deactivateExtension(extension, "uninstall");
        action(() => extensions.delete(extensionId))();

        const extensionFolderPath =
            extension.installationFolderPath ||
            getExtensionFolderPath(extensionId);
        loadExtensionTasks.delete(extensionFolderPath);
        clearExtensionRequireCache(extensionFolderPath);

        if (extension.extensionType == "extension-v1") {
            const transactionId = guid();
            const uninstallFolderPath = uninstallExtensionFolderPath(
                extensionsFolderPath,
                extensionId,
                transactionId
            );
            const removedFolderPath = removedExtensionFolderPath(
                extensionsFolderPath,
                extensionId,
                transactionId
            );
            const journal = await beginExtensionInstallJournal(
                extensionsFolderPath,
                {
                    transactionId,
                    extensionId,
                    operation: "uninstall",
                    targetRelativePath: path.relative(
                        extensionsFolderPath,
                        extensionFolderPath
                    ),
                    backupRelativePath: path.relative(
                        extensionsFolderPath,
                        uninstallFolderPath
                    ),
                    oldDigest: (await fileExists(extensionFolderPath))
                        ? await hashExtensionDirectory(extensionFolderPath)
                        : undefined,
                    publisherFingerprint: extension.publisherFingerprint
                }
            );
            let moved = false;
            try {
                if (await fileExists(extensionFolderPath)) {
                    await durableRename(extensionFolderPath, uninstallFolderPath);
                    moved = true;
                }
                await advanceExtensionInstallJournal(
                    extensionsFolderPath,
                    journal.transactionId,
                    "backup-moved"
                );
                await notifyExtensionV1Changed("uninstall", extensionId);
                if (moved) {
                    await durableRename(uninstallFolderPath, removedFolderPath);
                    moved = false;
                    try {
                        await removeFolder(removedFolderPath);
                    } catch (cleanupError) {
                        console.error(
                            `Failed to remove committed uninstall for extension ${extensionId}`,
                            cleanupError
                        );
                    }
                }
                await advanceExtensionInstallJournal(
                    extensionsFolderPath,
                    journal.transactionId,
                    "committed"
                );
                await removeExtensionInstallJournal(
                    extensionsFolderPath,
                    journal.transactionId
                );
            } catch (error) {
                await advanceExtensionInstallJournal(
                    extensionsFolderPath,
                    journal.transactionId,
                    "rolled-back"
                ).catch(() => undefined);
                if (moved && (await fileExists(uninstallFolderPath))) {
                    await durableRename(uninstallFolderPath, extensionFolderPath);
                }
                if (await fileExists(extensionFolderPath)) {
                    const restored = await loadExtension(extensionFolderPath);
                    if (restored) {
                        await notifyExtensionV1Changed("install", extensionId);
                        await registerExtension(restored);
                    }
                }
                throw error;
            }
        } else if (extension.extensionType === "pext") {
            try {
                await yarnUninstall(extension.name);
            } catch (error) {
                await registerExtension(extension);
                throw error;
            }
        } else {
            try {
                await removeFolder(extensionFolderPath);
            } catch (error) {
                await registerExtension(extension);
                throw error;
            }

            try {
                const {
                    deleteGroupInShortcuts,
                    SHORTCUTS_GROUP_NAME_FOR_EXTENSION_PREFIX
                } =
                    require("shortcuts/shortcuts-store") as typeof ShortcutsStoreModule;
                deleteGroupInShortcuts(
                    SHORTCUTS_GROUP_NAME_FOR_EXTENSION_PREFIX + extensionId
                );
            } catch (err) {
                console.error(
                    `Failed to remove shortcuts for extension ${extensionId}`,
                    err
                );
            }
        }
    }
}

////////////////////////////////////////////////////////////////////////////////

export let notifySource = {
    id: "shared/extension"
};
registerSource(notifySource);

export interface ExtensionChangeEvent {
    id: string;
    image?: string;
    properties?: IExtensionProperties;
}

watch(notifySource.id, undefined, (extensionChange: ExtensionChangeEvent) => {
    const extension = extensions.get(extensionChange.id);
    if (extension) {
        action(() => {
            if (extensionChange.image !== undefined) {
                extension.image = extensionChange.image;
            }

            if (extensionChange.properties !== undefined) {
                extension.properties = extensionChange.properties;
            }

            extension.isDirty = true;
        })();
    }
});

export async function changeExtensionImage(
    extension: IExtension,
    srcImageFilePath: string
) {
    let extensionFolderPath = getExtensionFolderPath(extension.id);

    let destImageFilePath = extensionFolderPath + "/image.png";

    await copyFile(srcImageFilePath, destImageFilePath);

    let image = destImageFilePath + "?" + guid();

    action(() => {
        extension.image = image;
        extension.isDirty = true;
    })();

    let extensionChange: ExtensionChangeEvent = {
        id: extension.id,
        image: image
    };
    sendMessage(notifySource, extensionChange);
}

////////////////////////////////////////////////////////////////////////////////

export async function exportExtension(
    extension: IExtension,
    destFilePath: string
) {
    const archiver = await import("archiver");

    return new Promise<void>((resolve, reject) => {
        let extensionFolderPath = getExtensionFolderPath(extension.id);
        var output = fs.createWriteStream(destFilePath);

        var archive = archiver.default("zip", {
            zlib: {
                level: 9
            }
        });

        output.on("close", function () {
            resolve();
        });

        archive.on("warning", function (err: any) {
            reject(err);
        });

        archive.on("error", function (err: any) {
            reject(err);
        });

        archive.pipe(output);

        archive.glob(
            "**/*",
            {
                cwd: extensionFolderPath,
                ignore: [".editable"]
            },
            {}
        );

        archive.finalize();
    });
}

////////////////////////////////////////////////////////////////////////////////

export function getManufacturer(extension: IExtension) {
    return firstWord(extension.displayName || extension.name);
}

export function isInstrumentExtension(extension: IExtension) {
    const eezStudioProperties = (extension as any)[
        CONF_EEZ_STUDIO_PROPERTY_NAME
    ];
    if (eezStudioProperties) {
        return !eezStudioProperties[CONF_MAIN_SCRIPT_PROPERTY_NAME];
    }
    return !!extension.properties;
}

////////////////////////////////////////////////////////////////////////////////

export const extensions = observable(new Map<string, IExtension>());
