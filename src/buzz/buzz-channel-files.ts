import { closeSync, constants as fsConstants, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

import type { ChannelReceipt, ChannelState, ChannelStateStore } from "./buzz-channel.ts";

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

/** Every well-formed receipt in one file, oldest first; a torn or foreign line is skipped, never guessed at. */
export const readChannelReceipts = (path: string): ChannelReceipt[] => {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: ChannelReceipt[] = [];
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    try {
      const value = JSON.parse(line) as ChannelReceipt;
      if (value && (value.type === "emitted" || value.type === "replied")) out.push(value);
    } catch {
      /* a torn final line is the writer mid-append */
    }
  }
  return out;
};

/** The cursor and shown-ids a restarted channel server resumes from. Atomic, owner-only. */
export const fileChannelStateStore = (stateDir: string, projectId: string): ChannelStateStore => {
  if (!PROJECT_SHAPE.test(projectId)) throw new Error("project id is not a file-safe name");
  const path = join(channelDir(stateDir), `${projectId}.state.json`);
  return {
    load: (): ChannelState | null => {
      try {
        const value = JSON.parse(readFileSync(path, "utf8")) as Partial<ChannelState>;
        if (typeof value.cursor !== "number" || !Array.isArray(value.seen) || !Array.isArray(value.threads)) return null;
        return {
          cursor: value.cursor,
          seen: value.seen.filter((id): id is string => typeof id === "string"),
          threads: value.threads.filter(
            (entry): entry is [string, string] => Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string",
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
