import {
    EXTENSION_CAPABILITIES,
    ExtensionCapability,
    validateCapabilityList
} from "./capabilities";
import { ExtensionV1Error, SerializedExtensionV1Error } from "./errors";
import { isValidExtensionId } from "./identifiers";
import { validatePackageRelativePath } from "./install-policy";

export { isValidExtensionId } from "./identifiers";

export type ExtensionV1JsonValue =
    | null
    | boolean
    | number
    | string
    | readonly ExtensionV1JsonValue[]
    | { readonly [key: string]: ExtensionV1JsonValue };

export interface ExtensionV1PackageAuthor {
    readonly name: string;
    readonly email?: string;
    readonly url?: string;
}

export interface ExtensionV1Configuration {
    readonly apiVersion: "1.0" | "1.1";
    readonly host: "sandbox";
    readonly browser: string;
    readonly activationEvents?: readonly string[];
    readonly capabilities?: readonly ExtensionCapability[];
    readonly allowedOrigins?: readonly string[];
    readonly contributes?: Readonly<Record<string, ExtensionV1JsonValue>>;
}

export interface ExtensionV1PackageManifest {
    /** Normalized identity: the package `id`, or `name` when `id` is omitted. */
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly displayName?: string;
    readonly description?: string;
    readonly author?: string | ExtensionV1PackageAuthor;
    readonly image?: string;
    readonly download?: string;
    readonly sha256?: string;
    readonly eezStudio: ExtensionV1Configuration;
}

/** Compatibility name for consumers that imported the first V1 draft. */
export type ExtensionV1Manifest = ExtensionV1PackageManifest;

export type ManifestValidationResult =
    | { readonly ok: true; readonly value: ExtensionV1PackageManifest }
    | { readonly ok: false; readonly error: SerializedExtensionV1Error };

const CONFIGURATION_KEYS = new Set([
    "apiVersion",
    "host",
    "browser",
    "activationEvents",
    "capabilities",
    "allowedOrigins",
    "contributes"
]);
const AUTHOR_KEYS = new Set(["name", "email", "url"]);
const PACKAGE_NAME_PATTERN =
    /^(?:@[a-z0-9](?:[a-z0-9._-]{0,99})\/)?[a-z0-9](?:[a-z0-9._-]{0,212})$/;
const SEMVER_PATTERN =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const DECLARATIVE_ICON_PATTERN = /^material:[a-z0-9_]{1,64}$/;

export function isSafeDeclarativeIcon(value: unknown): value is string {
    return typeof value === "string" && DECLARATIVE_ICON_PATTERN.test(value);
}
const MAX_JSON_DEPTH = 64;
const MAX_CONTRIBUTION_KEYS = 10000;
const CONTRIBUTION_KEYS = new Set(["homeSections"]);
const HOME_SECTION_KEYS = new Set([
    "id",
    "title",
    "icon",
    "category",
    "commands"
]);
const COMMAND_KEYS = new Set(["id", "title"]);
const CONTRIBUTION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== "object") {
        return false;
    }

    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function manifestError(
    message: string,
    field?: string,
    cause?: unknown
): ExtensionV1Error {
    return new ExtensionV1Error("INVALID_MANIFEST", message, {
        details: field ? { field } : undefined,
        cause
    });
}

function validateText(
    value: unknown,
    field: string,
    minimumLength: number,
    maximumLength: number
): string {
    if (
        typeof value !== "string" ||
        value.length < minimumLength ||
        value.length > maximumLength ||
        value.trim() !== value ||
        CONTROL_CHARACTER.test(value)
    ) {
        throw manifestError(
            `${field} must be a trimmed string between ${minimumLength} and ${maximumLength} characters without control characters`,
            field
        );
    }

    return value;
}

function validateVersion(value: unknown): string {
    if (
        typeof value !== "string" ||
        value.length > 128 ||
        !SEMVER_PATTERN.test(value)
    ) {
        throw manifestError("version must be a valid semantic version", "version");
    }

    return value;
}

function validateUrl(value: unknown, field: string): string {
    const urlValue = validateText(value, field, 1, 2048);
    let parsed: URL;
    try {
        parsed = new URL(urlValue);
    } catch (error) {
        throw manifestError(`${field} must be a valid URL`, field, error);
    }
    if (parsed.protocol !== "https:") {
        throw manifestError(`${field} must use HTTPS`, field);
    }
    return urlValue;
}

function validateAuthor(
    value: unknown
): string | ExtensionV1PackageAuthor | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value === "string") {
        return validateText(value, "author", 1, 256);
    }
    if (!isPlainObject(value)) {
        throw manifestError(
            "author must be a string or a plain author object",
            "author"
        );
    }
    for (const key of Object.keys(value)) {
        if (!AUTHOR_KEYS.has(key)) {
            throw manifestError(`author contains unknown field: ${key}`, `author.${key}`);
        }
    }

    const name = validateText(value.name, "author.name", 1, 256);
    const email =
        value.email === undefined
            ? undefined
            : validateText(value.email, "author.email", 3, 320);
    if (email !== undefined && !email.includes("@")) {
        throw manifestError("author.email must be a valid email address", "author.email");
    }
    const url =
        value.url === undefined
            ? undefined
            : validateUrl(value.url, "author.url");

    return Object.freeze({
        name,
        ...(email === undefined ? {} : { email }),
        ...(url === undefined ? {} : { url })
    });
}

function cloneJsonValue(
    value: unknown,
    field: string,
    seen: Set<object>,
    depth: number,
    keyCounter: { count: number }
): ExtensionV1JsonValue {
    if (depth > MAX_JSON_DEPTH) {
        throw manifestError(
            "contributes exceeds the maximum nesting depth",
            field
        );
    }
    if (
        value === null ||
        typeof value === "string" ||
        typeof value === "boolean"
    ) {
        return value;
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            throw manifestError("contributes contains a non-finite number", field);
        }
        return value;
    }
    if (typeof value !== "object") {
        throw manifestError("contributes contains a non-JSON value", field);
    }
    if (seen.has(value)) {
        throw manifestError("contributes contains a cycle", field);
    }
    seen.add(value);

    let cloned: ExtensionV1JsonValue;
    if (Array.isArray(value)) {
        cloned = Object.freeze(
            value.map((item, index) =>
                cloneJsonValue(
                    item,
                    `${field}[${index}]`,
                    seen,
                    depth + 1,
                    keyCounter
                )
            )
        );
    } else {
        if (!isPlainObject(value)) {
            throw manifestError("contributes contains a non-plain object", field);
        }
        const clonedObject = Object.create(null) as Record<
            string,
            ExtensionV1JsonValue
        >;
        for (const key of Object.keys(value)) {
            keyCounter.count += 1;
            if (keyCounter.count > MAX_CONTRIBUTION_KEYS) {
                throw manifestError(
                    "contributes contains too many object properties",
                    field
                );
            }
            if (CONTROL_CHARACTER.test(key) || key.length === 0 || key.length > 256) {
                throw manifestError(
                    "contributes contains an invalid object property name",
                    field
                );
            }
            clonedObject[key] = cloneJsonValue(
                value[key],
                `${field}.${key}`,
                seen,
                depth + 1,
                keyCounter
            );
        }
        cloned = Object.freeze(clonedObject);
    }

    seen.delete(value);
    return cloned;
}

function validateStringList(
    value: unknown,
    field: string
): readonly string[] | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!Array.isArray(value) || value.length > 256) {
        throw manifestError(`${field} must be an array of at most 256 strings`, field);
    }

    const seen = new Set<string>();
    const result = value.map(item => {
        const validated = validateText(item, field, 1, 256);
        if (seen.has(validated)) {
            throw manifestError(`${field} contains a duplicate value`, field);
        }
        seen.add(validated);
        return validated;
    });
    return Object.freeze(result);
}

function validateAllowedOrigins(value: unknown): readonly string[] | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!Array.isArray(value) || value.length > 64) {
        throw manifestError(
            "eez-studio.allowedOrigins must be an array of at most 64 HTTPS origins",
            "eez-studio.allowedOrigins"
        );
    }

    const seen = new Set<string>();
    const origins = value.map(item => {
        const origin = validateText(
            item,
            "eez-studio.allowedOrigins",
            1,
            2048
        );
        let parsed: URL;
        try {
            parsed = new URL(origin);
        } catch (error) {
            throw manifestError(
                "eez-studio.allowedOrigins contains an invalid URL",
                "eez-studio.allowedOrigins",
                error
            );
        }
        if (parsed.protocol !== "https:" || parsed.origin !== origin) {
            throw manifestError(
                "eez-studio.allowedOrigins entries must be exact HTTPS origins",
                "eez-studio.allowedOrigins"
            );
        }
        if (seen.has(origin)) {
            throw manifestError(
                "eez-studio.allowedOrigins contains a duplicate origin",
                "eez-studio.allowedOrigins"
            );
        }
        seen.add(origin);
        return origin;
    });
    return Object.freeze(origins);
}

function validateContributions(
    value: unknown
): Readonly<Record<string, ExtensionV1JsonValue>> {
    if (!isPlainObject(value)) {
        throw manifestError(
            "eez-studio.contributes must be a plain JSON object",
            "eez-studio.contributes"
        );
    }
    for (const key of Object.keys(value)) {
        if (!CONTRIBUTION_KEYS.has(key)) {
            throw manifestError(
                `eez-studio.contributes contains unknown extension point: ${key}`,
                `eez-studio.contributes.${key}`
            );
        }
    }

    if (value.homeSections !== undefined) {
        if (!Array.isArray(value.homeSections) || value.homeSections.length > 32) {
            throw manifestError(
                "contributes.homeSections must be an array of at most 32 sections",
                "eez-studio.contributes.homeSections"
            );
        }
        const sectionIds = new Set<string>();
        const commandIds = new Set<string>();
        for (const [sectionIndex, sectionValue] of value.homeSections.entries()) {
            const sectionField = `eez-studio.contributes.homeSections[${sectionIndex}]`;
            if (!isPlainObject(sectionValue)) {
                throw manifestError("Home section must be a plain object", sectionField);
            }
            for (const key of Object.keys(sectionValue)) {
                if (!HOME_SECTION_KEYS.has(key)) {
                    throw manifestError(
                        `Home section contains unknown field: ${key}`,
                        `${sectionField}.${key}`
                    );
                }
            }
            const sectionId = validateText(
                sectionValue.id,
                `${sectionField}.id`,
                1,
                128
            );
            if (
                !CONTRIBUTION_ID_PATTERN.test(sectionId) ||
                sectionIds.has(sectionId)
            ) {
                throw manifestError(
                    "Home section id must be valid and unique",
                    `${sectionField}.id`
                );
            }
            sectionIds.add(sectionId);
            validateText(sectionValue.title, `${sectionField}.title`, 1, 80);
            const icon = validateText(
                sectionValue.icon,
                `${sectionField}.icon`,
                1,
                128
            );
            if (!isSafeDeclarativeIcon(icon)) {
                throw manifestError(
                    "Home section icon must be a material icon identifier",
                    `${sectionField}.icon`
                );
            }
            if (
                sectionValue.category !== undefined &&
                sectionValue.category !== "none" &&
                sectionValue.category !== "common" &&
                sectionValue.category !== "instrument"
            ) {
                throw manifestError(
                    "Home section category must be none, common, or instrument",
                    `${sectionField}.category`
                );
            }
            if (sectionValue.commands !== undefined) {
                if (
                    !Array.isArray(sectionValue.commands) ||
                    sectionValue.commands.length > 32
                ) {
                    throw manifestError(
                        "Home section commands must be an array of at most 32 commands",
                        `${sectionField}.commands`
                    );
                }
                for (const [commandIndex, commandValue] of sectionValue.commands.entries()) {
                    const commandField = `${sectionField}.commands[${commandIndex}]`;
                    if (!isPlainObject(commandValue)) {
                        throw manifestError("Command must be a plain object", commandField);
                    }
                    for (const key of Object.keys(commandValue)) {
                        if (!COMMAND_KEYS.has(key)) {
                            throw manifestError(
                                `Command contains unknown field: ${key}`,
                                `${commandField}.${key}`
                            );
                        }
                    }
                    const commandId = validateText(
                        commandValue.id,
                        `${commandField}.id`,
                        1,
                        128
                    );
                    if (
                        !CONTRIBUTION_ID_PATTERN.test(commandId) ||
                        commandIds.has(commandId)
                    ) {
                        throw manifestError(
                            "Command id must be valid and unique within the extension",
                            `${commandField}.id`
                        );
                    }
                    commandIds.add(commandId);
                    validateText(
                        commandValue.title,
                        `${commandField}.title`,
                        1,
                        80
                    );
                }
            }
        }
    }

    return cloneJsonValue(
        value,
        "eez-studio.contributes",
        new Set(),
        0,
        { count: 0 }
    ) as Readonly<Record<string, ExtensionV1JsonValue>>;
}

function validateConfiguration(value: unknown): ExtensionV1Configuration {
    if (!isPlainObject(value)) {
        throw manifestError("eez-studio must be a plain object", "eez-studio");
    }
    for (const key of Object.keys(value)) {
        if (!CONFIGURATION_KEYS.has(key)) {
            throw manifestError(
                `eez-studio contains unknown field: ${key}`,
                `eez-studio.${key}`
            );
        }
    }
    if (value.apiVersion !== "1.0" && value.apiVersion !== "1.1") {
        throw new ExtensionV1Error(
            "UNSUPPORTED_MANIFEST_VERSION",
            'eez-studio.apiVersion must be "1.0" or "1.1"',
            { details: { field: "eez-studio.apiVersion" } }
        );
    }
    if (value.host !== "sandbox") {
        throw manifestError(
            'eez-studio.host must be "sandbox"',
            "eez-studio.host"
        );
    }

    let browser: string;
    try {
        browser = validatePackageRelativePath(value.browser, {
            maxPathBytes: 512,
            maxPathDepth: 32
        });
    } catch (error) {
        throw manifestError(
            "eez-studio.browser must be a safe package-relative path",
            "eez-studio.browser",
            error
        );
    }
    if (browser === "__host.html" || browser === "__host.js") {
        throw manifestError(
            "eez-studio.browser uses a host-reserved path",
            "eez-studio.browser"
        );
    }

    const activationEvents = validateStringList(
        value.activationEvents,
        "eez-studio.activationEvents"
    );
    let capabilities: readonly ExtensionCapability[] | undefined;
    if (value.capabilities !== undefined) {
        try {
            capabilities = validateCapabilityList(
                value.capabilities,
                "eez-studio.capabilities"
            );
        } catch (error) {
            throw manifestError(
                `eez-studio.capabilities must contain unique supported values: ${EXTENSION_CAPABILITIES.join(
                    ", "
                )}`,
                "eez-studio.capabilities",
                error
            );
        }
    }
    const allowedOrigins = validateAllowedOrigins(value.allowedOrigins);

    let contributes: Readonly<Record<string, ExtensionV1JsonValue>> | undefined;
    if (value.contributes !== undefined) {
        contributes = validateContributions(value.contributes);
    }

    return Object.freeze({
        apiVersion: value.apiVersion,
        host: "sandbox",
        browser,
        ...(activationEvents === undefined ? {} : { activationEvents }),
        ...(capabilities === undefined ? {} : { capabilities }),
        ...(allowedOrigins === undefined ? {} : { allowedOrigins }),
        ...(contributes === undefined ? {} : { contributes })
    });
}

export function validateExtensionV1PackageManifest(
    value: unknown
): ExtensionV1PackageManifest {
    if (!isPlainObject(value)) {
        throw manifestError("package.json must be a plain object");
    }
    if (
        typeof value.name !== "string" ||
        value.name.length > 214 ||
        !PACKAGE_NAME_PATTERN.test(value.name)
    ) {
        throw manifestError(
            "name must be a valid lower-case npm package name",
            "name"
        );
    }

    const id = value.id === undefined ? value.name : value.id;
    if (!isValidExtensionId(id)) {
        throw manifestError(
            "id must be a valid lower-case extension identifier",
            "id"
        );
    }

    const version = validateVersion(value.version);
    const displayName =
        value.displayName === undefined
            ? undefined
            : validateText(value.displayName, "displayName", 1, 120);
    const description =
        value.description === undefined
            ? undefined
            : validateText(value.description, "description", 0, 2048);
    const author = validateAuthor(value.author);

    let image: string | undefined;
    if (value.image !== undefined) {
        try {
            image = validatePackageRelativePath(value.image, {
                maxPathBytes: 512,
                maxPathDepth: 32
            });
        } catch (error) {
            throw manifestError(
                "image must be a safe package-relative path",
                "image",
                error
            );
        }
    }
    const download =
        value.download === undefined
            ? undefined
            : validateUrl(value.download, "download");
    const sha256 =
        value.sha256 === undefined
            ? undefined
            : typeof value.sha256 === "string" &&
              SHA256_PATTERN.test(value.sha256)
            ? value.sha256.toLowerCase()
            : undefined;
    if (value.sha256 !== undefined && sha256 === undefined) {
        throw manifestError(
            "sha256 must be a 64-character hexadecimal SHA-256 digest",
            "sha256"
        );
    }

    const eezStudio = validateConfiguration(value["eez-studio"]);
    return Object.freeze({
        id,
        name: value.name,
        version,
        ...(displayName === undefined ? {} : { displayName }),
        ...(description === undefined ? {} : { description }),
        ...(author === undefined ? {} : { author }),
        ...(image === undefined ? {} : { image }),
        ...(download === undefined ? {} : { download }),
        ...(sha256 === undefined ? {} : { sha256 }),
        eezStudio
    });
}

/** Compatibility alias; input is the complete package.json object. */
export const validateExtensionV1Manifest = validateExtensionV1PackageManifest;

export function tryValidateExtensionV1Manifest(
    value: unknown
): ManifestValidationResult {
    try {
        return { ok: true, value: validateExtensionV1PackageManifest(value) };
    } catch (error) {
        const normalizedError =
            error instanceof ExtensionV1Error
                ? error
                : manifestError("Manifest validation failed", undefined, error);
        return { ok: false, error: normalizedError.toJSON() };
    }
}
