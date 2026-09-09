#!/bin/sh
# #817 — the program `runHermesTargetBind` spawns has to be an executable at a path: production
# hands it `hermesExecutable` and appends its own `target bind --json`, so there is no argv slot a
# fixture could use to name an interpreter. A fixture that wrote that program at run time created a
# new inode, and macOS assesses every new inode from zero — the shape measured on this machine at
# over 120 seconds, wedging syspolicyd.
#
# So the executable is this file: checked in, one inode per checkout, assessed once. What varies per
# test is data. The caller writes ${HERMES_HOME}/producer.mjs and links ${HERMES_HOME}/node to the
# Node binary already running the suite; HERMES_HOME is one of the three variables production sets,
# and the environment it spawns with carries no PATH, so both must be reached by absolute path.
#
# `exec` replaces this shell rather than forking, so there is exactly one child pid: the caller's
# stdin, its stdout capture, and its timeout signal reach the producer exactly as they reached a
# directly-spawned program.
exec "$HERMES_HOME/node" "$HERMES_HOME/producer.mjs" "$@"
