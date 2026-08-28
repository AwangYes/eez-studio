/// <reference path="./globals.d.ts"/>
import "bootstrap";
import { ipcRenderer } from "electron";
import React from "react";
import { createRoot } from "react-dom/client";
import { configure } from "mobx";
import { observer } from "mobx-react";

import {
    extensions,
    loadExtensions
} from "eez-studio-shared/extensions/extensions";
import { getNodeModuleFolders } from "eez-studio-shared/extensions/yarn";

import * as notification from "eez-studio-ui/notification";
import { showAboutBox } from "eez-studio-ui/about-box";

import type * as ImportInstrumentDefinitionModule from "instrument/import-instrument-definition";

import { handleDragAndDrop } from "home/drag-and-drop";
import { loadTabs, ProjectEditorTab, tabs } from "home/tabs-store";
import { settingsController } from "home/settings";
import { App } from "home/app";
import { openProject } from "home/tabs-store";

import { LineMarkers } from "project-editor/flow/connection-line/ConnectionLineComponent";

import "home/settings";
import { extensionsCatalog } from "./extensions-manager/catalog";
import { buildProject } from "home/build-project";
import { layoutModels } from "eez-studio-ui/side-dock";
import {
    registerProjectExtensionServices,
    startProjectExtensionEvents
} from "home/extensions-v1/project-service";
import { studioExtensionServiceHost } from "home/extensions-v1/service-host";
import { startDeclarativeExtensionContributionHost } from "home/extensions-v1/contribution-host";
configure({ enforceActions: "observed", useProxies: "always" });

const extensionPlatformDisposables: Array<{ dispose(): void }> = [];

// make sure we store all the values waiting to be stored inside blur event handler
function blurAll() {
    var tmp = document.createElement("input");
    document.body.appendChild(tmp);
    tmp.focus();
    document.body.removeChild(tmp);
}

async function beforeAppClose(shutdownExtensionManager: boolean) {
    blurAll();

    for (const tab of tabs.tabs) {
        if (tab.beforeAppClose) {
            if (!(await tab.beforeAppClose())) {
                return false;
            }
        }
    }

    if (shutdownExtensionManager) {
        await ipcRenderer.invoke("eez-extension-v1/shutdown");
    }

    const {
        destroyExtensions
    } = require("eez-studio-shared/extensions/extensions");
    studioExtensionServiceHost.dispose();
    for (const disposable of extensionPlatformDisposables.splice(0)) {
        disposable.dispose();
    }
    await destroyExtensions();

    layoutModels.saveToLocalStorage();

    return true;
}

ipcRenderer.on("beforeClose", async () => {
    if (await beforeAppClose(true)) {
        ipcRenderer.send("readyToClose");
    }
});

ipcRenderer.on("reload", async () => {
    if (await beforeAppClose(false)) {
        ipcRenderer.send("reload");
    }
});

ipcRenderer.on("switch-theme", async () => {
    settingsController.switchTheme(!settingsController.isDarkTheme);
});

ipcRenderer.on(
    "importInstrumentDefinitionFile",
    (sender: any, filePath: string) => {
        const { importInstrumentDefinition } =
            require("instrument/import-instrument-definition") as typeof ImportInstrumentDefinitionModule;
        importInstrumentDefinition(filePath);
    }
);

ipcRenderer.on("show-about-box", async () => {
    showAboutBox();
});

ipcRenderer.on(
    "open-project",
    async (sender: any, filePath: any, runMode: boolean) => {
        openProject(filePath, runMode);
    }
);

ipcRenderer.on(
    "build-project",
    async (sender: any, filePath: any, runMode: boolean) => {
        buildProject(filePath);
    }
);

ipcRenderer.on("load-debug-info", async (sender: any, filePath: any) => {
    try {
        let tab = tabs.activeTab;
        if (tab instanceof ProjectEditorTab) {
            tab.loadDebugInfo(filePath);
        }
    } catch (err) {
        console.error(err);
    }
});

ipcRenderer.on("save-debug-info", () => {
    try {
        let tab = tabs.activeTab;
        if (tab instanceof ProjectEditorTab) {
            tab.saveDebugInfo();
        }
    } catch (err) {
        console.error(err);
    }
});

ipcRenderer.on("new-project", async (sender: any, filePath: any) => {
    const { showNewProjectWizard } = await import(
        "project-editor/project/ui/Wizard"
    );
    showNewProjectWizard();
});

ipcRenderer.on("add-instrument", async (sender: any, filePath: any) => {
    const { showAddInstrumentDialog } = await import(
        "instrument/add-instrument-dialog"
    );

    const { defaultInstrumentsStore } = await import("home/instruments");

    showAddInstrumentDialog(instrumentId => {
        setTimeout(() => {
            defaultInstrumentsStore.selectedInstrumentId = instrumentId;
        }, 100);
    });
});

const Main = observer(
    class Main extends React.Component<{ children: React.ReactNode }> {
        render() {
            return (
                <>
                    {this.props.children}
                    {notification.container}
                </>
            );
        }
    }
);

async function main() {
    const params = new URLSearchParams(location.search);
    const buildProject = params.get("build-project") === "1";

    let nodeModuleFolders: string[];
    try {
        nodeModuleFolders = await getNodeModuleFolders();
    } catch (err) {
        console.info(`Failed to get node module folders.`);
        nodeModuleFolders = [];
    }

    await loadExtensions(nodeModuleFolders);
    extensionPlatformDisposables.push(
        startDeclarativeExtensionContributionHost({
            onUnregisterHomeSections(sectionIds) {
                for (const sectionId of sectionIds) {
                    tabs.findTab(`homeSection_${sectionId}`)?.close?.();
                }
            }
        })
    );

    extensionsCatalog.load();

    if (!buildProject) {
        loadTabs();

        registerProjectExtensionServices();
        extensionPlatformDisposables.push(startProjectExtensionEvents());
        studioExtensionServiceHost.markReady(
            Array.from(extensions.values())
                .filter(extension => extension.extensionType == "extension-v1")
                .map(extension => extension.id)
                .sort()
        );

        const root = createRoot(document.getElementById("EezStudio_Content")!);
        root.render(
            <Main>
                <App />
                <LineMarkers />
            </Main>
        );

        handleDragAndDrop();
    }

    ipcRenderer.send("open-command-line-project");
}

void main().catch(error => {
    console.error("Failed to initialize the Studio home window", error);
});

// setTimeout(() => {
//     require("eez-studio-shared/module-stat");
// }, 1000);
