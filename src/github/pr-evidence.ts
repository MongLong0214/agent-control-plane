import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { digestOf, sha256 } from "../core/digest.ts";
import { type Decision, type Evidence, allow, deny, isAcpError } from "../core/errors.ts";
import { parseGitHubIdentity } from "../core/ids.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { RepositoryRecord } from "../registry/repository-registry.ts";

/**
 * `pr_evidence_get` — the CEO's own read of one pull request at an exact head, so a merge or deploy
 * decision can be checked against GitHub without a terminal.
 *
 * Scope: the repository is the one ACP's registry holds for the project, never a caller's URL or path;
 * the PR is the one number asked for; and GitHub is reached only through `GitHubReadClient`, which has
 * no method that writes. Nothing here runs a command or touches a local path.
 *
 * Head binding: the files, patches and merge-base are read from `compare/{baseSha}...{headSha}` by the
 * SHAs the PR read answered, on every page, rather than from `pulls/{n}/files`, which follows the PR's
 * head while it is being read: a push landing between the two reads would put another head's diff
 * under this head's label. A compare of two SHAs cannot change, and the check runs and statuses are
 * read by the same head SHA. The cost is GitHub's 300-file compare limit, past which the read is named
 * incomplete rather than wrong.
 *
 * Nothing incomplete is summarised as passing: every lookup that failed, every page that is missing,
 * every patch GitHub left out is named in `incomplete`, and while that list is not empty the answer is
 * a COVERAGE_INCOMPLETE refusal carrying what was read, `requiredChecks.allSatisfied` is never true,
 * and nothing in it says "ok". A continuation page carries the first page's gaps in its signed cursor,
 * so a snapshot that was incomplete stays incomplete on every page of it.
 */

/** GET only, over the kernel's App client and credential (`GitHubKernel.readOnlyGitHub`). */
export interface GitHubReadClient {
  get<T>(path: string): Promise<T>;
}

export interface PrEvidenceSource {
  projects: { get(projectId: string): unknown };
  repositories: { byProject(projectId: string): RepositoryRecord[] };
  github: GitHubReadClient;
}

export interface PrEvidenceInput {
  projectId: string;
  prNumber: number;
  expectedHead: string;
  repositoryRole?: string | undefined;
  cursor?: string | undefined;
  pageChars?: number | undefined;
}

/** The most diff characters one answer carries; a longer diff is read in pages. */
export const PR_EVIDENCE_DIFF_PAGE_MAX_CHARS = 100_000;

const PER_PAGE = 100;
/** GitHub's compare lists at most this many files; a larger diff is named incomplete. */
const COMPARE_FILE_LIMIT = 300;
const COMPARE_STATUSES: ReadonlySet<string> = new Set(["ahead", "behind", "diverged", "identical"]);
const CHECK_PAGE_BOUND = 10;
const RULE_PAGE_BOUND = 10;
const SHA = /^[0-9a-f]{40}$/;
/** A project id or repository role names a registry entry; a URL, a path or a remote identity is refused. */
const NOT_A_NAME = /[/\\:\s]|[\u0000-\u001f\u007f]|^\.\.?$/;

export interface PrEvidenceIncomplete {
  kind: "LOOKUP_FAILED" | "PERMISSION_DENIED" | "MALFORMED_RESPONSE" | "PAGE_BOUND_REACHED" | "COUNT_MISMATCH"
    | "PATCH_OMITTED" | "MERGEABILITY_NOT_COMPUTED" | "HEAD_MISMATCH"
    /** On a continuation page: the first page of this snapshot named gaps, so the snapshot is incomplete. */
    | "SNAPSHOT_INCOMPLETE";
  /** The GitHub API path the gap is in. */
  lookup: string;
  detail: string;
  page?: number;
  file?: string;
  status?: number;
}

export interface PrEvidenceFile {
  filename: string;
  previousFilename: string | null;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patchOmitted: boolean;
  blobUrl: string | null;
}

export interface PrEvidenceCheckRun {
  name: string;
  headSha: string;
  status: string;
  conclusion: string | null;
  appSlug: string | null;
  appId: number | null;
  url: string | null;
  detailsUrl: string | null;
}

export interface PrEvidenceStatus {
  context: string;
  state: string;
  url: string | null;
}

export interface PrEvidenceRequiredCheck {
  context: string;
  appId: number | null;
  sources: Array<"branch-protection" | "ruleset">;
  satisfied: boolean;
  observed: Array<{ kind: "check_run" | "status"; state: string | null; url: string | null }>;
}

export interface PrEvidenceSummary {
  pull: {
    state: string;
    draft: boolean | null;
    merged: boolean | null;
    title: string | null;
    headRef: string;
    baseRef: string;
    mergeable: boolean | null;
    /** REST `mergeable_state` (GraphQL `mergeStateStatus`), as GitHub computed it. */
    mergeableState: string | null;
    changedFiles: number | null;
    additions: number | null;
    deletions: number | null;
    commits: number | null;
  };
  mergeBase: { sha: string; compareStatus: string | null; aheadBy: number | null; behindBy: number | null } | null;
  files: PrEvidenceFile[];
  checks: { headSha: string; checkRuns: PrEvidenceCheckRun[]; statuses: PrEvidenceStatus[]; combinedState: string | null };
  requiredChecks: {
    /** Whether GitHub declares any required check for the base branch (branch protection or rulesets). */
    declared: boolean;
    contexts: PrEvidenceRequiredCheck[];
    /** true only when something is required, every one is green at the head and nothing is incomplete. */
    allSatisfied: boolean | null;
  };
  urls: {
    pull: string | null;
    files: string | null;
    checks: string | null;
    diff: string | null;
    patch: string | null;
    compare: string | null;
    /** The GitHub REST paths this answer was read from. */
    api: Record<string, string>;
  };
}

export interface PrEvidence {
  schema: "acp.pr-evidence.v1";
  projectId: string;
  repositoryIdentity: string;
  repositoryRole: string | null;
  prNumber: number;
  /** The SHAs the diff is between; every page of one read carries the same pair. */
  compared: { baseSha: string; headSha: string };
  diff: {
    offset: number;
    chars: number;
    /** Pass back as `cursor` for the next page; null once `done`. Bound to this PR, base, head and diff. */
    nextCursor: string | null;
    done: boolean;
    /** The whole diff's length in UTF-16 code units, as `offset` counts. */
    totalChars: number;
    totalUtf8Bytes: number;
    /** `sha256:` of the whole diff text; the pages joined in order hash to it. */
    sha256: string;
    fileCount: number;
    text: string;
  };
  incomplete: PrEvidenceIncomplete[];
  complete: boolean;
  /** The PR, files, checks and required checks; on the first page only, null on a continuation page. */
  summary: PrEvidenceSummary | null;
}

const cursorSchema = z.object({
  v: z.literal(1),
  p: z.string(),
  r: z.string(),
  n: z.number().int(),
  b: z.string().regex(SHA),
  h: z.string().regex(SHA),
  d: z.string(),
  o: z.number().int().min(0),
  /** How many gaps the first page of this snapshot named, and their digest. */
  g: z.number().int().min(0),
  gd: z.string(),
}).strict();
type Cursor = z.infer<typeof cursorSchema>;

/**
 * Signs the page cursors this process issues, so a cursor cannot be edited into another offset or into
 * a first page that had no gaps. Not a credential: it authorizes nothing, and a daemon restart only
 * makes earlier cursors unknown, which a fresh read without a cursor answers.
 */
const CURSOR_KEY = randomBytes(32);
const macOf = (payload: string): string => createHmac("sha256", CURSOR_KEY).update(payload).digest("base64url");
const encodeCursor = (cursor: Cursor): string => {
  const payload = Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
  return `${payload}.${macOf(payload)}`;
};
const decodeCursor = (text: string): Cursor | null => {
  const match = /^([A-Za-z0-9_-]{1,4000})\.([A-Za-z0-9_-]{43})$/.exec(text);
  if (!match) return null;
  const expected = Buffer.from(macOf(match[1]!), "utf8");
  const given = Buffer.from(match[2]!, "utf8");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(match[1]!, "base64url").toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

type Json = Record<string, unknown>;
const record = (value: unknown): Json | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Json : null;
const text = (value: unknown): string | null => typeof value === "string" ? value : null;
const count = (value: unknown): number | null => typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
const bool = (value: unknown): boolean | null => typeof value === "boolean" ? value : null;
const httpsUrl = (value: unknown): string | null => typeof value === "string" && value.startsWith("https://") ? value : null;

/** The HTTP status a failed GET carries, when GitHub answered at all. The error's own text is never echoed. */
const statusOf = (error: unknown): number | undefined => {
  if (!isAcpError(error)) return undefined;
  const status = (error.evidence as { status?: unknown } | undefined)?.status;
  return typeof status === "number" ? status : undefined;
};
const isPermissionFailure = (error: unknown): boolean => {
  const status = statusOf(error);
  return status === 401 || status === 403
    || (isAcpError(error) && error.reasonCode === ReasonCode.GITHUB_APP_PERMISSION_DENIED);
};
const gap = (error: unknown, lookup: string, detail: string, page?: number): PrEvidenceIncomplete => {
  const status = statusOf(error);
  return {
    kind: isPermissionFailure(error) ? "PERMISSION_DENIED" : "LOOKUP_FAILED",
    lookup, detail,
    ...(page === undefined ? {} : { page }),
    ...(status === undefined ? {} : { status }),
  };
};

interface FileRead {
  files: Array<PrEvidenceFile & { patch: string | null }>;
  gaps: PrEvidenceIncomplete[];
  mergeBase: { sha: string; compareStatus: string | null; aheadBy: number | null; behindBy: number | null } | null;
  compareUrl: string | null;
  lookup: string;
}

/**
 * The changed files, their patches and the merge-base, from one compare of the two SHAs. GitHub lists every
 * file of a compare on its first page, up to COMPARE_FILE_LIMIT; a count short of the PR's is named.
 */
const readComparedFiles = async (
  github: GitHubReadClient, root: string, baseSha: string, headSha: string, changedFiles: number | null, pullLookup: string,
): Promise<FileRead> => {
  const lookup = `${root}/compare/${baseSha}...${headSha}`;
  const files: FileRead["files"] = [];
  const gaps: PrEvidenceIncomplete[] = [];
  let compare: Json | null = null;
  try {
    compare = record(await github.get<unknown>(`${lookup}?per_page=1`));
    // An answer that is not an object holds no file, patch or merge-base: a gap, whatever the file count.
    if (!compare) gaps.push({ kind: "MALFORMED_RESPONSE", lookup, detail: "the compare answer is not an object; no file, patch or merge-base is in this answer" });
  } catch (error) {
    gaps.push(gap(error, lookup, "the compare of the two SHAs could not be read; no file or patch is in this answer"));
  }
  const rows = compare?.["files"];
  if (compare) {
    if (!Array.isArray(rows)) gaps.push({ kind: "MALFORMED_RESPONSE", lookup, detail: "the compare answer carries no files list" });
    if (text(record(compare["base_commit"])?.["sha"]) !== baseSha) {
      gaps.push({ kind: "MALFORMED_RESPONSE", lookup, detail: `the compare answer's base commit is not ${baseSha}` });
    }
    const compareStatus = text(compare["status"]);
    if (compareStatus === null || !COMPARE_STATUSES.has(compareStatus)) {
      gaps.push({ kind: "MALFORMED_RESPONSE", lookup, detail: "the compare answer carries no comparison status" });
    }
    if (count(compare["ahead_by"]) === null || count(compare["behind_by"]) === null) {
      gaps.push({ kind: "MALFORMED_RESPONSE", lookup, detail: "the compare answer carries no ahead_by/behind_by counts" });
    }
  }
  for (const row of Array.isArray(rows) ? rows : []) {
    const entry = record(row);
    const filename = text(entry?.["filename"]);
    if (!entry || filename === null) {
      gaps.push({ kind: "MALFORMED_RESPONSE", lookup, detail: "the compare lists an entry with no filename" });
      continue;
    }
    const patch = text(entry["patch"]);
    if (text(entry["status"]) === null || count(entry["additions"]) === null || count(entry["deletions"]) === null
        || count(entry["changes"]) === null) {
      gaps.push({ kind: "MALFORMED_RESPONSE", lookup, file: filename, detail: "the compare lists this file with no status or line counts" });
    }
    const status = text(entry["status"]) ?? "unknown";
    const changes = count(entry["changes"]) ?? 0;
    // A rename with no line changes has no patch to show; every other file without one is a gap.
    const patchOmitted = patch === null && !(status === "renamed" && changes === 0);
    if (patchOmitted) {
      gaps.push({ kind: "PATCH_OMITTED", lookup, file: filename,
        detail: "GitHub returned no patch for this file (binary, too large, or otherwise omitted); its diff is not in this answer" });
    }
    files.push({
      filename,
      previousFilename: text(entry["previous_filename"]),
      status,
      additions: count(entry["additions"]) ?? 0,
      deletions: count(entry["deletions"]) ?? 0,
      changes,
      patchOmitted,
      blobUrl: httpsUrl(entry["blob_url"]),
      patch,
    });
  }
  if (changedFiles === null) {
    gaps.push({ kind: "MALFORMED_RESPONSE", lookup: pullLookup, detail: "the pull request carries no changed_files count" });
  } else if (files.length !== changedFiles) {
    gaps.push({ kind: "COUNT_MISMATCH", lookup, detail: `${files.length} files listed, the pull request reports ${changedFiles}`
      + (files.length >= COMPARE_FILE_LIMIT ? `; GitHub's compare lists at most ${COMPARE_FILE_LIMIT}` : "") });
  }
  let mergeBase: FileRead["mergeBase"] = null;
  if (compare) {
    const mergeBaseSha = text(record(compare["merge_base_commit"])?.["sha"]);
    if (mergeBaseSha !== null && SHA.test(mergeBaseSha)) {
      mergeBase = { sha: mergeBaseSha, compareStatus: text(compare["status"]), aheadBy: count(compare["ahead_by"]), behindBy: count(compare["behind_by"]) };
    } else {
      gaps.push({ kind: "MALFORMED_RESPONSE", lookup, detail: "the compare answer carries no merge-base commit" });
    }
  }
  return { files, gaps, mergeBase, compareUrl: httpsUrl(compare?.["html_url"]), lookup };
};

/** Each file's section: a git header, and its GitHub patch when there is one. */
const diffOf = (files: FileRead["files"]): string => files.map((file) => {
  const from = file.previousFilename ?? file.filename;
  const header = `diff --git a/${from} b/${file.filename}\n`;
  if (file.patch === null || file.patch.length === 0) return header;
  const minus = file.status === "added" ? "/dev/null" : `a/${from}`;
  const plus = file.status === "removed" ? "/dev/null" : `b/${file.filename}`;
  return `${header}--- ${minus}\n+++ ${plus}\n${file.patch}${file.patch.endsWith("\n") ? "" : "\n"}`;
}).join("");

/** Pages of a list endpoint whose answer is `{ total_count, [key]: [...] }`, until the count or a short page. */
const readCounted = async (
  github: GitHubReadClient, lookup: string, query: string, key: string, gaps: PrEvidenceIncomplete[],
): Promise<{ rows: Json[]; first: Json | null }> => {
  const rows: Json[] = [];
  let first: Json | null = null;
  let total: number | null = null;
  for (let page = 1; page <= CHECK_PAGE_BOUND; page += 1) {
    let body: Json | null;
    try {
      body = record(await github.get<unknown>(`${lookup}?${query}per_page=${PER_PAGE}&page=${page}`));
    } catch (error) {
      gaps.push(gap(error, lookup, `page ${page} could not be read; it and every later page are missing`, page));
      return { rows, first };
    }
    const list = body?.[key];
    if (!body || !Array.isArray(list)) {
      gaps.push({ kind: "MALFORMED_RESPONSE", lookup, page, detail: `page ${page} carries no ${key} list` });
      return { rows, first };
    }
    const pageTotal = count(body["total_count"]);
    if (pageTotal === null) {
      gaps.push({ kind: "MALFORMED_RESPONSE", lookup, page, detail: `page ${page} carries no total_count, so a missing entry could not be seen` });
      return { rows, first: first ?? body };
    }
    first ??= body;
    total ??= pageTotal;
    for (const row of list) {
      const entry = record(row);
      if (entry) rows.push(entry);
      else gaps.push({ kind: "MALFORMED_RESPONSE", lookup, page, detail: `page ${page} holds an entry that is not an object` });
    }
    if (list.length < PER_PAGE || (total !== null && rows.length >= total)) {
      if (total !== null && rows.length !== total) {
        gaps.push({ kind: "COUNT_MISMATCH", lookup, detail: `${rows.length} listed, GitHub reports ${total}` });
      }
      return { rows, first };
    }
  }
  gaps.push({ kind: "PAGE_BOUND_REACHED", lookup, detail: `more than ${CHECK_PAGE_BOUND * PER_PAGE} entries; the rest are not read` });
  return { rows, first };
};

const readChecks = async (github: GitHubReadClient, root: string, headSha: string, gaps: PrEvidenceIncomplete[]) => {
  const runsLookup = `${root}/commits/${headSha}/check-runs`;
  const runs = await readCounted(github, runsLookup, "filter=latest&", "check_runs", gaps);
  const checkRuns: PrEvidenceCheckRun[] = [];
  for (const run of runs.rows) {
    const name = text(run["name"]);
    const runHead = text(run["head_sha"]);
    if (name === null || runHead === null) {
      gaps.push({ kind: "MALFORMED_RESPONSE", lookup: runsLookup, detail: "a check run carries no name or head_sha" });
      continue;
    }
    if (runHead !== headSha) {
      gaps.push({ kind: "HEAD_MISMATCH", lookup: runsLookup, detail: `check run ${name} is for ${runHead}, not ${headSha}; it is left out` });
      continue;
    }
    const app = record(run["app"]);
    const detailsUrl = httpsUrl(run["details_url"]);
    checkRuns.push({
      name, headSha: runHead, status: text(run["status"]) ?? "unknown", conclusion: text(run["conclusion"]),
      appSlug: text(app?.["slug"]), appId: count(app?.["id"]), url: httpsUrl(run["html_url"]) ?? detailsUrl, detailsUrl,
    });
  }
  const statusLookup = `${root}/commits/${headSha}/status`;
  const combined = await readCounted(github, statusLookup, "", "statuses", gaps);
  const combinedSha = text(combined.first?.["sha"]);
  const statuses: PrEvidenceStatus[] = [];
  if (combined.first && combinedSha === null) {
    gaps.push({ kind: "MALFORMED_RESPONSE", lookup: statusLookup, detail: "the combined status names no commit; it is left out" });
  } else if (combined.first && combinedSha !== headSha) {
    gaps.push({ kind: "HEAD_MISMATCH", lookup: statusLookup, detail: `the combined status is for ${String(combinedSha)}, not ${headSha}; it is left out` });
  } else {
    for (const status of combined.rows) {
      const context = text(status["context"]);
      if (context === null) {
        gaps.push({ kind: "MALFORMED_RESPONSE", lookup: statusLookup, detail: "a status carries no context" });
        continue;
      }
      statuses.push({ context, state: text(status["state"]) ?? "unknown", url: httpsUrl(status["target_url"]) });
    }
  }
  return { checkRuns, statuses, combinedState: combinedSha === headSha ? text(combined.first?.["state"]) : null, runsLookup, statusLookup };
};

/** The required checks GitHub declares for `baseRef`: classic branch protection and the active rulesets. */
const readRequired = async (github: GitHubReadClient, root: string, baseRef: string, gaps: PrEvidenceIncomplete[]) => {
  const required = new Map<string, { context: string; appId: number | null; sources: Set<"branch-protection" | "ruleset"> }>();
  const add = (context: string, appId: number | null, source: "branch-protection" | "ruleset") => {
    const key = `${context}\u0000${appId ?? ""}`;
    const entry = required.get(key) ?? { context, appId, sources: new Set() };
    entry.sources.add(source);
    required.set(key, entry);
  };
  const branchLookup = `${root}/branches/${encodeURIComponent(baseRef)}`;
  try {
    const branch = record(await github.get<unknown>(branchLookup));
    const isProtected = bool(branch?.["protected"]);
    if (isProtected === null) {
      gaps.push({ kind: "MALFORMED_RESPONSE", lookup: branchLookup, detail: "the base branch answer does not say whether it is protected" });
    } else if (isProtected) {
      const checks = record(record(branch?.["protection"])?.["required_status_checks"]);
      if (!checks) {
        gaps.push({ kind: "MALFORMED_RESPONSE", lookup: branchLookup, detail: "the base branch is protected and its required status checks are not readable" });
      } else if (text(checks["enforcement_level"]) !== "off") {
        const listed = Array.isArray(checks["checks"]) ? checks["checks"] : null;
        if (listed) {
          for (const item of listed) {
            const context = text(record(item)?.["context"]);
            if (context !== null) add(context, count(record(item)?.["app_id"]), "branch-protection");
          }
        } else if (Array.isArray(checks["contexts"])) {
          for (const context of checks["contexts"]) if (typeof context === "string") add(context, null, "branch-protection");
        }
      }
    }
  } catch (error) {
    gaps.push(gap(error, branchLookup, "the base branch's protection could not be read"));
  }
  const rulesLookup = `${root}/rules/branches/${encodeURIComponent(baseRef)}`;
  let ended = false;
  for (let page = 1; page <= RULE_PAGE_BOUND && !ended; page += 1) {
    let rules: unknown;
    try {
      rules = await github.get<unknown>(`${rulesLookup}?per_page=${PER_PAGE}&page=${page}`);
    } catch (error) {
      gaps.push(gap(error, rulesLookup, `ruleset page ${page} could not be read; it and every later page are missing`, page));
      ended = true;
      break;
    }
    if (!Array.isArray(rules)) {
      gaps.push({ kind: "MALFORMED_RESPONSE", lookup: rulesLookup, page, detail: `ruleset page ${page} is not a list` });
      ended = true;
      break;
    }
    for (const rule of rules) {
      if (text(record(rule)?.["type"]) !== "required_status_checks") continue;
      const listed = record(record(rule)?.["parameters"])?.["required_status_checks"];
      if (!Array.isArray(listed)) {
        gaps.push({ kind: "MALFORMED_RESPONSE", lookup: rulesLookup, page, detail: "a required_status_checks rule lists no checks" });
        continue;
      }
      for (const item of listed) {
        const context = text(record(item)?.["context"]);
        if (context !== null) add(context, count(record(item)?.["integration_id"]), "ruleset");
      }
    }
    ended = rules.length < PER_PAGE;
  }
  if (!ended) gaps.push({ kind: "PAGE_BOUND_REACHED", lookup: rulesLookup, detail: `more than ${RULE_PAGE_BOUND * PER_PAGE} rules; the rest are not read` });
  return { required: [...required.values()], branchLookup, rulesLookup };
};

/**
 * GitHub's protected-branch semantics: a required check passes on a completed `success`, `neutral` or `skipped`,
 * and a required status on `success`. Only what was observed at the head counts, from the named app when one is named.
 */
const PASSING_CONCLUSIONS: ReadonlySet<string> = new Set(["success", "neutral", "skipped"]);

const evaluateRequired = (
  required: Array<{ context: string; appId: number | null; sources: Set<"branch-protection" | "ruleset"> }>,
  checkRuns: PrEvidenceCheckRun[],
  statuses: PrEvidenceStatus[],
): PrEvidenceRequiredCheck[] => required.map(({ context, appId, sources }) => {
  const runs = checkRuns.filter((run) => run.name === context && (appId === null || run.appId === appId));
  const states = appId === null ? statuses.filter((status) => status.context === context) : [];
  const observed = [
    ...runs.map((run) => ({ kind: "check_run" as const, state: run.status === "completed" ? run.conclusion : run.status, url: run.url })),
    ...states.map((status) => ({ kind: "status" as const, state: status.state, url: status.url })),
  ];
  const satisfied = observed.length > 0
    && runs.every((run) => run.status === "completed" && run.conclusion !== null && PASSING_CONCLUSIONS.has(run.conclusion))
    && states.every((status) => status.state === "success");
  return { context, appId, sources: [...sources], satisfied, observed };
});

/** The registered GitHub repository of the project the caller names; never one the caller describes. */
const resolveRepository = (source: PrEvidenceSource, input: PrEvidenceInput): Decision<RepositoryRecord> => {
  if (!source.projects.get(input.projectId)) {
    return deny(ReasonCode.NOT_FOUND, "unknown project", { projectId: input.projectId });
  }
  const registered = source.repositories.byProject(input.projectId)
    .filter((repository) => repository.registration === "REGISTERED" && parseGitHubIdentity(repository.identity) !== null);
  const candidates = input.repositoryRole === undefined
    ? registered
    : registered.filter((repository) => repository.repositoryRole === input.repositoryRole);
  const roles = registered.map((repository) => repository.repositoryRole);
  if (candidates.length === 0) {
    return deny(ReasonCode.NOT_FOUND, "the project has no registered GitHub repository in that role", {
      projectId: input.projectId, repositoryRole: input.repositoryRole ?? null, registeredRoles: roles,
    });
  }
  if (candidates.length > 1) {
    return deny(ReasonCode.INVALID_ARGUMENT, "the project has several registered GitHub repositories; name repositoryRole", {
      projectId: input.projectId, registeredRoles: roles,
    });
  }
  return allow(ReasonCode.OK, candidates[0]!);
};

const validate = (input: PrEvidenceInput): Decision<void> => {
  if (NOT_A_NAME.test(input.projectId)) {
    return deny(ReasonCode.INVALID_ARGUMENT, "projectId names a registered project; a URL, path or remote identity is refused", {});
  }
  if (input.repositoryRole !== undefined && NOT_A_NAME.test(input.repositoryRole)) {
    return deny(ReasonCode.INVALID_ARGUMENT, "repositoryRole names a registered repository role; a URL, path or remote identity is refused", {});
  }
  if (!Number.isInteger(input.prNumber) || input.prNumber < 1) {
    return deny(ReasonCode.INVALID_ARGUMENT, "prNumber is a pull request number", {});
  }
  if (!SHA.test(input.expectedHead)) {
    return deny(ReasonCode.INVALID_ARGUMENT, "expectedHead is a full 40-hex commit SHA", {});
  }
  const pageChars = input.pageChars ?? PR_EVIDENCE_DIFF_PAGE_MAX_CHARS;
  if (!Number.isInteger(pageChars) || pageChars < 1 || pageChars > PR_EVIDENCE_DIFF_PAGE_MAX_CHARS) {
    return deny(ReasonCode.INVALID_ARGUMENT, `pageChars is between 1 and ${PR_EVIDENCE_DIFF_PAGE_MAX_CHARS}`, {});
  }
  return allow(ReasonCode.OK, undefined);
};

export const readPrEvidence = async (source: PrEvidenceSource, input: PrEvidenceInput): Promise<Decision<PrEvidence>> => {
  const valid = validate(input);
  if (!valid.allowed) return valid as Decision<PrEvidence>;
  const repository = resolveRepository(source, input);
  if (!repository.allowed) return repository as Decision<PrEvidence>;
  const identity = repository.value.identity;
  const { owner, repo } = parseGitHubIdentity(identity)!;
  const root = `/repos/${owner}/${repo}`;

  let cursor: Cursor | null = null;
  if (input.cursor !== undefined) {
    cursor = decodeCursor(input.cursor);
    if (!cursor) return deny(ReasonCode.INVALID_ARGUMENT, "cursor is not a page token this tool issued", {});
    if (cursor.p !== input.projectId || cursor.r !== identity || cursor.n !== input.prNumber) {
      return deny(ReasonCode.INVALID_ARGUMENT, "cursor was issued for another project, repository or pull request", {
        projectId: input.projectId, prNumber: input.prNumber,
      });
    }
    if (cursor.h !== input.expectedHead) {
      return deny(ReasonCode.SNAPSHOT_STALE, "cursor was issued against another head than expectedHead; start again without a cursor", {
        tokenHeadSha: cursor.h, expectedHead: input.expectedHead,
      });
    }
  }

  const pullLookup = `${root}/pulls/${input.prNumber}`;
  let pull: Json | null;
  try {
    pull = record(await source.github.get<unknown>(pullLookup));
  } catch (error) {
    const status = statusOf(error);
    const evidence: Evidence = { repositoryIdentity: identity, prNumber: input.prNumber, ...(status === undefined ? {} : { status }) };
    if (status === 404) return deny(ReasonCode.NOT_FOUND, "the registered repository has no pull request with that number", evidence);
    if (isPermissionFailure(error)) {
      return deny(ReasonCode.GITHUB_APP_PERMISSION_DENIED, "GitHub refused the App's read of this pull request", evidence);
    }
    if (isAcpError(error) && error.reasonCode === ReasonCode.TRUSTED_CREDENTIAL_UNAVAILABLE) {
      return deny(ReasonCode.TRUSTED_CREDENTIAL_UNAVAILABLE, "the trusted GitHub credential is not available", evidence);
    }
    return deny(ReasonCode.PROBE_FAILED, "the pull request could not be read from GitHub", evidence);
  }
  const head = record(pull?.["head"]);
  const base = record(pull?.["base"]);
  const headSha = text(head?.["sha"]);
  const baseSha = text(base?.["sha"]);
  const baseRef = text(base?.["ref"]);
  const baseRepo = text(record(base?.["repo"])?.["full_name"]);
  if (!pull || pull["number"] !== input.prNumber || headSha === null || !SHA.test(headSha) || baseSha === null
      || !SHA.test(baseSha) || baseRef === null || (baseRepo !== null && baseRepo.toLowerCase() !== `${owner}/${repo}`.toLowerCase())) {
    return deny(ReasonCode.PROBE_FAILED, "GitHub's answer is not this pull request of the registered repository", {
      repositoryIdentity: identity, prNumber: input.prNumber,
    });
  }
  if (headSha !== input.expectedHead) {
    return deny(ReasonCode.MERGE_HEAD_STALE, "the pull request's head is not expectedHead; nothing else is read", {
      prNumber: input.prNumber, expectedHead: input.expectedHead, headSha,
    });
  }
  if (cursor && cursor.b !== baseSha) {
    return deny(ReasonCode.SNAPSHOT_STALE, "the pull request's base moved since this cursor was issued; start again without a cursor", {
      tokenBaseSha: cursor.b, baseSha, headSha,
    });
  }

  const changedFiles = count(pull["changed_files"]);
  // By the two SHAs, on every page: see the module comment.
  const read = await readComparedFiles(source.github, root, baseSha, headSha, changedFiles, pullLookup);
  const incomplete = [...read.gaps];
  const diff = diffOf(read.files);
  const diffSha256 = sha256(diff);
  if (cursor && cursor.d !== diffSha256) {
    return deny(ReasonCode.SNAPSHOT_STALE, "the diff GitHub returns is not the one this cursor was issued for; start again without a cursor", {
      headSha, baseSha, tokenDiffSha256: cursor.d, diffSha256, incomplete,
    });
  }
  const offset = cursor?.o ?? 0;
  if (offset > diff.length) return deny(ReasonCode.INVALID_ARGUMENT, "cursor points past the end of the diff", {});

  let summary: PrEvidenceSummary | null = null;
  if (cursor) {
    if (cursor.g > 0) {
      incomplete.unshift({ kind: "SNAPSHOT_INCOMPLETE", lookup: pullLookup,
        detail: `the first page of this read named ${cursor.g} gap(s) (digest ${cursor.gd}); every page of it is incomplete` });
    }
  } else {
    const mergeable = bool(pull["mergeable"]);
    const mergeableState = text(pull["mergeable_state"]);
    if (mergeable === null || mergeableState === null || mergeableState === "unknown") {
      incomplete.push({ kind: "MERGEABILITY_NOT_COMPUTED", lookup: pullLookup,
        detail: "GitHub has not computed this pull request's mergeability yet; ask again" });
    }
    const checks = await readChecks(source.github, root, headSha, incomplete);
    const required = await readRequired(source.github, root, baseRef, incomplete);
    const contexts = evaluateRequired(required.required, checks.checkRuns, checks.statuses);
    const allSatisfied = contexts.length === 0
      ? null
      : contexts.some((context) => !context.satisfied) ? false : incomplete.length === 0 ? true : null;
    const html = httpsUrl(pull["html_url"]);
    summary = {
      pull: {
        state: text(pull["state"]) ?? "unknown", draft: bool(pull["draft"]), merged: bool(pull["merged"]), title: text(pull["title"]),
        headRef: text(head?.["ref"]) ?? "", baseRef, mergeable, mergeableState,
        changedFiles, additions: count(pull["additions"]), deletions: count(pull["deletions"]), commits: count(pull["commits"]),
      },
      mergeBase: read.mergeBase,
      files: read.files.map((file): PrEvidenceFile => ({
        filename: file.filename, previousFilename: file.previousFilename, status: file.status, additions: file.additions,
        deletions: file.deletions, changes: file.changes, patchOmitted: file.patchOmitted, blobUrl: file.blobUrl,
      })),
      checks: { headSha, checkRuns: checks.checkRuns, statuses: checks.statuses, combinedState: checks.combinedState },
      requiredChecks: { declared: contexts.length > 0, contexts, allSatisfied },
      urls: {
        pull: html, files: html === null ? null : `${html}/files`, checks: html === null ? null : `${html}/checks`,
        diff: httpsUrl(pull["diff_url"]), patch: httpsUrl(pull["patch_url"]), compare: read.compareUrl,
        api: {
          pull: pullLookup, compare: read.lookup, checkRuns: checks.runsLookup,
          status: checks.statusLookup, branch: required.branchLookup, rules: required.rulesLookup,
        },
      },
    };
  }

  // Sliced after every read of the snapshot, so the next cursor carries the first page's whole gap list.
  const pageChars = input.pageChars ?? PR_EVIDENCE_DIFF_PAGE_MAX_CHARS;
  let end = Math.min(offset + pageChars, diff.length);
  // A cut between the halves of a surrogate pair would leave half a character in each page.
  const last = diff.charCodeAt(end - 1);
  if (end < diff.length && end - offset > 1 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  const done = end >= diff.length;
  const carried = cursor ? { g: cursor.g, gd: cursor.gd } : { g: incomplete.length, gd: digestOf(incomplete) };
  const page = {
    offset,
    chars: end - offset,
    nextCursor: done ? null : encodeCursor({
      v: 1, p: input.projectId, r: identity, n: input.prNumber, b: baseSha, h: headSha, d: diffSha256, o: end, ...carried,
    }),
    done,
    totalChars: diff.length,
    totalUtf8Bytes: Buffer.byteLength(diff, "utf8"),
    sha256: diffSha256,
    fileCount: read.files.length,
    text: diff.slice(offset, end),
  };

  const evidence: PrEvidence = {
    schema: "acp.pr-evidence.v1",
    projectId: input.projectId,
    repositoryIdentity: identity,
    repositoryRole: repository.value.repositoryRole,
    prNumber: input.prNumber,
    compared: { baseSha, headSha },
    diff: page,
    incomplete,
    complete: incomplete.length === 0,
    summary,
  };
  return incomplete.length === 0
    ? allow(ReasonCode.OK, evidence)
    : deny(ReasonCode.COVERAGE_INCOMPLETE,
      `this read of the pull request is incomplete (${incomplete.length} gap(s) named in incomplete); it is not evidence that anything passes`,
      evidence as unknown as Evidence);
};
