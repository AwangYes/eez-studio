const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");

const utils = require(path.join(
    __dirname,
    "../../build/home/extensions-v1/interaction-service-utils.js"
));

const projectRoot = path.resolve(__dirname, "../..");
const interactionServicePath = path.join(
    projectRoot,
    "build/home/extensions-v1/interaction-service.js"
);

function request(extensionId, service, method, args, signal) {
    return {
        extensionId,
        service,
        method,
        args,
        deadline: Date.now() + 10_000,
        signal: signal ?? new AbortController().signal
    };
}

function loadServices({ window, showOpenDialog, resolveProject, applyProjectEdits }) {
    const originalLoad = Module._load;
    Module._load = function (moduleName, parent, isMain) {
        if (moduleName === "@electron/remote") {
            return {
                dialog: { showOpenDialog },
                getCurrentWindow: () => window
            };
        }
        if (moduleName === "home/extensions-v1/interaction-service-utils") {
            return utils;
        }
        return originalLoad.call(this, moduleName, parent, isMain);
    };
    delete require.cache[require.resolve(interactionServicePath)];
    try {
        const { registerInteractionExtensionServices } = require(
            interactionServicePath
        );
        return new Map(
            registerInteractionExtensionServices({
                resolveProject,
                applyProjectEdits
            }).map(({ service, handler }) => [service, handler])
        );
    } finally {
        Module._load = originalLoad;
    }
}

function createHarness(overrides = {}) {
    const inputEvents = [];
    const captures = [];
    const dialogs = [];
    const window = {
        getContentBounds: () => ({ x: 10, y: 20, width: 640, height: 480 }),
        webContents: {
            async sendInputEvent(event) {
                inputEvents.push(event);
            },
            async capturePage(rect) {
                captures.push(rect);
                return {
                    getSize: () => ({ width: rect.width, height: rect.height }),
                    toPNG: () => Buffer.from("png-artifact-payload"),
                    toJPEG: quality => Buffer.from(`jpeg-${quality}-payload`)
                };
            }
        }
    };
    const stores = overrides.stores ?? new Map();
    const services = loadServices({
        window,
        async showOpenDialog(owner, options) {
            dialogs.push({ owner, options });
            return overrides.dialogResult ?? { canceled: true, filePaths: [] };
        },
        resolveProject(projectId) {
            const store = stores.get(projectId);
            if (!store) throw new Error(`Unknown project: ${projectId}`);
            return { store, tab: {} };
        },
        applyProjectEdits:
            overrides.applyProjectEdits ??
            (async () => {
                throw new Error("Unexpected project edit");
            })
    });
    return { services, window, inputEvents, captures, dialogs };
}

function createStore(filePath, overrides = {}) {
    return {
        filePath,
        isModified: false,
        publicRevision: "revision-1",
        runtime: { isRunning: false, isPaused: false },
        assertRevision(revision) {
            assert.equal(revision, this.publicRevision);
        },
        undoManager: { undo() {} },
        ...overrides
    };
}

async function makeAssetHarness(options = {}) {
    const root = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "eez-interaction-service-")
    );
    const sourcePath = path.join(root, "selected.bin");
    const projectPath = path.join(root, "project", "project.eez-project");
    await fs.promises.mkdir(path.dirname(projectPath), { recursive: true });
    await fs.promises.writeFile(projectPath, "{}", "utf8");
    await fs.promises.writeFile(
        sourcePath,
        options.sourceBytes ?? Buffer.from("new asset bytes")
    );
    const store = createStore(projectPath, options.store);
    const harness = createHarness({
        stores: new Map([["project-1", store]]),
        dialogResult: { canceled: false, filePaths: [sourcePath] },
        applyProjectEdits: options.applyProjectEdits
    });
    const asset = harness.services.get("asset");
    const selected = await asset(
        request("extension.one", "asset", "selectSource", {})
    );
    return { ...harness, root, sourcePath, projectPath, store, asset, selected };
}

test("input validator rejects unsafe and oversized sequences", () => {
    assert.throws(
        () => utils.validateInputRequest({ target: "studio-ui", events: [] }),
        error => error.code === "INVALID_ARGUMENT"
    );
    assert.throws(
        () =>
            utils.validateInputRequest({
                target: "studio-ui",
                events: [{ type: "pointer", action: "move", x: -1, y: 0 }]
            }),
        error => error.code === "INVALID_ARGUMENT"
    );
});

test("capture validator enforces bounded rectangles and targets", () => {
    const valid = utils.validateCaptureRequest({
        target: "runtime",
        projectId: "project-1",
        rect: { x: 0, y: 0, width: 100, height: 80 },
        format: "jpeg",
        quality: 75
    });
    assert.equal(valid.format, "jpeg");
    assert.throws(
        () =>
            utils.validateCaptureRequest({
                rect: { x: 0, y: 0, width: 4097, height: 4096 }
            }),
        error => error.code === "INVALID_ARGUMENT"
    );
});

test("asset target resolver rejects traversal, absolute and empty components", () => {
    const root = path.resolve("/tmp/project");
    assert.equal(utils.resolveAssetTarget(root, "images/icon.png").relativePath, "images/icon.png");
    for (const value of ["../escape.bin", "/tmp/escape.bin", "images//icon.png", "images/../icon.png"]) {
        assert.throws(() => utils.resolveAssetTarget(root, value), error => error.code === "ASSET_PATH_UNSAFE");
    }
});

test("rate limiter bounds calls in a sliding window", () => {
    const limiter = new utils.SlidingWindowRateLimiter(2, 1000);
    limiter.consume("ext", 1000);
    limiter.consume("ext", 1001);
    assert.throws(() => limiter.consume("ext", 1002), error => error.code === "TOO_MANY_REQUESTS");
    limiter.consume("ext", 2002);
});

test("input service sends pointer, keyboard and text events to Electron", async () => {
    const harness = createHarness();
    const input = harness.services.get("input");
    const result = await input(
        request("input.extension", "input", "inject", {
            target: "studio-ui",
            events: [
                { type: "pointer", action: "move", x: 12, y: 34 },
                {
                    type: "pointer",
                    action: "down",
                    x: 12,
                    y: 34,
                    button: "right"
                },
                { type: "pointer", action: "up", x: 12, y: 34 },
                { type: "key", action: "down", key: "Enter" },
                { type: "key", action: "up", key: "Enter" },
                { type: "text", value: "A\u03a9" }
            ]
        })
    );

    assert.deepEqual(result, { delivered: 6, target: "studio-ui" });
    assert.deepEqual(harness.inputEvents, [
        { type: "mouseMove", x: 12, y: 34, button: "left" },
        { type: "mouseDown", x: 12, y: 34, button: "right" },
        { type: "mouseUp", x: 12, y: 34, button: "left" },
        { type: "keyDown", keyCode: "Enter" },
        { type: "keyUp", keyCode: "Enter" },
        { type: "char", keyCode: "A" },
        { type: "char", keyCode: "\u03a9" }
    ]);
});

test("runtime input is rejected until the project runtime is active", async () => {
    const projectPath = path.join(os.tmpdir(), "runtime.eez-project");
    const store = createStore(projectPath);
    const harness = createHarness({ stores: new Map([["project-1", store]]) });
    const input = harness.services.get("input");
    const args = {
        target: "runtime",
        projectId: "project-1",
        events: [{ type: "key", action: "down", key: "F5" }]
    };

    await assert.rejects(
        input(request("runtime.extension", "input", "inject", args)),
        error => error.code === "INVALID_RUNTIME_STATE"
    );
    store.runtime.isPaused = true;
    assert.deepEqual(
        await input(request("runtime.extension", "input", "inject", args)),
        { delivered: 1, target: "runtime" }
    );
});

test("screenshot service captures through Electron and owns chunked artifacts", async () => {
    const harness = createHarness();
    const screenshot = harness.services.get("screenshot");
    const capture = await screenshot(
        request("extension.one", "screenshot", "capture", {
            target: "studio-ui",
            format: "png",
            rect: { x: 5, y: 6, width: 120, height: 80 }
        })
    );

    assert.deepEqual(harness.captures, [
        { x: 5, y: 6, width: 120, height: 80 }
    ]);
    assert.equal(capture.mimeType, "image/png");
    assert.equal(capture.width, 120);
    assert.equal(capture.height, 80);
    assert.equal(capture.sha256, crypto.createHash("sha256").update("png-artifact-payload").digest("hex"));

    const chunks = [];
    let offset = 0;
    do {
        const chunk = await screenshot(
            request("extension.one", "screenshot", "readArtifact", {
                artifactId: capture.artifactId,
                offset,
                limit: 5
            })
        );
        chunks.push(Buffer.from(chunk.data, "base64"));
        if (chunk.done) break;
        offset = chunk.nextOffset;
    } while (true);
    assert.equal(Buffer.concat(chunks).toString(), "png-artifact-payload");

    await assert.rejects(
        screenshot(
            request("extension.two", "screenshot", "readArtifact", {
                artifactId: capture.artifactId
            })
        ),
        error => error.code === "PERMISSION_DENIED"
    );
    await assert.rejects(
        screenshot(
            request("extension.two", "screenshot", "deleteArtifact", {
                artifactId: capture.artifactId
            })
        ),
        error => error.code === "PERMISSION_DENIED"
    );
    assert.deepEqual(
        await screenshot(
            request("extension.one", "screenshot", "deleteArtifact", {
                artifactId: capture.artifactId
            })
        ),
        { deleted: true }
    );
    await assert.rejects(
        screenshot(
            request("extension.one", "screenshot", "readArtifact", {
                artifactId: capture.artifactId
            })
        ),
        error => error.code === "OBJECT_NOT_FOUND"
    );
});

test("screenshot service passes JPEG quality and full window bounds to Electron", async () => {
    const harness = createHarness();
    const screenshot = harness.services.get("screenshot");
    const capture = await screenshot(
        request("jpeg.extension", "screenshot", "capture", {
            format: "jpeg",
            quality: 73
        })
    );

    assert.deepEqual(harness.captures, [
        { x: 0, y: 0, width: 640, height: 480 }
    ]);
    assert.equal(capture.mimeType, "image/jpeg");
    const artifact = await screenshot(
        request("jpeg.extension", "screenshot", "readArtifact", {
            artifactId: capture.artifactId
        })
    );
    assert.equal(Buffer.from(artifact.data, "base64").toString(), "jpeg-73-payload");
});

test("asset selection uses Electron dialog and import commits file and project edits", async t => {
    let applyRequest;
    const context = await makeAssetHarness({
        async applyProjectEdits(request) {
            applyRequest = request;
            assert.equal(
                await fs.promises.readFile(
                    path.join(path.dirname(context.projectPath), "assets/icon.bin"),
                    "utf8"
                ),
                "new asset bytes"
            );
            return {
                revision: "revision-2",
                dirty: true,
                temporaryIds: { image: "object-1" }
            };
        }
    });
    t.after(() => fs.promises.rm(context.root, { recursive: true, force: true }));

    assert.equal(context.dialogs.length, 1);
    assert.equal(context.dialogs[0].owner, context.window);
    assert.deepEqual(context.dialogs[0].options, { properties: ["openFile"] });
    assert.equal(context.selected.cancelled, false);
    assert.equal(context.selected.name, "selected.bin");
    const result = await context.asset(
        request("extension.one", "asset", "import", {
            token: context.selected.token,
            projectId: "project-1",
            relativePath: "assets/icon.bin",
            expectedRevision: "revision-1",
            edits: [{ kind: "update", objectId: "image", properties: { source: "assets/icon.bin" } }],
            label: "Import icon"
        })
    );

    assert.equal(applyRequest.service, "project");
    assert.equal(applyRequest.method, "applyEdits");
    assert.equal(applyRequest.args.label, "Import icon");
    assert.deepEqual(result, {
        assetPath: "assets/icon.bin",
        sha256: context.selected.sha256,
        byteLength: Buffer.byteLength("new asset bytes"),
        projectId: "project-1",
        revision: "revision-2",
        dirty: true,
        temporaryIds: { image: "object-1" }
    });
    await assert.rejects(
        context.asset(
            request("extension.one", "asset", "import", {
                token: context.selected.token,
                projectId: "project-1",
                relativePath: "assets/again.bin"
            })
        ),
        error => error.code === "PERMISSION_DENIED"
    );
});

test("asset import restores an existing file when project edits fail", async t => {
    const context = await makeAssetHarness({
        async applyProjectEdits() {
            throw Object.assign(new Error("edit failed"), { code: "EDIT_FAILED" });
        }
    });
    t.after(() => fs.promises.rm(context.root, { recursive: true, force: true }));
    const targetPath = path.join(path.dirname(context.projectPath), "assets/icon.bin");
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.promises.writeFile(targetPath, "old asset bytes", "utf8");

    await assert.rejects(
        context.asset(
            request("extension.one", "asset", "import", {
                token: context.selected.token,
                projectId: "project-1",
                relativePath: "assets/icon.bin",
                replace: true,
                edits: [{ kind: "update" }]
            })
        ),
        error => error.code === "EDIT_FAILED"
    );
    assert.equal(await fs.promises.readFile(targetPath, "utf8"), "old asset bytes");
    assert.deepEqual(
        (await fs.promises.readdir(path.dirname(targetPath))).sort(),
        ["icon.bin"]
    );
});

test("asset import undoes project edits when file commit fails", async t => {
    let undoCalls = 0;
    const context = await makeAssetHarness({
        store: {
            undoManager: { undo: () => undoCalls++ }
        },
        async applyProjectEdits() {
            return { revision: "revision-2", dirty: true };
        }
    });
    context.store.assertRevision = revision => assert.equal(revision, "revision-2");
    t.after(() => fs.promises.rm(context.root, { recursive: true, force: true }));
    const targetPath = path.join(path.dirname(context.projectPath), "assets/icon.bin");
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.promises.writeFile(targetPath, "old asset bytes", "utf8");

    const originalRm = fs.promises.rm;
    let injected = false;
    fs.promises.rm = async (filePath, options) => {
        if (!injected && String(filePath).includes(".eez-backup-")) {
            injected = true;
            throw Object.assign(new Error("commit cleanup failed"), {
                code: "EIO"
            });
        }
        return originalRm(filePath, options);
    };
    try {
        await assert.rejects(
            context.asset(
                request("extension.one", "asset", "import", {
                    token: context.selected.token,
                    projectId: "project-1",
                    relativePath: "assets/icon.bin",
                    replace: true,
                    edits: [{ kind: "update" }]
                })
            ),
            error => error.code === "EIO"
        );
    } finally {
        fs.promises.rm = originalRm;
    }
    assert.equal(undoCalls, 1);
    assert.equal(await fs.promises.readFile(targetPath, "utf8"), "old asset bytes");
});

test("asset import reports ASSET_ROLLBACK_FAILED when project undo fails", async t => {
    const context = await makeAssetHarness({
        store: {
            undoManager: {
                undo() {
                    throw new Error("undo failed");
                }
            }
        },
        async applyProjectEdits() {
            return { revision: "revision-2", dirty: true };
        }
    });
    context.store.assertRevision = revision => assert.equal(revision, "revision-2");
    t.after(() => fs.promises.rm(context.root, { recursive: true, force: true }));
    const targetPath = path.join(path.dirname(context.projectPath), "assets/icon.bin");
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.promises.writeFile(targetPath, "old asset bytes", "utf8");

    const originalRm = fs.promises.rm;
    let injected = false;
    fs.promises.rm = async (filePath, options) => {
        if (!injected && String(filePath).includes(".eez-backup-")) {
            injected = true;
            throw new Error("commit cleanup failed");
        }
        return originalRm(filePath, options);
    };
    try {
        await assert.rejects(
            context.asset(
                request("extension.one", "asset", "import", {
                    token: context.selected.token,
                    projectId: "project-1",
                    relativePath: "assets/icon.bin",
                    replace: true,
                    edits: [{ kind: "update" }]
                })
            ),
            error => error.code === "ASSET_ROLLBACK_FAILED"
        );
    } finally {
        fs.promises.rm = originalRm;
    }
    assert.equal(await fs.promises.readFile(targetPath, "utf8"), "old asset bytes");
});

test("asset import rejects a source changed after dialog selection", async t => {
    const context = await makeAssetHarness();
    t.after(() => fs.promises.rm(context.root, { recursive: true, force: true }));
    await fs.promises.writeFile(context.sourcePath, "changed asset!!", "utf8");

    await assert.rejects(
        context.asset(
            request("extension.one", "asset", "import", {
                token: context.selected.token,
                projectId: "project-1",
                relativePath: "assets/icon.bin"
            })
        ),
        error => error.code === "ASSET_SOURCE_CHANGED"
    );
    await assert.rejects(
        fs.promises.access(
            path.join(path.dirname(context.projectPath), "assets/icon.bin")
        ),
        error => error.code === "ENOENT"
    );
});
