import {
    createHmac,
    randomBytes,
    randomUUID,
    timingSafeEqual
} from "crypto";
import { TextDecoder } from "util";

import { ExtensionV1Error } from "./errors";

export type LocalEndpointTransport = "unix" | "named-pipe";

export interface LocalEndpointDescriptor {
    readonly version: 1;
    readonly transport: LocalEndpointTransport;
    readonly address: string;
    readonly instanceId: string;
    readonly nonce: string;
    readonly createdAt: number;
    readonly expiresAt: number;
}

export interface CreateLocalEndpointDescriptorOptions {
    readonly transport: LocalEndpointTransport;
    readonly address: string;
    readonly now?: number;
    readonly ttlMs?: number;
}

export interface LocalEndpointAuthentication {
    readonly endpointInstanceId: string;
    readonly endpointNonce: string;
    readonly clientNonce: string;
    readonly timestamp: number;
}

export interface AuthenticationVerificationOptions {
    readonly now?: number;
    readonly maxClockSkewMs?: number;
    readonly replayCache?: NonceReplayCache;
}

export interface CreateLocalEndpointAuthenticationOptions {
    readonly now?: number;
    readonly clientNonce?: string;
}

export interface FrameDecoderOptions {
    readonly maxFrameBytes?: number;
    readonly maxBufferedBytes?: number;
}

const DESCRIPTOR_KEYS = new Set([
    "version",
    "transport",
    "address",
    "instanceId",
    "nonce",
    "createdAt",
    "expiresAt"
]);
const AUTHENTICATION_KEYS = new Set([
    "endpointInstanceId",
    "endpointNonce",
    "clientNonce",
    "timestamp"
]);
const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const NAMED_PIPE_PATTERN = /^\\\\\.\\pipe\\[^\u0000-\u001f\u007f\\/]{1,220}$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const DEFAULT_ENDPOINT_TTL_MS = 5 * 60 * 1000;
const MAX_ENDPOINT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const JSON_MAX_DEPTH = 64;

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== "object") {
        return false;
    }

    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function requireSafeInteger(
    value: unknown,
    field: string,
    minimum = 0
): number {
    if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < minimum
    ) {
        throw new ExtensionV1Error(
            "INVALID_ARGUMENT",
            `${field} must be a safe integer greater than or equal to ${minimum}`,
            { details: { field } }
        );
    }
    return value;
}

function validateNonce(value: unknown, field: string): string {
    if (
        typeof value !== "string" ||
        value.length < 22 ||
        value.length > 86 ||
        !BASE64URL_PATTERN.test(value)
    ) {
        throw new ExtensionV1Error(
            "INVALID_ARGUMENT",
            `${field} must be an unpadded base64url nonce between 16 and 64 bytes`,
            { details: { field } }
        );
    }

    const decoded = decodeBase64Url(value);
    if (
        decoded.length < 16 ||
        decoded.length > 64 ||
        encodeBase64Url(decoded) !== value
    ) {
        throw new ExtensionV1Error(
            "INVALID_ARGUMENT",
            `${field} must decode to between 16 and 64 bytes`,
            { details: { field } }
        );
    }
    return value;
}

function encodeBase64Url(value: Buffer): string {
    return value
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Buffer {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const paddingLength = (4 - (base64.length % 4)) % 4;
    return Buffer.from(base64 + "=".repeat(paddingLength), "base64");
}

function validateAddress(
    transport: LocalEndpointTransport,
    address: unknown
): string {
    if (
        typeof address !== "string" ||
        address.length === 0 ||
        CONTROL_CHARACTER.test(address)
    ) {
        throw new ExtensionV1Error(
            "INVALID_ENDPOINT",
            "Local endpoint address is invalid",
            { details: { field: "address" } }
        );
    }

    if (transport === "unix") {
        const pathSegments = address.split("/").slice(1);
        if (
            !address.startsWith("/") ||
            Buffer.byteLength(address, "utf8") > 103 ||
            pathSegments.some(
                segment =>
                    segment.length === 0 || segment === "." || segment === ".."
            )
        ) {
            throw new ExtensionV1Error(
                "INVALID_ENDPOINT",
                "Unix endpoint address must be a normalized absolute socket path of at most 103 bytes",
                { details: { field: "address" } }
            );
        }
    } else if (!NAMED_PIPE_PATTERN.test(address)) {
        throw new ExtensionV1Error(
            "INVALID_ENDPOINT",
            "Named pipe address must use the \\\\.\\pipe\\name form",
            { details: { field: "address" } }
        );
    }

    return address;
}

function validateAuthentication(
    value: LocalEndpointAuthentication
): LocalEndpointAuthentication {
    if (!isPlainObject(value)) {
        throw new ExtensionV1Error(
            "INVALID_ARGUMENT",
            "Authentication message must be a plain object"
        );
    }
    for (const key of Object.keys(value)) {
        if (!AUTHENTICATION_KEYS.has(key)) {
            throw new ExtensionV1Error(
                "INVALID_ARGUMENT",
                `Authentication message contains unknown field: ${key}`,
                { details: { field: key } }
            );
        }
    }
    if (
        typeof value.endpointInstanceId !== "string" ||
        !UUID_PATTERN.test(value.endpointInstanceId)
    ) {
        throw new ExtensionV1Error(
            "INVALID_ARGUMENT",
            "endpointInstanceId must be a UUID",
            { details: { field: "endpointInstanceId" } }
        );
    }

    return Object.freeze({
        endpointInstanceId: value.endpointInstanceId,
        endpointNonce: validateNonce(value.endpointNonce, "endpointNonce"),
        clientNonce: validateNonce(value.clientNonce, "clientNonce"),
        timestamp: requireSafeInteger(value.timestamp, "timestamp")
    });
}

function appendLengthPrefixed(parts: Buffer[], value: string): void {
    const encoded = Buffer.from(value, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(encoded.length, 0);
    parts.push(length, encoded);
}

function validateSecret(secret: string | Uint8Array): Buffer {
    const encoded =
        typeof secret === "string"
            ? Buffer.from(secret, "utf8")
            : Buffer.from(secret);
    if (encoded.length < 32) {
        throw new ExtensionV1Error(
            "INVALID_ARGUMENT",
            "HMAC secret must contain at least 32 bytes",
            { details: { field: "secret" } }
        );
    }
    return encoded;
}

function validateJsonValue(
    value: unknown,
    seen: Set<object>,
    depth: number
): void {
    if (depth > JSON_MAX_DEPTH) {
        throw new ExtensionV1Error(
            "INVALID_FRAME",
            "JSON frame exceeds the maximum nesting depth"
        );
    }
    if (
        value === null ||
        typeof value === "string" ||
        typeof value === "boolean"
    ) {
        return;
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            throw new ExtensionV1Error(
                "INVALID_FRAME",
                "JSON frame contains a non-finite number"
            );
        }
        return;
    }
    if (typeof value !== "object") {
        throw new ExtensionV1Error(
            "INVALID_FRAME",
            "JSON frame contains a non-JSON value"
        );
    }
    if (seen.has(value)) {
        throw new ExtensionV1Error(
            "INVALID_FRAME",
            "JSON frame contains a cycle"
        );
    }
    seen.add(value);
    if (Array.isArray(value)) {
        for (const item of value) {
            validateJsonValue(item, seen, depth + 1);
        }
    } else {
        if (!isPlainObject(value)) {
            throw new ExtensionV1Error(
                "INVALID_FRAME",
                "JSON frame contains a non-plain object"
            );
        }
        for (const key of Object.keys(value)) {
            validateJsonValue(value[key], seen, depth + 1);
        }
    }
    seen.delete(value);
}

function validateFrameObject(value: unknown): Record<string, unknown> {
    if (!isPlainObject(value)) {
        throw new ExtensionV1Error(
            "INVALID_FRAME",
            "Frame payload must be a JSON object"
        );
    }
    validateJsonValue(value, new Set(), 0);
    return value;
}

export function createNonce(byteLength = 32): string {
    requireSafeInteger(byteLength, "byteLength", 16);
    if (byteLength > 64) {
        throw new ExtensionV1Error(
            "INVALID_ARGUMENT",
            "byteLength must not exceed 64",
            { details: { field: "byteLength" } }
        );
    }
    return encodeBase64Url(randomBytes(byteLength));
}

export function createLocalEndpointDescriptor(
    options: CreateLocalEndpointDescriptorOptions
): LocalEndpointDescriptor {
    const now = options.now === undefined ? Date.now() : options.now;
    const ttlMs =
        options.ttlMs === undefined ? DEFAULT_ENDPOINT_TTL_MS : options.ttlMs;
    requireSafeInteger(now, "now");
    requireSafeInteger(ttlMs, "ttlMs", 1);
    if (ttlMs > MAX_ENDPOINT_TTL_MS || now > Number.MAX_SAFE_INTEGER - ttlMs) {
        throw new ExtensionV1Error(
            "INVALID_ARGUMENT",
            "ttlMs exceeds the supported endpoint lifetime",
            { details: { field: "ttlMs" } }
        );
    }

    return validateLocalEndpointDescriptor({
        version: 1,
        transport: options.transport,
        address: options.address,
        instanceId: randomUUID(),
        nonce: createNonce(),
        createdAt: now,
        expiresAt: now + ttlMs
    });
}

export function validateLocalEndpointDescriptor(
    value: unknown
): LocalEndpointDescriptor {
    if (!isPlainObject(value)) {
        throw new ExtensionV1Error(
            "INVALID_ENDPOINT",
            "Local endpoint descriptor must be a plain object"
        );
    }
    for (const key of Object.keys(value)) {
        if (!DESCRIPTOR_KEYS.has(key)) {
            throw new ExtensionV1Error(
                "INVALID_ENDPOINT",
                `Local endpoint descriptor contains unknown field: ${key}`,
                { details: { field: key } }
            );
        }
    }
    if (value.version !== 1) {
        throw new ExtensionV1Error(
            "INVALID_ENDPOINT",
            "Local endpoint descriptor version must be 1",
            { details: { field: "version" } }
        );
    }
    if (value.transport !== "unix" && value.transport !== "named-pipe") {
        throw new ExtensionV1Error(
            "INVALID_ENDPOINT",
            "Local endpoint transport is invalid",
            { details: { field: "transport" } }
        );
    }
    if (
        typeof value.instanceId !== "string" ||
        !UUID_PATTERN.test(value.instanceId)
    ) {
        throw new ExtensionV1Error(
            "INVALID_ENDPOINT",
            "Local endpoint instanceId must be a UUID",
            { details: { field: "instanceId" } }
        );
    }

    let nonce: string;
    let createdAt: number;
    let expiresAt: number;
    try {
        nonce = validateNonce(value.nonce, "nonce");
        createdAt = requireSafeInteger(value.createdAt, "createdAt");
        expiresAt = requireSafeInteger(value.expiresAt, "expiresAt");
    } catch (error) {
        if (error instanceof ExtensionV1Error) {
            throw new ExtensionV1Error("INVALID_ENDPOINT", error.message, {
                details: error.details,
                cause: error
            });
        }
        throw error;
    }
    if (
        expiresAt <= createdAt ||
        expiresAt - createdAt > MAX_ENDPOINT_TTL_MS
    ) {
        throw new ExtensionV1Error(
            "INVALID_ENDPOINT",
            "Local endpoint expiration is invalid",
            { details: { field: "expiresAt" } }
        );
    }

    return Object.freeze({
        version: 1,
        transport: value.transport,
        address: validateAddress(value.transport, value.address),
        instanceId: value.instanceId,
        nonce,
        createdAt,
        expiresAt
    });
}

export function encodeFrame(
    value: Record<string, unknown>,
    maxFrameBytes = DEFAULT_MAX_FRAME_BYTES
): Buffer {
    requireSafeInteger(maxFrameBytes, "maxFrameBytes", 1);
    validateFrameObject(value);

    let payload: Buffer;
    try {
        payload = Buffer.from(JSON.stringify(value), "utf8");
    } catch (error) {
        throw new ExtensionV1Error(
            "INVALID_FRAME",
            "Frame payload could not be serialized",
            { cause: error }
        );
    }
    if (payload.length === 0) {
        throw new ExtensionV1Error(
            "INVALID_FRAME",
            "Frame payload must not be empty"
        );
    }
    if (payload.length > maxFrameBytes) {
        throw new ExtensionV1Error(
            "FRAME_TOO_LARGE",
            "Frame exceeds the configured size limit",
            { details: { frameBytes: payload.length, maxFrameBytes } }
        );
    }

    const frame = Buffer.allocUnsafe(4 + payload.length);
    frame.writeUInt32BE(payload.length, 0);
    payload.copy(frame, 4);
    return frame;
}

export class FrameDecoder {
    private buffer = Buffer.alloc(0);
    private readonly maxFrameBytes: number;
    private readonly maxBufferedBytes: number;
    private readonly decoder = new TextDecoder("utf-8", { fatal: true });

    constructor(options: FrameDecoderOptions = {}) {
        this.maxFrameBytes = requireSafeInteger(
            options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
            "maxFrameBytes",
            1
        );
        this.maxBufferedBytes = requireSafeInteger(
            options.maxBufferedBytes ?? this.maxFrameBytes + 4,
            "maxBufferedBytes",
            4
        );
        if (this.maxBufferedBytes < this.maxFrameBytes + 4) {
            throw new ExtensionV1Error(
                "INVALID_ARGUMENT",
                "maxBufferedBytes must hold one maximum-size frame",
                { details: { field: "maxBufferedBytes" } }
            );
        }
    }

    push(chunk: Uint8Array): Record<string, unknown>[] {
        if (!(chunk instanceof Uint8Array)) {
            throw new ExtensionV1Error(
                "INVALID_ARGUMENT",
                "Frame chunk must be a Uint8Array",
                { details: { field: "chunk" } }
            );
        }
        if (this.buffer.length + chunk.byteLength > this.maxBufferedBytes) {
            this.reset();
            throw new ExtensionV1Error(
                "FRAME_TOO_LARGE",
                "Buffered frame data exceeds the configured size limit",
                { details: { maxBufferedBytes: this.maxBufferedBytes } }
            );
        }

        this.buffer = Buffer.concat([
            this.buffer,
            Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
        ]);
        const frames: Record<string, unknown>[] = [];
        let offset = 0;

        while (this.buffer.length - offset >= 4) {
            const frameLength = this.buffer.readUInt32BE(offset);
            if (frameLength === 0) {
                this.reset();
                throw new ExtensionV1Error(
                    "INVALID_FRAME",
                    "Zero-length frames are not allowed"
                );
            }
            if (frameLength > this.maxFrameBytes) {
                this.reset();
                throw new ExtensionV1Error(
                    "FRAME_TOO_LARGE",
                    "Frame exceeds the configured size limit",
                    { details: { frameBytes: frameLength, maxFrameBytes: this.maxFrameBytes } }
                );
            }
            if (this.buffer.length - offset - 4 < frameLength) {
                break;
            }

            const payload = this.buffer.subarray(
                offset + 4,
                offset + 4 + frameLength
            );
            let parsed: unknown;
            try {
                parsed = JSON.parse(this.decoder.decode(payload));
            } catch (error) {
                this.reset();
                throw new ExtensionV1Error(
                    "INVALID_FRAME",
                    "Frame contains invalid UTF-8 or JSON",
                    { cause: error }
                );
            }
            try {
                frames.push(validateFrameObject(parsed));
            } catch (error) {
                this.reset();
                throw error;
            }
            offset += 4 + frameLength;
        }

        if (offset > 0) {
            this.buffer = Buffer.from(this.buffer.subarray(offset));
        }
        return frames;
    }

    reset(): void {
        this.buffer = Buffer.alloc(0);
    }

    get bufferedBytes(): number {
        return this.buffer.length;
    }
}

export function encodeAuthenticationPayload(
    authentication: LocalEndpointAuthentication
): Buffer {
    const validated = validateAuthentication(authentication);
    const parts: Buffer[] = [Buffer.from("EEZ-EXTENSION-V1-AUTH\0", "ascii")];
    appendLengthPrefixed(parts, validated.endpointInstanceId);
    appendLengthPrefixed(parts, validated.endpointNonce);
    appendLengthPrefixed(parts, validated.clientNonce);

    const timestamp = Buffer.allocUnsafe(8);
    timestamp.writeBigUInt64BE(BigInt(validated.timestamp), 0);
    parts.push(timestamp);
    return Buffer.concat(parts);
}

export function createLocalEndpointAuthentication(
    descriptor: LocalEndpointDescriptor,
    options: CreateLocalEndpointAuthenticationOptions = {}
): LocalEndpointAuthentication {
    const validatedDescriptor = validateLocalEndpointDescriptor(descriptor);
    const timestamp = options.now === undefined ? Date.now() : options.now;
    requireSafeInteger(timestamp, "now");

    if (
        timestamp < validatedDescriptor.createdAt ||
        timestamp >= validatedDescriptor.expiresAt
    ) {
        throw new ExtensionV1Error(
            "AUTHENTICATION_FAILED",
            "Local endpoint descriptor is not active"
        );
    }

    return Object.freeze({
        endpointInstanceId: validatedDescriptor.instanceId,
        endpointNonce: validatedDescriptor.nonce,
        clientNonce:
            options.clientNonce === undefined
                ? createNonce()
                : validateNonce(options.clientNonce, "clientNonce"),
        timestamp
    });
}

export function createAuthenticationMac(
    secret: string | Uint8Array,
    authentication: LocalEndpointAuthentication
): string {
    const digest = createHmac("sha256", validateSecret(secret))
        .update(encodeAuthenticationPayload(authentication))
        .digest();
    return encodeBase64Url(digest);
}

export function verifyAuthenticationMac(
    secret: string | Uint8Array,
    authentication: LocalEndpointAuthentication,
    mac: string
): boolean {
    const expected = decodeBase64Url(
        createAuthenticationMac(secret, authentication)
    );
    if (
        typeof mac !== "string" ||
        mac.length !== 43 ||
        !BASE64URL_PATTERN.test(mac)
    ) {
        return false;
    }
    const received = decodeBase64Url(mac);
    return received.length === expected.length && timingSafeEqual(received, expected);
}

export class NonceReplayCache {
    private readonly entries = new Map<string, number>();
    readonly ttlMs: number;
    readonly maxEntries: number;

    constructor(ttlMs = 5 * 60 * 1000, maxEntries = 4096) {
        this.ttlMs = requireSafeInteger(ttlMs, "ttlMs", 1);
        this.maxEntries = requireSafeInteger(maxEntries, "maxEntries", 1);
        if (this.ttlMs > MAX_ENDPOINT_TTL_MS) {
            throw new ExtensionV1Error(
                "INVALID_ARGUMENT",
                "Replay cache ttlMs exceeds the maximum endpoint lifetime",
                { details: { field: "ttlMs" } }
            );
        }
    }

    consume(nonce: string, now = Date.now()): void {
        validateNonce(nonce, "nonce");
        requireSafeInteger(now, "now");
        if (now > Number.MAX_SAFE_INTEGER - this.ttlMs) {
            throw new ExtensionV1Error(
                "INVALID_ARGUMENT",
                "Replay cache expiration exceeds the safe integer range",
                { details: { field: "now" } }
            );
        }
        this.prune(now);

        const expiresAt = this.entries.get(nonce);
        if (expiresAt !== undefined && expiresAt > now) {
            throw new ExtensionV1Error(
                "NONCE_REUSED",
                "Authentication nonce has already been used"
            );
        }

        while (this.entries.size >= this.maxEntries) {
            const oldest = this.entries.keys().next().value as string | undefined;
            if (oldest === undefined) {
                break;
            }
            this.entries.delete(oldest);
        }
        this.entries.set(nonce, now + this.ttlMs);
    }

    prune(now = Date.now()): void {
        requireSafeInteger(now, "now");
        for (const [nonce, expiresAt] of this.entries) {
            if (expiresAt <= now) {
                this.entries.delete(nonce);
            }
        }
    }

    clear(): void {
        this.entries.clear();
    }

    get size(): number {
        return this.entries.size;
    }
}

export function assertEndpointAuthentication(
    descriptor: LocalEndpointDescriptor,
    secret: string | Uint8Array,
    authentication: LocalEndpointAuthentication,
    mac: string,
    options: AuthenticationVerificationOptions = {}
): void {
    const validatedDescriptor = validateLocalEndpointDescriptor(descriptor);
    const validated = validateAuthentication(authentication);
    const now = options.now === undefined ? Date.now() : options.now;
    const maxClockSkewMs =
        options.maxClockSkewMs === undefined
            ? 60 * 1000
            : options.maxClockSkewMs;
    requireSafeInteger(now, "now");
    requireSafeInteger(maxClockSkewMs, "maxClockSkewMs", 1);

    if (
        now < validatedDescriptor.createdAt ||
        now >= validatedDescriptor.expiresAt ||
        validated.endpointInstanceId !== validatedDescriptor.instanceId ||
        validated.endpointNonce !== validatedDescriptor.nonce
    ) {
        throw new ExtensionV1Error(
            "AUTHENTICATION_FAILED",
            "Authentication message does not match an active local endpoint"
        );
    }
    if (Math.abs(now - validated.timestamp) > maxClockSkewMs) {
        throw new ExtensionV1Error(
            "AUTHENTICATION_FAILED",
            "Authentication timestamp is outside the allowed clock skew"
        );
    }
    if (!verifyAuthenticationMac(secret, validated, mac)) {
        throw new ExtensionV1Error(
            "AUTHENTICATION_FAILED",
            "Authentication MAC is invalid"
        );
    }
    options.replayCache?.consume(validated.clientNonce, now);
}
