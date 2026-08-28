const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
const path = require("node:path");

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (/^(project-editor|eez-studio-shared|home)\//.test(request)) {
        try {
            return originalLoad(
                path.resolve(__dirname, "../../build", `${request}.js`),
                parent,
                isMain
            );
        } catch (error) {
            if (error.code !== "MODULE_NOT_FOUND") throw error;
        }
    }
    return originalLoad(request, parent, isMain);
};

const schema = require("../../build/home/extensions-v1/schema");
const object = require("../../build/project-editor/core/object");

test("schema descriptor includes JSON Schema, hash, and conditional required metadata", () => {
    const classes = object.getAllClasses();
    assert.ok(classes.length > 0);
    const described = schema.describeObjectClass(classes[0]);
    assert.equal(described.schemaVersion, "1.1");
    assert.match(described.schemaHash, /^[0-9a-f]{64}$/);
    assert.equal(described.schema.type, "object");
    assert.equal(described.schema.additionalProperties, false);
    assert.ok(described.properties.every(property => "required" in property));
});
