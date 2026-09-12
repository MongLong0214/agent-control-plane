/**
 * #833 — a peer-credential fd that is not a safe integer is refused before ToInt32 truncates it
 *
 * Each of the three operands on this line is the only thing that catches one ToInt32 form, and
 * every form folds to the same live fd. Measured: `fd + 2**32` is a safe integer, not negative,
 * above int32; `fd - 2**32` is a safe integer, below int32, negative; `fd + 0.5` is not a safe
 * integer, in range, not negative. The addon reads `fd` with `Napi::Number::Int32Value()`, which
 * is ECMAScript ToInt32 — reduction mod 2^32, not a range check — so a surviving form does not
 * return null, it returns that socket's real credentials for a number that looks nothing like a
 * small fd.
 *
 * Killed by the darwin test that holds a connected `AF_UNIX` pair: it first asserts the bare
 * `fd` returns credentials, which is the positive control that makes a null afterwards mean
 * "refused" rather than "the kernel call failed". The platform-independent cases cannot kill this
 * row — `-1`, `1.5`, `NaN` and `2**32 + 5` all fold to fds that are not connected sockets here,
 * so they return null whether the operand refused them or not.
 */
const aFractionalFdCannotReachTheAddon = {
  id: "a-fractional-fd-cannot-reach-the-addon",
  what: "an fd that is not a safe integer cannot reach the addon, where ToInt32 would truncate it onto a live fd",
  file: "src/core/peercred.ts",
  find: "  if (!Number.isSafeInteger(fd) || fd < 0 || fd > MAX_FD) return null;\n",
  replace: "  if (fd < 0 || fd > MAX_FD) return null;\n",
  killedBy: [
    "tests/unit/g5-peercred.test.ts::wires a real fd to the kernel call and refuses fd wraparound",
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default aFractionalFdCannotReachTheAddon;
