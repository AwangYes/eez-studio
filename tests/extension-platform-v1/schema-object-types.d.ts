export const enum PropertyType {
    Array,
    Object,
    Boolean,
    Number,
    Enum,
    String,
    MultilineText,
    Image,
    Color,
    ThemedColor,
    RelativeFolder,
    RelativeFile,
    ObjectReference,
    JSON,
    JavaScript,
    CSS,
    Python,
    CPP,
    GUID,
    NumberArrayAsString,
    StringArray,
    ConfigurationReference,
    Any,
    LVGLWidget,
    Null
}

export const TYPE_NAMES: Record<PropertyType, string>;

export interface IEezObject {
    [key: string]: unknown;
}

export interface PropertyInfo {
    name: string;
    type: PropertyType;
    dynamicType?: (object: IEezObject, property: PropertyInfo) => PropertyType;
    enumItems?: unknown[] | ((object: IEezObject) => unknown[]);
    typeClass?: EezClass;
    readOnlyInPropertyGrid?: boolean | ((object: IEezObject, property: PropertyInfo) => boolean);
    computed?: boolean;
    modifiable?: boolean;
    isOptional?: boolean | ((object: IEezObject, property: PropertyInfo) => boolean);
}

export interface EezClass {
    name: string;
    classInfo: { properties: PropertyInfo[] };
}

export const eezClassToClassNameMap: Map<EezClass, string>;
export function isPropertyOptional(object: IEezObject, property: PropertyInfo): boolean;
export function isPropertyReadOnly(object: IEezObject, property: PropertyInfo): boolean;
