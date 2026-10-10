import { type Decision, allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import type { HandoffPackage } from "../../src/cto/cto-lifecycle.ts";
import { wakeRoleHolder } from "../../src/daemon/agentcpd.ts";
import { Role } from "../../src/domain/types.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import type { BootstrapRuntimeFixture } from "./bootstrap-cto-fixture.ts";
import { registerFixtureProject } from "./harness.ts";
import { callMcpToolOverSocket } from "./mcp-socket.ts";

/** #246 C4 — the handoff an activation hands its new PRIMARY_CTO, minimal and complete. */
export const DRIVEN_HANDOFF: HandoffPackage = {
  projectStatus: "new",
  activeManifestDigest: null,
  recentDecisions: [],
  openBlockers: [],
  queuedWork: [],
  repositoryFacts: [],
  knownRisks: [],
  recommendedNextAction: "verify",
};

type OpenActivationHandoff = (
  projectId: string,
  runId: string,
  toSessionId: string,
  handoff: HandoffPackage,
) => Decision<{ handoffId: string }>;

/** Activation's own recording and enqueue of its handoff (`BootstrapActivation.openActivationHandoff`). */
export const openActivationHandoff = (f: BootstrapRuntimeFixture): OpenActivationHandoff => {
  const bootstrap = f.harness.cp.bootstrap as unknown as { openActivationHandoff: OpenActivationHandoff };
  return bootstrap.openActivationHandoff.bind(bootstrap);
};

/** A bootstrap run, dispatched, and a driven PRIMARY_CTO provisioned for the project it activates. */
export const drivenPrimary = async (f: BootstrapRuntimeFixture, projectId: string) => {
  f.harness.cp.providers.registerForRole(f.claude, Role.PRIMARY_CTO);
  await registerFixtureProject(f.harness, projectId);
  const bootstrap = await f.dispatchBootstrap();
  const bound = await f.harness.cp.cto.ensureDrivenPrimaryCto(projectId, bootstrap.runId);
  if (!bound.allowed) throw new Error(`driven primary CTO refused: ${bound.reasonCode}: ${bound.message}`);
  return { bootstrap, binding: bound.value };
};

/** The provider's own conversation id for a session row. */
export const externalOf = (f: BootstrapRuntimeFixture, sessionId: string): string =>
  f.harness.cp.sessions.require(sessionId).incarnation.split("#")[0]!;

/** Audit rows of one kind about one session. */
export const countAudit = (f: BootstrapRuntimeFixture, kind: string, sessionId: string): number =>
  f.harness.cp.db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM audit_events WHERE kind = ? AND session_id = ?`,
    [kind, sessionId],
  )?.n ?? 0;

/** Work turns (relay, no challenge) of one session's conversation. */
export const workTurnsOf = (f: BootstrapRuntimeFixture, sessionId: string): number => {
  const external = externalOf(f, sessionId);
  return f.claude.turns.filter((turn) =>
    turn.handle.externalSessionId === external && turn.relay !== null && !/session_attest/.test(turn.prompt)).length;
};

/** The work turn the prompt asks for: read what is addressed in band, accept a handoff, acknowledge. */
export const actOnWorkTurns = (f: BootstrapRuntimeFixture, sessionId: string): void => {
  let keys = 0;
  f.claude.onWorkTurn = async (_request, credential) => {
    if (!credential || credential.sessionId !== sessionId) return;
    const as = { sessionId: credential.sessionId, sessionSecret: credential.sessionSecret, token: credential.token ?? "" };
    const pending = await callMcpToolOverSocket(f.ctoSocket, as, "role_dispatch_pending", {});
    const messages = (pending["value"] as { messages?: Array<{ messageId: string; kind: string; payload: { handoffId?: string } }> } | undefined)
      ?.messages ?? [];
    for (const message of messages) {
      const row = f.harness.cp.outbox.get(message.messageId)!;
      if (message.kind === MessageKind.HANDOFF_PACKAGE) {
        await callMcpToolOverSocket(f.ctoSocket, as, "handoff_ack", {
          idempotencyKey: `driven-recovery-ack-${++keys}`,
          handoffId: message.payload.handoffId,
          messageId: message.messageId,
          payloadDigest: row.payloadDigest,
          bindingGeneration: row.bindingGeneration,
        });
      }
      await callMcpToolOverSocket(f.ctoSocket, as, "role_dispatch_ack", { messageId: message.messageId });
    }
  };
};

/**
 * The daemon's in-band wake, routed by `wakeRoleHolder` exactly as the daemon routes it, with an
 * interactive conversation port that answers and does nothing. `wakes` counts its knocks.
 */
export const routeInBandWakes = (f: BootstrapRuntimeFixture): { knocks: () => number } => {
  let knocks = 0;
  const conversation = {
    wake: async () => {
      knocks += 1;
      return allow(ReasonCode.OK, undefined);
    },
  };
  f.harness.cp.outbox.attachInBandWake((roleKey, messageIds) =>
    wakeRoleHolder(f.harness.cp, conversation, roleKey, { kind: "in-band dispatch", ids: messageIds ?? [] }));
  return { knocks: () => knocks };
};

/** Holds this session's next attestation turn inside the provider until `release`. */
export const holdNextAttestation = (f: BootstrapRuntimeFixture, sessionId: string) => {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  let entered = false;
  const external = externalOf(f, sessionId);
  const original = f.claude.runSessionTurn.bind(f.claude);
  f.claude.runSessionTurn = async (request) => {
    if (!entered && request.handle.externalSessionId === external && /session_attest/.test(request.prompt)) {
      entered = true;
      await barrier;
    }
    return original(request);
  };
  return { release: () => release(), entered: () => entered };
};
