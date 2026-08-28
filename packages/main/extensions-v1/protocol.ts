import { protocol } from "electron";

export const EXTENSION_SCHEME = "eez-extension";

// Electron requires privileged schemes to be registered before app readiness.
protocol.registerSchemesAsPrivileged([
    {
        scheme: EXTENSION_SCHEME,
        privileges: {
            standard: true,
            secure: true,
            supportFetchAPI: true,
            corsEnabled: true,
            stream: true
        }
    }
]);
