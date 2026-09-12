import { sep } from "node:path";

import { describe, expect, it } from "vitest";

import { isWithin } from "../../src/guard/workspace-probe.ts";

/**
 * `isWithin` decides whether a path lies inside a workspace root, and every caller uses it to
 * decide whether a write is inside the scope it was granted. Its two operands were unanswered in
 * the census, and each answers an input the other cannot:
 *
 *     isWithin("/a", "/a")    the root itself   — only `child === p`
 *     isWithin("/a", "/a/b")  a real child      — only `startsWith(p + sep)`
 *
 * Measured both ways before writing the rows: removing `child === p` makes the root stop being
 * within itself (a root would fail its own scope check), and removing the prefix test makes every
 * genuine child fall outside it.
 */
const root = `${sep}a`;

describe("a path is within its parent, and a shared prefix is not", () => {
  it("counts the root itself as within itself", () => {
    // Only `child === p` answers this: `"/a".startsWith("/a/")` is false.
    expect(isWithin(root, root)).toBe(true);
  });

  it("counts a real child as within", () => {
    // Only the prefix test answers this: `"/a/b" === "/a"` is false.
    expect(isWithin(root, `${root}${sep}b`)).toBe(true);
  });

  it("does not count a sibling that merely shares a prefix", () => {
    // The control, and the reason the prefix test appends the separator. Without `+ sep` a
    // `startsWith` check reads `/ab` as inside `/a`, which is how a scope check comes to admit a
    // directory nobody granted.
    expect(isWithin(root, `${sep}ab`)).toBe(false);
    expect(isWithin(root, `${sep}a-other`)).toBe(false);
  });

  it("does not count a parent as within its own child", () => {
    expect(isWithin(`${root}${sep}b`, root)).toBe(false);
  });

  it("treats a trailing separator on the root as the same root", () => {
    // The normalisation in front of both operands: `/a/` and `/a` are the same parent, and
    // without it `p + sep` would be `/a//` and no child would match.
    expect(isWithin(`${root}${sep}`, `${root}${sep}b`)).toBe(true);
    expect(isWithin(`${root}${sep}`, root)).toBe(true);
  });
});
