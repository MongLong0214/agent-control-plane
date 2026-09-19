import { isAbsolute } from "node:path";
import { z } from "zod";
import type { ControlPlane } from "../app/control-plane.ts";
import { CtoBindingDelegation } from "../ceo/cto-binding-delegation.ts";
import { runHermesTargetBind, type HermesTargetBindResponse } from "../runtime/hermes-target-bind.ts";
import { digestOf, sha256 } from "../core/digest.ts";
import { verifyClaudeIdentity, assertClaudeIdentityStillLive, SELF_CLAIM_PROTOCOL, SELF_CLAIM_EXECUTOR_KIND } from "../registry/canonical-self-claim.ts";
import { CtoDelegatedBinding } from "./cto-delegated-binding.ts";

const absolute = z.string().min(1).refine(isAbsolute);
const hermesTarget = z.object({
  provider: z.literal("hermes").default("hermes"),
  sessionId: z.string().min(1), incarnation: z.string().min(1),
  hermesExecutable: absolute, hermesHome: absolute, hermesProfile: z.string().min(1),
  requestedSessionId: z.string().min(1), expectedLineageRootDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  executorRuntimeIdentity: z.string().min(1),
}).strict();
const claudeTarget = z.object({
  provider: z.literal("claude"), sessionId: z.string().min(1), incarnation: z.string().min(1),
  nativeSessionUuid: z.string().uuid(), requiredExecutorVersion: z.string().min(1),
  expectedExecutorRealpath: absolute, expectedExecutorSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  expectedCwd: absolute,
}).strict();
const targetsSchema = z.array(z.union([hermesTarget, claudeTarget])).max(128);

/** Deployment-owned target pins, never request-supplied executable paths or proof callbacks.
 * Legacy grants expire on restart; explicitly durable owner grants use the existing event ledger.
 */
export function createCtoBindingRuntime(cp: ControlPlane, rawTargets: string | undefined) {
  let decoded: unknown;
  try { decoded = rawTargets?.trim() ? JSON.parse(rawTargets) : []; }
  catch { throw new Error("ACP_CTO_BINDING_TARGETS_JSON is invalid"); }
  const parsed = targetsSchema.safeParse(decoded);
  if (!parsed.success || new Set(parsed.data.map((t) => t.sessionId)).size !== parsed.data.length) {
    throw new Error("ACP_CTO_BINDING_TARGETS_JSON is invalid");
  }
  const targets = new Map(parsed.data.map((t) => [t.sessionId, t]));
  const authority = new CtoBindingDelegation(cp.sessions, cp.bindings, cp.ownerAuthority, cp.audit, cp.clock, cp.db);
  const service = new CtoDelegatedBinding({ db: cp.db, sessions: cp.sessions, bindings: cp.bindings, authority,
    target: (sessionId) => {
      const target = targets.get(sessionId);
      const session = cp.sessions.get(sessionId);
      if (!target || !session || session.provider !== target.provider || session.incarnation !== target.incarnation) return null;
      switch (target.provider) {
      case "claude": {
        if (session.osPid === null || session.osProcessStartedAt === null) return null;
        const pid = session.osPid;
        const claimed = { executorKind: SELF_CLAIM_EXECUTOR_KIND, targetLocator: target.nativeSessionUuid,
          targetLocatorDigest: sha256(target.nativeSessionUuid) };
        let attestationDigest = "";
        return { claimed, protocolVersion: SELF_CLAIM_PROTOCOL,
          get attestationDigest() { return attestationDigest; },
          verify: (tuple) => {
            if (tuple.sessionId !== sessionId || tuple.incarnation !== target.incarnation) return null;
            // This is a daemon-local check of an already provisioned session, not a new
            // claimant socket. Never pretend the authenticated CEO is the target's peer.
            const checked = verifyClaudeIdentity({ ...target, canonicalSessionUuid: target.nativeSessionUuid },
              { callerPid: pid, claimedPid: pid, claimedSessionUuid: target.nativeSessionUuid });
            if (!checked.allowed || checked.value.identity.startedAt !== session.osProcessStartedAt ||
                !assertClaudeIdentityStillLive(checked.value.identity).allowed) return null;
            attestationDigest = digestOf({ domain: "acp.cto-delegated-binding", ...tuple,
              ...checked.value, target: claimed });
            return claimed;
          },
        };
      }
      case "hermes": {
      const claimed = { executorKind: "hermes", targetLocator: target.requestedSessionId,
        targetLocatorDigest: target.expectedLineageRootDigest };
      let receipt: HermesTargetBindResponse | null = null;
      return { claimed, protocolVersion: "hermes.target-bind/v1",
        expectedExecutorRuntimeIdentity: target.executorRuntimeIdentity,
        get targetBindReceipt() { return receipt; },
        get attestationDigest() { return receipt?.receipt_digest ?? ""; },
        verify: (tuple) => {
          if (tuple.sessionId !== sessionId || tuple.incarnation !== target.incarnation) return null;
          const decision = runHermesTargetBind({ ...target, sessionId: target.requestedSessionId,
            actorId: tuple.actorId, bindingGeneration: tuple.generation, timeoutMs: 5000, maxOutputBytes: 65536 });
          if (!decision.allowed) return null;
          receipt = decision.value;
          return claimed;
        },
      };
      }
      }
    },
  });
  return Object.freeze({
    grant: (scope: unknown, receipt: unknown) => authority.grant(scope, receipt),
    revoke: (id: string, receipt: unknown) => authority.revoke(id, receipt),
    bind: (principal: { sessionId: string; sessionSecret: string }, request: unknown) =>
      service.execute({ method: "ctoBinding.bind", principal, request }),
  });
}
export type CtoBindingRuntime = ReturnType<typeof createCtoBindingRuntime>;
const runtimes = new WeakMap<ControlPlane, CtoBindingRuntime>();
export function daemonCtoBindingRuntime(cp: ControlPlane): CtoBindingRuntime {
  let runtime = runtimes.get(cp);
  if (!runtime) {
    runtime = createCtoBindingRuntime(cp, process.env["ACP_CTO_BINDING_TARGETS_JSON"]);
    runtimes.set(cp, runtime);
  }
  return runtime;
}
