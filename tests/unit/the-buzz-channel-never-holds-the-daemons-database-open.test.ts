import { execFileSync, spawn } from "node:child_process";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import {
  backlogReader,
  ceoPubkeyResolver,
  readDaemonDb,
  type DaemonDbOpener,
  type DaemonReads,
} from "../../src/buzz/buzz-channel-daemon-reads.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * A deploy stops the daemon and then needs zero processes holding its database. A CTO's channel server is a long-lived
 * process beside every CTO session, and it read the database through one handle it opened once and kept: its file, its
 * -wal and its -shm stayed open for as long as the session lived (deploy136 aborted on two of them: "DB writers still open
 * after the stop"). The channel now opens the database for one read and closes it again in a `finally`; between reads it
 * holds nothing, and what it remembers (the CEO's key, for five seconds) is a value in memory.
 */

const Database = createRequire(import.meta.url)("better-sqlite3") as new (
  path: string,
  options?: { readonly?: boolean; fileMustExist?: boolean; timeout?: number },
) => {
  pragma(source: string): unknown;
  exec(source: string): void;
  prepare(source: string): { get(...params: unknown[]): unknown };
  close(): void;
};

/** An opener whose handles are counted: how many were opened, how many are open now, and the most at once. */
const countingOpener = (options: { readonly closeThrows?: boolean; readonly cannotOpen?: boolean; readonly rows?: Record<string, unknown> } = {}) => {
  const state = { opened: 0, closed: 0, open: 0, mostAtOnce: 0 };
  const opener: DaemonDbOpener = () => {
    if (options.cannotOpen === true) return null;
    state.opened += 1;
    state.open += 1;
    state.mostAtOnce = Math.max(state.mostAtOnce, state.open);
    const reads: DaemonReads = {
      get: <T>(sql: string) => options.rows?.[sql] as T | undefined,
      all: <T>() => [] as T[],
    };
    return {
      reads,
      close: () => {
        state.closed += 1;
        state.open -= 1;
        if (options.closeThrows === true) throw new Error("close failed");
      },
    };
  };
  return { opener, state };
};

describe("a read opens the daemon's database for itself and closes it again", () => {
  it("returns what the read found and leaves nothing open", () => {
    const c = countingOpener();
    expect(readDaemonDb("/state", () => 42, c.opener)).toBe(42);
    expect(c.state).toMatchObject({ opened: 1, closed: 1, open: 0 });
  });

  it("closes the handle when the read throws, and lets the error through", () => {
    const c = countingOpener();
    expect(() => readDaemonDb("/state", () => { throw new Error("a query failed"); }, c.opener)).toThrow("a query failed");
    expect(c.state).toMatchObject({ opened: 1, closed: 1, open: 0 });
  });

  it("is not undone by a close that fails: the read's answer stands, and the throw does not escape", () => {
    const c = countingOpener({ closeThrows: true });
    expect(readDaemonDb("/state", () => "answer", c.opener)).toBe("answer");
    expect(c.state).toMatchObject({ opened: 1, closed: 1, open: 0 });
  });

  it("answers null, with nothing to close, when the database cannot be opened", () => {
    const c = countingOpener({ cannotOpen: true });
    expect(readDaemonDb("/state", () => 1, c.opener)).toBeNull();
    expect(c.state.open).toBe(0);
  });
});

describe("the CEO's key is remembered as a value, not as a handle", () => {
  it("opens for the first read, answers the next ones within five seconds from memory, and holds nothing between", () => {
    const c = countingOpener();
    let now = 1_000_000;
    const ceoKeys = ceoPubkeyResolver("/state", { open: c.opener, now: () => now });
    expect(ceoKeys()).toEqual([]);
    expect(c.state).toMatchObject({ opened: 1, closed: 1, open: 0 });
    now += 4_999;
    ceoKeys();
    ceoKeys();
    expect(c.state.opened).toBe(1);
    // After the five seconds it asks again, and closes again.
    now += 2;
    ceoKeys();
    expect(c.state).toMatchObject({ opened: 2, closed: 2, open: 0, mostAtOnce: 1 });
  });

  it("hears nobody, and holds nothing, when a read fails or the database cannot be opened", () => {
    const failing: DaemonDbOpener = () => ({ reads: { get: () => { throw new Error("locked"); }, all: () => [] }, close: () => undefined });
    expect(ceoPubkeyResolver("/state", { open: failing })()).toEqual([]);
    const none = countingOpener({ cannotOpen: true });
    expect(ceoPubkeyResolver("/state", { open: none.opener })()).toEqual([]);
  });
});

describe("the queue is read the same way", () => {
  it("opens for the one read and closes it, every time it is asked", () => {
    const c = countingOpener();
    const backlog = backlogReader("/state", "demo", c.opener);
    expect(backlog()).toEqual([]);
    expect(backlog()).toEqual([]);
    expect(c.state).toMatchObject({ opened: 2, closed: 2, open: 0, mostAtOnce: 1 });
  });

  it("is an empty queue when the database cannot be opened", () => {
    expect(backlogReader("/state", "demo", countingOpener({ cannotOpen: true }).opener)()).toEqual([]);
  });
});

describe("against a real SQLite database in WAL mode, as the daemon keeps it", () => {
  const world = () => {
    const dir = realpathSync(tempDir("acp-channel-db-"));
    const path = join(dir, "state.sqlite");
    const daemon = new Database(path);
    daemon.pragma("journal_mode = WAL");
    daemon.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('one')");
    return { dir, path, daemon };
  };

  /** Every descriptor this process holds on the database's files: lsof's `n` lines for state.sqlite, -wal and -shm. */
  const held = (dir: string): string[] => {
    const out = execFileSync("lsof", ["-p", String(process.pid), "-Fn"], { encoding: "utf8", maxBuffer: 8_000_000, timeout: 15_000 });
    return out.split("\n").filter((line) => line.startsWith("n") && line.includes(join(dir, "state.sqlite")));
  };
  const hasLsof = ((): boolean => {
    try {
      execFileSync("lsof", ["-p", String(process.pid), "-Fn"], { stdio: "ignore", maxBuffer: 8_000_000, timeout: 15_000 });
      return true;
    } catch {
      return false;
    }
  })();

  it("reads the database and holds no descriptor on it afterwards", () => {
    const w = world();
    const value = readDaemonDb(w.dir, (db) => db.get<{ v: string }>("SELECT v FROM t"));
    expect(value).toEqual({ v: "one" });
    // The daemon's own connection is the only one left: the read added nothing to it.
    w.daemon.close();
    if (hasLsof) expect(held(w.dir)).toEqual([]);
  });

  /**
   * The daemon as a process of its own, as it is in production: SQLite keeps a descriptor open past its close while another
   * connection of the same process holds a lock on the file, so a stand-in daemon in the test's own process would hide
   * exactly what is being measured.
   */
  const daemons: ReturnType<typeof spawn>[] = [];
  afterEach(() => {
    for (const child of daemons.splice(0)) child.kill("SIGKILL");
  });
  const daemonProcess = async (path: string): Promise<void> => {
    const driver = createRequire(import.meta.url).resolve("better-sqlite3");
    const child = spawn(
      process.execPath,
      ["-e", `const D = require(process.argv[1]); const db = new D(process.argv[2]); db.pragma("journal_mode = WAL");
        db.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('one')"); console.log("ready"); setInterval(() => {}, 1e6);`, driver, path],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    daemons.push(child);
    await new Promise<void>((resolve, reject) => {
      child.stdout!.once("data", () => resolve());
      child.once("exit", () => reject(new Error("the stand-in daemon exited before it was ready")));
    });
  };

  it.skipIf(!hasLsof)("opens a descriptor for the read, and has given every one back by the time the read returns", async () => {
    const dir = realpathSync(tempDir("acp-channel-db-"));
    await daemonProcess(join(dir, "state.sqlite"));
    expect(held(dir)).toEqual([]);
    let during = 0;
    const value = readDaemonDb(dir, (db) => {
      const row = db.get<{ v: string }>("SELECT v FROM t");
      during = held(dir).length;
      return row;
    });
    expect(value).toEqual({ v: "one" });
    // The measurement can see a handle (the read has the file, and -shm or -wal with it) ...
    expect(during).toBeGreaterThan(0);
    // ... and after the read this process holds none of the database's files: a deploy that stops the daemon finds no holder.
    expect(held(dir)).toEqual([]);
  });

  it.skipIf(!hasLsof)("holds no descriptor between reads however many it makes, the CEO's key and the queue alike", async () => {
    const dir = realpathSync(tempDir("acp-channel-db-"));
    await daemonProcess(join(dir, "state.sqlite"));
    let now = 0;
    const ceoKeys = ceoPubkeyResolver(dir, { now: () => now });
    const backlog = backlogReader(dir, "demo");
    for (let i = 0; i < 4; i += 1) {
      now += 6_000;
      // The stand-in daemon has no queue tables, so both queries fail inside SQLite: the CEO's key is then nobody's, and
      // the queue's error goes to its caller (the relay reports it and carries on). Either way nothing stays open.
      expect(ceoKeys()).toEqual([]);
      expect(() => backlog()).toThrow(/no such table/u);
      expect(held(dir)).toEqual([]);
    }
  });

  it("lets the daemon's successor take the database exclusively once the daemon has stopped", () => {
    const w = world();
    readDaemonDb(w.dir, (db) => db.get("SELECT v FROM t"));
    w.daemon.close();
    const successor = new Database(w.path, { timeout: 200 });
    successor.pragma("locking_mode = EXCLUSIVE");
    expect(() => {
      successor.exec("BEGIN EXCLUSIVE");
      successor.exec("INSERT INTO t VALUES ('two')");
      successor.exec("COMMIT");
    }).not.toThrow();
    successor.close();
  });

  it("control: a read-only handle that is kept open does stop that successor, so the check above can fail", () => {
    const w = world();
    const kept = new Database(w.path, { readonly: true, fileMustExist: true });
    kept.prepare("SELECT v FROM t").get();
    w.daemon.close();
    const successor = new Database(w.path, { timeout: 200 });
    successor.pragma("locking_mode = EXCLUSIVE");
    let blocked = false;
    try {
      successor.exec("BEGIN EXCLUSIVE");
      successor.exec("COMMIT");
    } catch {
      blocked = true;
    } finally {
      successor.close();
    }
    expect(blocked).toBe(true);
    kept.close();
  });
});

describe("no other path of the channel keeps the database", () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const channelSources = [
    ...readdirSync(join(root, "src", "buzz")).filter((name) => name.startsWith("buzz-channel")).map((name) => join("src", "buzz", name)),
    join("src", "cli", "buzz-channel.ts"),
  ];
  const readsModule = join("src", "buzz", "buzz-channel-daemon-reads.ts");

  /**
   * Every call of the daemon's database opener in `files`, and every variable, parameter or field whose type holds what one
   * returns, each as `file function: calls|keeps text`. A call is the opener's when what it returns is an `OpenedDaemonDb`,
   * so `openDaemonDb(stateDir)`, an injected `options.open(stateDir)` and an alias are found alike, whatever their names.
   * `planted` adds sources that exist only for this census, at the path given, so a control can show what it must see.
   */
  const openerCensus = (files: readonly string[], planted: Readonly<Record<string, string>>): string[] => {
    const options = ts.convertCompilerOptionsFromJson(
      (ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile).config as { compilerOptions: unknown }).compilerOptions,
      root,
    ).options;
    const host = ts.createCompilerHost(options);
    const plants = new Map(Object.entries(planted).map(([file, text]) => [join(root, file), text]));
    const { fileExists, readFile, getSourceFile } = host;
    host.fileExists = (path) => plants.has(path) || fileExists(path);
    host.readFile = (path) => plants.get(path) ?? readFile(path);
    host.getSourceFile = (path, language, ...rest) => {
      const text = plants.get(path);
      return text === undefined ? getSourceFile(path, language, ...rest) : ts.createSourceFile(path, text, language);
    };
    const roots = [...files.map((file) => join(root, file)), ...plants.keys()];
    const program = ts.createProgram(roots, options, host);
    const checker = program.getTypeChecker();
    const module = checker.getSymbolAtLocation(program.getSourceFile(join(root, readsModule))!)!;
    const opened = checker.getDeclaredTypeOfSymbol(checker.getExportsOfModule(module).find((symbol) => symbol.name === "OpenedDaemonDb")!);
    const holdsOpened = (type: ts.Type): boolean => type === opened || (type.isUnion() && type.types.includes(opened));
    const enclosing = (node: ts.Node): string => {
      for (let at = node.parent; at !== undefined; at = at.parent) {
        if (ts.isConstructorDeclaration(at)) return "constructor";
        if (ts.isFunctionLike(at) && at.name !== undefined) return at.name.getText();
        if (ts.isFunctionLike(at) && ts.isVariableDeclaration(at.parent)) return at.parent.name.getText();
        if (ts.isClassLike(at) && at.name !== undefined) return at.name.text;
      }
      return "(module)";
    };
    const found: string[] = [];
    for (const path of roots) {
      const record = (node: ts.Node, what: string): void => {
        found.push(`${relative(root, path)} ${enclosing(node)}: ${what}`);
      };
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const signature = checker.getResolvedSignature(node);
          if (signature !== undefined && holdsOpened(checker.getReturnTypeOfSignature(signature))) record(node, `calls ${node.getText()}`);
        }
        if (
          (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isPropertyDeclaration(node) || ts.isBindingElement(node)) &&
          holdsOpened(checker.getTypeAtLocation(node.name))
        ) {
          record(node, `keeps ${node.name.getText()}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(program.getSourceFile(path)!);
    }
    return found;
  };
  const buzzSources = [
    ...readdirSync(join(root, "src", "buzz")).filter((name) => name.endsWith(".ts")).map((name) => join("src", "buzz", name)),
    join("src", "cli", "buzz-channel.ts"),
  ];
  // What the control plants: a channel function that calls openDaemonDb() itself and keeps it, and a field kept from an
  // injected opener. They share the census's one program, since building that program is most of what the census costs.
  const direct = join("src", "buzz", "buzz-channel-planted-direct.ts");
  const injected = join("src", "buzz", "buzz-channel-planted-injected.ts");
  const plants = {
    [direct]: `import { openDaemonDb } from "./buzz-channel-daemon-reads.ts";
      export const keepsTheDatabase = (stateDir: string) => {
        const db = openDaemonDb(stateDir);
        return () => db?.reads.get<{ v: string }>("SELECT v FROM t");
      };`,
    [injected]: `import type { DaemonDbOpener, OpenedDaemonDb } from "./buzz-channel-daemon-reads.ts";
      export class KeepsAnInjectedHandle {
        readonly #db: OpenedDaemonDb | null;
        constructor(stateDir: string, options: { readonly open: DaemonDbOpener }) {
          this.#db = options.open(stateDir);
        }
      }`,
  };
  let censused: string[] | undefined;
  const census = (): string[] => (censused ??= openerCensus(buzzSources, plants));
  const isPlanted = (line: string): boolean => line.startsWith(direct) || line.startsWith(injected);

  it("opens SQLite in one place, the daemon-reads module, and nowhere else in the channel", () => {
    expect(channelSources.length).toBeGreaterThan(3);
    const opening = channelSources.filter((file) => /better-sqlite3|new Database\(|node:sqlite|DatabaseSync/u.test(readFileSync(join(root, file), "utf8")));
    expect(opening).toEqual([readsModule]);
  });

  it("calls the opener in one place, readDaemonDb, and nothing in src/buzz or the entry keeps what it returns", () => {
    expect(buzzSources.length).toBeGreaterThan(5);
    expect(census().filter((line) => !isPlanted(line))).toEqual([
      `${readsModule} readDaemonDb: keeps opened`,
      `${readsModule} readDaemonDb: calls open(stateDir)`,
    ]);
  });

  it("control: the census sees a channel function that calls openDaemonDb() itself and keeps it, and a field kept from an injected opener", () => {
    expect(census().filter(isPlanted)).toEqual([
      `${direct} keepsTheDatabase: keeps db`,
      `${direct} keepsTheDatabase: calls openDaemonDb(stateDir)`,
      `${injected} KeepsAnInjectedHandle: keeps #db`,
      `${injected} constructor: calls options.open(stateDir)`,
    ]);
  });

  it("never keeps what the opener returns: the entry has no handle variable, only readers that open for one read", () => {
    const entry = readFileSync(join(root, "src", "cli", "buzz-channel.ts"), "utf8");
    expect(entry).not.toMatch(/openDaemon|\bdaemon\s*(:|=|\?\?=)/u);
    expect(entry).toMatch(/ceoPubkeyResolver\(/u);
    expect(entry).toMatch(/backlogReader\(/u);
    const reads = readFileSync(join(root, readsModule), "utf8");
    // The one call of the opener (counted by the census above) is inside the function that closes what it opened.
    expect(reads).toMatch(/finally\s*\{[^}]*close\(\)/u);
  });
});
