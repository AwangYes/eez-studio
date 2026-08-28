const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");

const { app } = require("electron");

const watchdog = setTimeout(() => {
    console.error("Extension Platform Electron smoke test timed out");
    app.exit(1);
}, 60_000);

process.env.EEZ_STUDIO_EXTENSION_DEVELOPER_MODE = "1";
process.env.NODE_PATH = path.resolve(__dirname, "../../build");
require("module").Module._initPaths();

require(path.resolve(__dirname, "../../build/main/extensions-v1/protocol.js"));

async function main() {
    await app.whenReady();

    const { SandboxExtensionHost } = require(path.resolve(
        __dirname,
        "../../build/main/extensions-v1/sandbox-host.js"
    ));
    const calls = [];
    const secrets = new Map();
    const fixtureDirectory = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "eez-extension-electron-smoke-")
    );
    const selectedAssetPath = path.join(fixtureDirectory, "selected.txt");
    await fs.promises.writeFile(selectedAssetPath, "smoke asset", "utf8");
    let host;
    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (request === "@electron/remote") {
            return {
                getCurrentWindow: () => host.window,
                dialog: {
                    showOpenDialog: async () => ({
                        canceled: false,
                        filePaths: [selectedAssetPath]
                    })
                }
            };
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    let interactionServices;
    try {
        const { registerInteractionExtensionServices } = require(path.resolve(
            __dirname,
            "../../build/home/extensions-v1/interaction-service.js"
        ));
        interactionServices = new Map(
            registerInteractionExtensionServices({
                resolveProject() {
                    throw new Error("The smoke fixture has no runtime project");
                },
                async applyProjectEdits() {
                    throw new Error("The smoke fixture does not edit projects");
                }
            }).map(({ service, handler }) => [service, handler])
        );
    } finally {
        Module._load = originalLoad;
    }
    host = new SandboxExtensionHost(
        {
            id: "com.example.extension-platform-smoke",
            version: "1.0.0",
            installationPath: path.join(__dirname, "fixtures/smoke-extension"),
            browser: "extension.js"
        },
        async request => {
            calls.push({ service: request.service, method: request.method });
            const interactionHandler = interactionServices.get(request.service);
            if (interactionHandler) {
                return interactionHandler(request);
            }
            if (request.service === "smoke" && request.method === "ping") {
                return request.args;
            }
            if (request.service === "smoke") {
                return { accepted: true };
            }
            if (request.service !== "storage") {
                throw new Error(`Unexpected fixture service: ${request.service}`);
            }
            const { key, value } = request.args;
            if (request.method === "store") {
                secrets.set(key, value);
                return { stored: true };
            }
            if (request.method === "get") return { value: secrets.get(key) };
            if (request.method === "keys") return { keys: [...secrets.keys()] };
            if (request.method === "delete") {
                secrets.delete(key);
                return { deleted: true };
            }
            throw new Error(`Unexpected storage method: ${request.method}`);
        }
    );

    try {
        await host.activate();
        assert(calls.some(call => call.service === "smoke" && call.method === "activated"));
        assert.deepEqual(
            calls.filter(call => call.service === "storage").map(call => call.method),
            ["store", "get", "keys", "delete"]
        );
        await host.deactivate("shutdown");
        assert(calls.some(call => call.service === "smoke" && call.method === "deactivated"));
        console.log("Extension Platform Electron smoke test passed");
    } finally {
        await host.deactivate("shutdown");
        await fs.promises.rm(fixtureDirectory, {
            recursive: true,
            force: true
        });
        clearTimeout(watchdog);
        app.quit();
    }
}

main().catch(error => {
    clearTimeout(watchdog);
    console.error(error);
    app.exit(1);
});
