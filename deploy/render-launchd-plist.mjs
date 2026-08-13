#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";

const [templatePath, outputPath, launcher, workingDirectory, stdoutPath, stderrPath, home, path] = process.argv.slice(2);

if (![templatePath, outputPath, launcher, workingDirectory, stdoutPath, stderrPath, home, path].every(Boolean)) {
  throw new Error("usage: render-launchd-plist.mjs <template> <output> <launcher> <working-dir> <stdout> <stderr> <home> <path>");
}
for (const [name, value] of Object.entries({ outputPath, launcher, workingDirectory, stdoutPath, stderrPath, home })) {
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
}

const xml = (value) => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&apos;");

const replacements = {
  __ACP_LAUNCHER__: launcher,
  __ACP_WORKING_DIRECTORY__: workingDirectory,
  __ACP_STDOUT_PATH__: stdoutPath,
  __ACP_STDERR_PATH__: stderrPath,
  __ACP_HOME__: home,
  __ACP_PATH__: path,
};

let rendered = readFileSync(templatePath, "utf8");
for (const [token, value] of Object.entries(replacements)) {
  if (!rendered.includes(token)) throw new Error(`template is missing ${token}`);
  rendered = rendered.replaceAll(token, xml(value));
}
if (rendered.includes("__ACP_")) throw new Error("rendered plist still contains an unresolved placeholder");
writeFileSync(outputPath, rendered, { encoding: "utf8", mode: 0o600 });
