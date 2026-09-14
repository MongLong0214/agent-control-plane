import { describe, expect, it } from "vitest";

import { Role } from "../../src/domain/types.ts";
import { ProviderRegistry } from "../../src/runtime/provider.ts";
import type { ProviderAdapter } from "../../src/runtime/provider.ts";

/**
 * #512. One `ClaudeCliAdapter` served every role and carried the blind reviewer's credential
 * scope, so the probe asking whether the **CTO** session was alive authenticated as the reviewer.
 * The dispatch refused with `SESSION_NOT_READY`, naming the session for a failure about identity.
 *
 * The repair is not one adapter that behaves differently; it is two adapters and a registry that
 * will not hand out either of them to a caller who did not say which identity it is acting as.
 * These rows pin that, and the third is the one that matters most: **making two instances is not
 * enough if a shared lookup can still collapse them into one.**
 */
const adapterNamed = (provider: string, marker: string): ProviderAdapter =>
  ({ provider, isProduction: true, marker } as unknown as ProviderAdapter);

describe("a registry hands out the role that asked", () => {
  const cto = adapterNamed("claude", "cto-identity");
  const reviewer = adapterNamed("claude", "reviewer-identity");

  const registryWithBothRoles = (): ProviderRegistry => {
    const registry = new ProviderRegistry();
    registry.registerForRole(cto, Role.PRIMARY_CTO);
    registry.registerForRole(reviewer, Role.BLIND_REVIEWER);
    return registry;
  };

  it("gives each role its own adapter, not one shared instance", () => {
    const registry = registryWithBothRoles();

    expect((registry.requireForRole("claude", Role.PRIMARY_CTO) as unknown as { marker: string }).marker)
      .toBe("cto-identity");
    expect((registry.requireForRole("claude", Role.BLIND_REVIEWER) as unknown as { marker: string }).marker)
      .toBe("reviewer-identity");
  });

  it("refuses a lookup that names no role, rather than picking one", () => {
    // The acceptance condition stated for this repair: two instances plus a shared lookup that
    // collapses them is the same defect wearing a fix. A caller with no role must not get an
    // identity chosen for it.
    const registry = registryWithBothRoles();

    expect(() => registry.require("claude")).toThrowError(/role-scoped/);
  });

  it("refuses the nullable lookup too, rather than reporting an ambiguity as an absence", () => {
    // `get` answers null for "not registered", and callers turn that into NOT_FOUND. Letting it
    // answer null for "registered, but you did not say as whom" would hide a present identity
    // behind a missing-adapter refusal. Both CTO reads of the registry go through this method.
    const registry = registryWithBothRoles();

    expect(() => registry.get("claude")).toThrowError(/role-scoped/);
  });

  it("refuses a role that was never registered rather than falling back", () => {
    const registry = new ProviderRegistry();
    registry.registerForRole(reviewer, Role.BLIND_REVIEWER);

    expect(() => registry.requireForRole("claude", Role.PRIMARY_CTO))
      .toThrowError(/no adapter registered for provider 'claude' in role 'PRIMARY_CTO'/);
  });

  it("leaves a provider with no role-scoped adapter answering as before", () => {
    // The capacity monitor asks by provider alone and has no role. Nothing about it changes,
    // which is why this repair does not have to reach it.
    const registry = new ProviderRegistry();
    registry.register(adapterNamed("grok", "shared"));

    expect((registry.require("grok") as unknown as { marker: string }).marker).toBe("shared");
    expect((registry.requireForRole("grok", Role.PRIMARY_CTO) as unknown as { marker: string }).marker)
      .toBe("shared");
  });

  it("refuses a second registration for the same provider and role", () => {
    const registry = registryWithBothRoles();

    expect(() => registry.registerForRole(adapterNamed("claude", "second"), Role.PRIMARY_CTO))
      .toThrowError(/already registered for role 'PRIMARY_CTO'/);
  });
});
