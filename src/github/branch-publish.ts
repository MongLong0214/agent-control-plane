import { NON_PORTABLE_PATTERNS } from "../contracts/manifest.ts";
import { digestOf, sha256 } from "../core/digest.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { BranchObjects, BranchPublishLimits } from "../git/branch-objects.ts";

/**
 * #512 S-PUSH (CEO f5879479) — the refusing public-safety scan over everything a branch publication sends,
 * completed before the first upload. The objects are read by `src/git/branch-objects.ts`; nothing here
 * spawns a process or sends a request.
 */


/** D5 — a publication never changes a workflow: the App holds no workflows permission, and none is added. */
export const workflowChanges = (paths: readonly string[]): string[] =>
  paths.filter((path) => {
    const lower = path.toLowerCase();
    return lower === ".github/workflows" || lower.startsWith(".github/workflows/");
  });

/**
 * The session URL forms the scan refuses (#1161 BP-01): an agent conversation, share or task link names a
 * session as surely as a session trailer does. Each provider form is listed; the generic `/session(s)/<id>`
 * rule covers the rest that put the word in the path.
 */
const SESSION_URL_RULES: ReadonlyArray<RegExp> = [
  /\bclaude\.ai\/(?:code|chat|share|project)s?\b/i,
  /\b(?:chatgpt\.com|chat\.openai\.com)\/(?:c|share|s|g|codex|backend-api\/conversation)\//i,
  /\bgemini\.google\.com\/(?:app|share|gem)\//i,
  /\bg\.co\/gemini\/share\//i,
  /\bgrok\.com\/(?:chat|share|c)\//i,
  /\b(?:x|twitter)\.com\/i\/grok\b/i,
  /https?:\/\/[^\s\x22\x27<>]*\/sessions?\/[A-Za-z0-9_-]{8,}/i,
  // The same without a scheme, as a link pasted into a path or a branch name carries it.
  /\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\/(?:[^\s\x22\x27<>]*\/)?sessions?\/[A-Za-z0-9_-]{8,}/i,
];

/** What the public-safety scan refuses, by name. A finding names its rule and its object, never the text. */
const SCAN_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  ...NON_PORTABLE_PATTERNS.map(([pattern, name]) => [pattern, name] as const),
  ...SESSION_URL_RULES.map((pattern) => [pattern, "session url"] as const),
  [/^[ \t]*(?:[A-Za-z][A-Za-z0-9]*-)*Session(?:-Id|-Url|-Link)?[ \t]*:/im, "session trailer"],
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/, "private key"],
  [/~\/\.(?:hermes|agent-control-plane)(?![A-Za-z0-9_-])/, "home state path"],
  [/\$\{?HOME\}?\/\.(?:hermes|agent-control-plane)(?![A-Za-z0-9_-])/, "home state path"],
  [/(?:^|[^A-Za-z0-9._~-])\/(?:Users|home)\/[A-Za-z0-9._-]+\//im, "absolute home path"],
];

export const BRANCH_PUBLISH_SCANNER = "acp.branch-publish-scan.v2";

/** The most tree entries the full-path walk visits before it refuses rather than scan a subset. */
const MAX_PATH_VISITS = 200_000;

export interface PublicationScanInput {
  objects: BranchObjects;
  branch: string;
  pullRequestTitle: string;
  pullRequestBody: string;
  /** Absolute paths that never leave the machine: the home directory, the ACP state root, registered checkouts. */
  forbiddenPaths: readonly string[];
  limits: BranchPublishLimits;
}

export interface PublicationScan {
  scanDigest: string;
  counts: { commits: number; trees: number; blobs: number; bytes: number };
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** The bytes as UTF-8 text, or null when they are not valid UTF-8 (which the binary policy then covers). */
const utf8Text = (bytes: Buffer): string | null => {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return null;
  }
};

/** A UTF-16 blob with a byte-order mark, as text; null for anything else. */
const utf16Text = (bytes: Buffer): string | null => {
  if (bytes.length < 2) return null;
  const little = bytes[0] === 0xff && bytes[1] === 0xfe;
  const big = bytes[0] === 0xfe && bytes[1] === 0xff;
  if (!little && !big) return null;
  const body = Buffer.from(bytes.subarray(2, 2 + Math.floor((bytes.length - 2) / 2) * 2));
  return (big ? body.swap16() : body).toString("utf16le");
};

/**
 * The refusing public-safety scan, over every object the publication sends and the pull request text that
 * follows it, completed before the first upload. A finding refuses the whole publication: redacting would
 * change the bytes and so the commit id. The digest names the scanner and every object it read, so a
 * receipt binds the exact set that was found clean.
 *
 * #1161 BP-01 (CEO 37f3fcb3) — one standard on every surface, and no decoding that can hide a match:
 * - Text surfaces are read as strict UTF-8, never with replacement characters: the PR title and body, the
 *   ref, every full joined tree path, and each commit object (message, author and committer). A commit or a
 *   tree name that is not valid UTF-8 is refused where it is read (`parseCommitObject`, `parseTreeObject`).
 * - Blobs: a blob that is valid UTF-8 is scanned as that text. A blob that is not (binary, or text in another
 *   encoding) falls under the stated binary policy: every rule is matched against the raw bytes one byte per
 *   character (every rule is ASCII, so this finds exactly the byte sequences a rule names), and every
 *   forbidden path is searched for as its raw UTF-8 bytes. A UTF-16 blob with a byte-order mark is also
 *   decoded and scanned as text. A path written in any other non-UTF-8 encoding is not detected (a limit).
 * - Every surface also gets the raw UTF-8 byte search for each forbidden path, in NFC and NFD; the text
 *   search compares each path in NFC, NFD and case-folded, because macOS stores names decomposed and compares
 *   them without case.
 * - Tree paths are scanned joined from each sent commit's root (`a/b/c`), not one component at a time.
 */
export const scanPublication = (input: PublicationScanInput): Decision<PublicationScan> => {
  const { objects } = input;
  for (const [label, text] of [["pull request title", input.pullRequestTitle], ["pull request body", input.pullRequestBody]] as const) {
    if (Buffer.byteLength(text, "utf8") > input.limits.maxTextBytes) {
      return deny(ReasonCode.BRANCH_PUBLISH_LIMIT_EXCEEDED, `${label} is longer than a publication may send`, {
        object: label,
        limit: input.limits.maxTextBytes,
      });
    }
  }
  const literals = [...new Set(
    input.forbiddenPaths
      .map((path) => path.replace(/\/+$/, ""))
      .filter((path) => path.length > 1)
      .flatMap((path) => [path, path.normalize("NFC"), path.normalize("NFD")]),
  )];
  const folded = [...new Set(literals.map((literal) => literal.toLowerCase()))];
  const literalBytes = literals.map((literal) => Buffer.from(literal, "utf8"));
  const seen = new Set<string>();
  const findings: Array<{ object: string; rule: string }> = [];
  const found = (object: string, rule: string): void => {
    const key = `${object}\u0000${rule}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (findings.length < 20) findings.push({ object, rule });
  };
  const scanRules = (object: string, text: string): void => {
    for (const [pattern, rule] of SCAN_RULES) if (pattern.test(text)) found(object, rule);
  };
  const scanText = (object: string, text: string): void => {
    scanRules(object, text);
    const variants = [text, text.normalize("NFC"), text.normalize("NFD")].map((variant) => variant.toLowerCase());
    if (folded.some((literal) => variants.some((variant) => variant.includes(literal)))) found(object, "local absolute path");
  };
  const scanBytes = (object: string, bytes: Buffer): void => {
    if (literalBytes.some((literal) => bytes.includes(literal))) found(object, "local absolute path");
    const text = utf8Text(bytes);
    if (text !== null) {
      scanText(object, text);
      return;
    }
    // The binary policy: the rules over the raw bytes, one byte per character; the paths over their UTF-8 bytes.
    scanRules(object, bytes.toString("latin1"));
    const wide = utf16Text(bytes);
    if (wide !== null) scanText(object, wide);
  };

  scanText("ref", `refs/heads/${input.branch}`);
  scanText("pull request title", input.pullRequestTitle);
  scanText("pull request body", input.pullRequestBody);
  for (const commit of objects.commits) scanBytes(`commit:${commit.sha}`, commit.raw);

  const treeById = new Map(objects.trees.map((tree) => [tree.sha, tree]));
  const walked = new Set<string>();
  const reached = new Set<string>();
  let visits = 0;
  const walk = (treeSha: string, prefix: string): boolean => {
    const tree = treeById.get(treeSha);
    if (tree === undefined) return true;
    const key = `${treeSha}\u0000${prefix}`;
    if (walked.has(key)) return true;
    walked.add(key);
    reached.add(treeSha);
    for (const entry of tree.entries) {
      visits += 1;
      if (visits > MAX_PATH_VISITS) return false;
      const path = prefix === "" ? entry.path : `${prefix}/${entry.path}`;
      scanText(`tree:${tree.sha}:path`, path);
      if (entry.type === "tree" && !walk(entry.sha, path)) return false;
    }
    return true;
  };
  for (const commit of objects.commits) {
    if (!walk(commit.fields.tree, "")) {
      return deny(ReasonCode.BRANCH_PUBLISH_LIMIT_EXCEEDED, "the candidate's tree paths are more than the scan reads in full", {
        limit: MAX_PATH_VISITS,
      });
    }
  }
  // A sent tree no sent commit reaches still has every entry scanned, by name.
  for (const tree of objects.trees) {
    if (!reached.has(tree.sha)) for (const entry of tree.entries) scanText(`tree:${tree.sha}:path`, entry.path);
  }
  for (const path of objects.changedPaths) scanText("changed path", path);
  for (const blob of objects.blobs) scanBytes(`blob:${blob.sha}`, blob.content);

  if (seen.size > 0) {
    return deny(ReasonCode.BRANCH_PUBLISH_CONTENT_REFUSED, "the public-safety scan refused the publication; nothing was sent", {
      scanner: BRANCH_PUBLISH_SCANNER,
      findings,
      findingCount: seen.size,
    });
  }
  return allow(ReasonCode.OK, {
    scanDigest: digestOf({
      scanner: BRANCH_PUBLISH_SCANNER,
      ref: `refs/heads/${input.branch}`,
      commits: objects.commits.map((commit) => commit.sha),
      trees: objects.trees.map((tree) => tree.sha),
      blobs: objects.blobs.map((blob) => blob.sha),
      pullRequestTitle: sha256(input.pullRequestTitle),
      pullRequestBody: sha256(input.pullRequestBody),
    }),
    // The bounded set the collector capped: every commit, tree and blob byte.
    counts: { commits: objects.commits.length, trees: objects.trees.length, blobs: objects.blobs.length, bytes: objects.bytes },
  });
};
