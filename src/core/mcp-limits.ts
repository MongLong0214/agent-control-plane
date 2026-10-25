// Shared here so the relay can derive its wire ceiling without loading bootstrap machinery.
export const BOOTSTRAP_REVIEW_EVIDENCE_MAX_BYTES = 512 * 1024;

/**
 * JSON serializers may encode every string's UTF-16 unit as \uXXXX. Six wire bytes per
 * decoded UTF-8 byte covers ASCII/control characters as well as multibyte characters and
 * surrogate pairs. Allow 1 KiB of decoded request envelope, with the same worst-case escaping.
 * This bounds wire framing only: evidence still validates its own 512 KiB decoded byte limit.
 * The SDK stdio reader already allows 10 MiB; it needs no increase.
 */
export const MAX_MCP_LINE_BYTES = 6 * (BOOTSTRAP_REVIEW_EVIDENCE_MAX_BYTES + 1024);
