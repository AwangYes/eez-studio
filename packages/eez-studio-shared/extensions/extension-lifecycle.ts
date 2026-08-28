export const EXTENSION_ACTIVATION_TIMEOUT_MS = 10000;
export const EXTENSION_CLEANUP_TIMEOUT_MS = 3000;

export class ExtensionLifecycleTimeoutError extends Error {
    readonly code = "EXTENSION_LIFECYCLE_TIMEOUT";

    constructor(
        readonly extensionId: string,
        readonly phase: string,
        readonly timeoutMs: number
    ) {
        super(
            `Extension ${extensionId} ${phase} timed out after ${timeoutMs} ms`
        );
        this.name = "ExtensionLifecycleTimeoutError";
    }
}

export function runExtensionLifecycleOperation<T>(
    extensionId: string,
    phase: string,
    timeoutMs: number,
    operation: () => T | Promise<T>
) {
    const operationPromise = Promise.resolve().then(operation);
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(
            () =>
                reject(
                    new ExtensionLifecycleTimeoutError(
                        extensionId,
                        phase,
                        timeoutMs
                    )
                ),
            timeoutMs
        );
        operationPromise.then(
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

/** Coordinates cleanup by extension object identity, not extension ID. */
export class ExtensionLifecycleCoordinator {
    private cleanupTasks = new WeakMap<object, Promise<void>>();

    cleanupOnce(target: object, cleanup: () => void | Promise<void>) {
        const existing = this.cleanupTasks.get(target);
        if (existing) {
            return existing;
        }
        const task = Promise.resolve().then(cleanup);
        this.cleanupTasks.set(target, task);
        return task;
    }
}
