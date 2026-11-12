import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { plistText } from '../lib/scheduler.mjs';
import { bootId } from '../lib/usage.mjs';

test('macOS: real launchd waits for active windows, sends at reset, and distinguishes provider failures', {
  skip: process.platform !== 'darwin' || process.env.HI_AI_TEST_LAUNCHD !== '1', timeout: 200_000,
}, async t => {
  const service = `gui/${process.getuid()}/io.hi-ai`;
  const current = spawnSync('launchctl', ['print', service]);
  assert.notEqual(current.status, 0, 'Refusing to replace an existing hi-ai LaunchAgent');
  const realPlist = path.join(os.homedir(), 'Library/LaunchAgents/io.hi-ai.plist');
  assert.equal(await fs.access(realPlist).then(() => true, () => false), false, 'An existing plist must not be replaced');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hi-ai-launchd-'));
  const cli = fileURLToPath(new URL('../bin/hi-ai.mjs', import.meta.url));
  const bin = path.join(directory, 'bin');
  await fs.mkdir(bin);
  const firstNode = path.join(directory, 'node-v1');
  const secondNode = path.join(directory, 'node-v2');
  const stableNode = path.join(bin, 'node');
  await fs.symlink(process.execPath, firstNode);
  await fs.symlink(firstNode, stableNode);
  const marker = path.join(directory, 'sent');
  const failedLogin = path.join(directory, 'fail-claude');
  await fs.writeFile(failedLogin, 'simulate an expired Claude login');
  for (const name of ['claude', 'codex']) {
    const response = name === 'claude'
      ? JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'hi' })
      : [JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'hi' } }), JSON.stringify({ type: 'turn.completed' })].join('\n');
    const failure = name === 'claude' ? `if (fs.existsSync(${JSON.stringify(failedLogin)})) { console.log(JSON.stringify({type:'result',subtype:'error_during_execution',is_error:true})); process.exit(1); }` : '';
    await fs.writeFile(path.join(bin, name), `#!/usr/bin/env node\nconst fs = require('node:fs');\nfs.appendFileSync(${JSON.stringify(marker)}, '${name}\\n');\n${failure}\nconsole.log(${JSON.stringify(response)});\n`, { mode: 0o755 });
  }
  const env = { ...process.env, HOME: directory, HI_AI_HOME: path.join(directory, 'settings'), PATH: `${bin}:${process.env.PATH}`, CLAUDE_CONFIG_DIR: path.join(directory, 'claude'), CODEX_HOME: path.join(directory, 'codex') };
  const call = args => spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' });
  t.after(async () => {
    const result = call(['uninstall']);
    assert.equal(result.status, 0, result.stderr);
    await fs.rm(directory, { recursive: true, force: true });
  });
  const setup = call(['setup', '--providers', 'claude,codex']);
  assert.equal(setup.status, 0, setup.stderr);
  const resetAt = new Date(Date.now() + 90_000).toISOString();
  const active = { state: 'active', resetAt, checkedAt: new Date().toISOString(), usedPercent: 20, source: 'fixture', boot: await bootId() };
  await fs.writeFile(path.join(env.HI_AI_HOME, 'state.json'), JSON.stringify({ claude: { usage: active }, codex: { usage: active } }));
  const settings = JSON.parse(await fs.readFile(path.join(env.HI_AI_HOME, 'config.json'), 'utf8'));
  assert.ok(!settings.scheduler.node.includes('/Cellar/') && !settings.scheduler.node.includes('/fnm_multishells/'));
  // Inject a controlled stable alias into the real job to simulate an upgrade.
  // Resolver selection itself is covered with Homebrew and fnm fixtures.
  const testPlist = path.join(directory, 'Library/LaunchAgents/io.hi-ai.plist');
  assert.equal(spawnSync('launchctl', ['bootout', service]).status, 0);
  settings.scheduler.node = stableNode;
  await fs.writeFile(path.join(env.HI_AI_HOME, 'config.json'), JSON.stringify(settings));
  await fs.writeFile(testPlist, plistText({ node: stableNode, directory: env.HI_AI_HOME, searchPath: env.PATH }));
  assert.equal(spawnSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, testPlist]).status, 0);
  await fs.symlink(process.execPath, secondNode);
  await fs.rm(stableNode);
  await fs.symlink(secondNode, stableNode);
  await fs.rm(firstNode);
  assert.equal(spawnSync('launchctl', ['print', service]).status, 0);
  const firstTick = Date.now() + 80_000;
  let latched;
  while (Date.now() < firstTick) {
    const state = JSON.parse(await fs.readFile(path.join(env.HI_AI_HOME, 'state.json'), 'utf8'));
    if (state.claude.resetAt && state.codex.resetAt) { latched = state; break; }
    await setTimeout(500);
  }
  assert.equal(latched?.claude.resetAt, resetAt);
  assert.equal(latched?.codex.resetAt, resetAt);
  assert.equal(await fs.readFile(marker, 'utf8').catch(() => ''), '', 'an active window must not receive an early hello');
  const deadline = Date.now() + 100_000;
  while (Date.now() < deadline) {
    const messages = await fs.readFile(marker, 'utf8').catch(() => '');
    const running = await fs.access(path.join(env.HI_AI_HOME, 'run.lock')).then(() => true, () => false);
    if (messages === 'claude\ncodex\n' && !running) break;
    await setTimeout(500);
  }
  assert.equal(await fs.readFile(marker, 'utf8'), 'claude\ncodex\n');
  const failureStatus = call(['status']);
  assert.match(failureStatus.stdout, /^Scheduled:/);
  assert.match(failureStatus.stdout, /provider failure/);
  assert.match(failureStatus.stdout, /claude \(haiku\): failed/);
  assert.ok(!failureStatus.stdout.includes('Broken schedule'));
  assert.match(spawnSync('launchctl', ['print', service], { encoding: 'utf8' }).stdout, /last exit code = 0/);
  assert.equal(call(['run', '--scheduled']).status, 0);
  assert.equal(await fs.readFile(marker, 'utf8'), 'claude\ncodex\n', 'both providers wait five more hours');
  assert.equal(call(['pause']).status, 0);
  assert.notEqual(spawnSync('launchctl', ['print', service]).status, 0);
  assert.equal(call(['resume']).status, 0);
  assert.equal(spawnSync('launchctl', ['print', service]).status, 0);
  // Reproduce the review's loaded-but-broken job, then check that status exposes
  // the bad path immediately and resume repairs it.
  assert.equal(spawnSync('launchctl', ['bootout', service]).status, 0);
  await fs.writeFile(testPlist, plistText({ node: firstNode, directory: env.HI_AI_HOME }));
  assert.equal(spawnSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, testPlist]).status, 0);
  assert.match(call(['status']).stdout, /Broken schedule/);
  assert.equal(call(['resume']).status, 0);
  assert.match(call(['status']).stdout, /Waiting for first scheduler check/);
});
