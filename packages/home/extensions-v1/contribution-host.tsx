import React from "react";
import { ipcRenderer } from "electron";
import { observe, runInAction } from "mobx";

import { extensions } from "eez-studio-shared/extensions/extensions";
import type {
    HomeTabCategory,
    IExtension,
    IHomeSection
} from "eez-studio-shared/extensions/extension";
import { Button } from "eez-studio-ui/button";
import { isSafeDeclarativeIcon } from "eez-studio-shared/extensions-v1";

interface DeclarativeCommand {
    id: string;
    title: string;
}

interface DeclarativeHomeSection {
    id: string;
    title: string;
    icon: string;
    category?: HomeTabCategory;
    commands?: DeclarativeCommand[];
}

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const HOME_SECTION_KEYS = new Set([
    "id",
    "title",
    "icon",
    "category",
    "commands"
]);
const COMMAND_KEYS = new Set(["id", "title"]);

function isValidText(value: unknown, maximumLength: number): value is string {
    return (
        typeof value == "string" &&
        value.length > 0 &&
        value.length <= maximumLength &&
        value.trim() == value &&
        !CONTROL_CHARACTER.test(value)
    );
}

function readHomeSections(value: unknown): DeclarativeHomeSection[] {
    if (value == undefined) {
        return [];
    }
    if (!Array.isArray(value) || value.length > 32) {
        throw new Error("contributes.homeSections must be an array");
    }
    const ids = new Set<string>();
    const commandIds = new Set<string>();
    return value.map(item => {
        if (!item || typeof item != "object" || Array.isArray(item)) {
            throw new Error("Home section contribution must be an object");
        }
        const section = item as Record<string, unknown>;
        if (Object.keys(section).some(key => !HOME_SECTION_KEYS.has(key))) {
            throw new Error("Home section contribution contains an unknown field");
        }
        if (
            typeof section.id != "string" ||
            !ID_PATTERN.test(section.id) ||
            ids.has(section.id) ||
            !isValidText(section.title, 80) ||
            !isValidText(section.icon, 128) ||
            !isSafeDeclarativeIcon(section.icon) ||
            (section.category != undefined &&
                !new Set(["none", "common", "instrument"]).has(
                    section.category as string
                ))
        ) {
            throw new Error("Invalid Home section contribution");
        }
        ids.add(section.id);
        const commands = section.commands;
        if (
            commands != undefined &&
            (!Array.isArray(commands) || commands.length > 32)
        ) {
            throw new Error("Home section commands must be an array");
        }
        return {
            id: section.id,
            title: section.title,
            icon: section.icon,
            category: section.category as HomeTabCategory | undefined,
            commands: (commands ?? []).map(commandValue => {
                if (
                    !commandValue ||
                    typeof commandValue != "object" ||
                    Array.isArray(commandValue)
                ) {
                    throw new Error("Command contribution must be an object");
                }
                const command = commandValue as Record<string, unknown>;
                if (Object.keys(command).some(key => !COMMAND_KEYS.has(key))) {
                    throw new Error("Command contribution contains an unknown field");
                }
                if (
                    typeof command.id != "string" ||
                    !ID_PATTERN.test(command.id) ||
                    commandIds.has(command.id) ||
                    !isValidText(command.title, 80)
                ) {
                    throw new Error("Invalid command contribution");
                }
                commandIds.add(command.id);
                return { id: command.id, title: command.title };
            })
        };
    });
}

function ExtensionHomeSection({
    extensionId,
    section
}: {
    extensionId: string;
    section: DeclarativeHomeSection;
}) {
    return (
        <div className="EezStudio_ExtensionV1_HomeSection p-3">
            <div className="d-flex flex-wrap gap-2">
                {(section.commands ?? []).map(command => (
                    <Button
                        key={command.id}
                        color="primary"
                        size="medium"
                        onClick={() =>
                            ipcRenderer.send("eez-extension-v1/command", {
                                extensionId,
                                commandId: command.id
                            })
                        }
                    >
                        {command.title}
                    </Button>
                ))}
            </div>
        </div>
    );
}

export interface DeclarativeExtensionContributionHostOptions {
    onUnregisterHomeSections?: (sectionIds: readonly string[]) => void;
}

const registeredExtensions = new Map<string, IExtension>();
let disposeActiveHost: (() => void) | undefined;

export function unregisterDeclarativeExtensionContributions(
    extensionId: string,
    options: DeclarativeExtensionContributionHostOptions = {}
) {
    const extension = registeredExtensions.get(extensionId);
    if (!extension) {
        return;
    }

    const sectionIds = (extension.homeSections ?? []).map(section => section.id);
    runInAction(() => {
        extension.homeSections = undefined;
    });
    registeredExtensions.delete(extensionId);

    try {
        options.onUnregisterHomeSections?.(sectionIds);
    } catch (error) {
        console.error(
            `Failed to remove declarative Home sections for ${extensionId}`,
            error
        );
    }
}

export function registerDeclarativeExtensionContributions(
    extension: IExtension,
    options: DeclarativeExtensionContributionHostOptions = {}
) {
    unregisterDeclarativeExtensionContributions(extension.id, options);
    if (extension.extensionType != "extension-v1" || !extension.manifest) {
        return;
    }

    let registeredHomeSections: IHomeSection[];
    try {
        const contributions = extension.manifest.contributes as
            | Record<string, unknown>
            | undefined;
        const homeSections = readHomeSections(contributions?.homeSections);
        registeredHomeSections = homeSections.map(section => ({
            id: `${extension.id}.${section.id}`,
            title: section.title,
            icon: section.icon,
            category: section.category ?? "common",
            renderContent: () => (
                <ExtensionHomeSection
                    extensionId={extension.id}
                    section={section}
                />
            )
        }));
    } catch (error) {
        console.error(
            `Invalid declarative contributions for ${extension.id}`,
            error
        );
        registeredHomeSections = [];
    }

    runInAction(() => {
        extension.homeSections = registeredHomeSections;
    });
    registeredExtensions.set(extension.id, extension);
}

export function startDeclarativeExtensionContributionHost(
    options: DeclarativeExtensionContributionHostOptions = {}
) {
    disposeActiveHost?.();

    const stopObserving = observe(extensions, change => {
        if (change.type == "delete") {
            unregisterDeclarativeExtensionContributions(change.name, options);
        } else {
            registerDeclarativeExtensionContributions(change.newValue, options);
        }
    });
    for (const extension of extensions.values()) {
        registerDeclarativeExtensionContributions(extension, options);
    }

    let disposed = false;
    const dispose = () => {
        if (disposed) {
            return;
        }
        disposed = true;
        stopObserving();
        for (const extensionId of Array.from(registeredExtensions.keys())) {
            unregisterDeclarativeExtensionContributions(extensionId, options);
        }
        if (disposeActiveHost == dispose) {
            disposeActiveHost = undefined;
        }
    };
    disposeActiveHost = dispose;

    return { dispose };
}
