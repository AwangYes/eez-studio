import { app, dialog } from "electron";
import crypto from "crypto";
import fs from "fs";
import path from "path";

import type { ExtensionCapability } from "eez-studio-shared/extensions-v1";

interface StoredGrants {
    version: 1;
    grants: Record<string, true>;
}

const SESSION_CAPABILITIES = new Set<ExtensionCapability>([
    "runtime.control"
]);
const MAX_WORKSPACE_SCOPE_LENGTH = 4096;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

function validateWorkspaceScope(scope: string) {
    if (
        typeof scope != "string" ||
        scope.length == 0 ||
        scope.length > MAX_WORKSPACE_SCOPE_LENGTH ||
        scope.trim() != scope ||
        CONTROL_CHARACTER.test(scope)
    ) {
        const error = new Error("Invalid extension workspace scope") as Error & {
            code: string;
        };
        error.code = "INVALID_ARGUMENT";
        throw error;
    }
    return scope;
}

export class ExtensionPermissionManager {
    private readonly sessionGrants = new Set<string>();
    private readonly pending = new Map<string, Promise<void>>();
    private readonly epochs = new Map<string, number>();
    private stored: StoredGrants = { version: 1, grants: {} };
    private loaded = false;
    private saveQueue: Promise<void> = Promise.resolve();
    private promptQueue: Promise<void> = Promise.resolve();
    private readonly pendingByExtension = new Map<string, number>();

    private get filePath() {
        return path.join(app.getPath("userData"), "extension-v1-grants.json");
    }

    private key(
        extensionId: string,
        publisherFingerprint: string | undefined,
        capability: string,
        scope: string
    ) {
        if (
            publisherFingerprint != undefined &&
            !/^[0-9a-f]{64}$/.test(publisherFingerprint)
        ) {
            throw new Error("Invalid extension publisher fingerprint");
        }
        return JSON.stringify([
            extensionId,
            publisherFingerprint
                ? `sha256:${publisherFingerprint}`
                : "developer-unsigned",
            capability,
            validateWorkspaceScope(scope)
        ]);
    }

    private async load() {
        if (this.loaded) {
            return;
        }
        this.loaded = true;
        try {
            const parsed = JSON.parse(
                await fs.promises.readFile(this.filePath, "utf8")
            );
            const grants = parsed?.grants;
            if (
                parsed?.version === 1 &&
                grants &&
                typeof grants === "object" &&
                !Array.isArray(grants) &&
                Object.getPrototypeOf(grants) === Object.prototype &&
                Object.entries(grants).every(
                    ([key, value]) => value === true && this.isGrantKey(key)
                )
            ) {
                this.stored = {
                    version: 1,
                    grants: Object.fromEntries(Object.entries(grants))
                };
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code != "ENOENT") {
                console.error("Failed to load extension grants", error);
            }
        }
    }

    private isGrantKey(key: string) {
        try {
            const parts = JSON.parse(key);
            return (
                Array.isArray(parts) &&
                parts.length === 4 &&
                parts.every(part => typeof part === "string" && part.length > 0) &&
                (parts[1] === "developer-unsigned" ||
                    /^sha256:[0-9a-f]{64}$/.test(parts[1]))
            );
        } catch {
            return false;
        }
    }

    private epoch(extensionId: string) {
        return this.epochs.get(extensionId) ?? 0;
    }

    private revokedError() {
        const error = new Error(
            "Extension permission request was invalidated"
        ) as Error & { code: string };
        error.code = "PERMISSION_REVOKED";
        return error;
    }

    private async saveUnlocked() {
        const filePath = this.filePath;
        const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
        let temporaryFile: fs.promises.FileHandle | undefined;
        try {
            temporaryFile = await fs.promises.open(temporaryPath, "wx", 0o600);
            await temporaryFile.writeFile(
                JSON.stringify(this.stored, undefined, 2),
                "utf8"
            );
            await temporaryFile.sync();
            await temporaryFile.close();
            temporaryFile = undefined;
            await fs.promises.rename(temporaryPath, filePath);

            let directory: fs.promises.FileHandle | undefined;
            try {
                directory = await fs.promises.open(path.dirname(filePath), "r");
                await directory.sync();
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (
                    code != "EINVAL" &&
                    code != "EPERM" &&
                    code != "EISDIR" &&
                    code != "ENOTSUP"
                ) {
                    throw error;
                }
            } finally {
                await directory?.close();
            }
        } catch (error) {
            await temporaryFile?.close().catch(() => undefined);
            await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
            throw error;
        }
    }

    private save() {
        const write = this.saveQueue.then(() => this.saveUnlocked());
        this.saveQueue = write.catch(() => undefined);
        return write;
    }

    async authorize(options: {
        extensionId: string;
        extensionName: string;
        publisherKeyId?: string;
        publisherFingerprint?: string;
        requestedCapabilities: readonly string[];
        capability: ExtensionCapability;
        workspaceScope: string;
    }) {
        await this.load();
        if (!options.requestedCapabilities.includes(options.capability)) {
            const error = new Error(
                `Extension did not declare capability ${options.capability}`
            ) as Error & { code: string };
            error.code = "CAPABILITY_NOT_DECLARED";
            throw error;
        }

        const grantKey = this.key(
            options.extensionId,
            options.publisherFingerprint,
            options.capability,
            options.workspaceScope
        );
        const unsigned = options.publisherFingerprint == undefined;
        if (
            this.sessionGrants.has(grantKey) ||
            (!unsigned && this.stored.grants[grantKey])
        ) {
            return;
        }

        let authorization = this.pending.get(grantKey);
        if (!authorization) {
            const pendingCount = this.pendingByExtension.get(options.extensionId) ?? 0;
            if (pendingCount > 0) {
                const error = new Error(
                    "Extension has another permission request pending"
                ) as Error & { code: string };
                error.code = "TOO_MANY_REQUESTS";
                throw error;
            }
            const epoch = this.epoch(options.extensionId);
            this.pendingByExtension.set(
                options.extensionId,
                pendingCount + 1
            );
            const queuedPrompt = this.promptQueue
                .catch(() => undefined)
                .then(() => this.prompt(options, grantKey, epoch));
            this.promptQueue = queuedPrompt.then(
                () => undefined,
                () => undefined
            );
            authorization = queuedPrompt.finally(() => {
                const count = this.pendingByExtension.get(options.extensionId) ?? 1;
                if (count <= 1) {
                    this.pendingByExtension.delete(options.extensionId);
                } else {
                    this.pendingByExtension.set(options.extensionId, count - 1);
                }
                if (this.pending.get(grantKey) === authorization) {
                    this.pending.delete(grantKey);
                }
            });
            this.pending.set(grantKey, authorization);
        }
        return authorization;
    }

    async isAuthorized(options: {
        extensionId: string;
        publisherKeyId?: string;
        publisherFingerprint?: string;
        capability: ExtensionCapability;
        workspaceScope: string;
    }) {
        await this.load();
        const grantKey = this.key(
            options.extensionId,
            options.publisherFingerprint,
            options.capability,
            options.workspaceScope
        );
        const globalKey = this.key(
            options.extensionId,
            options.publisherFingerprint,
            options.capability,
            "global"
        );
        return (
            this.sessionGrants.has(grantKey) ||
            (options.publisherFingerprint != undefined &&
                !!this.stored.grants[grantKey]) ||
            this.sessionGrants.has(globalKey) ||
            (options.publisherFingerprint != undefined &&
                !!this.stored.grants[globalKey])
        );
    }

    private async prompt(
        options: {
            extensionId: string;
            extensionName: string;
            publisherKeyId?: string;
            publisherFingerprint?: string;
            capability: ExtensionCapability;
            workspaceScope: string;
        },
        grantKey: string,
        epoch: number
    ) {
        if (this.epoch(options.extensionId) !== epoch) {
            throw this.revokedError();
        }
        const workspaceScope = validateWorkspaceScope(options.workspaceScope);
        const displayedScope =
            workspaceScope.length > 512
                ? `${workspaceScope.slice(0, 509)}...`
                : workspaceScope;
        const sessionOnly =
            options.publisherFingerprint == undefined ||
            SESSION_CAPABILITIES.has(options.capability);
        const result = await dialog.showMessageBox({
            type: "question",
            title: "Extension permission",
            message: `${options.extensionName} requests ${options.capability}`,
            detail:
                workspaceScope === "global"
                    ? "Scope: Studio workspace"
                    : `Scope: ${displayedScope}`,
            noLink: true,
            buttons: sessionOnly
                ? ["Allow for session", "Deny"]
                : ["Allow for workspace", "Allow once", "Deny"],
            defaultId: sessionOnly ? 1 : 2,
            cancelId: sessionOnly ? 1 : 2
        });

        if (this.epoch(options.extensionId) !== epoch) {
            throw this.revokedError();
        }

        if (result.response === 0) {
            if (sessionOnly) {
                this.sessionGrants.add(grantKey);
            } else {
                this.stored.grants[grantKey] = true;
                await this.save();
            }
            return;
        }
        if (!sessionOnly && result.response === 1) {
            return;
        }

        const error = new Error("Extension permission was denied") as Error & {
            code: string;
        };
        error.code = "PERMISSION_DENIED";
        throw error;
    }

    async revokeExtension(extensionId: string) {
        await this.load();
        this.epochs.set(extensionId, this.epoch(extensionId) + 1);
        const matches = (key: string) => {
            try {
                return JSON.parse(key)[0] === extensionId;
            } catch {
                return false;
            }
        };
        for (const key of Array.from(this.pending.keys())) {
            if (matches(key)) {
                this.pending.delete(key);
            }
        }
        this.pendingByExtension.delete(extensionId);
        for (const key of Array.from(this.sessionGrants)) {
            if (matches(key)) {
                this.sessionGrants.delete(key);
            }
        }
        for (const key of Object.keys(this.stored.grants)) {
            if (matches(key)) {
                delete this.stored.grants[key];
            }
        }
        await this.save();
    }
}
