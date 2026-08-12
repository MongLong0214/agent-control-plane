import type { Clock } from "../../src/core/clock.ts";
import type { InvocationRequest, InvocationResult } from "../../src/runtime/provider.ts";
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
    return request.isolation ? { ...result, isolationAttested: true } : result;
  }
}
