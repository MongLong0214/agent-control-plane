import { afterAll, describe, expect, it } from "vitest";

import { buzzCollaborationAuthority } from "../../src/daemon/agentcpd.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import {
  bindCeo,
  fixtureManifest,
  makeHarness,
  registerFixtureProject,
} from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * #674's authority, against the real registry.
 *
 * The seam's ordering and refusals are measured in `buzz-message-ingress.test.ts` against a spy.
 * What these rows measure is the half a spy cannot stand in for: that the two answers are read
 * from assignments and sessions, and that the window between them is a refusal rather than a
 * stale grant.
 */
const anyBuzzActorIsAuthenticated = { isAllowedActor: () => true };

const ROOM = "buzz-ceo-room";


/**
 * A second project, registered without a repository.
 *
 * `registerFixtureProject` binds `harness.repoPath` as the project's canonical checkout, and a
 * second call refuses — correctly: one path cannot be two repositories' canonical checkout. These
 * rows need a second *project* for the bindings to be scoped by, and nothing about a repository.
 */
const registerBareProject = (
  harness: ReturnType<typeof makeHarness>,
  projectId: string,
): string => {
  const manifest = fixtureManifest(projectId);
  const project = harness.cp.projects.register({
    projectId,
    name: "fixture",
    manifest,
    authorization: harness.cp.manifestAuthorizationForTests(manifest),
  });
  if (!project.allowed) throw new Error(`project registration failed: ${project.message}`);
  return projectId;
};

const ctoSession = (
  harness: ReturnType<typeof makeHarness>,
  projectIds: readonly string[],
  buzzActorId: string,
): { sessionId: string } => {
  const session = harness.cp.sessions.create({ provider: "scripted", model: "scripted-cto" });
  expect(
    harness.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test").reasonCode,
  ).toBe(ReasonCode.OK);
  for (const projectId of projectIds) {
    const bound = harness.cp.bindings.bind({
      role: Role.PRIMARY_CTO,
      sessionId: session.sessionId,
      projectId,
    });
    if (!bound.allowed) throw new Error(`CTO binding failed: ${bound.message}`);
  }
  const actor = harness.cp.sessions.bindBuzzActor(
    { sessionId: session.sessionId, sessionSecret: session.sessionSecret!, buzzActorId },
    anyBuzzActorIsAuthenticated,
  );
  if (!actor.allowed) throw new Error(`buzz actor binding failed: ${actor.message}`);
  return { sessionId: session.sessionId };
};

describe("the Buzz collaboration authority", () => {
  it("derives the sender's role from its own live binding and grants the CTO-to-CEO relation", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness);
    ctoSession(harness, [projectId], "npub-cto");
    bindCeo(harness);
    const authority = buzzCollaborationAuthority(harness.cp);

    expect(authority.senderRoleFor("npub-cto")).toBe(roleKeyFor(Role.PRIMARY_CTO, { projectId }));

    const granted = authority.admitRelation({
      senderRoleKey: roleKeyFor(Role.PRIMARY_CTO, { projectId }),
      targetRoleKey: roleKeyFor(Role.CEO),
      conversation: ROOM,
    });
    if (!granted.allowed) throw new Error(`expected a grant, got ${granted.message}`);
    // Null rather than the sender's project: the CEO's binding carries none, so this pair is not
    // scoped by one and reporting the sender's would be reporting a scope the relation did not use.
    expect(granted.value.projectId).toBeNull();
    expect(granted.value.targetGeneration).toBe(
      harness.cp.bindings.active(roleKeyFor(Role.CEO))!.bindingGeneration,
    );
  });

  it("answers no role for an identity holding two, for an unbound one, and for a dead session", async () => {
    const harness = makeHarness();
    const first = await registerFixtureProject(harness, "fixture-project-a");
    const second = { projectId: registerBareProject(harness, "fixture-project-b") };
    // One session, two projects: addressable by neither rule, so it speaks by neither. A `find`
    // here would hand it the union of two projects' grants.
    ctoSession(harness, [first.projectId, second.projectId], "npub-cto-of-two");
    const bare = harness.cp.sessions.create({ provider: "scripted", model: "scripted-bare" });
    harness.cp.sessions.transition(bare.sessionId, SessionLifecycle.READY, "test");
    harness.cp.sessions.bindBuzzActor(
      { sessionId: bare.sessionId, sessionSecret: bare.sessionSecret!, buzzActorId: "npub-bare" },
      anyBuzzActorIsAuthenticated,
    );
    const authority = buzzCollaborationAuthority(harness.cp);

    expect(authority.senderRoleFor("npub-cto-of-two")).toBeNull();
    // A live session holding no role at all, which is the case a `buzz_actor_id` lookup alone
    // would have admitted.
    expect(authority.senderRoleFor("npub-bare")).toBeNull();
    expect(authority.senderRoleFor("npub-nobody")).toBeNull();
    expect(authority.senderRoleFor("   ")).toBeNull();
  });

  it("refuses the reverse direction, which no relation grants", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness);
    ctoSession(harness, [projectId], "npub-cto");
    bindCeo(harness);
    const authority = buzzCollaborationAuthority(harness.cp);

    const refused = authority.admitRelation({
      senderRoleKey: roleKeyFor(Role.CEO),
      targetRoleKey: roleKeyFor(Role.PRIMARY_CTO, { projectId }),
      conversation: ROOM,
    });
    if (refused.allowed) throw new Error("expected a refusal");
    expect(refused.reasonCode).toBe(ReasonCode.INGRESS_RELATION_NOT_PERMITTED);
    expect(refused.message).toContain("grants no collaboration");
  });

  it("refuses a sender whose assignment was revoked after its role was derived", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness);
    ctoSession(harness, [projectId], "npub-cto");
    bindCeo(harness);
    const authority = buzzCollaborationAuthority(harness.cp);

    // The window #674's ordering creates: the role is derived before the replay slot is spent and
    // before the `p` tag is resolved, so the assignment can go away before the relation is judged.
    const senderRoleKey = authority.senderRoleFor("npub-cto");
    expect(senderRoleKey).toBe(roleKeyFor(Role.PRIMARY_CTO, { projectId }));
    const revoked = harness.cp.bindings.revoke(senderRoleKey!, "test");
    expect(revoked.allowed).toBe(true);

    const refused = authority.admitRelation({
      senderRoleKey: senderRoleKey!,
      targetRoleKey: roleKeyFor(Role.CEO),
      conversation: ROOM,
    });
    if (refused.allowed) throw new Error("expected a refusal");
    expect(refused.reasonCode).toBe(ReasonCode.INGRESS_RELATION_NOT_PERMITTED);
    expect(refused.message).toContain("sending role no longer holds");
  });

  it("reports the target's generation as it is when the relation is judged, not as it was", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness);
    ctoSession(harness, [projectId], "npub-cto");
    bindCeo(harness);
    const authority = buzzCollaborationAuthority(harness.cp);
    const before = harness.cp.bindings.active(roleKeyFor(Role.CEO))!.bindingGeneration;

    // Rebind the CEO: the generation moves, and a grant carrying the old one would let a receipt
    // from the previous generation satisfy the delivery-time fence.
    expect(harness.cp.bindings.revoke(roleKeyFor(Role.CEO), "test").allowed).toBe(true);
    bindCeo(harness);
    const after = harness.cp.bindings.active(roleKeyFor(Role.CEO))!.bindingGeneration;
    expect(after).toBeGreaterThan(before);

    const granted = authority.admitRelation({
      senderRoleKey: roleKeyFor(Role.PRIMARY_CTO, { projectId }),
      targetRoleKey: roleKeyFor(Role.CEO),
      conversation: ROOM,
    });
    if (!granted.allowed) throw new Error(`expected a grant, got ${granted.message}`);
    expect(granted.value.targetGeneration).toBe(after);
  });

  it("refuses a target that no longer holds a binding at all", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness);
    ctoSession(harness, [projectId], "npub-cto");
    bindCeo(harness);
    const authority = buzzCollaborationAuthority(harness.cp);
    expect(harness.cp.bindings.revoke(roleKeyFor(Role.CEO), "test").allowed).toBe(true);

    const refused = authority.admitRelation({
      senderRoleKey: roleKeyFor(Role.PRIMARY_CTO, { projectId }),
      targetRoleKey: roleKeyFor(Role.CEO),
      conversation: ROOM,
    });
    if (refused.allowed) throw new Error("expected a refusal");
    expect(refused.reasonCode).toBe(ReasonCode.INGRESS_RELATION_NOT_PERMITTED);
    expect(refused.message).toContain("addressed role no longer holds");
  });

  it("refuses a project-scoped pair from different projects, and admits one from the same", async () => {
    const harness = makeHarness();
    const first = await registerFixtureProject(harness, "fixture-project-a");
    const second = { projectId: registerBareProject(harness, "fixture-project-b") };
    ctoSession(harness, [first.projectId], "npub-cto-a");
    ctoSession(harness, [second.projectId], "npub-cto-b");
    // A relation both of whose sides carry a project, which the production table never produces —
    // see the parameter's docstring. Without this the same-project comparison is unreachable.
    const authority = buzzCollaborationAuthority(
      harness.cp,
      new Map([[Role.PRIMARY_CTO, [Role.PRIMARY_CTO] as readonly Role[]]]),
    );

    const across = authority.admitRelation({
      senderRoleKey: roleKeyFor(Role.PRIMARY_CTO, { projectId: first.projectId }),
      targetRoleKey: roleKeyFor(Role.PRIMARY_CTO, { projectId: second.projectId }),
      conversation: ROOM,
    });
    if (across.allowed) throw new Error("expected a refusal across projects");
    expect(across.reasonCode).toBe(ReasonCode.INGRESS_RELATION_NOT_PERMITTED);
    expect(across.message).toContain("different projects");

    // The control: the same call within one project is granted, and reports that project rather
    // than null. Without it, a refusal that rejected every pair would pass the row above.
    const within = authority.admitRelation({
      senderRoleKey: roleKeyFor(Role.PRIMARY_CTO, { projectId: first.projectId }),
      targetRoleKey: roleKeyFor(Role.PRIMARY_CTO, { projectId: first.projectId }),
      conversation: ROOM,
    });
    if (!within.allowed) throw new Error(`expected a grant, got ${within.message}`);
    expect(within.value.projectId).toBe(first.projectId);
  });

  it("scopes a pair by the room alone when the sending role carries no project", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness);
    ctoSession(harness, [projectId], "npub-cto");
    bindCeo(harness);
    // The unscoped *sender*. The production table never grants it — `CEO` addresses nobody — so
    // this row is the only way the branch is reached, and without it a reader could not tell the
    // branch from dead code. The CTO-to-CEO case above reaches the other unscoped branch, where
    // the sender has a project and the target does not.
    const authority = buzzCollaborationAuthority(
      harness.cp,
      new Map([[Role.CEO, [Role.PRIMARY_CTO] as readonly Role[]]]),
    );

    const granted = authority.admitRelation({
      senderRoleKey: roleKeyFor(Role.CEO),
      targetRoleKey: roleKeyFor(Role.PRIMARY_CTO, { projectId }),
      conversation: ROOM,
    });
    if (!granted.allowed) throw new Error(`expected a grant, got ${granted.message}`);
    expect(granted.value.projectId).toBeNull();
    // The target is the scoped side here, and its generation is still the one reported.
    expect(granted.value.targetGeneration).toBe(
      harness.cp.bindings.activePrimaryCto(projectId)!.bindingGeneration,
    );
  });

  it("refuses an envelope that names no room", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness);
    ctoSession(harness, [projectId], "npub-cto");
    bindCeo(harness);
    const authority = buzzCollaborationAuthority(harness.cp);

    const refused = authority.admitRelation({
      senderRoleKey: roleKeyFor(Role.PRIMARY_CTO, { projectId }),
      targetRoleKey: roleKeyFor(Role.CEO),
      conversation: "",
    });
    if (refused.allowed) throw new Error("expected a refusal");
    expect(refused.reasonCode).toBe(ReasonCode.INGRESS_RELATION_NOT_PERMITTED);
    expect(refused.message).toContain("named room");
  });
});
