#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const output = new URL('../dist/host/',import.meta.url);
mkdirSync(output,{recursive:true});
// The host script runs from source under Node's type stripping; the packaged copy imports the built modules.
const packaged = name => readFileSync(new URL(`./${name}`,import.meta.url),'utf8')
  .replaceAll('../src/core/digest.ts','../core/digest.js')
  .replaceAll('../src/core/process-argv.ts','../core/process-argv.js')
  .replaceAll('../src/runtime/host-provisioner-reason.ts','../runtime/host-provisioner-reason.js')
  .replaceAll('../src/runtime/cto-channel-launch.ts','../runtime/cto-channel-launch.js')
  .replaceAll('../src/cto/one-cto-per-project.ts','../cto/one-cto-per-project.js')
  .replaceAll('../src/outbox/ceo-buzz-signer.ts','../outbox/ceo-buzz-signer.js');
writeFileSync(new URL('host-project-provisioner.mjs',output),packaged('host-project-provisioner.mjs'),{mode:0o700});
