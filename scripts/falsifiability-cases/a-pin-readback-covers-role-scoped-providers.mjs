/**
 * #954, the blocker the first version of this check shipped with. `checkProviderExecutables` read
 * `this.providers.production()`, which is
 * `list().filter(a => a.isProduction && !hasRoleScoped(a.provider))`. Both `ClaudeCliAdapter`s are
 * registered with `registerForRole` — `control-plane.ts:726` and `:740` carry `roles:`, and `:458`
 * routes anything with `roles` there — so claude is not in the shared production inventory, and
 * claude is the provider whose pin died on the host. Measured on the shipped composition with the
 * three `ACP_*_BINARY` pins set: `list()` gives `['gpt','grok','claude']`, `production()` gives
 * `['gpt','grok']`, and `doctor.run("capacity")` produced no finding at all for a claude pin whose
 * versioned target had been pruned.
 *
 * `production()`'s own docstring already said which question this is: `list()` "enumerates every
 * provider this deployment has, role-scoped included, because providerCount, the sweep budget
 * derived from its length, and doctor's per-provider reads are facts about the provider set and go
 * wrong when a provider silently leaves it."
 *
 * The mutation is that substitution, restored. It compiles and every unscoped case in the test file
 * survives it, which is the point: only a witness that composes through `ControlPlane` with the
 * default adapters can see it, and the absence of such a witness is what let this reach a green
 * suite twice. The `isProduction` filter inside the loop makes the mutant a pure narrowing of the
 * provider set rather than a type error.
 */
const aPinReadbackCoversRoleScopedProviders = {
  id: "a-pin-readback-covers-role-scoped-providers",
  what: "the pin readback reads the whole provider set, role-scoped providers included, not the shared production inventory",
  file: "src/doctor/doctor.ts",
  find: "    for (const adapter of this.providers.list()) {",
  replace: "    for (const adapter of this.providers.production()) {",
  killedBy: [
    "tests/unit/the-doctor-reads-the-pin-it-will-spawn.test.ts::finds the pruned pin on the shipped composition, where claude is registered per role",
  ],
};

export default aPinReadbackCoversRoleScopedProviders;
