import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * `commitlore-preserve.yml` checks the CommitLore repository out at a pinned tag and hands the
 * action a path to `dist/cli.js`. Its comment reasoned that a committed `dist/` means "nothing
 * builds" — true — and then acted as though nothing needed installing either.
 *
 * `dist/cli.js` opens with `import { Command } from 'commander'`. Without `node_modules` that
 * bare specifier dies in ESM resolution before the file is parsed:
 *
 *     node:internal/modules/package_json_reader:314
 *       throw new ERR_MODULE_NOT_FOUND(packageName, fileURLToPath(base), null);
 *
 * The action reported it as `cannot parse the merge message`, which reads like a malformed commit
 * rather than a CLI that never started — so the job was red on **six consecutive merges** (#852,
 * #856, #860, #861, #862, #855) and every one of them was merged anyway, mine included. A check
 * that is always red is indistinguishable from a check that is broken, and this one guards
 * against silent record loss when someone presses GitHub's own Squash button.
 *
 * Measured: cloning v1.2.16 and running `node dist/cli.js --version` with no install reproduces
 * the trace; after `npm ci --omit=dev --ignore-scripts` it prints `1.2.16`.
 *
 * This reads the workflow rather than a fixture, for the same reason the shard test does: a
 * fixture is a second description of the fact, free to stop resembling the one CI runs.
 */
const WORKFLOW = ".github/workflows/commitlore-preserve.yml";

describe("a vendored CLI is installed before the workflow runs it", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");

  it("passes the action a cli-path inside the directory it checks out", () => {
    const checkout = /path:\s*(\S+)/.exec(workflow)?.[1];
    const cliPath = /cli-path:\s*(\S+)/.exec(workflow)?.[1];

    expect(checkout).toBeDefined();
    expect(cliPath).toBeDefined();
    // The rest of this file is about that directory, so the two must be the same one.
    expect(cliPath?.startsWith(`${checkout}/`)).toBe(true);
  });

  it("installs dependencies in that directory before anything invokes the CLI", () => {
    const checkout = /path:\s*(\S+)/.exec(workflow)?.[1] ?? "";
    const steps = workflow.split(/^      - /m);

    const install = steps.findIndex(
      (step) => /^run:\s*npm (?:ci|install)/.test(step) && step.includes(`working-directory: ${checkout}`),
    );
    const action = steps.findIndex((step) => step.includes("action/preserve@"));

    expect(install, "no npm install step for the vendored CLI").toBeGreaterThan(-1);
    expect(action).toBeGreaterThan(-1);
    // Order is the property. An install after the action is an install that never ran in time.
    expect(install).toBeLessThan(action);
  });

  it("installs without dev dependencies and without lifecycle scripts", () => {
    // This job holds a token with `contents: write` on refs/notes/commitlore, and it is installing
    // a third-party lockfile. `--ignore-scripts` is what keeps that from executing arbitrary
    // postinstall code with that token in the environment.
    const install = /run:\s*(npm (?:ci|install)[^\n]*)/.exec(workflow)?.[1] ?? "";

    expect(install).toContain("--ignore-scripts");
    expect(install).toContain("--omit=dev");
  });

  it("proves the CLI starts, rather than trusting that the install worked", () => {
    // The failure this file exists for was a CLI that could not start being reported as a parse
    // error. One version call before the action turns that class back into what it is.
    const steps = workflow.split(/^      - /m);
    const smoke = steps.findIndex((step) => /^run:\s*node \S*cli\.js --version/.test(step));
    const action = steps.findIndex((step) => step.includes("action/preserve@"));

    expect(smoke, "no step proves the vendored CLI can start").toBeGreaterThan(-1);
    expect(smoke).toBeLessThan(action);
  });
});
