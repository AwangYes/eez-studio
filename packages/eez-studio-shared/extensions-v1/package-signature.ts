import crypto from "crypto";
import fs from "fs";
import path from "path";

import { validatePackageRelativePath } from "./install-policy";

export const EXTENSION_SIGNATURE_FILE = "extension-signature.json";
const MAX_SIGNATURE_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_SIGNED_FILES = 10000;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const SIGNATURE_KEYS = new Set([
    "version",
    "algorithm",
    "keyId",
    "files",
    "signature"
]);

interface ExtensionPackageSignature {
    version: 1;
    algorithm: "ed25519";
    keyId: string;
    files: Record<string, string>;
    signature: string;
}

export interface ExtensionSignaturePolicy {
    source: "catalog" | "local";
    developerMode: boolean;
    trustedKeys: Readonly<Record<string, string>>;
}

function compareUtf8(left: string, right: string) {
    return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function canonicalPayload(
    signature: ExtensionPackageSignature,
    normalizedFiles: Record<string, string>
) {
    const files = Object.fromEntries(
        Object.entries(normalizedFiles).sort(([left], [right]) =>
            compareUtf8(left, right)
        )
    );
    return Buffer.from(
        JSON.stringify({
            version: signature.version,
            algorithm: signature.algorithm,
            keyId: signature.keyId,
            files
        }),
        "utf8"
    );
}

interface PackageFile {
    readonly actualPath: string;
    readonly normalizedPath: string;
}

async function listFiles(
    root: string,
    actualRelative = "",
    normalizedRelative = ""
): Promise<PackageFile[]> {
    const directory = path.join(root, actualRelative);
    const entries = await fs.promises.readdir(directory, {
        withFileTypes: true
    });
    const files: PackageFile[] = [];
    for (const entry of entries) {
        const normalizedName = entry.name.normalize("NFC");
        const actualChild = actualRelative
            ? `${actualRelative}/${entry.name}`
            : entry.name;
        const normalizedChild = normalizedRelative
            ? `${normalizedRelative}/${normalizedName}`
            : normalizedName;
        if (entry.isDirectory()) {
            files.push(
                ...(await listFiles(root, actualChild, normalizedChild))
            );
        } else if (entry.isFile()) {
            files.push({
                actualPath: actualChild,
                normalizedPath: normalizedChild
            });
        } else {
            throw new Error(
                `Unsupported extension package entry: ${normalizedChild}`
            );
        }
    }
    return files;
}

export async function verifyExtensionPackageSignature(
    packageRoot: string,
    policy: ExtensionSignaturePolicy
) {
    const signaturePath = path.join(packageRoot, EXTENSION_SIGNATURE_FILE);
    let rawSignature: string;
    try {
        const signatureStat = await fs.promises.stat(signaturePath);
        if (
            !signatureStat.isFile() ||
            signatureStat.size > MAX_SIGNATURE_MANIFEST_BYTES
        ) {
            throw new Error("Extension package signature manifest is too large");
        }
        rawSignature = await fs.promises.readFile(signaturePath, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code == "ENOENT") {
            if (policy.source == "local" && policy.developerMode) {
                return { signed: false as const };
            }
            throw new Error("Extension package signature is required");
        }
        throw error;
    }

    let signature: ExtensionPackageSignature;
    try {
        signature = JSON.parse(rawSignature) as ExtensionPackageSignature;
    } catch {
        throw new Error("Invalid extension package signature manifest");
    }
    if (
        signature === null ||
        typeof signature !== "object" ||
        Object.keys(signature).some(key => !SIGNATURE_KEYS.has(key)) ||
        signature?.version !== 1 ||
        signature.algorithm !== "ed25519" ||
        typeof signature.keyId !== "string" ||
        !KEY_ID_PATTERN.test(signature.keyId) ||
        typeof signature.signature !== "string" ||
        !BASE64_PATTERN.test(signature.signature) ||
        !signature.files ||
        typeof signature.files !== "object" ||
        Array.isArray(signature.files)
    ) {
        throw new Error("Invalid extension package signature manifest");
    }
    const publicKeyValue = Object.prototype.hasOwnProperty.call(
        policy.trustedKeys,
        signature.keyId
    )
        ? policy.trustedKeys[signature.keyId]
        : undefined;
    if (typeof publicKeyValue !== "string" || publicKeyValue.length == 0) {
        throw new Error(`Untrusted extension publisher key: ${signature.keyId}`);
    }
    let publicKey: crypto.KeyObject;
    try {
        publicKey = crypto.createPublicKey(publicKeyValue);
    } catch {
        throw new Error(`Invalid extension publisher key: ${signature.keyId}`);
    }
    if (publicKey.asymmetricKeyType !== "ed25519") {
        throw new Error(`Extension publisher key must be Ed25519: ${signature.keyId}`);
    }
    const publisherFingerprint = crypto
        .createHash("sha256")
        .update(publicKey.export({ type: "spki", format: "der" }))
        .digest("hex");

    const normalizedSignedFiles: Record<string, string> = Object.create(null);
    const declaredFiles = Object.keys(signature.files);
    if (declaredFiles.length > MAX_SIGNED_FILES) {
        throw new Error("Extension signature declares too many files");
    }
    for (const file of declaredFiles) {
        const normalizedFile = validatePackageRelativePath(file);
        if (Object.prototype.hasOwnProperty.call(normalizedSignedFiles, normalizedFile)) {
            throw new Error(
                `Duplicate normalized extension signature path: ${normalizedFile}`
            );
        }
        if (!/^[0-9a-f]{64}$/.test(signature.files[file])) {
            throw new Error(`Invalid extension file digest: ${file}`);
        }
        normalizedSignedFiles[normalizedFile] = signature.files[file];
    }
    const actualPackageFiles = (await listFiles(packageRoot)).filter(
        file => file.normalizedPath != EXTENSION_SIGNATURE_FILE
    );
    const actualFilesByNormalizedPath = new Map<string, PackageFile>();
    for (const file of actualPackageFiles) {
        validatePackageRelativePath(file.normalizedPath);
        if (actualFilesByNormalizedPath.has(file.normalizedPath)) {
            throw new Error(
                `Duplicate normalized extension package path: ${file.normalizedPath}`
            );
        }
        actualFilesByNormalizedPath.set(file.normalizedPath, file);
    }
    const normalizedDeclaredFiles = Object.keys(normalizedSignedFiles).sort(
        compareUtf8
    );
    const actualFiles = Array.from(actualFilesByNormalizedPath.keys()).sort(
        compareUtf8
    );
    if (JSON.stringify(actualFiles) != JSON.stringify(normalizedDeclaredFiles)) {
        throw new Error("Extension signed file list does not match package contents");
    }
    for (const file of actualFiles) {
        const content = await fs.promises.readFile(
            path.join(packageRoot, actualFilesByNormalizedPath.get(file)!.actualPath)
        );
        const digest = crypto.createHash("sha256").update(content).digest("hex");
        if (digest !== normalizedSignedFiles[file]) {
            throw new Error(`Extension file integrity check failed: ${file}`);
        }
    }
    const signatureBytes = Buffer.from(signature.signature, "base64");
    if (signatureBytes.length !== 64) {
        throw new Error("Invalid Ed25519 extension signature length");
    }
    if (
        !crypto.verify(
            null,
            canonicalPayload(signature, normalizedSignedFiles),
            publicKey,
            signatureBytes
        )
    ) {
        throw new Error("Extension package signature verification failed");
    }
    return {
        signed: true as const,
        keyId: signature.keyId,
        publisherFingerprint,
        files: Object.freeze({ ...normalizedSignedFiles }) as Readonly<
            Record<string, string>
        >
    };
}
