"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const extensionV1 = require("../../build/eez-studio-shared/extensions-v1");

function assertErrorCode(code, operation) {
    assert.throws(operation, error => {
        assert(error instanceof extensionV1.ExtensionV1Error);
        assert.equal(error.code, code);
        return true;
    });
}

function createPackageJson(overrides = {}) {
    return {
        name: "@example/extension",
        version: "1.2.3",
        displayName: "Example Extension",
        license: "MIT",
        "eez-studio": {
            apiVersion: "1.0",
            host: "sandbox",
            browser: "dist/main.js",
            activationEvents: ["onStartup"],
            capabilities: ["project.read", "storage.secure"],
            allowedOrigins: [
                "https://api.example.com",
                "https://assets.example.com:8443"
            ],
            contributes: {
                homeSections: [
                    {
                        id: "tools",
                        title: "Tools",
                        icon: "material:extension",
                        commands: [{ id: "example.run", title: "Run" }]
                    }
                ]
            }
        },
        ...overrides
    };
}

test("manifest validates package metadata and a closed eez-studio block", () => {
    const packageJson = createPackageJson();
    const manifest = extensionV1.validateExtensionV1PackageManifest(packageJson);

    assert.equal(manifest.id, "@example/extension");
    assert.equal(manifest.name, packageJson.name);
    assert.equal(manifest.eezStudio.browser, "dist/main.js");
    assert.deepEqual(manifest.eezStudio.allowedOrigins, [
        "https://api.example.com",
        "https://assets.example.com:8443"
    ]);
    assert.equal(manifest.license, undefined);
    assert.notEqual(manifest, packageJson);
    assert(Object.isFrozen(manifest));
    assert(Object.isFrozen(manifest.eezStudio));
    assert(Object.isFrozen(manifest.eezStudio.allowedOrigins));
    assert(Object.isFrozen(manifest.eezStudio.contributes.homeSections));

    assertErrorCode("INVALID_MANIFEST", () =>
        extensionV1.validateExtensionV1PackageManifest(
            createPackageJson({
                "eez-studio": {
                    ...packageJson["eez-studio"],
                    unexpected: true
                }
            })
        )
    );
});

test("manifest validates declarative contribution schemas statically", () => {
    const configuration = createPackageJson()["eez-studio"];
    for (const contributes of [
        { unknownPoint: [] },
        {
            homeSections: [
                {
                    id: "tools",
                    title: "Tools",
                    icon: "material:extension",
                    unknown: true
                }
            ]
        },
        {
            homeSections: [
                {
                    id: "tools",
                    title: "Tools",
                    icon: "material:extension",
                    commands: [
                        { id: "run", title: "Run" },
                        { id: "run", title: "Run again" }
                    ]
                }
            ]
        }
    ]) {
        assertErrorCode("INVALID_MANIFEST", () =>
            extensionV1.validateExtensionV1PackageManifest(
                createPackageJson({
                    "eez-studio": { ...configuration, contributes }
                })
            )
        );
    }
});

test("manifest only accepts non-network declarative material icons", () => {
    const configuration = createPackageJson()["eez-studio"];
    for (const icon of [
        "https://example.com/icon.png",
        "file:///tmp/icon.png",
        "\\\\server\\share\\icon.png",
        "svg:unknown",
        "material:Extension",
        "material:bad-name"
    ]) {
        assertErrorCode("INVALID_MANIFEST", () =>
            extensionV1.validateExtensionV1PackageManifest(
                createPackageJson({
                    "eez-studio": {
                        ...configuration,
                        contributes: {
                            homeSections: [
                                {
                                    id: "tools",
                                    title: "Tools",
                                    icon
                                }
                            ]
                        }
                    }
                })
            )
        );
    }
    assert.equal(
        extensionV1.isSafeDeclarativeIcon("material:extension"),
        true
    );
});

test("manifest only accepts unique exact HTTPS origins", () => {
    const configuration = createPackageJson()["eez-studio"];

    for (const allowedOrigins of [
        ["http://api.example.com"],
        ["https://api.example.com/path"],
        ["https://api.example.com/"],
        ["https://api.example.com", "https://api.example.com"],
        Array.from({ length: 65 }, (_, index) => `https://host-${index}.example`)
    ]) {
        assertErrorCode("INVALID_MANIFEST", () =>
            extensionV1.validateExtensionV1PackageManifest(
                createPackageJson({
                    "eez-studio": {
                        ...configuration,
                        allowedOrigins
                    }
                })
            )
        );
    }
});

test("manifest rejects browser entries reserved by the sandbox host", () => {
    const configuration = createPackageJson()["eez-studio"];
    for (const browser of ["__host.html", "__host.js"]) {
        assertErrorCode("INVALID_MANIFEST", () =>
            extensionV1.validateExtensionV1PackageManifest(
                createPackageJson({
                    "eez-studio": { ...configuration, browser }
                })
            )
        );
    }
});

test("capability grants enforce identity, scope, lifetime, and request subset", () => {
    const grant = extensionV1.validateExtensionGrant({
        version: 1,
        grantId: "123e4567-e89b-42d3-a456-426614174000",
        extensionId: "@example/extension",
        capabilities: ["project.read", "storage.secure"],
        issuedAt: 1000,
        expiresAt: 2000,
        projectIds: ["project-one"]
    });

    extensionV1.assertGrantCapabilitiesRequested(grant, [
        "project.read",
        "project.write",
        "storage.secure"
    ]);
    extensionV1.assertCapabilityGranted(
        grant,
        "@example/extension",
        "project.read",
        { now: 1500, projectId: "project-one" }
    );

    assertErrorCode("PERMISSION_DENIED", () =>
        extensionV1.assertCapabilityGranted(
            grant,
            "@example/other",
            "project.read",
            { now: 1500, projectId: "project-one" }
        )
    );
    assertErrorCode("PERMISSION_DENIED", () =>
        extensionV1.assertCapabilityGranted(
            grant,
            "@example/extension",
            "project.read",
            { now: 999, projectId: "project-one" }
        )
    );
    assertErrorCode("GRANT_EXPIRED", () =>
        extensionV1.assertCapabilityGranted(
            grant,
            "@example/extension",
            "project.read",
            { now: 2000, projectId: "project-one" }
        )
    );
    assertErrorCode("CAPABILITY_NOT_GRANTED", () =>
        extensionV1.assertCapabilityGranted(
            grant,
            "@example/extension",
            "project.write",
            { now: 1500, projectId: "project-one" }
        )
    );
    assertErrorCode("PERMISSION_DENIED", () =>
        extensionV1.assertCapabilityGranted(
            grant,
            "@example/extension",
            "project.read",
            { now: 1500, projectId: "project-two" }
        )
    );
    assertErrorCode("PERMISSION_DENIED", () =>
        extensionV1.assertGrantCapabilitiesRequested(grant, ["project.read"])
    );
});

test("install policy rejects traversal, non-portable paths, and archive bombs", () => {
    assert.equal(
        extensionV1.validatePackageRelativePath("dist/main.js"),
        "dist/main.js"
    );

    for (const packagePath of [
        "../main.js",
        "/main.js",
        "C:/main.js",
        "dist\\main.js",
        "dist//main.js",
        "dist/./main.js",
        "con/file.js"
    ]) {
        assertErrorCode("INVALID_PACKAGE_PATH", () =>
            extensionV1.validatePackageRelativePath(packagePath)
        );
    }

    assertErrorCode("PACKAGE_ENTRY_TOO_LARGE", () =>
        extensionV1.validateInstallPackage(100, [
            {
                path: "dist/main.js",
                type: "file",
                compressedSize: 1,
                uncompressedSize: 201
            }
        ])
    );
    assertErrorCode("UNSUPPORTED_PACKAGE_ENTRY", () =>
        extensionV1.validateInstallPackage(100, [
            {
                path: "dist/link",
                type: "symlink",
                compressedSize: 1,
                uncompressedSize: 1
            }
        ])
    );
    assertErrorCode("PACKAGE_TOO_LARGE", () =>
        extensionV1.validateInstallPackage(101, [], {
            maxArchiveBytes: 100
        })
    );
});

test("local framing handles chunks and authentication detects replay", () => {
    const first = extensionV1.encodeFrame({ type: "first", sequence: 1 });
    const second = extensionV1.encodeFrame({ type: "second", sequence: 2 });
    const decoder = new extensionV1.FrameDecoder();

    assert.deepEqual(decoder.push(first.subarray(0, 3)), []);
    assert.deepEqual(
        decoder.push(Buffer.concat([first.subarray(3), second])),
        [
            { type: "first", sequence: 1 },
            { type: "second", sequence: 2 }
        ]
    );
    assertErrorCode("FRAME_TOO_LARGE", () =>
        extensionV1.encodeFrame({ value: "too large" }, 4)
    );

    const endpoint = extensionV1.createLocalEndpointDescriptor({
        transport: "unix",
        address: "/tmp/eez-extension-v1-test.sock",
        now: 1000,
        ttlMs: 10000
    });
    const firstNonce = extensionV1.createNonce();
    const secondNonce = extensionV1.createNonce();
    assert.notEqual(firstNonce, secondNonce);
    assert.match(firstNonce, /^[A-Za-z0-9_-]{43}$/);

    const authentication = extensionV1.createLocalEndpointAuthentication(
        endpoint,
        { now: 5000, clientNonce: firstNonce }
    );
    const secret = Buffer.alloc(32, 7);
    const mac = extensionV1.createAuthenticationMac(secret, authentication);
    assert(extensionV1.verifyAuthenticationMac(secret, authentication, mac));

    const invalidMac = (mac[0] === "A" ? "B" : "A") + mac.slice(1);
    assert.equal(
        extensionV1.verifyAuthenticationMac(secret, authentication, invalidMac),
        false
    );

    const replayCache = new extensionV1.NonceReplayCache(10000, 4);
    extensionV1.assertEndpointAuthentication(
        endpoint,
        secret,
        authentication,
        mac,
        { now: 5000, maxClockSkewMs: 1000, replayCache }
    );
    assertErrorCode("NONCE_REUSED", () =>
        extensionV1.assertEndpointAuthentication(
            endpoint,
            secret,
            authentication,
            mac,
            { now: 5001, maxClockSkewMs: 1000, replayCache }
        )
    );
});

test("secure storage namespaces encrypted values with injected substitutes", () => {
    const values = new Map();
    const backend = {
        get: key => values.get(key),
        set: (key, value) => values.set(key, value),
        delete: key => values.delete(key),
        keys: () => Array.from(values.keys())
    };
    const encryption = {
        isEncryptionAvailable: () => true,
        encryptString: plaintext => Buffer.from(`sealed:${plaintext}`, "utf8"),
        decryptString: encrypted => {
            const value = encrypted.toString("utf8");
            assert(value.startsWith("sealed:"));
            return value.slice("sealed:".length);
        }
    };
    const first = new extensionV1.ExtensionSecureStorage(
        "@example/first",
        "a".repeat(64),
        backend,
        encryption
    );
    const second = new extensionV1.ExtensionSecureStorage(
        "@example/second",
        "b".repeat(64),
        backend,
        encryption
    );

    first.set("token", "first secret");
    second.set("token", "second secret");
    assert.equal(first.get("token"), "first secret");
    assert.equal(second.get("token"), "second secret");
    assert.deepEqual(first.keys(), ["token"]);
    assert.notEqual(first.getStorageKey("token"), second.getStorageKey("token"));
    const replacement = new extensionV1.ExtensionSecureStorage(
        "@example/first",
        "c".repeat(64),
        backend,
        encryption
    );
    assert.notEqual(first.getStorageKey("token"), replacement.getStorageKey("token"));
    assert.equal(replacement.get("token"), undefined);
    assert.equal(values.size, 2);
    for (const stored of values.values()) {
        assert(!stored.includes("first secret"));
        assert(!stored.includes("second secret"));
    }

    const unavailable = new extensionV1.ExtensionSecureStorage(
        "@example/unavailable",
        "d".repeat(64),
        backend,
        {
            ...encryption,
            isEncryptionAvailable: () => false
        }
    );
    assertErrorCode("SECURE_STORAGE_UNAVAILABLE", () =>
        unavailable.set("token", "secret")
    );

    values.set(first.getStorageKey("corrupt"), "not-json");
    assertErrorCode("SECURE_STORAGE_CORRUPT", () => first.get("corrupt"));
});
