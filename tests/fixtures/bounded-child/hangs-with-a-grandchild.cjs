// #872's hang fixture: a child that never exits and leaves a grandchild that never exits either.
//
// The grandchild writes its own pid to the path in argv[2] before hanging, so a test can ask the
// operating system whether it is still there after the bound expired. Without a process-group
// signal it is: measured at `grandchildStillAlive: true` against `spawnSync`'s own timeout, which
// reaps the direct child only.
const { spawn } = require("node:child_process");
const { writeFileSync, renameSync } = require("node:fs");
const { join, dirname } = require("node:path");

const marker = process.argv[2];
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });

// Published by rename, so a reader never sees the path at zero bytes: `open(O_CREAT|O_TRUNC)`
// makes the name visible before `write(2)` puts anything in it.
const staging = join(dirname(marker), `.${process.pid}.partial`);
writeFileSync(staging, String(child.pid));
renameSync(staging, marker);

setInterval(() => {}, 1000);
