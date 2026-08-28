import { ipcRenderer } from "electron";

const REQUEST_CHANNEL = "eez-extension-v1/studio-request";
const RESPONSE_CHANNEL = "eez-extension-v1/studio-response";
const CANCEL_CHANNEL = "eez-extension-v1/studio-cancel";
const READY_CHANNEL = "eez-extension-v1/studio-ready";

export interface StudioServiceRequest {
    extensionId: string;
    service: string;
    method: string;
    args: unknown;
    deadline: number;
    signal: AbortSignal;
}

export type StudioServiceHandler = (
    request: StudioServiceRequest
) => Promise<unknown>;

export class StudioExtensionServiceHost {
    private handlers = new Map<string, StudioServiceHandler>();
    private requests = new Map<string, AbortController>();

    private readonly requestListener = async (
        _event: Electron.IpcRendererEvent,
        payload: any
    ) => {
        const handler = this.handlers.get(payload?.service);
        if (!handler || typeof payload?.requestId !== "string") {
            ipcRenderer.send(RESPONSE_CHANNEL, {
                requestId: payload?.requestId,
                error: {
                    code: "SERVICE_NOT_FOUND",
                    message: `Unknown extension service: ${payload?.service}`
                }
            });
            return;
        }
        if (payload.deadline <= Date.now()) {
            ipcRenderer.send(RESPONSE_CHANNEL, {
                requestId: payload.requestId,
                error: {
                    code: "DEADLINE_EXCEEDED",
                    message: "Request expired before execution"
                }
            });
            return;
        }
        const abortController = new AbortController();
        this.requests.set(payload.requestId, abortController);
        try {
            const result = await handler({
                extensionId: payload.extensionId,
                service: payload.service,
                method: payload.method,
                args: payload.args,
                deadline: payload.deadline,
                signal: abortController.signal
            });
            if (!abortController.signal.aborted) {
                ipcRenderer.send(RESPONSE_CHANNEL, {
                    requestId: payload.requestId,
                    result
                });
            }
        } catch (error) {
            if (!abortController.signal.aborted) {
                ipcRenderer.send(RESPONSE_CHANNEL, {
                    requestId: payload.requestId,
                    error: {
                        code: (error as any)?.code ?? "INTERNAL",
                        message:
                            error instanceof Error
                                ? error.message
                                : "Studio service failed"
                    }
                });
            }
        } finally {
            this.requests.delete(payload.requestId);
        }
    };

    private readonly cancelListener = (
        _event: Electron.IpcRendererEvent,
        payload: any
    ) => {
        this.requests
            .get(payload?.requestId)
            ?.abort(payload?.reason ?? "cancelled");
    };

    constructor() {
        ipcRenderer.on(REQUEST_CHANNEL, this.requestListener);
        ipcRenderer.on(CANCEL_CHANNEL, this.cancelListener);
    }

    register(service: string, handler: StudioServiceHandler) {
        if (this.handlers.has(service)) {
            throw new Error(`Studio extension service already registered: ${service}`);
        }
        this.handlers.set(service, handler);
        return () => this.handlers.delete(service);
    }

    markReady(extensionIds: readonly string[]) {
        ipcRenderer.send(READY_CHANNEL, {
            extensionIds: Array.from(extensionIds)
        });
    }

    dispose() {
        for (const request of this.requests.values()) {
            request.abort("Studio extension service host disposed");
        }
        this.requests.clear();
        this.handlers.clear();
        ipcRenderer.removeListener(REQUEST_CHANNEL, this.requestListener);
        ipcRenderer.removeListener(CANCEL_CHANNEL, this.cancelListener);
    }
}

export const studioExtensionServiceHost = new StudioExtensionServiceHost();
