import { createHash } from 'node:crypto';
import { z } from 'zod';
import { digestOf } from '../core/digest.ts';
import { acpError, isAcpError } from '../core/errors.ts';
import { ReasonCode } from '../core/reason-codes.ts';
import { workUnitMarkers } from './work-unit-marker.ts';
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
// Besides the generic shapes, this covers the Buzz/Nostr identity key the resident provisioner itself
// writes: 64 hex characters in `~/.hermes/bridge/keys/cto-<project>.priv` and in `BUZZ_PRIVATE_KEY`,
// assigned under any key-like name (quoted JSON/YAML keys included), as its bech32 `nsec1` form, or as a
// text that is nothing but that key, which is what a copied `.priv` file is.
const CREDENTIAL_SHAPES = [
  /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/i,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|sk-(?:proj-)?[A-Za-z0-9_-]{20,})\b/i,
  /(?:password|passwd|api[_-]?key|secret(?:[_-]?key)?|priv(?:ate)?[_-]?key|access[_-]?token)["']?\s*[:=]\s*["']?[^\s"']{8,}/i,
  /\bnsec1[a-z0-9]{20,}/i,
  /^\s*[0-9a-fA-F]{64}\s*$/,
];
export function screenPublicText(value: string): void {
  if (CREDENTIAL_SHAPES.some(shape => shape.test(value))) {
    throw new Error('credential-shaped content refused before publication');
  }
}
/** Every string a public sink receives, each screened on its own so a whole-value shape is seen. */
const publicStrings = (value: unknown): string[] =>
  typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(publicStrings)
    : value !== null && typeof value === 'object' ? Object.values(value).flatMap(publicStrings) : [];
const refuseGenesis = (refusal: string, message: string, evidence: Record<string, unknown>): never => {
  throw acpError(ReasonCode.INVALID_ARGUMENT, message, { refusal, ...evidence });
};
/**
 * #1240 — the genesis issues' structure and linkage, never their content: a work-unit marker links an
 * issue to one approved unit (`work-unit-marker.ts`), and blind review judges whether the issue covers it.
 * A genesis has at least one issue and one milestone, and every issue links a milestone (a product
 * stage). Once any issue carries a marker, every issue carries
 * exactly one, as its last line; all name the same n; there are n issues; the k are exactly 1..n; and no
 * key is on two issues. An issue with no marker is valid only as the single issue of a single-unit plan.
 * The units are the request's declared work units, as Repo Factory numbered them; nothing here counts
 * requirements. Each refusal names itself in `refusal`, with the issues, indices or keys it is about.
 */
const assertWorkUnits = (bundle: Pick<GenesisBundle, 'issues' | 'milestones'>): void => {
  const { issues } = bundle;
  // A genesis tracks its approved work as issues in milestones: with none of either it tracks nothing.
  if (issues.length === 0 || bundle.milestones.length === 0) refuseGenesis('GENESIS_BACKLOG_MISSING', `the genesis declares ${issues.length} issues and ${bundle.milestones.length} milestones; it needs at least one of each`, { issueCount: issues.length, milestoneCount: bundle.milestones.length });
  const unlinked = issues.filter(issue => issue.milestoneKey === null).map(issue => issue.key);
  if (unlinked.length > 0) refuseGenesis('GENESIS_ISSUE_MILESTONE_MISSING', `genesis issues ${unlinked.join(', ')} link no milestone`, { issues: unlinked });
  const read = issues.map(issue => ({ issue: issue.key, ...workUnitMarkers(issue.body) }));
  if (read.every(r => r.markers.length === 0)) {
    if (issues.length > 1) refuseGenesis('GENESIS_WORK_UNITS_UNMARKED', `${issues.length} genesis issues carry no work-unit marker; an unmarked issue is valid only as the single issue of a single-unit plan`, { issues: issues.map(issue => issue.key) });
    return;
  }
  const unmarked = read.filter(r => r.markers.length === 0).map(r => r.issue);
  if (unmarked.length > 0) refuseGenesis('GENESIS_WORK_UNIT_UNMARKED', `genesis issues ${unmarked.join(', ')} carry no work-unit marker beside marked ones`, { issues: unmarked });
  const misplaced = read.filter(r => r.markers.length > 1 || r.last === null).map(r => r.issue);
  if (misplaced.length > 0) refuseGenesis('GENESIS_WORK_UNIT_MARKER_NOT_ONE_LAST_LINE', `genesis issues ${misplaced.join(', ')} carry more than one work-unit marker, or one that is not the body's last line`, { issues: misplaced });
  const units = read.map(r => ({ issue: r.issue, ...r.last! }));
  const totals = [...new Set(units.map(u => u.n))];
  if (totals.length > 1) refuseGenesis('GENESIS_WORK_UNIT_MIXED_TOTAL', `genesis issues name different unit totals: ${totals.join(', ')}`, { totals });
  const total = totals[0]!;
  if (issues.length !== total) refuseGenesis('GENESIS_WORK_UNIT_COUNT_MISMATCH', `the work-unit markers name ${total} units and the genesis has ${issues.length} issues`, { total, issueCount: issues.length });
  const indices = units.map(u => u.k);
  const missing = Array.from({ length: total }, (_, index) => index + 1).filter(k => !indices.includes(k));
  const repeated = [...new Set(indices.filter((k, index) => indices.indexOf(k) !== index))];
  if (missing.length > 0 || repeated.length > 0) refuseGenesis('GENESIS_WORK_UNIT_INDEX_MISMATCH', `the work-unit indices are not exactly 1..${total}`, { total, missing, repeated, unexpected: indices.filter(k => k > total) });
  const keys = units.map(u => u.key);
  const duplicated = [...new Set(keys.filter((key, index) => keys.indexOf(key) !== index))];
  if (duplicated.length > 0) refuseGenesis('GENESIS_WORK_UNIT_KEY_DUPLICATE', `work-unit keys ${duplicated.join(', ')} are each on more than one issue`, { keys: duplicated, issues: units.filter(u => duplicated.includes(u.key)).map(u => u.issue) });
};
/** #1240 — a work-unit refusal `parseGenesis` threw, with what it names; null for any other failure. */
export const genesisRefusalOf = (error: unknown): Record<string, unknown> | null => {
  if (!isAcpError(error)) return null;
  const evidence = error.evidence as Record<string, unknown>;
  return typeof evidence['refusal'] === 'string' && evidence['refusal'].startsWith('GENESIS_') ? { ...evidence } : null;
};
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
  const metadata = { ...bundle, files: bundle.files.map(f => f.path) };
  screenPublicText(JSON.stringify(metadata));
  for (const value of publicStrings(metadata)) screenPublicText(value);
  for (const key of ['labels', 'milestones', 'issues'] as const) {
    const values = bundle[key].map(x => 'key' in x ? x.key : x.name);
    if (new Set(values).size !== values.length) throw new Error(`duplicate genesis ${key}`);
  }
  for (const issue of bundle.issues) {
    if (issue.labels.some(l => !bundle.labels.some(x => x.name === l)) || (issue.milestoneKey !== null && !bundle.milestones.some(m => m.key === issue.milestoneKey))) throw new Error('unknown issue label/milestone');
  }
  assertWorkUnits(bundle);
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
