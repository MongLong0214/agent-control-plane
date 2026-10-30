#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const output = new URL('../dist/host/',import.meta.url);
mkdirSync(output,{recursive:true});
// Both host scripts run from source under Node's type stripping; the packaged copies import the built modules.
const packaged = name => readFileSync(new URL(`./${name}`,import.meta.url),'utf8')
  .replaceAll('../src/core/digest.ts','../core/digest.js')
  .replaceAll('../src/core/process-argv.ts','../core/process-argv.js')
  .replaceAll('../src/runtime/host-provisioner-reason.ts','../runtime/host-provisioner-reason.js')
  .replaceAll('../src/outbox/ceo-buzz-signer.ts','../outbox/ceo-buzz-signer.js');
for (const name of ['host-project-provisioner.mjs','resident-fleet-up.mjs']) writeFileSync(new URL(name,output),packaged(name),{mode:0o700});
