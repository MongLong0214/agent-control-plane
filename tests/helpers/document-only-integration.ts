import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { RefreshTrigger, type CapacityMonitor, type ProviderCapacity, type RoleProviderCapacity } from "../../src/capacity/capacity-monitor.ts";
import { Role } from "../../src/domain/types.ts";
import type { ProviderRegistry, RoleCapacityBinding } from "../../src/runtime/provider.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";

/** Consumes the existing collector result verbatim; never authors an observation. */
export function assertMeasuredCapacity(readings: ProviderCapacity[], expectedProviders: readonly string[] = ["claude", "gpt"]): ProviderCapacity[] {
  if (expectedProviders.length === 0 || new Set(expectedProviders).size !== expectedProviders.length
      || readings.length !== expectedProviders.length) throw new Error("CAPACITY_UNKNOWN_NOT_ROUTABLE: incomplete measurement set");
  for (const provider of expectedProviders) {
    const matches = readings.filter((reading) => reading.provider === provider);
    const reading = matches[0];
    if (matches.length !== 1 || !reading || reading.operatorObservation
        || reading.sensorHealth !== "HEALTHY" || reading.runtimeHealth !== "HEALTHY"
        || (reading.allocationAdmission !== "OPEN" && reading.allocationAdmission !== "CONSERVE") || reading.buckets.length === 0
        || reading.buckets.some((bucket) => typeof bucket.remainingPercent !== "number"
          || !Number.isFinite(bucket.remainingPercent) || bucket.remainingPercent <= 0 || bucket.remainingPercent > 100)) {
      throw new Error(`CAPACITY_UNKNOWN_NOT_ROUTABLE: ${provider}; measured collector admission required`);
    }
  }
  return readings;
}

/** The B workload's critical roles, not an invented worker fanout or optional-review gate. */
const DOCUMENT_ROLES = [Role.CEO, Role.BOOTSTRAP_CTO, Role.PRIMARY_CTO, Role.WORKER, Role.BLIND_REVIEWER] as const;
export async function measureDocumentCapacity(capacity: CapacityMonitor, providers: ProviderRegistry): Promise<Array<ProviderCapacity | RoleProviderCapacity>> {
  const readings: Array<ProviderCapacity | RoleProviderCapacity> = [];
  const bindings: RoleCapacityBinding[] = [];
  for (const provider of ["claude", "gpt"]) {
    if (!providers.hasRoleScoped(provider)) {
      readings.push(...assertMeasuredCapacity(await capacity.refresh(RefreshTrigger.DOCTOR_CAPACITY_REPORT, [provider]), [provider]));
      continue;
    }
    for (const role of DOCUMENT_ROLES) {
      const binding = providers.capacityBindingForRole(provider, role);
      const reading = await capacity.refreshForRole(provider, role);
      if (!binding || reading.binding.generation !== binding.generation) throw new Error("CAPACITY_UNKNOWN_NOT_ROUTABLE: role binding unavailable");
      assertMeasuredCapacity([reading], [provider]);
      const capability = role === Role.CEO ? "ceo" : role === Role.WORKER ? "worker" : role === Role.BLIND_REVIEWER ? "blind-review" : "cto";
      if (!capacity.isRoutableFor(reading, capability)) throw new Error("CAPACITY_UNKNOWN_NOT_ROUTABLE: role capability unavailable");
      bindings.push(binding);
      readings.push(reading);
    }
  }
  // An earlier result can be superseded while a later role is being measured.
  if (bindings.some((binding) => providers.capacityBindingForRole(binding.provider, binding.role) !== binding)) {
    throw new Error("CAPACITY_UNKNOWN_NOT_ROUTABLE: role binding superseded");
  }
  return readings;
}

/** Explicit operator input, never a canonical actor/session or a provider observation. */
export interface DocumentInput {
  evidenceKind: "disposable-component";
  repositoryIdentity: string;
  baseHead: string;
  contract: TaskContract;
  patch: string;
}
const git = (root: string, args: string[], input?: string): string =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", input, timeout: 10_000 });

const strings = z.array(z.string().min(1));
const documentSchema = z.object({
  evidenceKind: z.literal("disposable-component"),
  repositoryIdentity: z.literal("github:MongLong0214/agent-control-plane"),
  baseHead: z.string().regex(/^[0-9a-f]{40}$/),
  patch: z.string().min(1).max(1_048_576),
  contract: z.object({
    goal: z.string().min(1), why: z.string().min(1), scope: strings.min(1),
    nonGoals: strings, acceptance: strings.min(1), priority: z.enum(["LOW", "NORMAL", "CRITICAL"]),
    humanGate: strings, references: strings,
  }).strict(),
}).strict();

export function validateDocumentInput(root: string, input: unknown): DocumentInput {
  const approved = documentSchema.parse(input);
  const remote = git(root, ["remote", "get-url", "origin"]).trim();
  const repo = approved.repositoryIdentity.slice("github:".length);
  if (![ `git@github.com:${repo}.git`, `https://github.com/${repo}.git`, `https://github.com/${repo}` ].includes(remote)
      || git(root, ["rev-parse", "HEAD"]).trim() !== approved.baseHead
      || git(root, ["status", "--porcelain", "--untracked-files=all"]).trim()) {
    throw new Error("DOCUMENT_INPUT_WRONG_TARGET_OR_DIRTY");
  }
  const scope = [...approved.contract.scope].sort();
  if (new Set(scope).size !== scope.length) throw new Error("DOCUMENT_INPUT_DUPLICATE_SCOPE");
  for (const path of scope) {
    if (!/^(?:docs\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.md|README\.md)$/.test(path)
        || path.split("/").some((part) => part === "." || part === "..")
        || realpathSync(join(root, path)) !== join(realpathSync(root), path)
        || !lstatSync(join(root, path)).isFile()
        || !git(root, ["ls-tree", "HEAD", "--", path]).startsWith("100644 blob ")) {
      throw new Error("DOCUMENT_INPUT_NOT_REGULAR_DOCUMENT");
    }
  }
  // No renames, binary content, mode changes, new files or deleted files in this bounded adapter.
  if (/^(?:old mode|new mode|new file mode|deleted file mode|rename |copy |GIT binary patch|Binary files)/m.test(approved.patch)) {
    throw new Error("DOCUMENT_INPUT_NOT_DOCUMENT_EDIT");
  }
  const stats = git(root, ["apply", "--numstat", "-z", "-"], approved.patch).split("\0").filter(Boolean);
  const paths = stats.map((row) => {
    const match = /^\d+\t\d+\t([^\t\n]+)$/.exec(row);
    if (!match) throw new Error("DOCUMENT_INPUT_INVALID_DIFF");
    return match[1]!;
  }).sort();
  if (JSON.stringify(paths) !== JSON.stringify(scope)) throw new Error("DOCUMENT_INPUT_SCOPE_MISMATCH");

  git(root, ["apply", "--check", "-"], approved.patch);
  return approved;
}

export function applyDocumentInput(root: string, input: DocumentInput): void {
  validateDocumentInput(root, input);
  git(root, ["apply", "--index", "-"], input.patch);
}
