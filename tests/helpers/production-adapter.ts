import { join } from "node:path";

import type { Clock } from "../../src/core/clock.ts";
import { sha256 } from "../../src/core/digest.ts";
import type {
  InvocationRequest,
  InvocationResult,
  ReviewerEgressRecord,
  SessionHandle,
  SessionSpec,
} from "../../src/runtime/provider.ts";
import { REVIEWER_PROVIDER_ENDPOINTS } from "../../src/runtime/provider.ts";
import { ScriptedAdapter } from "../../src/runtime/scripted-adapter.ts";

/**
 * A scripted adapter the *test suite* routes production work to.
 *
 * §14 admission and §15 coverage both refuse to route when no production provider is
 * registered, and `ScriptedAdapter` is deliberately `isProduction = false` so a
 * deterministic double can never stand in for a real model in the product. Tests still
 * have to drive dispatch, so the production flag is flipped *here* — under `tests/`,
 * where the shipped composition root cannot reach it. That keeps the shipped code free of
 * a mock-only production path while letting a fixture exercise the routing it guards.
 */
export class TestProductionAdapter extends ScriptedAdapter {
  override readonly isProduction = true;

  constructor(clock: Clock, provider = "scripted") {
    super(clock, provider);
  }

  /**
   * The provider may allocate a concrete workdir below the requested managed root. Keeping
   * those values different makes lifecycle tests prove that the returned routing fact, not
   * the request echo, is what gets persisted.
   */
  override async startSession(spec: SessionSpec): Promise<SessionHandle> {
    const handle = await super.startSession(spec);
    return { ...handle, workdir: join(spec.workdir, "provider-returned-workdir") };
  }

  /**
   * Attests the blind-review isolation contract, which the shipped `ScriptedAdapter`
   * refuses to do and should refuse to do: it has no OS boundary to enforce.
   *
   * This double has nothing to isolate. It answers from a queued script and performs no
   * I/O at all — it opens no file, spawns no process, reads no repository, touches no
   * daemon state and makes no network call — so a packet-only reviewer boundary is
   * satisfied by construction rather than by enforcement. Saying so here, in a test-owned
   * subclass, keeps the attestation out of the product: a real adapter still has to prove
   * it confined the process, and `BlindReviewGate` still refuses one that cannot.
   */
  override async invoke(request: InvocationRequest): Promise<InvocationResult> {
    const result = await super.invoke(request);
    return request.isolation
      ? { ...result, isolationAttested: true, egressEvidence: testReviewerEgressEvidence(this.provider) }
      : result;
  }
}

/**
 * Deterministic evidence used only by test doubles which do no I/O at all. Production
 * adapters may never use this: they must populate the same shape from a live proxy lease.
 */
export const testReviewerEgressEvidence = (provider: string): ReviewerEgressRecord[] => {
  const allowedHost = REVIEWER_PROVIDER_ENDPOINTS[provider]?.[0] ??
    `${provider.replace(/[^a-z0-9-]/gi, "").toLowerCase() || "reviewer"}.provider.test`;
  const deniedHost = allowedHost === "api.openai.com" ? "api.anthropic.com" : "api.openai.com";
  const port = 18_443;
  const allowlistDigest = sha256(`${allowedHost}\n`);
  return [{
    provider,
    allowedEndpoints: [allowedHost],
    allowlistDigest,
    proxyPort: port,
    phase: "reviewer-invocation",
    jsonl: [
      JSON.stringify({ t: 1, verdict: "START", port, pid: 1, allowlistDigest }),
      JSON.stringify({ t: 2, verdict: "ALLOW", host: allowedHost, port: 443 }),
      JSON.stringify({ t: 3, verdict: "DENY", host: deniedHost, port: 443 }),
    ].join("\n") + "\n",
    probes: {
      allowedEndpoint: { host: allowedHost, connected: true, statusCode: 200 },
      deniedEndpoint: { host: deniedHost, denied: true, statusCode: 403 },
      directSocket: [
        { host: allowedHost, proxyMode: "unset", connected: false, blocked: true, errorCode: "EPERM" },
        { host: allowedHost, proxyMode: "override", connected: false, blocked: true, errorCode: "EPERM" },
      ],
    },
  }];
};
