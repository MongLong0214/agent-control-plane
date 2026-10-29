#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const output = new URL('../dist/host/',import.meta.url);
mkdirSync(output,{recursive:true});
const source = readFileSync(new URL('./host-project-provisioner.mjs',import.meta.url),'utf8')
  .replaceAll('../src/core/digest.ts','../core/digest.js')
  .replaceAll('../src/core/process-argv.ts','../core/process-argv.js')
  .replaceAll('../src/outbox/ceo-buzz-signer.ts','../outbox/ceo-buzz-signer.js');
writeFileSync(new URL('host-project-provisioner.mjs',output),source,{mode:0o700});
writeFileSync(new URL('resident-fleet-up.mjs',output),readFileSync(new URL('./resident-fleet-up.mjs',import.meta.url)),{mode:0o700});
