#!/usr/bin/env node
// The fleet watcher calls this once per recovery sweep, alongside its existing non-ACP entries.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const home = process.env.HOME;
const script = process.env.ACP_HOST_PROJECT_PROVISIONER;
if (!home || !script || !process.env.ACP_STATE_DIR) throw new Error('resident fleet recovery requires HOME, ACP_STATE_DIR and ACP_HOST_PROJECT_PROVISIONER');
const dir = join(home,'.claude','watchers','fleet');
for (const name of readdirSync(dir).filter(n => n.endsWith('.resident.json'))) {
  const request = JSON.parse(readFileSync(join(dir,name),'utf8'));
  try {
    execFileSync(process.execPath,[resolve(script)],{input:JSON.stringify({...request,version:1,operation:'ensure-resident'}),env:process.env,timeout:120_000,maxBuffer:2_000_000,stdio:['pipe','pipe','pipe']});
  } catch {process.stderr.write(`resident recovery pending: ${name}\n`);process.exitCode = 1;}
}
