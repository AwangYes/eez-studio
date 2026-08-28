import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { dialog, getCurrentWindow } from "@electron/remote";

import type { ProjectStore } from "project-editor/store";
import {
    interactionError,
    requirePlainObject,
    resolveAssetTarget,
    SlidingWindowRateLimiter,
    validateCaptureRequest,
    validateInputRequest
} from "home/extensions-v1/interaction-service-utils";
import type { StudioServiceRequest } from "home/extensions-v1/service-host";

interface InteractionDependencies {
    resolveProject(projectId: string): { store: ProjectStore; tab: unknown };
    applyProjectEdits(request: StudioServiceRequest): Promise<unknown>;
}

interface AssetToken {
    extensionId: string;
    sourcePath: string;
    size: number;
    digest: string;
    expiresAt: number;
}

interface Artifact {
    extensionId: string;
    bytes: Buffer;
    mimeType: "image/png" | "image/jpeg";
    width: number;
    height: number;
    expiresAt: number;
}

const MAX_ASSET_BYTES = 32 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const ARTIFACT_TTL_MS = 5 * 60 * 1000;
const ASSET_TOKEN_TTL_MS = 5 * 60 * 1000;
const assetTokens = new Map<string, AssetToken>();
const artifacts = new Map<string, Artifact>();
let artifactBytes = 0;

const inputRate = new SlidingWindowRateLimiter(30, 60_000);
const captureRate = new SlidingWindowRateLimiter(60, 60_000);
const importRate = new SlidingWindowRateLimiter(20, 60_000);

function checkAbort(signal: AbortSignal) {
    if (signal.aborted) {
        interactionError("CANCELLED", "Interaction request was cancelled");
    }
}

async function digestFile(filePath: string) {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
    for await (const chunk of stream) {
        hash.update(chunk as Buffer);
    }
    return hash.digest("hex");
}

async function syncFile(filePath: string) {
    const handle = await fs.promises.open(filePath, "r");
    try {
        await handle.sync();
    } catch (error) {
        // Windows does not guarantee fsync support for every filesystem
        // provider (for example hosted CI volumes). The file write and atomic
        // rename remain valid; report only errors that indicate a real I/O
        // failure while allowing the documented degraded-durability mode.
        const code = (error as NodeJS.ErrnoException).code;
        if (
            process.platform != "win32" ||
            (code != "EPERM" && code != "EINVAL" && code != "ENOTSUP")
        ) {
            throw error;
        }
    } finally {
        await handle.close();
    }
}

function assertNoSymlinkEscape(rootPath: string, targetPath: string) {
    const realRoot = fs.realpathSync(rootPath);
    let current = rootPath;
    const relative = path.relative(rootPath, path.dirname(targetPath));
    for (const component of relative.split(path.sep)) {
        if (!component) continue;
        current = path.join(current, component);
        if (!fs.existsSync(current)) break;
        if (!fs.statSync(current).isDirectory() || fs.realpathSync(current) !== current && !fs.realpathSync(current).startsWith(realRoot + path.sep)) {
            interactionError("ASSET_PATH_UNSAFE", "Asset destination contains an unsafe path component");
        }
    }
}

function cleanExpired() {
    const now = Date.now();
    for (const [id, token] of assetTokens) {
        if (token.expiresAt <= now) assetTokens.delete(id);
    }
    for (const [id, artifact] of artifacts) {
        if (artifact.expiresAt <= now) {
            artifactBytes -= artifact.bytes.length;
            artifacts.delete(id);
        }
    }
}

function ensureProjectRuntime(
    deps: InteractionDependencies,
    target: "studio-ui" | "runtime",
    projectId: string | undefined
) {
    if (target !== "runtime") return;
    if (!projectId) interactionError("INVALID_ARGUMENT", "runtime target requires projectId");
    const { store } = deps.resolveProject(projectId);
    if (!store.runtime || (!store.runtime.isRunning && !store.runtime.isPaused)) {
        interactionError("INVALID_RUNTIME_STATE", "Runtime is not running");
    }
}

async function inputService(request: StudioServiceRequest, deps: InteractionDependencies) {
    inputRate.consume(request.extensionId);
    const args = validateInputRequest(request.args);
    ensureProjectRuntime(deps, args.target, args.projectId);
    const webContents = getCurrentWindow().webContents;
    const contentBounds = getCurrentWindow().getContentBounds();
    const width = contentBounds.width;
    const height = contentBounds.height;
    let delivered = 0;
    for (const event of args.events) {
        checkAbort(request.signal);
        if (event.delayMs) {
            await new Promise<void>((resolve, reject) => {
                const onAbort = () => {
                    clearTimeout(timer);
                    reject(new Error("Input sequence cancelled"));
                };
                const timer = setTimeout(() => {
                    request.signal.removeEventListener("abort", onAbort);
                    resolve();
                }, event.delayMs);
                request.signal.addEventListener("abort", onAbort, { once: true });
                if (request.signal.aborted) onAbort();
            });
        }
        if (event.type === "pointer") {
            if ((event.x as number) >= width || (event.y as number) >= height) {
                interactionError("INVALID_ARGUMENT", "Pointer coordinates are outside the Studio window");
            }
            const button = event.button ?? "left";
            await webContents.sendInputEvent({
                type: event.action === "move" ? "mouseMove" : event.action === "down" ? "mouseDown" : "mouseUp",
                x: event.x as number,
                y: event.y as number,
                button
            } as Electron.MouseInputEvent);
        } else if (event.type === "key") {
            await webContents.sendInputEvent({ type: event.action === "down" ? "keyDown" : "keyUp", keyCode: event.key } as Electron.KeyboardInputEvent);
        } else {
            for (const character of event.value as string) {
                checkAbort(request.signal);
                await webContents.sendInputEvent({ type: "char", keyCode: character } as Electron.KeyboardInputEvent);
            }
        }
        delivered++;
    }
    return { delivered, target: args.target };
}

async function screenshotService(request: StudioServiceRequest, deps: InteractionDependencies) {
    cleanExpired();
    captureRate.consume(request.extensionId);
    const args = validateCaptureRequest(request.args);
    ensureProjectRuntime(deps, args.target, args.projectId);
    checkAbort(request.signal);
    const webContents = getCurrentWindow().webContents;
    const contentBounds = getCurrentWindow().getContentBounds();
    const contentWidth = contentBounds.width;
    const contentHeight = contentBounds.height;
    const rect = args.rect ?? { x: 0, y: 0, width: contentWidth, height: contentHeight };
    if (rect.x + rect.width > contentWidth || rect.y + rect.height > contentHeight) {
        interactionError("INVALID_ARGUMENT", "Capture rectangle is outside the Studio window");
    }
    const image = await webContents.capturePage(rect);
    checkAbort(request.signal);
    const bytes = args.format === "png" ? image.toPNG() : image.toJPEG(args.quality);
    if (bytes.length > MAX_ARTIFACT_BYTES) {
        interactionError("RESPONSE_TOO_LARGE", "Screenshot exceeds the artifact size limit");
    }
    const size = image.getSize();
    const artifactId = crypto.randomUUID();
    const expiresAt = Date.now() + ARTIFACT_TTL_MS;
    artifacts.set(artifactId, {
        extensionId: request.extensionId,
        bytes,
        mimeType: args.format === "png" ? "image/png" : "image/jpeg",
        width: size.width,
        height: size.height,
        expiresAt
    });
    artifactBytes += bytes.length;
    while (artifactBytes > MAX_ARTIFACT_BYTES && artifacts.size > 0) {
        const oldest = artifacts.keys().next().value as string;
        const value = artifacts.get(oldest)!;
        artifactBytes -= value.bytes.length;
        artifacts.delete(oldest);
    }
    return {
        artifactId,
        mimeType: args.format === "png" ? "image/png" : "image/jpeg",
        width: size.width,
        height: size.height,
        byteLength: bytes.length,
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        expiresAt: new Date(expiresAt).toISOString()
    };
}

async function readArtifactService(request: StudioServiceRequest) {
    cleanExpired();
    const args = request.args as any;
    if (!args || typeof args.artifactId !== "string") interactionError("INVALID_ARGUMENT", "artifactId is required");
    const artifact = artifacts.get(args.artifactId) ?? interactionError("OBJECT_NOT_FOUND", "Unknown screenshot artifact");
    if (artifact.extensionId !== request.extensionId) interactionError("PERMISSION_DENIED", "Artifact belongs to another extension");
    const offset = args.offset ?? 0;
    const limit = args.limit ?? 512 * 1024;
    if (!Number.isInteger(offset) || !Number.isInteger(limit) || offset < 0 || limit < 1 || limit > 512 * 1024 || offset > artifact.bytes.length) {
        interactionError("INVALID_ARGUMENT", "Invalid artifact range");
    }
    const end = Math.min(offset + limit, artifact.bytes.length);
    return { artifactId: args.artifactId, offset, nextOffset: end < artifact.bytes.length ? end : undefined, data: artifact.bytes.subarray(offset, end).toString("base64"), done: end >= artifact.bytes.length };
}

async function deleteArtifactService(request: StudioServiceRequest) {
    const id = (request.args as any)?.artifactId;
    const artifact = artifacts.get(id);
    if (!artifact) return { deleted: false };
    if (artifact.extensionId !== request.extensionId) interactionError("PERMISSION_DENIED", "Artifact belongs to another extension");
    artifactBytes -= artifact.bytes.length;
    artifacts.delete(id);
    return { deleted: true };
}

async function selectAssetSourceService(request: StudioServiceRequest) {
    importRate.consume(request.extensionId);
    checkAbort(request.signal);
    const result = await dialog.showOpenDialog(getCurrentWindow(), { properties: ["openFile"] });
    checkAbort(request.signal);
    if (result.canceled || result.filePaths.length === 0) return { cancelled: true };
    const sourcePath = path.resolve(result.filePaths[0]);
    const linkStat = await fs.promises.lstat(sourcePath);
    if (linkStat.isSymbolicLink()) interactionError("ASSET_SOURCE_UNSAFE", "Symbolic-link asset sources are not allowed");
    const stat = linkStat;
    if (!stat.isFile() || stat.size > MAX_ASSET_BYTES) interactionError("REQUEST_TOO_LARGE", "Asset exceeds the size limit");
    const token = crypto.randomUUID();
    let digest: string;
    try {
        digest = await digestFile(sourcePath);
    } catch (error) {
        interactionError("ASSET_SOURCE_CHANGED", "Selected asset could not be read");
    }
    const expiresAt = Date.now() + ASSET_TOKEN_TTL_MS;
    assetTokens.set(token, { extensionId: request.extensionId, sourcePath, size: stat.size, digest, expiresAt });
    return { cancelled: false, token, name: path.basename(sourcePath), size: stat.size, sha256: digest, expiresAt: new Date(expiresAt).toISOString() };
}

async function importAssetService(request: StudioServiceRequest, deps: InteractionDependencies) {
    cleanExpired();
    importRate.consume(request.extensionId);
    const args = requirePlainObject(request.args, "asset import args") as any;
    const allowed = new Set([
        "token",
        "projectId",
        "relativePath",
        "replace",
        "expectedRevision",
        "label",
        "edits"
    ]);
    if (Object.keys(args).some(key => !allowed.has(key))) {
        interactionError("INVALID_ARGUMENT", "Asset import request has unknown fields");
    }
    if (!args || typeof args.token !== "string" || typeof args.projectId !== "string") interactionError("INVALID_ARGUMENT", "token and projectId are required");
    if (args.replace !== undefined && typeof args.replace !== "boolean") interactionError("INVALID_ARGUMENT", "replace must be a boolean");
    if (args.edits !== undefined && (!Array.isArray(args.edits) || args.edits.length > 1000)) interactionError("INVALID_ARGUMENT", "edits must contain at most 1000 entries");
    const token = assetTokens.get(args.token);
    if (!token || token.extensionId !== request.extensionId) interactionError("PERMISSION_DENIED", "Invalid or expired asset token");
    checkAbort(request.signal);
    const { store } = deps.resolveProject(args.projectId);
    if (!store.filePath) interactionError("INVALID_ARGUMENT", "Project has no local file path");
    if (args.expectedRevision !== undefined) {
        if (typeof args.expectedRevision !== "string") interactionError("INVALID_ARGUMENT", "expectedRevision must be a string");
        store.assertRevision(args.expectedRevision);
    }
    const { targetPath, relativePath } = resolveAssetTarget(path.dirname(store.filePath), args.relativePath);
    assertNoSymlinkEscape(path.dirname(store.filePath), targetPath);
    if (fs.existsSync(targetPath) && args.replace !== true) interactionError("INVALID_ARGUMENT", "Asset already exists; set replace to true");
    let sourceStat: fs.Stats;
    try {
        sourceStat = await fs.promises.lstat(token.sourcePath);
    } catch (error) {
        interactionError("ASSET_SOURCE_CHANGED", "Selected asset is no longer available");
    }
    if (sourceStat.isSymbolicLink()) interactionError("ASSET_SOURCE_UNSAFE", "Selected asset became a symbolic link");
    let sourceDigest: string;
    try {
        sourceDigest = await digestFile(token.sourcePath);
    } catch (error) {
        interactionError("ASSET_SOURCE_CHANGED", "Selected asset could not be read");
    }
    if (sourceStat.size !== token.size || sourceDigest !== token.digest) interactionError("ASSET_SOURCE_CHANGED", "Selected asset changed on disk");
    const stagingPath = path.join(os.tmpdir(), `eez-asset-${crypto.randomUUID()}`);
    try {
        await fs.promises.copyFile(token.sourcePath, stagingPath, fs.constants.COPYFILE_EXCL);
        await syncFile(stagingPath);
        if (await digestFile(stagingPath) !== token.digest) {
            interactionError("ASSET_SOURCE_CHANGED", "Selected asset changed while it was being staged");
        }
    } catch (error) {
        await fs.promises.rm(stagingPath, { force: true }).catch(() => undefined);
        throw error;
    }
    let backupPath: string | undefined;
    let projectApplied = false;
    let projectRevision: string | undefined;
    try {
        await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
        if (fs.existsSync(targetPath)) {
            backupPath = `${targetPath}.eez-backup-${crypto.randomUUID()}`;
            await fs.promises.rename(targetPath, backupPath);
        }
        await fs.promises.rename(stagingPath, targetPath);
        await syncFile(targetPath);
        checkAbort(request.signal);
        const edits = Array.isArray(args.edits) ? args.edits : [];
        let projectResult: any = { projectId: args.projectId, revision: (store as any).publicRevision, dirty: store.isModified };
        if (edits.length > 0) {
            projectResult = await deps.applyProjectEdits({ ...request, service: "project", method: "applyEdits", args: { projectId: args.projectId, expectedRevision: args.expectedRevision, edits, label: args.label ?? "Import asset" } });
            projectApplied = true;
            projectRevision = projectResult.revision;
        }
        if (backupPath) await fs.promises.rm(backupPath, { force: true });
        assetTokens.delete(args.token);
        return { assetPath: relativePath, sha256: token.digest, byteLength: token.size, projectId: args.projectId, revision: projectResult.revision, dirty: projectResult.dirty, temporaryIds: projectResult.temporaryIds ?? {} };
    } catch (error) {
        let rollbackFailure: unknown;
        if (projectApplied && projectRevision && args.edits?.length) {
            try {
                store.assertRevision(projectRevision);
                store.undoManager.undo();
            } catch (undoError) {
                rollbackFailure = undoError;
            }
        }
        try {
            await fs.promises.rm(targetPath, { force: true });
            if (backupPath) await fs.promises.rename(backupPath, targetPath);
        } catch (fileRollbackError) {
            rollbackFailure = rollbackFailure ?? fileRollbackError;
        }
        await fs.promises.rm(stagingPath, { force: true }).catch(cleanupError => {
            rollbackFailure = rollbackFailure ?? cleanupError;
        });
        if (rollbackFailure) {
            const rollbackError = new Error("Asset import rollback failed") as Error & { code: string; cause?: unknown };
            rollbackError.code = "ASSET_ROLLBACK_FAILED";
            rollbackError.cause = rollbackFailure;
            throw rollbackError;
        }
        throw error;
    }
}

export function registerInteractionExtensionServices(deps: InteractionDependencies) {
    return [
        { service: "input", handler: (request: StudioServiceRequest) => inputService(request, deps) },
        { service: "screenshot", handler: async (request: StudioServiceRequest) => request.method === "capture" ? screenshotService(request, deps) : request.method === "readArtifact" ? readArtifactService(request) : request.method === "deleteArtifact" ? deleteArtifactService(request) : interactionError("METHOD_NOT_FOUND", `Unknown screenshot method: ${request.method}`) },
        { service: "asset", handler: async (request: StudioServiceRequest) => request.method === "selectSource" ? selectAssetSourceService(request) : request.method === "import" ? importAssetService(request, deps) : interactionError("METHOD_NOT_FOUND", `Unknown asset method: ${request.method}`) }
    ];
}
