export interface StudioObjectWithId {
    objID?: string;
}

export function findObjectByObjID<T extends StudioObjectWithId>(
    objects: Iterable<T | T[]>,
    objectId: string
) {
    for (const object of objects) {
        if (!Array.isArray(object) && object.objID === objectId) {
            return object;
        }
    }
    return undefined;
}

export function isPlainRecord(
    value: unknown
): value is Record<string, unknown> {
    if (value == null || typeof value != "object" || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype == Object.prototype || prototype == null;
}

const STRING_PROPERTY_TYPES = new Set([
    "String",
    "MultilineText",
    "Image",
    "Color",
    "ThemedColor",
    "RelativeFolder",
    "RelativeFile",
    "ObjectReference",
    "JavaScript",
    "CSS",
    "Python",
    "CPP",
    "GUID",
    "NumberArrayAsString",
    "ConfigurationReference"
]);

export function isValidStudioScalarValue(
    type: string,
    value: unknown,
    enumIds?: readonly (string | number)[]
) {
    if (type == "Boolean") {
        return typeof value == "boolean";
    }
    if (type == "Number") {
        return typeof value == "number" && Number.isFinite(value);
    }
    if (type == "Enum") {
        return (
            (typeof value == "string" || typeof value == "number") &&
            (!enumIds || enumIds.includes(value))
        );
    }
    if (STRING_PROPERTY_TYPES.has(type) || type == "JSON") {
        return typeof value == "string";
    }
    if (type == "Any") {
        return (
            value == null ||
            typeof value == "boolean" ||
            typeof value == "string" ||
            (typeof value == "number" && Number.isFinite(value))
        );
    }
    if (type == "Null") {
        return value === null;
    }
    return false;
}

export function isValidStudioCreateValue(
    type: string,
    value: unknown,
    hasTypeClass: boolean,
    enumIds?: readonly (string | number)[]
) {
    if (type == "Object") {
        return hasTypeClass && isPlainRecord(value);
    }
    if (type == "Array") {
        return (
            hasTypeClass &&
            Array.isArray(value) &&
            value.every(item => isPlainRecord(item))
        );
    }
    if (type == "StringArray") {
        return (
            Array.isArray(value) &&
            value.every(item => typeof item == "string")
        );
    }
    if (type == "JSON" || type == "Any") {
        return true;
    }
    return isValidStudioScalarValue(type, value, enumIds);
}

export function isChildCollectionSchema(type: string, hasTypeClass: boolean) {
    return type == "Array" && hasTypeClass;
}
