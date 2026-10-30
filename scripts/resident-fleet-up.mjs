#!/usr/bin/env node
// The fleet watcher calls this once per recovery sweep, alongside its existing non-ACP entries.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { formatHostProvisionerReason, readHostProvisionerReason, recordedResidentExitStatus } from '../src/runtime/host-provisioner-reason.ts';
const home = process.env.HOME;
const script = process.env.ACP_HOST_PROJECT_PROVISIONER;
if (!home || !script || !process.env.ACP_STATE_DIR) throw new Error('resident fleet recovery requires HOME, ACP_STATE_DIR and ACP_HOST_PROJECT_PROVISIONER');
const dir = join(home,'.claude','watchers','fleet');
const host = (request, operation, packet = request.packet) =>
  execFileSync(process.execPath,[resolve(script)],{input:JSON.stringify({...request,version:1,operation,packet}),env:process.env,timeout:120_000,maxBuffer:2_000_000,stdio:['pipe','pipe','pipe'],encoding:'utf8'});
for (const name of readdirSync(dir).filter(n => n.endsWith('.resident.json'))) {
  const request = JSON.parse(readFileSync(join(dir,name),'utf8'));
  try {host(request,'ensure-resident');} catch (error) {
    // No daemon pass resumes a completed provisioning row, so this sweep is the consumer of Claude's
    // recorded exit: the reason goes to the watcher's log first, then is acknowledged and recovered.
    // Claude failing in ensure-resident's own `claude mcp` calls has the same reason shape; only the host's
    // exit status says the refusal is the recorded exit, and anything else is never acknowledged.
    const reason = readHostProvisionerReason(String(error.stderr ?? ''),'ensure-resident');
    let recovered = false;
    if (reason && error.status === recordedResidentExitStatus) {
      process.stderr.write(`resident exited: ${name}: ${formatHostProvisionerReason(reason)}\n`);
      try {host(request,'acknowledge-resident-exit',{residentExitReason:reason});host(request,'ensure-resident');recovered = true;} catch { /* Reported as pending below. */ }
    } else if (reason) process.stderr.write(`resident provisioning failed: ${name}: ${formatHostProvisionerReason(reason)}\n`);
    if (!recovered) {process.stderr.write(`resident recovery pending: ${name}\n`);process.exitCode = 1;}
  }
}
