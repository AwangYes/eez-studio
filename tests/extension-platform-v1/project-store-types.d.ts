declare module "project-editor/store" {
    export class ProjectStore {
        filePath?: string;
        isModified: boolean;
        publicRevision: string;
        runtime?: {
            isRunning: boolean;
            isPaused: boolean;
        };
        undoManager: {
            undo(): void;
        };
        project: {
            enableTabs(): void;
        };
        lastRevision: symbol;
        lastRevisionStable: symbol;
        setModified(revision: symbol): symbol;
        restoreModifiedRevision(
            lastRevision: symbol,
            lastRevisionStable: symbol
        ): void;
        updateLastRevisionStable(): void;
        advanceRevision(): void;
        assertRevision(revision: string): void;
    }
}
