"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const projectRoot = path.resolve(__dirname, "../..");
const extensionV1 = require(path.join(
    projectRoot,
    "build/eez-studio-shared/extensions-v1"
));

function requireWithMocks(modulePath, mocks) {
    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (Object.prototype.hasOwnProperty.call(mocks, request)) {
            return mocks[request];
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[require.resolve(modulePath)];
    try {
        return require(modulePath);
    } finally {
        Module._load = originalLoad;
    }
}

function runWithMocks(mocks, operation) {
    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (Object.prototype.hasOwnProperty.call(mocks, request)) {
            return mocks[request];
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        return operation();
    } finally {
        Module._load = originalLoad;
    }
}

function createMemoryBackend() {
    const values = new Map();
    return {
        values,
        get: key => values.get(key),
        set: (key, value) => values.set(key, value),
        delete: key => void values.delete(key),
        keys: () => Array.from(values.keys())
    };
}

const encryption = {
    isEncryptionAvailable: () => true,
    encryptString(plaintext) {
        return Buffer.from(plaintext, "utf8").map(byte => byte ^ 0xa5);
    },
    decryptString(ciphertext) {
        return ciphertext.map(byte => byte ^ 0xa5).toString("utf8");
    }
};

const secureStoragePath = path.join(
    projectRoot,
    "build/main/extensions-v1/secure-storage-service.js"
);
const secureStorageModule = requireWithMocks(secureStoragePath, {
    electron: { app: { getPath: () => os.tmpdir() } },
    "eez-studio-shared/extensions-v1": extensionV1
});
const observabilityPath = path.join(
    projectRoot,
    "build/main/extensions-v1/observability.js"
);
const observabilityModule = requireWithMocks(observabilityPath, {
    electron: { app: { getPath: () => os.tmpdir() } }
});

test("encrypted secure storage persists and isolates extension namespaces", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "eez-secure-persist-"));
    const filePath = path.join(directory, "secrets.json");
    const electron = { safeStorage: encryption };
    const firstFingerprint = "a".repeat(64);
    const replacementFingerprint = "b".repeat(64);
    try {
        const backend = new secureStorageModule.FileSecureStorageBackend(filePath);
        const first = runWithMocks({ electron }, () =>
            extensionV1.createElectronExtensionSecureStorage(
                "com.example.first",
                firstFingerprint,
                backend
            )
        );
        const second = runWithMocks({ electron }, () =>
            extensionV1.createElectronExtensionSecureStorage(
                "com.example.second",
                firstFingerprint,
                backend
            )
        );
        first.set("token", "first persistent secret");
        second.set("token", "second persistent secret");

        const serialized = fs.readFileSync(filePath, "utf8");
        assert(!serialized.includes("first persistent secret"));
        assert(!serialized.includes("second persistent secret"));
        assert.equal(JSON.parse(serialized).version, 1);
        if (process.platform !== "win32") {
            assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
        }

        const reloadedBackend = new secureStorageModule.FileSecureStorageBackend(
            filePath
        );
        const reloaded = new extensionV1.ExtensionSecureStorage(
            "com.example.first",
            firstFingerprint,
            reloadedBackend,
            encryption
        );
        const replacementPublisher = new extensionV1.ExtensionSecureStorage(
            "com.example.first",
            replacementFingerprint,
            reloadedBackend,
            encryption
        );
        assert.equal(reloaded.get("token"), "first persistent secret");
        assert.deepEqual(reloaded.keys(), ["token"]);
        assert.equal(replacementPublisher.get("token"), undefined);
        assert.equal(reloadedBackend.keys().length, 2);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("secure storage corruption fails closed consistently", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "eez-secure-corrupt-"));
    const filePath = path.join(directory, "secrets.json");
    fs.writeFileSync(filePath, '{"version":1,"values":', "utf8");
    try {
        const backend = new secureStorageModule.FileSecureStorageBackend(filePath);
        let firstFailure;
        assert.throws(
            () => backend.keys(),
            error => {
                firstFailure = error;
                assert.equal(error.code, "SECURE_STORAGE_CORRUPT");
                return true;
            }
        );
        assert.throws(
            () => backend.get("anything"),
            error => error === firstFailure
        );
        assert.equal(
            fs.readFileSync(filePath, "utf8"),
            '{"version":1,"values":'
        );
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("secure storage enforces per-extension key and total file quotas", () => {
    const backend = createMemoryBackend();
    const sessionBackend = createMemoryBackend();
    const factory = (extensionId, publisherFingerprint, selectedBackend) =>
        new extensionV1.ExtensionSecureStorage(
            extensionId,
            publisherFingerprint,
            selectedBackend,
            encryption
        );
    const service = new secureStorageModule.ExtensionSecureStorageService(
        backend,
        sessionBackend,
        factory
    );
    const fingerprint = "c".repeat(64);
    for (
        let index = 0;
        index < secureStorageModule.SECURE_STORAGE_MAX_KEYS_PER_EXTENSION;
        index++
    ) {
        service.dispatch("com.example.quota", fingerprint, "store", {
            key: `key-${index}`,
            value: `value-${index}`
        });
    }
    assert.throws(
        () =>
            service.dispatch("com.example.quota", fingerprint, "store", {
                key: "one-too-many",
                value: "rejected"
            }),
        error => error.code === "SECURE_STORAGE_QUOTA_EXCEEDED"
    );
    assert.deepEqual(
        service.dispatch("com.example.quota", fingerprint, "store", {
            key: "key-0",
            value: "replacement"
        }),
        { stored: true }
    );
    assert.deepEqual(
        service.dispatch("com.example.other", fingerprint, "store", {
            key: "independent",
            value: "allowed"
        }),
        { stored: true }
    );

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "eez-secure-quota-"));
    const filePath = path.join(directory, "secrets.json");
    try {
        const fileBackend = new secureStorageModule.FileSecureStorageBackend(filePath);
        fileBackend.set("existing", "preserved");
        const original = fs.readFileSync(filePath, "utf8");
        assert.throws(
            () =>
                fileBackend.set(
                    "oversized",
                    "x".repeat(
                        secureStorageModule.SECURE_STORAGE_MAX_TOTAL_BYTES
                    )
                ),
            error => error.code === "SECURE_STORAGE_QUOTA_EXCEEDED"
        );
        assert.equal(fs.readFileSync(filePath, "utf8"), original);
        assert.equal(fileBackend.get("existing"), "preserved");
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("unsigned secure storage remains session-only", () => {
    const persistentBackend = createMemoryBackend();
    const factory = (extensionId, publisherFingerprint, backend) =>
        new extensionV1.ExtensionSecureStorage(
            extensionId,
            publisherFingerprint,
            backend,
            encryption
        );
    const firstSession = new secureStorageModule.ExtensionSecureStorageService(
        persistentBackend,
        createMemoryBackend(),
        factory
    );
    firstSession.dispatch("com.example.developer", undefined, "store", {
        key: "token",
        value: "temporary"
    });
    assert.deepEqual(
        firstSession.dispatch("com.example.developer", undefined, "get", {
            key: "token"
        }),
        { value: "temporary" }
    );
    assert.equal(persistentBackend.values.size, 0);

    const nextSession = new secureStorageModule.ExtensionSecureStorageService(
        persistentBackend,
        createMemoryBackend(),
        factory
    );
    assert.deepEqual(
        nextSession.dispatch("com.example.developer", undefined, "get", {
            key: "token"
        }),
        { value: undefined }
    );
});

test("audit records redact sensitive details and expose aggregate metrics", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "eez-audit-redact-"));
    try {
        const observability = new observabilityModule.ExtensionObservability(
            directory
        );
        observability.emit({
            type: "service.completed",
            extensionId: "com.example.audit",
            publisherFingerprint: "d".repeat(64),
            workspaceScope: "/private/workspace/customer-project",
            service: "project",
            method: "read",
            durationMs: 12,
            details: {
                apiToken: "token-value-must-not-leak",
                nested: {
                    password: "password-value-must-not-leak",
                    safe: "visible"
                },
                longValue: "v".repeat(600),
                many: Array.from({ length: 40 }, (_, index) => index),
                deep: { one: { two: { three: { four: { five: "hidden" } } } } }
            }
        });
        observability.emit({
            type: "service.completed",
            extensionId: "com.example.audit",
            service: "project",
            method: "read",
            durationMs: 8
        });
        observability.emit({
            type: "permission.denied",
            extensionId: "com.example.audit"
        });
        observability.setGauge("hosts.active", 3);
        await observability.flush();

        const raw = fs.readFileSync(
            path.join(directory, "extensions.jsonl"),
            "utf8"
        );
        assert(!raw.includes("token-value-must-not-leak"));
        assert(!raw.includes("password-value-must-not-leak"));
        assert(!raw.includes("/private/workspace/customer-project"));
        const records = raw
            .trimEnd()
            .split("\n")
            .map(line => JSON.parse(line));
        assert.equal(records.length, 3);
        assert.match(records[0].timestamp, /^\d{4}-\d{2}-\d{2}T/);
        assert.match(records[0].eventId, /^[0-9a-f-]{36}$/);
        assert.equal(records[0].publisherFingerprint, `sha256:${"d".repeat(16)}`);
        assert.equal(
            records[0].workspaceScope,
            crypto
                .createHash("sha256")
                .update("/private/workspace/customer-project")
                .digest("hex")
        );
        assert.equal(records[0].details.apiToken, "[redacted]");
        assert.equal(records[0].details.nested.password, "[redacted]");
        assert.equal(records[0].details.nested.safe, "visible");
        assert.equal(records[0].details.longValue.length, 512);
        assert.equal(records[0].details.many.length, 32);
        assert(JSON.stringify(records[0].details).includes("[truncated]"));

        assert.deepEqual(observability.snapshot(), {
            counters: {
                "service.completed": 2,
                "permission.denied": 1,
                "audit.writeFailures": 0
            },
            gauges: { "hosts.active": 3 },
            totalDurationMs: { "project.read": 20 }
        });
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("audit log rotation retains the configured number of newest files", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "eez-audit-rotate-"));
    const logPath = path.join(directory, "extensions.jsonl");
    try {
        fs.writeFileSync(
            logPath,
            Buffer.alloc(observabilityModule.EXTENSION_AUDIT_MAX_LOG_BYTES, "a")
        );
        for (
            let index = 1;
            index <= observabilityModule.EXTENSION_AUDIT_MAX_ROLLED_FILES;
            index++
        ) {
            fs.writeFileSync(`${logPath}.${index}`, `rolled-${index}`, "utf8");
        }

        const observability = new observabilityModule.ExtensionObservability(
            directory
        );
        observability.emit({
            type: "integrity.violation",
            extensionId: "com.example.rotation"
        });
        await observability.flush();

        assert.equal(
            fs.statSync(`${logPath}.1`).size,
            observabilityModule.EXTENSION_AUDIT_MAX_LOG_BYTES
        );
        for (
            let index = 2;
            index <= observabilityModule.EXTENSION_AUDIT_MAX_ROLLED_FILES;
            index++
        ) {
            assert.equal(
                fs.readFileSync(`${logPath}.${index}`, "utf8"),
                `rolled-${index - 1}`
            );
        }
        const active = JSON.parse(fs.readFileSync(logPath, "utf8").trim());
        assert.equal(active.type, "integrity.violation");
        if (process.platform !== "win32") {
            assert.equal(fs.statSync(logPath).mode & 0o777, 0o600);
        }
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("audit write failures are counted without rejecting flush", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "eez-audit-failure-"));
    const invalidDirectory = path.join(directory, "not-a-directory");
    fs.writeFileSync(invalidDirectory, "file", "utf8");
    const originalConsoleError = console.error;
    try {
        console.error = () => {};
        const observability = new observabilityModule.ExtensionObservability(
            invalidDirectory
        );
        observability.emit({
            type: "host.activation.failed",
            extensionId: "com.example.failure"
        });
        await observability.flush();
        assert.deepEqual(observability.snapshot(), {
            counters: {
                "host.activation.failed": 1,
                "audit.writeFailures": 1
            },
            gauges: {},
            totalDurationMs: {}
        });
    } finally {
        console.error = originalConsoleError;
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
