import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  BuzzAdapter,
  BuzzCliTransport,
  InMemoryBuzzTransport,
  type BuzzCliMessage,
} from "../../src/buzz/buzz-adapter.ts";
import {
  BuzzChannelTrafficWatch,
  type BuzzChannelTrafficSource,
} from "../../src/buzz/channel-traffic-watch.ts";
import { createBuzzRuntime } from "../../src/daemon/agentcpd.ts";
import type { Daemon } from "../../src/daemon/daemon.ts";
import { SessionLifecycle } from "../../src/domain/types.ts";
import { aggregate, type DoctorReport, type Finding } from "../../src/doctor/doctor.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness, type Harness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

let messageSequence = 0;
const message = (createdAt: number, id?: string): BuzzCliMessage => {
  messageSequence += 1;
  return {
    id: id ?? `msg-${messageSequence}`,
    content: "<redacted>",
    pubkey: "some-pubkey",
    created_at: createdAt,
    kind: 9,
    tags: [],
  };
};

const finding = (report: DoctorReport, code: string, sessionId?: string): Finding | undefined =>
  report.findings.find(
    (candidate) =>
      candidate.code === code &&
      (sessionId === undefined || candidate.observedEvidence["sessionId"] === sessionId),
  );

const waitFor = async (condition: () => boolean, description: string, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
};

/**
 * A deterministic source behind the real watch. It preserves relay history, applies the CLI's
 * exclusive `--since` and `--limit`, and can hold one call so a real daemon tick overlaps a real
 * adapter channel change.
 */
class ScriptedChannelSource implements BuzzChannelTrafficSource {
  readonly calls: Array<{ channel: string; since: number; limit: number }> = [];
  #messages: BuzzCliMessage[] = [];
  #nextError: Error | null = null;
  #blocker: {
    started: () => void;
    release: Promise<void>;
  } | null = null;

  respondWith(messages: readonly BuzzCliMessage[]): void {
    this.#messages = [...messages];
  }

  failNextWith(error: Error): void {
    this.#nextError = error;
  }

  blockNextRead(): { started: Promise<void>; release: () => void } {
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    this.#blocker = { started: markStarted, release: released };
    return { started, release };
  }

  async messagesSince(channel: string, since: number, limit: number): Promise<BuzzCliMessage[]> {
    this.calls.push({ channel, since, limit });
    if (this.#nextError) {
      const error = this.#nextError;
      this.#nextError = null;
      throw error;
    }
    if (this.#blocker) {
      const blocker = this.#blocker;
      this.#blocker = null;
      blocker.started();
      await blocker.release;
    }
    return this.#messages.filter((entry) => entry.created_at > since).slice(0, limit);
  }
}

interface RunningWatch {
  harness: Harness;
  source: ScriptedChannelSource;
  watch: BuzzChannelTrafficWatch;
  adapter: BuzzAdapter;
  daemon: Daemon;
}

const runningWatch = async (source = new ScriptedChannelSource()): Promise<RunningWatch> => {
  const harness = makeHarness();
  harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
  const watch = new BuzzChannelTrafficWatch(harness.cp.db, harness.cp.clock, harness.cp.audit, source);
  const adapter = new BuzzAdapter(
    harness.cp.db,
    harness.cp.clock,
    harness.cp.audit,
    harness.cp.sessions,
    harness.cp.bindings,
    harness.cp.outbox,
    new InMemoryBuzzTransport(),
    watch,
  );
  const daemon = harness.cp.createDaemon({
    stateDir: tempDir("acp-channel-traffic-daemon-"),
    buzz: adapter,
    channelTrafficWatch: watch,
    buzzChannelTrafficIntervalMs: 200,
    deliveryIntervalMs: 60_000,
  });
  return { harness, source, watch, adapter, daemon };
};

const connectSession = async (
  runtime: Pick<RunningWatch, "harness" | "adapter">,
  model: string,
  purpose = `cto:${model}`,
): Promise<{ sessionId: string; channel: string; purpose: string }> => {
  const session = runtime.harness.cp.sessions.create({ provider: "scripted", model });
  // Production connects the launched session before its health probe moves it to READY.
  const connected = await runtime.adapter.connect(session.sessionId, purpose);
  if (!connected.allowed) throw new Error(`fixture connect failed: ${JSON.stringify(connected)}`);
  runtime.harness.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "health probe passed");
  return { sessionId: session.sessionId, channel: connected.value, purpose };
};

const start = async (runtime: RunningWatch): Promise<void> => {
  const started = await runtime.daemon.start();
  if (!started.allowed) throw new Error(`fixture daemon start failed: ${JSON.stringify(started)}`);
};

const stop = async (runtime: RunningWatch): Promise<void> => {
  await runtime.daemon.stop();
  runtime.harness.cp.close();
};

const watchRow = (runtime: RunningWatch, sessionId: string) =>
  runtime.harness.cp.db.get<{
    baseline_at: number | null;
    window_started_at: number | null;
    observed_count: number;
    window_incomplete: number;
    attempt_in_progress: number;
    last_read_success_at: string | null;
    last_error_at: string | null;
  }>(
    `SELECT baseline_at, window_started_at, observed_count, window_incomplete,
            attempt_in_progress, last_read_success_at, last_error_at
       FROM buzz_channel_traffic_watch WHERE session_id = ?`,
    [sessionId],
  );

const waitForBaseline = async (runtime: RunningWatch, sessionId: string): Promise<void> => {
  await waitFor(
    () => watchRow(runtime, sessionId)?.baseline_at !== null,
    `baseline for ${sessionId}`,
  );
};

describe("Doctor reports raw Buzz channel traffic between completed watch checks", () => {
  it("a connected session is never checked until the daemon watch runs", async () => {
    const runtime = await runningWatch();
    try {
      const session = await connectSession(runtime, "not-yet-checked");

      const before = await runtime.harness.cp.doctor.run("system");
      expect(finding(before, "BUZZ_CHANNEL_TRAFFIC_NEVER_CHECKED", session.sessionId)).toBeDefined();

      await start(runtime);
      await waitForBaseline(runtime, session.sessionId);
      const after = await runtime.harness.cp.doctor.run("system");
      expect(finding(after, "BUZZ_CHANNEL_TRAFFIC_BASELINE_ESTABLISHED", session.sessionId))
        .toBeDefined();
    } finally {
      await stop(runtime);
    }
  });

  it("a complete watch check advances the raw traffic window", async () => {
    const runtime = await runningWatch();
    try {
      const session = await connectSession(runtime, "advancing-window");
      await start(runtime);
      await waitForBaseline(runtime, session.sessionId);
      const baselineSecond = Math.floor(runtime.harness.clock.now().getTime() / 1000);
      const traffic = [
        message(baselineSecond + 1),
        message(baselineSecond + 2),
        message(baselineSecond + 3),
        message(baselineSecond + 4),
      ];

      runtime.harness.clock.advance(5_000);
      runtime.source.respondWith(traffic);
      await waitFor(
        () => watchRow(runtime, session.sessionId)?.observed_count === 4,
        "four-message completed window",
      );
      const first = await runtime.harness.cp.doctor.run("system");
      const measured = finding(first, "BUZZ_CHANNEL_TRAFFIC_BETWEEN_COMPLETED_CHECKS", session.sessionId);
      expect(measured?.severity).toBe("INFO");
      expect(aggregate(measured ? [measured] : [])).toBe("HEALTHY");
      expect(measured?.observedEvidence).toMatchObject({
        measurementScope: "RAW_CHANNEL_TRAFFIC_BETWEEN_COMPLETED_WATCH_CHECKS",
        unmeasured: "MENTION_CLASSIFICATION_NEEDS_ACTION_AND_CANONICAL_TURN_DELIVERY",
        remainder: "ISSUE_674_REQUIRES_RELAY_SIDE_TELEMETRY",
        rawChannelMessagesBetweenCompletedChecks: 4,
      });

      runtime.harness.clock.advance(1_000);
      await waitFor(
        () => {
          const row = watchRow(runtime, session.sessionId);
          return row?.window_started_at !== null && row?.observed_count === 0;
        },
        "next completed zero window",
      );
      const second = await runtime.harness.cp.doctor.run("system");
      expect(
        finding(second, "BUZZ_CHANNEL_TRAFFIC_BETWEEN_COMPLETED_CHECKS", session.sessionId)
          ?.observedEvidence,
      ).toMatchObject({ rawChannelMessagesBetweenCompletedChecks: 0 });
    } finally {
      await stop(runtime);
    }
  });

  it("reconnecting to the same channel preserves the completed measurement", async () => {
    const runtime = await runningWatch();
    try {
      const session = await connectSession(runtime, "same-channel-reconnect");
      await start(runtime);
      await waitForBaseline(runtime, session.sessionId);
      const baselineSecond = Math.floor(runtime.harness.clock.now().getTime() / 1000);
      runtime.harness.clock.advance(3_000);
      runtime.source.respondWith([message(baselineSecond + 1), message(baselineSecond + 2)]);
      await waitFor(
        () => watchRow(runtime, session.sessionId)?.observed_count === 2,
        "two-message completed window",
      );

      const reconnected = await runtime.adapter.connect(session.sessionId, session.purpose);
      expect(reconnected.allowed).toBe(true);
      const report = await runtime.harness.cp.doctor.run("system");
      expect(
        finding(report, "BUZZ_CHANNEL_TRAFFIC_BETWEEN_COMPLETED_CHECKS", session.sessionId)
          ?.observedEvidence,
      ).toMatchObject({ rawChannelMessagesBetweenCompletedChecks: 2 });
    } finally {
      await stop(runtime);
    }
  });

  it("a failed check reports unavailable instead of a stale count", async () => {
    const runtime = await runningWatch();
    try {
      const session = await connectSession(runtime, "failed-read");
      await start(runtime);
      await waitForBaseline(runtime, session.sessionId);
      runtime.harness.clock.advance(1_000);
      runtime.source.failNextWith(new Error("buzz messages get returned invalid output"));
      await waitFor(
        () => watchRow(runtime, session.sessionId)?.last_error_at !== null,
        "failed watch read",
      );

      const report = await runtime.harness.cp.doctor.run("system");
      const unavailable = finding(report, "BUZZ_CHANNEL_TRAFFIC_WATCH_UNAVAILABLE", session.sessionId);
      expect(unavailable).toBeDefined();
      expect(unavailable?.observedEvidence).toMatchObject({
        unmeasured: "MENTION_CLASSIFICATION_NEEDS_ACTION_AND_CANONICAL_TURN_DELIVERY",
      });
    } finally {
      await stop(runtime);
    }
  });

  it("an unfinished daemon watch attempt is not a verified old window", async () => {
    const runtime = await runningWatch();
    try {
      const session = await connectSession(runtime, "unfinished-read");
      await start(runtime);
      await waitForBaseline(runtime, session.sessionId);
      runtime.harness.clock.advance(1_000);
      const blocked = runtime.source.blockNextRead();
      await blocked.started;

      const report = await runtime.harness.cp.doctor.run("system");
      const unavailable = finding(report, "BUZZ_CHANNEL_TRAFFIC_WATCH_UNAVAILABLE", session.sessionId);
      expect(unavailable?.observedEvidence).toMatchObject({
        error: "watch attempt did not complete",
      });

      blocked.release();
      await waitFor(
        () => watchRow(runtime, session.sessionId)?.attempt_in_progress === 0,
        "blocked watch attempt to finish",
      );
    } finally {
      await stop(runtime);
    }
  });
});

describe("Buzz channel traffic cursor boundaries", () => {
  it("an event after the baseline in the same epoch second reaches Doctor through the daemon watch", async () => {
    const runtime = await runningWatch();
    try {
      runtime.harness.clock.advance(200);
      const session = await connectSession(runtime, "same-second");
      await start(runtime);
      await waitForBaseline(runtime, session.sessionId);
      const baselineSecond = Math.floor(runtime.harness.clock.now().getTime() / 1000);

      runtime.source.respondWith([message(baselineSecond, "same-second-after-baseline")]);
      runtime.harness.clock.advance(600);
      await waitFor(
        () => watchRow(runtime, session.sessionId)?.observed_count === 1,
        "same-second event",
      );

      const report = await runtime.harness.cp.doctor.run("system");
      expect(
        finding(report, "BUZZ_CHANNEL_TRAFFIC_BETWEEN_COMPLETED_CHECKS", session.sessionId)
          ?.observedEvidence,
      ).toMatchObject({ rawChannelMessagesBetweenCompletedChecks: 1 });
      expect(runtime.source.calls.at(-1)).toMatchObject({ since: baselineSecond - 1, limit: 201 });
    } finally {
      await stop(runtime);
    }
  });

  it("the baseline second excludes event ids already present when the window started", async () => {
    const runtime = await runningWatch();
    try {
      runtime.harness.clock.advance(200);
      const baselineSecond = Math.floor(runtime.harness.clock.now().getTime() / 1000);
      const prior = message(baselineSecond, "same-second-before-baseline");
      runtime.source.respondWith([prior]);
      const session = await connectSession(runtime, "boundary-identity");
      await start(runtime);
      await waitForBaseline(runtime, session.sessionId);

      runtime.source.respondWith([
        message(baselineSecond, "same-second-after-baseline"),
        prior,
      ]);
      runtime.harness.clock.advance(600);
      await waitFor(
        () => watchRow(runtime, session.sessionId)?.observed_count === 1,
        "only the new boundary event",
      );
      const report = await runtime.harness.cp.doctor.run("system");
      expect(
        finding(report, "BUZZ_CHANNEL_TRAFFIC_BETWEEN_COMPLETED_CHECKS", session.sessionId)
          ?.observedEvidence,
      ).toMatchObject({ rawChannelMessagesBetweenCompletedChecks: 1 });
    } finally {
      await stop(runtime);
    }
  });

  it("event ids make repeated and out of order relay rows one count each", async () => {
    const runtime = await runningWatch();
    try {
      const session = await connectSession(runtime, "deduplicated-events");
      await start(runtime);
      await waitForBaseline(runtime, session.sessionId);
      const baselineSecond = Math.floor(runtime.harness.clock.now().getTime() / 1000);
      const first = message(baselineSecond + 1, "event-first");
      const second = message(baselineSecond + 2, "event-second");
      runtime.source.respondWith([second, first, second]);
      runtime.harness.clock.advance(3_000);

      await waitFor(
        () => watchRow(runtime, session.sessionId)?.observed_count === 2,
        "two unique events",
      );
      const report = await runtime.harness.cp.doctor.run("system");
      expect(
        finding(report, "BUZZ_CHANNEL_TRAFFIC_BETWEEN_COMPLETED_CHECKS", session.sessionId)
          ?.observedEvidence,
      ).toMatchObject({ rawChannelMessagesBetweenCompletedChecks: 2 });
    } finally {
      await stop(runtime);
    }
  });

  it("a channel generation rejects a stale tick after a real channel change", async () => {
    const runtime = await runningWatch();
    try {
      const session = await connectSession(runtime, "old-channel");
      await start(runtime);
      await waitForBaseline(runtime, session.sessionId);
      const baselineSecond = Math.floor(runtime.harness.clock.now().getTime() / 1000);
      runtime.source.respondWith([message(baselineSecond + 10, "stale-old-channel-event")]);
      runtime.harness.clock.advance(10_000);
      const blocked = runtime.source.blockNextRead();
      await blocked.started;

      const changed = await runtime.adapter.connect(session.sessionId, "cto:new-channel");
      if (!changed.allowed) throw new Error(`fixture channel change failed: ${JSON.stringify(changed)}`);
      const changedChannel = changed.value;
      expect(changedChannel).not.toBe(session.channel);
      runtime.source.respondWith([]);
      blocked.release();

      await waitFor(
        () => {
          const row = runtime.harness.cp.db.get<{ channel_id: string; baseline_at: number | null }>(
            `SELECT channel_id, baseline_at FROM buzz_channel_traffic_watch WHERE session_id = ?`,
            [session.sessionId],
          );
          return row?.channel_id === changedChannel && row?.baseline_at !== null;
        },
        "new-channel baseline after stale read",
      );
      const report = await runtime.harness.cp.doctor.run("system");
      expect(finding(report, "BUZZ_CHANNEL_TRAFFIC_BASELINE_ESTABLISHED", session.sessionId))
        .toBeDefined();
    } finally {
      await stop(runtime);
    }
  });

  it("a capped read cannot become healthy silence after boundary filtering", async () => {
    const runtime = await runningWatch();
    try {
      const baselineSecond = Math.floor(runtime.harness.clock.now().getTime() / 1000);
      const boundary = message(baselineSecond, "already-present-at-window-start");
      runtime.source.respondWith([boundary]);
      const session = await connectSession(runtime, "capped-boundary");
      await start(runtime);
      await waitForBaseline(runtime, session.sessionId);

      runtime.harness.clock.advance(1_000);
      runtime.source.respondWith(Array.from({ length: 201 }, () => boundary));
      await waitFor(
        () => watchRow(runtime, session.sessionId)?.window_incomplete === 1,
        "incomplete capped window",
      );
      const report = await runtime.harness.cp.doctor.run("system");
      const incomplete = finding(report, "BUZZ_CHANNEL_TRAFFIC_WINDOW_INCOMPLETE", session.sessionId);
      expect(report.status).toBe("DEGRADED");
      expect(incomplete?.observedEvidence).toMatchObject({ confirmedRawChannelMessages: 0 });
    } finally {
      await stop(runtime);
    }
  });

  it("exactly two hundred raw rows complete the window", async () => {
    const runtime = await runningWatch();
    try {
      const session = await connectSession(runtime, "exactly-two-hundred");
      await start(runtime);
      await waitForBaseline(runtime, session.sessionId);
      const baselineSecond = Math.floor(runtime.harness.clock.now().getTime() / 1000);
      runtime.source.respondWith(
        Array.from({ length: 200 }, (_, index) => message(baselineSecond + index + 1)),
      );
      runtime.harness.clock.advance(201_000);
      await waitFor(
        () => watchRow(runtime, session.sessionId)?.observed_count === 200,
        "complete two-hundred-row window",
      );
      const report = await runtime.harness.cp.doctor.run("system");
      expect(
        finding(report, "BUZZ_CHANNEL_TRAFFIC_BETWEEN_COMPLETED_CHECKS", session.sessionId)
          ?.observedEvidence,
      ).toMatchObject({ rawChannelMessagesBetweenCompletedChecks: 200 });
      expect(finding(report, "BUZZ_CHANNEL_TRAFFIC_WINDOW_INCOMPLETE", session.sessionId))
        .toBeUndefined();
    } finally {
      await stop(runtime);
    }
  });
});

/**
 * Executable stand-in for the installed CLI. Production `BuzzCliTransport` crosses this process
 * boundary, and production `createBuzzRuntime` supplies that same instance to adapter and watch.
 */
class ExecutableBuzzCli {
  readonly binary: string;
  readonly channel = "00000000-0000-0000-0000-000000000674";
  readonly #messages: string;
  readonly #raw: string;
  readonly #calls: string;

  constructor() {
    const root = tempDir("acp-buzz-channel-traffic-cli-");
    this.binary = join(root, "buzz");
    this.#messages = join(root, "messages.json");
    this.#raw = join(root, "raw-output");
    this.#calls = join(root, "calls.jsonl");
    writeFileSync(this.#messages, "[]", "utf8");
    writeFileSync(this.#calls, "", "utf8");
    writeFileSync(
      this.binary,
      `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(this.#calls)}, JSON.stringify(argv) + "\\n");
const flag = (name) => {
  const index = argv.indexOf(name);
  return index < 0 ? null : argv[index + 1] ?? null;
};
const die = (message) => {
  process.stderr.write(JSON.stringify({ error: "user_error", message, retryable: false }));
  process.exit(1);
};
if (argv[0] === "channels" && argv[1] === "get") {
  const channel = flag("--channel");
  if (!channel) die("--channel is required");
  process.stdout.write(JSON.stringify({ channel_id: channel }));
  process.exit(0);
}
if (argv[0] === "messages" && argv[1] === "get") {
  if (!flag("--channel")) die("--channel is required");
  const messages = fs.readFileSync(${JSON.stringify(this.#messages)}, "utf8");
  if (fs.existsSync(${JSON.stringify(this.#raw)})) {
    process.stdout.write(messages);
    process.exit(0);
  }
  const since = Number(flag("--since"));
  const limit = Number(flag("--limit"));
  const response = JSON.parse(messages)
    .filter((entry) => entry.created_at > since)
    .slice(0, limit);
  process.stdout.write(JSON.stringify(response));
  process.exit(0);
}
die("unsupported argv: " + argv.join(" "));
`,
      "utf8",
    );
    chmodSync(this.binary, 0o755);
  }

  respondWith(messages: readonly BuzzCliMessage[]): void {
    if (existsSync(this.#raw)) unlinkSync(this.#raw);
    writeFileSync(this.#messages, JSON.stringify(messages), "utf8");
  }

  respondRaw(value: unknown): void {
    writeFileSync(this.#messages, JSON.stringify(value), "utf8");
    writeFileSync(this.#raw, "raw", "utf8");
  }

  messageReadCount(): number {
    return readFileSync(this.#calls, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as string[])
      .filter((argv) => argv[0] === "messages" && argv[1] === "get")
      .length;
  }
}

describe("agentcpd Buzz composition", () => {
  it("production composition measures each session on a shared channel", async () => {
    const harness = makeHarness();
    harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
    const cli = new ExecutableBuzzCli();
    const transport = new BuzzCliTransport(cli.binary, cli.channel);
    const runtime = createBuzzRuntime(harness.cp, transport);
    const daemon = harness.cp.createDaemon({
      stateDir: tempDir("acp-production-channel-traffic-daemon-"),
      buzz: runtime.buzz,
      channelTrafficWatch: runtime.channelTrafficWatch,
      buzzChannelTrafficIntervalMs: 1_500,
      deliveryIntervalMs: 60_000,
    });
    const priorKey = process.env["BUZZ_PRIVATE_KEY"];
    process.env["BUZZ_PRIVATE_KEY"] = "test-key";
    try {
      const connect = async (model: string) => {
        const session = harness.cp.sessions.create({ provider: "scripted", model });
        const decision = await runtime.buzz.connect(session.sessionId, `cto:${model}`);
        if (!decision.allowed) throw new Error(`fixture connect failed: ${JSON.stringify(decision)}`);
        harness.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "health probe passed");
        return session.sessionId;
      };
      const sessionA = await connect("shared-a");
      const sessionB = await connect("shared-b");
      expect(harness.cp.sessions.get(sessionA)?.buzzAddress).toBe(cli.channel);
      expect(harness.cp.sessions.get(sessionB)?.buzzAddress).toBe(cli.channel);

      const started = await daemon.start();
      if (!started.allowed) throw new Error(`fixture daemon start failed: ${JSON.stringify(started)}`);
      await waitFor(
        () => {
          const rows = harness.cp.db.get<{ completed: number }>(
            `SELECT COUNT(*) AS completed FROM buzz_channel_traffic_watch
              WHERE last_read_success_at IS NOT NULL`,
          );
          return rows?.completed === 2;
        },
        "two production-composed baselines",
        10_000,
      );

      const baselineSecond = Math.floor(harness.clock.now().getTime() / 1000);
      harness.clock.advance(2_000);
      cli.respondWith([message(baselineSecond + 1, "shared-channel-event")]);
      await waitFor(
        () => {
          const rows = harness.cp.db.get<{ measured: number }>(
            `SELECT COUNT(*) AS measured FROM buzz_channel_traffic_watch
              WHERE observed_count = 1 AND window_started_at IS NOT NULL`,
          );
          return rows?.measured === 2;
        },
        "two independent shared-channel windows",
        10_000,
      );
      const report = await harness.cp.doctor.run("system");
      const measuredA = finding(report, "BUZZ_CHANNEL_TRAFFIC_BETWEEN_COMPLETED_CHECKS", sessionA);
      expect(aggregate(measuredA ? [measuredA] : [])).toBe("HEALTHY");
      expect(measuredA?.observedEvidence).toMatchObject({
        rawChannelMessagesBetweenCompletedChecks: 1,
        unmeasured: "MENTION_CLASSIFICATION_NEEDS_ACTION_AND_CANONICAL_TURN_DELIVERY",
      });
      expect(
        finding(report, "BUZZ_CHANNEL_TRAFFIC_BETWEEN_COMPLETED_CHECKS", sessionB)
          ?.observedEvidence,
      ).toMatchObject({ rawChannelMessagesBetweenCompletedChecks: 1 });
      expect(cli.messageReadCount()).toBeGreaterThanOrEqual(4);

      cli.respondRaw([{}]);
      harness.clock.advance(2_000);
      await waitFor(
        () => {
          const rows = harness.cp.db.get<{ failed: number }>(
            `SELECT COUNT(*) AS failed FROM buzz_channel_traffic_watch
              WHERE last_error_at IS NOT NULL`,
          );
          return rows?.failed === 2;
        },
        "invalid CLI rows to fail both watch reads",
        10_000,
      );
      const invalid = await harness.cp.doctor.run("system");
      expect(finding(invalid, "BUZZ_CHANNEL_TRAFFIC_WATCH_UNAVAILABLE", sessionA)).toBeDefined();
      expect(finding(invalid, "BUZZ_CHANNEL_TRAFFIC_WATCH_UNAVAILABLE", sessionB)).toBeDefined();
    } finally {
      await daemon.stop();
      harness.cp.close();
      if (priorKey === undefined) delete process.env["BUZZ_PRIVATE_KEY"];
      else process.env["BUZZ_PRIVATE_KEY"] = priorKey;
    }
  }, 30_000);
});
