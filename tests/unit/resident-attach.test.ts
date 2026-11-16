import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Db } from '../../src/db/database.ts';
import { cleanupTempDirs, tempDir } from '../helpers/fixtures.ts';
vi.mock('../../src/cli/attach-relay.ts', () => ({AUTO_GENERATION:'auto',runAttachRelayCommand:vi.fn(async () => 0),runAdoptedCeoAttachRelay:vi.fn(async () => 0)}));
import { main } from '../../src/cli/agentctl.ts';
import { runAttachRelayCommand } from '../../src/cli/attach-relay.ts';
afterAll(cleanupTempDirs);
afterEach(() => {vi.unstubAllEnvs();vi.clearAllMocks();});
it('the provisioner MCP command reaches the canonical attach relay with the next DB generation',async () => {
  const state = tempDir('resident-attach-');const db = new Db(join(state,'state.sqlite'));db.close();
  vi.stubEnv('ACP_STATE_DIR',state);
  const uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  expect(await main(['attach','resident-cto','--claimed-session-id',uuid,'--project-id','resident'])).toBe(0);
  // The generation is not fixed at spawn: the relay reads the role's next one before each attempt.
  expect(runAttachRelayCommand).toHaveBeenCalledWith(expect.objectContaining({claim:{claimedSessionUuid:uuid,projectId:'resident',expectedBindingGeneration:'auto'},stateDir:state}),expect.anything());
  const options = vi.mocked(runAttachRelayCommand).mock.calls[0]![0];
  expect(await options.nextGeneration!()).toBe(1);
});

it('attach canonical-cto without a generation, or with auto, reads the next one from the database; a number stays a pin',async () => {
  const state = tempDir('canonical-attach-auto-');
  // Only the column the read uses: gen1 and gen2 of the role exist (both revoked), so the next generation is 3.
  const db = new Database(join(state,'state.sqlite'));
  db.exec(`CREATE TABLE assignments (role_key TEXT NOT NULL, binding_generation INTEGER NOT NULL, status TEXT NOT NULL)`);
  for (const generation of [1, 2]) db.prepare(`INSERT INTO assignments VALUES ('PRIMARY_CTO:logic', ?, 'REVOKED')`).run(generation);
  db.close();
  vi.stubEnv('ACP_STATE_DIR',state);
  const uuid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  for (const tail of [[], ['--expected-binding-generation','auto']]) {
    vi.mocked(runAttachRelayCommand).mockClear();
    expect(await main(['attach','canonical-cto','--claimed-session-id',uuid,'--project-id','logic',...tail])).toBe(0);
    const options = vi.mocked(runAttachRelayCommand).mock.calls[0]![0];
    expect(options.claim.expectedBindingGeneration).toBe('auto');
    expect(await options.nextGeneration!()).toBe(3);
  }
  vi.mocked(runAttachRelayCommand).mockClear();
  expect(await main(['attach','canonical-cto','--claimed-session-id',uuid,'--project-id','logic','--expected-binding-generation','2'])).toBe(0);
  expect(vi.mocked(runAttachRelayCommand).mock.calls[0]![0].claim.expectedBindingGeneration).toBe(2);
  vi.mocked(runAttachRelayCommand).mockClear();
  expect(await main(['attach','canonical-cto','--claimed-session-id',uuid,'--project-id','logic','--expected-binding-generation','0'])).not.toBe(0);
  expect(runAttachRelayCommand).not.toHaveBeenCalled();
});
