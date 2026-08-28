/**
 * Official Catalog publisher keys. Release engineering adds reviewed Ed25519
 * public keys here; an empty set intentionally makes Catalog V1 installs fail
 * closed rather than trusting a key delivered with the package.
 */
export const TRUSTED_EXTENSION_PUBLISHERS: Readonly<Record<string, string>> =
    Object.freeze({});
