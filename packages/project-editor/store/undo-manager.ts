import { makeObservable } from "mobx";
import { observable, computed, action } from "mobx";

import type { ProjectStore } from "project-editor/store";

////////////////////////////////////////////////////////////////////////////////

interface IUndoItem {
    commands: ICommand[];
    selectionBefore: any;
    selectionAfter: any;
    label?: string;
}

interface IActiveTransaction {
    previousCombineCommands: boolean;
    previousUndoStack: IUndoItem[];
    previousRedoStack: IUndoItem[];
    previousCommands: ICommand[];
    previousSelectionBeforeFirstCommand: any;
    lastRevision: symbol;
    lastRevisionStable: symbol;
    failed: boolean;
    uncertain: boolean;
    error: any;
}

export class TransactionRollbackError extends Error {
    readonly code = "PROJECT_TRANSACTION_ROLLBACK_FAILED";

    constructor(public transactionError: any, public rollbackErrors: any[]) {
        super("Project transaction failed and could not be fully rolled back");
        this.name = "TransactionRollbackError";
    }
}

export class UndoManager {
    undoStack: IUndoItem[] = [];
    redoStack: IUndoItem[] = [];
    commands: ICommand[] = [];

    private selectionBeforeFirstCommand: any;
    public combineCommands: boolean = false;

    postponeSetCombineCommandsFalse: boolean = false;

    private activeTransaction: IActiveTransaction | undefined;

    constructor(public projectStore: ProjectStore) {
        makeObservable(this, {
            undoStack: observable,
            redoStack: observable,
            commands: observable,
            clear: action,
            pushToUndoStack: action,
            setCombineCommands: action,
            executeCommand: action,
            runTransaction: action,
            canUndo: computed,
            undoDescription: computed,
            undo: action,
            canRedo: computed,
            redoDescription: computed,
            redo: action
        });
    }

    clear() {
        this.undoStack = [];
        this.redoStack = [];
        this.commands = [];
        this.activeTransaction = undefined;
    }

    pushToUndoStack(label?: string) {
        if (this.commands.length > 0) {
            // TODO set selectionAfter to current selection
            const selectionAfter = undefined;

            this.undoStack.push({
                commands: this.commands,
                selectionBefore: this.selectionBeforeFirstCommand,
                selectionAfter: selectionAfter,
                label
            });

            this.commands = [];

            // TODO set this.selectionBeforeFirstCommand to current selection
            this.selectionBeforeFirstCommand = undefined;
            return true;
        }
        return false;
    }

    setCombineCommands(value: boolean) {
        if (this.activeTransaction) {
            return;
        }

        if (value == false && this.postponeSetCombineCommandsFalse) {
            return;
        }

        this.pushToUndoStack();
        this.combineCommands = value;

        if (!this.combineCommands) {
            this.projectStore.updateLastRevisionStable();
        }
    }

    executeCommand(command: ICommand) {
        if (this.commands.length == 0) {
            // TODO set this.selectionBeforeFirstCommand to current selection
            this.selectionBeforeFirstCommand = undefined;
        } else {
            if (!this.combineCommands) {
                this.pushToUndoStack();
            }
        }

        try {
            command.execute();
        } catch (error) {
            const executionError = new TransactionRollbackError(error, []);
            if (this.activeTransaction) {
                this.activeTransaction.failed = true;
                this.activeTransaction.uncertain = true;
                this.activeTransaction.error = executionError;
            }
            this.invalidateUncertainModelState();
            throw executionError;
        }

        command.revision = Symbol();
        const previousRevision = this.projectStore.setModified(command.revision);
        if (command.previousRevision == undefined) {
            command.previousRevision = previousRevision;
        }

        this.commands.push(command);

        this.redoStack = [];

        if (!this.activeTransaction) {
            this.projectStore.advanceRevision();
        }
    }

    private invalidateUncertainModelState() {
        this.undoStack = [];
        this.redoStack = [];
        this.commands = [];
        this.selectionBeforeFirstCommand = undefined;
        this.projectStore.setModified(Symbol());
        this.projectStore.updateLastRevisionStable();
        this.projectStore.advanceRevision();
        this.projectStore.project.enableTabs();
    }

    runTransaction<T>(label: string, fn: () => T): T {
        if (this.activeTransaction) {
            const transaction = this.activeTransaction;
            try {
                const result = fn();
                if (
                    result != undefined &&
                    typeof (result as any).then == "function"
                ) {
                    throw new Error("Project transactions must be synchronous");
                }
                return result;
            } catch (error) {
                transaction.failed = true;
                if (transaction.error == undefined) {
                    transaction.error = error;
                }
                throw error;
            }
        }

        if (this.combineCommands) {
            throw new Error(
                "Cannot start a project transaction while legacy command combination is active"
            );
        }

        const previousCommands = this.commands.slice();
        const previousSelectionBeforeFirstCommand =
            this.selectionBeforeFirstCommand;
        const previousUndoStack = this.undoStack.slice();
        this.pushToUndoStack();

        const transaction: IActiveTransaction = {
            previousCombineCommands: this.combineCommands,
            previousUndoStack,
            previousRedoStack: this.redoStack.slice(),
            previousCommands,
            previousSelectionBeforeFirstCommand,
            lastRevision: this.projectStore.lastRevision,
            lastRevisionStable: this.projectStore.lastRevisionStable,
            failed: false,
            uncertain: false,
            error: undefined
        };
        this.activeTransaction = transaction;
        this.combineCommands = true;

        let result: T | undefined;
        try {
            result = fn();
            if (
                result != undefined &&
                typeof (result as any).then == "function"
            ) {
                throw new Error("Project transactions must be synchronous");
            }
        } catch (error) {
            transaction.failed = true;
            if (transaction.error == undefined) {
                transaction.error = error;
            }
        }

        if (transaction.failed) {
            if (transaction.uncertain) {
                this.combineCommands = transaction.previousCombineCommands;
                this.activeTransaction = undefined;
                throw transaction.error;
            }
            const rollbackErrors: any[] = [];
            for (let i = this.commands.length - 1; i >= 0; i--) {
                try {
                    this.commands[i].undo();
                } catch (error) {
                    rollbackErrors.push(error);
                }
            }

            this.undoStack = transaction.previousUndoStack;
            this.commands = transaction.previousCommands;
            this.selectionBeforeFirstCommand =
                transaction.previousSelectionBeforeFirstCommand;
            this.redoStack = transaction.previousRedoStack;
            this.combineCommands = transaction.previousCombineCommands;
            this.activeTransaction = undefined;

            if (rollbackErrors.length > 0) {
                this.invalidateUncertainModelState();
                throw new TransactionRollbackError(
                    transaction.error,
                    rollbackErrors
                );
            }
            this.projectStore.restoreModifiedRevision(
                transaction.lastRevision,
                transaction.lastRevisionStable
            );
            this.projectStore.project.enableTabs();
            throw transaction.error;
        }

        const committed = this.pushToUndoStack(label);
        this.combineCommands = transaction.previousCombineCommands;
        this.activeTransaction = undefined;

        if (committed) {
            this.projectStore.updateLastRevisionStable();
            this.projectStore.advanceRevision();
        }

        return result!;
    }

    static getCommandsDescription(commands: ICommand[]) {
        return commands[commands.length - 1].description;
    }

    static getUndoItemDescription(undoItem: IUndoItem) {
        return (
            undoItem.label ?? UndoManager.getCommandsDescription(undoItem.commands)
        );
    }

    get canUndo() {
        return this.undoStack.length > 0 || this.commands.length > 0;
    }

    get undoDescription() {
        let description;
        if (this.commands.length > 0) {
            description = UndoManager.getCommandsDescription(this.commands);
        } else if (this.undoStack.length > 0) {
            description = UndoManager.getUndoItemDescription(
                this.undoStack[this.undoStack.length - 1]
            );
        }
        return description;
    }

    undo() {
        if (this.activeTransaction) {
            throw new Error("Cannot undo while a project transaction is active");
        }
        this.pushToUndoStack();

        const undoItem = this.undoStack[this.undoStack.length - 1];
        if (undoItem) {
            try {
                for (let i = undoItem.commands.length - 1; i >= 0; i--) {
                    undoItem.commands[i].undo();
                    this.projectStore.setModified(
                        undoItem.commands[i].previousRevision!
                    );
                }
            } catch (error) {
                this.invalidateUncertainModelState();
                throw new TransactionRollbackError(error, []);
            }

            // TODO select undoItem.selectionBefore

            this.undoStack.pop();
            this.redoStack.push(undoItem);

            this.projectStore.project.enableTabs();
            this.projectStore.advanceRevision();
        }
    }

    get canRedo() {
        return this.redoStack.length > 0;
    }

    get redoDescription() {
        let description;
        if (this.redoStack.length > 0) {
            description = UndoManager.getUndoItemDescription(
                this.redoStack[this.redoStack.length - 1]
            );
        }
        return description;
    }

    redo() {
        if (this.activeTransaction) {
            throw new Error("Cannot redo while a project transaction is active");
        }
        const redoItem = this.redoStack[this.redoStack.length - 1];
        if (redoItem) {
            try {
                for (let i = 0; i < redoItem.commands.length; i++) {
                    redoItem.commands[i].execute();
                    this.projectStore.setModified(redoItem.commands[i].revision!);
                }
            } catch (error) {
                this.invalidateUncertainModelState();
                throw new TransactionRollbackError(error, []);
            }

            // TODO select redoItem.selectionAfter

            this.redoStack.pop();
            this.undoStack.push(redoItem);

            this.projectStore.project.enableTabs();
            this.projectStore.advanceRevision();
        }
    }
}

export interface ICommand {
    execute(): void;
    undo(): void;
    description: string;
    revision?: symbol;
    previousRevision?: symbol;
}

export interface IUndoManager {
    executeCommand(command: ICommand): void;
    combineCommands: boolean;
    commands: ICommand[];
}
