import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BOOTSTRAP_POST_CONFIRM_LIFECYCLE,
  BootstrapLifecycleKind,
  bootstrapLifecycleSection,
  type BootstrapLifecycleSite,
} from "../../src/bootstrap/bootstrap-lifecycle.ts";
import { REPO_FACTORY_RESULT_SCHEMA_ID } from "../../src/bootstrap/repo-factory-result.ts";

/**
 * W2 — each sentence of the post-CONFIRM lifecycle the BOOTSTRAP_PLAN reviewer is shown is tied to
 * the code that makes it true. For every site an item names, the body of that function (with its doc
 * comment) must still hold every refusal or check the item rests on, and none of the checks a
 * NOT_VERIFIED item reports as absent. Removing an enforcement, or adding a check an item says is
 * missing, fails here until the statement is changed with it.
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const source = (file: string): string => readFileSync(`${ROOT}${file}`, "utf8");

/**
 * The text of `symbol`'s definition: its doc comment, its signature and its body, up to the next
 * declaration at the same indentation. A closing line (`}`, `)`, `]`) at that indentation is still
 * part of it.
 */
const definitionOf = (text: string, symbol: string): string | null => {
  const lines = text.split("\n");
  const head = new RegExp(
    `^\\s*(?:(?:export|private|public|protected|static|async|readonly)\\s+)*(?:const\\s+)?#?${symbol}\\s*(?:=|\\(|<)`,
  );
  const start = lines.findIndex((line) => head.test(line));
  if (start < 0) return null;
  const indent = lines[start]!.length - lines[start]!.trimStart().length;
  let end = start + 1;
  for (; end < lines.length; end += 1) {
    const line = lines[end]!;
    if (line.trim() === "") continue;
    const at = line.length - line.trimStart().length;
    if (at < indent) break;
    if (at === indent && !/^\s*[)}\]]/.test(line)) break;
  }
  let doc = start;
  if (lines[start - 1]?.trim().endsWith("*/")) {
    while (doc > 0 && !lines[doc - 1]!.trim().startsWith("/**")) doc -= 1;
    doc -= 1;
  }
  return lines.slice(Math.max(doc, 0), end).join("\n");
};

/** What a site's code no longer says that its statement rests on. */
const violations = (text: string, site: BootstrapLifecycleSite): string[] => {
  const body = definitionOf(text, site.symbol);
  if (body === null) return [`${site.file}: ${site.symbol} is not defined`];
  return [
    ...site.enforces.filter((token) => !body.includes(token)).map((token) => `${site.file} ${site.symbol}: missing ${JSON.stringify(token)}`),
    ...(site.absent ?? []).filter((token) => body.includes(token)).map((token) => `${site.file} ${site.symbol}: now checks ${JSON.stringify(token)}`),
  ];
};

describe("W2: every lifecycle statement is tied to the code that enforces it", () => {
  it("the items are distinct, every kind is present, and every item names at least one site", () => {
    const ids = BOOTSTRAP_POST_CONFIRM_LIFECYCLE.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(BOOTSTRAP_POST_CONFIRM_LIFECYCLE.map((item) => item.kind))).toEqual(new Set(Object.values(BootstrapLifecycleKind)));
    for (const item of BOOTSTRAP_POST_CONFIRM_LIFECYCLE) {
      expect(item.sites.length, item.id).toBeGreaterThan(0);
      for (const site of item.sites) expect(site.enforces.length, `${item.id} ${site.symbol}`).toBeGreaterThan(0);
    }
    // Review of run_7717 — the two checks once reported absent (F2, F3) are enforced now, and the
    // application's terminal state (F5) and the delivered facts (F4) are stated with their code.
    for (const id of ["confirm-manifest-recheck", "confirm-ack-recipient", "application-completed", "handoff-observed-facts"]) {
      const item = BOOTSTRAP_POST_CONFIRM_LIFECYCLE.find((candidate) => candidate.id === id)!;
      expect(item.kind, id).toBe(BootstrapLifecycleKind.IMPLEMENTED_GUARANTEE);
    }
    // F1 — the forged-ledger item states the trust boundary and keeps the checks it does not exempt.
    const forged = BOOTSTRAP_POST_CONFIRM_LIFECYCLE.find((candidate) => candidate.id === "forged-ledger")!;
    expect(forged.kind).toBe(BootstrapLifecycleKind.NOT_VERIFIED);
    expect(forged.statement).toContain("single local owner account");
    expect(forged.statement).toContain("not an exemption");
    expect(forged.sites[0]!.enforces).toEqual(expect.arrayContaining(["WRONG_TARGET", "already exists and carries no receipt from this bootstrap operation"]));
  });

  it.each(BOOTSTRAP_POST_CONFIRM_LIFECYCLE.map((item) => [item.id, item] as const))("%s: its sites still enforce it", (_id, item) => {
    expect(item.sites.flatMap((site) => violations(source(site.file), site))).toEqual([]);
  });

  it("the check bites: a body with an enforcement removed, or with an absent check added, is reported", () => {
    const activation = source("src/bootstrap/activation.ts");
    const ack = BOOTSTRAP_POST_CONFIRM_LIFECYCLE.find((item) => item.id === "handoff-ack-gate")!.sites.find((site) => site.symbol === "incompleteness")!;
    expect(violations(activation, ack)).toEqual([]);
    expect(violations(activation.replace('missing.push("handoffAck")', "void 0"), ack)).toEqual([
      `src/bootstrap/activation.ts incompleteness: missing ${JSON.stringify('missing.push("handoffAck")')}`,
    ]);
    const recipient = BOOTSTRAP_POST_CONFIRM_LIFECYCLE.find((item) => item.id === "confirm-ack-recipient")!.sites[0]!;
    expect(violations(activation, recipient)).toEqual([]);
    const unchecked = activation.replace("primary.sessionId !== handoffArtifact.content.toSessionId", "false");
    expect(unchecked).not.toBe(activation);
    expect(violations(unchecked, recipient)).toEqual([
      `src/bootstrap/activation.ts finalizeBootstrapActivationConfirm: missing ${JSON.stringify("primary.sessionId !== handoffArtifact.content.toSessionId")}`,
    ]);
    // F5 — the CONFIRM no longer moving the application to COMPLETED is reported.
    const gate = source("src/ceo/production-gate.ts");
    const completed = BOOTSTRAP_POST_CONFIRM_LIFECYCLE.find((item) => item.id === "application-completed")!.sites.find((site) => site.symbol === "submitCeoDecision")!;
    expect(violations(gate, completed)).toEqual([]);
    expect(violations(gate.replace("applications.markCompleted(input.runId, input.candidateSnapshotDigest)", "allow(ReasonCode.OK, null)"), completed)).toEqual([
      `src/ceo/production-gate.ts submitCeoDecision: missing ${JSON.stringify("applications.markCompleted(input.runId, input.candidateSnapshotDigest)")}`,
    ]);
  });

  it("F6: the run's own PLAN-task provenance is rendered as an enforced fact when recorded and as NOT_VERIFIED when not, and not at all unnamed", () => {
    const at = (lines: string[], text: string) => lines.findIndex((line) => line.startsWith(text));
    const headings = (lines: string[]) => ({
      guarantees: lines.indexOf("Guarantees the control plane implements after CONFIRM:"),
      notVerified: lines.indexOf("Conditions the control plane does not verify:"),
    });
    const bound = bootstrapLifecycleSection({ taskId: "task_bound", planDigest: "sha256:plan", recorded: true });
    const line = at(bound, "- [plan-task-provenance-this-run]");
    expect(line).toBeGreaterThan(headings(bound).guarantees);
    expect(line).toBeLessThan(headings(bound).notVerified);
    expect(bound[line]).toContain("task task_bound is bound to its current PLAN sha256:plan by a BOOTSTRAP_PLAN_TASKS record");
    const legacy = bootstrapLifecycleSection({ taskId: "task_legacy", planDigest: "sha256:plan", recorded: false });
    expect(at(legacy, "- [plan-task-provenance-this-run]")).toBeGreaterThan(headings(legacy).notVerified);
    expect(legacy[at(legacy, "- [plan-task-provenance-this-run]")]).toContain("no BOOTSTRAP_PLAN_TASKS record");
    expect(at(bootstrapLifecycleSection(), "- [plan-task-provenance-this-run]")).toBe(-1);
    // The site it names is the store read the review prompt computes it with.
    expect(source("src/run/task-graph.ts")).toContain("export const bootstrapPlanTaskRecorded = ");
    expect(source("src/review/blind-review.ts")).toContain("bootstrapPlanTaskRecorded(this.db, request.runId, taskId, planDigest)");
  });

  it("the prompt section is rendered from the items alone, grouped by kind, and the result schema from its constant", () => {
    const section = bootstrapLifecycleSection().join("\n");
    for (const item of BOOTSTRAP_POST_CONFIRM_LIFECYCLE) expect(section).toContain(`- [${item.id}] ${item.statement}`);
    const order = ["Plan-level requirements", "Guarantees the control plane implements after CONFIRM", "Conditions the control plane does not verify"].map((heading) =>
      section.indexOf(heading),
    );
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(BOOTSTRAP_POST_CONFIRM_LIFECYCLE.find((item) => item.id === "result-parsed")!.statement).toContain(REPO_FACTORY_RESULT_SCHEMA_ID);
    expect(section).toContain("not a request to pass it");
  });
});
