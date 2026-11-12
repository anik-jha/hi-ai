import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { bootId } from '../lib/usage.mjs';

test('Linux: real cron repeats both providers when due and preserves unrelated jobs', {
  skip: process.platform !== 'linux' || process.env.HI_AI_TEST_CRON !== '1', timeout: 170_000,
}, async t => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hi-ai's cron %-"));
  const original = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
  assert.ok(original.status === 0 || /no crontab/i.test(original.stderr), original.stderr);
  t.after(async () => {
    const restored = original.status === 0
      ? spawnSync('crontab', ['-'], { input: original.stdout }) : spawnSync('crontab', ['-r']);
    assert.equal(restored.status, 0);
    await fs.rm(directory, { recursive: true, force: true });
  });
  const preserve = '# unrelated job\n0 0 1 1 * /bin/true\n';
  assert.equal(spawnSync('crontab', ['-'], { input: preserve }).status, 0);
  const bin = path.join(directory, 'bin');
  await fs.mkdir(bin);
  const marker = path.join(directory, 'sent');
  for (const name of ['claude', 'codex']) {
    const response = name === 'claude'
      ? JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'hi' })
      : [JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'hi' } }), JSON.stringify({ type: 'turn.completed' })].join('\n');
    await fs.writeFile(path.join(bin, name), `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(marker)}, '${name}\\n');\nconsole.log(${JSON.stringify(response)});\n`, { mode: 0o755 });
  }
  // Exercise the actual distributable and global bin link, without a registry.
  const pack = spawnSync('npm', ['pack', '--pack-destination', directory, '--json'], { cwd: root, encoding: 'utf8' });
  assert.equal(pack.status, 0, pack.stderr);
  const archive = path.join(directory, JSON.parse(pack.stdout)[0].filename);
  const prefix = path.join(directory, 'package');
  const install = spawnSync('npm', ['install', '--global', '--prefix', prefix, archive], { encoding: 'utf8' });
  assert.equal(install.status, 0, install.stderr);
  const cli = path.join(prefix, 'bin', 'hi-ai');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HI_AI_HOME: path.join(directory, 'settings'), CLAUDE_CONFIG_DIR: path.join(directory, 'claude'), CODEX_HOME: path.join(directory, 'codex') };
  const call = args => spawnSync(cli, args, { env, encoding: 'utf8' });
  const setup = call(['setup', '--providers', 'claude,codex']);
  assert.equal(setup.status, 0, setup.stderr);
  const idle = { state: 'idle', resetAt: null, checkedAt: new Date().toISOString(), usedPercent: 0, source: 'fixture', boot: await bootId() };
  await fs.writeFile(path.join(env.HI_AI_HOME, 'state.json'), JSON.stringify({ claude: { usage: idle }, codex: { usage: idle } }));
  assert.ok(spawnSync('crontab', ['-l'], { encoding: 'utf8' }).stdout.startsWith(preserve));
  const waitForPings = async count => {
    const deadline = Date.now() + 75_000;
    while (Date.now() < deadline) {
      const messages = (await fs.readFile(marker, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
      const running = await fs.access(path.join(env.HI_AI_HOME, 'run.lock')).then(() => true, () => false);
      if (messages.length >= count && !running) return messages;
      await setTimeout(500);
    }
    assert.fail(`cron did not produce ${count} pings before the deadline`);
  };
  assert.deepEqual(await waitForPings(2), ['claude', 'codex']);
  // Move the persisted success timestamps past five hours, rather than waiting
  // five hours in CI. The next real cron tick must repeat both providers.
  const statePath = path.join(env.HI_AI_HOME, 'state.json');
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  for (const provider of Object.values(state)) provider.lastSuccessAt = new Date(Date.now() - 5 * 60 * 60 * 1000 - 1000).toISOString();
  await fs.writeFile(statePath, JSON.stringify(state));
  assert.deepEqual(await waitForPings(4), ['claude', 'codex', 'claude', 'codex']);
  assert.equal(call(['run', '--scheduled']).status, 0);
  assert.equal((await fs.readFile(marker, 'utf8')).trim().split('\n').length, 4, 'no duplicate before five more hours');
  assert.equal(call(['pause']).status, 0);
  assert.equal(spawnSync('crontab', ['-l'], { encoding: 'utf8' }).stdout, preserve);
  assert.equal(call(['resume']).status, 0);
  assert.equal(call(['uninstall']).status, 0);
  assert.equal(spawnSync('crontab', ['-l'], { encoding: 'utf8' }).stdout, preserve);
});
