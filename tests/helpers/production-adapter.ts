import type { Clock } from "../../src/core/clock.ts";
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
}
