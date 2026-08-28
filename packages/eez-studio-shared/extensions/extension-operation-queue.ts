export class ExtensionOperationQueue {
    private operations = new Map<string, Promise<void>>();

    run<T>(extensionId: string, operation: () => T | Promise<T>) {
        const previous = this.operations.get(extensionId) ?? Promise.resolve();
        const result = previous.then(operation);
        const completion = result.then(
            () => undefined,
            () => undefined
        );
        this.operations.set(extensionId, completion);
        void completion.then(() => {
            if (this.operations.get(extensionId) === completion) {
                this.operations.delete(extensionId);
            }
        });
        return result;
    }
}
