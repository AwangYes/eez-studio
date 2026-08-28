"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { after, test } = require("node:test");

const REQUEST_CHANNEL = "eez-extension-v1/studio-request";
const RESPONSE_CHANNEL = "eez-extension-v1/studio-response";
const CANCEL_CHANNEL = "eez-extension-v1/studio-cancel";
const READY_CHANNEL = "eez-extension-v1/studio-ready";
const CHANGE_REQUEST_CHANNEL = "eez-extension-v1/change-request";
const COMMAND_CHANNEL = "eez-extension-v1/command";
const SHUTDOWN_CHANNEL = "eez-extension-v1/shutdown";

class FakeWebContents extends EventEmitter {
    constructor(renderer) {
        super();
        this.renderer = renderer;
        this.destroyed = false;
        this.sent = [];
    }

    isDestroyed() {
        return this.destroyed;
    }

    send(channel, payload) {
        this.sent.push({ channel, payload });
        queueMicrotask(() => this.renderer.emit(channel, {}, payload));
    }
}

const ipcMain = new EventEmitter();
const ipcRenderer = new EventEmitter();
const webContents = new FakeWebContents(ipcRenderer);
const homeWindow = {
    browserWindow: {
        webContents,
        isDestroyed: () => false
    }
};

ipcRenderer.send = (channel, payload) => {
    queueMicrotask(() => ipcMain.emit(channel, { sender: webContents }, payload));
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === "electron") {
        return { ipcMain, ipcRenderer };
    }
    if (request === "main/home-window") {
        return { findHomeWindow: () => homeWindow };
    }
    return originalLoad.call(this, request, parent, isMain);
};

const projectRoot = path.resolve(__dirname, "../..");
const { RendererServiceBroker } = require(path.join(
    projectRoot,
    "build/main/extensions-v1/renderer-service-broker.js"
));
const { studioExtensionServiceHost: serviceHost } = require(path.join(
    projectRoot,
    "build/home/extensions-v1/service-host.js"
));

Module._load = originalLoad;

const broker = new RendererServiceBroker();

after(() => {
    serviceHost.dispose();
    broker.dispose();
});

test("broker and renderer service host complete a request-response round trip", async () => {
    const unregister = serviceHost.register("integration.echo", request => {
        assert.equal(request.extensionId, "@example/integration");
        assert.equal(request.service, "integration.echo");
        assert.equal(request.method, "read");
        assert.deepEqual(request.args, { value: 42 });
        assert.equal(request.signal.aborted, false);
        return Promise.resolve({ echoed: request.args });
    });

    try {
        assert.deepEqual(
            await broker.dispatch(
                "@example/integration",
                "integration.echo",
                "read",
                { value: 42 },
                new AbortController().signal,
                1000
            ),
            { echoed: { value: 42 } }
        );
    } finally {
        unregister();
    }
});

test("service errors preserve their machine-readable code through the broker", async () => {
    const unregister = serviceHost.register("integration.error", async () => {
        const error = new Error("expected service failure");
        error.code = "EXPECTED_FAILURE";
        throw error;
    });

    try {
        await assert.rejects(
            broker.dispatch(
                "@example/integration",
                "integration.error",
                "fail",
                {},
                new AbortController().signal,
                1000
            ),
            error => {
                assert.equal(error.code, "EXPECTED_FAILURE");
                assert.equal(error.message, "expected service failure");
                return true;
            }
        );
    } finally {
        unregister();
    }
});

test("broker cancellation reaches the active renderer service request", async () => {
    let handlerStartedResolve;
    const handlerStarted = new Promise(resolve => {
        handlerStartedResolve = resolve;
    });
    let rendererObservedAbort = false;
    const unregister = serviceHost.register("integration.cancel", request => {
        handlerStartedResolve();
        return new Promise(resolve => {
            request.signal.addEventListener(
                "abort",
                () => {
                    rendererObservedAbort = true;
                    resolve(undefined);
                },
                { once: true }
            );
        });
    });
    const abortController = new AbortController();
    const pending = broker.dispatch(
        "@example/integration",
        "integration.cancel",
        "wait",
        {},
        abortController.signal,
        1000
    );

    try {
        await handlerStarted;
        abortController.abort("integration test cancellation");
        await assert.rejects(pending, /request cancelled/);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(rendererObservedAbort, true);
        assert.equal(
            webContents.sent.some(entry => entry.channel === CANCEL_CHANNEL),
            true
        );
    } finally {
        unregister();
    }
});

test("unknown renderer services return SERVICE_NOT_FOUND", async () => {
    await assert.rejects(
        broker.dispatch(
            "@example/integration",
            "integration.missing",
            "read",
            {},
            new AbortController().signal,
            1000
        ),
        error => {
            assert.equal(error.code, "SERVICE_NOT_FOUND");
            return true;
        }
    );

    assert.equal(ipcMain.listenerCount(RESPONSE_CHANNEL) > 0, true);
    assert.equal(ipcRenderer.listenerCount(REQUEST_CHANNEL) > 0, true);
});

test("renderer service host includes installed extension IDs in READY", async () => {
    const readyPayload = new Promise(resolve => {
        ipcMain.once(READY_CHANNEL, (_event, payload) => resolve(payload));
    });

    serviceHost.markReady(["installed.keep"]);

    assert.deepEqual(await readyPayload, {
        extensionIds: ["installed.keep"]
    });
});

function requireWithMocks(modulePath, mocks) {
    const load = Module._load;
    Module._load = function (request, parent, isMain) {
        if (Object.prototype.hasOwnProperty.call(mocks, request)) {
            return mocks[request];
        }
        return load.call(this, request, parent, isMain);
    };
    delete require.cache[require.resolve(modulePath)];
    try {
        return require(modulePath);
    } finally {
        Module._load = load;
    }
}

test("sandbox preload rejects reserved lifecycle services", () => {
    const preloadIpc = new EventEmitter();
    const sent = [];
    preloadIpc.send = (channel, payload) => sent.push({ channel, payload });
    let exposedApi;
    const argument = "--eez-extension-instance=test-instance";
    process.argv.push(argument);
    try {
        requireWithMocks(
            path.join(
                projectRoot,
                "build/main/extensions-v1/sandbox-preload.js"
            ),
            {
                electron: {
                    contextBridge: {
                        exposeInMainWorld(_name, api) {
                            exposedApi = api;
                        }
                    },
                    ipcRenderer: preloadIpc
                }
            }
        );
    } finally {
        process.argv.splice(process.argv.lastIndexOf(argument), 1);
    }

    assert.equal(exposedApi.onInternalEvent, undefined);
    assert.throws(
        () => exposedApi.request("$host", "ready", {}),
        /Reserved extension service/
    );
    assert.throws(
        () => exposedApi.notify("$host", "deactivated", {}),
        /Reserved extension service/
    );
    for (const [service, method] of [
        ["", "list"],
        ["workspace", ""],
        ["x".repeat(129), "list"],
        ["workspace", "x".repeat(129)]
    ]) {
        assert.throws(() => exposedApi.request(service, method, {}));
    }
    assert.throws(
        () => exposedApi.subscribe(undefined),
        /listener must be a function/
    );
    exposedApi.notify("workspace", "list", {});
    assert.equal(sent.length, 1);
    assert.equal(sent[0].payload.service, "workspace");
});

test("sandbox host owns lifecycle completion and denies ambient permissions", async () => {
    const sandboxRoot = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "eez-extension-sandbox-")
    );
    await fs.promises.mkdir(path.join(sandboxRoot, "dist"));
    await fs.promises.writeFile(
        path.join(sandboxRoot, "dist", "entry.js"),
        "export async function activate() {}\n",
        "utf8"
    );
    class FakeSandboxWebContents extends EventEmitter {
        constructor() {
            super();
            this.destroyed = false;
            this.executed = [];
            this.sent = [];
        }

        isDestroyed() {
            return this.destroyed;
        }

        setWindowOpenHandler(handler) {
            this.windowOpenHandler = handler;
        }

        executeJavaScript(script) {
            this.executed.push(script);
            return Promise.resolve(this.executed.length === 1 ? true : undefined);
        }

        send(channel, payload) {
            this.sent.push({ channel, payload });
        }
    }

    const windows = [];
    class FakeSandboxWindow extends EventEmitter {
        constructor() {
            super();
            this.webContents = new FakeSandboxWebContents();
            this.destroyed = false;
            windows.push(this);
        }

        loadURL(url) {
            this.loadedUrl = url;
            return Promise.resolve();
        }

        isDestroyed() {
            return this.destroyed;
        }

        destroy() {
            if (this.destroyed) {
                return;
            }
            this.destroyed = true;
            this.webContents.destroyed = true;
            this.emit("closed");
        }
    }

    class FakeSession extends EventEmitter {
        constructor() {
            super();
            this.protocol = {
                handle: async (_scheme, handler) => {
                    this.protocolHandler = handler;
                },
                unhandle: async () => {
                    this.protocolRemoved = true;
                }
            };
            this.webRequest = {
                onBeforeRequest: handler => {
                    this.beforeRequestHandler = handler;
                },
                onHeadersReceived: handler => {
                    this.headersReceivedHandler = handler;
                }
            };
        }

        setPermissionCheckHandler(handler) {
            this.permissionCheckHandler = handler;
        }

        setPermissionRequestHandler(handler) {
            this.permissionRequestHandler = handler;
        }

        setDevicePermissionHandler(handler) {
            this.devicePermissionHandler = handler;
        }

        setDisplayMediaRequestHandler(handler) {
            this.displayMediaRequestHandler = handler;
        }
    }

    const sandboxIpc = new EventEmitter();
    const sessions = [];
    const sandboxModule = requireWithMocks(
        path.join(projectRoot, "build/main/extensions-v1/sandbox-host.js"),
        {
            electron: {
                BrowserWindow: FakeSandboxWindow,
                ipcMain: sandboxIpc,
                net: { fetch: () => Promise.resolve(new Response()) },
                session: {
                    fromPartition() {
                        const extensionSession = new FakeSession();
                        sessions.push(extensionSession);
                        return extensionSession;
                    }
                }
            },
            "main/extensions-v1/protocol": {
                EXTENSION_SCHEME: "eez-extension"
            },
            "eez-studio-shared/extensions-v1": {
                EXTENSION_SIGNATURE_FILE: "extension-signature.json",
                TRUSTED_EXTENSION_PUBLISHERS: {},
                async verifyExtensionPackageSignature(root) {
                    const content = await fs.promises.readFile(
                        path.join(root, "dist", "entry.js")
                    );
                    return {
                        signed: true,
                        publisherFingerprint: "a".repeat(64),
                        files: {
                            "dist/entry.js": crypto
                                .createHash("sha256")
                                .update(content)
                                .digest("hex")
                        }
                    };
                }
            }
        }
    );

    let dispatches = 0;
    const host = new sandboxModule.SandboxExtensionHost(
        {
            id: "@example/sandbox",
            version: "1.0.0",
            installationPath: sandboxRoot,
            browser: "dist/entry.js",
            publisherFingerprint: "a".repeat(64)
        },
        async () => {
            dispatches++;
        }
    );
    await host.activate();

    const extensionSession = sessions[0];
    const sandboxWindow = windows[0];
    assert.equal(extensionSession.permissionCheckHandler(), false);
    assert.equal(extensionSession.devicePermissionHandler(), false);
    let displayStreams;
    extensionSession.displayMediaRequestHandler({}, streams => {
        displayStreams = streams;
    });
    assert.deepEqual(displayStreams, {});
    let permissionGranted;
    extensionSession.permissionRequestHandler(
        sandboxWindow.webContents,
        "media",
        granted => {
            permissionGranted = granted;
        }
    );
    assert.equal(permissionGranted, false);
    let downloadPrevented = false;
    extensionSession.emit("will-download", {
        preventDefault() {
            downloadPrevented = true;
        }
    });
    assert.equal(downloadPrevented, true);

    const hostResponse = await extensionSession.protocolHandler({
        url: sandboxWindow.loadedUrl
    });
    assert.doesNotMatch(await hostResponse.text(), /__host\.js/);
    const entryResponse = await extensionSession.protocolHandler({
        url: `${sandboxWindow.loadedUrl.replace("/__host.html", "")}/dist/entry.js`
    });
    assert.equal(entryResponse.status, 200);
    assert.match(entryResponse.headers.get("content-type"), /text\/javascript/);
    assert.match(sandboxWindow.webContents.executed[0], /extension\.activate/);
    assert.doesNotMatch(sandboxWindow.webContents.executed[0], /\$host/);

    const instanceId = new URL(sandboxWindow.loadedUrl).hostname;
    sandboxIpc.emit(
        "eez-extension-v1/request",
        { sender: sandboxWindow.webContents },
        {
            instanceId,
            requestId: 7,
            service: "$host",
            method: "ready",
            args: {}
        }
    );
    assert.equal(dispatches, 0);
    assert.equal(
        sandboxWindow.webContents.sent.at(-1).payload.error.code,
        "SERVICE_NOT_FOUND"
    );

    let navigationPrevented = false;
    sandboxWindow.webContents.emit("will-navigate", {
        preventDefault() {
            navigationPrevented = true;
        }
    });
    assert.equal(navigationPrevented, true);

    await host.deactivate("shutdown");
    assert.match(sandboxWindow.webContents.executed[1], /extension\.deactivate/);
    assert.match(sandboxWindow.webContents.executed[1], /shutdown/);
    assert.equal(extensionSession.protocolRemoved, true);
    assert.equal(extensionSession.permissionCheckHandler, null);
    assert.equal(extensionSession.displayMediaRequestHandler, null);
    assert.equal(extensionSession.listenerCount("will-download"), 0);

    let integrityExits = 0;
    const integrityHost = new sandboxModule.SandboxExtensionHost(
        {
            id: "@example/integrity",
            version: "1.0.0",
            installationPath: sandboxRoot,
            browser: "dist/entry.js",
            publisherFingerprint: "a".repeat(64)
        },
        async () => undefined,
        () => {
            integrityExits++;
        }
    );
    await integrityHost.activate();
    const integritySession = sessions[1];
    const integrityWindow = windows[1];
    await fs.promises.writeFile(
        path.join(sandboxRoot, "dist", "entry.js"),
        "export async function activate() { throw new Error('tampered'); }\n",
        "utf8"
    );
    const integrityResponse = await integritySession.protocolHandler({
        url: `${integrityWindow.loadedUrl.replace(
            "/__host.html",
            ""
        )}/dist/entry.js`
    });
    assert.equal(integrityResponse.status, 409);
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(integrityExits, 1);
    assert.equal(integritySession.protocolRemoved, true);

    let unexpectedExits = 0;
    const crashedHost = new sandboxModule.SandboxExtensionHost(
        {
            id: "@example/crashed-sandbox",
            version: "1.0.0",
            installationPath: sandboxRoot,
            browser: "dist/entry.js",
            publisherFingerprint: "a".repeat(64)
        },
        async () => undefined,
        () => {
            unexpectedExits++;
        }
    );
    await crashedHost.activate();
    const crashedSession = sessions[2];
    windows[2].destroy();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(unexpectedExits, 1);
    assert.equal(crashedSession.protocolRemoved, true);
    assert.equal(crashedSession.permissionCheckHandler, null);
    assert.equal(crashedSession.displayMediaRequestHandler, null);
    assert.equal(crashedSession.listenerCount("will-download"), 0);
    await fs.promises.rm(sandboxRoot, { recursive: true, force: true });
});

test("sandbox manager reconciles Home READY snapshots against disk", async () => {
    const managerIpc = new EventEmitter();
    const invokeHandlers = new Map();
    managerIpc.handle = (channel, handler) => {
        invokeHandlers.set(channel, handler);
    };
    managerIpc.removeHandler = channel => {
        invokeHandlers.delete(channel);
    };

    const homeWebContents = {};
    const outsiderWebContents = {};
    const extensionMap = new Map();
    const events = [];
    const diskPathIds = [];
    const revokedIds = [];
    const reloadIds = [];
    const inspectionBlocks = new Map();
    const activationBlocks = new Map();

    function extension(id, options = {}) {
        return {
            id,
            name: id,
            displayName: id,
            version: "1.0.0",
            extensionType: "extension-v1",
            installationFolderPath: `loaded:${id}`,
            manifest: { capabilities: [] },
            ...options
        };
    }

    extensionMap.set("installed.keep", extension("installed.keep"));
    extensionMap.set("installed.remove", extension("installed.remove"));
    extensionMap.set("broken.reload", extension("broken.reload"));
    extensionMap.set(
        "preinstalled.core",
        extension("preinstalled.core", { preInstalled: true })
    );
    extensionMap.set("legacy.payload", {
        id: "legacy.payload",
        extensionType: "instrument"
    });

    class FakeSandboxExtensionHost {
        constructor(options) {
            this.id = options.id;
        }

        async activate() {
            events.push(`activate:${this.id}`);
            const block = activationBlocks.get(this.id);
            if (block) {
                await block;
            }
        }

        async deactivate(reason) {
            events.push(`deactivate:${this.id}:${reason}`);
        }

        sendEvent(event) {
            events.push(`event:${this.id}:${event.type}:${event.commandId ?? ""}`);
        }
    }

    class FakePermissionManager {
        async revokeExtension(extensionId) {
            revokedIds.push(extensionId);
        }

        async isAuthorized() {
            return false;
        }
    }

    class FakeRendererServiceBroker {
        dispose() {}
    }

    const managerModule = requireWithMocks(
        path.join(projectRoot, "build/main/extensions-v1/manager.js"),
        {
            electron: { ipcMain: managerIpc },
            mobx: { action: callback => callback },
            "eez-studio-shared/extensions-v1": {
                isValidExtensionId(value) {
                    return (
                        typeof value === "string" &&
                        value.length <= 214 &&
                        /^(?:@[a-z0-9](?:[a-z0-9._-]{0,99})\/)?[a-z0-9](?:[a-z0-9._-]{0,212})$/.test(
                            value
                        )
                    );
                }
            },
            "eez-studio-shared/extensions/extensions": {
                extensions: extensionMap,
                async reloadExtensionV1(diskPath, expectedId) {
                    const extensionId = diskPath.slice("disk:".length);
                    assert.equal(expectedId, extensionId);
                    reloadIds.push(extensionId);
                    events.push(`reload:${extensionId}`);
                    if (extensionId === "broken.reload") {
                        throw new Error("broken extension package");
                    }
                    const reloaded = extension(
                        extensionId,
                        extensionId === "activation.wait"
                            ? {
                                  manifest: {
                                      capabilities: [],
                                      contributes: {
                                          homeSections: [
                                              {
                                                  commands: [
                                                      { id: "run", title: "Run" }
                                                  ]
                                              }
                                          ]
                                      }
                                  }
                              }
                            : undefined
                    );
                    extensionMap.set(extensionId, reloaded);
                    return reloaded;
                }
            },
            "eez-studio-shared/extensions/extension-folder": {
                getExtensionFolderPath(extensionId) {
                    diskPathIds.push(extensionId);
                    return `disk:${extensionId}`;
                }
            },
            "eez-studio-shared/extensions/extension-installation": {
                async inspectExtensionPackageStatic(diskPath) {
                    const extensionId = diskPath.slice("disk:".length);
                    events.push(`inspect:${extensionId}`);
                    const block = inspectionBlocks.get(extensionId);
                    if (block) {
                        await block;
                    }
                    return {
                        id: extensionId,
                        extensionType:
                            extensionId === "legacy.payload"
                                ? "instrument"
                                : "extension-v1"
                    };
                }
            },
            "main/home-window": {
                findHomeWindow: () => ({
                    browserWindow: { webContents: homeWebContents }
                })
            },
            "main/extensions-v1/permission-manager": {
                ExtensionPermissionManager: FakePermissionManager
            },
            "main/extensions-v1/renderer-service-broker": {
                RendererServiceBroker: FakeRendererServiceBroker
            },
            "main/extensions-v1/sandbox-host": {
                SandboxExtensionHost: FakeSandboxExtensionHost
            }
        }
    );
    const manager = managerModule.extensionV1Manager;

    async function emitReady(payload, sender = homeWebContents) {
        managerIpc.emit(READY_CHANNEL, { sender }, payload);
        const reconciliation = manager.readyReconciliation;
        if (reconciliation) {
            await reconciliation;
        } else {
            await new Promise(resolve => setImmediate(resolve));
        }
    }

    try {
        await manager.activateRegisteredExtensions();
        events.length = 0;

        const changeRequestHandler = invokeHandlers.get(CHANGE_REQUEST_CHANNEL);
        await assert.rejects(
            changeRequestHandler(
                { sender: homeWebContents },
                { extensionId: "../invalid", action: "install" }
            ),
            error => error.code === "INVALID_ARGUMENT"
        );

        await emitReady({
            extensionIds: [
                "installed.keep",
                "broken.reload",
                "missing.valid",
                "legacy.payload",
                "preinstalled.core"
            ],
            extensionPaths: {
                "installed.keep": "/renderer/controlled/path"
            }
        });

        assert.deepEqual(reloadIds, [
            "installed.keep",
            "broken.reload",
            "missing.valid"
        ]);
        assert.deepEqual(diskPathIds, [
            "installed.keep",
            "broken.reload",
            "missing.valid",
            "legacy.payload",
            "installed.keep",
            "broken.reload",
            "missing.valid"
        ]);
        assert.equal(extensionMap.has("missing.valid"), true);
        assert.equal(extensionMap.has("installed.remove"), false);
        assert.equal(extensionMap.get("legacy.payload").extensionType, "instrument");
        assert.equal(revokedIds.includes("installed.remove"), true);
        assert.equal(
            events.includes("deactivate:installed.remove:uninstall"),
            true
        );
        assert.equal(
            events.indexOf("reload:missing.valid") >
                events.indexOf("reload:broken.reload"),
            true
        );
        assert.equal(events.includes("activate:missing.valid"), true);
        assert.equal(events.includes("reload:legacy.payload"), false);
        assert.equal(diskPathIds.includes("preinstalled.core"), false);
        assert.equal(events.at(-1), "activate:preinstalled.core");

        events.length = 0;
        diskPathIds.length = 0;
        const invalidPayloads = [
            { extensionIds: ["../escape"] },
            { extensionIds: ["duplicate.id", "duplicate.id"] },
            {
                extensionIds: Array.from(
                    { length: 1025 },
                    (_value, index) => `oversized.${index}`
                )
            }
        ];
        await emitReady(
            { extensionIds: ["outsider.valid"] },
            outsiderWebContents
        );
        for (const payload of invalidPayloads) {
            await emitReady(payload);
        }
        assert.deepEqual(events, []);
        assert.deepEqual(diskPathIds, []);

        let releaseFirstInspection;
        const firstInspection = new Promise(resolve => {
            releaseFirstInspection = resolve;
        });
        inspectionBlocks.set("serial.one", firstInspection);
        managerIpc.emit(READY_CHANNEL, { sender: homeWebContents }, {
            extensionIds: ["serial.one"]
        });
        const firstReconciliation = manager.readyReconciliation;
        await new Promise(resolve => setImmediate(resolve));
        managerIpc.emit(READY_CHANNEL, { sender: homeWebContents }, {
            extensionIds: ["serial.two"]
        });
        const secondReconciliation = manager.readyReconciliation;

        await new Promise(resolve => setImmediate(resolve));
        assert.equal(events.includes("inspect:serial.one"), true);
        assert.equal(events.includes("inspect:serial.two"), false);
        releaseFirstInspection();
        await Promise.all([firstReconciliation, secondReconciliation]);

        const firstPreinstalledRestart = events.indexOf(
            "activate:preinstalled.core"
        );
        assert.equal(firstPreinstalledRestart >= 0, true);
        assert.equal(
            events.indexOf("inspect:serial.two") > firstPreinstalledRestart,
            true
        );

        let releaseActivation;
        activationBlocks.set(
            "activation.wait",
            new Promise(resolve => {
                releaseActivation = resolve;
            })
        );
        managerIpc.emit(READY_CHANNEL, { sender: homeWebContents }, {
            extensionIds: ["activation.wait"]
        });
        const activationReconciliation = manager.readyReconciliation;
        while (!events.includes("activate:activation.wait")) {
            await new Promise(resolve => setImmediate(resolve));
        }
        managerIpc.emit(
            COMMAND_CHANNEL,
            { sender: homeWebContents },
            { extensionId: "activation.wait", commandId: "run" }
        );
        assert.equal(
            events.includes("event:activation.wait:command:run"),
            false
        );
        releaseActivation();
        await activationReconciliation;
        assert.equal(
            events.includes("event:activation.wait:command:run"),
            true
        );

        let releaseDisposeInspection;
        const disposeInspection = new Promise(resolve => {
            releaseDisposeInspection = resolve;
        });
        inspectionBlocks.set("dispose.wait", disposeInspection);
        managerIpc.emit(READY_CHANNEL, { sender: homeWebContents }, {
            extensionIds: ["dispose.wait"]
        });
        await new Promise(resolve => setImmediate(resolve));

        let disposeCompleted = false;
        const shutdownHandler = invokeHandlers.get(SHUTDOWN_CHANNEL);
        await assert.rejects(
            shutdownHandler({ sender: outsiderWebContents }),
            error => error.code === "PERMISSION_DENIED"
        );
        const disposing = shutdownHandler({ sender: homeWebContents }).then(() => {
            disposeCompleted = true;
        });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(disposeCompleted, false);

        releaseDisposeInspection();
        await disposing;
        assert.equal(disposeCompleted, true);
        assert.equal(invokeHandlers.has(SHUTDOWN_CHANNEL), false);
    } finally {
        await manager.dispose();
    }
});

test("permission revocation invalidates pending prompts and unsigned grants stay ephemeral", async () => {
    const userData = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "eez-extension-permissions-")
    );
    let resolvePrompt;
    const dialog = {
        showMessageBox: () =>
            new Promise(resolve => {
                resolvePrompt = resolve;
            })
    };
    const permissionModule = requireWithMocks(
        path.join(projectRoot, "build/main/extensions-v1/permission-manager.js"),
        {
            electron: {
                app: { getPath: () => userData },
                dialog
            }
        }
    );

    try {
        const publisherFingerprint = "a".repeat(64);
        const malformedKey = JSON.stringify([
            "@example/permissions",
            `sha256:${publisherFingerprint}`,
            "project.read",
            "global"
        ]);
        await fs.promises.writeFile(
            path.join(userData, "extension-v1-grants.json"),
            JSON.stringify({ version: 1, grants: { [malformedKey]: false } }),
            "utf8"
        );
        const permissions = new permissionModule.ExtensionPermissionManager();
        assert.equal(
            await permissions.isAuthorized({
                extensionId: "@example/permissions",
                publisherKeyId: "publisher",
                publisherFingerprint,
                capability: "project.read",
                workspaceScope: "global"
            }),
            false
        );

        const pendingAuthorization = permissions.authorize({
            extensionId: "@example/permissions",
            extensionName: "Permissions",
            publisherKeyId: "publisher",
            publisherFingerprint,
            requestedCapabilities: ["project.read"],
            capability: "project.read",
            workspaceScope: "global"
        });
        await new Promise(resolve => setImmediate(resolve));
        await permissions.revokeExtension("@example/permissions");
        resolvePrompt({ response: 0 });
        await assert.rejects(
            pendingAuthorization,
            error => error.code === "PERMISSION_REVOKED"
        );
        assert.deepEqual(
            JSON.parse(
                await fs.promises.readFile(
                    path.join(userData, "extension-v1-grants.json"),
                    "utf8"
                )
            ).grants,
            {}
        );

        const persistedGrantKey = JSON.stringify([
            "@example/persisted",
            `sha256:${publisherFingerprint}`,
            "project.read",
            "global"
        ]);
        await fs.promises.writeFile(
            path.join(userData, "extension-v1-grants.json"),
            JSON.stringify({
                version: 1,
                grants: { [persistedGrantKey]: true }
            }),
            "utf8"
        );
        const persisted = new permissionModule.ExtensionPermissionManager();
        assert.equal(
            await persisted.isAuthorized({
                extensionId: "@example/persisted",
                publisherKeyId: "publisher",
                publisherFingerprint,
                capability: "project.read",
                workspaceScope: "global"
            }),
            true
        );
        assert.equal(
            await persisted.isAuthorized({
                extensionId: "@example/persisted",
                publisherKeyId: "publisher",
                publisherFingerprint: "b".repeat(64),
                capability: "project.read",
                workspaceScope: "global"
            }),
            false
        );

        dialog.showMessageBox = async () => ({ response: 0 });
        const unsigned = new permissionModule.ExtensionPermissionManager();
        await unsigned.authorize({
            extensionId: "@example/unsigned",
            extensionName: "Unsigned",
            requestedCapabilities: ["project.read"],
            capability: "project.read",
            workspaceScope: "global"
        });
        assert.equal(
            await unsigned.isAuthorized({
                extensionId: "@example/unsigned",
                capability: "project.read",
                workspaceScope: "global"
            }),
            true
        );
        const stored = JSON.parse(
            await fs.promises.readFile(
                path.join(userData, "extension-v1-grants.json"),
                "utf8"
            )
        );
        assert.equal(
            Object.keys(stored.grants).some(key =>
                key.includes("developer-unsigned")
            ),
            false
        );
    } finally {
        await fs.promises.rm(userData, { recursive: true, force: true });
    }
});
