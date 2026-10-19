import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";

/**
 * #512 S-PUSH (CEO f5879479) — what `GitHubKernel.publishBranch` sends, read from the local object
 * database rather than described by metadata. It lives under `src/git/`, not `src/github/`: the GitHub path
 * spawns nothing (P1-14), and this module's git children get a fixed environment with no credential in it.
 *
 * GitHub's Git Data API builds a blob, a tree and a commit from JSON fields, and the object id it answers
 * is the hash of the object it built. The CTO measured on a disposable repository (D1) that a worker commit
 * is reproduced exactly when every field comes from the local object: the exact message bytes (the
 * trailing newline included), the author and committer each with their epoch and their own offset, the
 * tree and the parents. This module reads those objects, renders the request fields, and checks before
 * anything is sent that the fields hash back to the local ids. The kernel then checks each id GitHub
 * answers against the local one. The refusing scan over these objects is `src/github/branch-publish.ts`.
 *
 * Everything here is local and read-only. Nothing in this file sends a request.
 */

/**
 * Bounds on one publication. A candidate past any of them is refused, never truncated. Every bound is
 * inclusive (a value equal to it passes, one past it refuses) and is checked from `git cat-file
 * --batch-check` metadata, before any object payload is read or uploaded.
 */
export interface BranchPublishLimits {
  maxCommits: number;
  /** Every object sent, commits, trees and blobs together. */
  maxObjects: number;
  /** The largest single object sent, of any type: a commit, a tree or a blob. */
  maxObjectBytes: number;
  /** The bytes of every object sent, commits, trees and blobs together. */
  maxTotalBytes: number;
  /** The pull request title and body that follow the publication, each. */
  maxTextBytes: number;
}

export const DEFAULT_BRANCH_PUBLISH_LIMITS: BranchPublishLimits = Object.freeze({
  maxCommits: 100,
  maxObjects: 2_000,
  maxObjectBytes: 5 * 1024 * 1024,
  maxTotalBytes: 25 * 1024 * 1024,
  maxTextBytes: 64 * 1024,
});

/** A commit identity as GitHub's create-commit API takes it: the date carries the commit's own offset. */
export interface GitIdentity {
  name: string;
  email: string;
  date: string;
}

/** The create-commit request body. */
export interface CommitApiFields {
  message: string;
  tree: string;
  parents: string[];
  author: GitIdentity;
  committer: GitIdentity;
}

export interface LocalCommit {
  sha: string;
  fields: CommitApiFields;
  raw: Buffer;
}

export type TreeEntryType = "blob" | "tree" | "commit";

/** One create-tree entry: a single path component, its mode as the API spells it, and its object. */
export interface TreeApiEntry {
  path: string;
  mode: string;
  type: TreeEntryType;
  sha: string;
}

export interface LocalTree {
  sha: string;
  entries: TreeApiEntry[];
}

export interface LocalBlob {
  sha: string;
  content: Buffer;
}

/** The objects one publication sends, each list in the order it is sent. */
export interface BranchObjects {
  /** Parents before children. */
  commits: LocalCommit[];
  /** Subtrees before the trees that hold them. */
  trees: LocalTree[];
  blobs: LocalBlob[];
  /** Every path any sent commit changes against any of its parents (`--root` for a root commit). */
  changedPaths: string[];
  candidateTree: string;
  /** The bytes of every object sent (commits, trees and blobs), as the bounded metadata stated them. */
  bytes: number;
}


const GIT_TIMEOUT_MS = 120_000;
const GIT_OUTPUT_LIMIT_BYTES = 256 * 1024 * 1024;

/**
 * One bounded git invocation with binary output. Blob bytes are the payload, so the string-decoding
 * `git()` helper cannot carry them. `--no-replace-objects`, because a replace ref changes what a local
 * read returns and nothing GitHub would build. A timeout, an oversized answer or a non-zero exit rejects.
 */
export const gitBytes = (
  cwd: string,
  args: readonly string[],
  options: { input?: Buffer; allowExitCodes?: readonly number[] } = {},
): Promise<{ stdout: Buffer; exitCode: number }> =>
  new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, "--no-replace-objects", ...args], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? "",
        LC_ALL: "C",
        GIT_TERMINAL_PROMPT: "0",
        GIT_PAGER: "cat",
        GIT_CONFIG_NOSYSTEM: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = "";
    let settled = false;
    const finish = (error: Error | null, exitCode?: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ stdout: Buffer.concat(chunks), exitCode: exitCode ?? 0 });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`git ${args[0] ?? ""} exceeded its ${GIT_TIMEOUT_MS}ms bound`));
    }, GIT_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > GIT_OUTPUT_LIMIT_BYTES) {
        child.kill("SIGKILL");
        finish(new Error(`git ${args[0] ?? ""} answered more than ${GIT_OUTPUT_LIMIT_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 2_000) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code === 0 || (code !== null && (options.allowExitCodes ?? []).includes(code))) {
        finish(null, code);
        return;
      }
      finish(new Error(`git ${args[0] ?? ""} failed (${code ?? "signal"}): ${stderr.trim().slice(0, 400)}`));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input ?? Buffer.alloc(0));
  });

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** The bytes as UTF-8, or null when they are not: a JSON request body cannot carry other bytes exactly. */
const utf8OrNull = (bytes: Buffer): string | null => {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return null;
  }
};

const gitObjectId = (type: string, content: Buffer): string =>
  createHash("sha1").update(`${type} ${content.length}\0`).update(content).digest("hex");

const IDENTITY = /^(.*) <([^<>\n]*)> (\d+) ([+-])(\d{2})(\d{2})$/;

/** `2026-10-19T12:00:00+09:00` for epoch and offset `+0900`: the local time at that offset, and the offset. */
export const isoWithOffset = (epochSeconds: number, sign: "+" | "-", hours: string, minutes: string): string | null => {
  const offsetSeconds = (sign === "-" ? -1 : 1) * (Number(hours) * 3600 + Number(minutes) * 60);
  const local = new Date((epochSeconds + offsetSeconds) * 1000);
  if (Number.isNaN(local.getTime())) return null;
  const iso = local.toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(iso)) return null;
  return `${iso.slice(0, 19)}${sign}${hours}:${minutes}`;
};

/** The epoch and git offset an ISO date with an explicit offset names: the inverse of `isoWithOffset`. */
const epochAndOffset = (date: string): { epoch: number; offset: string } | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})([+-])(\d{2}):(\d{2})$/.exec(date);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, sign, oh, om] = match;
  const localMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  const offsetSeconds = (sign === "-" ? -1 : 1) * (Number(oh) * 3600 + Number(om) * 60);
  return { epoch: localMs / 1000 - offsetSeconds, offset: `${sign}${oh}${om}` };
};

/**
 * The commit object a create-commit request with these fields names, by git's own format: what the
 * pre-flight compares with the local id before anything is sent.
 */
export const commitObjectFromApiFields = (fields: CommitApiFields): Buffer | null => {
  const ident = (identity: GitIdentity): string | null => {
    const at = epochAndOffset(identity.date);
    return at ? `${identity.name} <${identity.email}> ${at.epoch} ${at.offset}` : null;
  };
  const author = ident(fields.author);
  const committer = ident(fields.committer);
  if (author === null || committer === null) return null;
  const header = [
    `tree ${fields.tree}`,
    ...fields.parents.map((parent) => `parent ${parent}`),
    `author ${author}`,
    `committer ${committer}`,
  ].join("\n");
  return Buffer.concat([Buffer.from(`${header}\n\n`, "utf8"), Buffer.from(fields.message, "utf8")]);
};

/** The id git gives the commit object these fields name. */
export const commitIdFromApiFields = (fields: CommitApiFields): string | null => {
  const object = commitObjectFromApiFields(fields);
  return object === null ? null : gitObjectId("commit", object);
};

/**
 * A raw commit object as create-commit fields. Only `tree`, `parent`, `author` and `committer` headers are
 * read; a signature, an encoding or a merge tag cannot be reproduced through these fields, so such a commit
 * is refused rather than sent without it.
 */
export const parseCommitObject = (sha: string, raw: Buffer): Decision<CommitApiFields> => {
  const separator = raw.indexOf("\n\n");
  if (separator < 0) {
    return deny(ReasonCode.BRANCH_PUBLISH_UNSUPPORTED, "commit object has no message separator", { commit: sha });
  }
  const header = utf8OrNull(raw.subarray(0, separator));
  const message = utf8OrNull(raw.subarray(separator + 2));
  if (header === null || message === null) {
    return deny(ReasonCode.BRANCH_PUBLISH_UNSUPPORTED, "commit object is not UTF-8, which the API cannot carry exactly", {
      commit: sha,
    });
  }
  let tree: string | null = null;
  const parents: string[] = [];
  const identities: Partial<Record<"author" | "committer", GitIdentity>> = {};
  for (const line of header.split("\n")) {
    const space = line.indexOf(" ");
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? "" : line.slice(space + 1);
    if (key === "tree" && tree === null && /^[0-9a-f]{40}$/.test(value)) {
      tree = value;
    } else if (key === "parent" && /^[0-9a-f]{40}$/.test(value)) {
      parents.push(value);
    } else if ((key === "author" || key === "committer") && identities[key] === undefined) {
      const match = IDENTITY.exec(value);
      const date = match ? isoWithOffset(Number(match[3]), match[4] as "+" | "-", match[5]!, match[6]!) : null;
      if (!match || date === null) {
        return deny(ReasonCode.BRANCH_PUBLISH_UNSUPPORTED, `commit ${key} cannot be expressed as an API identity`, {
          commit: sha,
          header: key,
        });
      }
      identities[key] = { name: match[1]!, email: match[2]!, date };
    } else {
      return deny(ReasonCode.BRANCH_PUBLISH_UNSUPPORTED, "commit carries a header the API cannot reproduce", {
        commit: sha,
        header: key.slice(0, 40),
      });
    }
  }
  if (tree === null || identities.author === undefined || identities.committer === undefined) {
    return deny(ReasonCode.BRANCH_PUBLISH_UNSUPPORTED, "commit object lacks a tree, author or committer", { commit: sha });
  }
  const fields: CommitApiFields = {
    message,
    tree,
    parents,
    author: identities.author,
    committer: identities.committer,
  };
  // The pre-flight: the fields must name this exact object before any of them leaves the machine.
  if (commitIdFromApiFields(fields) !== sha) {
    return deny(ReasonCode.BRANCH_PUBLISH_OBJECT_MISMATCH, "commit fields do not reproduce the local commit id", {
      commit: sha,
    });
  }
  return allow(ReasonCode.OK, fields);
};

/** A raw tree object as create-tree entries, in the object's own order. */
export const parseTreeObject = (sha: string, raw: Buffer): Decision<TreeApiEntry[]> => {
  const entries: TreeApiEntry[] = [];
  let at = 0;
  while (at < raw.length) {
    const space = raw.indexOf(0x20, at);
    const nul = raw.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > raw.length) {
      return deny(ReasonCode.BRANCH_PUBLISH_UNSUPPORTED, "tree object is malformed", { tree: sha });
    }
    const mode = raw.subarray(at, space).toString("latin1");
    const name = utf8OrNull(raw.subarray(space + 1, nul));
    if (name === null) {
      return deny(ReasonCode.BRANCH_PUBLISH_UNSUPPORTED, "tree entry name is not UTF-8, which the API cannot carry exactly", {
        tree: sha,
      });
    }
    const object = raw.subarray(nul + 1, nul + 21).toString("hex");
    const type: TreeEntryType | null = mode === "40000" ? "tree" : mode === "160000" ? "commit"
      : mode === "100644" || mode === "100755" || mode === "120000" ? "blob" : null;
    if (type === null) {
      return deny(ReasonCode.BRANCH_PUBLISH_UNSUPPORTED, "tree entry mode is not one the API takes", { tree: sha, mode });
    }
    entries.push({ path: name, mode: mode === "40000" ? "040000" : mode, type, sha: object });
    at = nul + 21;
  }
  // The pre-flight for trees: the entries, in this order and with git's own mode spelling, are this tree.
  const rendered = Buffer.concat(entries.map((entry) => Buffer.concat([
    Buffer.from(`${entry.mode === "040000" ? "40000" : entry.mode} ${entry.path}\0`, "utf8"),
    Buffer.from(entry.sha, "hex"),
  ])));
  if (gitObjectId("tree", rendered) !== sha) {
    return deny(ReasonCode.BRANCH_PUBLISH_OBJECT_MISMATCH, "tree entries do not reproduce the local tree id", { tree: sha });
  }
  return allow(ReasonCode.OK, entries);
};

/**
 * `git cat-file --batch` over `ids`: each object's type and bytes. Each object must be the type and size the
 * bounded metadata stated, so what was capped is what is read.
 */
const readObjects = async (
  cwd: string,
  ids: readonly string[],
  stated: ReadonlyMap<string, { type: string; size: number }>,
): Promise<Map<string, { type: string; content: Buffer }>> => {
  const out = new Map<string, { type: string; content: Buffer }>();
  if (ids.length === 0) return out;
  const { stdout } = await gitBytes(cwd, ["cat-file", "--batch"], { input: Buffer.from(`${ids.join("\n")}\n`, "latin1") });
  let at = 0;
  while (at < stdout.length) {
    const lineEnd = stdout.indexOf(0x0a, at);
    if (lineEnd < 0) throw new Error("cat-file --batch answer ended inside a header");
    const header = stdout.subarray(at, lineEnd).toString("latin1").split(" ");
    if (header[1] === "missing" || header.length !== 3) throw new Error(`object ${header[0] ?? "?"} is missing locally`);
    const size = Number(header[2]);
    const content = stdout.subarray(lineEnd + 1, lineEnd + 1 + size);
    if (content.length !== size) throw new Error("cat-file --batch answer ended inside an object");
    const expected = stated.get(header[0]!);
    if (expected === undefined || expected.type !== header[1] || expected.size !== size) {
      throw new Error(`object ${header[0]!} is not the type and size its metadata stated`);
    }
    out.set(header[0]!, { type: header[1]!, content });
    at = lineEnd + 1 + size + 1;
  }
  return out;
};

const lines = (bytes: Buffer): string[] => bytes.toString("latin1").split("\n").map((line) => line.trim()).filter(Boolean);

/**
 * Every object a publication of `candidateHead` sends to a remote whose `baseBranch` is at `baseHead`:
 * the commits `baseHead..candidateHead`, parents first, and the trees and blobs they reach that `baseHead`
 * does not. Every parent of a sent commit is either sent or an ancestor of `baseHead`, which the remote
 * holds once its base ref is read at `baseHead`. Counts and sizes are refused against `limits` before any
 * blob is read.
 */
export const collectBranchObjects = async (
  checkoutPath: string,
  baseHead: string,
  candidateHead: string,
  limits: BranchPublishLimits,
): Promise<Decision<BranchObjects>> => {
  const commitIds = lines((await gitBytes(checkoutPath, ["rev-list", "--topo-order", "--reverse", candidateHead, `^${baseHead}`])).stdout);
  if (commitIds.length > limits.maxCommits) {
    return deny(ReasonCode.BRANCH_PUBLISH_LIMIT_EXCEEDED, "candidate has more commits than one publication may send", {
      commits: commitIds.length,
      limit: limits.maxCommits,
    });
  }
  const allIds = lines((await gitBytes(checkoutPath, ["rev-list", "--objects", "--no-object-names", candidateHead, `^${baseHead}`])).stdout);
  if (allIds.length > limits.maxObjects) {
    return deny(ReasonCode.BRANCH_PUBLISH_LIMIT_EXCEEDED, "candidate has more objects than one publication may send", {
      objects: allIds.length,
      limit: limits.maxObjects,
    });
  }
  const checked = lines((await gitBytes(checkoutPath, ["cat-file", "--batch-check"], {
    input: Buffer.from(`${allIds.join("\n")}\n`, "latin1"),
  })).stdout).map((line) => line.split(" "));
  // #1161 BP-03 — every object counts, commits and trees as well as blobs: each against the per-object
  // bound and all of them against the total, from this metadata alone, before any payload is read.
  const blobIds: string[] = [];
  const treeIds: string[] = [];
  const stated = new Map<string, { type: string; size: number }>();
  let totalBytes = 0;
  for (const [id, type, size] of checked) {
    if (type !== "blob" && type !== "tree" && type !== "commit") {
      return deny(ReasonCode.BRANCH_PUBLISH_UNSUPPORTED, "candidate reaches an object the publication cannot send", {
        object: id ?? null,
        type: type ?? null,
      });
    }
    const bytes = Number(size);
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error(`object ${id ?? "?"} has no readable size`);
    if (bytes > limits.maxObjectBytes) {
      return deny(ReasonCode.BRANCH_PUBLISH_LIMIT_EXCEEDED, `a ${type} is larger than one publication may send`, {
        object: id,
        type,
        bytes,
        limit: limits.maxObjectBytes,
      });
    }
    totalBytes += bytes;
    if (totalBytes > limits.maxTotalBytes) {
      return deny(ReasonCode.BRANCH_PUBLISH_LIMIT_EXCEEDED, "candidate objects exceed the bytes one publication may send", {
        bytesAtLeast: totalBytes,
        limit: limits.maxTotalBytes,
      });
    }
    stated.set(id!, { type, size: bytes });
    if (type === "blob") blobIds.push(id!);
    else if (type === "tree") treeIds.push(id!);
  }
  if (stated.size !== allIds.length || commitIds.some((id) => stated.get(id)?.type !== "commit")) {
    throw new Error("the object metadata does not describe exactly the objects the publication sends");
  }

  const objects = await readObjects(checkoutPath, [...commitIds, ...treeIds, ...blobIds], stated);
  const sent = new Set(commitIds);
  const commits: LocalCommit[] = [];
  for (const id of commitIds) {
    const raw = objects.get(id);
    if (raw?.type !== "commit") throw new Error(`commit ${id} could not be read`);
    const fields = parseCommitObject(id, raw.content);
    if (!fields.allowed) return fields as Decision<BranchObjects>;
    for (const parent of fields.value.parents) {
      if (sent.has(parent)) continue;
      const ancestor = await gitBytes(checkoutPath, ["merge-base", "--is-ancestor", parent, baseHead], { allowExitCodes: [1] });
      if (ancestor.exitCode !== 0) {
        return deny(ReasonCode.BRANCH_PUBLISH_UNSUPPORTED, "a sent commit has a parent the remote base does not hold", {
          commit: id,
          parent,
          baseHead,
        });
      }
    }
    commits.push({ sha: id, fields: fields.value, raw: raw.content });
  }

  const parsedTrees = new Map<string, TreeApiEntry[]>();
  for (const id of treeIds) {
    const raw = objects.get(id);
    if (raw?.type !== "tree") throw new Error(`tree ${id} could not be read`);
    const entries = parseTreeObject(id, raw.content);
    if (!entries.allowed) return entries as Decision<BranchObjects>;
    parsedTrees.set(id, entries.value);
  }
  const trees: LocalTree[] = [];
  const placed = new Set<string>();
  const place = (id: string): void => {
    if (placed.has(id)) return;
    placed.add(id);
    for (const entry of parsedTrees.get(id) ?? []) {
      if (entry.type === "tree" && parsedTrees.has(entry.sha)) place(entry.sha);
    }
    trees.push({ sha: id, entries: parsedTrees.get(id)! });
  };
  for (const id of treeIds) place(id);

  const blobs: LocalBlob[] = [];
  for (const id of blobIds) {
    const raw = objects.get(id);
    if (raw?.type !== "blob" || gitObjectId("blob", raw.content) !== id) {
      return deny(ReasonCode.BRANCH_PUBLISH_OBJECT_MISMATCH, "blob bytes do not reproduce the local blob id", { blob: id });
    }
    blobs.push({ sha: id, content: raw.content });
  }

  const changed = new Set<string>();
  for (const commit of commits) {
    const diffArgs = commit.fields.parents.length === 0
      ? ["diff-tree", "-r", "--root", "--no-commit-id", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", commit.sha]
      : ["diff-tree", "-r", "-m", "--no-commit-id", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", commit.sha];
    for (const path of (await gitBytes(checkoutPath, diffArgs)).stdout.toString("utf8").split("\0")) {
      if (path) changed.add(path);
    }
  }

  const candidateTree = commitIds.length > 0
    ? commits[commits.length - 1]!.fields.tree
    : lines((await gitBytes(checkoutPath, ["rev-parse", `${candidateHead}^{tree}`])).stdout)[0] ?? "";
  if (commitIds.length > 0 && commits[commits.length - 1]!.sha !== candidateHead) {
    return deny(ReasonCode.BRANCH_PUBLISH_UNSUPPORTED, "the candidate is not the last commit the publication sends", {
      candidateHead,
    });
  }
  return allow(ReasonCode.OK, { commits, trees, blobs, changedPaths: [...changed].sort(), candidateTree, bytes: totalBytes });
};
