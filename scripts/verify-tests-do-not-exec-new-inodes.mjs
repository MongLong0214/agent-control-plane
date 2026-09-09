#!/usr/bin/env node
/**
 * #817 — a test that writes a program and then execs it wedges this machine's Gatekeeper daemon.
 *
 * The deciding variable is the inode, not the file. macOS caches `SecStaticCodeCheckValidity` per
 * inode, so every new inode is a full validation from zero. Measured on 2026-09-09, on the machine
 * this repository is developed on:
 *
 *   a freshly written 3-line #!/bin/sh script, chmod +x, exec'd directly   > 120s, never returned
 *   the same bytes at the same path, run as `/bin/sh <path>`               0.02s  0.02s  0.02s
 *   a hardlink to the ~100MB node binary, exec'd directly                  0.76s
 *
 * A three-line script at a new inode wedges; a 100MB universal Mach-O at an existing inode does
 * not. `syspolicyd` wedged twice that day, the second time for over an hour, blocking a commit.
 * The stack sampled off the daemon was `MachORep::signingData -> Universal::architecture`.
 *
 * Two shapes avoid it and lose nothing:
 *
 *   - A fixture that needs a different path to the same program should `linkSync`, not copy. A
 *     hardlink is a different path at the same inode, so the assessment is already cached; where
 *     the fixture's contract is about realpath identity, the path still differs.
 *   - A script fixture should be invoked through an interpreter — `spawn("/bin/sh", [path])`
 *     rather than `chmod +x` and `spawn(path)`. Read as data by an already-assessed interpreter,
 *     the script never becomes an assessment subject.
 *
 * WHAT THIS CHECKS, and how much of it is honest.
 *
 * Under `tests/` and `scripts/`, per file, it pairs a creation with a use:
 *
 *   creation   `writeFileSync`/`writeFile`, `copyFileSync`/`cpSync`, or a spawned `cp`-family
 *              command — new bytes at a new inode. `chmodSync`/`chmod` to a mode carrying an exec
 *              bit does not create anything; it marks a path this file already wrote as one that
 *              was meant to be run.
 *   use        that same path in argv[0] of `spawn`/`spawnSync`/`execFile`/`execFileSync`/`fork`.
 *
 * Two verdicts, and the second one is the check admitting what it does not know:
 *
 *   EXECUTED    the created path reaches argv[0] in this file. This is the defect.
 *   UNRESOLVED  the created path carries a deliberate exec bit and then leaves the analysis —
 *               handed to a function this file does not declare, including inside an object
 *               literal. Nobody sets the exec bit on a file they only mean to read, so the intent
 *               is legible even where the exec site is not. The check refuses rather than guesses,
 *               and a site is answered by fixing it or by naming it in a declared list.
 *
 * Paths are followed inside one file. Identifiers resolve to the innermost enclosing function that
 * declares them, so two same-named locals in different functions stay apart. `const x = <expr>`
 * unifies its two sides; a call to a function declared in the same file unifies each argument with
 * the matching parameter, and the call's result — including an object destructured out of it —
 * with what that function returns. That is enough to see through the local fixture wrappers these
 * tests are written with. It is not a type-aware analysis: block scope is ignored, so two `const
 * path` declarations in different blocks of one function are still merged.
 *
 * WHAT IT CANNOT SEE — this is not complete coverage:
 *
 *   - a path that crosses a file boundary. The exec site is often in `src/`, which is not scanned;
 *     UNRESOLVED is where those land, and it cannot say which of them actually exec.
 *   - a command assembled as a shell string — `execSync(`${p} --flag`)`, `sh -c`, a Makefile, a
 *     `.sh` fixture, a workflow `run:` step. Only `node:child_process` argv[0] is read.
 *   - a path reached through an array element, a Map, a class field, a closure variable mutated
 *     later, or a name built at run time.
 *   - `chmod +x` performed by a spawned `chmod` rather than by `node:fs`, and a mode computed
 *     rather than written as a literal.
 *   - a program a dependency creates and execs on the suite's behalf.
 *   - whether any named site is ever reached. This reads syntax: a fixture inside a skipped suite
 *     counts exactly like one that runs.
 *
 * A clean run means "no pairing of this shape was found in the file that creates the bytes". It
 * never means "no test execs a new inode".
 *
 * sol-simplify: this exists because the defect is invisible in a diff and costs an hour of the
 * machine; retire it when fixture programs stop being created at run time.
 *
 * Usage: node scripts/verify-tests-do-not-exec-new-inodes.mjs
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { ALLOWED, UNFIXED } from "./lib/exec-at-new-inode-sites.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIRECTORIES = ["tests", "scripts"];
const SOURCE = /\.(?:[cm]?[jt]s|tsx)$/u;
const SKIP_DIRECTORIES = new Set(["node_modules", ".git", "dist"]);

/** argv[0] is the program. `exec`/`execSync` take a command string and are a documented blind spot. */
const EXEC_APIS = new Set(["spawn", "spawnSync", "execFile", "execFileSync", "fork"]);
/** A copy is new bytes at a new inode; a hardlink is not, which is the whole point. */
const COPY_TOOLS = new Set(["cp", "ditto", "install", "rsync"]);
/** Names that introduce a scope. Block scope is deliberately not one of them; see the header. */
const isScope = (node) => ts.isSourceFile(node) || ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) ||
  ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) ||
  ts.isSetAccessorDeclaration(node);

/**
 * Callees that cannot be an exec, so reaching one is not the path escaping the analysis.
 * Absence from this set is not an accusation: it only means the check stops and says so.
 */
const INERT = new Set([
  "access", "accessSync", "appendFile", "appendFileSync", "chmod", "chmodSync", "chown",
  "chownSync", "close", "closeSync", "copyFile", "copyFileSync", "cp", "cpSync",
  "createReadStream", "createWriteStream", "existsSync", "link", "linkSync", "lstat", "lstatSync",
  "mkdir", "mkdirSync", "mkdtemp", "mkdtempSync", "open", "openSync", "read", "readFile",
  "readFileSync", "readSync", "readdir", "readdirSync", "readlink", "readlinkSync", "realpath",
  "realpathSync", "rename", "renameSync", "rm", "rmSync", "rmdir", "rmdirSync", "stat", "statSync",
  "statfsSync", "symlink", "symlinkSync", "truncate", "truncateSync", "unlink", "unlinkSync",
  "utimes", "utimesSync", "watch", "write", "writeFile", "writeFileSync", "writeSync",
  "basename", "dirname", "extname", "format", "isAbsolute", "join", "normalize", "parse",
  "relative", "resolve", "toNamespacedPath", "fileURLToPath", "pathToFileURL",
  "afterAll", "afterEach", "assert", "beforeAll", "beforeEach", "deepEqual", "deepStrictEqual",
  "describe", "equal", "expect", "fail", "it", "notEqual", "ok", "strictEqual", "test",
  "toBe", "toBeDefined", "toBeFalsy", "toBeTruthy", "toContain", "toContainEqual", "toEqual",
  "toHaveBeenCalledWith", "toHaveLength", "toMatch", "toMatchObject", "toStrictEqual", "toThrow",
  "add", "concat", "delete", "digest", "endsWith", "error", "every", "filter", "find", "from",
  "get", "has", "includes", "indexOf", "info", "log", "map", "match", "push", "replace",
  "replaceAll", "set", "slice", "some", "sort", "split", "startsWith", "stringify", "trim",
  "unshift", "update", "warn",
  "Boolean", "Number", "String", "encodeURIComponent", "quote",
]);

const sourceFiles = (directory) =>
  readdirSync(join(ROOT, directory), { withFileTypes: true })
    .flatMap((entry) => {
      if (entry.isDirectory()) {
        return SKIP_DIRECTORIES.has(entry.name) ? [] : sourceFiles(join(directory, entry.name));
      }
      return entry.isFile() && SOURCE.test(entry.name) ? [join(directory, entry.name)] : [];
    })
    .sort();

const walk = (node, visit) => {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
};
const unparen = (node) => (node && ts.isParenthesizedExpression(node) ? unparen(node.expression) : node);
const calleeName = (node) => {
  const callee = unparen(node.expression);
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
};
/** An exec bit in a literal mode. A computed mode is unread, which the header states. */
const execMode = (node) => {
  const value = unparen(node);
  if (!value) return false;
  if (ts.isNumericLiteral(value)) return (Number(value.text) & 0o111) !== 0;
  if (ts.isStringLiteralLike(value)) return (Number.parseInt(value.text, 8) & 0o111) !== 0;
  return false;
};
const modeOption = (node) => {
  const options = unparen(node);
  if (!options || !ts.isObjectLiteralExpression(options)) return undefined;
  return options.properties.find((entry) => ts.isPropertyAssignment(entry) && entry.name &&
    ts.isIdentifier(entry.name) && entry.name.text === "mode")?.initializer;
};
const bindingNames = (name) => {
  if (ts.isIdentifier(name)) return [name.text];
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    return name.elements.flatMap((element) => (ts.isBindingElement(element) ? bindingNames(element.name) : []));
  }
  return [];
};

/** A union-find over path keys. Every merge is a claim that two texts name one file. */
const makeUnion = () => {
  const parent = new Map();
  const find = (key) => {
    if (!parent.has(key)) parent.set(key, key);
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root);
    let walker = key;
    while (parent.get(walker) !== walker) {
      const next = parent.get(walker);
      parent.set(walker, root);
      walker = next;
    }
    return root;
  };
  return { find, union: (a, b) => { const x = find(a), y = find(b); if (x !== y) parent.set(x, y); } };
};

const analyse = (file, source) => {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const enclosing = (node) => {
    let walker = node.parent;
    while (walker && !isScope(walker)) walker = walker.parent;
    return walker ?? tree;
  };
  const line = (node) => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;

  // Where each name is declared, so `path` in one helper is not `path` in another.
  const declared = new Map();
  const declare = (scope, name) => {
    const names = declared.get(scope.pos) ?? new Set();
    names.add(name);
    declared.set(scope.pos, names);
  };
  // Functions declared here, with their parameters and what they hand back: fixture helpers are
  // written as local wrappers, and a check that stops at the wrapper sees nothing.
  const locals = new Map();
  const declareLocal = (name, fn) => {
    if (!name || !fn.parameters) return;
    const returns = [];
    if (fn.body && !ts.isBlock(fn.body)) returns.push(fn.body);
    else if (fn.body) walk(fn.body, (node) => { if (ts.isReturnStatement(node) && node.expression) returns.push(node.expression); });
    locals.set(name, { parameters: [...fn.parameters], returns });
  };
  walk(tree, (node) => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
      for (const name of bindingNames(node.name)) declare(enclosing(node), name);
    }
    if (ts.isCatchClause(node) && node.variableDeclaration) {
      for (const name of bindingNames(node.variableDeclaration.name)) declare(enclosing(node), name);
    }
    if (ts.isFunctionDeclaration(node) && node.name) {
      declare(enclosing(node), node.name.text);
      declareLocal(node.name.text, node);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const initializer = unparen(node.initializer);
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
        declareLocal(node.name.text, initializer);
      }
    }
  });

  /** The nearest enclosing thing a person would name: a function, or the test it sits in. */
  const qualifier = (node) => {
    for (let walker = node; walker; walker = walker.parent) {
      if (ts.isFunctionDeclaration(walker) && walker.name) return walker.name.text;
      if ((ts.isArrowFunction(walker) || ts.isFunctionExpression(walker)) &&
        walker.parent && ts.isVariableDeclaration(walker.parent) && ts.isIdentifier(walker.parent.name)) {
        return walker.parent.name.text;
      }
      if (ts.isCallExpression(walker)) {
        const name = calleeName(walker), title = unparen(walker.arguments[0]);
        if ((name === "it" || name === "test" || name === "describe") && title && ts.isStringLiteralLike(title)) {
          return `${name} ${JSON.stringify(title.text)}`;
        }
      }
    }
    return "module";
  };
  const resolveScope = (node, name) => {
    let scope = enclosing(node);
    for (;;) {
      if (declared.get(scope.pos)?.has(name)) return scope;
      if (scope === tree) return tree;
      scope = enclosing(scope);
    }
  };
  const key = (node) => {
    const value = unparen(node);
    if (!value) return undefined;
    if (ts.isIdentifier(value)) return `id:${value.text}@${resolveScope(value, value.text).pos}`;
    if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value) ||
      ts.isCallExpression(value) || ts.isTemplateExpression(value) || ts.isBinaryExpression(value)) {
      return `expr:${value.getText(tree).replace(/\s+/gu, " ").trim()}@${enclosing(value).pos}`;
    }
    return undefined;
  };
  /** The key a declared list uses: content only, so it survives every line above it moving. */
  const siteKey = (node) => {
    const value = unparen(node);
    const name = ts.isIdentifier(value) ? `id:${value.text}`
      : `expr:${value.getText(tree).replace(/\s+/gu, " ").trim()}`;
    return `${name} in ${qualifier(value)}`;
  };

  const { find, union } = makeUnion();
  const creations = new Map(), chmods = [], execs = [], escapes = [];
  const record = (target, form, node) => {
    const path = key(target);
    if (!path) return;
    const existing = creations.get(path) ??
      { key: path, site: siteKey(target), forms: new Set(), lines: new Set(), execBit: false };
    existing.forms.add(form);
    existing.lines.add(line(node));
    creations.set(path, existing);
  };

  walk(tree, (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const initializer = unparen(node.initializer);
      const local = ts.isCallExpression(initializer) ? locals.get(calleeName(initializer) ?? "") : undefined;
      if (ts.isIdentifier(node.name)) {
        const left = `id:${node.name.text}@${enclosing(node).pos}`;
        if (local) {
          for (const returned of local.returns) {
            const right = key(returned);
            if (right) union(left, right);
          }
        } else {
          const right = key(node.initializer);
          if (right) union(left, right);
        }
      } else if (local && ts.isObjectBindingPattern(node.name)) {
        // `const { executable } = makeFixture()` — bind each name to the property the helper returns.
        for (const element of node.name.elements) {
          if (!ts.isIdentifier(element.name)) continue;
          const wanted = element.propertyName && ts.isIdentifier(element.propertyName)
            ? element.propertyName.text : element.name.text;
          const left = `id:${element.name.text}@${enclosing(node).pos}`;
          for (const returned of local.returns) {
            const object = unparen(returned);
            if (!object || !ts.isObjectLiteralExpression(object)) continue;
            for (const property of object.properties) {
              if (ts.isShorthandPropertyAssignment(property) && property.name.text === wanted) {
                const right = key(property.name);
                if (right) union(left, right);
              }
              if (ts.isPropertyAssignment(property) && property.name && ts.isIdentifier(property.name) &&
                property.name.text === wanted) {
                const right = key(property.initializer);
                if (right) union(left, right);
              }
            }
          }
        }
      }
    }
    if (!ts.isCallExpression(node)) return;
    const name = calleeName(node), args = node.arguments, local = name ? locals.get(name) : undefined;

    if (local) {
      args.forEach((argument, index) => {
        const parameter = local.parameters[index], argumentKey = key(argument);
        if (parameter && ts.isIdentifier(parameter.name) && argumentKey) {
          union(argumentKey, `id:${parameter.name.text}@${enclosing(parameter).pos}`);
        }
      });
    }

    if ((name === "writeFileSync" || name === "writeFile") && args[0]) {
      record(args[0], "writeFileSync", node);
      if (execMode(modeOption(args[2]))) {
        const path = key(args[0]);
        if (path) chmods.push({ key: path, line: line(node) });
      }
    }
    if ((name === "chmodSync" || name === "chmod") && args[0] && execMode(args[1])) {
      const path = key(args[0]);
      if (path) chmods.push({ key: path, line: line(node) });
    }
    if ((name === "copyFileSync" || name === "copyFile" || name === "cpSync" || name === "cp") && args[1]) {
      record(args[1], "copy", node);
    }
    // A locally declared `spawn` is a wrapper, not `node:child_process`; it is followed, not read.
    if (name && EXEC_APIS.has(name) && !local && args[0]) {
      const program = unparen(args[0]);
      const tool = ts.isStringLiteralLike(program) ? program.text.split("/").pop() : undefined;
      const vector = unparen(args[1]);
      if (tool && COPY_TOOLS.has(tool) && vector && ts.isArrayLiteralExpression(vector) && vector.elements.length) {
        record(vector.elements[vector.elements.length - 1], `${tool} (spawned)`, node);
      }
      const program_key = key(program);
      if (program_key) execs.push({ key: program_key, api: name, line: line(node) });
    }

    // A path handed to a function this file does not declare is a path this check stops following.
    // An argument vector is data for another program, so the exec APIs are read at argv[0] only.
    if (name && !local && !INERT.has(name) && !EXEC_APIS.has(name)) {
      for (const argument of args) {
        const reachable = [];
        const collect = (value) => {
          const inner = unparen(value);
          if (!inner) return;
          if (ts.isObjectLiteralExpression(inner)) {
            for (const property of inner.properties) {
              if (ts.isPropertyAssignment(property)) collect(property.initializer);
              if (ts.isShorthandPropertyAssignment(property)) {
                const found = key(property.name);
                if (found) reachable.push(found);
              }
            }
            return;
          }
          if (ts.isArrayLiteralExpression(inner)) {
            for (const element of inner.elements) collect(element);
            return;
          }
          if (ts.isIdentifier(inner)) {
            const found = key(inner);
            if (found) reachable.push(found);
          }
        };
        collect(argument);
        for (const found of reachable) escapes.push({ key: found, callee: name, line: line(node) });
      }
    }
  });

  // An exec bit only means something on bytes this file wrote. `chmod 0o500` on a directory
  // `mkdirSync` made is a permission fixture, not a program, and it is not a new inode of bytes.
  for (const creation of creations.values()) {
    const root = find(creation.key);
    for (const site of chmods) {
      if (find(site.key) !== root) continue;
      creation.execBit = true;
      creation.forms.add("chmod");
      creation.lines.add(site.line);
    }
  }

  const findings = [], undecided = [];
  for (const creation of creations.values()) {
    const root = find(creation.key);
    const executed = execs.filter((site) => find(site.key) === root);
    if (executed.length) {
      findings.push({ verdict: "EXECUTED", creation, sites: [...new Set(executed.map((site) => `${site.api}() at line ${site.line}`))] });
      continue;
    }
    if (!creation.execBit) continue;
    const escaped = escapes.filter((site) => find(site.key) === root);
    if (escaped.length) {
      findings.push({ verdict: "UNRESOLVED", creation, sites: [...new Set(escaped.map((site) => `${site.callee}() at line ${site.line}`))] });
      continue;
    }
    undecided.push({ creation });
  }
  return { parseFailed: tree.parseDiagnostics.length > 0, creations: creations.size, findings, undecided };
};

const files = DIRECTORIES.flatMap(sourceFiles).sort();
const problems = [], reported = [], unwatched = [];
let filesWithCreations = 0, totalCreations = 0;
for (const file of files) {
  const { parseFailed, creations, findings, undecided } = analyse(file, readFileSync(join(ROOT, file), "utf8"));
  if (parseFailed) problems.push(`${file}: cannot parse; nothing in it was read`);
  if (creations) filesWithCreations += 1;
  totalCreations += creations;
  for (const finding of findings) reported.push({ file, ...finding, site: `${file}::${finding.creation.site}` });
  for (const entry of undecided) unwatched.push({ file, site: `${file}::${entry.creation.site}`, lines: entry.creation.lines });
}

process.stdout.write(
  `CENSUS: read ${files.length} file(s) under ${DIRECTORIES.map((name) => `${name}/`).join(" and ")}; ` +
    `${filesWithCreations} of them write or copy ${totalCreations} path(s) this check can name; ` +
    `${totalCreations - reported.length - unwatched.length} of those path(s) carry no exec bit and ` +
    `reach no exec in the file that creates them.\n`,
);

let allowed = 0, unfixed = 0, open = 0;
const seen = new Set();
for (const finding of reported.sort((a, b) => a.site.localeCompare(b.site))) {
  const permanent = ALLOWED.get(finding.site), backlog = UNFIXED.get(finding.site);
  if (permanent) allowed += 1; else if (backlog) unfixed += 1; else open += 1;
  seen.add(finding.site);
  process.stdout.write(
    `  ${finding.verdict}  ${permanent ? "ALLOWED" : backlog ? "UNFIXED" : "OPEN"}  ${finding.file}\n` +
      `    ${finding.creation.site}\n` +
      `    created by ${[...finding.creation.forms].sort().join(", ")}` +
      ` at line ${[...finding.creation.lines].sort((a, b) => a - b).join(", ")}\n` +
      `    ${finding.verdict === "EXECUTED" ? "exec'd by" : "leaves this file through"} ${finding.sites.join("; ")}\n` +
      (permanent ?? backlog ? `    ${permanent ?? backlog}\n` : ""),
  );
}
for (const [site, reason] of [...ALLOWED, ...UNFIXED]) {
  if (!seen.has(site)) problems.push(`stale declared site, no longer found: ${site}`);
  else if (!reason.trim()) problems.push(`declared site has no reason: ${site}`);
}
// Everything the check refuses to guess about. A stub planted on PATH and a launcher installed
// for a supervisor both land here: the bytes are made runnable in this file and whoever runs them
// is somewhere else. Printed rather than counted, because a number hides which sites they are.
if (unwatched.length) {
  process.stdout.write(
    `NOT DECIDED — ${unwatched.length} path(s) are made executable in the file that writes them and ` +
      `reach no exec and no hand-off this check can follow. These are not cleared; they are unread.\n`,
  );
  for (const entry of unwatched.sort((a, b) => a.site.localeCompare(b.site))) {
    process.stdout.write(`  ${entry.site}  (line ${[...entry.lines].sort((a, b) => a - b).join(", ")})\n`);
  }
}
for (const problem of problems) process.stdout.write(`  ERROR: ${problem}\n`);

if (open || problems.length) {
  process.stdout.write(
    `RESULT: FAIL — ${open} site(s) create bytes at a new inode and run them, with no declared ` +
      `reason; ${problems.length} declaration error(s); ${allowed} allowed; ${unfixed} known and ` +
      `unfixed; ${unwatched.length} not decided.\n`,
  );
  process.exit(1);
}
process.stdout.write(
  `RESULT: PASS — no undeclared site pairs a creation with an exec; ${allowed} allowed, ` +
    `${unfixed} known and unfixed, ${unwatched.length} not decided and not failed. Syntax only, one ` +
    `file at a time: a path that crosses a file, a shell command string, or a run-time path is ` +
    `invisible here. PASS is not coverage of the not-decided list.\n`,
);
