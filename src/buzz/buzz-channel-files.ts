import { closeSync, constants as fsConstants, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

import { isChannelReceipt, type ChannelReceipt, type ChannelState, type ChannelStateStore } from "./buzz-channel.ts";

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

/** The cursor and shown-ids a restarted channel server resumes from. Atomic, owner-only. */
export const fileChannelStateStore = (stateDir: string, projectId: string): ChannelStateStore => {
  if (!PROJECT_SHAPE.test(projectId)) throw new Error("project id is not a file-safe name");
  const path = join(channelDir(stateDir), `${projectId}.state.json`);
  return {
    load: (): ChannelState | null => {
      try {
        const value = JSON.parse(readFileSync(path, "utf8")) as Partial<{ cursor: unknown; seen: unknown; threads: unknown }>;
        if (typeof value.cursor !== "number" || !Array.isArray(value.seen) || !Array.isArray(value.threads)) return null;
        const cursor = value.cursor;
        return {
          cursor,
          // A file written before ids carried their time held bare ids: they are kept as written at the cursor.
          seen: value.seen.flatMap((entry): [string, number][] =>
            typeof entry === "string" ? [[entry, cursor]]
              : Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "number" ? [[entry[0], entry[1]]] : []),
          // Two-element entries carried no room, so they cannot say a reply is in the thread's own room: dropped.
          threads: value.threads.filter(
            (entry): entry is [string, string, string, string] =>
              Array.isArray(entry) && entry.length === 4 && entry.every((member) => typeof member === "string"),
          ),
        };
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
