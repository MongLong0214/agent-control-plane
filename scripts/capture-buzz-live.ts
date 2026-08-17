/**
 * #243 / #423 — live Buzz delivery and ACK capture.
 *
 * Runs the *production* path against the real relay: `BuzzCliTransport` driving the installed
 * `buzz` CLI, `BuzzAdapter.deliverPending` draining a real outbox claim, and the envelope read
 * back off the relay to prove it arrived intact. Nothing here is doubled — that is the whole
 * point, since #423 was two wrong assumptions that only a double could agree with.
 *
 * Usage (BUZZ_PRIVATE_KEY and BUZZ_RELAY_URL must be in the environment):
 *   npx tsx scripts/capture-buzz-live.ts <out.json>
 *
 * Not `node --experimental-strip-types`: strip-only mode rejects the parameter property in
 * `BuzzCliTransport`'s constructor (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`), so the documented
 * command stopped working when that class gained one. An operator following this comment met
 * a syntax error before reaching anything this capture is about.
 *
 * Creates its own ephemeral channel and deletes it on the way out, so the capture never
 * writes into an owner room and leaves no room behind that a later purpose could resolve to.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

import { BuzzAdapter, BuzzCliTransport } from "../src/buzz/buzz-adapter.ts";

import { configuredBuzzActorIngressPolicy } from "../src/daemon/agentcpd.ts";
import { ManualClock } from "../src/core/clock.ts";
import { newRunId } from "../src/core/ids.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../src/domain/types.ts";
import {
  BuzzActorIngress,
  IngressGuard,
  buzzActorBindingSigningRequest,
  ingressSignature,
} from "../src/ingress/ingress-guard.ts";
import { MessageKind } from "../src/outbox/envelope.ts";
import { makeCore, makeRepo, seedRun } from "../tests/helpers/fixtures.ts";
import { makeHarness, registerFixtureProject } from "../tests/helpers/harness.ts";

const out = process.argv[2] ?? "evidence/p0-09-buzz-live-delivery.json";
const binary = process.env["ACP_BUZZ_BINARY"] ?? "buzz";

/**
 * The relay has to be named, not defaulted.
 *
 * `buzz --help` documents `BUZZ_RELAY_URL [default: http://localhost:3000]`, and the CLI inherits
 * this process's environment, so leaving it unset does not mean "no relay" — it means localhost.
 * A capture that ran that way and passed would have measured a loopback relay while its own
 * `measured.relay` said `production`, because that field used to be a hardcoded string.
 *
 * The 2026-08-17 run is what surfaced it: `relay: "(default)"` next to `measured.relay:
 * "production"` in one artifact, contradicting each other. It failed for an unrelated reason
 * (`relay error 400: Client sent an HTTP request to an HTTPS server` — the loopback default
 * against a TLS relay), so the contradiction never had to be believed. That was luck, not a check.
 */
const relayUrl = process.env["BUZZ_RELAY_URL"];
if (!relayUrl) {
  console.error(
    "BUZZ_RELAY_URL is not set. The buzz CLI would fall back to http://localhost:3000 and this\n" +
      "capture would describe a loopback relay while claiming a production one. Set it to the\n" +
      "relay this capture is supposed to be about (docs/HANDOFF-20260814.md records the URL).",
  );
  process.exit(1);
}
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const channelName = `acp-verify-${stamp.slice(0, 19)}`;

const cli = (...argv: string[]): string =>
  execFileSync(binary, argv, { encoding: "utf8", timeout: 30_000 });

/**
 * A call whose *rejection* is the observation — the #423 counterexample, where the point is
 * that the installed CLI refuses an argv the adapter must therefore not build.
 *
 * `execFileSync` lets the child's stderr through to this process's stderr by default, so the
 * caught, expected rejection still printed the CLI's error text mid-run:
 *
 *     {"error":"user_error","message":"error: unexpected argument '--json' found ...
 *
 * A reader watching the capture sees a CLI error and a stopped-looking run. On 2026-08-17 that
 * is exactly what happened: the probe was read as the harness crashing on its own bad argv, and
 * the conclusion drawn was that this capture had never been runnable. It had; this line is a
 * `try`/`catch` that records `jsonFlagRejected` and continues.
 *
 * So the stderr is captured rather than inherited. The recorded fact is unchanged — deleting the
 * probe to quiet it would throw away the evidence that the flag is refused.
 */
const cliRejects = (...argv: string[]): boolean => {
  try {
    execFileSync(binary, argv, {
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return false;
  } catch {
    return true;
  }
};

const record: Record<string, unknown> = {
  capture: "P0-09/#243 live Buzz delivery and ACK against the production relay",
  capturedAt: new Date().toISOString(),
  relay: relayUrl,
  cliPath: execFileSync("which", [binary], { encoding: "utf8" }).trim(),
  // What this capture did and did not measure. Written into the record because a reader who
  // finds a `doctor` block here will otherwise take it for a statement about the deployment,
  // and three separate readings did exactly that: a `TRUSTED_GATE_CREDENTIAL_MISSING` finding
  // was read as the host lacking a GitHub App credential, which it has.
  //
  // The mix is deliberate. The transport, relay and ingress policy have to be the real ones or
  // the capture proves nothing; the control plane does not, and making it real would mean a
  // delivery capture reading and writing deployment state.
  measured: {
    // Derived, never asserted. This block exists to stop a reader taking the capture for more
    // than it measured — the comment above records three readings that did — so a field in it
    // that states `production` regardless of which relay was contacted is the one thing here
    // that must not be a literal.
    relay: relayUrl,
    transport: "installed buzz CLI",
    ingressPolicy: "the deployment's, via configuredBuzzActorIngressPolicy()",
    controlPlane: "in-memory test fixture (makeCore) — not the deployment",
    doctorScope:
      "the fixture control plane, so its findings describe that core and not this host; " +
      "deployment health belongs to #512, which brings a daemon up",
  },
};

/**
 * A wall-clock source shaped like the suite's ManualClock, so the fixtures accept it while
 * every timestamp it stamps is a real one.
 */
const liveClock = new (class extends ManualClock {
  override now(): Date { return new Date(); }
  override nowIso(): string { return new Date().toISOString(); }
})();

let channelId: string | null = null;
try {
  // ---------------------------------------------------------------- surface, live
  const transport = new BuzzCliTransport(binary);

  // With no purpose and no bound channel there is nothing this transport could open, and
  // it must say so rather than reporting healthy off a `--help` exit code.
  if (await transport.available()) {
    throw new Error("transport claimed availability with no purpose and no bound channel");
  }

  const liveChannels = JSON.parse(cli("channels", "list")) as Array<{
    channel_id: string;
    name: string;
  }>;
  record["surface"] = {
    channelsListArgv: ["channels", "list"],
    jsonFlagRejected: cliRejects("channels", "list", "--json"),
    identityField: Object.keys(liveChannels[0] ?? {}).includes("channel_id")
      ? "channel_id"
      : "MISSING",
    hasIdField: Object.hasOwn(liveChannels[0] ?? {}, "id"),
    availableWithoutPurposeOrBoundChannel: false,
  };

  // ---------------------------------------------------------------- own channel
  const created = JSON.parse(
    cli(
      "channels",
      "create",
      "--name",
      channelName,
      "--type",
      "stream",
      "--visibility",
      "private",
      "--description",
      "ACP #243 live delivery verification — ephemeral, archives itself",
      "--ttl",
      "3600",
    ),
  ) as { channel_id: string };
  channelId = created.channel_id;

  // Resolution goes through the production code path, by purpose, against the live list.
  const resolved = await transport.openChannel(`cto:${channelName}`);
  if (resolved !== channelId) {
    throw new Error(`openChannel resolved ${resolved}, expected ${channelId}`);
  }
  let refusedPurpose: string | null = null;
  try {
    await transport.openChannel(`cto:${channelName}-not-a-real-room`);
  } catch (err) {
    refusedPurpose = (err as Error).message;
  }
  if (!refusedPurpose) throw new Error("an unmatched purpose was not refused");

  // Now there is a channel a purpose resolves to, `available` can answer for that purpose —
  // and it answers by doing what `openChannel` does, against the live relay.
  const availableForPurpose = await transport.available(`cto:${channelName}`);
  if (!availableForPurpose) throw new Error("transport reported unavailable for a resolvable purpose");
  const availableForUnresolvable = await transport.available(`cto:${channelName}-not-a-real-room`);
  if (availableForUnresolvable) throw new Error("transport claimed availability for an unresolvable purpose");

  record["channelResolution"] = {
    createdChannel: channelId,
    availableForResolvablePurpose: availableForPurpose,
    availableForUnresolvablePurpose: availableForUnresolvable,
    resolvedByPurpose: `cto:${channelName}`,
    resolvedTo: resolved,
    unmatchedPurposeRefused: refusedPurpose,
  };

  // ---------------------------------------------------------------- real delivery
  // The system clock, not the suite's deterministic one. This capture writes to a real
  // relay, and an envelope stamped from a fixed domain clock lands next to a `created_at`
  // the relay wrote from wall time — evidence whose two halves cannot both be true. The
  // P0-14 gate canary shipped with exactly that defect (completed_at two days before its
  // own GitHub start); the default ManualClock here would have been seven months off.
  const core = makeCore({ clock: liveClock });
  seedRun({ db: core.db, clock: core.clock, repoPath: makeRepo() });
  const adapter = new BuzzAdapter(
    core.db,
    core.clock,
    core.audit,
    core.sessions,
    core.bindings,
    core.outbox,
    transport,
  );

  // A real session with its own secret, so the ACK below goes through the authenticated
  // writer path rather than a direct row insert.
  const session = core.sessions.create({ provider: "claude", model: "acp-live-capture" });
  const secret = session.sessionSecret;
  if (!secret) throw new Error("session registry issued no secret");
  const ready = core.sessions.transition(
    session.sessionId,
    SessionLifecycle.READY,
    "live capture runtime ready",
  );
  if (!ready.allowed) throw new Error(`session did not reach READY: ${ready.reason}`);

  const binding = core.bindings.bind({ role: Role.CEO, sessionId: session.sessionId });
  if (!binding.allowed) throw new Error(`role binding refused: ${binding.reason}`);

  const connected = await adapter.connect(session.sessionId, `cto:${channelName}`);
  if (!connected.allowed) throw new Error(`connect refused: ${connected.reason}`);
  if (connected.value !== channelId) {
    throw new Error(`connect bound ${connected.value}, expected ${channelId}`);
  }

  const runId = newRunId();
  const enqueued = core.outbox.enqueue({
    idempotencyKey: `outbox:live:${stamp}`,
    roleKey: binding.value.roleKey,
    bindingGeneration: binding.value.bindingGeneration,
    targetSessionId: session.sessionId,
    kind: MessageKind.RUN_DISPATCH,
    payload: { runId, capture: "p0-09-live", nonce: stamp },
  });
  if (!enqueued.allowed) throw new Error("enqueue refused");

  const delivered = await adapter.deliverPending();
  if (delivered.delivered.length !== 1 || delivered.failed.length !== 0) {
    throw new Error(`delivery did not settle cleanly: ${JSON.stringify(delivered)}`);
  }

  // ---------------------------------------------------------------- read it back
  const messages = await transport.readBack(channelId, 10);
  const landed = messages.find((m) => m.content.includes(enqueued.value.messageId));
  if (!landed) throw new Error("the delivered envelope was not found on the relay");
  if (!landed.content.includes(`bindingGeneration="${binding.value.bindingGeneration}"`)) {
    throw new Error("the envelope on the relay is missing its generation fence");
  }

  // P1-01: evidence whose halves disagree about when things happened is not evidence. The
  // relay stamps `created_at` from its own wall clock; every timestamp this capture writes
  // has to sit next to that coherently, or the record cannot be reconstructed later. This
  // check is what makes a deterministic clock impossible to reintroduce here silently.
  const relaySeconds = landed.created_at;
  const capturedSeconds = Math.floor(Date.parse(String(record["capturedAt"])) / 1000);
  const skewSeconds = Math.abs(relaySeconds - capturedSeconds);
  const envelopeExpiry = /expiresAt="([^"]+)"/.exec(landed.content)?.[1] ?? null;
  const expirySeconds = envelopeExpiry === null ? null : Math.floor(Date.parse(envelopeExpiry) / 1000);
  if (skewSeconds > 300) {
    throw new Error(
      `capture clock and relay clock disagree by ${skewSeconds}s — the evidence would be chronologically invalid`,
    );
  }
  if (expirySeconds === null || expirySeconds < relaySeconds) {
    throw new Error(
      `the envelope on the relay expired before the relay recorded it (expiresAt=${envelopeExpiry})`,
    );
  }

  record["clockCoherence"] = {
    relayCreatedAt: new Date(relaySeconds * 1000).toISOString(),
    captureClockSkewSeconds: skewSeconds,
    envelopeExpiresAt: envelopeExpiry,
    envelopeExpiresAfterRelayReceipt: true,
  };

  record["delivery"] = {
    messageId: enqueued.value.messageId,
    outboxStatus: core.outbox.get(enqueued.value.messageId)?.status,
    relayEventId: landed.id,
    relayPubkey: landed.pubkey,
    fenceOnRelay: {
      roleKey: binding.value.roleKey,
      bindingGeneration: binding.value.bindingGeneration,
      targetSessionId: session.sessionId,
    },
    envelopeBytesOnRelay: landed.content.length,
    readBackArgv: ["messages", "get", "--channel", channelId, "--limit", "10"],
  };

  // ---------------------------------------------------------------- ACK and refusal
  // Through the production ingress, not around it. An earlier version of this capture called
  // `sessions.bindBuzzActor` directly and supplied its own `isAllowedActor`, so "a different
  // actor is refused" was true only because that actor had no row — `resolveActor` returns
  // null for anything unbound, with or without an allowlist. That proved nothing, and it is
  // the exact shape of the defect this repository keeps finding in its own tests.
  //
  // Here the deployment's ingress policy names exactly one allowed actor, the binding is
  // HMAC-signed, and the refusal below is the guard's, on an actor that is otherwise
  // well-formed and correctly signed.
  // #243 — the deployment's policy, not one this script builds. The previous version generated
  // its own secret and allowlisted the identity it had just landed, which proved that
  // `IngressGuard` enforces whatever list it is handed. That was never the question. The
  // question is whether `agentcpd`'s configured policy would refuse the actor, and only the
  // policy `agentcpd` actually reads can answer it.
  const policy = configuredBuzzActorIngressPolicy();
  if (!policy) {
    throw new Error(
      "ACP_BUZZ_INGRESS_SECRET and ACP_BUZZ_ALLOWED_ACTORS are not configured, so there is no " +
        "deployment policy to capture. Configure them as agentcpd runs and re-run; a policy " +
        "invented here would prove nothing (#243).",
    );
  }
  if (!policy.allowedActors.includes(landed.pubkey)) {
    // Refusing rather than adding it. Amending the allowlist here would make the capture pass
    // against a policy the deployment does not hold, which is the failure this whole item is
    // about.
    throw new Error(
      `the configured allowlist does not contain the relay identity this capture landed ` +
        `(${landed.pubkey}). Add it to ACP_BUZZ_ALLOWED_ACTORS in the deployment configuration ` +
        `and re-run.`,
    );
  }
  const ingressSecret = policy.secret;
  const guard = new IngressGuard(core.db, core.clock, core.audit, { buzz: policy });
  const actorIngress = new BuzzActorIngress(guard, core.sessions);

  const bindThrough = (actor: string, nonce: string) => {
    const request = { actor, sessionId: session.sessionId, sessionSecret: secret, nonce };
    const signature = ingressSignature(ingressSecret, buzzActorBindingSigningRequest(request));
    return actorIngress.bindActor({ ...request, signature });
  };

  const bound = bindThrough(landed.pubkey, `acp-live-${stamp}`);
  if (!bound.allowed) throw new Error(`signed ingress refused the relay identity: ${bound.message}`);

  // Same session, same secret, a fresh nonce and a valid signature — the only difference is
  // that this actor is not the one the deployment allowlisted.
  const impostorPubkey = `${landed.pubkey.slice(0, -4)}dead`;
  const impostor = bindThrough(impostorPubkey, `acp-live-impostor-${stamp}`);
  if (impostor.allowed) throw new Error("signed ingress admitted an actor outside the allowlist");

  const acknowledged = adapter.resolveActor(landed.pubkey);
  if (!acknowledged) throw new Error("the delivered-to actor did not resolve to a binding");
  if (adapter.resolveActor(impostorPubkey)) throw new Error("a refused actor still resolved");

  record["acknowledgement"] = {
    path: "IngressGuard.admit -> BuzzActorIngress.bindActor -> SessionRegistry.bindBuzzActor",
    actorFromRelay: landed.pubkey,
    resolvedRole: acknowledged.role,
    resolvedGeneration: acknowledged.bindingGeneration,
    resolvedStatus: acknowledged.status,
    differentActor: impostorPubkey,
    differentActorReasonCode: impostor.reasonCode,
    differentActorMessage: impostor.message,
    differentActorResolvedTo: null,
    sessionLifecycle: core.sessions.get(session.sessionId)?.lifecycle ?? null,
  };

  // ------------------------------------------------- doctor, on the production wiring
  // #243's done-when is not only "an envelope arrived": the doctor must stop reporting
  // CTO_BUZZ_NOT_CONNECTED for a project whose CTO is connected. That finding is what every
  // earlier DEGRADED run was recording.
  //
  // The control plane is built with the *real* CLI transport bound to the channel created
  // above — the shape of production's constructor (`agentcpd.ts:1149` passes
  // ACP_BUZZ_CHANNEL), not the in-memory double the suite normally uses.
  const harness = makeHarness({ buzzTransport: new BuzzCliTransport(binary, channelId), clock: liveClock });
  const { projectId } = await registerFixtureProject(harness, "buzz-live-doctor");

  const ctoSession = harness.cp.sessions.create({ provider: "scripted", model: "scripted-cto" });
  harness.cp.sessions.transition(ctoSession.sessionId, SessionLifecycle.READY, "live capture cto");
  const ctoBound = harness.cp.bindings.bind({
    roleKey: roleKeyFor(Role.PRIMARY_CTO, { projectId }),
    role: Role.PRIMARY_CTO,
    sessionId: ctoSession.sessionId,
    projectId,
  });
  if (!ctoBound.allowed) throw new Error(`CTO binding failed: ${ctoBound.message}`);

  const beforeConnect = await harness.cp.doctor.run();
  const ctoConnected = await harness.buzzAdapter.connect(ctoSession.sessionId, `primary-cto:${projectId}`);
  if (!ctoConnected.allowed) throw new Error(`live CTO buzz connect refused: ${ctoConnected.message}`);
  const afterConnect = await harness.cp.doctor.run();

  const notConnectedFor = (report: { findings: ReadonlyArray<{ code: string; scope: string }> }): boolean =>
    report.findings.some((f) => f.code === "CTO_BUZZ_NOT_CONNECTED" && f.scope === `project:${projectId}`);

  if (!notConnectedFor(beforeConnect)) {
    throw new Error("the doctor did not report CTO_BUZZ_NOT_CONNECTED before the CTO connected");
  }
  if (notConnectedFor(afterConnect)) {
    throw new Error("the doctor still reports CTO_BUZZ_NOT_CONNECTED for a connected CTO");
  }

  record["doctor"] = {
    projectId,
    ctoSessionId: ctoSession.sessionId,
    buzzAddress: harness.cp.sessions.get(ctoSession.sessionId)?.buzzAddress ?? null,
    ctoBuzzNotConnectedBeforeConnect: true,
    ctoBuzzNotConnectedAfterConnect: false,
    statusBeforeConnect: beforeConnect.status,
    statusAfterConnect: afterConnect.status,
    remainingFindingCodes: [...new Set(afterConnect.findings.map((f) => f.code))].sort(),
  };

  // What this record does and does not close. #243's done-when includes a HEALTHY doctor for
  // a project whose CTO is connected. This capture shows the Buzz-specific finding clearing,
  // and records the doctor status it actually observed — which is not HEALTHY, because the
  // fixture project has unrelated blocking findings. Writing PASS against #243 on that basis
  // would be a completed record carrying a claim nobody checked, so the result names the
  // narrower thing that was proven and #243 stays open.
  const doctorHealthy = afterConnect.status === "HEALTHY";
  record["closes"] = {
    "P0-09/#423": "transport matched to the installed CLI, argv and field names pinned",
    "#243": doctorHealthy
      ? "delivery, fenced envelope, signed-ingress acknowledgement, and a HEALTHY doctor"
      : "NOT CLOSED — delivery and acknowledgement proven; the done-when also requires a HEALTHY doctor",
  };
  record["result"] = doctorHealthy ? "PASS" : "PARTIAL";
} catch (err) {
  record["result"] = "FAIL";
  record["error"] = (err as Error).message;
} finally {
  if (channelId) {
    try {
      // Deleted, not archived: `channels list` still returns an archived channel, so
      // archiving would leave a name a later purpose could resolve to. The relay also
      // refuses to delete an archived channel, so an ephemeral TTL that fires first has to
      // be undone before the delete. The channel holds only this capture's own envelopes.
      try {
        cli("channels", "unarchive", "--channel", channelId);
      } catch {
        // Not archived yet — the ordinary case, since the TTL is an hour.
      }
      cli("channels", "delete", "--channel", channelId);
      record["cleanup"] = { channel: channelId, deleted: true };
    } catch (err) {
      record["cleanup"] = { channel: channelId, deleted: false, error: (err as Error).message };
    }
  }
  writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  console.log(`${record["result"]} → ${out}`);
  if (record["result"] === "FAIL") {
    console.error(record["error"]);
    process.exitCode = 1;
  }
}
