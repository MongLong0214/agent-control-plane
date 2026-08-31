import { resolve, relative } from "node:path";

import { digestOf } from "../core/digest.ts";
import { allow, deny, type Decision } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { EXPERIMENT_ISOLATION_SCHEMA_ID } from "./baseline-contract.ts";

/**
 * The exact call site that turns a `deny` from this module into a refused SQLite open.
 *
 * Named as a string, not merely asserted in prose, so a caller (and the census in
 * `scripts/verify-v1-experiment-isolation-declaration.mjs`) can point at where the claim below is
 * actually true rather than trusting a comment.
 */
export const EXPERIMENT_ISOLATION_ENFORCEMENT_POINT = "src/db/database.ts Db constructor (DbOpenOptions.experimentContext)";

/**
 * V1-BR-08 — wired (#416). This is the path-validation result `Db`'s constructor consumes
 * before it opens a SQLite handle for a declared experiment context: a `deny` here stops the
 * handle from ever being created, not merely a lexical fact recorded after the fact.
 *
 * #416 originally shipped only this declaration, with a comment claiming "V1 has no experiment
 * context or state-opening runtime" to place enforcement on. That premise was stale the whole
 * time this file existed: every SQLite handle in this system is opened by `Db`'s constructor
 * (`src/db/database.ts`), so that constructor *is* the state-opening runtime, and it is now the
 * enforcement point `enforcementPoint` below names.
 *
 * `runtimeEnforcement` is a static fact about the codebase — that *a* real enforcement point
 * exists for a caller who threads this decision into `Db` correctly — not a per-call promise.
 * A caller that computes this decision and never passes it to `Db` (or opens a handle directly
 * with `better-sqlite3` instead) gets no enforcement from it, and this function has no way to see
 * that misuse. What it can say honestly is that the enforcement point exists in this codebase;
 * it must never claim that *this specific call* was enforced when nothing consumed it.
 */
export interface ExperimentIsolationValidation {
  schema: typeof EXPERIMENT_ISOLATION_SCHEMA_ID;
  experimentId: string;
  experimentDatabasePath: string;
  experimentArtifactRoot: string;
  productionDatabasePath: string;
  productionArtifactRoot: string;
  runtimeEnforcement: "ENFORCED_AT_DB_OPEN";
  /** Where `runtimeEnforcement` is true, for a caller that wants to go verify it. */
  enforcementPoint: typeof EXPERIMENT_ISOLATION_ENFORCEMENT_POINT;
  digest: string;
}

export interface ExperimentIsolationInput {
  experimentId: string;
  experimentDatabasePath: string;
  experimentArtifactRoot: string;
  productionDatabasePath: string;
  productionArtifactRoot: string;
}

/**
 * V1-BR-08 — wired (#416): validates that an offline experiment has no lexical path alias to
 * production state or artifacts, and is consumed by `Db`'s constructor as a write-denial gate
 * before it opens a handle for a declared experiment context. Do not reimplement this comparison
 * at a second call site — `Db` is the one place in this system a SQLite handle is opened, and a
 * second implementation is a second place this guarantee can drift from what it claims.
 */
export const validateExperimentIsolation = (
  input: ExperimentIsolationInput,
): Decision<ExperimentIsolationValidation> => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.experimentId)) {
    return deny(ReasonCode.INVALID_ARGUMENT, "experimentId must be a stable path-safe identifier", {
      experimentId: input.experimentId,
    });
  }
  const experimentDatabasePath = resolve(input.experimentDatabasePath);
  const experimentArtifactRoot = resolve(input.experimentArtifactRoot);
  const productionDatabasePath = resolve(input.productionDatabasePath);
  const productionArtifactRoot = resolve(input.productionArtifactRoot);

  if (experimentDatabasePath === productionDatabasePath) {
    return deny(ReasonCode.CONFLICT, "an offline experiment may not use the production SQLite database", {
      experimentDatabasePath,
      productionDatabasePath,
    });
  }
  if (
    sameOrNested(experimentArtifactRoot, productionArtifactRoot) ||
    sameOrNested(productionArtifactRoot, experimentArtifactRoot)
  ) {
    return deny(ReasonCode.CONFLICT, "experiment artifacts must be outside the production artifact root", {
      experimentArtifactRoot,
      productionArtifactRoot,
    });
  }

  const unsigned = {
    schema: EXPERIMENT_ISOLATION_SCHEMA_ID as typeof EXPERIMENT_ISOLATION_SCHEMA_ID,
    experimentId: input.experimentId,
    experimentDatabasePath,
    experimentArtifactRoot,
    productionDatabasePath,
    productionArtifactRoot,
    runtimeEnforcement: "ENFORCED_AT_DB_OPEN" as const,
    enforcementPoint: EXPERIMENT_ISOLATION_ENFORCEMENT_POINT as typeof EXPERIMENT_ISOLATION_ENFORCEMENT_POINT,
  };
  return allow(ReasonCode.OK, { ...unsigned, digest: digestOf(unsigned) });
};

const sameOrNested = (candidate: string, root: string): boolean => {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (!fromRoot.startsWith("..") && !fromRoot.includes(`..${process.platform === "win32" ? "\\" : "/"}`));
};
