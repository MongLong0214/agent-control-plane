import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const src = join(root, "src");

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : path.endsWith(".ts") ? [path] : [];
  });

/**
 * Every non-code file a module reads beside itself (`new URL("./x.sql", import.meta.url)`), as the
 * path relative to `src`. A compiled module reads the same name beside itself under `dist`, so each
 * one has to be copied there by the build; tsc copies none of them.
 */
const assetsModulesRead = (): string[] =>
  [...new Set(sources(src).flatMap((file) => {
    const text = readFileSync(file, "utf8");
    return [...text.matchAll(/new URL\("\.\/([^"/]+\.(?:sql|md|json))"/g)].map((match) => relative(src, join(file, "..", match[1]!)));
  }))].sort();

/** What the build script copies from `src/<path>` to `dist/<path>`. */
const assetsTheBuildShips = (): string[] => {
  const build = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts["build"]!;
  return [...build.matchAll(/\bcp src\/(\S+) dist\/(\S+)/g)].filter((match) => match[1] === match[2]).map((match) => match[1]!).sort();
};

describe("the build ships every file a compiled module reads beside itself", () => {
  it("copies each frozen schema snapshot the migrations read, and every other such asset, to the same path under dist", () => {
    const read = assetsModulesRead();
    // The frozen snapshots a v56 build's migrations read, schema-v55.sql among them.
    expect(read).toEqual(expect.arrayContaining(["db/schema.sql", "db/schema-v54.sql", "db/schema-v55.sql"]));
    const shipped = assetsTheBuildShips();
    expect(read.filter((asset) => !shipped.includes(asset))).toEqual([]);
  });
});
