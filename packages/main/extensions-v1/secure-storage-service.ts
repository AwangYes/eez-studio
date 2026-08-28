import { app } from "electron";
import crypto from "crypto";
import fs from "fs";
import path from "path";

import {
    createElectronExtensionSecureStorage,
    ExtensionV1Error,
    type SecureStorageBackend
} from "eez-studio-shared/extensions-v1";

interface StoredSecrets {
    readonly version: 1;
    readonly values: Record<string, string>;
}

export const SECURE_STORAGE_MAX_KEYS_PER_EXTENSION = 256;
export const SECURE_STORAGE_MAX_TOTAL_BYTES = 4 * 1024 * 1024;

function atomicWrite(filePath: string, contents: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
        descriptor = fs.openSync(temporaryPath, "wx", 0o600);
        fs.writeFileSync(descriptor, contents, "utf8");
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(temporaryPath, filePath);
        try {
            const directory = fs.openSync(path.dirname(filePath), "r");
            fs.fsyncSync(directory);
            fs.closeSync(directory);
        } catch (error) {
            if (process.platform !== "win32") {
                throw error;
            }
        }
    } finally {
        if (descriptor != undefined) {
            fs.closeSync(descriptor);
        }
        try {
            fs.unlinkSync(temporaryPath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
            }
        }
    }
}

export class FileSecureStorageBackend implements SecureStorageBackend {
    private loaded = false;
    private loadFailure: ExtensionV1Error | undefined;
    private values: Record<string, string> = {};

    constructor(private readonly configuredPath?: string) {}

    private get filePath() {
        return (
            this.configuredPath ??
            path.join(app.getPath("userData"), "extension-v1-secrets.json")
        );
    }

    private load() {
        if (this.loadFailure) {
            throw this.loadFailure;
        }
        if (this.loaded) {
            return;
        }
        try {
            const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
            if (
                parsed?.version !== 1 ||
                !parsed.values ||
                typeof parsed.values !== "object" ||
                Array.isArray(parsed.values) ||
                Object.getPrototypeOf(parsed.values) !== Object.prototype ||
                !Object.entries(parsed.values).every(
                    ([key, value]) =>
                        typeof key === "string" && typeof value === "string"
                )
            ) {
                throw new Error("Secure storage file has an invalid shape");
            }
            this.values = Object.fromEntries(Object.entries(parsed.values));
            this.loaded = true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                this.loadFailure = new ExtensionV1Error(
                    "SECURE_STORAGE_CORRUPT",
                    "Extension secure storage file is corrupt",
                    { cause: error }
                );
                throw this.loadFailure;
            }
            this.loaded = true;
        }
    }

    get(key: string) {
        this.load();
        return this.values[key];
    }

    set(key: string, value: string) {
        this.load();
        const next = { ...this.values, [key]: value };
        const document: StoredSecrets = { version: 1, values: next };
        const serialized = JSON.stringify(document);
        if (
            Buffer.byteLength(serialized, "utf8") >
            SECURE_STORAGE_MAX_TOTAL_BYTES
        ) {
            throw new ExtensionV1Error(
                "SECURE_STORAGE_QUOTA_EXCEEDED",
                "Extension secure storage quota exceeded"
            );
        }
        atomicWrite(this.filePath, serialized);
        this.values = next;
    }

    delete(key: string) {
        this.load();
        if (!(key in this.values)) {
            return;
        }
        const next = { ...this.values };
        delete next[key];
        atomicWrite(
            this.filePath,
            JSON.stringify({ version: 1, values: next } satisfies StoredSecrets)
        );
        this.values = next;
    }

    keys() {
        this.load();
        return Object.keys(this.values);
    }
}

function requireRecord(args: unknown) {
    if (
        args == null ||
        typeof args !== "object" ||
        Array.isArray(args) ||
        Object.getPrototypeOf(args) !== Object.prototype
    ) {
        throw new ExtensionV1Error("INVALID_ARGUMENT", "Arguments must be an object");
    }
    return args as Record<string, unknown>;
}

function requireOnly(record: Record<string, unknown>, allowed: readonly string[]) {
    if (Object.keys(record).some(key => !allowed.includes(key))) {
        throw new ExtensionV1Error("INVALID_ARGUMENT", "Arguments contain unknown fields");
    }
}

function createSessionBackend(): SecureStorageBackend {
    const values = new Map<string, string>();
    return {
        get: key => values.get(key),
        set: (key, value) => values.set(key, value),
        delete: key => void values.delete(key),
        keys: () => Array.from(values.keys())
    };
}

export class ExtensionSecureStorageService {
    constructor(
        private readonly persistentBackend: SecureStorageBackend = new FileSecureStorageBackend(),
        private readonly sessionBackend: SecureStorageBackend = createSessionBackend(),
        private readonly createStorage: typeof createElectronExtensionSecureStorage =
            createElectronExtensionSecureStorage
    ) {}

    dispatch(
        extensionId: string,
        publisherFingerprint: string | undefined,
        method: string,
        args: unknown
    ) {
        const signed = publisherFingerprint != undefined;
        const identity =
            publisherFingerprint ??
            crypto
                .createHash("sha256")
                .update(`developer-unsigned:${extensionId}`, "utf8")
                .digest("hex");
        const storage = this.createStorage(
            extensionId,
            identity,
            signed ? this.persistentBackend : this.sessionBackend
        );
        const record = requireRecord(args);
        if (method === "keys") {
            requireOnly(record, []);
            return { keys: storage.keys() };
        }
        requireOnly(record, method === "store" || method === "set" ? ["key", "value"] : ["key"]);
        if (typeof record.key !== "string") {
            throw new ExtensionV1Error("INVALID_ARGUMENT", "key must be a string");
        }
        if (method === "get") {
            return { value: storage.get(record.key) };
        }
        if (method === "store" || method === "set") {
            if (typeof record.value !== "string") {
                throw new ExtensionV1Error("INVALID_ARGUMENT", "value must be a string");
            }
            const keys = storage.keys();
            if (
                !keys.includes(record.key) &&
                keys.length >= SECURE_STORAGE_MAX_KEYS_PER_EXTENSION
            ) {
                throw new ExtensionV1Error(
                    "SECURE_STORAGE_QUOTA_EXCEEDED",
                    "Extension secure storage key limit exceeded"
                );
            }
            storage.set(record.key, record.value);
            return { stored: true };
        }
        if (method === "delete") {
            storage.delete(record.key);
            return { deleted: true };
        }
        throw new ExtensionV1Error(
            "METHOD_NOT_FOUND",
            `Unknown secure storage method: ${method}`
        );
    }
}
