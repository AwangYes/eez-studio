import path from "path";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export class InteractionServiceError extends Error {
    constructor(
        public readonly code: string,
        message: string
    ) {
        super(message);
        this.name = "InteractionServiceError";
    }
}

export function interactionError(code: string, message: string): never {
    throw new InteractionServiceError(code, message);
}

export function requirePlainObject(
    value: unknown,
    field = "args"
): Record<string, unknown> {
    if (
        value == null ||
        typeof value != "object" ||
        Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    ) {
        interactionError("INVALID_ARGUMENT", `${field} must be a plain object`);
    }
    return value as Record<string, unknown>;
}

export interface ValidatedInputEvent {
    readonly type: "pointer" | "key" | "text";
    readonly action?: "move" | "down" | "up";
    readonly x?: number;
    readonly y?: number;
    readonly button?: "left" | "middle" | "right";
    readonly key?: string;
    readonly value?: string;
    readonly delayMs: number;
}

export interface ValidatedInputRequest {
    readonly target: "studio-ui" | "runtime";
    readonly projectId?: string;
    readonly events: readonly ValidatedInputEvent[];
}

export function validateInputRequest(value: unknown): ValidatedInputRequest {
    const args = requirePlainObject(value);
    const allowed = new Set(["target", "projectId", "events"]);
    for (const key of Object.keys(args)) {
        if (!allowed.has(key)) {
            interactionError("INVALID_ARGUMENT", `Unknown input field: ${key}`);
        }
    }
    if (args.target !== "studio-ui" && args.target !== "runtime") {
        interactionError("INVALID_ARGUMENT", "target must be studio-ui or runtime");
    }
    if (
        args.target === "runtime" &&
        (typeof args.projectId != "string" || args.projectId.length == 0)
    ) {
        interactionError("INVALID_ARGUMENT", "runtime input requires projectId");
    }
    if (!Array.isArray(args.events) || args.events.length == 0 || args.events.length > 100) {
        interactionError("INVALID_ARGUMENT", "events must contain 1 to 100 input events");
    }

    let totalDelay = 0;
    const events = args.events.map((raw, index): ValidatedInputEvent => {
        const event = requirePlainObject(raw, `events[${index}]`);
        const delayMs = event.delayMs === undefined ? 0 : event.delayMs;
        if (!Number.isInteger(delayMs) || (delayMs as number) < 0 || (delayMs as number) > 1000) {
            interactionError("INVALID_ARGUMENT", `events[${index}].delayMs is invalid`);
        }
        totalDelay += delayMs as number;
        if (totalDelay > 10000) {
            interactionError("INVALID_ARGUMENT", "input sequence exceeds 10 seconds");
        }

        if (event.type === "pointer") {
            const allowedKeys = new Set(["type", "action", "x", "y", "button", "delayMs"]);
            if (Object.keys(event).some(key => !allowedKeys.has(key))) {
                interactionError("INVALID_ARGUMENT", `events[${index}] has unknown fields`);
            }
            if (!["move", "down", "up"].includes(event.action as string)) {
                interactionError("INVALID_ARGUMENT", `events[${index}].action is invalid`);
            }
            if (
                !Number.isInteger(event.x) ||
                !Number.isInteger(event.y) ||
                (event.x as number) < 0 ||
                (event.y as number) < 0
            ) {
                interactionError("INVALID_ARGUMENT", `events[${index}] coordinates are invalid`);
            }
            const button = event.button === undefined ? "left" : event.button;
            if (!["left", "middle", "right"].includes(button as string)) {
                interactionError("INVALID_ARGUMENT", `events[${index}].button is invalid`);
            }
            return {
                type: "pointer",
                action: event.action as "move" | "down" | "up",
                x: event.x as number,
                y: event.y as number,
                button: button as "left" | "middle" | "right",
                delayMs: delayMs as number
            };
        }
        if (event.type === "key") {
            const allowedKeys = new Set(["type", "action", "key", "delayMs"]);
            if (Object.keys(event).some(key => !allowedKeys.has(key))) {
                interactionError("INVALID_ARGUMENT", `events[${index}] has unknown fields`);
            }
            if (event.action !== "down" && event.action !== "up") {
                interactionError("INVALID_ARGUMENT", `events[${index}].action is invalid`);
            }
            if (
                typeof event.key != "string" ||
                event.key.length == 0 ||
                event.key.length > 64 ||
                CONTROL_CHARACTERS.test(event.key)
            ) {
                interactionError("INVALID_ARGUMENT", `events[${index}].key is invalid`);
            }
            return {
                type: "key",
                action: event.action,
                key: event.key,
                delayMs: delayMs as number
            };
        }
        if (event.type === "text") {
            const allowedKeys = new Set(["type", "value", "delayMs"]);
            if (Object.keys(event).some(key => !allowedKeys.has(key))) {
                interactionError("INVALID_ARGUMENT", `events[${index}] has unknown fields`);
            }
            if (
                typeof event.value != "string" ||
                event.value.length == 0 ||
                event.value.length > 4096
            ) {
                interactionError("INVALID_ARGUMENT", `events[${index}].value is invalid`);
            }
            return { type: "text", value: event.value, delayMs: delayMs as number };
        }
        interactionError("INVALID_ARGUMENT", `events[${index}].type is invalid`);
    });
    return {
        target: args.target as "studio-ui" | "runtime",
        projectId: args.projectId as string | undefined,
        events
    };
}

export interface ValidatedCaptureRequest {
    readonly projectId?: string;
    readonly target: "studio-ui" | "runtime";
    readonly format: "png" | "jpeg";
    readonly quality: number;
    readonly rect?: { x: number; y: number; width: number; height: number };
}

export function validateCaptureRequest(value: unknown): ValidatedCaptureRequest {
    const args = requirePlainObject(value);
    const allowed = new Set(["projectId", "target", "format", "quality", "rect"]);
    if (Object.keys(args).some(key => !allowed.has(key))) {
        interactionError("INVALID_ARGUMENT", "Screenshot request has unknown fields");
    }
    const target = args.target ?? "studio-ui";
    if (target !== "studio-ui" && target !== "runtime") {
        interactionError("INVALID_ARGUMENT", "target must be studio-ui or runtime");
    }
    if (
        target === "runtime" &&
        (typeof args.projectId != "string" || args.projectId.length == 0)
    ) {
        interactionError("INVALID_ARGUMENT", "runtime capture requires projectId");
    }
    const format = args.format ?? "png";
    if (format !== "png" && format !== "jpeg") {
        interactionError("INVALID_ARGUMENT", "format must be png or jpeg");
    }
    const quality = args.quality ?? 90;
    if (!Number.isInteger(quality) || (quality as number) < 1 || (quality as number) > 100) {
        interactionError("INVALID_ARGUMENT", "quality must be an integer from 1 to 100");
    }
    let rect: ValidatedCaptureRequest["rect"];
    if (args.rect !== undefined) {
        const input = requirePlainObject(args.rect, "rect");
        if (
            Object.keys(input).some(key => !new Set(["x", "y", "width", "height"]).has(key)) ||
            !Number.isInteger(input.x) ||
            !Number.isInteger(input.y) ||
            !Number.isInteger(input.width) ||
            !Number.isInteger(input.height) ||
            (input.x as number) < 0 ||
            (input.y as number) < 0 ||
            (input.width as number) < 1 ||
            (input.height as number) < 1 ||
            (input.width as number) * (input.height as number) > 16_777_216
        ) {
            interactionError("INVALID_ARGUMENT", "rect is invalid or exceeds 16 megapixels");
        }
        rect = input as unknown as ValidatedCaptureRequest["rect"];
    }
    return {
        target,
        projectId: args.projectId as string | undefined,
        format,
        quality: quality as number,
        rect
    };
}

export function resolveAssetTarget(rootPath: string, relativePath: unknown) {
    if (
        typeof relativePath != "string" ||
        relativePath.length == 0 ||
        relativePath.length > 512 ||
        relativePath.includes("\0")
    ) {
        interactionError("INVALID_ARGUMENT", "relativePath is invalid");
    }
    const portable = relativePath.replace(/\\/g, "/");
    if (
        path.posix.isAbsolute(portable) ||
        path.win32.isAbsolute(relativePath) ||
        portable.split("/").some(part => part === ".." || part === "")
    ) {
        interactionError("ASSET_PATH_UNSAFE", "Asset path must be a normalized relative path");
    }
    const root = path.resolve(rootPath);
    const target = path.resolve(root, ...portable.split("/"));
    const relative = path.relative(root, target);
    if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
        interactionError("ASSET_PATH_UNSAFE", "Asset path escapes the project directory");
    }
    return { targetPath: target, relativePath: portable };
}

export class SlidingWindowRateLimiter {
    private readonly calls = new Map<string, number[]>();

    constructor(
        private readonly limit: number,
        private readonly windowMs: number
    ) {}

    consume(key: string, now = Date.now()) {
        const active = (this.calls.get(key) ?? []).filter(time => time > now - this.windowMs);
        if (active.length >= this.limit) {
            interactionError("TOO_MANY_REQUESTS", "Extension request rate limit exceeded");
        }
        active.push(now);
        this.calls.set(key, active);
    }

    delete(key: string) {
        this.calls.delete(key);
    }
}
