/**
 * A 512 KiB review evidence JSON body can double when escaped into tools/call (for example,
 * trailing JSON tabs). Keep the existing 1 MiB allowance plus 1 KiB for the request envelope.
 * Shared by the daemon socket framing and agentctl attach, without importing daemon machinery.
 * The SDK stdio reader already allows 10 MiB; it needs no increase.
 */
export const MAX_MCP_LINE_BYTES = 1024 * 1024 + 1024;
