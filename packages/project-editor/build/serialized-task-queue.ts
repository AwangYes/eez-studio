export class SerializedTaskCancelledError extends Error {
    readonly code = "CANCELLED";

    constructor() {
        super("Serialized task was cancelled");
        this.name = "SerializedTaskCancelledError";
    }
}

export function assertTaskNotCancelled(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw new SerializedTaskCancelledError();
    }
}

export class SerializedTaskQueue {
    private tail: Promise<void> = Promise.resolve();

    run<T>(
        task: () => Promise<T>,
        signal?: AbortSignal,
        checkCancellationAfterTask = true
    ): Promise<T> {
        const result = this.tail.then(async () => {
            assertTaskNotCancelled(signal);
            try {
                const value = await task();
                if (checkCancellationAfterTask) {
                    assertTaskNotCancelled(signal);
                }
                return value;
            } catch (error) {
                if (checkCancellationAfterTask) {
                    assertTaskNotCancelled(signal);
                }
                throw error;
            }
        });
        this.tail = result.then(
            () => undefined,
            () => undefined
        );
        return result;
    }
}
