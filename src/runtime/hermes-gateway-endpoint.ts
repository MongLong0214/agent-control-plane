/**
 * Where ACP reaches the Hermes Gateway's loopback API: the identity readback, the Telegram turn
 * receipts, the canonical CEO turn and the daemon notice all go to this one endpoint, and the
 * Hermes runtime `agentctl bootstrap hermes` launches is told the same one. One reader, so no
 * caller can name a different Gateway than another.
 *
 * `ACP_HERMES_GATEWAY_ENDPOINT` is `127.0.0.1:<port>`. Unset is the Gateway's own default,
 * 127.0.0.1:8642. Set to anything else — another host, a name, a scheme, a path, credentials, a
 * port outside 1–65535, or nothing — it is refused, never read as the default: a deployment that
 * named an isolated Gateway must not reach the live one because the name was mistyped.
 */
export const HERMES_GATEWAY_ENDPOINT_VAR = "ACP_HERMES_GATEWAY_ENDPOINT";
export const HERMES_GATEWAY_HOST = "127.0.0.1";
export const DEFAULT_HERMES_GATEWAY_PORT = 8642;

/** The configured Gateway port; the default when the variable is unset; null when it is set to anything but `127.0.0.1:<port>`. */
export const configuredHermesGatewayPort = (
  environment: Readonly<Record<string, string | undefined>>,
): number | null => {
  const raw = environment[HERMES_GATEWAY_ENDPOINT_VAR];
  if (raw === undefined) return DEFAULT_HERMES_GATEWAY_PORT;
  const match = /^127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(raw);
  if (!match) return null;
  const port = Number(match[1]);
  return port <= 65535 ? port : null;
};

/** The endpoint as the variable spells it, for the Hermes runtime's environment. */
export const hermesGatewayEndpoint = (port: number): string => `${HERMES_GATEWAY_HOST}:${port}`;
