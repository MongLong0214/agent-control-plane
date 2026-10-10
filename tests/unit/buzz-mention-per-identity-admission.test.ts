import { afterAll, describe, expect, it } from "vitest";

import {
  type BuzzMentionAdmission,
  type BuzzMentionAdmissionChange,
  type BuzzMentionEvent,
  type BuzzMentionRegistry,
  type BuzzMentionRoleBinding,
  type BuzzMentionSink,
  startBuzzMentionSubscriberFromStateDir,
} from "../../src/buzz/buzz-mention-subscriber.ts";
import {
  channelKey,
  type ChannelKey,
  movableRegistry,
  type MovableRegistry,
  seamSink,
  type SeamSink,
  signedMention,
  steppedClock,
  type SteppedClock,
  storingRelay,
  type StoringRelay,
  writeSubscriberConfig,
} from "../helpers/buzz-mention-relay.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * Buzz mention subscriber admission is per identity.
 *
 * Measured live: the owner paused the Logic Pro MCP CTO, its identity lost its live PRIMARY_CTO
 * binding, and the daemon refused the whole subscriber with "identities[0] does not currently hold a
 * live PRIMARY_CTO binding". repo-factory's and CommitLore's CTOs, both bound, then received no
 * automatic mention wake and fell back to polling. Every row here runs three identities through one
 * subscriber against a relay that stores what it is sent, so "unconsumed" is a statement about what
 * was asked for, and "no duplicate execution" is the replay authority's answer, not this module's.
 */

const ROOMS = { logic: "room-logic", repoFactory: "room-repo-factory", commitlore: "room-commitlore" } as const;
type Cto = keyof typeof ROOMS;
const ROLE: Record<Cto, string> = {
  logic: "PRIMARY_CTO:logic-pro-mcp",
  repoFactory: "PRIMARY_CTO:repo-factory",
  commitlore: "PRIMARY_CTO:commitlore",
};
const ORDER: readonly Cto[] = ["logic", "repoFactory", "commitlore"];

const bindingOf = (cto: Cto, key: ChannelKey, generation = 1, sessionId = `${cto}-session-${generation}`): BuzzMentionRoleBinding => ({
  roleKey: ROLE[cto],
  buzzActorId: key.pubkey,
  bindingGeneration: generation,
  sessionId,
});

interface Deployment {
  keys: Record<Cto, ChannelKey>;
  owner: ChannelKey;
  relay: StoringRelay;
  clock: SteppedClock;
  registry: MovableRegistry;
  sink: SeamSink;
  changes: BuzzMentionAdmissionChange[];
  handle: ReturnType<typeof startBuzzMentionSubscriberFromStateDir>;
  mention(to: Cto, createdAt: number, text: string): BuzzMentionEvent;
}

/** Three canonical CTO identities, each in its own room; `bound` says which hold a live binding. */
const deploy = (
  bound: readonly Cto[],
  options: {
    sink?: BuzzMentionSink;
    registry?: (keys: Record<Cto, ChannelKey>, held: MovableRegistry) => BuzzMentionRegistry;
  } = {},
): Deployment => {
  const dir = tempDir("acp-buzz-per-identity-");
  const keys = {
    logic: channelKey(dir, "logic.key"),
    repoFactory: channelKey(dir, "repo-factory.key"),
    commitlore: channelKey(dir, "commitlore.key"),
  };
  const owner = channelKey(dir, "owner.key");
  writeSubscriberConfig(dir, ORDER.map((cto) => ({ keyFile: keys[cto].keyFile, rooms: [ROOMS[cto]] })));
  const relay = storingRelay();
  const clock = steppedClock();
  const registry = movableRegistry();
  for (const cto of bound) registry.hold(keys[cto].pubkey, bindingOf(cto, keys[cto]));
  const sink = seamSink();
  const changes: BuzzMentionAdmissionChange[] = [];
  const handle = startBuzzMentionSubscriberFromStateDir(dir, {
    registry: options.registry?.(keys, registry) ?? registry,
    sink: options.sink ?? sink,
    openSocket: relay.factory,
    scheduler: clock.scheduler,
    reportAdmission: (change) => changes.push(change),
    reportRoleNotHeld: () => undefined,
  });
  return {
    keys,
    owner,
    relay,
    clock,
    registry,
    sink,
    changes,
    handle,
    mention: (to, createdAt, text) =>
      signedMention({ author: owner.secretKey, addressedTo: keys[to].pubkey, room: ROOMS[to], createdAt, text }),
  };
};

const executedIds = (sink: SeamSink): string[] => sink.executions().map((call) => call.eventId);

describe("with the Logic identity excluded for want of a live binding", () => {
  it("still delivers repo-factory's and CommitLore's mentions, and leaves Logic's unconsumed until it is admitted", async () => {
    const d = deploy(["repoFactory", "commitlore"]);
    try {
      await d.relay.drain(d.handle);
      expect(d.relay.openFor(d.keys.repoFactory.pubkey)).toHaveLength(1);
      expect(d.relay.openFor(d.keys.commitlore.pubkey)).toHaveLength(1);
      expect(d.relay.openFor(d.keys.logic.pubkey)).toHaveLength(0);

      const toRepoFactory = d.mention("repoFactory", 1_800_000_010, "repo-factory, status");
      const toCommitlore = d.mention("commitlore", 1_800_000_011, "CommitLore, status");
      const toLogic = d.mention("logic", 1_800_000_012, "Logic, status");
      for (const event of [toRepoFactory, toCommitlore, toLogic]) d.relay.publish(event);
      await d.relay.drain(d.handle);

      expect(d.sink.executions().map((call) => [call.eventId, call.roleKey])).toEqual([
        [toRepoFactory.id, ROLE.repoFactory],
        [toCommitlore.id, ROLE.commitlore],
      ]);
      // Unconsumed: nothing ever asked the relay for Logic's mail, and the seam never saw it.
      expect(d.relay.requested.map((request) => request.pubkey)).not.toContain(d.keys.logic.pubkey);
      expect(d.sink.calls.map((call) => call.eventId)).not.toContain(toLogic.id);
      // The judgement timer keeps asking; while the binding is still absent it opens nothing.
      d.clock.fireAll();
      await d.relay.drain(d.handle);
      expect(d.relay.openFor(d.keys.logic.pubkey)).toHaveLength(0);

      // Logic is claimed again. Its message was waiting on the relay and is delivered now, to it.
      d.registry.hold(d.keys.logic.pubkey, bindingOf("logic", d.keys.logic, 2));
      d.handle.rejudge();
      await d.relay.drain(d.handle);
      expect(d.sink.executions().map((call) => [call.eventId, call.roleKey])).toEqual([
        [toRepoFactory.id, ROLE.repoFactory],
        [toCommitlore.id, ROLE.commitlore],
        [toLogic.id, ROLE.logic],
      ]);
    } finally {
      d.handle.close();
    }
  });

  it("admits Logic on the judgement timer when its binding returns with no switch to announce it", async () => {
    const d = deploy(["repoFactory", "commitlore"]);
    try {
      await d.relay.drain(d.handle);
      const toLogic = d.mention("logic", 1_800_000_020, "Logic, waiting");
      d.relay.publish(toLogic);
      // A session that takes its channel identity after its binding publishes no switch; only the
      // subscriber's own schedule notices it.
      d.registry.hold(d.keys.logic.pubkey, bindingOf("logic", d.keys.logic));
      expect(d.relay.openFor(d.keys.logic.pubkey)).toHaveLength(0);
      d.clock.fireAll();
      await d.relay.drain(d.handle);
      expect(d.relay.openFor(d.keys.logic.pubkey)).toHaveLength(1);
      expect(executedIds(d.sink)).toEqual([toLogic.id]);
      expect(d.changes.map((change) => `${change.identity}:${change.state}`)).toEqual([
        "identities[0]:EXCLUDED",
        "identities[0]:ADMITTED",
      ]);
    } finally {
      d.handle.close();
    }
  });

  it("reports the exclusion once, by ordinal and reason, and is silent about the identities it admitted", async () => {
    const d = deploy(["repoFactory", "commitlore"]);
    try {
      d.clock.fireAll();
      d.handle.rejudge();
      d.clock.fireAll();
      await d.relay.drain(d.handle);
      expect(d.changes).toEqual([
        {
          identity: "identities[0]",
          identityPubkey: d.keys.logic.pubkey,
          state: "EXCLUDED",
          reason: "NO_LIVE_PRIMARY_CTO_BINDING",
          roleKey: null,
        },
      ]);
    } finally {
      d.handle.close();
    }
  });

  it("excludes only the identity whose registry answer cannot be verified, and starts the others", async () => {
    const d = deploy(["repoFactory", "commitlore"], {
      registry: (keys, held) => ({
        primaryCtoBindingFor: (pubkey) => {
          if (pubkey === keys.logic.pubkey) throw new Error("registry read failed");
          return held.primaryCtoBindingFor(pubkey);
        },
      }),
    });
    try {
      await d.relay.drain(d.handle);
      expect(d.handle.admission().identities.map((one) => [one.identity, one.state, one.reason])).toEqual([
        ["identities[0]", "EXCLUDED", "BINDING_UNVERIFIABLE"],
        ["identities[1]", "ADMITTED", null],
        ["identities[2]", "ADMITTED", null],
      ]);
      expect(d.relay.openFor(d.keys.repoFactory.pubkey)).toHaveLength(1);
      expect(d.relay.openFor(d.keys.commitlore.pubkey)).toHaveLength(1);
    } finally {
      d.handle.close();
    }
  });
});

describe("re-judgement of the admitted set", () => {
  it("leaves a role with the identity already admitted for it when a second identity is judged to hold it too", async () => {
    const d = deploy(["repoFactory"]);
    try {
      await d.relay.drain(d.handle);
      // Not a state a consistent registry reaches; the rule is that the holder keeps the role and
      // the later claimant is excluded, rather than two connections racing for one role's mail.
      d.registry.hold(d.keys.commitlore.pubkey, { ...bindingOf("repoFactory", d.keys.commitlore), buzzActorId: d.keys.commitlore.pubkey });
      d.handle.rejudge();
      await d.relay.drain(d.handle);
      expect(d.handle.admission().identities.map((one) => [one.identity, one.state, one.reason])).toEqual([
        ["identities[0]", "EXCLUDED", "NO_LIVE_PRIMARY_CTO_BINDING"],
        ["identities[1]", "ADMITTED", null],
        ["identities[2]", "EXCLUDED", "ROLE_HELD_BY_ANOTHER_IDENTITY"],
      ]);
      expect(d.relay.openFor(d.keys.commitlore.pubkey)).toHaveLength(0);
    } finally {
      d.handle.close();
    }
  });
});

describe("re-judgement right before delivery", () => {
  it("refuses delivery after a revoke, and after a re-claim delivers only to the new binding", async () => {
    const d = deploy(["repoFactory"]);
    try {
      await d.relay.drain(d.handle);
      const before = d.mention("repoFactory", 1_800_000_100, "before the revoke");
      d.relay.publish(before);
      await d.relay.drain(d.handle);
      expect(d.sink.executions().map((call) => call.binding)).toEqual([
        { bindingGeneration: 1, sessionId: "repoFactory-session-1" },
      ]);

      // Revoked. A mention pushed on the still-open connection reaches no sink.
      d.registry.hold(d.keys.repoFactory.pubkey, null);
      const during = d.mention("repoFactory", 1_800_000_200, "while revoked");
      d.relay.publish(during);
      await d.relay.drain(d.handle);
      expect(d.sink.calls.map((call) => call.eventId)).toEqual([before.id]);

      // Judgement takes the connection away and keeps it away while the binding is absent.
      d.handle.rejudge();
      d.clock.fireAll();
      await d.relay.drain(d.handle);
      expect(d.relay.openFor(d.keys.repoFactory.pubkey)).toHaveLength(0);
      expect(d.handle.admission().identities[1]).toMatchObject({ state: "EXCLUDED", roleKey: ROLE.repoFactory });

      // Re-claimed by another session at the next generation.
      d.registry.hold(d.keys.repoFactory.pubkey, bindingOf("repoFactory", d.keys.repoFactory, 2, "repoFactory-session-new"));
      d.handle.rejudge();
      await d.relay.drain(d.handle);

      const afterRevoke = d.sink.calls.slice(1);
      expect(afterRevoke.length).toBeGreaterThan(0);
      for (const call of afterRevoke) {
        expect(call.binding).toEqual({ bindingGeneration: 2, sessionId: "repoFactory-session-new" });
      }
      expect(d.sink.executions().map((call) => [call.eventId, call.binding?.bindingGeneration])).toEqual([
        [before.id, 1],
        [during.id, 2],
      ]);
    } finally {
      d.handle.close();
    }
  });

  it("names the binding read immediately before delivery when the role moved under a live connection", async () => {
    const d = deploy(["repoFactory"]);
    try {
      await d.relay.drain(d.handle);
      d.relay.publish(d.mention("repoFactory", 1_800_000_300, "first"));
      await d.relay.drain(d.handle);
      // A session change with no re-judgement in between: the connection stays, and the delivery
      // is judged again before the sink is called.
      d.registry.hold(d.keys.repoFactory.pubkey, bindingOf("repoFactory", d.keys.repoFactory, 3, "repoFactory-session-3"));
      d.relay.publish(d.mention("repoFactory", 1_800_000_301, "second"));
      await d.relay.drain(d.handle);
      expect(d.sink.calls.map((call) => call.binding)).toEqual([
        { bindingGeneration: 1, sessionId: "repoFactory-session-1" },
        { bindingGeneration: 3, sessionId: "repoFactory-session-3" },
      ]);
    } finally {
      d.handle.close();
    }
  });
});

describe("a reconfiguration boundary", () => {
  it("loses no event, executes none twice and delivers none to the wrong target", async () => {
    const d = deploy(["repoFactory", "commitlore"]);
    try {
      await d.relay.drain(d.handle);
      const a1 = d.mention("repoFactory", 1_800_001_000, "a1");
      const b1 = d.mention("commitlore", 1_800_001_001, "b1");
      d.relay.publish(a1);
      d.relay.publish(b1);
      await d.relay.drain(d.handle);

      // repo-factory leaves the admitted set; CommitLore stays.
      d.registry.hold(d.keys.repoFactory.pubkey, null);
      d.handle.rejudge();
      const a2 = d.mention("repoFactory", 1_800_001_100, "a2, sent while excluded");
      const b2 = d.mention("commitlore", 1_800_001_101, "b2");
      d.relay.publish(a2);
      d.relay.publish(b2);
      await d.relay.drain(d.handle);
      expect(executedIds(d.sink)).toEqual([a1.id, b1.id, b2.id]);

      // And rejoins under a new generation.
      d.registry.hold(d.keys.repoFactory.pubkey, bindingOf("repoFactory", d.keys.repoFactory, 2));
      d.handle.rejudge();
      await d.relay.drain(d.handle);

      // The window was kept, not reset: the rejoining connection asks from a1's second, inclusive,
      // so a1 comes back and the seam refuses it; a2 is new and is the one execution added.
      const asked = d.relay.requested.filter((request) => request.pubkey === d.keys.repoFactory.pubkey);
      expect(asked.map((request) => request.filter["since"])).toEqual([undefined, a1.created_at]);
      expect(executedIds(d.sink)).toEqual([a1.id, b1.id, b2.id, a2.id]);
      expect(new Set(executedIds(d.sink)).size).toBe(executedIds(d.sink).length);
      expect(d.sink.calls.filter((call) => call.eventId === a1.id).map((call) => call.answer)).toEqual([
        "DURABLE",
        "ALREADY_DURABLE",
      ]);
      for (const call of d.sink.calls) {
        const addressee = [a1, a2].some((event) => event.id === call.eventId) ? "repoFactory" : "commitlore";
        expect(call.roleKey).toBe(ROLE[addressee]);
        expect(call.identityPubkey).toBe(d.keys[addressee].pubkey);
      }
      expect(d.sink.executions().find((call) => call.eventId === a2.id)?.binding?.bindingGeneration).toBe(2);
    } finally {
      d.handle.close();
    }
  });

  it("does not move the window on an admission still in flight when its identity is excluded", async () => {
    // The seam answers the first admission of a1 only when the test releases it.
    const inner = seamSink();
    let release: () => void = () => undefined;
    let gated = true;
    const gate: BuzzMentionSink = {
      admit: async (request): Promise<BuzzMentionAdmission> => {
        if (gated) {
          gated = false;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return (await inner.admit(request)) as BuzzMentionAdmission;
      },
    };
    const d = deploy(["repoFactory"], { sink: gate });
    try {
      await d.relay.drain(d.handle);
      const a1 = d.mention("repoFactory", 1_800_002_000, "in flight");
      d.relay.publish(a1);
      await new Promise<void>((resolve) => setImmediate(resolve));

      d.registry.hold(d.keys.repoFactory.pubkey, null);
      d.handle.rejudge();
      release();
      await d.relay.drain(d.handle);

      d.registry.hold(d.keys.repoFactory.pubkey, bindingOf("repoFactory", d.keys.repoFactory, 2));
      d.handle.rejudge();
      await d.relay.drain(d.handle);

      // The in-flight answer belonged to a connection that is gone, so it set no window: the
      // rejoining connection asks from where the old one had reached (EOSE, before a1), gets a1
      // again, and the seam refuses the replay. One execution, and nothing skipped.
      const asked = d.relay.requested.map((request) => request.filter["since"]);
      expect(asked).toEqual([undefined, 0]);
      expect(inner.calls.map((call) => [call.eventId, call.answer])).toEqual([
        [a1.id, "DURABLE"],
        [a1.id, "ALREADY_DURABLE"],
      ]);
    } finally {
      d.handle.close();
    }
  });
});

describe("health", () => {
  it("shows the partial state and each exclusion's reason, and never reads a configured count as continuity", async () => {
    const d = deploy(["repoFactory", "commitlore"]);
    try {
      await d.relay.drain(d.handle);
      const health = d.handle.counters().admission;
      expect(d.handle.socketCount).toBe(3);
      expect(health).toMatchObject({ continuity: "PARTIAL", configuredIdentities: 3, admittedIdentities: 2 });
      expect(health?.identities.map((one) => [one.identity, one.state, one.reason, one.roleKey])).toEqual([
        ["identities[0]", "EXCLUDED", "NO_LIVE_PRIMARY_CTO_BINDING", null],
        ["identities[1]", "ADMITTED", null, ROLE.repoFactory],
        ["identities[2]", "ADMITTED", null, ROLE.commitlore],
      ]);
      expect(health?.identities[0]?.excludedSinceSeconds).toBe(1_900_000_000);

      d.registry.hold(d.keys.logic.pubkey, bindingOf("logic", d.keys.logic));
      d.handle.rejudge();
      expect(d.handle.admission()).toMatchObject({ continuity: "FULL", admittedIdentities: 3 });
    } finally {
      d.handle.close();
    }
  });

  it("carries a judging registry's own reason, and this module's room and project checks", async () => {
    const d = deploy([], {
      registry: (keys) => ({
        primaryCtoBindingFor: () => null,
        judgeIdentity: (pubkey) => {
          if (pubkey === keys.logic.pubkey) return { verdict: "EXCLUDED", reason: "SESSION_NOT_LIVE" };
          if (pubkey === keys.repoFactory.pubkey) {
            return { verdict: "ADMITTED", binding: { ...bindingOf("repoFactory", keys.repoFactory), room: ROOMS.logic } };
          }
          return { verdict: "ADMITTED", binding: { ...bindingOf("commitlore", keys.commitlore), projectId: "repo-factory" } };
        },
      }),
    });
    try {
      expect(d.handle.admission().identities.map((one) => one.reason)).toEqual([
        "SESSION_NOT_LIVE",
        "ROOM_NOT_SUBSCRIBED",
        "PROJECT_MISMATCH",
      ]);
      expect(d.handle.admission().continuity).toBe("NONE");
      expect(d.relay.connections).toEqual([]);
    } finally {
      d.handle.close();
    }
  });
});
