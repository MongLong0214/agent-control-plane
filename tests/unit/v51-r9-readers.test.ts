import { createCtoMcpPort } from "../../src/mcp/cto-server.ts";
import { respond } from "../../src/mcp/shared.ts";
import type { Node } from "typescript";
import { afterAll, expect, it } from "vitest";
import { MessageKind } from "../../src/outbox/envelope.ts";
import { cleanupTempDirs, seedRun } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);
const UNKNOWN = "outcome unknown / delivery unconfirmed / automatic resend held";
const fixture = (outcome: "withheld" | "timeout" = "withheld") => {
  const h = makeHarness();
  const seeded = seedRun({ db: h.cp.db, clock: h.clock, repoPath: h.repoPath });
  const session = h.cp.sessions.require(seeded.sessionId);
  h.cp.sessions.setBuzzAddress(session.sessionId, "room");
  const binding = h.cp.bindings.active(`PRIMARY_CTO:${seeded.projectId}`)!;
  const enqueued = h.cp.outbox.enqueue({ roleKey: binding.roleKey, bindingGeneration: binding.bindingGeneration,
    targetSessionId: session.sessionId, runId: seeded.runId, kind: MessageKind.REVISION_REQUEST,
    idempotencyKey: `revision:${seeded.runId}:candidate:VERIFICATION_COMMAND_FAILED:attempt_111111111111111111111111`, payload: { candidateSnapshotDigest: "candidate", reasonCode: "VERIFICATION_COMMAND_FAILED", report: {} } });
  if (!enqueued.allowed) throw new Error(enqueued.message);
  const claim = h.cp.outbox.claimDeliverable().find(row => row.messageId === enqueued.value.messageId)!;
  if (!claim) throw new Error("no claim");
  const destination = { room: "room", recipient: "recipient" };
  h.cp.outbox.recordSendInFlight(claim.messageId, destination);
  const receipt = outcome === "withheld"
    ? h.cp.outbox.markAlreadySent(claim.messageId, claim.claimToken, "UNKNOWN", destination)
    : h.cp.outbox.markAttemptFailed(claim.messageId, claim.claimToken, {
      failureClass: "unknown_observed", retryable: false, error: "injected timeout", destination });
  return { h, seeded, session, claim, receipt };
};

it("FCR-17: external role_dispatch_ack refusal must disclose the held unknown outcome", () => {
  const f = fixture();
  try {
    const receipt = respond(createCtoMcpPort(f.h.cp).acknowledgeInBand(f.claim.messageId, f.session.sessionId, f.session.incarnation));
    const body = JSON.parse(receipt.content[0]!.text);
    expect(body.evidence).toMatchObject({ status: "OUTCOME_UNKNOWN", delivery: UNKNOWN, delivered: false, completed: false, automaticResendHeld: true });
  } finally { f.h.cp.close(); }
});

it("FCR-17: generic stale ACK refusal discloses the held unknown outcome", () => {
  const f = fixture();
  try {
    const receipt = f.h.cp.outbox.acknowledge(f.claim.messageId, f.session.sessionId, 999, f.session.incarnation);
    expect(receipt.evidence).toMatchObject({ status: "OUTCOME_UNKNOWN", delivery: UNKNOWN,
      delivered: false, completed: false, automaticResendHeld: true });
  } finally { f.h.cp.close(); }
});

// Check the types of receivers rather than a hand-picked file list or variable names. The only
// raw views are the DB/domain mapper and the private ingress replay adapter (no external status).
it("FCR-17 reader census: newly serialized outbox statuses must use the shared projection", async () => {
  const { default: ts } = await import("typescript");
  const { fileURLToPath } = await import("node:url");
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const config = ts.readConfigFile(`${root}tsconfig.json`, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const program = ts.createProgram(parsed.fileNames.filter(path => path.startsWith(`${root}src/`)), parsed.options);
  const checker = program.getTypeChecker();
  const violations: string[] = [];
  const internal: string[] = [];
  for (const source of program.getSourceFiles().filter(file => file.fileName.startsWith(`${root}src/`))) {
    const path = source.fileName.slice(root.length);
    const visit = (node: Node): void => {
      if (ts.isPropertyAssignment(node) && ts.isPropertyAccessExpression(node.initializer) && node.initializer.name.text === "status") {
        const receiver = checker.getNonNullableType(checker.getTypeAtLocation(node.initializer.expression));
        if ((receiver.getProperty("messageId") && receiver.getProperty("failureClass")) || (receiver.getProperty("message_id") && receiver.getProperty("failure_class"))) {
          const object = node.parent;
          const call = object.parent;
          const throughProjection = ts.isCallExpression(call) && call.expression.getText(source) === "outboxDeliveryReadback";
          let scope: Node | undefined = node;
          let privateReplay = false;
          let mapper = false;
          while (scope) {
            if (ts.isPropertyAssignment(scope) && scope.name.getText(source) === "existingRoleMessage") privateReplay = true;
            if (ts.isVariableDeclaration(scope) && scope.name.getText(source) === "hydrate") mapper = true;
            scope = scope.parent;
          }
          if (throughProjection) { /* shared interpretation is the external boundary */ }
          else if ((path === "src/outbox/outbox.ts" && mapper) || (path === "src/daemon/agentcpd.ts" && privateReplay)) {
            internal.push(`${path}:${mapper ? "hydrate" : "existingRoleMessage"}`);
          } else {
            const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
            violations.push(`${path}:${line + 1}: ${node.getText(source)}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(violations).toEqual([]);
  expect(internal.sort()).toEqual(["src/daemon/agentcpd.ts:existingRoleMessage", "src/daemon/agentcpd.ts:existingRoleMessage", "src/outbox/outbox.ts:hydrate"]);
});
