import { afterEach, describe, expect, it } from "vitest";

import { configuredBuzzActorIngressPolicy } from "../../src/daemon/agentcpd.ts";

/**
 * The capture must read the deployment's policy, not build one (#243).
 *
 * `scripts/capture-buzz-live.ts` used to generate its own secret and allowlist the identity it
 * had just landed. That proved `IngressGuard` enforces whatever list it is handed — which was
 * never in question — and said nothing about whether `agentcpd`'s configured policy would refuse
 * the actor. The capture now calls this resolver, so these pin the contract it depends on.
 *
 * The half-configured case is the one worth guarding. Returning a policy with an empty allowlist
 * would admit nothing and look like a working deny; returning one with an empty secret would
 * accept any signature. Both are silent, and both are worse than refusing to start.
 */
const KEYS = ["ACP_BUZZ_INGRESS_SECRET", "ACP_BUZZ_ALLOWED_ACTORS"] as const;
const saved = new Map<string, string | undefined>();
for (const key of KEYS) saved.set(key, process.env[key]);

afterEach(() => {
  for (const key of KEYS) {
    const previous = saved.get(key);
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

const withEnv = (secret: string | undefined, actors: string | undefined) => {
  if (secret === undefined) delete process.env["ACP_BUZZ_INGRESS_SECRET"];
  else process.env["ACP_BUZZ_INGRESS_SECRET"] = secret;
  if (actors === undefined) delete process.env["ACP_BUZZ_ALLOWED_ACTORS"];
  else process.env["ACP_BUZZ_ALLOWED_ACTORS"] = actors;
};

describe("the deployment's Buzz ingress policy is read, not invented (#243)", () => {
  it("returns null when the deployment configures no Buzz ingress", () => {
    // Null is not an error: a deployment that does not use Buzz has no policy, and the capture
    // reports that as "nothing to capture" rather than proceeding with one it made up.
    withEnv(undefined, undefined);
    expect(configuredBuzzActorIngressPolicy()).toBeNull();
  });

  it("refuses a half-configured policy rather than returning a permissive one", () => {
    withEnv("s3cret", undefined);
    expect(() => configuredBuzzActorIngressPolicy()).toThrowError(/must be configured together/);
    withEnv(undefined, "actor-one");
    expect(() => configuredBuzzActorIngressPolicy()).toThrowError(/must be configured together/);
  });

  it("returns exactly the configured actors and secret", () => {
    withEnv("s3cret", " actor-one , actor-two ,");
    expect(configuredBuzzActorIngressPolicy()).toEqual({
      allowedActors: ["actor-one", "actor-two"],
      secret: "s3cret",
    });
  });
});
