import fs from "fs";
import path from "path";

import {
    resolvePackageInstallPath,
    validateInstallPackage
} from "./install-policy";

function entryType(entry: import("adm-zip").IZipEntry) {
    if (entry.isDirectory) {
        return "directory" as const;
    }
    const unixType = (entry.attr >>> 16) & 0xf000;
    if (unixType == 0xa000) {
        return "symlink" as const;
    }
    if (unixType != 0 && unixType != 0x8000) {
        return "device" as const;
    }
    return "file" as const;
}

export async function extractExtensionArchiveSafely(
    archivePath: string,
    destinationPath: string
) {
    const { default: AdmZip } = await import("adm-zip");
    const archiveStat = await fs.promises.stat(archivePath);
    // Reject oversized inputs before AdmZip reads or parses their central
    // directory. validateInstallPackage performs the same check again with the
    // complete entry list below.
    validateInstallPackage(archiveStat.size, []);
    const archive = new AdmZip(archivePath);
    const zipEntries = archive.getEntries();
    const validated = validateInstallPackage(
        archiveStat.size,
        zipEntries.map(entry => ({
            path: entry.entryName,
            type: entryType(entry),
            compressedSize: entry.header.compressedSize,
            uncompressedSize: entry.header.size
        }))
    );

    await fs.promises.mkdir(destinationPath, { recursive: true, mode: 0o700 });
    const installRoot = await fs.promises.realpath(destinationPath);
    const installRootPrefix = installRoot.endsWith(path.sep)
        ? installRoot
        : installRoot + path.sep;
    const requireInsideInstallRoot = (candidate: string) => {
        if (candidate !== installRoot && !candidate.startsWith(installRootPrefix)) {
            throw new Error("Extension archive target escapes the install root");
        }
    };
    for (let index = 0; index < validated.entries.length; index++) {
        const validatedEntry = validated.entries[index];
        const zipEntry = zipEntries[index];
        const targetPath = resolvePackageInstallPath(
            installRoot,
            validatedEntry.path
        );
        if (validatedEntry.type == "directory") {
            await fs.promises.mkdir(targetPath, {
                recursive: true,
                mode: 0o700
            });
            requireInsideInstallRoot(await fs.promises.realpath(targetPath));
            continue;
        }

        await fs.promises.mkdir(path.dirname(targetPath), {
            recursive: true,
            mode: 0o700
        });
        const realParent = await fs.promises.realpath(path.dirname(targetPath));
        requireInsideInstallRoot(realParent);
        const realTargetPath = path.join(realParent, path.basename(targetPath));
        const data = zipEntry.getData();
        if (data.length != validatedEntry.uncompressedSize) {
            throw new Error(
                `Extension archive entry size mismatch: ${validatedEntry.path}`
            );
        }
        await fs.promises.writeFile(realTargetPath, data, {
            flag: "wx",
            mode: 0o600
        });
    }
}
