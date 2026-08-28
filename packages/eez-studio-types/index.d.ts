import type { Stream } from "stream";

////////////////////////////////////////////////////////////////////////////////

/** Public contract version implemented by Extension Platform V1. */
export const EXTENSION_API_VERSION: "1.0";
export const API_VERSION: typeof EXTENSION_API_VERSION;

export type ExtensionApiVersion = typeof EXTENSION_API_VERSION;
export type ExtensionHostKind = "sandbox";
export type ExtensionMode = "production" | "development" | "test";
export type ExtensionDeactivationReason =
    | "reload"
    | "uninstall"
    | "shutdown"
    | "replace"
    | "activation-error";

export interface Disposable {
    dispose(): void | Promise<void>;
}

export type Event<T> = (
    listener: (event: T) => void | Promise<void>,
    thisArg?: unknown,
    disposables?: Disposable[]
) => Disposable;

export type ExtensionCapability =
    | "project.read"
    | "project.write"
    | "project.manage"
    | "build.execute"
    | "runtime.control"
    | "input.inject"
    | "asset.import"
    | "screenshot.capture"
    | "storage.secure";

export type ExtensionJsonValue =
    | null
    | boolean
    | number
    | string
    | readonly ExtensionJsonValue[]
    | { readonly [key: string]: ExtensionJsonValue };

export interface ExtensionCommandContribution {
    readonly id: string;
    readonly title: string;
}

export interface ExtensionHomeSectionContribution {
    readonly id: string;
    readonly title: string;
    readonly icon: string;
    readonly category?: "none" | "common" | "instrument";
    readonly commands?: readonly ExtensionCommandContribution[];
}

export interface ExtensionContributions {
    readonly homeSections?: readonly ExtensionHomeSectionContribution[];
}

/** The normalized contents of the `eez-studio` package manifest property. */
export interface ExtensionManifest {
    apiVersion: ExtensionApiVersion;
    host: ExtensionHostKind;
    browser: string;
    activationEvents?: readonly string[];
    capabilities?: readonly ExtensionCapability[];
    allowedOrigins?: readonly string[];
    contributes?: ExtensionContributions;
}

export interface ExtensionLogger {
    trace(message: string, ...args: unknown[]): void;
    debug(message: string, ...args: unknown[]): void;
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
}

export interface ExtensionStorage {
    get<T>(key: string, defaultValue?: T): Promise<T | undefined>;
    update(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    keys(): Promise<readonly string[]>;
}

export interface ExtensionSecrets {
    get(key: string): Promise<string | undefined>;
    store(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
}

export interface ExtensionServiceDescriptor {
    service: string;
    method: string;
}

export interface ExtensionServiceRequest<TParams = unknown>
    extends ExtensionServiceDescriptor {
    requestId?: string;
    params?: TParams;
}

export interface ExtensionServiceError {
    code: string;
    message: string;
    data?: ExtensionJsonValue;
}

export interface ExtensionServiceResponse<TResult = unknown> {
    requestId?: string;
    ok: boolean;
    result?: TResult;
    error?: ExtensionServiceError;
}

export type ExtensionServiceHandler<TParams = unknown, TResult = unknown> = (
    request: ExtensionServiceRequest<TParams>,
    signal: AbortSignal
) => TResult | Promise<TResult>;

export interface ExtensionServiceRegistry {
    register<TParams = unknown, TResult = unknown>(
        descriptor: ExtensionServiceDescriptor,
        handler: ExtensionServiceHandler<TParams, TResult>
    ): Disposable;

    request<TParams = unknown, TResult = unknown>(
        request: ExtensionServiceRequest<TParams>,
        signal?: AbortSignal
    ): Promise<ExtensionServiceResponse<TResult>>;
}

export interface ExtensionContext {
    readonly id: string;
    readonly version: string;
    readonly apiVersion: ExtensionApiVersion;
    readonly mode: ExtensionMode;
    readonly log: ExtensionLogger;
    readonly storage: ExtensionStorage;
    readonly secrets: ExtensionSecrets;
    readonly signal: AbortSignal;
    readonly subscriptions: Disposable[];
    readonly services: ExtensionServiceRegistry;
}

export interface ExtensionModule {
    activate(
        context: ExtensionContext
    ): void | Disposable | Promise<void | Disposable>;
    deactivate?(
        reason: ExtensionDeactivationReason
    ): void | Promise<void>;
}

/** Opaque identifiers and concurrency tokens used by Studio services. */
export type StudioProjectId = string;
export type StudioObjectId = string;
export type StudioRevision = string;
export type StudioContentHash = string;
export type StudioUri = string;

export type StudioServiceName =
    | "workspace"
    | "project"
    | "build"
    | "runtime"
    | "editor";

/** Stable error codes that may be reported by the sandbox service host. */
export type StudioServiceErrorCode =
    | "SERVICE_NOT_FOUND"
    | "METHOD_NOT_FOUND"
    | "INVALID_ARGUMENT"
    | "CAPABILITY_NOT_DECLARED"
    | "CAPABILITY_NOT_GRANTED"
    | "GRANT_EXPIRED"
    | "PERMISSION_DENIED"
    | "PERMISSION_REVOKED"
    | "PROJECT_NOT_FOUND"
    | "PROJECT_NOT_READY"
    | "DIRTY_PROJECT"
    | "CANCELLED"
    | "DEADLINE_EXCEEDED"
    | "REQUEST_TOO_LARGE"
    | "RESPONSE_TOO_LARGE"
    | "TOO_MANY_REQUESTS"
    | "OBJECT_NOT_FOUND"
    | "INVALID_PROPERTY"
    | "INVALID_PROPERTY_VALUE"
    | "INVALID_PARENT"
    | "INVALID_CHILD_TYPE"
    | "INVALID_MOVE"
    | "UNKNOWN_OBJECT_TYPE"
    | "TRANSACTIONS_UNAVAILABLE"
    | "PROJECT_REVISION_CONFLICT"
    | "PROJECT_TRANSACTION_ROLLBACK_FAILED"
    | "PROJECT_DISK_HASH_CONFLICT"
    | "INVALID_RUNTIME_STATE"
    | "STUDIO_SERVICE_ERROR"
    | "SERVICE_ERROR"
    | "INTERNAL";

export interface StudioServiceCallError extends Error {
    readonly code: StudioServiceErrorCode;
}

export type StudioEmptyParams = Readonly<Record<string, never>>;

export interface StudioProjectHandle {
    readonly projectId: StudioProjectId;
    readonly uri?: StudioUri;
    readonly title: string;
    readonly ready: boolean;
    readonly dirty: boolean;
    readonly active: boolean;
    readonly revision: StudioRevision;
    readonly diskHash?: StudioContentHash;
}

export type StudioWorkspaceListParams = StudioEmptyParams;
export type StudioWorkspaceListResult = readonly StudioProjectHandle[];

export interface StudioWorkspaceActivateParams {
    readonly projectId: StudioProjectId;
}

export interface StudioWorkspaceOpenParams {
    readonly uri: StudioUri;
}

export interface StudioWorkspaceReloadParams {
    readonly projectId: StudioProjectId;
    readonly discardChanges?: boolean;
}

export interface StudioWorkspaceCloseParams {
    readonly projectId: StudioProjectId;
}

export interface StudioWorkspaceCloseResult {
    readonly closed: boolean;
}

export interface StudioProjectParams {
    readonly projectId: StudioProjectId;
}

export type StudioProjectDescribeParams = StudioProjectParams;

export interface StudioProjectSnapshotParams extends StudioProjectParams {
    /** Zero-based UTF-16 code-unit cursor. `offset` is a compatibility alias. */
    readonly cursor?: number;
    readonly offset?: number;
    readonly limit?: number;
}

export interface StudioProjectSnapshotResult {
    readonly projectId: StudioProjectId;
    readonly revision: StudioRevision;
    readonly cursor: number;
    readonly cursorUnit: "utf16-code-unit";
    readonly totalCharacters: number;
    readonly totalBytes: number;
    readonly content: string;
    readonly nextCursor?: number;
    readonly hash: StudioContentHash;
}

export interface StudioProjectGetObjectParams extends StudioProjectParams {
    readonly objectId: StudioObjectId;
}

export interface StudioProjectObject {
    readonly projectId: StudioProjectId;
    readonly revision: StudioRevision;
    readonly objectId: StudioObjectId;
    readonly type: string;
    readonly value: ExtensionJsonValue;
}

export interface StudioSchemaProperty {
    readonly name: string;
    readonly type: string;
    readonly required: boolean;
    /** True when requiredness depends on the concrete object instance. */
    readonly conditionallyRequired?: true;
    readonly readOnly: boolean;
}

export interface StudioSchemaObjectType {
    readonly type: string;
    readonly properties: readonly StudioSchemaProperty[];
}

export type StudioProjectGetSchemaParams = StudioProjectParams;
export type StudioProjectGetSchemaResult = readonly StudioSchemaObjectType[];

export interface StudioProjectCreateEdit {
    readonly kind: "create";
    readonly temporaryId?: string;
    readonly parentId: StudioObjectId;
    readonly property: string;
    readonly type: string;
    readonly properties: Readonly<Record<string, ExtensionJsonValue>>;
}

export interface StudioProjectUpdateEdit {
    readonly kind: "update";
    readonly objectId: StudioObjectId;
    readonly properties: Readonly<Record<string, ExtensionJsonValue>>;
}

export interface StudioProjectDeleteEdit {
    readonly kind: "delete";
    readonly objectId: StudioObjectId;
}

export interface StudioProjectMoveEdit {
    readonly kind: "move";
    readonly objectId: StudioObjectId;
    readonly parentId: StudioObjectId;
    readonly property: string;
    readonly index?: number;
}

export type StudioProjectEdit =
    | StudioProjectCreateEdit
    | StudioProjectUpdateEdit
    | StudioProjectDeleteEdit
    | StudioProjectMoveEdit;

export interface StudioProjectApplyEditsParams extends StudioProjectParams {
    readonly label?: string;
    readonly expectedRevision?: StudioRevision;
    readonly edits: readonly StudioProjectEdit[];
}

export interface StudioProjectApplyEditsResult {
    readonly projectId: StudioProjectId;
    readonly revision: StudioRevision;
    readonly temporaryIds: Readonly<Record<string, StudioObjectId>>;
    readonly dirty: boolean;
}

export interface StudioProjectSaveParams extends StudioProjectParams {
    readonly expectedRevision?: StudioRevision;
    readonly expectedDiskHash?: StudioContentHash;
}

export interface StudioProjectUndoParams extends StudioProjectParams {
    readonly expectedRevision?: StudioRevision;
}

export type StudioProjectRedoParams = StudioProjectUndoParams;

export interface StudioBuildParams extends StudioProjectParams {
    readonly expectedRevision?: StudioRevision;
}

export interface StudioBuildResult {
    readonly projectId: StudioProjectId;
    readonly revision: StudioRevision;
    readonly ok: boolean;
    readonly result: ExtensionJsonValue;
}

export type StudioRuntimeState =
    | "stopped"
    | "starting"
    | "running"
    | "paused";

export interface StudioRuntimeStatus {
    readonly state: StudioRuntimeState;
    readonly debugger: boolean;
    readonly error?: string;
}

export type StudioRuntimeStatusParams = StudioProjectParams;

export interface StudioRuntimeStartParams extends StudioProjectParams {
    readonly debugger?: boolean;
}

export type StudioRuntimeStopParams = StudioProjectParams;
export type StudioRuntimePauseParams = StudioProjectParams;
export type StudioRuntimeResumeParams = StudioProjectParams;

export interface StudioRuntimeStepParams extends StudioProjectParams {
    readonly mode?: "step-into" | "step-over" | "step-out";
}

export interface StudioEditorObjectParams extends StudioProjectParams {
    readonly objectId: StudioObjectId;
}

export type StudioEditorNavigateParams = StudioEditorObjectParams;
export type StudioEditorSelectParams = StudioEditorObjectParams;

export interface StudioEditorNavigateResult {
    readonly navigated: true;
    readonly objectId: StudioObjectId;
}

export interface StudioEditorSelectResult {
    readonly selected: true;
    readonly objectId: StudioObjectId;
}

export interface StudioServiceMethod<TParams, TResult> {
    readonly params: TParams;
    readonly result: TResult;
}

/** Compile-time map for every public Studio service operation in API 1.0. */
export interface StudioServiceContract {
    readonly workspace: {
        readonly list: StudioServiceMethod<
            StudioWorkspaceListParams,
            StudioWorkspaceListResult
        >;
        readonly activate: StudioServiceMethod<
            StudioWorkspaceActivateParams,
            StudioProjectHandle
        >;
        readonly open: StudioServiceMethod<
            StudioWorkspaceOpenParams,
            StudioProjectHandle
        >;
        readonly reload: StudioServiceMethod<
            StudioWorkspaceReloadParams,
            StudioProjectHandle
        >;
        readonly close: StudioServiceMethod<
            StudioWorkspaceCloseParams,
            StudioWorkspaceCloseResult
        >;
    };
    readonly project: {
        readonly describe: StudioServiceMethod<
            StudioProjectDescribeParams,
            StudioProjectHandle
        >;
        readonly snapshot: StudioServiceMethod<
            StudioProjectSnapshotParams,
            StudioProjectSnapshotResult
        >;
        readonly getObject: StudioServiceMethod<
            StudioProjectGetObjectParams,
            StudioProjectObject
        >;
        readonly getSchema: StudioServiceMethod<
            StudioProjectGetSchemaParams,
            StudioProjectGetSchemaResult
        >;
        readonly applyEdits: StudioServiceMethod<
            StudioProjectApplyEditsParams,
            StudioProjectApplyEditsResult
        >;
        readonly save: StudioServiceMethod<
            StudioProjectSaveParams,
            StudioProjectHandle
        >;
        readonly undo: StudioServiceMethod<
            StudioProjectUndoParams,
            StudioProjectHandle
        >;
        readonly redo: StudioServiceMethod<
            StudioProjectRedoParams,
            StudioProjectHandle
        >;
    };
    readonly build: {
        readonly check: StudioServiceMethod<
            StudioBuildParams,
            StudioBuildResult
        >;
        readonly run: StudioServiceMethod<StudioBuildParams, StudioBuildResult>;
    };
    readonly runtime: {
        readonly status: StudioServiceMethod<
            StudioRuntimeStatusParams,
            StudioRuntimeStatus
        >;
        readonly start: StudioServiceMethod<
            StudioRuntimeStartParams,
            StudioRuntimeStatus
        >;
        readonly stop: StudioServiceMethod<
            StudioRuntimeStopParams,
            StudioRuntimeStatus
        >;
        readonly pause: StudioServiceMethod<
            StudioRuntimePauseParams,
            StudioRuntimeStatus
        >;
        readonly resume: StudioServiceMethod<
            StudioRuntimeResumeParams,
            StudioRuntimeStatus
        >;
        readonly step: StudioServiceMethod<
            StudioRuntimeStepParams,
            StudioRuntimeStatus
        >;
    };
    readonly editor: {
        readonly navigate: StudioServiceMethod<
            StudioEditorNavigateParams,
            StudioEditorNavigateResult
        >;
        readonly select: StudioServiceMethod<
            StudioEditorSelectParams,
            StudioEditorSelectResult
        >;
    };
}

export type StudioServiceMethodName<
    TService extends StudioServiceName
> = Extract<keyof StudioServiceContract[TService], string>;

export type StudioServiceOperation = {
    [TService in StudioServiceName]: `${TService}:${StudioServiceMethodName<TService>}`;
}[StudioServiceName];

type StudioServiceDefinitionByMethod<
    TService extends StudioServiceName,
    TMethod extends StudioServiceMethodName<TService>
> = StudioServiceContract[TService][TMethod];

export type StudioServiceParams<
    TOperation extends StudioServiceOperation
> = TOperation extends `${infer TService extends StudioServiceName}:${infer TMethod}`
    ? TMethod extends StudioServiceMethodName<TService>
        ? StudioServiceDefinitionByMethod<
              TService,
              TMethod
          > extends StudioServiceMethod<infer TParams, unknown>
            ? TParams
            : never
        : never
    : never;

export type StudioServiceResult<
    TOperation extends StudioServiceOperation
> = TOperation extends `${infer TService extends StudioServiceName}:${infer TMethod}`
    ? TMethod extends StudioServiceMethodName<TService>
        ? StudioServiceDefinitionByMethod<
              TService,
              TMethod
          > extends StudioServiceMethod<unknown, infer TResult>
            ? TResult
            : never
        : never
    : never;

type StudioServiceParamsByMethod<
    TService extends StudioServiceName,
    TMethod extends StudioServiceMethodName<TService>
> = StudioServiceDefinitionByMethod<
    TService,
    TMethod
> extends StudioServiceMethod<
    infer TParams,
    unknown
>
    ? TParams
    : never;

type StudioServiceResultByMethod<
    TService extends StudioServiceName,
    TMethod extends StudioServiceMethodName<TService>
> = StudioServiceDefinitionByMethod<
    TService,
    TMethod
> extends StudioServiceMethod<
    unknown,
    infer TResult
>
    ? TResult
    : never;

export type StudioExtensionEvent =
    | {
          readonly type: "command";
          readonly commandId: string;
      }
    | {
          readonly type: "workspace.changed";
          readonly projects: readonly StudioProjectHandle[];
      }
    | {
          readonly type: "workspace.activeProjectChanged";
          readonly projectId?: StudioProjectId;
      }
    | {
          readonly type: "project.changed";
          readonly projectId: StudioProjectId;
          readonly revision: StudioRevision;
          readonly dirty: boolean;
      }
    | {
          readonly type: "project.saved";
          readonly projectId: StudioProjectId;
          readonly revision: StudioRevision;
          readonly diskHash: StudioContentHash;
      }
    | {
          readonly type: "build.completed";
          readonly projectId: StudioProjectId;
          readonly revision: StudioRevision;
          readonly ok: boolean;
      }
    | {
          readonly type: "runtime.changed";
          readonly projectId: StudioProjectId;
          readonly status: StudioRuntimeStatus;
      }
    | {
          readonly type: "editor.selectionChanged";
          readonly projectId: StudioProjectId;
          readonly objectIds: readonly StudioObjectId[];
      };

/** API exposed to an extension's sandboxed browser entry point. */
export interface SandboxExtensionHostApi {
    readonly instanceId: string;

    request<
        TService extends StudioServiceName,
        TMethod extends StudioServiceMethodName<TService>
    >(
        service: TService,
        method: TMethod,
        args: StudioServiceParamsByMethod<TService, TMethod>
    ): Promise<StudioServiceResultByMethod<TService, TMethod>>;

    notify<
        TService extends StudioServiceName,
        TMethod extends StudioServiceMethodName<TService>
    >(
        service: TService,
        method: TMethod,
        args: StudioServiceParamsByMethod<TService, TMethod>
    ): void;

    /** Returns an idempotent unsubscribe function. */
    subscribe(listener: (event: StudioExtensionEvent) => void): () => void;
}

/** Module shape expected from a sandbox manifest's `browser` entry point. */
export interface SandboxExtensionModule {
    activate(host: SandboxExtensionHostApi): void | Promise<void>;
    deactivate?(reason: ExtensionDeactivationReason): void | Promise<void>;
}

declare global {
    interface Window {
        readonly eezExtensionHost: SandboxExtensionHostApi;
    }
}

////////////////////////////////////////////////////////////////////////////////

export type BasicType =
    | "integer"
    | "float"
    | "double"
    | "boolean"
    | "string"
    | "date"
    | "blob"
    | "stream"
    | "widget"
    | "json"
    | "event"
    | "any";

export type OtherBasicType =
    | "undefined"
    | "null"
    | `int8`
    | `uint8`
    | `int16`
    | `uint16`
    | `int8`
    | `int8`
    | `uint32`
    | `int64`
    | `uint64`
    | `stringasset`
    | `arrayasset`
    | `arrayref`;

export type ValueType =
    | BasicType
    | OtherBasicType
    | `object:${string}`
    | `enum:${string}`
    | `struct:${string}`
    | `dynamic:${string}`
    | `array:${BasicType}`
    | `array:array:${BasicType}`
    | `array:object:${string}`
    | `array:struct:${string}`
    | `array:enum:${string}`
    | `array:dynamic:${string}`
    | `importedProject`;

export interface IVariable {
    name: string;
    fullName: string;
    description?: string;
    type: ValueType;
    defaultValue: any;
    defaultValueList: any;
    persistent: boolean;
}

export interface IPropertyValue {
    propertyValueIndex: number;
    valueWithType: ValueWithType;
}

export type ValueWithType = {
    value: Value;
    valueType: ValueType;
};

export type Value =
    | null
    | undefined
    | boolean
    | number
    | string
    | Uint8Array
    | Stream
    | Date
    | ObjectOrArrayValue;

export type ObjectOrArrayValueWithType = {
    value: ObjectOrArrayValue;
    valueType: ValueType;
};

export type ObjectOrArrayValue =
    | undefined
    | Value[]
    | { [fieldName: string]: Value };

////////////////////////////////////////////////////////////////////////////////

export interface GenericDialogConfiguration {
    dialogDefinition: DialogDefinition;
    values: any;
    okButtonText?: string;
    onOk?: (result: GenericDialogResult) => Promise<boolean>;
}

export interface DialogDefinition {
    title?: string;
    size?: "small" | "medium" | "large";
    fields: IFieldProperties[];
    error?: string;
}

export interface IEnumItem {
    id: string | number;
    label: string;
}

export type EnumItems = (number | string | IEnumItem)[];

export interface IFieldProperties {
    name: string;
    displayName?: string;
    type?:
        | "integer"
        | "number"
        | "string"
        | "password"
        | "boolean"
        | "enum"
        | "radio"
        | "range"
        | "button";
    enumItems?: EnumItems | (() => EnumItems);
    defaultValue?: number | string | boolean;
    visible?: (values: any) => boolean;
    validators?: Rule[];
    minValue?: number;
    maxValue?: number;
}

export type Rule = (
    object: any,
    ruleName: string
) => Promise<string | null> | string | null;

export interface GenericDialogResult {
    values: any;
    onProgress: (type: "info" | "error", message: string) => boolean;
}

////////////////////////////////////////////////////////////////////////////////

export type LogItemType =
    | "fatal"
    | "error"
    | "warning"
    | "scpi"
    | "info"
    | "debug";

////////////////////////////////////////////////////////////////////////////////

// must be serializable
export type IObjectVariableValueConstructorParams = {};

export interface IObjectVariableValueStatus {
    label?: string;
    image?: string;
    color?: string;
    error?: string;
}

export type IObjectVariableValue = {
    constructorParams: IObjectVariableValueConstructorParams;
    status: IObjectVariableValueStatus;
};

export interface IObjectVariableValueFieldDescription {
    name: string;
    valueType: ValueType | IObjectVariableValueFieldDescription[];
    getFieldValue(objectVariableValue: IObjectVariableValue): any;
}

export interface IObjectVariableType {
    editConstructorParams?(
        variable: IVariable,
        params?: IObjectVariableValueConstructorParams,
        runtime?: boolean
    ): Promise<IObjectVariableValueConstructorParams | undefined>;

    createValue(
        params: IObjectVariableValueConstructorParams,
        isRuntime: boolean
    ): IObjectVariableValue;

    destroyValue(
        value: IObjectVariableValue,
        newValue?: IObjectVariableValue
    ): void;

    getValue(variableValue: any): IObjectVariableValue | null;

    valueFieldDescriptions: IObjectVariableValueFieldDescription[];
}

////////////////////////////////////////////////////////////////////////////////

export interface IComponentInput {
    name: string;
    type: ValueType;
    isSequenceInput: boolean;
    isOptionalInput: boolean;
}

export interface IComponentOutput {
    name: string;
    type: ValueType;
    isSequenceOutput: boolean;
    isOptionalOutput: boolean;
}

export interface IComponentPropertyBase {
    name: string;
    displayName?: string;
    disabled?: (...props: string[]) => boolean;
    optional?: (...props: string[]) => boolean;
    formText?: string;
}

export interface IExpressionComponentProperty extends IComponentPropertyBase {
    type: "expression";
    valueType: ValueType;
}

export interface IAssignableExpressionComponentProperty
    extends IComponentPropertyBase {
    type: "assignable-expression";
    valueType: ValueType;
}

export interface ITemplateLiteralComponentProperty
    extends IComponentPropertyBase {
    type: "template-literal";
}

export interface EnumItem {
    id: string | number;
    label?: string;
}

export interface IEnumComponentProperty extends IComponentPropertyBase {
    type: "enum";
    enumItems: EnumItem[];
}

export interface IInlineCodeComponentProperty extends IComponentPropertyBase {
    type: "inline-code";
    language: "JSON" | "JavaScript" | "CSS" | "Python" | "C/C++";
}

export interface IListComponentProperty extends IComponentPropertyBase {
    type: "list";
    properties: IComponentProperty[];
    migrateProperties?: (component: IActionComponent) => void;
    defaults: any;
}

export interface IBooleanComponentProperty extends IComponentPropertyBase {
    type: "boolean";
}

export type IComponentProperty =
    | IExpressionComponentProperty
    | IAssignableExpressionComponentProperty
    | ITemplateLiteralComponentProperty
    | IEnumComponentProperty
    | IInlineCodeComponentProperty
    | IListComponentProperty
    | IBooleanComponentProperty;

export type IDisposeComponentState = () => void;

export type IComponentIsRunning = boolean;

export interface ICustomInput {
    name: string;
    type: ValueType;
}

export interface ICustomOutput {
    name: string;
    type: ValueType;
}

export interface IActionComponent {
    [propertyName: string]: any;

    customInputs: ICustomInput[];
    customOutputs: ICustomOutput[];
}

export interface IActionComponentDefinition {
    name: string;
    icon: string;
    componentHeaderColor: string;
    componentPaletteLabel?: string;

    bodyPropertyName?: string;
    bodyPropertyCallback?: (...props: string[]) => React.ReactNode;

    inputs: IComponentInput[];
    outputs: IComponentOutput[] | ((...props: string[]) => IComponentOutput[]);

    properties: IComponentProperty[];

    defaults?: any;

    migrateProperties?: (component: IActionComponent) => void;

    execute?: (context: IDashboardComponentContext) => void;
}

interface IMessageFromWorker {
    id: number;
    flowStateIndex: number;
    componentIndex: number;
    message: any;
    callback?: (result: any) => void;
}

// message data sent from WASM worker to renderer
export interface WorkerToRenderMessage {
    // sent from worker once at the start
    init?: any;

    // screen data (to be displayed in Canvas), sent from worker at each tick
    screen?: Uint8ClampedArray;

    isRTL?: boolean;

    // message from worker to Studio debugger
    messageToDebugger?: Uint8Array;

    // SCPI command to execute (only renderer is able to execute SCPI commands)
    scpiCommand?: ScpiCommand;

    // evaluated property values
    propertyValues?: IPropertyValue[];

    freeArrayValue?: ObjectOrArrayValueWithType;

    getObjectVariableMemberValue?: {
        arrayValuePtr: number;
        memberIndex: number;
    };

    getBitmapAsDataURL?: {
        name: string;
    };

    setDashboardColorTheme?: {
        themeName: string;
    };

    getLvglScreenByName?: {
        name: string;
    };

    getLvglObjectByName?: {
        name: string;
    };

    getLvglGroupByName?: {
        name: string;
    };

    getLvglStyleByName?: {
        name: string;
    };

    getLvglImageByName?: {
        name: string;
    };

    getLvglFontByName?: {
        name: string;
    };

    getLvglObjectNameFromIndex?: {
        index: number;
    };

    lvglObjAddStyle?: {
        targetObj: number;
        styleIndex: number;
    };

    lvglObjRemoveStyle?: {
        targetObj: number;
        styleIndex: number;
    };

    lvglSetColorTheme?: {
        themeName: string;
    };

    lvglCreateScreen?: {
        screenIndex: number;
    };

    lvglDeleteScreen?: {
        screenIndex: number;
    };

    lvglScreenTick?: any;

    lvglOnEventHandler?: {
        obj: number;
        eventCode: number;
        event: number;
    };
}

interface IField {
    name: string;
    valueType: ValueType;
}

interface ITypeBase {
    kind: "object" | "array";
    valueType: ValueType;
}

type IFieldIndexes = { [key: string]: number };

interface IObjectType {
    kind: "object";
    valueType: ValueType;
    fields: IField[];
    fieldIndexes: IFieldIndexes;
    open: boolean;
}

interface IArrayType {
    kind: "array";
    valueType: ValueType;
    elementType: IType;
}

interface IBasicType {
    kind: "basic";
    valueType: ValueType;
}

type IType = IArrayType | IObjectType | IBasicType;

type IIndexes = { [key: string]: string };

interface AssetsMap {
    flows: {
        flowIndex: number;
        path: string;
        readablePath: string;
        components: {
            componentIndex: number;
            path: string;
            readablePath: string;
            inputIndexes: {
                [inputName: string]: number;
            };
            outputs: {
                outputName: string;
                actionFlowIndex: number;
                valueTypeIndex: number;
                connectionLines: {
                    targetComponentIndex: number;
                    targetInputIndex: number;
                }[];
            }[];
            outputIndexes: {
                [outputName: string]: number;
            };
            properties: {
                valueTypeIndex: number;
            }[];
            propertyIndexes: {
                [propertyName: string]: number;
            };
        }[];
        componentIndexes: { [path: string]: number };
        componentInputs: {
            inputIndex: number;
            componentIndex: number;
            inputName: string;
            inputType: string;
        }[];
        localVariables: {
            index: number;
            name: string;
        }[];
        widgetDataItems: {
            widgetDataItemIndex: number;
            flowIndex: number;
            componentIndex: number;
            propertyValueIndex: number;
        }[];
        widgetActions: {
            widgetActionIndex: number;
            flowIndex: number;
            componentIndex: number;
            outputIndex: number;
        }[];
    }[];
    flowIndexes: { [path: string]: number };
    actionFlowIndexes: { [actionName: string]: number };
    jsonValues: any[];
    constants: any[];
    globalVariables: {
        index: number;
        name: string;
        type: string;
    }[];
    dashboardComponentTypeToNameMap: {
        [componentType: number]: string;
    };
    types: IType[];
    typeIndexes: IIndexes;
    displayWidth: number;
    displayHeight: number;
    bitmaps: string[];
    lvglWidgetIndexes: { [identifier: string]: number };
    lvglWidgetGeneratedIdentifiers: { [objId: string]: string };
}

export interface ScpiCommand {
    instrumentId: string;
    command: Uint8Array;
    isQuery: boolean;
    timeout: number;
    delay: number;
}

// prettier-ignore
export interface IWasmFlowRuntime {
    // emscripten API
    HEAP8: Uint8Array;
    HEAPU8: Uint8Array;
    HEAP16: Uint8Array;
    HEAPU16: Uint8Array;
    HEAP32: Uint32Array;
    HEAPU32: Uint32Array;

    HEAPF32: Float32Array;
    HEAPF64: Float64Array;

    FS: any;

    stringToNewUTF8(str: string): number;
    UTF8ToString(ptr: number): string;
    AsciiToString(ptr: number): string;

    _malloc(size: number): number;
    _free(ptr: number): void;

    //
    wasmModuleId: number;
    assetsMap: AssetsMap;
    postWorkerToRendererMessage: (workerToRenderMessage: WorkerToRenderMessage) => any;

    getClassByName: (className: string) => any;

    onRuntimeTerminate: () => void;

    readSettings: (key: string) => any;
    writeSettings: (key: string, value: any) => any;
    hasWidgetHandle: (flowStateIndex: number, componentIndex: number) => boolean;
    getWidgetHandle: (flowStateIndex: number, componentIndex: number) => number;
    getWidgetHandleInfo: (widgetHandle: number) => {
        flowStateIndex: number, componentIndex: number
    } | undefined;

    // eez framework API
    _init(wasmModuleId: number, debuggerMessageSubsciptionFilter: number, assets: number, assetsSize: number, displayWidth: number, displayHeight: number, darkTheme: boolean, timeZone: number, screensLifetimeSupport: boolean): void;
    _mainLoop(): boolean;
    _getSyncedBuffer(): number;
    _onMouseWheelEvent(wheelDeltaY: number, pressed: number): void;
    _onPointerEvent(x: number, y: number, pressed: number): void;
    _onKeyPressed(key: number): void;
    _onMessageFromDebugger(messageData: number, messageDataSize: number): void;

    // eez flow API for Dashboard projects

    _createUndefinedValue(): number;
    _createNullValue(): number;
    _createIntValue(value: number): number;
    _createDoubleValue(value: number): number;
    _createBooleanValue(value: number): number;
    _createStringValue(value: number): number;
    _createArrayValue(arraySize: number, arrayType: number): number;
    _createStreamValue(value: number): number;
    _createDateValue(value: number): number;
    _createBlobValue(bufferPtr: number, bufferLen: number): number;
    _createJsonValue(value: number): number;
    _createErrorValue(): number;

    _arrayValueSetElementValue(arrayValuePtr: number, elementIndex: number, value: number): void;

    _valueFree(valuePtr: number): void;

    _getGlobalVariable(globalVariableIndex: number): number;
    _setGlobalVariable(globalVariableIndex: number, valuePtr: number): void;
    _updateGlobalVariable(globalVariableIndex: number, valuePtr: number): void;

    _getFlowIndex(flowStateIndex: number): number;

    _getComponentExecutionState(flowStateIndex: number, componentIndex: number): number;
    _allocateDashboardComponentExecutionState(flowStateIndex: number, componentIndex: number): number;
    _deallocateDashboardComponentExecutionState(flowStateIndex: number, componentIndex: number): void;

    _getUint8Param(flowStateIndex: number, componentIndex: number, offset: number): number;
    _getUint32Param(flowStateIndex: number, componentIndex: number, offset: number): number;
    _getStringParam(flowStateIndex: number, componentIndex: number, offset: number): number;
    _getExpressionListParam(flowStateIndex: number, componentIndex: number, offset: number): number;
    _freeExpressionListParam(ptr: number): void;

    _getListParamSize(flowStateIndex: number, componentIndex: number, offset: number): number;
    _evalListParamElementExpression(flowStateIndex: number, componentIndex: number, listOffset: number, elementIndex: number, expressionOffset: number, errorMessage: number): number;

    _getInputValue(flowStateIndex: number, inputIndex: number): number;
    _clearInputValue(flowStateIndex: number, inputIndex: number): void;

    _evalProperty(flowStateIndex: number, componentIndex: number, propertyIndex: number, iteratorsPtr: number, disableThrowError: boolean): number;
    _assignProperty(flowStateIndex: number, componentIndex: number, propertyIndex: number, iteratorsPtr: number, valuePtr: number): number;

    _setPropertyField(flowStateIndex: number, componentIndex: number, propertyIndex: number, fieldIndex: number, valuePtr: number): void;

    _propagateValue(flowStateIndex: number, componentIndex: number, outputIndex: number, valuePtr: number): void;
    _propagateValueThroughSeqout(flowStateIndex: number, componentIndex: number): void;

    _onEvent(flowStateIndex: number, flowEvent: number, valuePtr: number): void;

    _startAsyncExecution(flowStateIndex: number, componentIndex: number): number;
    _endAsyncExecution(flowStateIndex: number, componentIndex: number): void;

    _executeCallAction(flowStateIndex: number, componentIndex: number, flowIndex: number): void;

    _logInfo(flowStateIndex: number, componentIndex: number, infoMessage: number): void;
    _throwError(flowStateIndex: number, componentIndex: number, errorMessage: number): void;

    _onScpiResult(errorMessage: number, result: number, resultLen: number, resultIsBlob: number): void;

    _getFirstRootFlowState(): number;
    _getFirstChildFlowState(flowStateIndex: number): number;
    _getNextSiblingFlowState(flowStateIndex: number): number;

    _getFlowStateFlowIndex(flowStateIndex: number): number;

    _stopScript(): void;

    _isRTL(): boolean;

    _setDebuggerMessageSubsciptionFilter(filter: number): void;

    _onMqttEvent(handle: number, eventType: number, eventDataPtr1: number, eventDataPtr2: number): void;

    _flowCleanup() : void;

    // LVGL API
    _lvglCreateScreen(parentObj: number, index: number, x: number, y: number, w: number, h: number): number;
    _lvglCreateUserWidget(parentObj: number, index: number, x: number, y: number, w: number, h: number): number;

    _lvglScreenLoad(page_index: number, obj: number): void;
    _lvglDeleteObject(obj: number): void;
    _lvglDeleteObjectIndex(index: number): void;
    _lvglDeletePageFlowState(index: number): void;

    _lvglObjGetStylePropColor(obj: number, part: number, state: number, prop: number): number;
    _lvglObjGetStylePropNum(obj: number, part: number, state: number, prop: number): number;
    _lvglObjSetLocalStylePropColor(obj: number, prop: number, color: number, selector: number): void;
    _lvglObjSetLocalStylePropNum(obj: number, prop: number, num: number, selector: number): void;
    _lvglObjSetLocalStylePropPtr(obj: number, prop: number, ptr: number, selector: number): void;
    _lvglObjGetStylePropBuiltInFont(obj: number, part: number, state: number, prop: number): number;
    _lvglObjGetStylePropFontAddr(obj: number, part: number, state: number, prop: number): number;
    _lvglObjSetLocalStylePropBuiltInFont(obj: number, prop: number, font_index: number, selector: number): void;

    _lvglSetObjStylePropBuiltInFont(obj: number, style: number, prop: number, font_index: number): void
    _lvglSetObjStylePropPtr(obj: number, style: number, prop: number, ptr: number): void;

    _lvglStyleCreate(): number;
    _lvglStyleSetPropColor(obj: number, prop: number, color: number): void;
    _lvglSetStylePropBuiltInFont(obj: number, prop: number, font_index: number): void
    _lvglSetStylePropPtr(obj: number, prop: number, ptr: number): void;
    _lvglSetStylePropNum(obj: number, prop: number, num: number): void;
    _lvglStyleDelete(obj: number): void;

    _lvglObjAddStyle(obj: number, style: number, selector: number): void;
    _lvglObjRemoveStyle(obj: number, style: number, selector: number): void;

    _lvglGetObjRelX(obj: number): number;
    _lvglGetObjRelY(obj: number): number;
    _lvglGetObjWidth(obj: number): number;
    _lvglGetObjHeight(obj: number): number;
    _lvglLoadFont(font_file_path: number, fallback_user_font: number, fallback_builtin_font: number): number;
    _lvglFreeFont(font_ptr: number): void;

    _lvglAddTimelineKeyframe(
        obj: number,
        page_index: number,
        start: number, end: number,
        enabledProperties: number,
        x: number, xEasingFunc: number,
        y: number, yEasingFunc: number,
        width: number, widthEasingFunc: number,
        height: number, heightEasingFunc: number,
        opacity: number, opacityEasingFunc: number,
        scale: number, scaleEasingFunc: number,
        rotate: number, rotateEasingFunc: number,
        cp1x: number, cp1y: number, cp2x: number, cp2y: number
    ): void;
    _lvglSetTimelinePosition(timelinePosition: number): void;
    _lvglClearTimeline(): void;
    _lvglGetFlowState(flowState: number, userWidgetComponentIndexOrPageIndex: number): number;

    _lvglLineSetPoints(obj: number, point_values: number, point_num: number);
    _lvglScrollTo(obj: number, x: number, y: number, anim_en: boolean);
    _lvglGetScrollX(obj: number): number;
    _lvglGetScrollY(obj: number): number;

    _lvglCreateGroup(): number;
    _lvglSetEncoderGroup(groupObj: number): void;
    _lvglSetKeyboardGroup(groupObj: number): void;
    _lvglAddScreenLoadedEventHandler(screenObj: number): void;
    _lvglGroupAddObject(screenObj: number, groupObj: number, obj: number): void;
    _lvglGroupRemoveObjectsForScreen(screenObj: number): void;

    _lvglObjInvalidate(obj: number);

    _lvglDeleteScreenOnUnload(screenIndex: number);

    _lvglAddEventHandler(obj: number): void;

    _lvglCreateFreeTypeFont(filePath: number, size: number, renderMode: number, style: number): number;

    _lvglGetBuiltinFontPtr(fontName: number): number;

    _lvglCreateAnim(setDelay: boolean, delay: number, setRepeatDelay: boolean, repeatDelay: number, setRepeatCount: boolean, repeatCount: number): number;

    _eez_flow_init_themes(themeNames: number, numThemes: number, changeColorTheme: number, themeColors: number, numColorsPerTheme: number);

    // EEZ-GUI Lite

    _initEezGuiLite(displayWidth: number, displayHeight: number): void;

    // EEZ-GUI Lite — colors, fonts, styles
    _setColors(colorsPtr: number, numColors: number): void;
    _setFonts(fontsPtr: number, numFonts: number): void;
    _setStyles(stylesPtr: number, numStyles: number): void;

    // EEZ-GUI Lite — widget allocation
    _allocTextWidget(): number;
    _allocButtonWidget(): number;
    _allocRectangleWidget(): number;
    _allocSwitchWidget(): number;
    _allocSelectWidget(): number;
    _allocContainerWidget(): number;
    _freeWidget(widgetPtr: number): void;

    // EEZ-GUI Lite — widget field setters
    _setWidgetFlags(widgetPtr: number, flags: number): void;
    _setWidgetGeometry(widgetPtr: number, x: number, y: number, w: number, h: number): void;
    _setWidgetStyle(widgetPtr: number, style: number): void;
    _setWidgetVisible(widgetPtr: number, isVisible: number): void;
    _setTextWidgetText(widgetPtr: number, textProp: number): void;
    _setButtonWidgetText(widgetPtr: number, textProp: number): void;
    _setButtonWidgetEnabled(widgetPtr: number, isEnabled: number): void;
    _setButtonWidgetDisabledStyle(widgetPtr: number, disabledStyle: number): void;
    _setSwitchWidgetChecked(widgetPtr: number, isCheckedProp: number): void;

    // EEZ-GUI Lite — page rendering
    _startPage(pageDataPtr: number, style: number): void;
    _endPage(): void;
    _renderTextWidget(widgetPtr: number): void;
    _renderButtonWidget(widgetPtr: number): void;
    _renderRectangleWidget(widgetPtr: number): void;
    _renderSwitchWidget(widgetPtr: number): void;
    _renderSelectBegin(widgetPtr: number): void;
    _renderSelectEnd(widgetPtr: number): void;
    _renderContainerBegin(widgetPtr: number): void;
    _renderContainerEnd(widgetPtr: number): void;

    // EEZ-GUI Lite — input and refresh
    _pointerInput(x: number, y: number, pressed: boolean): void;
    _requestRefresh(): void;

    // EEZ-GUI Lite — struct sizes and offsets
    _sizeofStyle(): number;
    _sizeofColor(): number;
    _sizeofFontData(): number;
    _sizeofGlyphData(): number;
    _sizeofGlyphsGroup(): number;
    _sizeofTextWidget(): number;
    _sizeofButtonWidget(): number;
    _sizeofRectangleWidget(): number;
    _sizeofSwitchWidget(): number;
    _sizeofSelectWidget(): number;
    _sizeofContainerWidget(): number;

    // EEZ-GUI Lite — style struct offsets
    _offsetofStyleFlags(): number;
    _offsetofStyleBgColor(): number;
    _offsetofStyleColor(): number;
    _offsetofStyleActiveBgColor(): number;
    _offsetofStyleActiveColor(): number;
    _offsetofStyleBorderSizeTop(): number;
    _offsetofStyleBorderSizeRight(): number;
    _offsetofStyleBorderSizeBottom(): number;
    _offsetofStyleBorderSizeLeft(): number;
    _offsetofStyleBorderColor(): number;
    _offsetofStyleFont(): number;
    _offsetofStylePaddingTop(): number;
    _offsetofStylePaddingRight(): number;
    _offsetofStylePaddingBottom(): number;
    _offsetofStylePaddingLeft(): number;

    // EEZ-GUI Lite — glyph_data_t offsets
    _offsetofGlyphDx(): number;
    _offsetofGlyphW(): number;
    _offsetofGlyphH(): number;
    _offsetofGlyphX(): number;
    _offsetofGlyphY(): number;
    _offsetofGlyphPixelsIndex(): number;

    // EEZ-GUI Lite — glyphs_group_t offsets
    _offsetofGroupEncoding(): number;
    _offsetofGroupGlyphIndex(): number;
    _offsetofGroupLength(): number;

    // EEZ-GUI Lite — font_data_t offsets
    _offsetofFontAscent(): number;
    _offsetofFontDescent(): number;
    _offsetofFontBpp(): number;
    _offsetofFontEncodingStart(): number;
    _offsetofFontEncodingEnd(): number;
    _offsetofFontGroups(): number;
    _offsetofFontGlyphs(): number;
    _offsetofFontPixels(): number;

    // EEZ-GUI Lite — widget struct offsets
    _offsetofWidgetFlags(): number;
    _offsetofWidgetX(): number;
    _offsetofWidgetY(): number;
    _offsetofWidgetW(): number;
    _offsetofWidgetH(): number;
    _offsetofWidgetStyle(): number;
    _offsetofWidgetVisible(): number;
    _offsetofTextWidgetText(): number;
    _offsetofButtonWidgetText(): number;
    _offsetofSwitchWidgetChecked(): number;

    // EEZ-GUI Lite — constants
    _getWidgetFlagClickable(): number;
    _getStyleFlagHorzAlignLeft(): number;
    _getStyleFlagHorzAlignRight(): number;
    _getStyleFlagHorzAlignCenter(): number;
    _getStyleFlagVertAlignTop(): number;
    _getStyleFlagVertAlignBottom(): number;
    _getStyleFlagVertAlignCenter(): number;
    _getStyleFlagBlink(): number;

    // EEZ-GUI Lite — color helper
    _makeColor(r: number, g: number, b: number): number;

    // EEZ-GUI Lite — JS callback registration (set on Module object)
    _jsGetStrProp?: (prop: number) => number;
    _jsGetBoolProp?: (prop: number) => number;
    _jsGetIntProp?: (prop: number) => number;
    _jsOnEvent?: (widgetPtr: number, eventType: number) => void;
}

export interface IDashboardComponentContext {
    WasmFlowRuntime: IWasmFlowRuntime;

    flowStateIndex: number;

    getFlowIndex: () => number;
    getComponentIndex: () => number;

    getComponentExecutionState: <T>() => T | undefined;
    setComponentExecutionState: <T>(executionState: T) => void;

    getUint8Param: (offset: number) => number;
    getUint32Param: (offset: number) => number;
    getStringParam: (offset: number) => string;
    getExpressionListParam: (offset: number) => any[];

    getListParamSize: (offset: number) => number;
    evalListParamElementExpression: <T = any>(
        listOffset: number,
        elementIndex: number,
        expressionOffset: number,
        errorMessage: string,
        expectedTypes?: ValueType | ValueType[]
    ) => T | undefined;

    getInputValue: <T = any>(
        inputName: string,
        expectedTypes?: ValueType[]
    ) => T | undefined;

    clearInputValue: (inputName: string) => void;

    evalProperty: <T = any>(
        propertyName: string,
        expectedTypes?: ValueType | ValueType[]
    ) => T | undefined;

    setPropertyField: <T = any>(
        propertyName: string,
        fieldName: string,
        value: any
    ) => void;

    assignProperty(
        inputName: string,
        value: any,
        iterators: number[] | undefined
    ): void;

    getOutputType: (outputName: string) => IType | undefined;

    propagateValue: (outputName: string, value: any) => void;
    propagateValueThroughSeqout: () => void;

    startAsyncExecution: () => IDashboardComponentContext;
    endAsyncExecution: () => void;

    executeCallAction: (flowIndex: number) => void;

    logInfo: (infoMessage: string) => void;

    throwError: (errorMessage: string) => void;
}

////////////////////////////////////////////////////////////////////////////////

export interface IEezFlowEditor {
    registerActionComponent(definition: IActionComponentDefinition): void;

    registerObjectVariableType(
        name: string,
        objectVariableType: IObjectVariableType
    ): void;

    showGenericDialog(
        conf: GenericDialogConfiguration
    ): Promise<GenericDialogResult>;

    validators: {
        required: Rule;
        rangeInclusive: (min: number, max?: number) => Rule;
    };
}
