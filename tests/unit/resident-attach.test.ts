import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { Db } from '../../src/db/database.ts';
import { cleanupTempDirs, tempDir } from '../helpers/fixtures.ts';
vi.mock('../../src/cli/attach-relay.ts', () => ({runAttachRelayCommand:vi.fn(async () => 0),runAdoptedCeoAttachRelay:vi.fn(async () => 0)}));
import { main } from '../../src/cli/agentctl.ts';
import { runAttachRelayCommand } from '../../src/cli/attach-relay.ts';
afterAll(cleanupTempDirs);
afterEach(() => {vi.unstubAllEnvs();vi.clearAllMocks();});
it('the provisioner MCP command reaches the canonical attach relay with the next DB generation',async () => {
  const state = tempDir('resident-attach-');const db = new Db(join(state,'state.sqlite'));db.close();
  vi.stubEnv('ACP_STATE_DIR',state);
  const uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  expect(await main(['attach','resident-cto','--claimed-session-id',uuid,'--project-id','resident'])).toBe(0);
  expect(runAttachRelayCommand).toHaveBeenCalledWith(expect.objectContaining({claim:{claimedSessionUuid:uuid,projectId:'resident',expectedBindingGeneration:1}}),expect.anything());
});
