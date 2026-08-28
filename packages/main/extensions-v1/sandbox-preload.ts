import { contextBridge, ipcRenderer } from "electron";

const instanceId = process.argv
    .find(arg => arg.startsWith("--eez-extension-instance="))
    ?.substring("--eez-extension-instance=".length);

if (!instanceId) {
    throw new Error("Missing extension instance identity");
}

const REQUEST_CHANNEL = "eez-extension-v1/request";
const RESPONSE_CHANNEL = "eez-extension-v1/response";
const EVENT_CHANNEL = "eez-extension-v1/event";

let nextRequestId = 1;
const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(reason: Error): void }
>();
const eventListeners = new Set<(event: unknown) => void>();

function requirePublicRequest(service: string, method: string) {
    if (
        typeof service !== "string" ||
        service.length == 0 ||
        service.length > 128 ||
        service.startsWith("$")
    ) {
        throw new Error("Reserved extension service");
    }
    if (
        typeof method !== "string" ||
        method.length == 0 ||
        method.length > 128
    ) {
        throw new Error("Invalid extension service method");
    }
}

ipcRenderer.on(
    RESPONSE_CHANNEL,
    (
        _event,
        response: {
            requestId: number;
            result?: unknown;
            error?: { code: string; message: string };
        }
    ) => {
        const request = pending.get(response.requestId);
        if (!request) {
            return;
        }
        pending.delete(response.requestId);
        if (response.error) {
            const error = new Error(response.error.message) as Error & {
                code?: string;
            };
            error.code = response.error.code;
            request.reject(error);
        } else {
            request.resolve(response.result);
        }
    }
);

ipcRenderer.on(EVENT_CHANNEL, (_event, event: unknown) => {
    for (const listener of eventListeners) {
        listener(event);
    }
});

function requestSecureStorage(method: string, args: unknown) {
    requirePublicRequest("storage", method);
    const requestId = nextRequestId++;
    return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        ipcRenderer.send(REQUEST_CHANNEL, {
            instanceId,
            requestId,
            service: "storage",
            method,
            args
        });
    });
}

contextBridge.exposeInMainWorld("eezExtensionHost", {
    instanceId,
    request(service: string, method: string, args: unknown) {
        requirePublicRequest(service, method);
        const requestId = nextRequestId++;
        return new Promise((resolve, reject) => {
            pending.set(requestId, { resolve, reject });
            ipcRenderer.send(REQUEST_CHANNEL, {
                instanceId,
                requestId,
                service,
                method,
                args
            });
        });
    },
    notify(service: string, method: string, args: unknown) {
        requirePublicRequest(service, method);
        ipcRenderer.send(REQUEST_CHANNEL, {
            instanceId,
            requestId: 0,
            service,
            method,
            args
        });
    },
    secrets: {
        async get(key: string) {
            const result = (await requestSecureStorage("get", { key })) as {
                value?: string;
            };
            return result.value;
        },
        async store(key: string, value: string) {
            await requestSecureStorage("store", { key, value });
        },
        async delete(key: string) {
            await requestSecureStorage("delete", { key });
        },
        async keys() {
            const result = (await requestSecureStorage("keys", {})) as {
                keys: string[];
            };
            return result.keys;
        }
    },
    subscribe(listener: (event: unknown) => void) {
        if (typeof listener !== "function") {
            throw new TypeError("Extension event listener must be a function");
        }
        eventListeners.add(listener);
        return () => eventListeners.delete(listener);
    }
});
