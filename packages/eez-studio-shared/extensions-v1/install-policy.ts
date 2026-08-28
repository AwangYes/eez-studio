import path from "path";

import { ExtensionV1Error } from "./errors";

export type InstallPackageEntryType =
    | "file"
    | "directory"
    | "symlink"
    | "hardlink"
    | "device";

export interface InstallPackageEntry {
    readonly path: string;
    readonly type: InstallPackageEntryType;
    readonly compressedSize: number;
    readonly uncompressedSize: number;
}

export interface InstallPackagePolicy {
    readonly maxArchiveBytes: number;
    readonly maxEntries: number;
    readonly maxEntryBytes: number;
    readonly maxTotalUncompressedBytes: number;
    readonly maxPathBytes: number;
    readonly maxPathDepth: number;
    readonly maxCompressionRatio: number;
    readonly rejectCaseInsensitiveCollisions: boolean;
}

export interface ValidatedInstallPackageEntry extends InstallPackageEntry {
    readonly path: string;
}

export interface ValidatedInstallPackage {
    readonly archiveBytes: number;
    readonly totalUncompressedBytes: number;
    readonly entries: readonly ValidatedInstallPackageEntry[];
}

export const DEFAULT_INSTALL_PACKAGE_POLICY: InstallPackagePolicy =
    Object.freeze({
        maxArchiveBytes: 100 * 1024 * 1024,
        maxEntries: 10000,
        maxEntryBytes: 100 * 1024 * 1024,
        maxTotalUncompressedBytes: 500 * 1024 * 1024,
        maxPathBytes: 512,
        maxPathDepth: 32,
        maxCompressionRatio: 200,
        rejectCaseInsensitiveCollisions: true
    });

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const WINDOWS_INVALID_CHARACTER = /[<>:"|?*]/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const DRIVE_PREFIX = /^[A-Za-z]:/;

function requireSafeInteger(
    value: unknown,
    name: string,
    minimum: number
): number {
    if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < minimum
    ) {
        throw new ExtensionV1Error(
            "INVALID_ARGUMENT",
            `${name} must be a safe integer greater than or equal to ${minimum}`,
            { details: { field: name } }
        );
    }

    return value;
}

function resolvePolicy(
    overrides: Partial<InstallPackagePolicy> = {}
): InstallPackagePolicy {
    const policy = {
        ...DEFAULT_INSTALL_PACKAGE_POLICY,
        ...overrides
    };

    requireSafeInteger(policy.maxArchiveBytes, "maxArchiveBytes", 1);
    requireSafeInteger(policy.maxEntries, "maxEntries", 1);
    requireSafeInteger(policy.maxEntryBytes, "maxEntryBytes", 1);
    requireSafeInteger(
        policy.maxTotalUncompressedBytes,
        "maxTotalUncompressedBytes",
        1
    );
    requireSafeInteger(policy.maxPathBytes, "maxPathBytes", 1);
    requireSafeInteger(policy.maxPathDepth, "maxPathDepth", 1);

    if (
        typeof policy.maxCompressionRatio !== "number" ||
        !Number.isFinite(policy.maxCompressionRatio) ||
        policy.maxCompressionRatio < 1
    ) {
        throw new ExtensionV1Error(
            "INVALID_ARGUMENT",
            "maxCompressionRatio must be a finite number greater than or equal to 1",
            { details: { field: "maxCompressionRatio" } }
        );
    }

    if (typeof policy.rejectCaseInsensitiveCollisions !== "boolean") {
        throw new ExtensionV1Error(
            "INVALID_ARGUMENT",
            "rejectCaseInsensitiveCollisions must be a boolean",
            { details: { field: "rejectCaseInsensitiveCollisions" } }
        );
    }

    return Object.freeze(policy);
}

function invalidPackagePath(
    packagePath: unknown,
    reason: string
): ExtensionV1Error {
    return new ExtensionV1Error(
        "INVALID_PACKAGE_PATH",
        `Invalid package path: ${reason}`,
        {
            details: {
                path: typeof packagePath === "string" ? packagePath : undefined,
                reason
            }
        }
    );
}

export function validatePackageRelativePath(
    packagePath: unknown,
    policyOverrides: Partial<InstallPackagePolicy> = {},
    allowDirectoryMarker = false
): string {
    const policy = resolvePolicy(policyOverrides);

    if (typeof packagePath !== "string" || packagePath.length === 0) {
        throw invalidPackagePath(packagePath, "path must be a non-empty string");
    }
    if (CONTROL_CHARACTER.test(packagePath)) {
        throw invalidPackagePath(packagePath, "control characters are not allowed");
    }
    if (packagePath.includes("\\")) {
        throw invalidPackagePath(packagePath, "backslashes are not allowed");
    }
    if (
        packagePath.startsWith("/") ||
        packagePath.startsWith("//") ||
        DRIVE_PREFIX.test(packagePath)
    ) {
        throw invalidPackagePath(packagePath, "path must be relative");
    }

    let normalizedPath = packagePath.normalize("NFC");
    if (allowDirectoryMarker && normalizedPath.endsWith("/")) {
        normalizedPath = normalizedPath.slice(0, -1);
    }

    if (Buffer.byteLength(normalizedPath, "utf8") > policy.maxPathBytes) {
        throw invalidPackagePath(packagePath, "path is too long");
    }

    const segments = normalizedPath.split("/");
    if (segments.length > policy.maxPathDepth) {
        throw invalidPackagePath(packagePath, "path is too deep");
    }

    for (const segment of segments) {
        if (segment.length === 0 || segment === "." || segment === "..") {
            throw invalidPackagePath(
                packagePath,
                "empty and traversal segments are not allowed"
            );
        }
        if (
            segment.endsWith(".") ||
            segment.endsWith(" ") ||
            WINDOWS_RESERVED_NAME.test(segment) ||
            WINDOWS_INVALID_CHARACTER.test(segment)
        ) {
            throw invalidPackagePath(
                packagePath,
                "path is not portable across supported platforms"
            );
        }
    }

    return normalizedPath;
}

export function resolvePackageInstallPath(
    installRoot: string,
    packagePath: string,
    policyOverrides: Partial<InstallPackagePolicy> = {}
): string {
    if (typeof installRoot !== "string" || installRoot.length === 0) {
        throw new ExtensionV1Error(
            "INVALID_ARGUMENT",
            "installRoot must be a non-empty string",
            { details: { field: "installRoot" } }
        );
    }

    const normalizedPath = validatePackageRelativePath(
        packagePath,
        policyOverrides
    );
    const resolvedRoot = path.resolve(installRoot);
    const resolvedTarget = path.resolve(
        resolvedRoot,
        ...normalizedPath.split("/")
    );
    const rootPrefix = resolvedRoot.endsWith(path.sep)
        ? resolvedRoot
        : resolvedRoot + path.sep;

    if (!resolvedTarget.startsWith(rootPrefix)) {
        throw invalidPackagePath(packagePath, "path escapes the install root");
    }

    return resolvedTarget;
}

export function validateInstallPackage(
    archiveBytes: number,
    entries: Iterable<InstallPackageEntry>,
    policyOverrides: Partial<InstallPackagePolicy> = {}
): ValidatedInstallPackage {
    const policy = resolvePolicy(policyOverrides);
    requireSafeInteger(archiveBytes, "archiveBytes", 0);

    if (archiveBytes > policy.maxArchiveBytes) {
        throw new ExtensionV1Error(
            "PACKAGE_TOO_LARGE",
            "Extension package archive exceeds the configured size limit",
            {
                details: {
                    archiveBytes,
                    maxArchiveBytes: policy.maxArchiveBytes
                }
            }
        );
    }

    if (
        entries === null ||
        entries === undefined ||
        typeof entries[Symbol.iterator] !== "function"
    ) {
        throw new ExtensionV1Error(
            "INVALID_ARGUMENT",
            "entries must be iterable",
            { details: { field: "entries" } }
        );
    }

    const seenPaths = new Set<string>();
    const validatedEntries: ValidatedInstallPackageEntry[] = [];
    let totalUncompressedBytes = 0;

    for (const entry of entries) {
        if (validatedEntries.length >= policy.maxEntries) {
            throw new ExtensionV1Error(
                "TOO_MANY_PACKAGE_ENTRIES",
                "Extension package contains too many entries",
                { details: { maxEntries: policy.maxEntries } }
            );
        }
        if (entry === null || typeof entry !== "object") {
            throw new ExtensionV1Error(
                "INVALID_ARGUMENT",
                "Package entries must be objects",
                { details: { field: "entries" } }
            );
        }
        if (entry.type !== "file" && entry.type !== "directory") {
            throw new ExtensionV1Error(
                "UNSUPPORTED_PACKAGE_ENTRY",
                "Package links and special files are not supported",
                { details: { path: entry.path, type: entry.type } }
            );
        }

        const normalizedPath = validatePackageRelativePath(
            entry.path,
            policy,
            entry.type === "directory"
        );
        const collisionKey = policy.rejectCaseInsensitiveCollisions
            ? normalizedPath.toLowerCase()
            : normalizedPath;
        if (seenPaths.has(collisionKey)) {
            throw invalidPackagePath(
                entry.path,
                "duplicate or case-insensitive path collision"
            );
        }
        seenPaths.add(collisionKey);

        const compressedSize = requireSafeInteger(
            entry.compressedSize,
            "compressedSize",
            0
        );
        const uncompressedSize = requireSafeInteger(
            entry.uncompressedSize,
            "uncompressedSize",
            0
        );

        if (uncompressedSize > policy.maxEntryBytes) {
            throw new ExtensionV1Error(
                "PACKAGE_ENTRY_TOO_LARGE",
                "Package entry exceeds the configured size limit",
                {
                    details: {
                        path: normalizedPath,
                        uncompressedSize,
                        maxEntryBytes: policy.maxEntryBytes
                    }
                }
            );
        }

        if (
            uncompressedSize > 0 &&
            (compressedSize === 0 ||
                uncompressedSize / compressedSize >
                    policy.maxCompressionRatio)
        ) {
            throw new ExtensionV1Error(
                "PACKAGE_ENTRY_TOO_LARGE",
                "Package entry exceeds the configured compression ratio",
                {
                    details: {
                        path: normalizedPath,
                        compressedSize,
                        uncompressedSize,
                        maxCompressionRatio: policy.maxCompressionRatio
                    }
                }
            );
        }

        if (
            totalUncompressedBytes >
            policy.maxTotalUncompressedBytes - uncompressedSize
        ) {
            throw new ExtensionV1Error(
                "PACKAGE_TOO_LARGE",
                "Extension package exceeds the total uncompressed size limit",
                {
                    details: {
                        maxTotalUncompressedBytes:
                            policy.maxTotalUncompressedBytes
                    }
                }
            );
        }
        totalUncompressedBytes += uncompressedSize;

        validatedEntries.push(
            Object.freeze({
                path: normalizedPath,
                type: entry.type,
                compressedSize,
                uncompressedSize
            })
        );
    }

    return Object.freeze({
        archiveBytes,
        totalUncompressedBytes,
        entries: Object.freeze(validatedEntries)
    });
}
