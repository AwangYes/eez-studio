import { BrowserWindow, ipcMain, session, WebContents } from "electron";
import crypto from "crypto";
import fs from "fs";
import path from "path";

import {
    EXTENSION_SIGNATURE_FILE,
    TRUSTED_EXTENSION_PUBLISHERS,
    verifyExtensionPackageSignature
} from "eez-studio-shared/extensions-v1";

import { EXTENSION_SCHEME } from "main/extensions-v1/protocol";

const REQUEST_CHANNEL = "eez-extension-v1/request";
const RESPONSE_CHANNEL = "eez-extension-v1/response";
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export interface SandboxExtensionDescriptor {
    id: string;
    version: string;
    installationPath: string;
    browser: string;
    allowedOrigins?: readonly string[];
    publisherFingerprint?: string;
}

export interface ExtensionServiceRequest {
    extensionId: string;
    instanceId: string;
    service: string;
    method: string;
    args: unknown;
    signal: AbortSignal;
}

export type ExtensionServiceDispatcher = (
    request: ExtensionServiceRequest
) => Promise<unknown>;

interface SandboxRequestPayload {
    instanceId: string;
    requestId: number;
    service: string;
    method: string;
    args: unknown;
}

function resolvedInside(root: string, candidate: string) {
    const resolvedRoot = path.resolve(root);
    const resolvedCandidate = path.resolve(root, candidate);
    return (
        resolvedCandidate === resolvedRoot ||
        resolvedCandidate.startsWith(resolvedRoot + path.sep)
    );
}

function timeout<T>(promise: Promise<T>, timeoutMs: number, label: string) {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`${label} timed out after ${timeoutMs} ms`)),
            timeoutMs
        );
        promise.then(
            value => {
                clearTimeout(timer);
                resolve(value);
            },
            error => {
                clearTimeout(timer);
                reject(error);
            }
        );
    });
}

function sendResponse(
    sender: WebContents,
    requestId: number,
    response: { result?: unknown; error?: { code: string; message: string } }
) {
    if (!sender.isDestroyed()) {
        sender.send(RESPONSE_CHANNEL, { requestId, ...response });
    }
}

function sendResult(sender: WebContents, requestId: number, result: unknown) {
    try {
        const serialized = JSON.stringify(result);
        if (
            serialized !== undefined &&
            Buffer.byteLength(serialized, "utf8") > MAX_RESPONSE_BYTES
        ) {
            sendResponse(sender, requestId, {
                error: {
                    code: "RESPONSE_TOO_LARGE",
                    message: "Studio service response exceeds 16 MiB"
                }
            });
            return;
        }
    } catch {
        sendResponse(sender, requestId, {
            error: {
                code: "SERVICE_ERROR",
                message: "Studio service response must be JSON data"
            }
        });
        return;
    }
    sendResponse(sender, requestId, { result });
}

function normalizeAllowedOrigins(origins: readonly string[] | undefined) {
    return new Set(
        (origins ?? []).map(origin => {
            const url = new URL(origin);
            if (url.protocol !== "https:" || url.origin !== origin) {
                throw new Error(
                    `Extension network origin must be an exact HTTPS origin: ${origin}`
                );
            }
            return origin;
        })
    );
}

function isDeveloperModeEnabled() {
    return (
        process.env.EEZ_STUDIO_EXTENSION_DEVELOPER_MODE == "1" ||
        process.argv.includes("--extension-developer-mode")
    );
}

async function collectUnsignedIntegrity(
    root: string,
    relative = "",
    files = new Map<string, string>()
) {
    const directory = path.join(root, relative);
    for (const entry of await fs.promises.readdir(directory, {
        withFileTypes: true
    })) {
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            await collectUnsignedIntegrity(root, child, files);
        } else if (entry.isFile()) {
            const content = await fs.promises.readFile(path.join(root, child));
            files.set(
                child,
                crypto.createHash("sha256").update(content).digest("hex")
            );
        } else {
            throw new Error(`Unsupported extension package entry: ${child}`);
        }
    }
    return files;
}

function contentType(filePath: string) {
    switch (path.extname(filePath).toLowerCase()) {
        case ".js":
        case ".mjs":
            return "text/javascript; charset=utf-8";
        case ".json":
            return "application/json; charset=utf-8";
        case ".css":
            return "text/css; charset=utf-8";
        case ".wasm":
            return "application/wasm";
        case ".svg":
            return "image/svg+xml";
        case ".png":
            return "image/png";
        case ".jpg":
        case ".jpeg":
            return "image/jpeg";
        case ".gif":
            return "image/gif";
        case ".webp":
            return "image/webp";
        default:
            return "application/octet-stream";
    }
}

export class SandboxExtensionHost {
    private window: BrowserWindow | undefined;
    private extensionSession: Electron.Session | undefined;
    private readonly instanceId = crypto.randomBytes(24).toString("hex");
    private readonly abortController = new AbortController();
    private inFlightRequests = 0;
    private deactivated = false;
    private integrityInvalidated = false;
    private runtimeIntegrity = new Map<string, string>();
    private protocolRegistered = false;
    private deactivateCallback:
        | ((reason: string) => Promise<void>)
        | undefined;
    private downloadListener:
        | ((event: Electron.Event) => void)
        | undefined;
    private requestListener:
        | ((event: Electron.IpcMainEvent, payload: any) => void)
        | undefined;

    constructor(
        private readonly descriptor: SandboxExtensionDescriptor,
        private readonly dispatch: ExtensionServiceDispatcher,
        private readonly onUnexpectedExit?: () => void
    ) {}

    async activate() {
        if (this.window) {
            return;
        }
        if (this.deactivated) {
            throw new Error("A disposed extension host cannot be reactivated");
        }

        const partition = `eez-extension-v1-${this.instanceId}`;
        const extensionSession = session.fromPartition(partition, {
            cache: false
        });
        this.extensionSession = extensionSession;
        extensionSession.setPermissionCheckHandler(() => false);
        extensionSession.setPermissionRequestHandler(
            (_webContents, _permission, callback) => callback(false)
        );
        extensionSession.setDevicePermissionHandler(() => false);
        extensionSession.setDisplayMediaRequestHandler(
            (_request, callback) => callback({})
        );
        this.downloadListener = event => event.preventDefault();
        extensionSession.on("will-download", this.downloadListener);
        const root = path.resolve(this.descriptor.installationPath);
        const realRoot = fs.realpathSync(root);
        const entry = this.descriptor.browser.replace(/\\/g, "/");
        if (!resolvedInside(root, entry)) {
            throw new Error("Extension browser entry escapes installation root");
        }
        const allowedOrigins = normalizeAllowedOrigins(
            this.descriptor.allowedOrigins
        );
        try {
            const verification = await verifyExtensionPackageSignature(root, {
                source: "local",
                developerMode: isDeveloperModeEnabled(),
                trustedKeys: TRUSTED_EXTENSION_PUBLISHERS
            });
            if (verification.signed) {
                if (
                    verification.publisherFingerprint !==
                    this.descriptor.publisherFingerprint
                ) {
                    throw new Error(
                        "Extension publisher identity changed before activation"
                    );
                }
                this.runtimeIntegrity = new Map(Object.entries(verification.files));
            } else {
                if (this.descriptor.publisherFingerprint != undefined) {
                    throw new Error(
                        "Signed extension became unsigned before activation"
                    );
                }
                this.runtimeIntegrity = await collectUnsignedIntegrity(root);
                this.runtimeIntegrity.delete(EXTENSION_SIGNATURE_FILE);
            }
        } catch (error) {
            await this.deactivate("activation-error");
            throw error;
        }

        await extensionSession.protocol.handle(EXTENSION_SCHEME, async request => {
            const url = new URL(request.url);
            if (url.hostname !== this.instanceId) {
                return new Response("Forbidden", { status: 403 });
            }
            let requestedPath: string;
            try {
                requestedPath = decodeURIComponent(url.pathname).replace(
                    /^\/+/,
                    ""
                );
            } catch {
                return new Response("Bad request", { status: 400 });
            }
            if (requestedPath === "__host.html") {
                return new Response(
                    '<!doctype html><meta charset="utf-8">',
                    {
                        headers: {
                            "Content-Type": "text/html; charset=utf-8",
                            "Cache-Control": "no-store"
                        }
                    }
                );
            }
            if (!resolvedInside(root, requestedPath)) {
                return new Response("Forbidden", { status: 403 });
            }
            const filePath = path.resolve(root, requestedPath);
            let realFilePath: string;
            try {
                const fileStat = fs.lstatSync(filePath);
                if (!fileStat.isFile()) {
                    return new Response("Not found", { status: 404 });
                }
                realFilePath = fs.realpathSync(filePath);
            } catch {
                return new Response("Not found", { status: 404 });
            }
            if (!resolvedInside(realRoot, realFilePath)) {
                return new Response("Forbidden", { status: 403 });
            }
            const expectedDigest = this.runtimeIntegrity.get(requestedPath);
            if (!expectedDigest) {
                this.invalidateIntegrity(
                    `Extension requested an unverified file: ${requestedPath}`
                );
                return new Response("Extension package integrity changed", {
                    status: 409
                });
            }
            let content: Buffer;
            try {
                content = await fs.promises.readFile(realFilePath);
            } catch {
                this.invalidateIntegrity(
                    `Extension file disappeared: ${requestedPath}`
                );
                return new Response("Extension package integrity changed", {
                    status: 409
                });
            }
            const actualDigest = crypto
                .createHash("sha256")
                .update(content)
                .digest("hex");
            if (actualDigest !== expectedDigest) {
                this.invalidateIntegrity(
                    `Extension file integrity check failed: ${requestedPath}`
                );
                return new Response("Extension package integrity changed", {
                    status: 409
                });
            }
            return new Response(new Uint8Array(content), {
                headers: {
                    "Content-Type": contentType(realFilePath),
                    "Cache-Control": "no-store"
                }
            });
        });
        this.protocolRegistered = true;

        extensionSession.webRequest.onBeforeRequest((details, callback) => {
            let url: URL;
            try {
                url = new URL(details.url);
            } catch {
                callback({ cancel: true });
                return;
            }
            if (
                (url.protocol === `${EXTENSION_SCHEME}:` &&
                    url.hostname === this.instanceId) ||
                (url.protocol === "https:" && allowedOrigins.has(url.origin))
            ) {
                callback({});
            } else {
                callback({ cancel: true });
            }
        });
        extensionSession.webRequest.onHeadersReceived((details, callback) => {
            callback({
                responseHeaders: {
                    ...details.responseHeaders,
                    "Content-Security-Policy": [
                        `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src ${[
                            ...allowedOrigins
                        ].join(" ") || "'none'"}`
                    ]
                }
            });
        });

        this.requestListener = (event, untrustedPayload) => {
            const payload = untrustedPayload as SandboxRequestPayload;
            if (
                !this.window ||
                event.sender !== this.window.webContents ||
                payload?.instanceId !== this.instanceId ||
                !Number.isSafeInteger(payload?.requestId) ||
                payload.requestId < 0 ||
                typeof payload?.service !== "string" ||
                payload.service.length == 0 ||
                payload.service.length > 128 ||
                typeof payload?.method !== "string" ||
                payload.method.length == 0 ||
                payload.method.length > 128
            ) {
                return;
            }
            if (payload.service.startsWith("$")) {
                sendResponse(event.sender, payload.requestId, {
                    error: {
                        code: "SERVICE_NOT_FOUND",
                        message: "Reserved extension service"
                    }
                });
                return;
            }
            let argsBytes: number;
            try {
                argsBytes = Buffer.byteLength(JSON.stringify(payload.args), "utf8");
            } catch {
                sendResponse(event.sender, payload.requestId, {
                    error: {
                        code: "INVALID_ARGUMENT",
                        message: "Extension request arguments must be JSON data"
                    }
                });
                return;
            }
            if (argsBytes > MAX_REQUEST_BYTES || this.inFlightRequests >= 64) {
                sendResponse(event.sender, payload.requestId, {
                    error: {
                        code:
                            argsBytes > MAX_REQUEST_BYTES
                                ? "REQUEST_TOO_LARGE"
                                : "TOO_MANY_REQUESTS",
                        message:
                            argsBytes > MAX_REQUEST_BYTES
                                ? "Extension request exceeds 1 MiB"
                                : "Extension request concurrency limit exceeded"
                    }
                });
                return;
            }
            this.inFlightRequests++;
            this.dispatch({
                extensionId: this.descriptor.id,
                instanceId: this.instanceId,
                service: payload.service,
                method: payload.method,
                args: payload.args,
                signal: this.abortController.signal
            }).then(
                result => sendResult(event.sender, payload.requestId, result),
                error =>
                    sendResponse(event.sender, payload.requestId, {
                        error: {
                            code: (error as any)?.code ?? "SERVICE_ERROR",
                            message:
                                error instanceof Error
                                    ? error.message.slice(0, 4096)
                                    : String(error).slice(0, 4096)
                        }
                    })
            ).finally(() => {
                this.inFlightRequests--;
            });
        };
        ipcMain.on(REQUEST_CHANNEL, this.requestListener);

        try {
            this.window = new BrowserWindow({
                show: false,
                webPreferences: {
                    sandbox: true,
                    contextIsolation: true,
                    nodeIntegration: false,
                    webSecurity: true,
                    webviewTag: false,
                    partition,
                    preload: path.join(__dirname, "sandbox-preload.js"),
                    additionalArguments: [
                        `--eez-extension-instance=${this.instanceId}`
                    ]
                }
            });
            this.window.webContents.setWindowOpenHandler(() => ({
                action: "deny"
            }));
            this.window.once("closed", () => {
                if (this.deactivated) {
                    return;
                }
                void this.deactivate("activation-error")
                    .catch(error => {
                        console.error(
                            `Failed to clean up crashed sandbox extension ${this.descriptor.id}`,
                            error
                        );
                    })
                    .finally(() => this.onUnexpectedExit?.());
            });
            this.window.webContents.on("will-navigate", event => {
                event.preventDefault();
            });
            await timeout(
                this.window.loadURL(
                    `${EXTENSION_SCHEME}://${this.instanceId}/__host.html`
                ),
                10000,
                "Extension load"
            );
            const entryUrl = `${EXTENSION_SCHEME}://${this.instanceId}/${entry
                .split("/")
                .map(segment => encodeURIComponent(segment))
                .join("/")}`;
            const webContents = this.window.webContents;
            const hasDeactivate = await timeout(
                webContents.executeJavaScript(
                    `(async () => {\n` +
                        `const extension = await import(${JSON.stringify(entryUrl)});\n` +
                        `if (typeof extension.activate !== "function") {\n` +
                        `throw new Error("Extension module must export activate(host)");\n` +
                        `}\n` +
                        `await extension.activate(window.eezExtensionHost);\n` +
                        `return typeof extension.deactivate === "function";\n` +
                        `})()`,
                    true
                ),
                10000,
                "Extension activation"
            );
            if (hasDeactivate === true) {
                this.deactivateCallback = async reason => {
                    await webContents.executeJavaScript(
                        `(async () => {\n` +
                            `const extension = await import(${JSON.stringify(entryUrl)});\n` +
                            `await extension.deactivate(${JSON.stringify(reason)});\n` +
                            `})()`,
                        true
                    );
                };
            }
        } catch (error) {
            await this.deactivate("activation-error");
            throw error;
        }
    }

    sendEvent(event: unknown) {
        if (this.window && !this.window.webContents.isDestroyed()) {
            this.window.webContents.send("eez-extension-v1/event", event);
        }
    }

    private invalidateIntegrity(message: string) {
        if (this.integrityInvalidated || this.deactivated) {
            return;
        }
        this.integrityInvalidated = true;
        console.error(`${message}; terminating ${this.descriptor.id}`);
        void this.deactivate("integrity-error")
            .catch(error => {
                console.error(
                    `Failed to stop integrity-invalid extension ${this.descriptor.id}`,
                    error
                );
            })
            .finally(() => this.onUnexpectedExit?.());
    }

    async deactivate(reason: string) {
        if (this.deactivated) {
            return;
        }
        this.deactivated = true;
        const window = this.window;
        const deactivateCallback = this.deactivateCallback;
        this.deactivateCallback = undefined;
        if (
            deactivateCallback &&
            window &&
            !window.webContents.isDestroyed()
        ) {
            try {
                await timeout(
                    deactivateCallback(reason),
                    3000,
                    "Extension deactivation"
                );
            } catch (error) {
                console.warn(
                    `Sandbox extension ${this.descriptor.id} did not deactivate cleanly`,
                    error
                );
            }
        }
        this.abortController.abort(reason);
        this.window = undefined;
        if (this.requestListener) {
            ipcMain.removeListener(REQUEST_CHANNEL, this.requestListener);
            this.requestListener = undefined;
        }
        if (window && !window.isDestroyed()) {
            window.destroy();
        }
        const extensionSession = this.extensionSession;
        this.extensionSession = undefined;
        if (extensionSession) {
            extensionSession.setPermissionCheckHandler(null);
            extensionSession.setPermissionRequestHandler(null);
            extensionSession.setDevicePermissionHandler(null);
            extensionSession.setDisplayMediaRequestHandler(null);
            extensionSession.webRequest.onBeforeRequest(null);
            extensionSession.webRequest.onHeadersReceived(null);
            if (this.downloadListener) {
                extensionSession.removeListener(
                    "will-download",
                    this.downloadListener
                );
            }
            this.downloadListener = undefined;
            if (this.protocolRegistered) {
                await extensionSession.protocol.unhandle(EXTENSION_SCHEME);
                this.protocolRegistered = false;
            }
        }
    }

    owns(webContents: WebContents) {
        return this.window?.webContents === webContents;
    }
}
