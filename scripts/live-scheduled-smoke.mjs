import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { defaults, findExecutable } from '../lib/core.mjs';
import * as scheduler from '../lib/scheduler.mjs';

if (process.env.HI_AI_LIVE_TEST !== '1' || process.platform !== 'darwin') {
  console.error('macOS only. Checks real usage and sends a scheduled hello if idle, consuming usage. Run HI_AI_LIVE_TEST=1 npm run test:live:scheduled to opt in.');
  process.exitCode = 1;
} else {
  const target = path.join(os.homedir(), 'Library/LaunchAgents/io.hi-ai.plist');
  if (await scheduler.registered() || await fs.access(target).then(() => true, () => false)) throw new Error('Refusing to replace an existing HiAI schedule.');
  const detected = [];
  for (const name of Object.keys(defaults)) if (await findExecutable(name)) detected.push(name);
  if (!detected.length) throw new Error('No supported provider CLIs found.');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hi-ai-live-scheduled-'));
  const cli = fileURLToPath(new URL('../bin/hi-ai.mjs', import.meta.url));
  const env = { ...process.env, HI_AI_HOME: directory };
  let installed = false;
  try {
    const setup = spawnSync(process.execPath, [cli, 'setup', '--providers', detected.join(',')], { env, encoding: 'utf8', timeout: 20_000 });
    if (setup.status !== 0) throw new Error(setup.stderr.trim() || 'Setup failed.');
    installed = true;
    const deadline = Date.now() + 330_000;
    let state;
    while (Date.now() < deadline) {
      try { state = JSON.parse(await fs.readFile(path.join(directory, 'state.json'), 'utf8')); } catch { /* First tick has not run. */ }
      const running = await fs.access(path.join(directory, 'run.lock')).then(() => true, () => false);
      // A completed attempt has `at` even when its delivery is uncertain.
      if (detected.every(name => state?.[name]?.at || state?.[name]?.usage || state?.[name]?.usageError) && !running) break;
      await setTimeout(500);
    }
    const heartbeat = JSON.parse(await fs.readFile(path.join(directory, 'heartbeat.json'), 'utf8'));
    console.log(JSON.stringify({ scheduledCheck: heartbeat }));
    for (const name of detected) {
      const result = state?.[name];
      console.log(JSON.stringify({ provider: name, action: result?.ok ? 'hi-sent' : result?.resetAt ? 'waiting-for-reset' : 'usage-unavailable', resetAt: result?.resetAt, usage: result?.usage?.state, confirmed: result?.confirmed === true, at: result?.at, code: result?.code }));
      if (!result?.ok && !result?.resetAt) process.exitCode = 1;
    }
  } finally {
    if (installed) await scheduler.remove();
    await fs.rm(directory, { recursive: true, force: true });
  }
}
