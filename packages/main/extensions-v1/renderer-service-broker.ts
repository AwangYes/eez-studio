import { ipcMain } from "electron";
import crypto from "crypto";

import { findHomeWindow } from "main/home-window";

const REQUEST_CHANNEL = "eez-extension-v1/studio-request";
const RESPONSE_CHANNEL = "eez-extension-v1/studio-response";
const CANCEL_CHANNEL = "eez-extension-v1/studio-cancel";

interface PendingRequest {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
    abortListener?: () => void;
    signal: AbortSignal;
}

function brokerError(code: string, message: string) {
    const error = new Error(message) as Error & { code: string };
    error.code = code;
    return error;
}

export class RendererServiceBroker {
    private pending = new Map<string, PendingRequest>();
    private disposed = false;
    private observedRenderer: Electron.WebContents | undefined;
    private observedRendererCleanup: (() => void) | undefined;
    private readonly responseListener: (
        event: Electron.IpcMainEvent,
        payload: any
    ) => void;

    constructor() {
        this.responseListener = (event, payload) => {
            const homeWindow = findHomeWindow();
            if (event.sender !== homeWindow?.browserWindow.webContents) {
                return;
            }
            const pending = this.pending.get(payload?.requestId);
            if (!pending) {
                return;
            }
            this.pending.delete(payload.requestId);
            clearTimeout(pending.timer);
            if (pending.abortListener) {
                pending.signal.removeEventListener(
                    "abort",
                    pending.abortListener
                );
            }
            if (payload.error) {
                const error = new Error(
                    typeof payload.error.message === "string"
                        ? payload.error.message
                        : "Studio service failed"
                ) as Error & { code?: string };
                error.code =
                    typeof payload.error.code === "string"
                        ? payload.error.code
                        : "STUDIO_SERVICE_ERROR";
                pending.reject(error);
            } else {
                pending.resolve(payload.result);
            }
        };
        ipcMain.on(RESPONSE_CHANNEL, this.responseListener);
    }

    private observeRenderer(webContents: Electron.WebContents) {
        if (this.observedRenderer === webContents) {
            return;
        }
        this.observedRendererCleanup?.();
        this.observedRenderer = webContents;
        const rejectUnavailable = () => {
            if (this.observedRenderer !== webContents) {
                return;
            }
            this.observedRenderer = undefined;
            this.observedRendererCleanup?.();
            this.observedRendererCleanup = undefined;
            this.rejectPending(
                brokerError(
                    "STUDIO_SERVICE_ERROR",
                    "Studio renderer became unavailable"
                )
            );
        };
        const navigationListener = (
            _event: Electron.Event,
            _url: string,
            _isInPlace: boolean,
            isMainFrame: boolean
        ) => {
            if (isMainFrame) {
                rejectUnavailable();
            }
        };
        webContents.once("destroyed", rejectUnavailable);
        webContents.once("render-process-gone", rejectUnavailable);
        webContents.on("did-start-navigation", navigationListener);
        this.observedRendererCleanup = () => {
            webContents.removeListener("destroyed", rejectUnavailable);
            webContents.removeListener("render-process-gone", rejectUnavailable);
            webContents.removeListener(
                "did-start-navigation",
                navigationListener
            );
        };
    }

    private rejectPending(error: Error) {
        for (const [requestId, pending] of this.pending) {
            clearTimeout(pending.timer);
            if (pending.abortListener) {
                pending.signal.removeEventListener(
                    "abort",
                    pending.abortListener
                );
            }
            pending.reject(error);
            this.pending.delete(requestId);
        }
    }

    dispatch(
        extensionId: string,
        service: string,
        method: string,
        args: unknown,
        signal: AbortSignal,
        timeoutMs = 120000
    ) {
        if (this.disposed) {
            return Promise.reject(
                brokerError("CANCELLED", "Studio service broker is disposed")
            );
        }
        if (signal.aborted) {
            return Promise.reject(
                brokerError("CANCELLED", "Studio service request cancelled")
            );
        }
        const homeWindow = findHomeWindow();
        if (!homeWindow || homeWindow.browserWindow.isDestroyed()) {
            return Promise.reject(
                brokerError(
                    "STUDIO_SERVICE_ERROR",
                    "Studio home window is unavailable"
                )
            );
        }
        this.observeRenderer(homeWindow.browserWindow.webContents);
        const requestId = crypto.randomUUID();
        return new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                const pending = this.pending.get(requestId);
                if (!pending) {
                    return;
                }
                this.pending.delete(requestId);
                signal.removeEventListener("abort", abortListener);
                if (!homeWindow.browserWindow.webContents.isDestroyed()) {
                    homeWindow.browserWindow.webContents.send(CANCEL_CHANNEL, {
                        requestId,
                        reason: "deadline"
                    });
                }
                reject(
                    brokerError(
                        "DEADLINE_EXCEEDED",
                        `Studio service timed out after ${timeoutMs} ms`
                    )
                );
            }, timeoutMs);
            const abortListener = () => {
                const pending = this.pending.get(requestId);
                if (!pending) {
                    return;
                }
                this.pending.delete(requestId);
                clearTimeout(timer);
                if (!homeWindow.browserWindow.webContents.isDestroyed()) {
                    homeWindow.browserWindow.webContents.send(CANCEL_CHANNEL, {
                        requestId,
                        reason: String(signal.reason ?? "cancelled")
                    });
                }
                reject(
                    brokerError(
                        "CANCELLED",
                        "Studio service request cancelled"
                    )
                );
            };
            signal.addEventListener("abort", abortListener, { once: true });
            this.pending.set(requestId, {
                resolve,
                reject,
                timer,
                abortListener,
                signal
            });
            try {
                homeWindow.browserWindow.webContents.send(REQUEST_CHANNEL, {
                    requestId,
                    extensionId,
                    service,
                    method,
                    args,
                    deadline: Date.now() + timeoutMs
                });
            } catch (error) {
                this.pending.delete(requestId);
                clearTimeout(timer);
                signal.removeEventListener("abort", abortListener);
                reject(error);
            }
        });
    }

    dispose(reason = "Studio service broker disposed") {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.rejectPending(brokerError("CANCELLED", reason));
        this.observedRendererCleanup?.();
        this.observedRendererCleanup = undefined;
        this.observedRenderer = undefined;
        ipcMain.removeListener(RESPONSE_CHANNEL, this.responseListener);
    }
}
