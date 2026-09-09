import type { Socket } from "node:net";

import { type Decision, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";

/**
 * The one-line JSON request framing shared by every local Unix-socket RPC surface this daemon
 * serves on its own listener — the operator socket and the canonical self-claim listener (#760).
 * Accumulate bytes, find the newline, refuse a second request on the same connection, parse
 * JSON — and nothing else.
 *
 * This is a separate primitive rather than something the operator socket already exposed because
 * the framing and the authentication must stay separate: a helper that also decided who may
 * speak — a token check, a peer-credential check, anything that answers "is this caller
 * allowed" — would be the exact authentication surface the two sockets exist to keep apart, just
 * relocated into a file that looks neutral. This module answers only "is this a complete,
 * well-formed, single JSON line" and hands the parsed value to its caller to decide anything
 * else. Every message here stays generic for the same reason: this is the second call site, and
 * the wording lives with each caller so a future third one is not tempted to import an "operator"
 * string a name never described.
 */
/**
 * The bound on one framed request: the whole buffer this reader has accumulated, the terminating
 * newline included. It is not the bound on a line's content, and the name says so because the two
 * differ by a byte and a caller cannot see which it is getting (#816).
 *
 * Measuring the buffer is right here and wrong for a reader that serves a stream. This reader
 * takes exactly one request per connection and refuses anything after the first newline, so the
 * buffer is that one request and nothing else; a stream reader's buffer is whatever the kernel
 * happened to deliver, which is neither peer's choice, and bounding that refuses two legal
 * messages for arriving together (#805). The consequence to state rather than discover: the
 * largest content this accepts is one byte short of this number, because the terminator it must
 * carry is counted too.
 */
export const MAX_LOCAL_SOCKET_FRAMED_REQUEST_BYTES = 1024 * 1024;

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
  maxFramedBytes: number = MAX_LOCAL_SOCKET_FRAMED_REQUEST_BYTES,
): { dispose(): void } => {
  let buffer = Buffer.alloc(0);
  let done = false;
  const receive = (chunk: Buffer): void => {
    if (done) return;
    buffer = Buffer.concat([buffer, chunk]);
    // The whole buffer, before the boundary is looked for: the terminator is part of what is
    // bounded here, so a request whose content is `maxFramedBytes` bytes does not fit.
    if (buffer.length > maxFramedBytes) {
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
