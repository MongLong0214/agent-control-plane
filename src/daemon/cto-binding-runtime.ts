import { isAbsolute } from "node:path";
import { z } from "zod";
import type { ControlPlane } from "../app/control-plane.ts";
import { CtoBindingDelegation } from "../ceo/cto-binding-delegation.ts";
import { runHermesTargetBind, type HermesTargetBindResponse } from "../runtime/hermes-target-bind.ts";
import { digestOf, sha256 } from "../core/digest.ts";
import { verifyClaudeIdentity, assertClaudeIdentityStillLive, hashingExecutingImageInspector, isExecutingImageProbeFailure,
  SELF_CLAIM_PROTOCOL, SELF_CLAIM_EXECUTOR_KIND } from "../registry/canonical-self-claim.ts";
import { CtoDelegatedBinding } from "./cto-delegated-binding.ts";

const absolute = z.string().min(1).refine(isAbsolute);
const hermesTarget = z.object({
  provider: z.literal("hermes").default("hermes"),
  sessionId: z.string().min(1), incarnation: z.string().min(1),
  hermesExecutable: absolute, hermesHome: absolute, hermesProfile: z.string().min(1),
  requestedSessionId: z.string().min(1), expectedLineageRootDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  executorRuntimeIdentity: z.string().min(1),
}).strict();
/**
 * The three pins a Claude target used to carry: a version, a realpath and a sha256 the verifier
 * compared the target's executing image against. That comparison was withdrawn with the canonical
 * claim's (2026-09-27) — `verifyClaudeIdentity` observes the image and compares it to nothing — so
 * no value here means anything. They are still accepted, with any value, and dropped at parse so
 * nothing downstream can read them. Refusing them is what `.strict()` would do if they were simply
 * deleted, and that would stop a deployment that still provisions them from starting: the failure
 * the removal was for, pointed the other way. The superseded canonical variables are ignored rather
 * than refused for the same reason.
 */
const WITHDRAWN_CLAUDE_TARGET_PINS = {
  requiredExecutorVersion: z.unknown().optional(),
  expectedExecutorRealpath: z.unknown().optional(),
  expectedExecutorSha256: z.unknown().optional(),
};
const claudeTarget = z.object({
  provider: z.literal("claude"), sessionId: z.string().min(1), incarnation: z.string().min(1),
  nativeSessionUuid: z.string().uuid(), ...WITHDRAWN_CLAUDE_TARGET_PINS,
}).strict().transform(({ requiredExecutorVersion: _version, expectedExecutorRealpath: _realpath,
  expectedExecutorSha256: _sha256, ...target }) => target);
const targetsSchema = z.array(z.union([hermesTarget, claudeTarget])).max(128);

/** Deployment-owned target pins, never request-supplied executable paths or proof callbacks.
 * There are no grants to expire or reconstruct: `bind` is the only door, and the CEO's own
 * live binding is what opens it.
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
  const authority = new CtoBindingDelegation(cp.sessions, cp.bindings, cp.audit, cp.db);
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
            // The hashing inspector, because the digest below is the one reader of the image's
            // sha256; the canonical claim observes the same image without reading its bytes.
            const checked = verifyClaudeIdentity({ ...target, canonicalSessionUuids: [target.nativeSessionUuid] },
              { callerPid: pid, claimedPid: pid, claimedSessionUuid: target.nativeSessionUuid },
              { imageInspector: hashingExecutingImageInspector });
            if (!checked.allowed || checked.value.identity.startedAt !== session.osProcessStartedAt ||
                !assertClaudeIdentityStillLive(checked.value.identity).allowed) return null;
            // An image the scan resolved but whose bytes could not be read arrives without its
            // sha256. Attesting it would put a composition in this digest it has never had — an
            // observed image with no hash — so it is refused; it used to be folded into `null` and
            // attested as no image at all. No image (`null`) and a scan that never ran are still
            // attested as they are: neither is a hash that failed.
            const { image } = checked.value;
            if (image !== null && !isExecutingImageProbeFailure(image) && image.sha256 === undefined) return null;
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
    bind: (principal: { sessionId: string; sessionSecret: string }, request: unknown) =>
      service.execute({ method: "ctoBinding.bind", principal, request }),
    // The removing half. It takes no deployment-owned target pin because it produces no
    // binding: a release needs to know which binding it ends, not which runtime it trusts.
    release: (principal: { sessionId: string; sessionSecret: string }, request: unknown) =>
      service.release({ method: "ctoBinding.release", principal, request }),
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
