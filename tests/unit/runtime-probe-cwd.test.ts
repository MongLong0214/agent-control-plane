import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const adapterUrl = new URL("../../src/runtime/cli-adapters.ts", import.meta.url).href;

// A fresh process owns HOME and cwd: no global chdir/env races with other tests,
// and every denied path contains only synthetic data, never host credentials.
it.skipIf(process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec"))
  .each(["ClaudeCliAdapter", "CodexCliAdapter"])(
    "%s probes from private scratch while retaining authority denials",
    (adapter) => {
      const root = mkdtempSync(join(tmpdir(), "acp-probe-cwd-test-"));
      try {
        const home = join(root, "home");
        const state = join(home, ".agent-control-plane");
        const cwd = join(state, "runtime", "generation-fixture");
        mkdirSync(cwd, { recursive: true });
        const denied = [
          join(state, "state.fixture"),
          join(home, ".ssh", "key.fixture"),
          join(home, ".config", "gh", "token.fixture"),
          join(home, "Library", "Keychains", "login.fixture"),
          join(root, "explicit-deny.fixture"),
        ];
        for (const path of denied) {
          mkdirSync(join(path, ".."), { recursive: true });
          writeFileSync(path, "synthetic-only", { mode: 0o600 });
        }
        const fixture = join(root, "version-fixture.cjs");
        writeFileSync(fixture, `#!${process.execPath}
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
assert.deepEqual(process.argv.slice(2), ['--version']);
const cwd = process.cwd();
// TMPDIR is already canonicalized by production; walking its denied ancestors
// with realpathSync would test a forbidden operation rather than usable cwd.
assert.equal(cwd, process.env.TMPDIR);
assert.equal(fs.statSync(cwd).mode & 0o777, 0o700);
assert.equal(path.basename(cwd).startsWith('acp-runtime-'), true);
fs.writeFileSync(path.join(cwd, 'owned-marker'), 'synthetic-only');
for (const target of ${JSON.stringify(denied)}) {
  assert.throws(() => fs.readFileSync(target), e => e.code === 'EPERM' || e.code === 'EACCES');
  assert.throws(() => fs.writeFileSync(target, 'forbidden'), e => e.code === 'EPERM' || e.code === 'EACCES');
}
assert.equal(process.env.ACP_SYNTHETIC_SECRET, undefined);
assert.equal(process.env.PATH.split(':').includes(${JSON.stringify(root)}), false);
console.log('fixture 1.0');
`, { mode: 0o700 });
        const script = `
import assert from 'node:assert/strict';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const nativeSpawn = childProcess.spawn;
let cliErrors = '';
childProcess.spawn = (...args) => {
  const child = nativeSpawn(...args);
  child.stderr?.on('data', chunk => { cliErrors += chunk; });
  return child;
};
syncBuiltinESMExports();
const { ${adapter}: Adapter } = await import(${JSON.stringify(adapterUrl)});
const cwd = process.cwd();
const options = {
  binary: ${JSON.stringify(fixture)},
  clock: { nowIso: () => '2026-01-01T00:00:00.000Z' },
  capacityFile: ${JSON.stringify(join(state, "capacity.fixture"))},
  denyReadPaths: [${JSON.stringify(denied[4])}],
  providerCredentialDir: ${JSON.stringify(join(home, "provider-fixture"))},
};
const scratchRoot = join(process.env.HOME, '.agent-control-plane', 'scratch');
const pending = [new Adapter(options).probeRuntime(), new Adapter(options).probeRuntime()];
// Both calls allocate before either child can settle: they must not share cwd.
const owned = readdirSync(scratchRoot);
assert.equal(owned.length, 2);
assert.notEqual(owned[0], owned[1]);
const health = await Promise.all(pending);
assert.deepEqual(readdirSync(scratchRoot), [], 'success/failure cleanup');
assert.equal(process.cwd(), cwd, 'parent cwd unchanged');
assert.deepEqual(health, ['HEALTHY', 'HEALTHY'], cliErrors);
assert.equal(await new Adapter({ ...options, binary: '/usr/bin/false' }).probeRuntime(), 'UNAVAILABLE');
assert.equal(await new Adapter({ ...options, binary: ${JSON.stringify(join(root, "absent-cli"))} }).probeRuntime(), 'UNAVAILABLE');
assert.deepEqual(readdirSync(scratchRoot), [], 'nonzero/spawn-error cleanup');
for (const name of owned) assert.equal(existsSync(join(scratchRoot, name)), false);
for (const target of ${JSON.stringify(denied)}) assert.equal(readFileSync(target, 'utf8'), 'synthetic-only');
`;
        const result = spawnSync(process.execPath, [
          "--experimental-transform-types", "--input-type=module", "-e", script,
        ], {
          cwd,
          env: {
            HOME: home,
            PATH: `${root}:/usr/bin:/bin`,
            ACP_SYNTHETIC_SECRET: "synthetic-only",
            NODE_DISABLE_COMPILE_CACHE: "1",
          },
          encoding: "utf8",
          timeout: 45_000,
        });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
        expect(existsSync(root)).toBe(false);
      }
    },
  );
