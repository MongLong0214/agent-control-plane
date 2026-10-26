import { dirname, join, resolve } from "node:path";

/**
 * Where a repo-factory run keeps its local files under its work directory (`<workRoot>/<runId>`):
 * the one source for the producer and runner that make them and for the check that a stored path
 * is the one they compute (core/credential-shapes.ts). Locations only: nothing here reads a file.
 */

/** Single source of truth for where a role's local checkout lives under `workDir`. */
export const repositoryCheckoutPath = (workDir: string, repositoryRole: string): string =>
  join(resolve(workDir), "repositories", repositoryRole);

/**
 * #246 C3, CEO decision (c) — the checkout leaf attempt `attempt` of a run creates: a name of its
 * own beside the producer's default leaf, bound to the run (its work directory) and the attempt. No
 * attempt ever reuses, moves or removes another attempt's checkout; an earlier one stays where it is.
 */
export const attemptCheckoutPath = (workDir: string, repositoryRole: string, attempt: number): string =>
  join(dirname(repositoryCheckoutPath(workDir, repositoryRole)), `${repositoryRole}.attempt-${attempt}`);

/**
 * Beside the checkout, never inside it. The checkout is disposable — a failed run removes it
 * so the same operation can retry — and the ledger is the one thing a retry must find.
 */
export const githubLedgerPath = (workDir: string, repositoryRole: string): string =>
  join(resolve(workDir), "github-ledger", `${repositoryRole}.json`);
