export type ExtensionCapability = string;
export class ExtensionV1Error extends Error {
    constructor(code: string, message: string, options?: { cause?: unknown });
    readonly code: string;
}
export interface SecureStorageBackend {
    get(key: string): string | undefined;
    set(key: string, value: string): void;
    delete(key: string): void;
    keys?(): readonly string[];
}
export function createElectronExtensionSecureStorage(
    extensionId: string,
    publisherFingerprint: string,
    backend: SecureStorageBackend
): SecureStorageBackend & { getStorageKey(key: string): string; keys(): readonly string[] };
export const EXTENSION_SIGNATURE_FILE: string;
export const TRUSTED_EXTENSION_PUBLISHERS: Readonly<Record<string, string>>;
export function verifyExtensionPackageSignature(
    packageRoot: string,
    policy: any
): Promise<
    | {
          signed: true;
          publisherFingerprint: string;
          files: Readonly<Record<string, string>>;
      }
    | { signed: false }
>;
export function isSafeDeclarativeIcon(value: unknown): value is string;

export interface IExtension {
    id: string;
    name: string;
    displayName: string;
    version: string;
    extensionType?: string;
    preInstalled?: boolean;
    installationFolderPath?: string;
    publisherKeyId?: string;
    publisherFingerprint?: string;
    manifest?: any;
}

export const extensions: Map<string, IExtension>;
export function reloadExtensionV1(
    folderPath: string,
    expectedId: string
): Promise<IExtension | undefined>;
export function getExtensionFolderPath(extensionId: string): string;
export function inspectExtensionPackageStatic(
    folderPath: string
): Promise<{ id: string; extensionType?: string } | undefined>;
export function isValidExtensionId(value: unknown): value is string;
