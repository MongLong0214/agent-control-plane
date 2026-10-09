import { spawnSync } from 'node:child_process';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import { SingleInstanceLock } from '../../src/daemon/single-instance.ts';
import { cleanupTempDirs, commitAll, gitSync, makeRepo, tempDir } from '../helpers/fixtures.ts';

afterAll(cleanupTempDirs);

it('ACP-WORKER-03-FC: a stale-fence reader must not unlink the predecessor\'s replacement live fence', async () => {
  const repo = makeRepo({'README.md':'base\n'});
  const base = gitSync(repo,['rev-parse','HEAD']);
  const branch = gitSync(repo,['symbolic-ref','--short','HEAD']);
  writeFileSync(join(repo,'README.md'),'next\n'); commitAll(repo,'next');
  const target = gitSync(repo,['rev-parse','HEAD']);
  gitSync(repo,['update-ref',`refs/heads/${branch}`,base,target]);
  const state = tempDir('acp-n4-fence-replacement-');
  const release = join(state,'release'), ready = join(state,'ready'), stop = join(state,'stop'), stopped = join(state,'stopped');
  const successor = new SingleInstanceLock(join(state,'agentcpd.lock'));
  const gone = 2_147_483_000;
  successor.fence([{pgid:gone,leaderStartedAt:null}],new Date().toISOString());
  const originalKill = process.kill.bind(process);
  let predecessor: {daemonPid:number;pgid:number;code:number;writtenFence:unknown}|undefined;
  const spy = vi.spyOn(process,'kill').mockImplementation((pid,signal) => {
    if (pid !== -gone || predecessor) return originalKill(pid,signal);
    let goneError: unknown;
    try { originalKill(pid,signal); } catch (error) { goneError = error; }
    if ((goneError as {code?:string})?.code !== 'ESRCH') throw new Error('the stale group must really be absent');
    // S has read the OLD fence and observed ESRCH. While S is paused, P clears that fence,
    // takes the lock, writes a NEW live fence in real Daemon.stop(), and exits 75.
    const coordinated = spawnSync(process.execPath,['-e',`
      const fs = require('node:fs'), cp = require('node:child_process');
      const args = process.argv.slice(1);
      const [helper,state,repo,branch,target,base,release,ready,stop,stopped,lock] = args;
      const child = cp.spawn(process.execPath,['--experimental-transform-types',helper,state,repo,branch,target,base,release,ready,stop,stopped,'race'],
        {cwd:process.cwd(),env:{...process.env,TMPDIR:'/private/tmp'},stdio:['ignore','ignore','pipe']});
      let err = ''; child.stderr.on('data',b=>err+=b);
      const exited = new Promise(resolve=>child.once('exit',resolve));
      (async()=>{
        const until = Date.now()+45000;
        while (!fs.existsSync(ready)) {
          if (Date.now()>until || child.exitCode!==null) throw new Error(err||'no ready report');
          await new Promise(r=>setTimeout(r,10));
        }
        fs.writeFileSync(stop,'stop now');
        const code = await exited;
        const report = JSON.parse(fs.readFileSync(ready,'utf8'));
        process.stdout.write(JSON.stringify({...report,code,writtenFence:JSON.parse(fs.readFileSync(lock+'.git-fence.json','utf8'))}));
      })().catch(e=>{console.error(e);child.kill('SIGKILL');process.exit(2)});
    `,join(process.cwd(),'tests/helpers/reviewer-fence-acquire-race-1070.ts'),state,repo,branch,target,base,release,ready,stop,stopped,join(state,'agentcpd.lock')],
    {cwd:process.cwd(),encoding:'utf8',timeout:60000,env:{...process.env,TMPDIR:'/private/tmp'}});
    if (coordinated.status !== 0) throw new Error(coordinated.stderr);
    predecessor = JSON.parse(coordinated.stdout);
    throw goneError;
  });
  try {
    const acquired = successor.acquire(new Date().toISOString());
    spy.mockRestore();
    expect(predecessor?.code).toBe(75);
    const report = predecessor!;
    expect(() => originalKill(report.daemonPid,0)).toThrow();
    expect(originalKill(-report.pgid,0)).toBe(true);
    const fenceAtAcquire = existsSync(successor.fencePath);
    const atAcquire = gitSync(repo,['rev-parse','HEAD']);
    // The CEO's final-round end state keeps the real mutator paused: fence preserved,
    // successor refused, and HEAD unchanged. Cleanup kills the group before any release.
    await new Promise(r=>setTimeout(r,100));
    const saved = JSON.parse(readFileSync(successor.fencePath,'utf8'));
    expect(saved.groups[0].pgid).toBe(report.pgid);
    expect(saved.groups[0].leaderStartedAt).toMatch(/^darwin-tv:/);
    const uniqueFiles = readdirSync(state).filter(n=>n.startsWith('agentcpd.lock.git-fence.') && n.endsWith('.json') && n!=='agentcpd.lock.git-fence.json');
    expect(uniqueFiles.some(n=>JSON.parse(readFileSync(join(state,n),'utf8')).groups?.some((g:{pgid:number})=>g.pgid===report.pgid))).toBe(true);
    expect(successor.held()).toBe(false);
    expect(gitSync(repo,['rev-parse','HEAD'])).toBe(base);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({case:'stale-fence-replacement',...report,successorAllowed:acquired.allowed,
      successorHeld:successor.held(),fenceAtAcquire,base,atAcquire,after:gitSync(repo,['rev-parse','HEAD'])}));
    expect(acquired.allowed,'a stale read removed a newly written live fence and granted authority').toBe(false);
  } finally {
    spy.mockRestore();
    if (predecessor) { try { originalKill(-predecessor.pgid,'SIGKILL'); } catch {} }
    writeFileSync(stop,'cleanup');
    successor.release();
  }
},120000);

it.each(['EPERM','ESRCH'])('a fenced group lookup returning %s has the correct conservative result', code => {
  const lock = new SingleInstanceLock(join(tempDir('acp-n4-errno-'),'agentcpd.lock'));
  const pgid = 2_147_483_000;
  lock.fence([{pgid,leaderStartedAt:null}],new Date().toISOString());
  const originalKill = process.kill.bind(process);
  const spy = vi.spyOn(process,'kill').mockImplementation((pid,signal) => {
    if (pid === -pgid) throw Object.assign(new Error(code),{code});
    return originalKill(pid,signal);
  });
  try {
    expect(lock.acquire(new Date().toISOString()).allowed).toBe(code==='ESRCH');
    expect(existsSync(lock.fencePath)).toBe(code==='EPERM');
  } finally { spy.mockRestore();lock.release(); }
});
