import { cpSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * #1268 — a CommitLore installation laid out as CommitLore's installer lays one out, for a fixture CLI: a package
 * (`pkg/package.json`, publishing `dist`, and the bundle `pkg/dist/commitlore.mjs`) and the wrapper
 * (`commitlore`, `# commitlore:wrapper:v1`) that execs node on the bundle. A CommitLore run copies the package
 * the wrapper names and runs that copy, so a fixture is a package, never a bare script.
 *
 * `body` is the fixture's program as a CommonJS script without its `#!` line: it runs inside a function in the
 * bundle, with `require`, so a bare `return` and `require(...)` behave as they did in the script. `version` is
 * the package's `version`, which a checked run compares with what the bundle answers to `--version`.
 */
export const writeCommitLoreInstall = (
  dir: string,
  body: string,
  options: { version?: string; mode?: number } = {},
): { wrapper: string; bundle: string; pkg: string } => {
  const pkg = join(dir, "pkg");
  const bundle = join(pkg, "dist", "commitlore.mjs");
  mkdirSync(join(pkg, "dist"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "commitlore-fixture", version: options.version ?? "1.7.3", files: ["dist"] }));
  writeFileSync(
    bundle,
    `import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\n(function () {\n${body}\n})();\n`,
    { mode: 0o700 },
  );
  const wrapper = join(dir, "commitlore");
  writeFileSync(wrapper, `#!/bin/sh\n# commitlore:wrapper:v1\nNODE="${process.execPath}"\nexec "$NODE" "${bundle}" "$@"\n`, {
    mode: options.mode ?? 0o700,
  });
  return { wrapper, bundle, pkg };
};

/** The package version a fixture answering `answer` to `--version` states: that answer when it is one, else 1.7.3. */
export const packageVersionFor = (answer: string): string => (/^\d+\.\d+\.\d+$/.test(answer.trim()) ? answer.trim() : "1.7.3");

/**
 * #1268 — a copy of the real CLI's installation, laid out as its installer lays one out — the package's published
 * files and a `# commitlore:wrapper:v1` wrapper that execs node on its bundle — found the way the real wrapper
 * names its bundle. A witness may replace the copy's bundle while leaving its wrapper as it is.
 */
export const installedCopyOf = (real: string, install: string): { wrapper: string; bundle: string } => {
  const target = realpathSync(real);
  const entry = target.endsWith(join("dist", "commitlore.mjs"))
    ? target
    : /^exec "\$NODE" "([^"\n]+)" "\$@"$/m.exec(readFileSync(target, "utf8"))?.[1];
  if (entry === undefined) throw new Error("FIXTURE FAILURE: the real CLI is neither CommitLore's wrapper nor its bundle");
  const root = dirname(dirname(entry));
  const pkg = join(install, "pkg");
  for (const name of ["package.json", "dist", "spec"]) cpSync(join(root, name), join(pkg, name), { recursive: true });
  const wrapper = join(install, "commitlore");
  writeFileSync(wrapper, `#!/bin/sh\n# commitlore:wrapper:v1\nNODE="${process.execPath}"\nexec "$NODE" "${join(pkg, "dist", "commitlore.mjs")}" "$@"\n`, {
    mode: 0o755,
  });
  return { wrapper, bundle: join(pkg, "dist", "commitlore.mjs") };
};
