import { createHash } from 'node:crypto';
import { z } from 'zod';
import { digestOf } from '../core/digest.ts';
import type { ProjectManifest } from '../contracts/manifest.ts';

const text = z.string().max(1_000_000);
export const genesisPath = z.string().min(1).max(500).refine(p =>
  !p.startsWith('/') && !p.includes('\\') && p.split('/').every(s => s !== '' && s !== '.' && s !== '..' && s.toLowerCase() !== '.git'), 'unsafe genesis path');
export const genesisBundleSchema = z.object({
  schema: z.literal('acp.genesis-bundle.v1'), commitMessage: z.string().min(1).max(1000),
  files: z.array(z.object({ path: genesisPath, mode: z.enum(['100644', '100755']), contentBase64: text,
    sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict()).min(1).max(2000),
  branches: z.object({ main: z.literal('main'), integration: z.literal('dev'), genesis: z.literal('genesis') }).strict(),
  labels: z.array(z.object({ name: z.string().min(1), color: z.string().regex(/^[a-fA-F0-9]{6}$/), description: text }).strict()).max(50),
  milestones: z.array(z.object({ key: z.string().min(1), title: z.string().min(1), description: text }).strict()).max(50),
  issues: z.array(z.object({ key: z.string().min(1), title: z.string().min(1), body: text, labels: z.array(z.string()), milestoneKey: z.string().nullable() }).strict()).max(50),
  productIntent: z.object({ summary: text, references: z.array(text), ownerInstructions: z.array(text) }).strict(),
}).strict();
export type GenesisBundle = z.infer<typeof genesisBundleSchema>;
export const bytesDigest = (bytes: Uint8Array): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
// Never include the matching bytes in an error, audit event or subprocess output.
export function screenPublicText(value: string): void {
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|sk-(?:proj-)?[A-Za-z0-9_-]{20,})\b|(?:password|passwd|api[_-]?key|secret|access[_-]?token)\s*[:=]\s*["']?[^\s"']{8,}/i.test(value)) {
    throw new Error('credential-shaped content refused before publication');
  }
}
export function parseGenesis(value: unknown, manifest?: ProjectManifest): GenesisBundle {
  const bundle = genesisBundleSchema.parse(value);
  const paths = new Set<string>();
  let total = 0;
  for (const file of bundle.files) {
    if (paths.has(file.path)) throw new Error('duplicate genesis path');
    paths.add(file.path);
    const bytes = Buffer.from(file.contentBase64, 'base64');
    if (bytes.toString('base64') !== file.contentBase64 || bytesDigest(bytes) !== file.sha256) throw new Error('genesis bytes/digest mismatch');
    total += bytes.length;
    if (total > 20_000_000) throw new Error('genesis bundle exceeds byte limit');
    screenPublicText(bytes.toString('utf8'));
  }
  for (const p of paths) for (const q of paths) if (q.startsWith(`${p}/`)) throw new Error('genesis file/directory collision');
  screenPublicText(JSON.stringify({ ...bundle, files: [] }));
  for (const key of ['labels', 'milestones', 'issues'] as const) {
    const values = bundle[key].map(x => 'key' in x ? x.key : x.name);
    if (new Set(values).size !== values.length) throw new Error(`duplicate genesis ${key}`);
  }
  for (const issue of bundle.issues) {
    if (issue.labels.some(l => !bundle.labels.some(x => x.name === l)) || (issue.milestoneKey !== null && !bundle.milestones.some(m => m.key === issue.milestoneKey))) throw new Error('unknown issue label/milestone');
  }
  if (manifest) {
    if (!/^[a-z0-9][a-z0-9._-]{0,80}$/.test(manifest.projectId)) throw new Error("project id must be safe for resident allocation");
    const profile = manifest.branchProfile;
    if (JSON.stringify(profile.longLived.slice().sort()) !== '["dev","main"]' || profile.defaultBranch !== 'dev' || profile.mergeStrategy !== 'merge_commit' || profile.releaseTagPolicy !== 'semver') throw new Error('genesis requires main/dev git flow');
    if (!manifest.ciWorkflows.length || !manifest.verificationCommands.length) throw new Error('genesis requires real tests and CI');
    for (const workflow of manifest.ciWorkflows) {
      const file = bundle.files.find(f => f.path === workflow.path);
      if (!file || workflow.approvedDigest !== file.sha256) throw new Error('CI must be pinned to genesis workflow SHA-256');
    }
    const required = manifest.verificationCommands.map(c => c.id);
    if (!required.every(id => manifest.verificationProfiles.standard.includes(id))) throw new Error('STANDARD_WORK must run the real tests');
    for (const command of manifest.verificationCommands) {
      if (command.argv[0] === 'git' || command.cwd !== '.') throw new Error('genesis requires a repository test command');
      // Supported launchers are bounded execFile commands, never a shell supplied by the PLAN.
      if (!['node', 'pnpm', 'npm', 'python3', 'cargo', 'go'].includes(command.argv[0] ?? '')) throw new Error('unsupported genesis verification executable');
      const [bin,...args] = command.argv;
      if (bin === 'node' && (!args.some(a => a === '--test' || /(?:test|verify).*\.[cm]?js$/.test(a)) || args.includes('-e') || args.includes('--eval'))) throw new Error('node verification must run tests');
      if (bin === 'node' && !bundle.files.some(f => /(?:test|verify).*\.[cm]?js$/.test(f.path))) throw new Error('test source missing from genesis');
      if (bin === 'pnpm' || bin === 'npm') {
        const file = bundle.files.find(f => f.path === 'package.json');
        const pkg = file ? JSON.parse(Buffer.from(file.contentBase64,'base64').toString('utf8')) as {scripts?:Record<string,string>} : null;
        const task = args[0] === 'run' ? args[1] : args[0];
        if (!task || !pkg?.scripts?.[task] || !/(?:test|vitest|jest|mocha|pytest)/.test(pkg.scripts[task]!)) throw new Error('package test script missing');
      }
      if (bin === 'cargo' && (!args.includes('test') || !paths.has('Cargo.toml'))) throw new Error('cargo tests missing');
      if (bin === 'go' && (!args.includes('test') || !paths.has('go.mod'))) throw new Error('go tests missing');
      if (bin === 'python3' && (!args.includes('pytest') || !bundle.files.some(f => /test.*\.py$/.test(f.path)))) throw new Error('python tests missing');
    }
  }
  return bundle;
}
export const genesisDigest = (value: unknown): string => digestOf(parseGenesis(value));
