import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";

import type { BuzzMentionEvent } from "../../src/buzz/buzz-mention-subscriber.ts";

/**
 * A relay on a real loopback TCP socket (#1283), speaking just enough RFC 6455, NIP-01 and NIP-42
 * for the daemon's own `nativeRelaySocketFactory` and Node's `WebSocket`: a challenge on connect,
 * `OK` for any `AUTH`, stored events then `EOSE` for a `REQ`, live pushes to open subscriptions,
 * and `CLOSE`. Nothing here is the live relay; it runs inside the test process only.
 *
 * Its point is the two ways a connection can go quiet while TCP stays ESTABLISHED, set per
 * connection: `silent` answers and delivers nothing at all, and `noLivePush` still answers every
 * request but stops pushing newly published events to the subscriptions already open on it. A
 * subscription limit and a store-only publish cover the review's other cases: a relay that refuses
 * every probe, and one event the live push skipped while later ones arrived.
 */
export interface LocalRelayConnection {
  readonly socket: Socket;
  /** Whether the TCP connection is still open on the relay's side. */
  open: boolean;
  authenticatedAs: string | null;
  silent: boolean;
  noLivePush: boolean;
  readonly subscriptions: Map<string, readonly Record<string, unknown>[]>;
  /** Every `REQ` this connection received while answering, in order. */
  readonly requests: { readonly id: string; readonly filters: readonly Record<string, unknown>[] }[];
  /** Every `CLOSE` this connection received while answering, by subscription id. */
  readonly closes: string[];
  /** Every `REQ` the relay ended with `CLOSED` for the subscription limit, by subscription id. */
  readonly refused: string[];
}

export interface LocalWebSocketRelay {
  /** `ws://127.0.0.1:<port>`: the address a test's socket factory dials. */
  readonly url: string;
  readonly connections: LocalRelayConnection[];
  /** Connections opened from now on start silent; existing ones are unchanged. */
  silentForNewConnections: boolean;
  /**
   * How many subscriptions one connection may hold open, on every connection; `null` for no limit.
   * A `REQ` past it is ended with `CLOSED` and `restricted: too many subscriptions`, as a relay does.
   */
  maxSubscriptionsPerConnection: number | null;
  /**
   * Stores an event and pushes it to every matching subscription on an answering connection.
   * `push: false` stores it only: a request finds it, and no open subscription is told.
   */
  publish(event: BuzzMentionEvent, options?: { readonly push?: boolean }): void;
  close(): Promise<void>;
}

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OPCODE_TEXT = 0x1;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;

const frameOf = (opcode: number, payload: Buffer): Buffer => {
  const length = payload.length;
  if (length < 126) return Buffer.concat([Buffer.from([0x80 | opcode, length]), payload]);
  if (length < 65_536) return Buffer.concat([Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff]), payload]);
  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return Buffer.concat([header, payload]);
};

/** Reads whole client frames off `state.buffer`; a partial frame stays for the next chunk. */
const readFrames = (state: { buffer: Buffer }): { opcode: number; payload: Buffer }[] => {
  const frames: { opcode: number; payload: Buffer }[] = [];
  for (;;) {
    const buffer = state.buffer;
    if (buffer.length < 2) return frames;
    const opcode = buffer[0]! & 0x0f;
    const masked = (buffer[1]! & 0x80) !== 0;
    let length = buffer[1]! & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < 4) return frames;
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buffer.length < 10) return frames;
      length = Number(buffer.readBigUInt64BE(2));
      offset = 10;
    }
    const maskAt = offset;
    if (masked) offset += 4;
    if (buffer.length < offset + length) return frames;
    const payload = Buffer.from(buffer.subarray(offset, offset + length));
    if (masked) for (let i = 0; i < payload.length; i += 1) payload[i] = payload[i]! ^ buffer[maskAt + (i % 4)]!;
    frames.push({ opcode, payload });
    state.buffer = buffer.subarray(offset + length);
  }
};

const tagValues = (event: BuzzMentionEvent, name: string): string[] =>
  event.tags.filter((tag) => tag[0] === name).map((tag) => tag[1] ?? "");

const matches = (filter: Record<string, unknown>, event: BuzzMentionEvent): boolean => {
  const kinds = filter["kinds"] as readonly number[] | undefined;
  if (kinds && !kinds.includes(event.kind)) return false;
  const authors = filter["authors"] as readonly string[] | undefined;
  if (authors && !authors.includes(event.pubkey)) return false;
  for (const name of ["p", "h", "e"]) {
    const wanted = filter[`#${name}`] as readonly string[] | undefined;
    if (wanted && !tagValues(event, name).some((value) => wanted.includes(value))) return false;
  }
  const since = filter["since"];
  return typeof since !== "number" || event.created_at >= since;
};

export const startLocalWebSocketRelay = async (): Promise<LocalWebSocketRelay> => {
  const stored: BuzzMentionEvent[] = [];
  const connections: LocalRelayConnection[] = [];
  const server = createServer((_request, response) => {
    response.writeHead(426).end();
  });

  const say = (connection: LocalRelayConnection, message: unknown[]): void => {
    if (connection.silent || !connection.open) return;
    connection.socket.write(frameOf(OPCODE_TEXT, Buffer.from(JSON.stringify(message), "utf8")));
  };

  const onText = (connection: LocalRelayConnection, text: string): void => {
    const message = JSON.parse(text) as unknown[];
    if (message[0] === "AUTH") {
      const auth = message[1] as { id: string; pubkey: string };
      connection.authenticatedAs = auth.pubkey;
      say(connection, ["OK", auth.id, true, ""]);
    } else if (message[0] === "REQ") {
      const id = message[1] as string;
      const filters = message.slice(2) as Record<string, unknown>[];
      const limit = relay.maxSubscriptionsPerConnection;
      if (limit !== null && !connection.subscriptions.has(id) && connection.subscriptions.size >= limit) {
        connection.refused.push(id);
        say(connection, ["CLOSED", id, "restricted: too many subscriptions"]);
        return;
      }
      connection.requests.push({ id, filters });
      connection.subscriptions.set(id, filters);
      for (const event of stored.filter((one) => filters.some((filter) => matches(filter, one)))) {
        say(connection, ["EVENT", id, event]);
      }
      say(connection, ["EOSE", id]);
    } else if (message[0] === "CLOSE") {
      connection.closes.push(message[1] as string);
      connection.subscriptions.delete(message[1] as string);
    }
  };

  server.on("upgrade", (request, socket: Socket, head: Buffer) => {
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
    socket.write(
      ["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`, "", ""].join("\r\n"),
    );
    const connection: LocalRelayConnection = {
      socket,
      open: true,
      authenticatedAs: null,
      silent: relay.silentForNewConnections,
      noLivePush: false,
      subscriptions: new Map(),
      requests: [],
      closes: [],
      refused: [],
    };
    connections.push(connection);
    const state = { buffer: Buffer.alloc(0) };
    const onData = (chunk: Buffer): void => {
      state.buffer = Buffer.concat([state.buffer, chunk]);
      for (const frame of readFrames(state)) {
        // A silent relay end reads nothing, closing handshakes included: the TCP stays open.
        if (connection.silent) continue;
        if (frame.opcode === OPCODE_TEXT) onText(connection, frame.payload.toString("utf8"));
        else if (frame.opcode === OPCODE_PING) socket.write(frameOf(0xa, frame.payload));
        else if (frame.opcode === OPCODE_CLOSE) {
          socket.write(frameOf(OPCODE_CLOSE, Buffer.alloc(0)));
          socket.end();
        }
      }
    };
    socket.on("data", onData);
    socket.on("close", () => {
      connection.open = false;
    });
    socket.on("error", () => {
      connection.open = false;
    });
    if (head.length > 0) onData(head);
    say(connection, ["AUTH", `challenge-${connections.length}`]);
  });

  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  const { port } = server.address() as AddressInfo;

  const relay: LocalWebSocketRelay = {
    url: `ws://127.0.0.1:${port}`,
    connections,
    silentForNewConnections: false,
    maxSubscriptionsPerConnection: null,
    publish: (event, options) => {
      stored.push(event);
      if (options?.push === false) return;
      for (const connection of connections) {
        if (connection.noLivePush) continue;
        for (const [id, filters] of connection.subscriptions) {
          if (filters.some((filter) => matches(filter, event))) say(connection, ["EVENT", id, event]);
        }
      }
    },
    close: async () => {
      for (const connection of connections) connection.socket.destroy();
      await new Promise<void>((closed) => server.close(() => closed()));
    },
  };
  return relay;
};
