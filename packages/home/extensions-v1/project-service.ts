import crypto from "crypto";
import { action, reaction } from "mobx";
import { ipcRenderer } from "electron";
import path from "path";

import { ProjectEditorTab, tabs } from "home/tabs-store";
import {
    getJSON,
    ProjectStore
} from "project-editor/store";
import { createObject } from "project-editor/store/serialization";
import { objectToJS } from "project-editor/store/helper";
import { visitObjects } from "project-editor/core/search";
import {
    eezClassToClassNameMap,
    getAllClasses,
    getClassByName,
    getClassInfo,
    getParent,
    EezObject,
    IEezObject,
    PropertyType,
    TYPE_NAMES
} from "project-editor/core/object";
import { Section } from "project-editor/store/output-sections";
import { ProjectEditor } from "project-editor/project-editor-interface";

import {
    StudioServiceRequest,
    studioExtensionServiceHost
} from "home/extensions-v1/service-host";
import {
    findObjectByObjID,
    isChildCollectionSchema,
    isPlainRecord,
    isValidStudioCreateValue,
    isValidStudioScalarValue
} from "home/extensions-v1/project-service-utils";
import { registerInteractionExtensionServices } from "home/extensions-v1/interaction-service";
import { describeObjectClass } from "home/extensions-v1/schema";

interface ProjectHandleDto {
    projectId: string;
    uri?: string;
    title: string;
    ready: boolean;
    dirty: boolean;
    active: boolean;
    revision: string;
    diskHash?: string;
}

type ProjectEdit =
    | {
          kind: "create";
          temporaryId?: string;
          parentId: string;
          property: string;
          type: string;
          properties: Record<string, unknown>;
      }
    | {
          kind: "update";
          objectId: string;
          properties: Record<string, unknown>;
      }
    | { kind: "delete"; objectId: string }
    | {
          kind: "move";
          objectId: string;
          parentId: string;
          property: string;
          index?: number;
      };

const EDIT_KEYS: Record<ProjectEdit["kind"], Set<string>> = {
    create: new Set([
        "kind",
        "temporaryId",
        "parentId",
        "property",
        "type",
        "properties"
    ]),
    update: new Set(["kind", "objectId", "properties"]),
    delete: new Set(["kind", "objectId"]),
    move: new Set([
        "kind",
        "objectId",
        "parentId",
        "property",
        "index"
    ])
};

function serviceError(code: string, message: string): never {
    const error = new Error(message) as Error & { code: string };
    error.code = code;
    throw error;
}

function toJsonValue(value: unknown) {
    if (value == undefined) {
        return null;
    }
    return JSON.parse(JSON.stringify(value));
}

class ProjectHandleRegistry {
    private ids = new WeakMap<ProjectEditorTab, string>();

    id(tab: ProjectEditorTab) {
        let id = this.ids.get(tab);
        if (!id) {
            id = crypto.randomUUID();
            this.ids.set(tab, id);
        }
        return id;
    }

    find(projectId: string) {
        return tabs.tabs.find(
            tab =>
                tab instanceof ProjectEditorTab && this.id(tab) === projectId
        ) as ProjectEditorTab | undefined;
    }

    dto(tab: ProjectEditorTab): ProjectHandleDto {
        const store = tab.projectStore as
            | (ProjectStore & { publicRevision?: string; diskHash?: string })
            | undefined;
        return {
            projectId: this.id(tab),
            uri: store?.filePath,
            title: store?.title ?? tab.titleStr,
            ready: !!store?.project?._fullyLoaded,
            dirty: !!store?.isModified,
            active: tabs.activeTab === tab,
            revision: store?.publicRevision ?? "loading",
            diskHash: store?.diskHash
        };
    }
}

const handles = new ProjectHandleRegistry();

export function startProjectExtensionEvents() {
    const dispose = reaction(
        () =>
            tabs.tabs
                .filter(tab => tab instanceof ProjectEditorTab && !tab.runMode)
                .map(tab => handles.dto(tab as ProjectEditorTab)),
        projects => {
            ipcRenderer.send("eez-extension-v1/studio-event", {
                type: "workspace.changed",
                projects
            });
        },
        { fireImmediately: true }
    );
    return { dispose };
}

function requireTab(projectId: string) {
    const tab = handles.find(projectId);
    if (!tab) {
        serviceError("PROJECT_NOT_FOUND", `Unknown project: ${projectId}`);
    }
    return tab;
}

export function requireStore(projectId: string) {
    const tab = requireTab(projectId);
    if (!tab.projectStore || !tab.projectStore.project?._fullyLoaded) {
        serviceError("PROJECT_NOT_READY", `Project is not ready: ${projectId}`);
    }
    return { tab, store: tab.projectStore };
}

function requireObject(store: ProjectStore, objectId: string) {
    const object = findObjectByObjID(visitObjects(store.project), objectId);
    if (!object) {
        serviceError("OBJECT_NOT_FOUND", `Unknown object: ${objectId}`);
    }
    return object as EezObject;
}

const FORBIDDEN_PROPERTY_NAMES = new Set([
    "__proto__",
    "constructor",
    "prototype",
    "objID",
    "_store"
]);

function validateProperties(
    objectClass: { classInfo: { properties: any[] } },
    properties: unknown,
    operation: "create" | "update",
    object?: EezObject
) {
    if (!isPlainRecord(properties)) {
        serviceError("INVALID_ARGUMENT", "properties must be a plain object");
    }
    const propertyMap = new Map(
        objectClass.classInfo.properties.map(property => [property.name, property])
    );
    for (const propertyName of Object.keys(properties)) {
        const property = propertyMap.get(propertyName);
        if (
            FORBIDDEN_PROPERTY_NAMES.has(propertyName) ||
            !property ||
            (property.computed && !property.modifiable)
        ) {
            serviceError(
                "INVALID_PROPERTY",
                `${propertyName} is not writable for ${operation}`
            );
        }

        const type = TYPE_NAMES[property.type as PropertyType];
        let enumIds: (string | number)[] | undefined;
        if (property.type == PropertyType.Enum) {
            const enumItems =
                typeof property.enumItems == "function"
                    ? object
                        ? property.enumItems(object)
                        : undefined
                    : property.enumItems;
            if (Array.isArray(enumItems)) {
                enumIds = enumItems.map((item: any) =>
                    item != null && typeof item == "object" ? item.id : item
                );
            }
        }

        const value = properties[propertyName];
        const valid =
            operation == "update"
                ? isValidStudioScalarValue(type, value, enumIds)
                : isValidStudioCreateValue(
                      type,
                      value,
                      property.typeClass != undefined,
                      enumIds
                  );
        if (!valid) {
            serviceError(
                "INVALID_PROPERTY_VALUE",
                `${propertyName} must be a valid ${type} value for ${operation}`
            );
        }
    }
    return properties;
}

function validateEdit(value: unknown): ProjectEdit {
    if (!isPlainRecord(value) || typeof value.kind != "string") {
        serviceError("INVALID_ARGUMENT", "Each edit must be an object");
    }
    if (!(value.kind in EDIT_KEYS)) {
        serviceError("INVALID_ARGUMENT", `Unknown edit kind: ${value.kind}`);
    }
    const kind = value.kind as ProjectEdit["kind"];
    for (const key of Object.keys(value)) {
        if (!EDIT_KEYS[kind].has(key)) {
            serviceError("INVALID_ARGUMENT", `Unknown ${kind} edit field: ${key}`);
        }
    }
    const requireId = (field: string) => {
        if (
            typeof value[field] != "string" ||
            value[field].length == 0 ||
            value[field].length > 256
        ) {
            serviceError("INVALID_ARGUMENT", `${field} must be a non-empty string`);
        }
    };
    if (kind == "create") {
        requireId("parentId");
        requireId("property");
        requireId("type");
        if (value.temporaryId != undefined) {
            requireId("temporaryId");
        }
        if (!isPlainRecord(value.properties)) {
            serviceError("INVALID_ARGUMENT", "create properties must be an object");
        }
    } else {
        requireId("objectId");
        if (kind == "update" && !isPlainRecord(value.properties)) {
            serviceError("INVALID_ARGUMENT", "update properties must be an object");
        }
        if (kind == "move") {
            requireId("parentId");
            requireId("property");
            if (
                value.index != undefined &&
                (!Number.isSafeInteger(value.index) || (value.index as number) < 0)
            ) {
                serviceError("INVALID_ARGUMENT", "move index must be a non-negative integer");
            }
        }
    }
    return value as unknown as ProjectEdit;
}

function requireChildArray(
    store: ProjectStore,
    parentId: string,
    property: string
) {
    const parent = requireObject(store, parentId) as any;
    const propertyInfo = getClassInfo(parent).properties.find(
        propertyInfo => propertyInfo.name == property
    );
    if (
        !propertyInfo ||
        !isChildCollectionSchema(
            TYPE_NAMES[propertyInfo.type],
            propertyInfo.typeClass != undefined
        )
    ) {
        serviceError("INVALID_PARENT", `Unknown child property: ${property}`);
    }
    const childArray = parent[property];
    if (!Array.isArray(childArray)) {
        serviceError(
            "INVALID_PARENT",
            `Property ${property} on ${parentId} is not a child collection`
        );
    }
    return {
        parent,
        childArray: childArray as EezObject[],
        propertyInfo
    };
}

function assertChildType(
    propertyInfo: { typeClass?: new (...args: any[]) => any },
    object: EezObject
) {
    if (!propertyInfo.typeClass || !(object instanceof propertyInfo.typeClass)) {
        serviceError(
            "INVALID_CHILD_TYPE",
            "Object type is not compatible with the target collection"
        );
    }
}

function moveObject(
    store: ProjectStore,
    object: EezObject,
    targetArray: EezObject[],
    requestedIndex?: number
) {
    const oldArray = getParent(object);
    if (!Array.isArray(oldArray)) {
        serviceError("INVALID_MOVE", "Only collection items can be moved");
    }
    const oldIndex = oldArray.indexOf(object);
    if (oldIndex < 0) {
        serviceError("INVALID_MOVE", "Object is detached from its parent");
    }
    if (oldArray !== targetArray) {
        serviceError(
            "INVALID_MOVE",
            "Cross-collection moves are not supported by the v1 API"
        );
    }
    const targetIndex =
        requestedIndex == undefined ? targetArray.length : requestedIndex;
    if (!Number.isSafeInteger(targetIndex) || targetIndex < 0) {
        serviceError("INVALID_ARGUMENT", "Move index must be a non-negative integer");
    }

    const removeFromCollection = () => {
        const currentIndex = targetArray.indexOf(object);
        if (currentIndex < 0) {
            throw new Error("Moved object is missing from its collection parent");
        }
        targetArray.splice(currentIndex, 1);
    };

    store.undoManager.executeCommand({
        execute: action(() => {
            removeFromCollection();
            const index = Math.min(targetIndex, targetArray.length);
            targetArray.splice(index, 0, object);
        }),
        undo: action(() => {
            removeFromCollection();
            oldArray.splice(Math.min(oldIndex, oldArray.length), 0, object);
        }),
        description: "Move object"
    });
}

function applyEdit(
    store: ProjectStore,
    edit: ProjectEdit,
    temporaryIds: Map<string, string>
) {
    const resolveId = (id: string) => temporaryIds.get(id) ?? id;
    if (edit.kind === "create") {
        const parentId = resolveId(edit.parentId);
        const { childArray, propertyInfo } = requireChildArray(
            store,
            parentId,
            edit.property
        );
        const objectClass = getClassByName(store, edit.type);
        if (!objectClass) {
            serviceError("UNKNOWN_OBJECT_TYPE", `Unknown type: ${edit.type}`);
        }
        const object = createObject(
            store,
            validateProperties(objectClass, edit.properties, "create") as any,
            objectClass
        );
        assertChildType(propertyInfo, object);
        store.addObject(childArray as unknown as IEezObject, object);
        if (edit.temporaryId) {
            temporaryIds.set(edit.temporaryId, object.objID);
        }
        return;
    }
    const object = requireObject(store, resolveId(edit.objectId));
    if (edit.kind === "update") {
        store.updateObject(
            object,
            validateProperties(
                object.constructor as typeof EezObject,
                edit.properties,
                "update",
                object
            )
        );
    } else if (edit.kind === "delete") {
        store.deleteObject(object);
    } else {
        const { childArray, propertyInfo } = requireChildArray(
            store,
            resolveId(edit.parentId),
            edit.property
        );
        assertChildType(propertyInfo, object);
        moveObject(store, object, childArray, edit.index);
    }
}

async function workspaceService(request: StudioServiceRequest) {
    const args = (request.args ?? {}) as any;
    if (request.method === "list") {
        return tabs.tabs
            .filter(tab => tab instanceof ProjectEditorTab && !tab.runMode)
            .map(tab => handles.dto(tab as ProjectEditorTab));
    }
    if (request.method === "activate") {
        const tab = requireTab(args.projectId);
        tab.makeActive();
        return handles.dto(tab);
    }
    if (request.method === "open") {
        if (typeof args.uri !== "string" || !args.uri) {
            serviceError("INVALID_ARGUMENT", "A project URI is required");
        }
        let tab = tabs.findProjectEditorTab(args.uri, false);
        if (!tab) {
            tab = tabs.addProjectTab(args.uri, false);
        }
        tab.makeActive();
        if (!tab.projectStore) {
            await tab.loadProject();
        }
        return handles.dto(tab);
    }
    if (request.method === "reload") {
        const tab = requireTab(args.projectId);
        if (tab.projectStore?.isModified && !args.discardChanges) {
            serviceError(
                "DIRTY_PROJECT",
                "Reload requires discardChanges for a modified project"
            );
        }
        await tab.reloadProject();
        while (!tab.projectStore?.project?._fullyLoaded) {
            if (request.signal.aborted || request.deadline <= Date.now()) {
                serviceError("CANCELLED", "Project reload was cancelled");
            }
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        return handles.dto(tab);
    }
    if (request.method === "close") {
        const tab = requireTab(args.projectId);
        await tab.close();
        return { closed: tab.closed };
    }
    serviceError("METHOD_NOT_FOUND", `Unknown workspace method: ${request.method}`);
}

export async function projectService(request: StudioServiceRequest) {
    const args = (request.args ?? {}) as any;
    const { tab, store } = requireStore(args.projectId);
    if (request.method === "describe") {
        return handles.dto(tab);
    }
    if (request.method === "snapshot") {
        const json = getJSON(store);
        const cursor = Math.max(0, Number(args.cursor ?? args.offset ?? 0));
        const limit = Math.max(1, Math.min(Number(args.limit ?? 65536), 1048576));
        if (!Number.isSafeInteger(cursor) || !Number.isSafeInteger(limit)) {
            serviceError(
                "INVALID_ARGUMENT",
                "Snapshot cursor and limit must be integers"
            );
        }
        return {
            projectId: args.projectId,
            revision: (store as any).publicRevision,
            cursor,
            cursorUnit: "utf16-code-unit",
            totalCharacters: json.length,
            totalBytes: Buffer.byteLength(json, "utf8"),
            content: json.substring(cursor, cursor + limit),
            nextCursor: cursor + limit < json.length ? cursor + limit : undefined,
            hash: crypto.createHash("sha256").update(json).digest("hex")
        };
    }
    if (request.method === "getObject") {
        const object = requireObject(store, args.objectId);
        return {
            projectId: args.projectId,
            revision: (store as any).publicRevision,
            objectId: object.objID,
            type:
                eezClassToClassNameMap.get(object.constructor as any) ??
                object.constructor.name,
            value: toJsonValue(objectToJS(object))
        };
    }
    if (request.method === "getSchema") {
        const objectClasses = new Map(
            getAllClasses().map(objectClass => [
                eezClassToClassNameMap.get(objectClass) ?? objectClass.name,
                objectClass
            ])
        );
        for (const [type, objectClass] of store.importedActionComponentClasses) {
            objectClasses.set(type, objectClass);
        }
        return Array.from(objectClasses, ([, objectClass]) =>
            describeObjectClass(objectClass)
        );
    }
    if (request.method === "applyEdits") {
        const edits = args.edits as unknown[];
        if (!Array.isArray(edits) || edits.length === 0 || edits.length > 1000) {
            serviceError("INVALID_ARGUMENT", "At least one edit is required");
        }
        const validatedEdits = edits.map(validateEdit);
        const declaredTemporaryIds = new Set<string>();
        for (const edit of validatedEdits) {
            if (edit.kind != "create" || edit.temporaryId == undefined) {
                continue;
            }
            if (
                declaredTemporaryIds.has(edit.temporaryId) ||
                findObjectByObjID(
                    visitObjects(store.project),
                    edit.temporaryId
                ) != undefined
            ) {
                serviceError(
                    "INVALID_ARGUMENT",
                    `Duplicate or conflicting temporaryId: ${edit.temporaryId}`
                );
            }
            declaredTemporaryIds.add(edit.temporaryId);
        }
        const label = args.label ?? "Extension edit";
        if (
            typeof label != "string" ||
            label.length == 0 ||
            label.length > 120 ||
            label.trim() != label ||
            /[\u0000-\u001f\u007f]/.test(label)
        ) {
            serviceError(
                "INVALID_ARGUMENT",
                "Transaction label must be a trimmed string of at most 120 characters"
            );
        }
        const temporaryIds = new Map<string, string>();
        const execute = () => {
            for (const edit of validatedEdits) {
                applyEdit(store, edit, temporaryIds);
            }
        };
        const runTransaction = (store as any).runTransaction;
        if (typeof runTransaction !== "function") {
            serviceError(
                "TRANSACTIONS_UNAVAILABLE",
                "Project transaction service is unavailable"
            );
        }
        runTransaction.call(
            store,
            label,
            args.expectedRevision,
            execute
        );
        return {
            projectId: args.projectId,
            revision: (store as any).publicRevision,
            temporaryIds: Object.fromEntries(temporaryIds),
            dirty: store.isModified
        };
    }
    if (request.method === "save") {
        await (store as any).save({
            expectedRevision: args.expectedRevision,
            expectedDiskHash: args.expectedDiskHash
        });
        return handles.dto(tab);
    }
    if (request.method === "undo") {
        store.assertRevision(args.expectedRevision);
        store.undoManager.undo();
        return handles.dto(tab);
    }
    if (request.method === "redo") {
        store.assertRevision(args.expectedRevision);
        store.undoManager.redo();
        return handles.dto(tab);
    }
    serviceError("METHOD_NOT_FOUND", `Unknown project method: ${request.method}`);
}

async function buildService(request: StudioServiceRequest) {
    const args = (request.args ?? {}) as any;
    const { store } = requireStore(args.projectId);
    const option = request.method === "check" ? "check" : "buildFiles";
    let buildRevision: string | undefined;
    const result = await ProjectEditor.build.buildProject(store, option, {
        signal: request.signal,
        expectedRevision: args.expectedRevision,
        onStartRevision(revision) {
            buildRevision = revision;
        }
    });
    if (buildRevision == undefined) {
        serviceError("INTERNAL", "Build did not report its project revision");
    }
    const output = store.outputSectionsStore.getSection(Section.OUTPUT);
    return {
        projectId: args.projectId,
        revision: buildRevision,
        ok: output.numErrors === 0,
        result: toJsonValue(result)
    };
}

async function runtimeService(request: StudioServiceRequest) {
    const args = (request.args ?? {}) as any;
    const { store } = requireStore(args.projectId);
    if (request.method === "status") {
        return {
            state: store.runtime
                ? store.runtime.isPaused
                    ? "paused"
                    : store.runtime.isRunning
                      ? "running"
                      : store.runtime.isStopped
                        ? "stopped"
                        : "starting"
                : "stopped",
            debugger: !!store.runtime?.isDebuggerActive,
            error:
                store.runtime?.error == undefined
                    ? undefined
                    : String(store.runtime.error)
        };
    }
    if (request.method === "start") {
        if (!store.runtime) {
            store.setRuntimeMode(!!args.debugger);
        }
    } else if (request.method === "stop") {
        await store.setEditorMode(true);
    } else if (request.method === "pause") {
        store.runtime?.pause();
    } else if (request.method === "resume") {
        store.runtime?.resume();
    } else if (request.method === "step") {
        if (!store.runtime?.isPaused) {
            serviceError("INVALID_RUNTIME_STATE", "Runtime is not paused");
        }
        const mode = args.mode ?? "step-over";
        if (!new Set(["step-into", "step-over", "step-out"]).has(mode)) {
            serviceError("INVALID_ARGUMENT", "Unknown single-step mode");
        }
        store.runtime.runSingleStep(mode);
    } else {
        serviceError("METHOD_NOT_FOUND", `Unknown runtime method: ${request.method}`);
    }
    return runtimeService({ ...request, method: "status" });
}

async function editorService(request: StudioServiceRequest) {
    const args = (request.args ?? {}) as any;
    const { store } = requireStore(args.projectId);
    const object = requireObject(store, args.objectId);
    if (request.method === "navigate") {
        ProjectEditor.navigateTo(object);
        return { navigated: true, objectId: object.objID };
    }
    if (request.method === "select") {
        ProjectEditor.selectObject(object);
        return { selected: true, objectId: object.objID };
    }
    serviceError("METHOD_NOT_FOUND", `Unknown editor method: ${request.method}`);
}

async function extensionHostService(request: StudioServiceRequest) {
    if (request.method != "workspaceScope") {
        serviceError("METHOD_NOT_FOUND", "Unknown internal extension host method");
    }
    const args = (request.args ?? {}) as any;
    if (typeof args.projectId == "string") {
        const { store } = requireStore(args.projectId);
        return store.filePath ? path.dirname(store.filePath) : args.projectId;
    }
    if (typeof args.uri == "string" && args.uri) {
        return path.dirname(path.resolve(args.uri));
    }
    return "global";
}

export function registerProjectExtensionServices() {
    return [
        studioExtensionServiceHost.register("workspace", workspaceService),
        studioExtensionServiceHost.register("project", projectService),
        studioExtensionServiceHost.register("build", buildService),
        studioExtensionServiceHost.register("runtime", runtimeService),
        studioExtensionServiceHost.register("editor", editorService),
        studioExtensionServiceHost.register(
            "$extensionHost",
            extensionHostService
        ),
        ...registerInteractionExtensionServices({
            resolveProject(projectId) {
                return requireStore(projectId);
            },
            applyProjectEdits(request) {
                return projectService(request);
            }
        }).map(({ service, handler }) =>
            studioExtensionServiceHost.register(service, handler)
        )
    ];
}
