import { resolve, relative } from "node:path";

import { digestOf } from "../core/digest.ts";
import { allow, deny, type Decision } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { EXPERIMENT_ISOLATION_SCHEMA_ID } from "./baseline-contract.ts";

/**
 * V1-BR-08 — partial. This is a path-validation result for a future offline experiment.
 * #416 keeps this V1 declaration synchronized with experiment-state candidates but does not add ACP 2.0 runtime enforcement.
 * V1 has no experiment context or state-opening runtime, so this value deliberately makes
 * no write-denial or context-withholding claim. A future ACP 2.0 owner must consume this
 * validation before opening any experiment state and add the runtime enforcement there.
 */
export interface ExperimentIsolationValidation {
  schema: typeof EXPERIMENT_ISOLATION_SCHEMA_ID;
  experimentId: string;
  experimentDatabasePath: string;
  experimentArtifactRoot: string;
  productionDatabasePath: string;
  productionArtifactRoot: string;
  runtimeEnforcement: "NOT_AVAILABLE_IN_V1";
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
 * V1-BR-08 — partial: validates that a future offline experiment has no lexical path alias
 * to production state or artifacts. This is preparation only: there is no v1 experiment
 * state opener to place this check on, so callers must not treat the result as a runtime
 * write guard.
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
    runtimeEnforcement: "NOT_AVAILABLE_IN_V1" as const,
  };
  return allow(ReasonCode.OK, { ...unsigned, digest: digestOf(unsigned) });
};

const sameOrNested = (candidate: string, root: string): boolean => {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (!fromRoot.startsWith("..") && !fromRoot.includes(`..${process.platform === "win32" ? "\\" : "/"}`));
};
