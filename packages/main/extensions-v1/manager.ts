import { ipcMain } from "electron";
import { action } from "mobx";
import path from "path";

import {
    extensions,
    reloadExtensionV1
} from "eez-studio-shared/extensions/extensions";
import {
    isValidExtensionId,
    type ExtensionCapability
} from "eez-studio-shared/extensions-v1";
import type { IExtension } from "eez-studio-shared/extensions/extension";
import { getExtensionFolderPath } from "eez-studio-shared/extensions/extension-folder";
import { inspectExtensionPackageStatic } from "eez-studio-shared/extensions/extension-installation";
import { findHomeWindow } from "main/home-window";

import { ExtensionPermissionManager } from "main/extensions-v1/permission-manager";
import { RendererServiceBroker } from "main/extensions-v1/renderer-service-broker";
import {
    SandboxExtensionHost,
    type SandboxExtensionDescriptor
} from "main/extensions-v1/sandbox-host";

const READY_CHANNEL = "eez-extension-v1/studio-ready";
const CHANGE_REQUEST_CHANNEL = "eez-extension-v1/change-request";
const COMMAND_CHANNEL = "eez-extension-v1/command";
const EVENT_CHANNEL = "eez-extension-v1/studio-event";
const SHUTDOWN_CHANNEL = "eez-extension-v1/shutdown";
const MAX_READY_EXTENSION_IDS = 1024;

export function validateReadyExtensionIds(payload: unknown) {
    const extensionIds = (payload as { extensionIds?: unknown } | undefined)
        ?.extensionIds;
    if (
        !Array.isArray(extensionIds) ||
        extensionIds.length > MAX_READY_EXTENSION_IDS
    ) {
        return undefined;
    }

    const uniqueIds = new Set<string>();
    for (const extensionId of extensionIds) {
        if (
            !isValidExtensionId(extensionId) ||
            uniqueIds.has(extensionId)
        ) {
            return undefined;
        }
        uniqueIds.add(extensionId);
    }
    return Array.from(uniqueIds);
}

const SERVICE_CAPABILITIES: Record<string, ExtensionCapability> = {
    "workspace:list": "project.read",
    "workspace:activate": "project.read",
    "workspace:open": "project.manage",
    "workspace:reload": "project.manage",
    "workspace:close": "project.manage",
    "project:describe": "project.read",
    "project:snapshot": "project.read",
    "project:getObject": "project.read",
    "project:getSchema": "project.read",
    "project:applyEdits": "project.write",
    "project:save": "project.write",
    "project:undo": "project.write",
    "project:redo": "project.write",
    "build:check": "build.execute",
    "build:run": "build.execute",
    "runtime:status": "project.read",
    "runtime:start": "runtime.control",
    "runtime:stop": "runtime.control",
    "runtime:pause": "runtime.control",
    "runtime:resume": "runtime.control",
    "runtime:step": "runtime.control",
    "editor:navigate": "project.read",
    "editor:select": "project.read"
};

function extensionDeclaresCommand(
    extension: IExtension | undefined,
    commandId: string
) {
    const contributions = extension?.manifest?.contributes as
        | { homeSections?: unknown }
        | undefined;
    if (!Array.isArray(contributions?.homeSections)) {
        return false;
    }
    return contributions.homeSections.some(section => {
        const commands = (section as { commands?: unknown } | undefined)
            ?.commands;
        return (
            Array.isArray(commands) &&
            commands.some(
                command =>
                    (command as { id?: unknown } | undefined)?.id === commandId
            )
        );
    });
}

export class ExtensionV1Manager {
    private readonly broker = new RendererServiceBroker();
    private readonly permissions = new ExtensionPermissionManager();
    private readonly hosts = new Map<string, SandboxExtensionHost>();
    private readonly activationTasks = new Map<string, Promise<boolean>>();
    private readonly refreshes = new Map<string, Promise<void>>();
    private readonly pendingCommands = new Map<string, string[]>();
    private readonly failedHosts = new Set<string>();
    private activating: Promise<void> | undefined;
    private readyReconciliation: Promise<void> | undefined;
    private disposed = false;

    private readonly readyListener = (
        event: Electron.IpcMainEvent,
        payload: unknown
    ) => {
        if (
            event.sender !== findHomeWindow()?.browserWindow.webContents
        ) {
            return;
        }
        const extensionIds = validateReadyExtensionIds(payload);
        if (!extensionIds) {
            console.warn("Ignored invalid V1 extension READY snapshot");
            return;
        }
        if (this.disposed) {
            return;
        }

        const previous = this.readyReconciliation;
        const reconciliation = (previous ?? Promise.resolve())
            .catch(() => undefined)
            .then(() => this.reconcileReadyExtensions(extensionIds));
        this.readyReconciliation = reconciliation;
        void reconciliation
            .catch(error => {
                console.error("Failed to reconcile V1 extensions after READY", error);
            })
            .finally(() => {
                if (this.readyReconciliation === reconciliation) {
                    this.readyReconciliation = undefined;
                }
            });
    };
    private readonly changeRequestHandler = async (
        event: Electron.IpcMainInvokeEvent,
        payload: any
    ) => {
        const homeWindow = findHomeWindow();
        if (
            event.sender !== homeWindow?.browserWindow.webContents ||
            !isValidExtensionId(payload?.extensionId) ||
            (payload.action != "install" && payload.action != "uninstall")
        ) {
            const error = new Error("Invalid extension change request") as Error & {
                code: string;
            };
            error.code = "INVALID_ARGUMENT";
            throw error;
        }
        await this.queueRefresh(payload.extensionId, payload.action);
        return { applied: true };
    };
    private readonly commandListener = (
        event: Electron.IpcMainEvent,
        payload: any
    ) => {
        const homeWindow = findHomeWindow();
        if (
            event.sender !== homeWindow?.browserWindow.webContents ||
            !isValidExtensionId(payload?.extensionId) ||
            typeof payload?.commandId != "string" ||
            payload.commandId.length > 128
        ) {
            return;
        }
        const extension = extensions.get(payload.extensionId);
        if (!extensionDeclaresCommand(extension, payload.commandId)) {
            return;
        }
        const host = this.hosts.get(payload.extensionId);
        if (host) {
            host.sendEvent({
                type: "command",
                commandId: payload.commandId
            });
            return;
        }

        if (
            extension?.extensionType == "extension-v1" &&
            !this.failedHosts.has(extension.id)
        ) {
            const commands = this.pendingCommands.get(payload.extensionId) ?? [];
            if (commands.length < 64) {
                commands.push(payload.commandId);
                this.pendingCommands.set(payload.extensionId, commands);
            }
        }
    };
    private readonly eventListener = (
        event: Electron.IpcMainEvent,
        payload: any
    ) => {
        const homeWindow = findHomeWindow();
        if (
            event.sender !== homeWindow?.browserWindow.webContents ||
            !payload ||
            typeof payload != "object"
        ) {
            return;
        }
        void this.forwardProjectEvent(payload).catch(error => {
            console.error("Failed to forward a V1 extension event", error);
        });
    };
    private readonly shutdownHandler = async (
        event: Electron.IpcMainInvokeEvent
    ) => {
        if (event.sender !== findHomeWindow()?.browserWindow.webContents) {
            const error = new Error(
                "Invalid extension platform shutdown request"
            ) as Error & { code: string };
            error.code = "PERMISSION_DENIED";
            throw error;
        }
        await this.dispose();
        return { stopped: true };
    };

    constructor() {
        ipcMain.on(READY_CHANNEL, this.readyListener);
        ipcMain.handle(CHANGE_REQUEST_CHANNEL, this.changeRequestHandler);
        ipcMain.on(COMMAND_CHANNEL, this.commandListener);
        ipcMain.on(EVENT_CHANNEL, this.eventListener);
        ipcMain.handle(SHUTDOWN_CHANNEL, this.shutdownHandler);
    }

    private async forwardProjectEvent(event: any) {
        const projects = Array.isArray(event.projects) ? event.projects : [];
        for (const [extensionId, host] of this.hosts) {
            const extension = extensions.get(extensionId);
            if (!extension?.manifest?.capabilities?.includes("project.read")) {
                continue;
            }
            const visibleProjects = [];
            for (const project of projects) {
                const scope =
                    typeof project?.uri == "string"
                        ? path.dirname(project.uri)
                        : project?.projectId;
                if (
                    typeof scope == "string" &&
                    (await this.permissions.isAuthorized({
                        extensionId,
                        publisherKeyId: extension.publisherKeyId,
                        publisherFingerprint: extension.publisherFingerprint,
                        capability: "project.read",
                        workspaceScope: scope
                    }))
                ) {
                    visibleProjects.push(project);
                }
            }
            host.sendEvent({ ...event, projects: visibleProjects });
        }
    }

    private async refreshExtension(
        extensionId: string,
        operation: "install" | "uninstall"
    ) {
        this.failedHosts.delete(extensionId);
        await this.activationTasks.get(extensionId)?.catch(() => false);
        const previousHost = this.hosts.get(extensionId);
        if (previousHost) {
            this.hosts.delete(extensionId);
            try {
                await previousHost.deactivate(
                    operation == "install" ? "replace" : "uninstall"
                );
            } catch (error) {
                console.error(
                    `Failed to dispose previous sandbox host ${extensionId}`,
                    error
                );
            }
        }
        if (operation == "uninstall") {
            this.pendingCommands.delete(extensionId);
            action(() => extensions.delete(extensionId))();
            await this.permissions.revokeExtension(extensionId);
            return;
        }

        const extension = await reloadExtensionV1(
            getExtensionFolderPath(extensionId),
            extensionId
        );
        if (
            !extension ||
            extension.extensionType != "extension-v1" ||
            extension.id != extensionId
        ) {
            throw new Error(
                `Installed sandbox extension could not be registered: ${extensionId}`
            );
        }
        if (!extension.publisherFingerprint) {
            await this.permissions.revokeExtension(extension.id);
        }
        if (!(await this.activateExtension(extension))) {
            throw new Error(
                `Sandbox extension activation failed: ${extensionId}`
            );
        }
    }

    private queueRefresh(
        extensionId: string,
        operation: "install" | "uninstall"
    ) {
        const previous = this.refreshes.get(extensionId);
        const refresh = (previous ?? Promise.resolve())
            .catch(() => undefined)
            .then(() => this.refreshExtension(extensionId, operation));
        this.refreshes.set(extensionId, refresh);
        void refresh
            .catch(error => {
                console.error(
                    `Failed to refresh V1 extension ${extensionId} after ${operation}`,
                    error
                );
            })
            .finally(() => {
                if (this.refreshes.get(extensionId) == refresh) {
                    this.refreshes.delete(extensionId);
                }
            });
        return refresh;
    }

    private async reconcileOperation(
        extensionId: string,
        operation: () => Promise<unknown>
    ) {
        try {
            await operation();
        } catch (error) {
            console.error(
                `Failed to reconcile V1 extension ${extensionId}`,
                error
            );
        }
    }

    private async restartPreinstalledExtension(extension: IExtension) {
        await this.activationTasks.get(extension.id)?.catch(() => false);
        const previousHost = this.hosts.get(extension.id);
        if (previousHost) {
            this.hosts.delete(extension.id);
            try {
                await previousHost.deactivate("reload");
            } catch (error) {
                console.error(
                    `Failed to dispose preinstalled sandbox host ${extension.id}`,
                    error
                );
            }
        }
        this.pendingCommands.delete(extension.id);
        this.failedHosts.delete(extension.id);
        if (!(await this.activateExtension(extension))) {
            throw new Error(
                `Preinstalled sandbox extension activation failed: ${extension.id}`
            );
        }
    }

    private async reconcileReadyExtensions(extensionIds: readonly string[]) {
        if (this.disposed) {
            return;
        }

        const preinstalled = Array.from(extensions.values()).filter(
            extension =>
                extension.extensionType == "extension-v1" &&
                extension.preInstalled
        );
        const installedStateIds = new Set(
            Array.from(extensions.values())
                .filter(
                    extension =>
                        extension.extensionType == "extension-v1" &&
                        !extension.preInstalled
                )
                .map(extension => extension.id)
        );
        for (const extensionId of this.hosts.keys()) {
            const extension = extensions.get(extensionId);
            if (
                extension?.extensionType != "extension-v1" ||
                !extension.preInstalled
            ) {
                installedStateIds.add(extensionId);
            }
        }

        const installedIds: string[] = [];
        for (const extensionId of extensionIds) {
            const extension = extensions.get(extensionId);
            if (
                extension?.extensionType == "extension-v1" &&
                extension.preInstalled
            ) {
                continue;
            }
            try {
                const inspection = await inspectExtensionPackageStatic(
                    getExtensionFolderPath(extensionId)
                );
                if (
                    inspection?.extensionType == "extension-v1" &&
                    inspection.id == extensionId
                ) {
                    installedIds.push(extensionId);
                }
            } catch (error) {
                console.error(
                    `Failed to inspect READY extension ${extensionId}`,
                    error
                );
            }
        }
        const retainedInstalledIds = new Set(installedIds);

        for (const extensionId of installedIds) {
            if (this.disposed) {
                return;
            }
            await this.reconcileOperation(extensionId, () =>
                this.queueRefresh(extensionId, "install")
            );
        }

        for (const extensionId of installedStateIds) {
            if (this.disposed) {
                return;
            }
            if (!retainedInstalledIds.has(extensionId)) {
                await this.reconcileOperation(extensionId, () =>
                    this.queueRefresh(extensionId, "uninstall")
                );
            }
        }

        for (const extension of preinstalled) {
            if (this.disposed) {
                return;
            }
            await this.reconcileOperation(extension.id, () =>
                this.restartPreinstalledExtension(extension)
            );
        }
    }

    private async workspaceScope(args: unknown, signal: AbortSignal) {
        return (await this.broker.dispatch(
            "$studio",
            "$extensionHost",
            "workspaceScope",
            args,
            signal,
            5000
        )) as string;
    }

    private async dispatch(
        extension: IExtension,
        service: string,
        method: string,
        args: unknown,
        signal: AbortSignal
    ) {
        if (service.startsWith("$")) {
            const error = new Error("Reserved extension service") as Error & {
                code: string;
            };
            error.code = "SERVICE_NOT_FOUND";
            throw error;
        }
        const capability = SERVICE_CAPABILITIES[`${service}:${method}`];
        if (!capability) {
            const error = new Error(
                `Unknown extension service method: ${service}.${method}`
            ) as Error & { code: string };
            error.code = "METHOD_NOT_FOUND";
            throw error;
        }
        const scope = await this.workspaceScope(args, signal);
        await this.permissions.authorize({
            extensionId: extension.id,
            extensionName: extension.displayName || extension.name,
            publisherKeyId: extension.publisherKeyId,
            publisherFingerprint: extension.publisherFingerprint,
            requestedCapabilities: extension.manifest?.capabilities ?? [],
            capability,
            workspaceScope: scope
        });
        return this.broker.dispatch(
            extension.id,
            service,
            method,
            args,
            signal
        );
    }

    async activateRegisteredExtensions() {
        if (this.disposed) {
            return;
        }
        if (this.activating) {
            return this.activating;
        }
        this.activating = (async () => {
            for (const extension of extensions.values()) {
                if (this.disposed) {
                    return;
                }
                await this.activateExtension(extension);
            }
        })().finally(() => {
            this.activating = undefined;
        });
        return this.activating;
    }

    private async activateExtension(extension: IExtension) {
        const activeTask = this.activationTasks.get(extension.id);
        if (activeTask) {
            return activeTask;
        }
        if (
            this.disposed ||
            extension.extensionType != "extension-v1" ||
            !extension.manifest ||
            !extension.installationFolderPath ||
            this.hosts.has(extension.id)
        ) {
            return this.hosts.has(extension.id);
        }
        const descriptor: SandboxExtensionDescriptor = {
            id: extension.id,
            version: extension.version,
            installationPath: extension.installationFolderPath,
            browser: extension.manifest.browser,
            allowedOrigins: extension.manifest.allowedOrigins,
            publisherFingerprint: extension.publisherFingerprint
        };
        const activationTask = this.activateExtensionHost(
            extension,
            descriptor
        ).finally(() => {
            if (this.activationTasks.get(extension.id) === activationTask) {
                this.activationTasks.delete(extension.id);
            }
        });
        this.activationTasks.set(extension.id, activationTask);
        return activationTask;
    }

    private async activateExtensionHost(
        extension: IExtension,
        descriptor: SandboxExtensionDescriptor
    ) {
        const host = new SandboxExtensionHost(
            descriptor,
            request =>
                this.dispatch(
                    extension,
                    request.service,
                    request.method,
                    request.args,
                    request.signal
                ),
            () => {
                if (this.hosts.get(extension.id) === host) {
                    this.hosts.delete(extension.id);
                    this.pendingCommands.delete(extension.id);
                    this.failedHosts.add(extension.id);
                    console.error(
                        `Sandbox extension exited unexpectedly: ${extension.id}`
                    );
                }
            }
        );
        this.failedHosts.delete(extension.id);
        try {
            await host.activate();
            if (this.disposed) {
                await host.deactivate("shutdown");
                return false;
            }
            this.hosts.set(extension.id, host);
            const commands = this.pendingCommands.get(extension.id) ?? [];
            this.pendingCommands.delete(extension.id);
            for (const commandId of commands) {
                host.sendEvent({ type: "command", commandId });
            }
            return true;
        } catch (error) {
            try {
                await host.deactivate("activation-error");
            } catch (cleanupError) {
                console.error(
                    `Failed to clean up sandbox extension ${extension.id} after activation error`,
                    cleanupError
                );
            }
            if (this.hosts.get(extension.id) === host) {
                this.hosts.delete(extension.id);
            }
            this.pendingCommands.delete(extension.id);
            this.failedHosts.add(extension.id);
            console.error(
                `Failed to activate sandbox extension ${extension.id}`,
                error
            );
            return false;
        }
    }

    async dispose() {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        ipcMain.removeListener(READY_CHANNEL, this.readyListener);
        ipcMain.removeHandler(CHANGE_REQUEST_CHANNEL);
        ipcMain.removeListener(COMMAND_CHANNEL, this.commandListener);
        ipcMain.removeListener(EVENT_CHANNEL, this.eventListener);
        ipcMain.removeHandler(SHUTDOWN_CHANNEL);
        try {
            await Promise.allSettled([
                ...this.refreshes.values(),
                ...(this.activating ? [this.activating] : []),
                ...this.activationTasks.values(),
                ...(this.readyReconciliation
                    ? [this.readyReconciliation]
                    : [])
            ]);
            await Promise.allSettled(
                Array.from(this.hosts.values()).map(host =>
                    host.deactivate("shutdown")
                )
            );
        } finally {
            this.refreshes.clear();
            this.pendingCommands.clear();
            this.failedHosts.clear();
            this.activationTasks.clear();
            this.hosts.clear();
            this.broker.dispose();
        }
    }
}

export const extensionV1Manager = new ExtensionV1Manager();
