import type { Socket } from "node:net";

import { type Decision, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";

/**
 * The one-line JSON request framing shared by every local Unix-socket RPC surface this daemon
 * serves on its own listener (the operator socket and, as of #760 round 6, the canonical
 * self-claim listener). Accumulate bytes, find the newline, refuse a second request on the same
 * connection, parse JSON — and nothing else.
 *
 * #760 round 6's own ruling is why this is a separate primitive rather than something the
 * operator socket already exposed: "factor the framing, not the authentication." A helper that
 * also decided who may speak — a token check, a peer-credential check, anything that answers "is
 * this caller allowed" — would be the exact authentication surface the two sockets exist to keep
 * apart, just relocated into a file that looks neutral. This module answers only "is this a
 * complete, well-formed, single JSON line" and hands the parsed value to its caller to decide
 * anything else. Every message here stays generic for the same reason: this is the second call
 * site, and the wording lives with each caller so a future third one is not tempted to import an
 * "operator" string a name never described.
 */
export const MAX_LOCAL_SOCKET_LINE_BYTES = 1024 * 1024;

export interface LocalSocketFrameMessages {
  tooLarge: string;
  multipleRequests: string;
  notJson: string;
}

/**
 * Reads exactly one newline-terminated JSON line from `socket` and calls `onLine` with the parsed
 * value, or `onFrameError` with a typed denial. Calls at most one of the two callbacks, and at
 * most once — this is a single-shot primitive, matching the "one request per connection" contract
 * both call sites already enforce over the wire. `dispose()` detaches this primitive's own `data`
 * listener without invoking either callback, for a caller that already decided to finish the
 * connection for a reason of its own (a caller-side timeout, a peer-authentication failure that
 * happened before any bytes were even read).
 */
export const readOneJsonLineRequest = (
  socket: Socket,
  messages: LocalSocketFrameMessages,
  onLine: (value: unknown) => void,
  onFrameError: (decision: Decision<never>) => void,
  maxBytes: number = MAX_LOCAL_SOCKET_LINE_BYTES,
): { dispose(): void } => {
  let buffer = Buffer.alloc(0);
  let done = false;
  const receive = (chunk: Buffer): void => {
    if (done) return;
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > maxBytes) {
      done = true;
      socket.removeListener("data", receive);
      onFrameError(deny(ReasonCode.INVALID_ARGUMENT, messages.tooLarge));
      return;
    }
    const boundary = buffer.indexOf(0x0a);
    if (boundary === -1) return;
    if (buffer.subarray(boundary + 1).length > 0) {
      done = true;
      socket.removeListener("data", receive);
      onFrameError(deny(ReasonCode.INVALID_ARGUMENT, messages.multipleRequests));
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(buffer.subarray(0, boundary).toString("utf8")) as unknown;
    } catch {
      done = true;
      socket.removeListener("data", receive);
      onFrameError(deny(ReasonCode.INVALID_ARGUMENT, messages.notJson));
      return;
    }
    done = true;
    socket.removeListener("data", receive);
    onLine(value);
  };
  socket.on("data", receive);
  return {
    dispose: () => {
      done = true;
      socket.removeListener("data", receive);
    },
  };
};
