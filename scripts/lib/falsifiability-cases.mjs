/**
 * Loads one falsifiability row per module out of `scripts/falsifiability-cases/`.
 *
 * The table in `verify-guards-are-falsifiable.mjs` is one array in one file, and every branch
 * appends to its end. Whether two branches conflict is then decided by where each happened to
 * insert, not by whether the changes say anything about each other. Measured on 2026-09-01 with
 * three open branches that only append rows (+218/+148/+93, zero deletions against their
 * merge-bases): two conflict, one does not.
 *
 * The cost is not the conflict. It is the manual resolution, which has twice cut an object
 * boundary and left a file that does not parse — while `grep -c "what:"` counted 298 rows and
 * called it verified. Row arithmetic is not verification (#741).
 *
 * A directory of one-row modules removes the shared insertion point: two branches adding two
 * differently-named files touch disjoint paths and git has nothing to reconcile.
 *
 * What that structure buys has to be paid for, and this file is the payment. A loader that
 * shrugs at a module it could not read is strictly worse than the array it replaces: the array
 * at least took the whole harness down with it, whereas `try { await import(f) } catch {}`
 * removes a row from the sweep and reports the survivors as a full pass. So every condition
 * below throws, and the harness runs this before it reads its own table, before it takes a
 * snapshot, and before it mutates anything — a broken case has no path to a count check.
 *
 * Dependency-free, in the shape of the other verify scripts (PRD §17.4).
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Where the modules live, relative to the repository root. Named once; used by every consumer. */
export const CASES_DIR = "scripts/falsifiability-cases";

/**
 * Exactly the keys a row may carry.
 *
 * Refusing an unknown key is the half that catches a typo. `killedby` on a row is not a row with
 * a missing `killedBy` — it is a row that looks complete to a reader and is missing the only
 * field that decides whether the mutation is watched. The array had no such check because an
 * object literal in a shared file gets read by whoever reviews the diff around it; a file of its
 * own is read by nobody after the day it lands.
 */
const ALLOWED_FIELDS = new Set(["id", "what", "file", "find", "replace", "killedBy", "symbols", "skip"]);
const REQUIRED_STRING_FIELDS = ["id", "what", "file", "find"];

/** `id` is the row's stable name: what `--only=` can select and what duplicate detection compares. */
const ID_SHAPE = /^[a-z0-9][a-z0-9-]*$/;

class CaseLoadError extends Error {}

const refuse = (moduleName, detail) => {
  throw new CaseLoadError(`${CASES_DIR}/${moduleName}: ${detail}`);
};

/**
 * Reads every case module, in a stable order, and refuses anything it cannot vouch for.
 *
 * Sorted by file name with the default (code-unit) comparator rather than a locale one: the sweep
 * order has to be identical on every machine, and `localeCompare` is not.
 *
 * @param {string} root absolute path to the repository root
 * @returns {Promise<object[]>} the rows, in file-name order
 */
export const loadFalsifiabilityCases = async (root) => {
  const dir = join(root, CASES_DIR);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new CaseLoadError(
      `${CASES_DIR} does not exist. The harness loads its rows from there; a missing directory is` +
        " zero rows, and zero rows is a sweep that passes having checked nothing.",
    );
  }

  const moduleNames = readdirSync(dir)
    .filter((name) => name.endsWith(".mjs"))
    .sort();

  // An empty directory reads as "every case passed" to anything that counts failures. It is the
  // same silence as a skipped module, arriving one level up.
  if (moduleNames.length === 0) {
    throw new CaseLoadError(
      `${CASES_DIR} holds no .mjs case modules. An empty directory is not a clean sweep; it is a` +
        " sweep with no subject.",
    );
  }

  const rows = [];
  const seenIds = new Map();

  for (const moduleName of moduleNames) {
    let namespace;
    try {
      namespace = await import(pathToFileURL(join(dir, moduleName)).href);
    } catch (error) {
      // The condition acceptance 2 is about. A syntax error surfaces here, from `import`, before
      // the harness has read its own table or touched the working tree — so there is no ordering
      // in which a broken case module is counted rather than parsed.
      refuse(moduleName, `could not be loaded — ${error.message}`);
    }

    // An ESM namespace enumerates its exported names. One row per module means one export, and
    // `export default [a, b]` is caught a few lines below by the array check.
    const exported = Object.keys(namespace).sort();
    if (exported.length !== 1 || exported[0] !== "default") {
      refuse(
        moduleName,
        `must have exactly one export (\`export default\`); it exports ${exported.length === 0 ? "nothing" : exported.map((n) => JSON.stringify(n)).join(", ")}.` +
          " One module is one row; a second export is a row this harness would never see.",
      );
    }

    const row = namespace.default;
    if (Array.isArray(row)) {
      refuse(
        moduleName,
        `exports an array of ${row.length} row(s). One module is one row — an array reintroduces` +
          " the shared insertion point this directory exists to remove.",
      );
    }
    if (row === null || typeof row !== "object") {
      refuse(moduleName, `must default-export a row object; it exported ${row === null ? "null" : typeof row}.`);
    }

    for (const key of Object.keys(row)) {
      if (!ALLOWED_FIELDS.has(key)) {
        refuse(
          moduleName,
          `has an unrecognised field ${JSON.stringify(key)}. Allowed: ${[...ALLOWED_FIELDS].join(", ")}.`,
        );
      }
    }
    for (const key of REQUIRED_STRING_FIELDS) {
      if (typeof row[key] !== "string" || row[key] === "") {
        refuse(moduleName, `field ${JSON.stringify(key)} must be a non-empty string.`);
      }
    }
    // `replace: ""` is the ordinary case — most mutations delete the guard — so it is checked for
    // type only, and its absence is a row whose mutation is undefined rather than empty.
    if (typeof row.replace !== "string") {
      refuse(moduleName, 'field "replace" must be a string ("" deletes the guarded line).');
    }
    if (!ID_SHAPE.test(row.id)) {
      refuse(moduleName, `id ${JSON.stringify(row.id)} is not lower-case kebab (${ID_SHAPE}).`);
    }
    if (seenIds.has(row.id)) {
      refuse(
        moduleName,
        `id ${JSON.stringify(row.id)} is already used by ${seenIds.get(row.id)}. Two rows under one` +
          " name make `--only=` ambiguous and a report unattributable.",
      );
    }
    seenIds.set(row.id, moduleName);

    if (!Array.isArray(row.killedBy) || row.killedBy.length === 0) {
      refuse(moduleName, 'field "killedBy" must be a non-empty array of test selectors.');
    }
    for (const entry of row.killedBy) {
      if (typeof entry !== "string" || entry === "") {
        refuse(moduleName, 'every "killedBy" entry must be a non-empty string.');
      }
      // `vitest run <path>` exits non-zero when the path matches no file, and this harness reads a
      // non-zero exit as "the guard was killed". So a `killedBy` naming a file that is not there
      // reports a kill forever, having run no test at all. `--anchors-only` already catches this
      // for the array; catching it at load means a case module cannot be added in that state.
      const testPath = entry.includes("::") ? entry.slice(0, entry.indexOf("::")) : entry;
      if (!existsSync(join(root, testPath))) {
        refuse(
          moduleName,
          `killedBy names ${testPath}, which does not exist — vitest exits non-zero for a missing` +
            " path, so this row would report a kill it never ran.",
        );
      }
    }
    if (row.symbols !== undefined && !Array.isArray(row.symbols)) {
      refuse(moduleName, 'field "symbols", when present, must be an array of enforcement loci.');
    }

    rows.push(row);
  }

  return rows;
};
