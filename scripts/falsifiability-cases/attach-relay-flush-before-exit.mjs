/**
 * The CLI turns this relay's resolved value into `process.exit`, and under Claude Code stdout is a
 * pipe. `process.exit` keeps only what the kernel already accepted, so resolving while a write is
 * still queued in userspace drops the tail of the daemon's MCP stream — measured on this host at
 * 769 001 of 900 073 bytes, which reaches Claude Code as a JSON-RPC line that stops mid-token.
 *
 * The mutation is the pre-repair code exactly: end stdout and resolve in the same turn. Only a test
 * with a real pipe, a payload past the pipe buffer and a reader stalled at the moment of exit can
 * see the difference — an in-process `PassThrough` has neither a kernel buffer nor a `process.exit`
 * behind it, and passes either way.
 */
const attachRelayFlushBeforeExit = {
  id: "attach-relay-flush-before-exit",
  what: "the relay resolves only once its stdout has flushed, so process.exit cannot truncate the stream",
  file: "src/cli/attach-relay.ts",
  find: "      if (stdoutFailed || io.stdout.writableFinished) return settle(code);\n      io.stdout.once(\"finish\", () => settle(code));\n      if (!io.stdout.writableEnded) io.stdout.end();\n",
  replace: "      if (!io.stdout.writableEnded) io.stdout.end();\n      settle(code);\n",
  killedBy: ["tests/process/attach-relay-process.test.ts::flushes every byte it piped to stdout before the process exits, with the reader stalled"],
};

export default attachRelayFlushBeforeExit;
