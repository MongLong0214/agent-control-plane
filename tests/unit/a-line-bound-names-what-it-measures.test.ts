import { readFileSync } from "node:fs";
import { Socket } from "node:net";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { MAX_LOCAL_SOCKET_FRAMED_REQUEST_BYTES, readOneJsonLineRequest } from "../../src/daemon/local-socket-framing.ts";

/**
 * #816. Two readers on these sockets bound a line by the byte offset of its terminator, and four
 * bound it by the length of everything buffered. Both are correct for the reader that uses them —
 * the first serves a stream of messages, the second takes one request per connection and refuses
 * anything after the newline — but until this test they named the same constant, so the bound a
 * call site read did not say which of the two it was. A line of exactly the limit's content plus
 * its terminator was accepted by the transport and refused by the readers, and nothing at either
 * site said so.
 *
 * The property is a naming one, so this reads the source rather than the behaviour: a bound is
 * measured one way. Behaviour is what the two limits already have tests for, and neither of them
 * can see this, because both measurements are correct where they stand.
 */
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/** The files that declare or consume a byte bound over this daemon's newline framing. */
const SUBJECTS = ["src/daemon/agentcpd.ts", "src/daemon/local-socket-framing.ts"];

/**
 * The callee compares this argument against its accumulated buffer, terminator included, so a
 * bound handed to it is measured the same way as one compared against `.length` here.
 */
const FRAMED_BOUND_PARAMETER = { callee: "readOneJsonLineRequest", parameterIndex: 4 };

type Measurement = "the line's content, terminator excluded" | "the whole buffer, terminator included";

interface Reading {
  bound: string;
  measurement: Measurement;
  where: string;
}

const isBoundName = (name: string): boolean => /bytes$/i.test(name);

const walk = (node: ts.Node, visit: (node: ts.Node) => void): void => {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
};

/**
 * Every place this source states a byte bound, with what the bound is compared against. An
 * unclassifiable comparison is returned as a problem rather than skipped: a reader that quietly
 * drops the site it cannot read reports agreement it never looked for.
 */
const readBounds = (fileName: string, source: string): { readings: Reading[]; problems: string[] } => {
  const tree = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const readings: Reading[] = [];
  const problems: string[] = [];
  const at = (node: ts.Node): string => {
    const { line } = tree.getLineAndCharacterOfPosition(node.getStart(tree));
    return `${fileName}:${line + 1}`;
  };
  walk(tree, (node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.GreaterThanToken &&
      ts.isIdentifier(node.right) &&
      isBoundName(node.right.text)
    ) {
      const bound = node.right.text;
      const left = node.left;
      if (ts.isPropertyAccessExpression(left) && left.name.text === "length") {
        readings.push({ bound, measurement: "the whole buffer, terminator included", where: at(node) });
      } else if (ts.isIdentifier(left) && left.text === "boundary") {
        readings.push({ bound, measurement: "the line's content, terminator excluded", where: at(node) });
      } else {
        problems.push(`${at(node)}: cannot tell what \`${left.getText(tree)} > ${bound}\` measures`);
      }
      return;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === FRAMED_BOUND_PARAMETER.callee
    ) {
      const argument = node.arguments[FRAMED_BOUND_PARAMETER.parameterIndex];
      if (argument && ts.isIdentifier(argument) && isBoundName(argument.text)) {
        readings.push({
          bound: argument.text,
          measurement: "the whole buffer, terminator included",
          where: at(argument),
        });
      }
    }
  });
  return { readings, problems };
};

/** Bounds this source measures more than one way, rendered for an assertion message. */
const boundsMeasuredTwoWays = (readings: Reading[]): string[] => {
  const byBound = new Map<string, Reading[]>();
  for (const reading of readings) byBound.set(reading.bound, [...(byBound.get(reading.bound) ?? []), reading]);
  return [...byBound.entries()]
    .filter(([, group]) => new Set(group.map((reading) => reading.measurement)).size > 1)
    .map(([bound, group]) =>
      `${bound} is measured ${new Set(group.map((r) => r.measurement)).size} ways: ${
        group.map((r) => `${r.where} measures ${r.measurement}`).join("; ")
      }`);
};

describe("a byte bound on this daemon's newline framing names what it measures (#816)", () => {
  const readings: Reading[] = [];
  const problems: string[] = [];
  for (const subject of SUBJECTS) {
    const read = readBounds(subject, readFileSync(`${repoRoot}/${subject}`, "utf8"));
    readings.push(...read.readings);
    problems.push(...read.problems);
  }

  it("reads every bound comparison in its subjects", () => {
    // A check whose reader matched nothing reports agreement over zero sites. The count is a
    // floor rather than the exact number so adding a bounded reader does not fail this.
    expect(problems).toEqual([]);
    expect(readings.length).toBeGreaterThanOrEqual(7);
  });

  it("measures each bound exactly one way", () => {
    expect(boundsMeasuredTwoWays(readings)).toEqual([]);
  });

  it("reports a bound that is measured both ways", () => {
    // The check must be able to fail. This is the shape it exists to catch, built here rather
    // than by mutating a subject so the arm keeps its meaning when the subjects change.
    const synthetic = [
      "const MAX_SHARED_BYTES = 10;",
      "const stream = (buffer: Buffer): void => {",
      "  const boundary = buffer.indexOf(0x0a);",
      "  if (boundary > MAX_SHARED_BYTES) return;",
      "};",
      "const single = (buffer: Buffer): void => {",
      "  if (buffer.length > MAX_SHARED_BYTES) return;",
      "};",
    ].join("\n");
    const read = readBounds("synthetic.ts", synthetic);
    expect(read.problems).toEqual([]);
    expect(boundsMeasuredTwoWays(read.readings)).toHaveLength(1);
    expect(boundsMeasuredTwoWays(read.readings)[0]).toContain("MAX_SHARED_BYTES is measured 2 ways");
  });
});

/**
 * The one reader of a framed bound that can be reached without standing up a listener. The three
 * inline readers in `agentcpd.ts` are module-private; what keeps them honest here is that their
 * edit is an identifier substitution to a constant declared as the one they used to name, so
 * nothing about what they accept moved. This is the behaviour the name now promises, pinned.
 */
const MESSAGES = { tooLarge: "too large", multipleRequests: "two requests", notJson: "not JSON" };

/** A socket driven by `emit` rather than a kernel, with the no-op error listener #805 needed. */
const drivenSocket = (): Socket => {
  const socket = new Socket();
  socket.on("error", () => {});
  return socket;
};

/** A JSON object line whose UTF-8 byte length is exactly `bytes`, terminator excluded. */
const requestOfBytes = (bytes: number): string => {
  const skeleton = JSON.stringify({ method: "x", pad: "" });
  const line = JSON.stringify({ method: "x", pad: "a".repeat(bytes - skeleton.length) });
  if (Buffer.byteLength(line) !== bytes) throw new Error(`built ${Buffer.byteLength(line)} bytes, wanted ${bytes}`);
  return line;
};

const deliver = (payload: string): { lines: unknown[]; refusals: string[] } => {
  const socket = drivenSocket();
  const lines: unknown[] = [];
  const refusals: string[] = [];
  try {
    readOneJsonLineRequest(socket, MESSAGES, (value) => lines.push(value), (decision) => {
      if (!decision.allowed) refusals.push(decision.message);
    });
    socket.emit("data", Buffer.from(payload));
  } finally {
    socket.destroy();
  }
  return { lines, refusals };
};

describe("the framed request bound counts the terminator, as its name says (#816)", () => {
  it("accepts a request whose content and terminator together are exactly the bound", () => {
    const line = requestOfBytes(MAX_LOCAL_SOCKET_FRAMED_REQUEST_BYTES - 1);
    const { lines, refusals } = deliver(`${line}\n`);
    expect(refusals).toEqual([]);
    expect(lines).toHaveLength(1);
  });

  it("refuses a request whose content alone is the bound, because the terminator is counted too", () => {
    const line = requestOfBytes(MAX_LOCAL_SOCKET_FRAMED_REQUEST_BYTES);
    const { lines, refusals } = deliver(`${line}\n`);
    expect(refusals).toEqual([MESSAGES.tooLarge]);
    expect(lines).toEqual([]);
  });

  it("still refuses a genuinely oversized request", () => {
    const line = requestOfBytes(MAX_LOCAL_SOCKET_FRAMED_REQUEST_BYTES * 2);
    const { lines, refusals } = deliver(`${line}\n`);
    expect(refusals).toEqual([MESSAGES.tooLarge]);
    expect(lines).toEqual([]);
  });

  it("still refuses bytes after the first terminator", () => {
    const { lines, refusals } = deliver(`{"method":"x"}\n{"method":"y"}\n`);
    expect(refusals).toEqual([MESSAGES.multipleRequests]);
    expect(lines).toEqual([]);
  });
});
