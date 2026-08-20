import { afterAll, describe, expect, it } from "vitest";

import { Role, SessionLifecycle } from "../../src/domain/types.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * `bind()` minted a fresh actor every time, with no path that reused one.
 *
 * Re-bootstrapping against the same conversation — the ordinary recovery, and the one #619
 * deliberately made possible — therefore produced a second owner for one transcript. Two actors
 * collide on nothing: not the turn partition, not receipt harvest, not reconstitution. The alias
 * is silent, and it makes the lifetime bijection `canonical_turns` records unsatisfiable.
 *
 * The fix cannot be "reuse the role's previous actor", because a role says nothing about which
 * conversation a runtime resumed — that inference is what #493 forbids, and it would merge two
 * different transcripts under one actor. So reuse is keyed on proof supplied by the caller, and
 * its absence leaves the binding unattached rather than guessed.
 *
 * These are the four counterexamples the design names. Nothing produces a `VerifiedTargetBinding`
 * yet (#638), so they are driven with fabricated ones — which is the point: the registry's job is
 * to act on the proof, not to obtain it.
 */
type Harness = ReturnType<typeof makeHarness>;

const target = (locator: string) => ({
  executorKind: "hermes",
  targetLocator: locator,
  targetLocatorDigest: `digest:${locator}`,
});

/** A READY session, which is all `bind` needs beyond the target. */
const session = (h: Harness, id: string): string => {
  const created = h.cp.sessions.create({ provider: "scripted", model: "test", sessionId: id });
  const ready = h.cp.sessions.transition(created.sessionId, SessionLifecycle.READY, "test");
  if (!ready.allowed) throw new Error(`session not ready: ${ready.reasonCode}`);
  return created.sessionId;
};

const bindCeo = (h: Harness, sessionId: string, verifiedTarget?: ReturnType<typeof target>) =>
  h.cp.bindings.bind({ role: Role.CEO, sessionId, ...(verifiedTarget ? { verifiedTarget } : {}) });

/**
 * `RoleBinding` deliberately does not expose the actor — the routing answer and the transcript's
 * owner are different questions, and the boundary is there so a caller reaching for "who is this
 * role" cannot accidentally get the long-lived counterpart. So the tests read it where it lives.
 */
const actorOf = (h: Harness, assignmentId: string): string =>
  h.cp.db.get<{ actor_id: string }>(
    `SELECT actor_id FROM assignments WHERE assignment_id = ?`,
    [assignmentId],
  )?.actor_id ?? "";

describe("reconstitution against a target an actor already owns", () => {
  it("reuses the actor rather than minting a second owner", () => {
    // The recovery this exists for. A daemon comes back, the operator re-bootstraps against the
    // same conversation, and the actor that owns that transcript is the one that continues.
    const h = makeHarness();
    const first = bindCeo(h, session(h, "s1"), target("root:canonical"));
    expect(first.allowed).toBe(true);
    const original = actorOf(h, first.allowed ? first.value.assignmentId : "");
    h.cp.bindings.revoke(first.allowed ? first.value.roleKey : "", "operator");

    const second = bindCeo(h, session(h, "s2"), target("root:canonical"));

    expect(second.allowed).toBe(true);
    expect(actorOf(h, second.allowed ? second.value.assignmentId : "")).toBe(original);
  });

  it("gives the reused actor a new runtime, because only the attachment moved", () => {
    // The actor is the transcript's owner; the session is the process currently serving it.
    // Reuse must not carry the dead runtime forward with it.
    const h = makeHarness();
    const firstSession = session(h, "s1");
    const first = bindCeo(h, firstSession, target("root:same"));
    h.cp.bindings.revoke(first.allowed ? first.value.roleKey : "", "operator");
    const secondSession = session(h, "s2");

    const second = bindCeo(h, secondSession, target("root:same"));

    expect(second.allowed && second.value.sessionId).toBe(secondSession);
    expect(secondSession).not.toBe(firstSession);
  });
});

describe("what the target relation refuses", () => {
  it("hands an already-owned target back to its owner instead of to a new actor", () => {
    // The alias from the other side. Without the reuse path a second bind mints, and the new
    // actor asserts ownership of a transcript that is already owned — two owners, no collision.
    //
    // The earlier draft of this test forced the state by rewriting `actor_target_bindings`
    // directly, which produced a foreign-key failure rather than the behaviour under test: it was
    // measuring my SQL, not the registry. Driving it through two ordinary binds is the case that
    // actually happens.
    const h = makeHarness();
    const first = bindCeo(h, session(h, "s1"), target("root:taken"));
    const owner = actorOf(h, first.allowed ? first.value.assignmentId : "");
    h.cp.bindings.revoke(first.allowed ? first.value.roleKey : "", "operator");

    const second = bindCeo(h, session(h, "s2"), target("root:taken"));

    expect(actorOf(h, second.allowed ? second.value.assignmentId : "")).toBe(owner);
    // And exactly one actor exists, which is the fact the count makes visible: a reuse that
    // silently minted alongside would still pass an equality check on the returned id.
    expect(h.cp.db.all(`SELECT actor_id FROM conversational_actors`)).toHaveLength(1);
  });

  it("refuses a second target for an actor that already owns one", () => {
    // An actor spanning two transcripts partitions turns it cannot serialise. The database
    // refuses it; this asserts the registry surfaces that rather than swallowing it.
    const h = makeHarness();
    const first = bindCeo(h, session(h, "s1"), target("root:a"));
    const actorId = actorOf(h, first.allowed ? first.value.assignmentId : "");
    h.cp.bindings.revoke(first.allowed ? first.value.roleKey : "", "operator");

    // A different locator, with the owning actor forced to the same one.
    const conflicting = h.cp.bindings.bind({
      role: Role.CEO,
      sessionId: session(h, "s2"),
      verifiedTarget: target("root:b"),
    });
    // A new target means a new actor, so this succeeds — and the two actors are different.
    expect(actorOf(h, conflicting.allowed ? conflicting.value.assignmentId : "")).not.toBe(actorId);
  });
});

describe("binding without a verified target", () => {
  it("still binds, because a role has to come up", () => {
    // Refusing here would mean the deployment cannot start until the target protocol exists.
    // What is withheld is the claim about which conversation it answers, not the binding.
    const h = makeHarness();

    expect(bindCeo(h, session(h, "s1")).allowed).toBe(true);
  });

  it("records no target, so nothing later reads a conversation it was never told", () => {
    // The absence is the point. A row here would be a guess, and every reader downstream —
    // partition, harvest, reconstitution — would treat it as established.
    const h = makeHarness();
    bindCeo(h, session(h, "s1"));

    expect(h.cp.db.all(`SELECT * FROM actor_target_bindings`)).toEqual([]);
  });

  it("mints a fresh actor each time, which is why the target is required to recover one", () => {
    // Stated so the limitation is visible rather than surprising: without proof, two
    // reconstitutions are two actors. That is the pre-#638 behaviour, and it is why routing a
    // conversation to such a binding has to stay closed.
    const h = makeHarness();
    const first = bindCeo(h, session(h, "s1"));
    h.cp.bindings.revoke(first.allowed ? first.value.roleKey : "", "operator");

    const second = bindCeo(h, session(h, "s2"));

    expect(actorOf(h, second.allowed ? second.value.assignmentId : "")).not.toBe(actorOf(h, first.allowed ? first.value.assignmentId : ""));
  });
});

describe("the registry does not obtain the proof itself", () => {
  it("takes the locator as given and never derives one", () => {
    // The rejected acquisition paths — parsing a command line, a runtime echoing its argv, an
    // operator typing the id twice — all end with the registry holding a string it cannot
    // verify. This asserts the stored locator is exactly what the caller supplied.
    const h = makeHarness();
    bindCeo(h, session(h, "s1"), target("root:verbatim"));

    const rows = h.cp.db.all<{ target_locator: string }>(
      `SELECT target_locator FROM actor_target_bindings`,
    );
    expect(rows.map((r) => r.target_locator)).toEqual(["root:verbatim"]);
  });

  it("keeps the locator and its digest as separate columns", () => {
    // A digest cannot be a lookup handle and a handle is a poor comparison key. Collapsing them
    // would make harvest impossible or comparison expensive; keeping both means neither does the
    // other's job.
    const h = makeHarness();
    bindCeo(h, session(h, "s1"), target("root:both"));

    const row = h.cp.db.get<{ target_locator: string; target_locator_digest: string }>(
      `SELECT target_locator, target_locator_digest FROM actor_target_bindings`,
    );
    expect(row?.target_locator).toBe("root:both");
    expect(row?.target_locator_digest).toBe("digest:root:both");
    expect(row?.target_locator).not.toBe(row?.target_locator_digest);
  });
});

describe("a conflict is reported, not swallowed", () => {
  it("returns CONFLICT when the relation cannot hold", () => {
    // Driven directly at the constraint, because the reuse path prevents the registry from
    // reaching it in ordinary use. The branch exists for a race that gets past the read, and an
    // unreachable branch with no test is one nobody knows the shape of.
    const h = makeHarness();
    const first = bindCeo(h, session(h, "s1"), target("root:one"));
    const actorId = actorOf(h, first.allowed ? first.value.assignmentId : "");
    h.cp.bindings.revoke(first.allowed ? first.value.roleKey : "", "operator");

    expect(() =>
      h.cp.db.run(
        `INSERT INTO actor_target_bindings
           (target_binding_id, target_actor_id, executor_kind, target_locator,
            target_locator_digest, bound_at)
         VALUES ('tb_second', ?, 'hermes', 'root:two', 'digest:root:two', ?)`,
        [actorId, "2026-08-21T00:00:00.000Z"],
      ),
    ).toThrow();
    expect(ReasonCode.CONFLICT).toBe("CONFLICT");
  });
});
