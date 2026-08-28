"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const AdmZip = require("adm-zip");
const extensionV1 = require("../../build/eez-studio-shared/extensions-v1");

async function withTemporaryDirectory(operation) {
    const directoryPath = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "eez-extension-install-test-")
    );
    try {
        return await operation(directoryPath);
    } finally {
        await fs.promises.rm(directoryPath, {
            recursive: true,
            force: true
        });
    }
}

function writeZip(archivePath, entries) {
    const archive = new AdmZip();
    for (const entry of entries) {
        archive.addFile(entry.name, Buffer.from(entry.content));
        if (entry.attr !== undefined) {
            archive.getEntry(entry.name).attr = entry.attr;
        }
    }
    archive.writeZip(archivePath);
}

function replaceAllBytes(buffer, source, replacement) {
    assert.equal(
        Buffer.byteLength(source),
        Buffer.byteLength(replacement),
        "ZIP entry replacements must preserve header lengths"
    );

    const sourceBytes = Buffer.from(source);
    const replacementBytes = Buffer.from(replacement);
    let replacements = 0;
    let offset = 0;
    while ((offset = buffer.indexOf(sourceBytes, offset)) !== -1) {
        replacementBytes.copy(buffer, offset);
        offset += sourceBytes.length;
        replacements++;
    }
    assert.equal(replacements, 2, "local and central ZIP names must be patched");
}

function fileDigest(content) {
    return crypto.createHash("sha256").update(content).digest("hex");
}

function canonicalSignaturePayload(signature) {
    const normalizedFiles = Object.fromEntries(
        Object.entries(signature.files).map(([file, digest]) => [
            file.normalize("NFC"),
            digest
        ])
    );
    const files = Object.fromEntries(
        Object.entries(normalizedFiles).sort(([left], [right]) =>
            Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
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

async function createSignedPackage(packageRoot, additionalFiles = {}) {
    const files = {
        "dist/main.js": Buffer.from("module.exports = {};\n", "utf8"),
        "package.json": Buffer.from(
            JSON.stringify({
                name: "@example/signed-extension",
                version: "1.0.0",
                "eez-studio": {
                    apiVersion: "1.0",
                    host: "sandbox",
                    browser: "dist/main.js"
                }
            }),
            "utf8"
        ),
        ...additionalFiles
    };
    for (const [relativePath, content] of Object.entries(files)) {
        const filePath = path.join(packageRoot, relativePath);
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        await fs.promises.writeFile(filePath, content);
    }

    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    const signature = {
        version: 1,
        algorithm: "ed25519",
        keyId: "test-publisher",
        files: Object.fromEntries(
            Object.entries(files).map(([relativePath, content]) => [
                relativePath,
                fileDigest(content)
            ])
        )
    };
    signature.signature = crypto
        .sign(null, canonicalSignaturePayload(signature), privateKey)
        .toString("base64");
    await fs.promises.writeFile(
        path.join(packageRoot, extensionV1.EXTENSION_SIGNATURE_FILE),
        JSON.stringify(signature),
        "utf8"
    );

    const publisherFingerprint = crypto
        .createHash("sha256")
        .update(publicKey.export({ type: "spki", format: "der" }))
        .digest("hex");
    return {
        signature,
        publisherFingerprint,
        policy: {
            source: "catalog",
            developerMode: false,
            trustedKeys: {
                "test-publisher": publicKey.export({
                    type: "spki",
                    format: "pem"
                })
            }
        }
    };
}

test("safe archive extraction writes a normal ZIP inside its destination", async () => {
    await withTemporaryDirectory(async temporaryRoot => {
        const archivePath = path.join(temporaryRoot, "normal.zip");
        const destinationPath = path.join(temporaryRoot, "installed");
        writeZip(archivePath, [
            { name: "package.json", content: "{}" },
            { name: "dist/main.js", content: "module.exports = {};\n" }
        ]);

        await extensionV1.extractExtensionArchiveSafely(
            archivePath,
            destinationPath
        );

        assert.equal(
            await fs.promises.readFile(
                path.join(destinationPath, "dist/main.js"),
                "utf8"
            ),
            "module.exports = {};\n"
        );
        assert.deepEqual(
            (await fs.promises.readdir(destinationPath)).sort(),
            ["dist", "package.json"]
        );
    });
});

test("safe archive extraction rejects a real traversal ZIP before writing", async () => {
    await withTemporaryDirectory(async temporaryRoot => {
        const archivePath = path.join(temporaryRoot, "traversal.zip");
        const destinationPath = path.join(temporaryRoot, "installed");
        const outsidePath = path.join(temporaryRoot, "outside.txt");
        const archive = new AdmZip();
        archive.addFile("aa/outside.txt", Buffer.from("escaped"));
        const zipBytes = archive.toBuffer();
        replaceAllBytes(zipBytes, "aa/outside.txt", "../outside.txt");
        await fs.promises.writeFile(archivePath, zipBytes);

        await assert.rejects(
            extensionV1.extractExtensionArchiveSafely(
                archivePath,
                destinationPath
            ),
            error => {
                assert(error instanceof extensionV1.ExtensionV1Error);
                assert.equal(error.code, "INVALID_PACKAGE_PATH");
                return true;
            }
        );
        assert.equal(fs.existsSync(outsidePath), false);
        assert.equal(fs.existsSync(destinationPath), false);
    });
});

test("safe archive extraction rejects Unix symlinks and high compression ratios", async () => {
    await withTemporaryDirectory(async temporaryRoot => {
        const symlinkArchivePath = path.join(temporaryRoot, "symlink.zip");
        const bombArchivePath = path.join(temporaryRoot, "compression.zip");
        writeZip(symlinkArchivePath, [
            {
                name: "link",
                content: "outside-target",
                attr: 0xa1ff0000
            }
        ]);
        writeZip(bombArchivePath, [
            {
                name: "repeated.txt",
                content: Buffer.alloc(1024 * 1024, 65)
            }
        ]);

        await assert.rejects(
            extensionV1.extractExtensionArchiveSafely(
                symlinkArchivePath,
                path.join(temporaryRoot, "symlink-output")
            ),
            error => {
                assert(error instanceof extensionV1.ExtensionV1Error);
                assert.equal(error.code, "UNSUPPORTED_PACKAGE_ENTRY");
                return true;
            }
        );
        await assert.rejects(
            extensionV1.extractExtensionArchiveSafely(
                bombArchivePath,
                path.join(temporaryRoot, "compression-output")
            ),
            error => {
                assert(error instanceof extensionV1.ExtensionV1Error);
                assert.equal(error.code, "PACKAGE_ENTRY_TOO_LARGE");
                return true;
            }
        );
    });
});

test("archive size is rejected before ZIP parsing", async () => {
    await withTemporaryDirectory(async temporaryRoot => {
        const archivePath = path.join(temporaryRoot, "oversized.zip");
        await fs.promises.writeFile(archivePath, Buffer.from("not a zip"));
        await fs.promises.truncate(archivePath, 100 * 1024 * 1024 + 1);

        await assert.rejects(
            extensionV1.extractExtensionArchiveSafely(
                archivePath,
                path.join(temporaryRoot, "output")
            ),
            error => {
                assert(error instanceof extensionV1.ExtensionV1Error);
                assert.equal(error.code, "PACKAGE_TOO_LARGE");
                return true;
            }
        );
    });
});

test("Ed25519 verification accepts a trusted package and rejects bad signatures", async () => {
    await withTemporaryDirectory(async packageRoot => {
        const { signature, policy } = await createSignedPackage(packageRoot);
        const verification =
            await extensionV1.verifyExtensionPackageSignature(
                packageRoot,
                policy
            );
        assert.equal(verification.signed, true);
        assert.equal(verification.keyId, "test-publisher");
        assert.match(verification.publisherFingerprint, /^[0-9a-f]{64}$/);

        const signaturePath = path.join(
            packageRoot,
            extensionV1.EXTENSION_SIGNATURE_FILE
        );
        const signatureBytes = Buffer.from(signature.signature, "base64");
        signatureBytes[0] ^= 0xff;
        await fs.promises.writeFile(
            signaturePath,
            JSON.stringify({
                ...signature,
                signature: signatureBytes.toString("base64")
            }),
            "utf8"
        );

        await assert.rejects(
            extensionV1.verifyExtensionPackageSignature(packageRoot, policy),
            /signature verification failed/
        );
    });
});

test("catalog installation pins the verified publisher fingerprint", async () => {
    await withTemporaryDirectory(async packageRoot => {
        const { policy, publisherFingerprint } =
            await createSignedPackage(packageRoot);
        const expectation = {
            id: "@example/signed-extension",
            version: "1.0.0",
            extensionType: "extension-v1",
            publisherFingerprint
        };

        const installation = require(
            "../../build/eez-studio-shared/extensions/extension-installation"
        );
        const prepared = await installation.prepareExtensionPackageForInstall(
            packageRoot,
            { ...policy, expected: expectation }
        );
        assert.equal(prepared.publisherFingerprint, publisherFingerprint);

        await assert.rejects(
            installation.prepareExtensionPackageForInstall(packageRoot, {
                ...policy,
                expected: {
                    ...expectation,
                    publisherFingerprint: "0".repeat(64)
                }
            }),
            /publisher fingerprint mismatch/
        );
    });
});

test("signature verification rejects tampered signed files", async () => {
    await withTemporaryDirectory(async packageRoot => {
        const { policy } = await createSignedPackage(packageRoot);
        await fs.promises.appendFile(
            path.join(packageRoot, "dist/main.js"),
            "// tampered\n",
            "utf8"
        );

        await assert.rejects(
            extensionV1.verifyExtensionPackageSignature(packageRoot, policy),
            /integrity check failed/
        );
    });
});

test("signature canonicalization uses NFC paths and UTF-8 byte ordering", async () => {
    await withTemporaryDirectory(async packageRoot => {
        const decomposedName = `dist/a\u0308.js`;
        const { policy } = await createSignedPackage(packageRoot, {
            "dist/z.js": Buffer.from("z", "utf8"),
            [decomposedName]: Buffer.from("unicode", "utf8")
        });

        const verification = await extensionV1.verifyExtensionPackageSignature(
            packageRoot,
            policy
        );
        assert.equal(verification.signed, true);
        assert.equal(
            Object.prototype.hasOwnProperty.call(
                verification.files,
                decomposedName.normalize("NFC")
            ),
            true
        );
        assert.equal(
            Object.prototype.hasOwnProperty.call(verification.files, decomposedName),
            false
        );
    });
});

test("signature verification only accepts Ed25519 publisher keys", async () => {
    await withTemporaryDirectory(async packageRoot => {
        const { policy } = await createSignedPackage(packageRoot);
        const { publicKey } = crypto.generateKeyPairSync("rsa", {
            modulusLength: 2048
        });

        await assert.rejects(
            extensionV1.verifyExtensionPackageSignature(packageRoot, {
                ...policy,
                trustedKeys: {
                    "test-publisher": publicKey.export({
                        type: "spki",
                        format: "pem"
                    })
                }
            }),
            /must be Ed25519/
        );
    });
});

test("Catalog packages are never accepted unsigned", async () => {
    await withTemporaryDirectory(async packageRoot => {
        await fs.promises.writeFile(
            path.join(packageRoot, "package.json"),
            "{}",
            "utf8"
        );

        for (const developerMode of [false, true]) {
            await assert.rejects(
                extensionV1.verifyExtensionPackageSignature(packageRoot, {
                    source: "catalog",
                    developerMode,
                    trustedKeys: {}
                }),
                /signature is required/
            );
        }
    });
});

test("local unsigned packages require explicit Developer Mode", async () => {
    await withTemporaryDirectory(async packageRoot => {
        await fs.promises.writeFile(
            path.join(packageRoot, "package.json"),
            "{}",
            "utf8"
        );

        await assert.rejects(
            extensionV1.verifyExtensionPackageSignature(packageRoot, {
                source: "local",
                developerMode: false,
                trustedKeys: {}
            }),
            /signature is required/
        );
        assert.deepEqual(
            await extensionV1.verifyExtensionPackageSignature(packageRoot, {
                source: "local",
                developerMode: true,
                trustedKeys: {}
            }),
            { signed: false }
        );
    });
});
