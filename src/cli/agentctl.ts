#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { digestOf } from "../core/digest.ts";
import { IngressGuard, ownerApprovalPayload } from "../ingress/ingress-guard.ts";
import { ControlPlane, defaultConfig } from "../app/control-plane.ts";
import { isAcpError } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
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
  agentctl github merge ...             refused: agentcpd owns CEO-approved finalization
  agentctl github post-merge ...        refused: agentcpd owns exact post-merge verification
  agentctl repair list                    show the repair operation allowlist
  agentctl repair dry-run <op> [k=v...]   evaluate a repair without changing anything
  agentctl repair execute <op> [k=v...]   execute a repair (owner-risk ops need --owner)
  agentctl capacity set <provider> <json> write the structured local capacity file
  agentctl capacity show                  current provider capacity and admission
  agentctl project register <name> <path> register a project and its primary repository
  agentctl project list                   list projects with derived activity
  agentctl daemon status                  daemon lock and health
`;

export const main = async (argv: string[]): Promise<number> => {
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

export const dispatch = async (
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
      // The local operator acts on the "cli" channel; the actor is their OS user, which
      // the deployment must have allowlisted as an owner identity (§21).
      const actor = process.env["ACP_OWNER_ACTOR"] ?? process.env["USER"] ?? "";
      const runId = required(args[1], "runId");
      const item = required(args[2], "item");
      const note = args.slice(3).join(" ");
      // §21 stopped accepting an identity as authority (#102), so this command has to *be* the
      // ingress it claims to be: it admits the approval through the guard, which checks the
      // channel policy, the nonce and that the payload binds this exact operation, and then
      // hands the gate the receipt that admission produced. Passing a `{channel, actor}` tuple
      // is refused, which left the shipped operator command unable to satisfy a human gate at
      // all (#372).
      const guard = new IngressGuard(cp.db, cp.clock, cp.audit, { cli: { allowedActors: [actor] } });
      const approval = {
        runId,
        operation: "owner_decision_submit",
        parameters: { item, approved: true, note },
        idempotencyKey: `owner-decision:${digestOf({ runId, item, note, actor })}`,
        approved: true,
      };
      const admitted = guard.admitOwnerApproval(
        {
          channel: "cli",
          actor,
          nonce: `owner-decision:${digestOf(approval)}`,
          payload: ownerApprovalPayload(approval),
        },
        approval,
      );
      if (!admitted.allowed) {
        print(admitted);
        return 1;
      }
      const decision = cp.ceo.recordOwnerDecision({
        runId,
        item,
        approved: true,
        note,
        receipt: admitted.value,
      });
      print(decision);
      return decision.allowed ? 0 : 1;
    },

    github: async () => {
      const [sub, ...params] = args;
      if (sub === "merge" || sub === "post-merge") {
        // `agentctl` is deliberately not a second control-plane/finalizer process (#393).
        // The daemon resumes every CEO-approved run under its single-instance lock; exposing
        // the coordinator here would let a CLI invocation bypass that durable ownership.
        print({
          allowed: false,
          reasonCode: ReasonCode.MERGE_AUTHORITY_DENIED,
          message: "GitHub finalization is daemon-owned; agentcpd will resume an approved run",
          evidence: { operation: sub, args: params },
        });
        return 1;
      }
      return fail(`unknown github subcommand: ${sub ?? ""}`);
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
