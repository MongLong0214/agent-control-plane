#!/usr/bin/env python3
"""Runs one command on a pseudo-terminal and relays this process's pipes to it.

Why this exists at all: the client build under qualification is only the build that can
hold the canonical claim when it was started *interactively*, and an interactive start is
decided by the terminal, not by an argument. Node has no way to allocate a pty, and
macOS `script(1)` calls `tcgetattr` on its own stdin and dies with
"Operation not supported on socket" when that stdin is a pipe -- which it always is under
a spawned child. The standard library's `pty` module is the one allocator available
without adding a dependency to this repository.

Deliberately not a terminal emulator. Bytes go through untouched in both directions; the
window size is fixed so the child renders at a known width instead of at whatever a
zero-sized pty would make it do. The caller reads raw escape sequences and is expected to
say so.

The exit status is the child's, re-raised through `waitstatus_to_exitcode`, so a caller
that reads only the exit code cannot mistake a failed exec for a completed run.
"""
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios

ROWS = 40
COLS = 120
CHUNK = 65536
POLL_SECONDS = 0.2


def main() -> int:
    argv = sys.argv[1:]
    if not argv:
        print("pty-session.py: expected a command to run", file=sys.stderr)
        return 2

    pid, master_fd = pty.fork()
    if pid == 0:
        # Child. execvp replaces this process, so anything after it only runs on failure.
        try:
            os.execvp(argv[0], argv)
        finally:
            os._exit(127)

    fcntl.ioctl(master_fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))

    # The child of `pty.fork` is in a session of its own, so killing this relay does not kill it.
    # A grandchild that outlives its wrapper keeps writing into a temp root the caller is about to
    # remove, which is how the caller's teardown first failed: ENOTEMPTY on a directory that had
    # been emptied a moment earlier. Terminating on the way out is this process's job because it
    # is the only one holding the child's pid.
    def relay_terminated(_signum, _frame):
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
        os._exit(143)

    for caught in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(caught, relay_terminated)

    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()
    # Once our own stdin reaches EOF, selecting on it again spins; drop it and keep
    # relaying the child, which is the side the caller is measuring.
    watched = [master_fd, stdin_fd]

    while True:
        try:
            readable, _, _ = select.select(watched, [], [], POLL_SECONDS)
        except (OSError, InterruptedError):
            break
        if master_fd in readable:
            try:
                data = os.read(master_fd, CHUNK)
            except OSError:
                data = b""
            if not data:
                break
            os.write(stdout_fd, data)
        if stdin_fd in readable:
            try:
                data = os.read(stdin_fd, CHUNK)
            except OSError:
                data = b""
            if data:
                os.write(master_fd, data)
            else:
                watched = [master_fd]

    try:
        os.close(master_fd)
    except OSError:
        pass
    _, status = os.waitpid(pid, 0)
    return os.waitstatus_to_exitcode(status)


sys.exit(main())
