export async function activate(host) {
    const pong = await host.request("smoke", "ping", {
        value: "extension-platform-v1"
    });
    if (pong.value !== "extension-platform-v1") {
        throw new Error("Sandbox service round trip failed");
    }

    await host.secrets.store("smoke-token", "not-persisted-by-fixture");
    if ((await host.secrets.get("smoke-token")) !== "not-persisted-by-fixture") {
        throw new Error("Sandbox secure storage bridge failed");
    }
    if (!(await host.secrets.keys()).includes("smoke-token")) {
        throw new Error("Sandbox secure storage key enumeration failed");
    }
    await host.secrets.delete("smoke-token");

    const input = await host.request("input", "inject", {
        target: "studio-ui",
        events: [{ type: "text", value: "E2E" }]
    });
    if (input.delivered !== 1) {
        throw new Error("Electron input injection failed");
    }

    const screenshot = await host.request("screenshot", "capture", {
        target: "studio-ui",
        format: "png",
        rect: { x: 0, y: 0, width: 64, height: 64 }
    });
    const artifact = await host.request("screenshot", "readArtifact", {
        artifactId: screenshot.artifactId
    });
    if (!artifact.done || !artifact.data.startsWith("iVBOR")) {
        throw new Error("Electron screenshot capture did not return PNG data");
    }
    await host.request("screenshot", "deleteArtifact", {
        artifactId: screenshot.artifactId
    });

    const selected = await host.request("asset", "selectSource", {});
    if (
        selected.cancelled ||
        selected.name !== "selected.txt" ||
        selected.size !== 11
    ) {
        throw new Error("Electron asset selection handler failed");
    }

    await host.request("smoke", "activated", {});
}

export async function deactivate(reason) {
    await window.eezExtensionHost.request("smoke", "deactivated", { reason });
}
