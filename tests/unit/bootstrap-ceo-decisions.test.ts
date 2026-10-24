import { afterEach, describe, expect, it } from "vitest";

import { collectBootstrapCeoDecisions, frozenBootstrapCeoDecisions } from "../../src/bootstrap/bootstrap-ceo-decisions.ts";
import { digestOf } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Role, SessionLifecycle } from "../../src/domain/types.ts";
import { makeCore, seedRun } from "../helpers/fixtures.ts";

const fixtures: ReturnType<typeof makeCore>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.db.close(); });

const fixture = () => {
  const core = makeCore();
  fixtures.push(core);
  const run = seedRun({ ...core, repoPath: "/unused-fixture" });
  const ceo = core.sessions.create({ provider: "scripted", model: "ceo" });
  core.sessions.transition(ceo.sessionId, SessionLifecycle.READY, "fixture CEO");
  const bound = core.bindings.bind({ role: Role.CEO, sessionId: ceo.sessionId });
  if (!bound.allowed) throw new Error(bound.message);
  const payload = { intent: "RESUME_REVIEW", runId: run.runId, contractDigest: "sha256:contract",
    bootstrapPlanDigest: digestOf("attached PLAN"), attachmentDigest: digestOf("attachment"),
    directive: "Resume review only; blind review and CEO CONFIRM are still required." };
  let key = 0;
  const record = (overrides: { sessionId?: string; runId?: string; outboxRunId?: string; payload?: Partial<typeof payload>;
    evidence?: Record<string, unknown>; reasonCode?: typeof ReasonCode.GATE_AUTHORITY_DENIED } = {}) => {
    const message = core.outbox.enqueue({ idempotencyKey: `resume-${++key}`, runId: overrides.outboxRunId ?? run.runId,
      roleKey: run.roleKey, bindingGeneration: run.generation, targetSessionId: run.sessionId,
      kind: "RESUME_REVIEW", payload: { ...payload, ...overrides.payload } });
    if (!message.allowed) throw new Error(message.message);
    const audit = core.audit.record({ kind: "CEO_DECISION", roleKey: "CEO", runId: overrides.runId ?? run.runId,
      sessionId: overrides.sessionId ?? ceo.sessionId, ...(overrides.reasonCode ? { reasonCode: overrides.reasonCode } : {}),
      evidence: { instruction: "RESUME_REVIEW", messageId: message.value.messageId,
        contractDigest: payload.contractDigest, payloadDigest: payload.bootstrapPlanDigest, digest: payload.attachmentDigest,
        bindingGeneration: bound.value.bindingGeneration, ...overrides.evidence } });
    if (!audit.allowed) throw new Error(audit.message);
    return { message: message.value, audit: audit.value };
  };
  const otherRunId = `${run.runId}_other`;
  core.db.run(`INSERT INTO runs (run_id, kind, execution_mode, priority, state, goal, contract_digest, created_at)
    VALUES (?, 'PROJECT_BOOTSTRAP', 'STANDARD', 'NORMAL', 'ACTIVE', 'another run', 'sha256:other', ?)`, [otherRunId, core.clock.nowIso()]);
  return { ...core, run, ceo, bound: bound.value, payload, record, otherRunId };
};

describe("bootstrap CEO review-entry releases", () => {
  it("collects the authenticated release with the original binding, row digest and decision identity", () => {
    const f = fixture();
    const { message, audit } = f.record();
    const assignment = f.db.get<{ actor_id: string }>("SELECT actor_id FROM assignments WHERE assignment_id = ?", [f.bound.assignmentId])!;
    // Later authority changes must not erase a decision authenticated at admission time.
    expect(f.bindings.revoke("CEO", "later CEO departure").allowed).toBe(true);
    const records = collectBootstrapCeoDecisions(f.db, f.run.runId);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ runId: f.run.runId, escalationId: null,
      resolution: f.payload.directive, resolutionDigest: digestOf(f.payload.directive),
      source: { kind: "ACP_CEO_REVIEW_ENTRY_RELEASE", decisionEventId: audit,
        messageId: message.messageId, payloadDigest: message.payloadDigest, sessionId: f.ceo.sessionId,
        actorId: assignment.actor_id, assignmentId: f.bound.assignmentId, bindingGeneration: f.bound.bindingGeneration,
        bindingEventId: f.audit.byKind("BINDING_CREATED").find(event => event.roleKey === "CEO")!.eventId,
        contractDigest: f.payload.contractDigest, bootstrapPlanDigest: f.payload.bootstrapPlanDigest,
        attachmentDigest: f.payload.attachmentDigest } });
    expect(frozenBootstrapCeoDecisions({ authenticatedCeoDecisions: records })).toEqual(records);
    expect(() => frozenBootstrapCeoDecisions({ authenticatedCeoDecisions: [{ ...records[0], resolution: "changed" }] }))
      .toThrow("frozen CEO decision digest mismatch");
  });

  it.each(["non-CEO", "other run", "other outbox run", "other payload run", "wrong intent", "wrong contract",
    "wrong PLAN", "wrong attachment", "wrong CEO generation", "missing message", "denied decision", "revoked CEO"])(
    "does not collect a %s release", scenario => {
      const f = fixture();
      if (scenario === "revoked CEO") expect(f.bindings.revoke("CEO", "before decision").allowed).toBe(true);
      f.record({
        ...(scenario === "non-CEO" ? { sessionId: f.run.sessionId } : {}),
        ...(scenario === "other run" ? { runId: f.otherRunId, outboxRunId: f.otherRunId, payload: { runId: f.otherRunId } } : {}),
        ...(scenario === "other outbox run" ? { outboxRunId: f.otherRunId } : {}),
        ...(scenario === "other payload run" ? { payload: { runId: f.otherRunId } } : {}),
        ...(scenario === "wrong intent" ? { payload: { intent: "CONFIRM" } } : {}),
        ...(scenario === "wrong contract" ? { payload: { contractDigest: digestOf("other") } } : {}),
        ...(scenario === "wrong PLAN" ? { payload: { bootstrapPlanDigest: digestOf("other") } } : {}),
        ...(scenario === "wrong attachment" ? { payload: { attachmentDigest: digestOf("other") } } : {}),
        ...(scenario === "wrong CEO generation" ? { evidence: { bindingGeneration: f.bound.bindingGeneration + 1 } } : {}),
        ...(scenario === "missing message" ? { evidence: { messageId: "missing" } } : {}),
        ...(scenario === "denied decision" ? { reasonCode: ReasonCode.GATE_AUTHORITY_DENIED } : {}),
      });
      expect(collectBootstrapCeoDecisions(f.db, f.run.runId)).toEqual([]);
    },
  );

  it("excludes a payload whose bytes do not match its recorded outbox digest", () => {
    const f = fixture();
    f.record();
    // Model corrupt storage at the read boundary without weakening immutable table guards.
    const get = f.db.get.bind(f.db);
    f.db.get = ((sql: string, params?: unknown[]) => {
      const row = get(sql, params);
      return sql.includes("FROM outbox") && row ? { ...row as object, payload_digest: digestOf("wrong") } : row;
    }) as typeof f.db.get;
    expect(collectBootstrapCeoDecisions(f.db, f.run.runId)).toEqual([]);
  });
});
