export const EXTENSION_V1_ERROR_CODES = [
    "INVALID_MANIFEST",
    "UNSUPPORTED_MANIFEST_VERSION",
    "INVALID_ARGUMENT",
    "PERMISSION_DENIED",
    "CAPABILITY_NOT_GRANTED",
    "GRANT_EXPIRED",
    "SECURE_STORAGE_UNAVAILABLE",
    "SECURE_STORAGE_CORRUPT",
    "SECURE_STORAGE_OPERATION_FAILED",
    "INVALID_ENDPOINT",
    "INVALID_FRAME",
    "FRAME_TOO_LARGE",
    "AUTHENTICATION_FAILED",
    "NONCE_REUSED",
    "PACKAGE_TOO_LARGE",
    "PACKAGE_ENTRY_TOO_LARGE",
    "TOO_MANY_PACKAGE_ENTRIES",
    "INVALID_PACKAGE_PATH",
    "UNSUPPORTED_PACKAGE_ENTRY"
] as const;

export type ExtensionV1ErrorCode =
    (typeof EXTENSION_V1_ERROR_CODES)[number];

export type ExtensionV1ErrorDetails = Readonly<Record<string, unknown>>;

export interface SerializedExtensionV1Error {
    readonly name: "ExtensionV1Error";
    readonly code: ExtensionV1ErrorCode;
    readonly message: string;
    readonly details?: ExtensionV1ErrorDetails;
}

export interface ExtensionV1ErrorOptions {
    readonly details?: Record<string, unknown>;
    readonly cause?: unknown;
}

const ERROR_CODE_SET: ReadonlySet<string> = new Set(
    EXTENSION_V1_ERROR_CODES
);

export function isExtensionV1ErrorCode(
    value: unknown
): value is ExtensionV1ErrorCode {
    return typeof value === "string" && ERROR_CODE_SET.has(value);
}

export class ExtensionV1Error extends Error {
    readonly code: ExtensionV1ErrorCode;
    readonly details?: ExtensionV1ErrorDetails;
    readonly cause?: unknown;

    constructor(
        code: ExtensionV1ErrorCode,
        message: string,
        options: ExtensionV1ErrorOptions = {}
    ) {
        super(message);
        Object.setPrototypeOf(this, new.target.prototype);

        this.name = "ExtensionV1Error";
        this.code = code;
        this.details = options.details
            ? Object.freeze({ ...options.details })
            : undefined;
        this.cause = options.cause;
    }

    toJSON(): SerializedExtensionV1Error {
        return {
            name: "ExtensionV1Error",
            code: this.code,
            message: this.message,
            ...(this.details ? { details: this.details } : {})
        };
    }
}

export function toExtensionV1Error(
    error: unknown,
    fallbackCode: ExtensionV1ErrorCode = "INVALID_ARGUMENT",
    fallbackMessage = "Extension operation failed"
): ExtensionV1Error {
    if (error instanceof ExtensionV1Error) {
        return error;
    }

    return new ExtensionV1Error(fallbackCode, fallbackMessage, {
        cause: error
    });
}

export function serializeExtensionV1Error(
    error: unknown,
    fallbackCode: ExtensionV1ErrorCode = "INVALID_ARGUMENT",
    fallbackMessage = "Extension operation failed"
): SerializedExtensionV1Error {
    return toExtensionV1Error(
        error,
        fallbackCode,
        fallbackMessage
    ).toJSON();
}
