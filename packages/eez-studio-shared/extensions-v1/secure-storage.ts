import { ExtensionV1Error } from "./errors";
import { isValidExtensionId } from "./identifiers";

export interface SafeStorageLike {
    isEncryptionAvailable(): boolean;
    encryptString(plainText: string): Buffer;
    decryptString(encrypted: Buffer): string;
}

export interface SecureStorageBackend {
    get(key: string): string | undefined;
    set(key: string, value: string): void;
    delete(key: string): void;
    keys?(): readonly string[];
}

export interface ExtensionSecureStorageOptions {
    readonly maxPlaintextBytes?: number;
    readonly maxEnvelopeBytes?: number;
}

interface SecureStorageEnvelope {
    readonly version: 1;
    readonly ciphertext: string;
}

const LOGICAL_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const ENVELOPE_KEYS = new Set(["version", "ciphertext"]);
const DEFAULT_MAX_PLAINTEXT_BYTES = 1024 * 1024;
const DEFAULT_MAX_ENVELOPE_BYTES = 2 * 1024 * 1024;

function encodeNamespacePart(value: string): string {
    return Buffer.from(value, "utf8")
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}

function validateLogicalKey(key: unknown): string {
    if (typeof key !== "string" || !LOGICAL_KEY_PATTERN.test(key)) {
        throw new ExtensionV1Error(
            "INVALID_ARGUMENT",
            "Secure storage key must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}",
            { details: { field: "key" } }
        );
    }

    return key;
}

function requirePositiveInteger(value: number, field: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new ExtensionV1Error(
            "INVALID_ARGUMENT",
            `${field} must be a positive safe integer`,
            { details: { field } }
        );
    }

    return value;
}

function parseEnvelope(value: string, maximumBytes: number): Buffer {
    if (Buffer.byteLength(value, "utf8") > maximumBytes) {
        throw new ExtensionV1Error(
            "SECURE_STORAGE_CORRUPT",
            "Secure storage envelope exceeds the configured size limit"
        );
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch (error) {
        throw new ExtensionV1Error(
            "SECURE_STORAGE_CORRUPT",
            "Secure storage envelope is not valid JSON",
            { cause: error }
        );
    }

    if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        Object.getPrototypeOf(parsed) !== Object.prototype
    ) {
        throw new ExtensionV1Error(
            "SECURE_STORAGE_CORRUPT",
            "Secure storage envelope has an invalid shape"
        );
    }

    const record = parsed as Record<string, unknown>;
    if (Object.keys(record).some(key => !ENVELOPE_KEYS.has(key))) {
        throw new ExtensionV1Error(
            "SECURE_STORAGE_CORRUPT",
            "Secure storage envelope contains unknown fields"
        );
    }
    if (
        record.version !== 1 ||
        typeof record.ciphertext !== "string" ||
        record.ciphertext.length === 0 ||
        !BASE64_PATTERN.test(record.ciphertext)
    ) {
        throw new ExtensionV1Error(
            "SECURE_STORAGE_CORRUPT",
            "Secure storage envelope contains invalid encrypted data"
        );
    }

    return Buffer.from(record.ciphertext, "base64");
}

export class ExtensionSecureStorage {
    readonly extensionId: string;
    readonly publisherFingerprint: string;
    private readonly namespacePrefix: string;
    private readonly maxPlaintextBytes: number;
    private readonly maxEnvelopeBytes: number;

    constructor(
        extensionId: string,
        publisherFingerprint: string,
        private readonly backend: SecureStorageBackend,
        private readonly encryption: SafeStorageLike,
        options: ExtensionSecureStorageOptions = {}
    ) {
        if (!isValidExtensionId(extensionId)) {
            throw new ExtensionV1Error(
                "INVALID_ARGUMENT",
                "extensionId must be a valid lower-case reverse-DNS identifier",
                { details: { field: "extensionId" } }
            );
        }
        if (
            typeof publisherFingerprint !== "string" ||
            !/^[0-9a-f]{64}$/.test(publisherFingerprint)
        ) {
            throw new ExtensionV1Error(
                "INVALID_ARGUMENT",
                "publisherFingerprint must be a lower-case SHA-256 fingerprint",
                { details: { field: "publisherFingerprint" } }
            );
        }
        if (
            backend === null ||
            typeof backend !== "object" ||
            typeof backend.get !== "function" ||
            typeof backend.set !== "function" ||
            typeof backend.delete !== "function"
        ) {
            throw new ExtensionV1Error(
                "INVALID_ARGUMENT",
                "A valid secure storage backend is required",
                { details: { field: "backend" } }
            );
        }
        if (
            encryption === null ||
            typeof encryption !== "object" ||
            typeof encryption.isEncryptionAvailable !== "function" ||
            typeof encryption.encryptString !== "function" ||
            typeof encryption.decryptString !== "function"
        ) {
            throw new ExtensionV1Error(
                "INVALID_ARGUMENT",
                "A valid safeStorage implementation is required",
                { details: { field: "encryption" } }
            );
        }

        this.extensionId = extensionId;
        this.publisherFingerprint = publisherFingerprint;
        this.namespacePrefix = `extensions-v1:${encodeNamespacePart(
            extensionId
        )}:sha256:${publisherFingerprint}:`;
        this.maxPlaintextBytes = requirePositiveInteger(
            options.maxPlaintextBytes ?? DEFAULT_MAX_PLAINTEXT_BYTES,
            "maxPlaintextBytes"
        );
        this.maxEnvelopeBytes = requirePositiveInteger(
            options.maxEnvelopeBytes ?? DEFAULT_MAX_ENVELOPE_BYTES,
            "maxEnvelopeBytes"
        );
    }

    getStorageKey(logicalKey: string): string {
        return this.namespacePrefix + encodeNamespacePart(validateLogicalKey(logicalKey));
    }

    get(logicalKey: string): string | undefined {
        this.assertEncryptionAvailable();
        const storageKey = this.getStorageKey(logicalKey);

        let storedValue: string | undefined;
        try {
            storedValue = this.backend.get(storageKey);
        } catch (error) {
            throw new ExtensionV1Error(
                "SECURE_STORAGE_OPERATION_FAILED",
                "Failed to read extension secure storage",
                { cause: error }
            );
        }
        if (storedValue === undefined) {
            return undefined;
        }
        if (typeof storedValue !== "string") {
            throw new ExtensionV1Error(
                "SECURE_STORAGE_CORRUPT",
                "Secure storage backend returned a non-string value"
            );
        }

        const encrypted = parseEnvelope(storedValue, this.maxEnvelopeBytes);
        try {
            const plaintext = this.encryption.decryptString(encrypted);
            if (
                typeof plaintext !== "string" ||
                Buffer.byteLength(plaintext, "utf8") > this.maxPlaintextBytes
            ) {
                throw new ExtensionV1Error(
                    "SECURE_STORAGE_CORRUPT",
                    "Decrypted secure storage value is invalid"
                );
            }
            return plaintext;
        } catch (error) {
            if (error instanceof ExtensionV1Error) {
                throw error;
            }
            throw new ExtensionV1Error(
                "SECURE_STORAGE_CORRUPT",
                "Failed to decrypt extension secure storage",
                { cause: error }
            );
        }
    }

    set(logicalKey: string, plaintext: string): void {
        this.assertEncryptionAvailable();
        const storageKey = this.getStorageKey(logicalKey);
        if (
            typeof plaintext !== "string" ||
            Buffer.byteLength(plaintext, "utf8") > this.maxPlaintextBytes
        ) {
            throw new ExtensionV1Error(
                "INVALID_ARGUMENT",
                "Secure storage value must be a string within the configured size limit",
                { details: { field: "plaintext" } }
            );
        }

        let encrypted: Buffer;
        try {
            encrypted = this.encryption.encryptString(plaintext);
        } catch (error) {
            throw new ExtensionV1Error(
                "SECURE_STORAGE_OPERATION_FAILED",
                "Failed to encrypt extension secure storage value",
                { cause: error }
            );
        }

        const envelope: SecureStorageEnvelope = {
            version: 1,
            ciphertext: encrypted.toString("base64")
        };
        const serialized = JSON.stringify(envelope);
        if (Buffer.byteLength(serialized, "utf8") > this.maxEnvelopeBytes) {
            throw new ExtensionV1Error(
                "INVALID_ARGUMENT",
                "Encrypted secure storage value exceeds the configured size limit",
                { details: { field: "plaintext" } }
            );
        }

        try {
            this.backend.set(storageKey, serialized);
        } catch (error) {
            throw new ExtensionV1Error(
                "SECURE_STORAGE_OPERATION_FAILED",
                "Failed to write extension secure storage",
                { cause: error }
            );
        }
    }

    delete(logicalKey: string): void {
        this.assertEncryptionAvailable();
        const storageKey = this.getStorageKey(logicalKey);
        try {
            this.backend.delete(storageKey);
        } catch (error) {
            throw new ExtensionV1Error(
                "SECURE_STORAGE_OPERATION_FAILED",
                "Failed to delete extension secure storage",
                { cause: error }
            );
        }
    }

    keys(): readonly string[] {
        this.assertEncryptionAvailable();
        if (typeof this.backend.keys !== "function") {
            throw new ExtensionV1Error(
                "SECURE_STORAGE_OPERATION_FAILED",
                "Secure storage backend does not support key enumeration"
            );
        }
        try {
            return this.backend
                .keys()
                .filter(key => key.startsWith(this.namespacePrefix))
                .map(key => {
                    const encoded = key.substring(this.namespacePrefix.length);
                    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
                        throw new Error("Invalid encoded secure storage key");
                    }
                    const padding = "=".repeat((4 - (encoded.length % 4)) % 4);
                    const decoded = Buffer.from(
                        encoded.replace(/-/g, "+").replace(/_/g, "/") + padding,
                        "base64"
                    ).toString("utf8");
                    return validateLogicalKey(decoded);
                })
                .sort();
        } catch (error) {
            if (error instanceof ExtensionV1Error) {
                throw error;
            }
            throw new ExtensionV1Error(
                "SECURE_STORAGE_OPERATION_FAILED",
                "Failed to enumerate extension secure storage",
                { cause: error }
            );
        }
    }

    private assertEncryptionAvailable(): void {
        let available: boolean;
        try {
            available = this.encryption.isEncryptionAvailable();
        } catch (error) {
            throw new ExtensionV1Error(
                "SECURE_STORAGE_UNAVAILABLE",
                "Unable to determine whether secure encryption is available",
                { cause: error }
            );
        }

        if (!available) {
            throw new ExtensionV1Error(
                "SECURE_STORAGE_UNAVAILABLE",
                "Electron safeStorage encryption is unavailable"
            );
        }
    }
}

export function createElectronExtensionSecureStorage(
    extensionId: string,
    publisherFingerprint: string,
    backend: SecureStorageBackend,
    options: ExtensionSecureStorageOptions = {}
): ExtensionSecureStorage {
    const processType = (process as NodeJS.Process & { type?: string }).type;
    if (processType === "renderer") {
        throw new ExtensionV1Error(
            "SECURE_STORAGE_UNAVAILABLE",
            "Extension secure storage is only available in the Electron main process"
        );
    }

    let safeStorage: SafeStorageLike | undefined;
    try {
        safeStorage = (
            require("electron") as { safeStorage?: SafeStorageLike }
        ).safeStorage;
    } catch (error) {
        throw new ExtensionV1Error(
            "SECURE_STORAGE_UNAVAILABLE",
            "Electron safeStorage could not be loaded",
            { cause: error }
        );
    }
    if (!safeStorage) {
        throw new ExtensionV1Error(
            "SECURE_STORAGE_UNAVAILABLE",
            "Electron safeStorage is unavailable"
        );
    }

    return new ExtensionSecureStorage(
        extensionId,
        publisherFingerprint,
        backend,
        safeStorage,
        options
    );
}
