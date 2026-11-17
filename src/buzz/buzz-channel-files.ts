import { closeSync, constants as fsConstants, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

import { isChannelReceipt, type ChannelEventEntry, type ChannelReceipt, type ChannelState, type ChannelStateStore } from "./buzz-channel.ts";

/**
 * The files a CTO's channel server shares with the daemon, all beneath the daemon's own state
 * directory: the receipts it appends (read, never written, by the daemon) and the cursor it keeps
 * for itself. Nothing here is a credential.
 */
export const BUZZ_CHANNEL_DIRNAME = "buzz-channel";
export const BUZZ_CHANNEL_RECEIPT_SUFFIX = ".receipts.jsonl";

const PROJECT_SHAPE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u;

export const channelDir = (stateDir: string): string => join(stateDir, BUZZ_CHANNEL_DIRNAME);

export const channelReceiptPath = (stateDir: string, projectId: string): string => {
  if (!PROJECT_SHAPE.test(projectId)) throw new Error("project id is not a file-safe name");
  return join(channelDir(stateDir), `${projectId}${BUZZ_CHANNEL_RECEIPT_SUFFIX}`);
};

const ensureDir = (stateDir: string): void => {
  mkdirSync(channelDir(stateDir), { recursive: true, mode: 0o700 });
};

/** One receipt as one line; `O_APPEND` makes concurrent writers' lines whole. */
export const appendChannelReceipt = (stateDir: string, projectId: string, receipt: ChannelReceipt): void => {
  ensureDir(stateDir);
  const fd = openSync(
    channelReceiptPath(stateDir, projectId),
    fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, `${JSON.stringify(receipt)}\n`);
  } finally {
    closeSync(fd);
  }
};

/** Keeps a long-lived receipt file bounded: at start, an oversized file keeps only its newest lines. */
export const trimChannelReceipts = (stateDir: string, projectId: string, maxBytes = 256 * 1024, keepLines = 200): void => {
  const path = channelReceiptPath(stateDir, projectId);
  if (!existsSync(path) || statSync(path).size <= maxBytes) return;
  const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.length > 0).slice(-keepLines);
  const staging = `${path}.${process.pid}.tmp`;
  writeFileSync(staging, `${lines.join("\n")}\n`, { mode: 0o600 });
  renameSync(staging, path);
};

/**
 * Every well-formed receipt in one file, oldest first, and the 1-based numbers of the lines that were not.
 * A line that does not parse or does not have a receipt's shape is skipped and reported by its number, and
 * the lines around it are read as if it were not there. A final line with no newline after it is the
 * writer mid-append, not a malformed receipt, and is skipped without being reported.
 */
export const readChannelReceipts = (path: string): { receipts: ChannelReceipt[]; skipped: number[] } => {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { receipts: [], skipped: [] };
  }
  const receipts: ChannelReceipt[] = [];
  const skipped: number[] = [];
  const lines = text.split("\n");
  const complete = text.endsWith("\n") ? lines.length : lines.length - 1;
  for (let i = 0; i < complete; i += 1) {
    const line = lines[i]!;
    if (line.length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      skipped.push(i + 1);
      continue;
    }
    if (isChannelReceipt(value)) receipts.push(value);
    else skipped.push(i + 1);
  }
  return { receipts, skipped };
};

/** The cursor, the failed events and the remembered events a restarted channel server resumes from. Atomic, owner-only. */
export const fileChannelStateStore = (stateDir: string, projectId: string): ChannelStateStore => {
  if (!PROJECT_SHAPE.test(projectId)) throw new Error("project id is not a file-safe name");
  const path = join(channelDir(stateDir), `${projectId}.state.json`);
  return {
    load: (): ChannelState | null => {
      try {
        const value = JSON.parse(readFileSync(path, "utf8")) as Partial<{ cursor: unknown; failed: unknown; events: unknown; seen: unknown; threads: unknown }>;
        if (typeof value.cursor !== "number") return null;
        const cursor = value.cursor;
        const failed = (Array.isArray(value.failed) ? value.failed : []).flatMap((entry): [string, number][] =>
          Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && typeof entry[1] === "number" ? [[entry[0], entry[1]]] : []);
        if (Array.isArray(value.events)) {
          // An entry that is not exactly an event is dropped, not guessed at; the entries around it are kept.
          const events = value.events.flatMap((entry): ChannelEventEntry[] =>
            Array.isArray(entry) && entry.length === 6 && typeof entry[0] === "string" && typeof entry[1] === "number" &&
            typeof entry[2] === "string" && typeof entry[3] === "string" && typeof entry[4] === "string" && typeof entry[5] === "boolean"
              ? [[entry[0], entry[1], entry[2], entry[3], entry[4], entry[5]]] : []);
          return { cursor, failed, events };
        }
        // The previous revision kept delivered ids and parents in two lists, and one event can be in both. They are
        // merged by id: it was shown if either list says so (ids with no time are kept at the cursor), and it keeps
        // the room, author and root the thread list gave it. Two-element threads carried no room, so they cannot
        // say a reply is in the thread's room: dropped.
        if (!Array.isArray(value.seen) || !Array.isArray(value.threads)) return null;
        const merged = new Map<string, [id: string, at: number, author: string, room: string, root: string, delivered: boolean]>();
        for (const entry of value.seen) {
          const id = typeof entry === "string" ? entry : Array.isArray(entry) && typeof entry[0] === "string" ? entry[0] : null;
          if (id === null) continue;
          const at = typeof entry === "string" ? cursor : typeof entry[1] === "number" ? entry[1] : null;
          if (at === null) continue;
          const earlier = merged.get(id);
          merged.set(id, [id, earlier === undefined ? at : Math.max(earlier[1], at), "", "", "", true]);
        }
        for (const entry of value.threads) {
          if (!Array.isArray(entry) || entry.length !== 4 || !entry.every((member) => typeof member === "string")) continue;
          const [id, author, room, root] = entry as [string, string, string, string];
          const shown = merged.get(id);
          merged.set(id, [id, shown?.[1] ?? cursor, author, room, root, shown?.[5] ?? false]);
        }
        return { cursor, failed: [], events: [...merged.values()] };
      } catch {
        return null;
      }
    },
    save: (state) => {
      ensureDir(stateDir);
      const staging = `${path}.${process.pid}.tmp`;
      writeFileSync(staging, JSON.stringify(state), { mode: 0o600 });
      renameSync(staging, path);
    },
  };
};

/** `buzz:<pubkey>` lines of the deployment's `owner-identities`, the same declaration the daemon's ingress reads. */
export const readBuzzOwnerPubkeys = (stateDir: string): string[] => {
  const file = join(stateDir, "owner-identities");
  if (!existsSync(file)) return [];
  const owners: string[] = [];
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const at = line.indexOf(":");
    if (at > 0 && line.slice(0, at) === "buzz") owners.push(line.slice(at + 1).trim());
  }
  return [...new Set(owners.filter((pubkey) => /^[0-9a-f]{64}$/u.test(pubkey)))];
};
