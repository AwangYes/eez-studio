declare module "project-editor/store" {
    export class ProjectStore {
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
    }
}
