const EXTENSION_ID_PATTERN =
    /^(?:@[a-z0-9](?:[a-z0-9._-]{0,99})\/)?[a-z0-9](?:[a-z0-9._-]{0,212})$/;

export function isValidExtensionId(value: unknown): value is string {
    return (
        typeof value === "string" &&
        value.length <= 214 &&
        EXTENSION_ID_PATTERN.test(value)
    );
}
