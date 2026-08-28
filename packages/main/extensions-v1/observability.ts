import { app } from "electron";
import crypto from "crypto";
import fs from "fs";
import path from "path";

export type ExtensionAuditEventType =
    | "host.activation.started"
    | "host.activation.completed"
    | "host.activation.failed"
    | "host.deactivation.completed"
    | "host.unexpected-exit"
    | "permission.granted"
    | "permission.denied"
    | "service.started"
    | "service.completed"
    | "service.failed"
    | "service.cancelled"
    | "integrity.violation";

export interface ExtensionAuditEvent {
    readonly type: ExtensionAuditEventType;
    readonly extensionId: string;
    readonly publisherFingerprint?: string;
    readonly instanceId?: string;
    readonly requestId?: string;
    readonly capability?: string;
    readonly service?: string;
    readonly method?: string;
    readonly workspaceScope?: string;
    readonly durationMs?: number;
    readonly resultCode?: string;
    readonly details?: Readonly<Record<string, unknown>>;
}

export interface ExtensionMetricsSnapshot {
    readonly counters: Readonly<Record<string, number>>;
    readonly gauges: Readonly<Record<string, number>>;
    readonly totalDurationMs: Readonly<Record<string, number>>;
}

const MAX_LOG_BYTES = 10 * 1024 * 1024;
const MAX_ROLLED_FILES = 10;
const SENSITIVE_KEY = /secret|token|password|authorization|cookie|content|prompt/i;

function safeDetails(value: unknown, depth = 0): unknown {
    if (depth > 4) {
        return "[truncated]";
    }
    if (value == null || typeof value === "boolean" || typeof value === "number") {
        return value;
    }
    if (typeof value === "string") {
        return value.slice(0, 512);
    }
    if (Array.isArray(value)) {
        return value.slice(0, 32).map(item => safeDetails(item, depth + 1));
    }
    if (typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .slice(0, 32)
                .map(([key, item]) => [
                    key,
                    SENSITIVE_KEY.test(key) ? "[redacted]" : safeDetails(item, depth + 1)
                ])
        );
    }
    return String(value).slice(0, 512);
}

export class ExtensionObservability {
    private writeQueue = Promise.resolve();
    private readonly counters = new Map<string, number>();
    private readonly gauges = new Map<string, number>();
    private readonly durations = new Map<string, number>();
    private writeFailures = 0;

    constructor(private readonly directory?: string) {}

    private get logDirectory() {
        return this.directory ?? path.join(app.getPath("userData"), "extension-audit");
    }

    emit(event: ExtensionAuditEvent) {
        const counterKey = event.type;
        this.counters.set(counterKey, (this.counters.get(counterKey) ?? 0) + 1);
        if (event.durationMs != undefined && event.service) {
            const key = `${event.service}.${event.method ?? "unknown"}`;
            this.durations.set(key, (this.durations.get(key) ?? 0) + event.durationMs);
        }
        const record = JSON.stringify({
            timestamp: new Date().toISOString(),
            eventId: crypto.randomUUID(),
            ...event,
            publisherFingerprint: event.publisherFingerprint
                ? `sha256:${event.publisherFingerprint.substring(0, 16)}`
                : undefined,
            workspaceScope: event.workspaceScope
                ? crypto.createHash("sha256").update(event.workspaceScope).digest("hex")
                : undefined,
            details: event.details ? safeDetails(event.details) : undefined
        });
        this.writeQueue = this.writeQueue
            .then(() => this.append(record + "\n"))
            .catch(error => {
                this.writeFailures++;
                console.error("Failed to write extension audit event", error);
            });
    }

    setGauge(name: string, value: number) {
        this.gauges.set(name, value);
    }

    snapshot(): ExtensionMetricsSnapshot {
        return {
            counters: Object.fromEntries([
                ...this.counters,
                ["audit.writeFailures", this.writeFailures]
            ]),
            gauges: Object.fromEntries(this.gauges),
            totalDurationMs: Object.fromEntries(this.durations)
        };
    }

    async flush() {
        await this.writeQueue;
    }

    private async append(line: string) {
        await fs.promises.mkdir(this.logDirectory, { recursive: true, mode: 0o700 });
        const logPath = path.join(this.logDirectory, "extensions.jsonl");
        let size = 0;
        try {
            size = (await fs.promises.stat(logPath)).size;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
            }
        }
        if (size + Buffer.byteLength(line, "utf8") > MAX_LOG_BYTES) {
            for (let index = MAX_ROLLED_FILES - 1; index >= 1; index--) {
                try {
                    await fs.promises.rename(`${logPath}.${index}`, `${logPath}.${index + 1}`);
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                        throw error;
                    }
                }
            }
            try {
                await fs.promises.rename(logPath, `${logPath}.1`);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                    throw error;
                }
            }
        }
        await fs.promises.appendFile(logPath, line, { encoding: "utf8", mode: 0o600 });
    }
}
