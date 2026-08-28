import crypto from "crypto";

import {
    eezClassToClassNameMap,
    type EezClass,
    type IEezObject,
    isPropertyOptional,
    isPropertyReadOnly,
    PropertyType,
    TYPE_NAMES
} from "project-editor/core/object";

export const EXTENSION_SCHEMA_VERSION = "1.1";

function scalarSchema(type: string): Record<string, unknown> {
    switch (type) {
        case "Boolean":
            return { type: "boolean" };
        case "Number":
            return { type: "number" };
        case "String":
        case "MultilineText":
        case "Color":
        case "ThemedColor":
        case "RelativeFolder":
        case "RelativeFile":
        case "ObjectReference":
        case "Image":
        case "GUID":
        case "JavaScript":
        case "CSS":
        case "Python":
        case "CPP":
        case "ConfigurationReference":
        case "NumberArrayAsString":
            return { type: "string" };
        case "StringArray":
            return { type: "array", items: { type: "string" } };
        case "Array":
            return { type: "array" };
        case "Object":
        case "JSON":
        case "Any":
            return {};
        case "Null":
            return { type: "null" };
        default:
            return {};
    }
}

function propertySchema(
    property: any,
    object: IEezObject | undefined
): Record<string, unknown> {
    const type = object && property.dynamicType
        ? TYPE_NAMES[property.dynamicType(object, property) as PropertyType]
        : TYPE_NAMES[property.type as PropertyType];
    const schema = scalarSchema(type);
    const enumItems = object && property.enumItems
        ? typeof property.enumItems == "function"
            ? property.enumItems(object)
            : property.enumItems
        : Array.isArray(property.enumItems)
          ? property.enumItems
          : undefined;
    if (type == "Enum" && enumItems) {
        schema.enum = enumItems.map((item: any) => item.id);
    }
    if (property.typeClass) {
        const nested = createJsonSchema(property.typeClass, object);
        Object.assign(schema, nested.schema);
    }
    if (property.readOnlyInPropertyGrid != undefined || property.computed) {
        const readOnly = object
            ? isPropertyReadOnly(object, property) ||
              (!!property.computed && !property.modifiable)
            : property.readOnlyInPropertyGrid === true ||
              (!!property.computed && !property.modifiable);
        if (readOnly) schema.readOnly = true;
    }
    if (typeof property.isOptional == "function" && !object) {
        schema["x-eez-conditionallyRequired"] = true;
    }
    return schema;
}

export function createJsonSchema(
    objectClass: EezClass,
    object?: IEezObject
) {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    const conditionallyRequired: string[] = [];
    for (const property of objectClass.classInfo.properties) {
        properties[property.name] = propertySchema(property, object);
        const optional = object
            ? isPropertyOptional(object, property)
            : property.isOptional === true;
        if (!optional) {
            if (typeof property.isOptional == "function" && !object) {
                conditionallyRequired.push(property.name);
            } else {
                required.push(property.name);
            }
        }
    }
    const schema: Record<string, unknown> = {
        type: "object",
        properties,
        additionalProperties: false
    };
    if (required.length) schema.required = required;
    if (conditionallyRequired.length) {
        schema["x-eez-conditionallyRequired"] = conditionallyRequired;
    }
    return {
        schema,
        schemaHash: crypto
            .createHash("sha256")
            .update(JSON.stringify(schema), "utf8")
            .digest("hex")
    };
}

export function describeObjectClass(
    objectClass: EezClass,
    object?: IEezObject
) {
    const type = eezClassToClassNameMap.get(objectClass) ?? objectClass.name;
    const { schema, schemaHash } = createJsonSchema(objectClass, object);
    return {
        type,
        schemaVersion: EXTENSION_SCHEMA_VERSION,
        schemaHash,
        schema,
        properties: objectClass.classInfo.properties.map((property: any) => ({
            name: property.name,
            type: TYPE_NAMES[property.type as PropertyType],
            required: object
                ? !isPropertyOptional(object, property)
                : property.isOptional !== true,
            conditionallyRequired:
                typeof property.isOptional == "function" || undefined,
            readOnly: object
                ? isPropertyReadOnly(object, property) ||
                  (!!property.computed && !property.modifiable)
                : property.readOnlyInPropertyGrid === true ||
                  (!!property.computed && !property.modifiable)
        }))
    };
}
