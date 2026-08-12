#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ControlPlane, defaultConfig } from "../app/control-plane.ts";
import { isAcpError } from "../core/errors.ts";
import type { RunState } from "../domain/types.ts";
import { SingleInstanceLock } from "../daemon/single-instance.ts";

/**
 * PRD §28.4 — the minimal operator CLI.
 *
 * Read paths open the same database the daemon uses; write paths are limited to the
 * operations §28.4 names, and repair still goes through the authorised repair contract
 * rather than touching state directly.
 */
const USAGE = `agentctl — Agent Control Plane operator CLI

  agentctl doctor [scope] [target]        run a read-only doctor pass
  agentctl run show <runId>               run state, tasks, evidence
  agentctl run list [state]               list runs
  agentctl run cancel <runId> <reason>    cancel a run and its task graph
  agentctl continuity status              continuity mode and role coverage plan
  agentctl outbox retry                   reset delivery attempts on pending messages
  agentctl owner approve <runId> <item>   record an owner decision for a human gate
  agentctl repair list                    show the repair operation allowlist
  agentctl repair dry-run <op> [k=v...]   evaluate a repair without changing anything
  agentctl repair execute <op> [k=v...]   execute a repair (owner-risk ops need --owner)
  agentctl capacity set <provider> <json> write the structured local capacity file
  agentctl capacity show                  current provider capacity and admission
  agentctl project register <name> <path> register a project and its primary repository
  agentctl project list                   list projects with derived activity
  agentctl daemon status                  daemon lock and health
`;

const main = async (argv: string[]): Promise<number> => {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help") {
    process.stdout.write(USAGE);
    return 0;
  }

  const config = defaultConfig();
  const owner = rest.includes("--owner");
  const args = rest.filter((a) => a !== "--owner");

  if (command === "daemon" && args[0] === "status") {
    const lock = new SingleInstanceLock(join(config.databasePath, "..", "agentcpd.lock"));
    print({ lock: lock.read(), databasePath: config.databasePath });
    return 0;
  }

  const cp = new ControlPlane(config);
  try {
    return await dispatch(cp, command, args, owner);
  } finally {
    cp.close();
  }
};

const dispatch = async (
  cp: ControlPlane,
  command: string,
  args: string[],
  owner: boolean,
): Promise<number> => {
  const handlers: Record<string, () => Promise<number>> = {
    doctor: async () => {
      const scope = (args[0] ?? "system") as Parameters<typeof cp.doctor.run>[0];
      print(await cp.doctor.run(scope, args[1]));
      return 0;
    },

    run: async () => {
      const [sub, ...params] = args;
      if (sub === "show") {
        const runId = required(params[0], "runId");
        const run = cp.runs.get(runId);
        if (!run) return fail(`unknown run ${runId}`);
        print({
          run,
          tasks: cp.tasks.list(runId),
          executions: cp.tasks.executions(runId),
          evidence: cp.ceo.evidence(runId),
          claims: cp.claims.heldByRun(runId),
          humanGate: cp.ceo.humanGateStatus(runId),
          outbox: cp.outbox.listByRun(runId).map((m) => ({
            kind: m.kind,
            status: m.status,
            bindingGeneration: m.bindingGeneration,
          })),
        });
        return 0;
      }
      if (sub === "list") {
        const state = params[0] as RunState | undefined;
        print(cp.runs.list(state ? { state } : {}));
        return 0;
      }
      if (sub === "cancel") {
        const decision = cp.runs.cancel(required(params[0], "runId"), params.slice(1).join(" ") || "operator cancel");
        print(decision);
        return decision.allowed ? 0 : 1;
      }
      return fail(`unknown run subcommand: ${sub ?? ""}`);
    },

    continuity: async () => {
      print({
        mode: cp.continuity.mode(),
        plan: cp.continuity.computeCoveragePlan(),
        capacity: cp.capacity.all(),
      });
      return 0;
    },

    outbox: async () => {
      if (args[0] !== "retry") return fail(`unknown outbox subcommand: ${args[0] ?? ""}`);
      const decision = await cp.repair.execute({
        operationId: "retry_outbox",
        parameters: {},
        authorizedBy: "HERMES",
        dryRun: false,
      });
      print(decision);
      return decision.allowed ? 0 : 1;
    },

    owner: async () => {
      if (args[0] !== "approve") return fail(`unknown owner subcommand: ${args[0] ?? ""}`);
      const decision = cp.ceo.recordOwnerDecision({
        runId: required(args[1], "runId"),
        item: required(args[2], "item"),
        approved: true,
        note: args.slice(3).join(" "),
      });
      print(decision);
      return decision.allowed ? 0 : 1;
    },

    repair: async () => {
      const [sub, operationId, ...params] = args;
      if (sub === "list") {
        print(cp.repair.catalog());
        return 0;
      }
      if (sub !== "dry-run" && sub !== "execute") return fail(`unknown repair subcommand: ${sub ?? ""}`);
      const parameters: Record<string, string> = {};
      for (const param of params) {
        const [k, ...v] = param.split("=");
        if (k) parameters[k] = v.join("=");
      }
      const decision = await cp.repair.execute({
        operationId: required(operationId, "operation"),
        parameters,
        authorizedBy: owner ? "OWNER" : "HERMES",
        dryRun: sub === "dry-run",
      });
      print(decision);
      return decision.allowed ? 0 : 1;
    },

    capacity: async () => {
      if (args[0] === "show") {
        print({ providers: cp.capacity.all() });
        return 0;
      }
      if (args[0] === "set") {
        const provider = required(args[1], "provider");
        const payload = required(args.slice(2).join(" "), "json");
        mkdirSync(cp.config.capacityDir, { recursive: true });
        const parsed = JSON.parse(payload) as Record<string, unknown>;
        // The owner publishes quota, not runtime health: an unstated runtime is probed
        // by the adapter, never assumed healthy.
        const body = { observedAt: cp.clock.nowIso(), runtimeHealth: "UNKNOWN", ...parsed };
        writeFileSync(join(cp.config.capacityDir, `${provider}.json`), JSON.stringify(body, null, 2), {
          mode: 0o600,
        });
        print({ wrote: join(cp.config.capacityDir, `${provider}.json`), body });
        return 0;
      }
      return fail(`unknown capacity subcommand: ${args[0] ?? ""}`);
    },

    project: async () => {
      if (args[0] === "list") {
        print(
          cp.projects.list().map((p) => ({
            ...p,
            repositories: cp.repositories.byProject(p.projectId).map((r) => r.identity),
          })),
        );
        return 0;
      }
      if (args[0] === "register") {
        const name = required(args[1], "name");
        const path = required(args[2], "checkoutPath");
        const project = cp.projects.register({ name, projectId: args[3] ?? undefined });
        if (!project.allowed) {
          print(project);
          return 1;
        }
        const repository = await cp.repositories.register({
          checkoutPath: path,
          projectId: project.value.projectId,
          repositoryRole: "primary",
        });
        print({ project: project.value, repository });
        return repository.allowed ? 0 : 1;
      }
      return fail(`unknown project subcommand: ${args[0] ?? ""}`);
    },
  };

  const handler = handlers[command];
  if (!handler) return fail(`unknown command: ${command}`);
  return handler();
};

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

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const body = isAcpError(err)
      ? { reasonCode: err.reasonCode, message: err.message, evidence: err.evidence }
      : { message: (err as Error).message };
    process.stderr.write(`${JSON.stringify(body, null, 2)}\n`);
    process.exit(1);
  });
