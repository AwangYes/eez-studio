import { ExtensionV1Error } from "./errors";
import { isValidExtensionId } from "./identifiers";

export const EXTENSION_CAPABILITIES = [
    "project.read",
    "project.write",
    "project.manage",
    "build.execute",
    "runtime.control",
    "input.inject",
    "asset.import",
    "screenshot.capture",
    "storage.secure"
] as const;

export type ExtensionCapability = (typeof EXTENSION_CAPABILITIES)[number];

export interface ExtensionGrant {
    readonly version: 1;
    readonly grantId: string;
    readonly extensionId: string;
    readonly capabilities: readonly ExtensionCapability[];
    readonly issuedAt: number;
    readonly expiresAt?: number;
    readonly projectIds?: readonly string[];
}

export interface CapabilityCheckOptions {
    readonly now?: number;
    readonly projectId?: string;
}

const CAPABILITY_SET: ReadonlySet<string> = new Set(EXTENSION_CAPABILITIES);
const GRANT_KEYS = new Set([
    "version",
    "grantId",
    "extensionId",
    "capabilities",
    "issuedAt",
    "expiresAt",
    "projectIds"
]);
const GRANT_ID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== "object") {
        return false;
    }

    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function grantError(message: string, field?: string): ExtensionV1Error {
    return new ExtensionV1Error("INVALID_ARGUMENT", message, {
        details: field ? { field } : undefined
    });
}

function validateExtensionId(value: unknown): string {
    if (!isValidExtensionId(value)) {
        throw grantError(
            "extensionId must be a valid lower-case extension identifier",
            "extensionId"
        );
    }

    return value;
}

function validateProjectId(value: unknown): string {
    if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > 256 ||
        CONTROL_CHARACTER.test(value) ||
        value.trim() !== value
    ) {
        throw grantError("projectIds contains an invalid project ID", "projectIds");
    }

    return value;
}

function validateTimestamp(value: unknown, field: string): number {
    if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 0
    ) {
        throw grantError(`${field} must be a non-negative integer`, field);
    }

    return value;
}

export function isExtensionCapability(
    value: unknown
): value is ExtensionCapability {
    return typeof value === "string" && CAPABILITY_SET.has(value);
}

export function validateCapabilityList(
    value: unknown,
    field = "capabilities"
): readonly ExtensionCapability[] {
    if (!Array.isArray(value)) {
        throw grantError(`${field} must be an array`, field);
    }

    const capabilities: ExtensionCapability[] = [];
    const seen = new Set<ExtensionCapability>();
    for (const capability of value) {
        if (!isExtensionCapability(capability)) {
            throw grantError(`${field} contains an unknown capability`, field);
        }
        if (seen.has(capability)) {
            throw grantError(`${field} contains a duplicate capability`, field);
        }
        seen.add(capability);
        capabilities.push(capability);
    }

    return Object.freeze(capabilities);
}

export function validateExtensionGrant(value: unknown): ExtensionGrant {
    if (!isPlainObject(value)) {
        throw grantError("Grant must be a plain object");
    }

    for (const key of Object.keys(value)) {
        if (!GRANT_KEYS.has(key)) {
            throw grantError(`Grant contains unknown field: ${key}`, key);
        }
    }

    if (value.version !== 1) {
        throw grantError("Grant version must be 1", "version");
    }
    if (
        typeof value.grantId !== "string" ||
        !GRANT_ID_PATTERN.test(value.grantId)
    ) {
        throw grantError("grantId must be a UUID", "grantId");
    }

    const extensionId = validateExtensionId(value.extensionId);
    const capabilities = validateCapabilityList(value.capabilities);
    const issuedAt = validateTimestamp(value.issuedAt, "issuedAt");
    const expiresAt =
        value.expiresAt === undefined
            ? undefined
            : validateTimestamp(value.expiresAt, "expiresAt");
    if (expiresAt !== undefined && expiresAt <= issuedAt) {
        throw grantError("expiresAt must be greater than issuedAt", "expiresAt");
    }

    let projectIds: readonly string[] | undefined;
    if (value.projectIds !== undefined) {
        if (!Array.isArray(value.projectIds) || value.projectIds.length === 0) {
            throw grantError(
                "projectIds must be a non-empty array when present",
                "projectIds"
            );
        }
        const seen = new Set<string>();
        const validatedProjectIds = value.projectIds.map(projectId => {
            const validatedProjectId = validateProjectId(projectId);
            if (seen.has(validatedProjectId)) {
                throw grantError(
                    "projectIds contains a duplicate project ID",
                    "projectIds"
                );
            }
            seen.add(validatedProjectId);
            return validatedProjectId;
        });
        projectIds = Object.freeze(validatedProjectIds);
    }

    return Object.freeze({
        version: 1,
        grantId: value.grantId,
        extensionId,
        capabilities,
        issuedAt,
        ...(expiresAt === undefined ? {} : { expiresAt }),
        ...(projectIds === undefined ? {} : { projectIds })
    });
}

export function assertGrantCapabilitiesRequested(
    grant: ExtensionGrant,
    requestedCapabilities: readonly ExtensionCapability[]
): void {
    const validatedGrant = validateExtensionGrant(grant);
    const requested = new Set(
        validateCapabilityList(requestedCapabilities, "requestedCapabilities")
    );
    for (const capability of validatedGrant.capabilities) {
        if (!requested.has(capability)) {
            throw new ExtensionV1Error(
                "PERMISSION_DENIED",
                "Grant contains a capability that the extension did not request",
                { details: { capability } }
            );
        }
    }
}

export function isGrantExpired(
    grant: ExtensionGrant,
    now = Date.now()
): boolean {
    const validatedGrant = validateExtensionGrant(grant);
    validateTimestamp(now, "now");
    return (
        validatedGrant.expiresAt !== undefined &&
        now >= validatedGrant.expiresAt
    );
}

export function assertCapabilityGranted(
    grant: ExtensionGrant,
    extensionId: string,
    capability: ExtensionCapability,
    options: CapabilityCheckOptions = {}
): void {
    const validatedGrant = validateExtensionGrant(grant);
    validateExtensionId(extensionId);
    if (!isExtensionCapability(capability)) {
        throw grantError("Unknown capability", "capability");
    }
    if (validatedGrant.extensionId !== extensionId) {
        throw new ExtensionV1Error(
            "PERMISSION_DENIED",
            "Grant belongs to a different extension"
        );
    }

    const now = options.now === undefined ? Date.now() : options.now;
    validateTimestamp(now, "now");
    if (now < validatedGrant.issuedAt) {
        throw new ExtensionV1Error(
            "PERMISSION_DENIED",
            "Extension grant is not active yet"
        );
    }
    if (
        validatedGrant.expiresAt !== undefined &&
        now >= validatedGrant.expiresAt
    ) {
        throw new ExtensionV1Error("GRANT_EXPIRED", "Extension grant has expired");
    }
    if (!validatedGrant.capabilities.includes(capability)) {
        throw new ExtensionV1Error(
            "CAPABILITY_NOT_GRANTED",
            "Required extension capability was not granted",
            { details: { capability } }
        );
    }

    if (validatedGrant.projectIds !== undefined) {
        if (options.projectId === undefined) {
            throw new ExtensionV1Error(
                "PERMISSION_DENIED",
                "A project-scoped grant requires a project ID"
            );
        }
        const projectId = validateProjectId(options.projectId);
        if (!validatedGrant.projectIds.includes(projectId)) {
            throw new ExtensionV1Error(
                "PERMISSION_DENIED",
                "Grant does not apply to the requested project"
            );
        }
    }
}
