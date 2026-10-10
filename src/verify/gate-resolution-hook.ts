import { pathToFileURL } from "node:url";

/**
 * RF-S22 (#1082 R1-02, round 5) — the module loader every protected gate entry runs under.
 *
 * Pinning a gate's files does not pin what its specifiers load. Node chooses the file for a
 * `#name` specifier from the nearest package.json `imports`, for a bare specifier from the
 * candidate's node_modules and that package's `main` or `exports`, and for a directory from its
 * package.json `main` -- all files the candidate owns. A closure review flipped an unchanged gate's
 * verdict by editing only `routing/package.json`, so that `require('../routing')` loaded a bypass
 * file instead of the declared helper; and a gate that loads candidate code in-process can be
 * short-circuited by that code.
 *
 * So ACP launches a command that runs a gate entry as `node --import=<this preload> <entry>`. The
 * preload registers a synchronous resolve hook (`module.registerHooks`, which covers both `require`
 * and `import`; Node 22.15 and later, and every 24) that admits exactly two kinds of load:
 *
 * - a node builtin, except `worker_threads`: a worker runs its module graph without this hook
 *   (measured: an eval worker under the preload loaded a file the hook refuses on the main
 *   thread);
 * - a specifier that is a path -- `./`, `../`, `/` or `file:` -- naming one of the command's
 *   declared gate files exactly. Node must resolve it to the very file it names, so extension
 *   probing, a directory's `main` or `index` and a symlink are refused too.
 *
 * Any other load throws `ACP_GATE_RESOLUTION_REFUSED` inside the gate, so the gate errors and its
 * verdict is a failure, never a pass. What a specifier loads is then a function of the pinned bytes
 * alone. That also means a gate cannot load candidate code or dependencies in-process: it reads
 * candidate files as data. (Spawning a process does not escape the hook in production either: the
 * sandbox runs the command under RLIMIT_NPROC 1.)
 *
 * The preload is a `data:` URL ACP builds from this file, not a file it points at: nothing is read
 * from the candidate, the sandbox needs no read rule for ACP's own install, and the declared paths
 * travel inside it. A node without `registerHooks` fails the preload before the entry starts, so a
 * gate is never run unhooked. The candidate cannot add or remove it: the manifest refuses any node
 * option before a gate entry, and the sandbox environment drops NODE_OPTIONS.
 */
export const GATE_RESOLUTION_REFUSED = "ACP_GATE_RESOLUTION_REFUSED";

/** The preload's own source. Plain JavaScript: node evaluates it before anything else runs. */
const preloadSource = (declaredUrls: readonly string[]): string => [
  'import nodeModule from "node:module";',
  "if (typeof nodeModule.registerHooks !== \"function\") {",
  "  throw new Error(\"ACP will not run a gate entry without module.registerHooks: this node cannot enforce which files the gate loads\");",
  "}",
  `const declared = new Set(${JSON.stringify(declaredUrls)});`,
  "const pathLike = /^(?:\\.{1,2}\\/|\\/|file:)/;",
  "const unhookedBuiltins = new Set([\"worker_threads\", \"node:worker_threads\"]);",
  "const refuse = (specifier, parentURL, why) => {",
  "  const error = new Error(`ACP refused to load '${specifier}'${parentURL ? ` from ${parentURL}` : \"\"}: ${why}`);",
  `  error.code = ${JSON.stringify(GATE_RESOLUTION_REFUSED)};`,
  "  throw error;",
  "};",
  "nodeModule.registerHooks({",
  "  resolve(specifier, context, nextResolve) {",
  "    if (nodeModule.isBuiltin(specifier)) {",
  "      if (unhookedBuiltins.has(specifier)) refuse(specifier, context.parentURL, \"a worker would run without this loader\");",
  "      return nextResolve(specifier, context);",
  "    }",
  "    if (context.parentURL !== undefined && !pathLike.test(specifier)) {",
  "      refuse(specifier, context.parentURL, \"a gate loads only a declared gate file, by a relative path, or a node builtin\");",
  "    }",
  "    const resolved = nextResolve(specifier, context);",
  "    if (context.parentURL !== undefined && resolved.url !== new URL(specifier, context.parentURL).href) {",
  "      refuse(specifier, context.parentURL, `it resolves to ${resolved.url}, not to the file it names`);",
  "    }",
  "    if (!declared.has(resolved.url)) refuse(specifier, context.parentURL, \"it is not a declared gate file\");",
  "    return resolved;",
  "  },",
  "});",
  "",
].join("\n");

/**
 * The node option that installs the preload for a command whose declared gate files are
 * `declaredPaths`: absolute, real paths in the command's materialised worktree.
 */
export const gateResolutionPreload = (declaredPaths: readonly string[]): string =>
  `--import=data:text/javascript,${encodeURIComponent(preloadSource(declaredPaths.map((path) => pathToFileURL(path).href)))}`;
