import { getUserDataPath } from "eez-studio-shared/util-electron";
import { EXTENSIONS_FOLDER_NAME } from "eez-studio-shared/conf";
import { sourceRootDir } from "eez-studio-shared/util";
import {
    extensionFolderPath,
    extensionStagingFolderPath
} from "eez-studio-shared/extensions/extension-installation";

export const preInstalledExtensionsFolderPath = sourceRootDir();

export const extensionsFolderPath = getUserDataPath(EXTENSIONS_FOLDER_NAME);

export const extensionsStagingFolderPath =
    extensionStagingFolderPath(extensionsFolderPath);

export function getExtensionFolderPath(extensionId: string) {
    return extensionFolderPath(extensionsFolderPath, extensionId);
}
