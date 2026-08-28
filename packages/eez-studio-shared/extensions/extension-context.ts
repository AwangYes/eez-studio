import type {
    Disposable,
    ExtensionApiVersion,
    ExtensionContext,
    ExtensionLogger,
    ExtensionMode,
    ExtensionSecrets,
    ExtensionServiceDescriptor,
    ExtensionServiceHandler,
    ExtensionServiceRegistry,
    ExtensionServiceRequest,
    ExtensionServiceResponse,
    ExtensionStorage
} from "eez-studio-types";
import {
    EXTENSION_CLEANUP_TIMEOUT_MS,
    runExtensionLifecycleOperation
} from "./extension-lifecycle";

type AnyServiceHandler = ExtensionServiceHandler<unknown, unknown>;

const extensionStorage = new Map<string, Map<string, unknown>>();
const extensionSecrets = new Map<string, Map<string, string>>();
const serviceHandlers = new Map<string, AnyServiceHandler>();

function serviceKey(descriptor: ExtensionServiceDescriptor) {
    return `${descriptor.service}:${descriptor.method}`;
}

function createDisposable(dispose: () => void | Promise<void>): Disposable {
    let isDisposed = false;

    return {
        async dispose() {
            if (isDisposed) {
                return;
            }
            isDisposed = true;
            await dispose();
        }
    };
}

class MemoryStorage implements ExtensionStorage {
    constructor(private values: Map<string, unknown>) {}

    async get<T>(key: string, defaultValue?: T) {
        return this.values.has(key)
            ? (this.values.get(key) as T)
            : defaultValue;
    }

    async update(key: string, value: unknown) {
        this.values.set(key, value);
    }

    async delete(key: string) {
        this.values.delete(key);
    }

    async keys() {
        return Array.from(this.values.keys());
    }
}

class MemorySecrets implements ExtensionSecrets {
    constructor(private values: Map<string, string>) {}

    async get(key: string) {
        return this.values.get(key);
    }

    async store(key: string, value: string) {
        this.values.set(key, value);
    }

    async delete(key: string) {
        this.values.delete(key);
    }

    async keys() {
        return Array.from(this.values.keys());
    }
}

class ScopedServiceRegistry implements ExtensionServiceRegistry {
    constructor(private subscriptions: Disposable[]) {}

    register<TParams, TResult>(
        descriptor: ExtensionServiceDescriptor,
        handler: ExtensionServiceHandler<TParams, TResult>
    ) {
        const key = serviceKey(descriptor);
        if (serviceHandlers.has(key)) {
            throw new Error(`Extension service already registered: ${key}`);
        }

        serviceHandlers.set(key, handler as AnyServiceHandler);
        const disposable = createDisposable(() => {
            if (serviceHandlers.get(key) === handler) {
                serviceHandlers.delete(key);
            }
        });
        this.subscriptions.push(disposable);
        return disposable;
    }

    async request<TParams, TResult>(
        request: ExtensionServiceRequest<TParams>,
        signal: AbortSignal = new AbortController().signal
    ): Promise<ExtensionServiceResponse<TResult>> {
        const handler = serviceHandlers.get(serviceKey(request));
        if (!handler) {
            return {
                requestId: request.requestId,
                ok: false,
                error: {
                    code: "SERVICE_NOT_FOUND",
                    message: `Extension service not found: ${serviceKey(
                        request
                    )}`
                }
            };
        }

        if (signal.aborted) {
            return {
                requestId: request.requestId,
                ok: false,
                error: {
                    code: "REQUEST_ABORTED",
                    message: "Extension service request was aborted"
                }
            };
        }

        try {
            const result = await handler(
                request as ExtensionServiceRequest<unknown>,
                signal
            );
            return {
                requestId: request.requestId,
                ok: true,
                result: result as TResult
            };
        } catch (err) {
            return {
                requestId: request.requestId,
                ok: false,
                error: {
                    code: "SERVICE_ERROR",
                    message: err instanceof Error ? err.message : String(err)
                }
            };
        }
    }
}

function getMode(): ExtensionMode {
    if (process.env.NODE_ENV == "development") {
        return "development";
    }
    if (process.env.NODE_ENV == "test") {
        return "test";
    }
    return "production";
}

function createLogger(extensionId: string): ExtensionLogger {
    const prefix = `[extension:${extensionId}]`;
    return {
        trace: (message, ...args) => console.trace(prefix, message, ...args),
        debug: (message, ...args) => console.debug(prefix, message, ...args),
        info: (message, ...args) => console.info(prefix, message, ...args),
        warn: (message, ...args) => console.warn(prefix, message, ...args),
        error: (message, ...args) => console.error(prefix, message, ...args)
    };
}

export class ManagedExtensionContext implements ExtensionContext {
    readonly mode = getMode();
    readonly log: ExtensionLogger;
    readonly storage: ExtensionStorage;
    readonly secrets: ExtensionSecrets;
    readonly subscriptions: Disposable[] = [];
    readonly services: ExtensionServiceRegistry;

    private abortController = new AbortController();
    private isDisposed = false;

    constructor(
        readonly id: string,
        readonly version: string,
        readonly apiVersion: ExtensionApiVersion
    ) {
        this.log = createLogger(id);

        let storage = extensionStorage.get(id);
        if (!storage) {
            storage = new Map<string, unknown>();
            extensionStorage.set(id, storage);
        }
        this.storage = new MemoryStorage(storage);

        let secrets = extensionSecrets.get(id);
        if (!secrets) {
            secrets = new Map<string, string>();
            extensionSecrets.set(id, secrets);
        }
        this.secrets = new MemorySecrets(secrets);
        this.services = new ScopedServiceRegistry(this.subscriptions);
    }

    get signal() {
        return this.abortController.signal;
    }

    abort() {
        this.abortController.abort();
    }

    async dispose(timeoutMs = EXTENSION_CLEANUP_TIMEOUT_MS) {
        if (this.isDisposed) {
            return;
        }
        this.isDisposed = true;
        this.abort();

        const subscriptions = this.subscriptions.splice(0).reverse();
        await Promise.all(
            subscriptions.map(async (subscription, index) => {
                try {
                    await runExtensionLifecycleOperation(
                        this.id,
                        `subscription cleanup ${index + 1}`,
                        timeoutMs,
                        () => subscription.dispose()
                    );
                } catch (err) {
                    this.log.error(
                        "Failed to dispose extension subscription",
                        err
                    );
                }
            })
        );
    }
}
