"use strict";

const fs = require("node:fs");
const path = require("node:path");

const journal = require("../../build/eez-studio-shared/extensions/extension-install-journal");
const installation = require("../../build/eez-studio-shared/extensions/extension-installation");

async function writeState(folderPath, state) {
    await fs.promises.mkdir(folderPath, { recursive: true });
    await fs.promises.writeFile(path.join(folderPath, "state"), state, "utf8");
}

async function main() {
    const [root, operation, crashCheckpoint] = process.argv.slice(2);
    if (!root || !operation || !crashCheckpoint) {
        throw new Error("Expected root, operation and crash checkpoint");
    }

    const transactionId = "crashworker";
    const extensionId = `com.example.crash.${operation}`;
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

    if (operation == "update" || operation == "uninstall") {
        await writeState(targetPath, "old");
    }
    if (operation != "uninstall") {
        await writeState(incomingPath, "new");
    }

    const checkpoint = async currentCheckpoint => {
        if (currentCheckpoint == crashCheckpoint) {
            process.exit(86);
        }
    };

    const removeDirectory = folderPath =>
        fs.promises.rm(folderPath, { recursive: true, force: true });
    const commit = async () => {
        if (crashCheckpoint == "rolled-back") {
            throw new Error("injected transaction failure");
        }
    };
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
            commit,
            removeDirectory,
            checkpoint
        });
    } else {
        await journal.runDurableExtensionInstall({
            root,
            transactionId,
            extensionId,
            operation,
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
            commit,
            removeDirectory,
            checkpoint
        });
    }
    throw new Error(`Checkpoint was not reached: ${crashCheckpoint}`);
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
