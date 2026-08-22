#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { defaultConfig } from "../app/control-plane.ts";
import { digestOf } from "../core/digest.ts";
import { type Decision, deny, isAcpError } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { RunState } from "../domain/types.ts";
import { SingleInstanceLock } from "../daemon/single-instance.ts";

/**
 * PRD §28.4 — the operator CLI is a client, never a composition root. Every command crosses
 * the authenticated daemon socket. `daemon status` additionally falls back to reading the
 * local lock file, so that it still answers when no daemon does.
 */
const USAGE = `agentctl — Agent Control Plane operator CLI

  agentctl doctor [scope] [target]        run a read-only doctor pass
  agentctl run show <runId>               run state, tasks, evidence
  agentctl run list [state]               list runs
  agentctl run export <runId>             export host-anchored run evidence
  agentctl run cancel <runId> <reason>    cancel a run and its task graph
  agentctl baseline export --from <ISO> --to <ISO>
  agentctl continuity status              continuity mode and role coverage plan
  agentctl outbox retry                   reset delivery attempts on pending messages
  agentctl owner approve <runId> <item>   record an owner decision for a human gate
  agentctl github merge ...             refused: agentcpd owns CEO-approved finalization
  agentctl github post-merge ...        refused: agentcpd owns exact post-merge verification
  agentctl repair list                    show the repair operation allowlist
  agentctl repair dry-run <op> [k=v...]   evaluate a repair without changing anything
  agentctl repair execute <op> [k=v...]   execute a repair (owner-risk ops need --owner)
  agentctl capacity observe <provider> <json> record a short-lived, authenticated quota observation
  agentctl capacity show                  current provider capacity and admission
  agentctl project register <name> <path> register a project and its primary repository
  agentctl project list                   list projects with derived activity
  agentctl actor register <id> <generation> <expected-set-generation>
  agentctl actor list                     list registered conversational actors
  agentctl actor unregister <id> <generation> <expected-set-generation> <reason>
  agentctl conversation contradictions     turns whose records disagree, with the ids to cite
  agentctl conversation adjudicate <actor> <turn> <reason-code> <evidence-digest> <id>...
  agentctl conversation unresolved         turns waiting on a person, with what each already holds
  agentctl conversation resolve <actor> <turn> <reason-code> <evidence-digest> [--fenced]
                                           settle an unobserved turn ABORTED, which permits a retry.
                                           --fenced only when its executor incarnation is still
                                           current: you are stating the execution cannot still write
  agentctl bootstrap hermes -- <command>  launch Hermes and establish CEO generation 1
  agentctl daemon status                  daemon mode and health; falls back to the lock file
`;

export interface OperatorClientOptions {
  socketPath: string;
  token?: string;
  timeoutMs?: number;
}

export interface OperatorClient {
  request(
    method: string,
    params?: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<Decision<unknown>>;
}

const OPERATOR_MUTATION_METHOD_NAMES = new Set([
  "run.cancel",
  "outbox.retry",
  "owner.approve",
  "repair.dry-run",
  "repair.execute",
  "capacity.observe",
  "project.register",
  "actor.register",
  "actor.unregister",
  "conversation.adjudicate",
  "conversation.resolve",
]);

/** Creates a daemon-only operator client. It never opens SQLite or constructs a service. */
export const createOperatorClient = (options: OperatorClientOptions): OperatorClient => ({
  request: (method, params = {}, idempotencyKey) =>
    exchangeOperatorRequest(options, {
      requestId: randomUUID(),
      method,
      params,
      ...(idempotencyKey || OPERATOR_MUTATION_METHOD_NAMES.has(method)
        ? { idempotencyKey: idempotencyKey ?? `operator:${digestOf({ method, params })}` }
        : {}),
    }),
});

export const main = async (argv: string[]): Promise<number> => {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help") {
    process.stdout.write(USAGE);
    return 0;
  }

  const config = defaultConfig();
  const owner = rest.includes("--owner");
  const args = rest.filter((arg) => arg !== "--owner");

  const client = createOperatorClient({
    socketPath:
      process.env["ACP_OPERATOR_SOCKET"] ?? join(config.databasePath, "..", "agentcpd.operator.sock"),
    token: process.env["ACP_OPERATOR_TOKEN"],
  });

  // `daemon status` keeps its offline reading — it must answer when no daemon is running — but
  // it asks the daemon first. A parked daemon is the one state where the lock file is actively
  // misleading: it says a process holds the lock, and nothing in it says that process is
  // serving only the capacity door. `mode` and the remaining blocking findings live on the
  // socket method, so an inspection that never sends it cannot report the state this exists for.
  if (command === "daemon" && args[0] === "status") {
    const live = await client.request("daemon.status", {});
    if (live.allowed) {
      print(live.value);
      return 0;
    }
    // Three different situations reach here: no token, so the client never opened a socket;
    // a wrong token, where the daemon accepted the connection and *answered* with a denial;
    // and a socket that could not be reached at all. Only `reasonCode` separates them, so that
    // is what this reports — an earlier version asserted `answered: false`, which is simply
    // untrue of the middle case, and the one before that called all three "unreachable".
    // `lock` is a file read that never checks whether its pid is alive, so it can appear
    // beside any of them, including beside a process that is already gone.
    const lock = new SingleInstanceLock(join(config.databasePath, "..", "agentcpd.lock"));
    print({
      lock: lock.read(),
      databasePath: config.databasePath,
      daemonStatus: { reasonCode: live.reasonCode, message: live.message },
    });
    return 0;
  }

  return dispatch(client, command, args, owner);
};

export const dispatch = async (
  client: OperatorClient,
  command: string,
  args: string[],
  owner: boolean,
): Promise<number> => {
  const call = async (
    method: string,
    params: Record<string, unknown> = {},
    idempotencyKey?: string,
  ): Promise<number> => {
    const decision = await client.request(method, params, idempotencyKey);
    print(decision.allowed ? decision.value : decision);
    return decision.allowed ? 0 : 1;
  };

  if (command === "doctor") {
    return call("doctor.run", { scope: args[0] ?? "system", target: args[1] ?? null });
  }

  if (command === "bootstrap") {
    if (args[0] !== "hermes") return fail(`unknown bootstrap subcommand: ${args[0] ?? ""}`);
    const separator = args.indexOf("--", 1);
    const hermesCommand = separator === -1 ? args.slice(1) : args.slice(separator + 1);
    if (hermesCommand.length === 0) {
      return fail("bootstrap hermes requires -- followed by a command and its arguments");
    }
    return call(
      "bootstrap.hermes",
      { command: hermesCommand },
      `hermes-bootstrap:${digestOf(hermesCommand)}`,
    );
  }

  if (command === "run") {
    const [sub, ...params] = args;
    if (sub === "show") return call("run.show", { runId: required(params[0], "runId") });
    if (sub === "list") return call("run.list", params[0] ? { state: params[0] as RunState } : {});
    if (sub === "export") return call("run.export", { runId: required(params[0], "runId") });
    if (sub === "cancel") {
      return call("run.cancel", {
        runId: required(params[0], "runId"),
        reason: params.slice(1).join(" ") || "operator cancel",
      });
    }
    return fail(`unknown run subcommand: ${sub ?? ""}`);
  }

  if (command === "baseline") {
    if (args[0] !== "export") return fail(`unknown baseline subcommand: ${args[0] ?? ""}`);
    let from: string | undefined;
    let to: string | undefined;
    for (let index = 1; index < args.length; index += 2) {
      const option = args[index];
      const value = args[index + 1];
      if (option !== "--from" && option !== "--to") return fail(`unknown baseline option: ${option ?? ""}`);
      if (!value) return fail(`missing required argument: ${option}`);
      if (option === "--from") from = value;
      if (option === "--to") to = value;
    }
    if (!from || !to) return fail("baseline export requires --from and --to");
    return call("baseline.export", { from, to });
  }

  if (command === "continuity") {
    if (args[0] !== "status") return fail(`unknown continuity subcommand: ${args[0] ?? ""}`);
    return call("continuity.status");
  }

  if (command === "outbox") {
    if (args[0] !== "retry") return fail(`unknown outbox subcommand: ${args[0] ?? ""}`);
    return call("outbox.retry");
  }

  if (command === "owner") {
    if (args[0] !== "approve") return fail(`unknown owner subcommand: ${args[0] ?? ""}`);
    return call("owner.approve", {
      runId: required(args[1], "runId"),
      item: required(args[2], "item"),
      note: args.slice(3).join(" "),
      approved: true,
    });
  }

  if (command === "github") {
    const [sub, ...params] = args;
    if (sub === "merge" || sub === "post-merge") {
      // Finalization is intentionally not an operator method. The daemon resumes the durable
      // finalizer after CEO confirmation while holding the single-instance lock.
      print({
        allowed: false,
        reasonCode: ReasonCode.MERGE_AUTHORITY_DENIED,
        message: "GitHub finalization is daemon-owned; agentcpd will resume an approved run",
        evidence: { operation: sub, args: params },
      });
      return 1;
    }
    return fail(`unknown github subcommand: ${sub ?? ""}`);
  }

  if (command === "repair") {
    const [sub, operationId, ...params] = args;
    if (sub === "list") return call("repair.list");
    if (sub !== "dry-run" && sub !== "execute") {
      return fail(`unknown repair subcommand: ${sub ?? ""}`);
    }
    const parameters: Record<string, string> = {};
    for (const param of params) {
      const [key, ...value] = param.split("=");
      if (key) parameters[key] = value.join("=");
    }
    return call(`repair.${sub}`, {
      operationId: required(operationId, "operation"),
      parameters,
      owner,
    });
  }

  if (command === "capacity") {
    if (args[0] === "show") return call("capacity.show");
    if (args[0] === "observe") {
      const provider = required(args[1], "provider");
      const payload = required(args.slice(2).join(" "), "json");
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload) as unknown;
      } catch {
        return fail("json must be valid JSON");
      }
      return call("capacity.observe", { provider, payload: parsed });
    }
    return fail(`unknown capacity subcommand: ${args[0] ?? ""}`);
  }

  if (command === "project") {
    if (args[0] === "list") return call("project.list");
    if (args[0] === "register") {
      return call("project.register", {
        name: required(args[1], "name"),
        checkoutPath: required(args[2], "checkoutPath"),
        projectId: args[3] ?? undefined,
      });
    }
    return fail(`unknown project subcommand: ${args[0] ?? ""}`);
  }

  if (command === "actor") {
    const [sub, actorId, actorGeneration, expectedRegistrySetGeneration, ...reason] = args;
    if (sub === "list") return call("actor.list");
    if (sub === "register") {
      return call("actor.register", {
        actorId: required(actorId, "actorId"),
        actorGeneration: requiredInteger(actorGeneration, "actorGeneration", 1),
        expectedRegistrySetGeneration: requiredInteger(
          expectedRegistrySetGeneration,
          "expectedRegistrySetGeneration",
          0,
        ),
      });
    }
    if (sub === "unregister") {
      return call("actor.unregister", {
        actorId: required(actorId, "actorId"),
        actorGeneration: requiredInteger(actorGeneration, "actorGeneration", 1),
        expectedRegistrySetGeneration: requiredInteger(
          expectedRegistrySetGeneration,
          "expectedRegistrySetGeneration",
          0,
        ),
        reason: required(reason.join(" "), "reason"),
      });
    }
    return fail(`unknown actor subcommand: ${sub ?? ""}`);
  }

  if (command === "conversation") {
    const [sub, targetActorId, turnRequestId, reasonCode, evidenceDigest, ...observationIds] = args;
    if (sub === "contradictions") return call("conversation.contradictions");
    if (sub === "unresolved") return call("conversation.unresolved");
    if (sub === "resolve") {
      // No observation ids: an unresolved turn has nothing to cite, which is exactly why
      // `adjudicate` cannot take it. What the operator supplies instead is what they looked at.
      return call("conversation.resolve", {
        targetActorId: required(targetActorId, "targetActorId"),
        turnRequestId: required(turnRequestId, "turnRequestId"),
        reasonCode: required(reasonCode, "reasonCode"),
        evidenceDigest: required(evidenceDigest, "evidenceDigest"),
        // Needed only when ACP cannot see the fence for itself. If the turn's executor incarnation
        // is still the current one, the execution may still be running, and settling ABORTED
        // without this flag would admit a retry while the first attempt is in flight.
        fenceAsserted: observationIds.includes("--fenced"),
      });
    }
    if (sub === "adjudicate") {
      // The ids come from `conversation contradictions`, which is why they are positional rather
      // than a flag: an adjudication cites the set that turn actually holds, and retyping a
      // summary is how a partial citation gets made.
      const cited = observationIds.map((raw) => Number(raw));
      if (cited.length === 0 || cited.some((id) => !Number.isSafeInteger(id) || id < 1)) {
        return fail("adjudicate needs at least one observation id, and each must be a positive integer");
      }
      return call("conversation.adjudicate", {
        targetActorId: required(targetActorId, "targetActorId"),
        turnRequestId: required(turnRequestId, "turnRequestId"),
        reasonCode: required(reasonCode, "reasonCode"),
        evidenceDigest: required(evidenceDigest, "evidenceDigest"),
        citedObservationIds: cited,
      });
    }
    return fail(`unknown conversation subcommand: ${sub ?? ""}`);
  }
  if (command === "daemon" && args[0] === "status") return call("daemon.status");
  return fail(`unknown command: ${command}`);
};

/**
 * Larger than the widest budget the daemon may take (`MAX_OPERATOR_METHOD_BUDGET_MS`), asserted
 * by a test rather than imported: this CLI is a socket client, and pulling the daemon module in to
 * read a number would hand it the runtime surface it is deliberately without. Both were five seconds once,
 * so whichever timer fired first decided whether the same healthy daemon read as unauthenticated
 * or as having lost its lock — neither of which was true (#609). Writing the client's number by
 * hand puts that race one edit away from returning; a test asserts the inequality as well,
 * because a derivation can still be edited into equality.
 */
export const DEFAULT_OPERATOR_CLIENT_TIMEOUT_MS = 180_000;

const exchangeOperatorRequest = (
  options: OperatorClientOptions,
  request: { requestId: string; method: string; params: Record<string, unknown>; idempotencyKey?: string },
): Promise<Decision<unknown>> => {
  const token = options.token?.trim() ?? "";
  if (token.length === 0) {
    return Promise.resolve(
      deny(
        ReasonCode.OPERATOR_UNAUTHENTICATED,
        "agentctl needs the separately provisioned ACP_OPERATOR_TOKEN to reach agentcpd",
        { socketPath: options.socketPath },
      ),
    );
  }

  return new Promise<Decision<unknown>>((resolveExchange) => {
    const socket = createConnection(options.socketPath);
    // Strictly greater than the daemon's own execution budget, so its typed refusal wins the
    // race and the operator reads why the method failed rather than that the client gave up.
    // These were both five seconds, and which one fired decided whether the same healthy daemon
    // was reported as unauthenticated or as having lost its lock (#609).
    const timeoutMs = options.timeoutMs ?? DEFAULT_OPERATOR_CLIENT_TIMEOUT_MS;
    let received = "";
    let settled = false;
    let timeout: NodeJS.Timeout | null = null;
    const finish = (result: Decision<unknown>): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      socket.end();
      resolveExchange(result);
    };
    const unavailable = (error: unknown): void =>
      finish(
        deny(
          ReasonCode.DAEMON_LOCK_LOST,
          "agentcpd operator socket is unavailable; no direct database fallback was attempted",
          { socketPath: options.socketPath, error: error instanceof Error ? error.message : String(error) },
        ),
      );

    timeout = setTimeout(() => {
      socket.destroy();
      finish(
        deny(
          ReasonCode.OPERATOR_REQUEST_TIMEOUT,
          "agentcpd accepted the request and did not answer within the client budget",
          { socketPath: options.socketPath, budgetMs: timeoutMs },
        ),
      );
    }, timeoutMs);
    timeout.unref();
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ token, ...request })}\n`);
    });
    socket.on("data", (chunk: string) => {
      received += chunk;
      const boundary = received.indexOf("\n");
      if (boundary === -1) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(received.slice(0, boundary)) as unknown;
      } catch {
        return finish(deny(ReasonCode.INTERNAL_ERROR, "agentcpd returned invalid operator JSON", {}));
      }
      if (!isDecision(parsed)) {
        return finish(deny(ReasonCode.INTERNAL_ERROR, "agentcpd returned an invalid operator decision", {}));
      }
      finish(parsed);
    });
    socket.once("error", unavailable);
    socket.once("close", () => {
      if (!settled) unavailable(new Error("operator socket closed before a response"));
    });
  });
};

const isDecision = (value: unknown): value is Decision<unknown> =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { allowed?: unknown }).allowed === "boolean" &&
  typeof (value as { reasonCode?: unknown }).reasonCode === "string";

const print = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

const fail = (message: string): number => {
  process.stderr.write(`${message}\n\n${USAGE}`);
  return 2;
};

const required = (value: string | undefined, name: string): string => {
  if (!value) throw new Error(`missing required argument: ${name}`);
  return value;
};

const requiredInteger = (value: string | undefined, name: string, minimum: number): number => {
  const parsed = Number(required(value, name));
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}`);
  }
  return parsed;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      const body = isAcpError(err)
        ? { reasonCode: err.reasonCode, message: err.message, evidence: err.evidence }
        : { message: (err as Error).message };
      process.stderr.write(`${JSON.stringify(body, null, 2)}\n`);
      process.exit(1);
    });
}
