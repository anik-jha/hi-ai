import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as syncFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { deliveryConfirmed, execute, FIVE_HOURS_MS, RETRY_DELAY_MS, firstStart, nextDueAt, validateTime } from '../lib/core.mjs';
import { cronText, nodeExecutable, plistText, stripCron } from '../lib/scheduler.mjs';
import { bootId } from '../lib/usage.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(root, 'bin/hi-ai.mjs');
const systemBoot = await bootId();

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hi-ai's test %-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const bin = path.join(directory, 'bin');
  await fs.mkdir(bin);
  const env = {
    ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    HI_AI_HOME: path.join(directory, 'settings'), FIXTURE: directory,
    CLAUDE_CONFIG_DIR: path.join(directory, 'claude'), CODEX_HOME: path.join(directory, 'codex'),
    OPENAI_API_KEY: 'test-only', CODEX_API_KEY: 'test-only',
    ANTHROPIC_API_KEY: 'test-only', ANTHROPIC_AUTH_TOKEN: 'test-only',
  };
  const writeScript = async (name, text) => fs.writeFile(path.join(bin, name), `#!/usr/bin/env node\n${text}`, { mode: 0o755 });
  for (const name of ['claude', 'codex']) await writeScript(name, `
const fs = require('node:fs');
if (process.env.SLOW_PROVIDER === ${JSON.stringify(name)}) {
  fs.writeFileSync(process.env.FIXTURE + '/provider.pid', String(process.pid));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.SLOW_MS || 600));
}
fs.appendFileSync(process.env.FIXTURE + '/calls', JSON.stringify({
  name: ${JSON.stringify(name)}, args: process.argv.slice(2), cwd: process.cwd(),
  apiKeyPresent: ['OPENAI_API_KEY','CODEX_API_KEY','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN'].some(k => k in process.env)
}) + '\\n');
if (process.env.BAD_OUTPUT !== ${JSON.stringify(name)}) {
  if (${JSON.stringify(name)} === 'claude') console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'hi'}));
  else {
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'hi'}}));
    console.log(JSON.stringify({type:'turn.completed'}));
  }
}
process.exit(process.env.FAIL_PROVIDER === ${JSON.stringify(name)} ? 1 : 0);
`);
  await writeScript('launchctl', `
const fs = require('node:fs');
const target = process.env.FIXTURE + '/registered';
const action = process.argv[2];
if (action === 'print') {
  if (!fs.existsSync(target)) process.exit(1);
  if (process.env.REPORTED_NODE) console.log('program = ' + process.env.REPORTED_NODE);
  if (process.env.REPORTED_EXIT) console.log('last exit code = ' + process.env.REPORTED_EXIT);
  process.exit(0);
}
if (action === 'bootstrap') {
  if (process.env.FAIL_SCHEDULER) process.exit(1);
  fs.writeFileSync(target, 'yes');
}
if (action === 'bootout') fs.rmSync(target, { force: true });
`);
  await writeScript('crontab', `
const fs = require('node:fs');
const target = process.env.FIXTURE + '/crontab';
if (process.env.FAIL_SCHEDULER) { console.error('permission denied'); process.exit(1); }
if (process.argv[2] === '-l') {
  if (!fs.existsSync(target)) { console.error('no crontab for test'); process.exit(1); }
  process.stdout.write(fs.readFileSync(target));
} else fs.writeFileSync(target, fs.readFileSync(0));
`);
  // Keep all plist writes away from the real user's LaunchAgents directory.
  env.HOME = directory;
  const call = (args, extra = {}) => {
    const result = spawnSync(process.execPath, [cli, ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 10_000 });
    if (['setup', 'resume'].includes(args[0]) && result.status === 0) {
      // Legacy lifecycle fixtures start with a known idle reading. Dedicated
      // usage tests exercise the real adapters and active/reset transitions.
      const target = path.join(env.HI_AI_HOME, 'state.json');
      const state = syncFs.existsSync(target) ? JSON.parse(syncFs.readFileSync(target, 'utf8')) : {};
      const settings = JSON.parse(syncFs.readFileSync(path.join(env.HI_AI_HOME, 'config.json'), 'utf8'));
      for (const provider of settings.providers) {
        state[provider.name] ||= {};
        state[provider.name].usage = { state: 'idle', resetAt: null, checkedAt: new Date().toISOString(), usedPercent: 0, source: 'fixture', boot: systemBoot };
      }
      syncFs.writeFileSync(target, JSON.stringify(state), { mode: 0o600 });
    }
    return result;
  };
  const start = (args, extra = {}) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    const result = new Promise((resolve, reject) => {
      let stdout = ''; let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
    });
    return { child, result };
  };
  const calls = async () => (await fs.readFile(path.join(directory, 'calls'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { directory, env, call, calls, writeScript, start };
}

async function waitForFile(target) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await fs.access(target).then(() => true, () => false)) return;
    await setTimeout(20);
  }
  assert.fail(`File was not created: ${target}`);
}

test('first start accepts now or the next local HH:MM occurrence', () => {
  for (const time of ['00:00', '06:00', '23:59']) assert.equal(validateTime(time), time);
  for (const time of ['24:00', '6:00', '06:60', '* *', '06:00\n']) assert.throws(() => validateTime(time));
  const now = new Date(2026, 0, 2, 23, 59);
  assert.equal(firstStart(undefined, now), now.toISOString());
  assert.equal(firstStart('06:00', now), new Date(2026, 0, 3, 6, 0).toISOString());
});

test('cron quoting preserves other jobs and replaces only its own schedule', () => {
  const other = '# my jobs\n5 * * * * echo keep\n';
  const options = { node: '/usr/bin/node', script: "/some user's/100%/cli.mjs", directory: '/tmp/helper', searchPath: '/usr/bin:/bin' };
  const first = cronText(other, options);
  assert.ok(first.startsWith(other));
  assert.match(first, /\* \* \* \* \* /);
  assert.ok(first.includes("user'\\''s"));
  assert.ok(first.includes('100\\%'));
  assert.equal(cronText(first, options), first);
  const replaced = cronText(first, options);
  assert.match(replaced, /\* \* \* \* \* /);
  assert.equal(stripCron(replaced), other);
  assert.throws(() => stripCron('# hi-ai:begin\nprecious job'), /Unclosed/);
  assert.throws(() => cronText('', { ...options, script: '/bad\npath' }), /line breaks/);
});

test('launchd plist contains escaped paths and no immediate execution', async t => {
  const text = plistText({ node: '/node', script: '/a&b/<script>', directory: '/tmp/test', searchPath: '/bin' });
  assert.ok(text.includes('/a&amp;b/&lt;script&gt;'));
  assert.ok(text.includes('<key>StartInterval</key><integer>60</integer>'));
  assert.ok(!text.includes('StartCalendarInterval'));
  assert.ok(!text.includes('RunAtLoad'));
  if (process.platform === 'darwin') {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reset-plist-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const target = path.join(directory, 'test.plist');
    await fs.writeFile(target, text);
    const result = spawnSync('/usr/bin/plutil', ['-lint', target], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
});

test('setup → preview → run → deduplicate → pause → resume → uninstall', async t => {
  const f = await fixture(t);
  const setup = f.call(['setup', '--providers', 'claude,codex']);
  assert.equal(setup.status, 0, setup.stderr);
  assert.equal((await f.calls()).length, 0, 'setup must not send a message');
  assert.equal(f.call(['run', '--dry-run']).status, 0);
  assert.equal((await f.calls()).length, 0, 'preview must not send a message');
  const result = f.call(['run', '--scheduled']);
  assert.equal(result.status, 0, result.stderr);
  const calls = await f.calls();
  assert.deepEqual(calls.map(p => p.name), ['claude', 'codex']);
  for (const call of calls) {
    assert.equal(call.apiKeyPresent, false);
    assert.ok(call.cwd.startsWith(await fs.realpath(os.tmpdir())));
    await assert.rejects(fs.access(call.cwd), { code: 'ENOENT' });
  }
  assert.ok(calls[0].args.includes('--no-session-persistence'));
  assert.equal(calls[0].args[calls[0].args.indexOf('--tools') + 1], '');
  assert.ok(calls[1].args.includes('--ignore-user-config'));
  assert.equal(f.call(['run', '--scheduled']).status, 0);
  assert.equal((await f.calls()).length, 2);
  const status = f.call(['status']);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Scheduled/);
  assert.match(status.stdout, /claude \(haiku\): sent/);
  assert.equal(f.call(['pause']).status, 0);
  assert.equal(f.call(['run', '--scheduled']).status, 0);
  assert.equal((await f.calls()).length, 2);
  assert.match(f.call(['status']).stdout, /Paused/);
  assert.equal(f.call(['resume']).status, 0);
  assert.match(f.call(['status']).stdout, /Waiting for first scheduler check/);
  assert.equal(f.call(['uninstall']).status, 0);
  assert.equal(f.call(['uninstall']).status, 0, 'uninstall is idempotent');
  await assert.rejects(fs.access(path.join(f.env.HI_AI_HOME, 'config.json')), { code: 'ENOENT' });
});

test('provider failure is visible and retry does not repeat the successful provider', async t => {
  const f = await fixture(t);
  assert.equal(f.call(['setup', '--providers', 'claude,codex']).status, 0);
  assert.equal(f.call(['run', '--scheduled'], { FAIL_PROVIDER: 'claude' }).status, 0);
  assert.match(f.call(['status']).stdout, /claude \(haiku\): failed/);
  assert.equal(f.call(['run', '--scheduled']).status, 0);
  assert.equal((await f.calls()).length, 2, 'failure retry must respect the five-minute backoff');
  const target = path.join(f.env.HI_AI_HOME, 'state.json');
  const state = JSON.parse(await fs.readFile(target, 'utf8'));
  state.claude.at = new Date(Date.now() - RETRY_DELAY_MS - 1000).toISOString();
  await fs.writeFile(target, JSON.stringify(state));
  assert.equal(f.call(['run', '--scheduled']).status, 0);
  assert.deepEqual((await f.calls()).map(p => p.name), ['claude', 'codex', 'claude']);
});

test('five hours means elapsed time across midnight and DST; failures preserve the successful anchor', () => {
  const at = '2026-11-01T05:30:00Z';
  const due = Date.parse(at) + FIVE_HOURS_MS;
  assert.equal(nextDueAt({}, { ok: true, lastSuccessAt: at }), due);
  assert.equal(nextDueAt({}, { ok: false, at: '2026-11-01T06:30:00Z', lastSuccessAt: at }), due);
  assert.equal(nextDueAt({}, { ok: true, lastSuccessAt: '2026-11-11T23:00:00Z' }), Date.parse('2026-11-12T04:00:00Z'));
});

test('each provider repeats after five hours and persists its own countdown across CLI restarts', async t => {
  const f = await fixture(t);
  assert.equal(f.call(['setup', '--providers', 'claude,codex']).status, 0);
  assert.equal(f.call(['run', '--scheduled']).status, 0);
  const target = path.join(f.env.HI_AI_HOME, 'state.json');
  let state = JSON.parse(await fs.readFile(target, 'utf8'));
  const almostDue = new Date(Date.now() - FIVE_HOURS_MS + 60_000).toISOString();
  state.claude.lastSuccessAt = almostDue;
  state.codex.lastSuccessAt = almostDue;
  await fs.writeFile(target, JSON.stringify(state));
  assert.equal(f.call(['run', '--scheduled']).status, 0);
  assert.equal((await f.calls()).length, 2, 'do not send at four hours and 59 minutes');
  state.claude.lastSuccessAt = new Date(Date.now() - FIVE_HOURS_MS - 1000).toISOString();
  await fs.writeFile(target, JSON.stringify(state));
  assert.equal(f.call(['run', '--scheduled']).status, 0);
  assert.deepEqual((await f.calls()).map(p => p.name), ['claude', 'codex', 'claude']);
  state = JSON.parse(await fs.readFile(target, 'utf8'));
  state.codex.lastSuccessAt = new Date(Date.now() - FIVE_HOURS_MS - 1000).toISOString();
  await fs.writeFile(target, JSON.stringify(state));
  assert.equal(f.call(['run', '--scheduled']).status, 0);
  assert.deepEqual((await f.calls()).map(p => p.name), ['claude', 'codex', 'claude', 'codex']);
  assert.equal(f.call(['run', '--scheduled']).status, 0);
  assert.equal((await f.calls()).length, 4, 'missed intervals never cause a burst of pings');
  assert.equal(f.call(['pause']).status, 0);
  assert.equal(f.call(['resume']).status, 0);
  assert.equal(f.call(['run', '--scheduled']).status, 0);
  assert.equal((await f.calls()).length, 4, 'pause/resume does not reset successful countdowns');
});

test('optional first time defers automatic messages, while an explicit run starts the five-hour countdown', async t => {
  const f = await fixture(t);
  assert.equal(f.call(['setup', '--time', '06:00', '--providers', 'claude,codex']).status, 0);
  assert.equal(f.call(['run', '--scheduled']).status, 0);
  assert.equal((await f.calls()).length, 0);
  assert.equal(f.call(['run']).status, 0);
  assert.equal((await f.calls()).length, 2);
  assert.equal(f.call(['run', '--scheduled']).status, 0);
  assert.equal((await f.calls()).length, 2);
});

test('active lock skips and stale lock recovers', async t => {
  const f = await fixture(t);
  assert.equal(f.call(['setup', '--providers', 'claude']).status, 0);
  const lock = path.join(f.env.HI_AI_HOME, 'run.lock');
  await fs.writeFile(lock, String(process.pid));
  assert.match(f.call(['run']).stdout, /already running/);
  assert.equal((await f.calls()).length, 0);
  await fs.writeFile(lock, '2147483647');
  assert.equal(f.call(['run']).status, 0);
  assert.equal((await f.calls()).length, 1);
});

test('bad setup inputs cannot modify an existing configuration', async t => {
  const f = await fixture(t);
  assert.equal(f.call(['setup', '--providers', 'claude']).status, 0);
  const target = path.join(f.env.HI_AI_HOME, 'config.json');
  const before = await fs.readFile(target, 'utf8');
  for (const args of [
    ['setup', '--time', '25:00'], ['setup', '--providers', 'typo'],
    ['setup', '--claude-model', ''], ['status', '--time', '07:00'],
  ]) assert.equal(f.call(args).status, 1);
  assert.equal(await fs.readFile(target, 'utf8'), before);
});

test('failed scheduler installation restores configuration', async t => {
  const f = await fixture(t);
  const failure = f.call(['setup', '--providers', 'claude'], { FAIL_SCHEDULER: '1' });
  assert.equal(failure.status, 1);
  await assert.rejects(fs.access(path.join(f.env.HI_AI_HOME, 'config.json')), { code: 'ENOENT' });
});

test('Linux scheduler preserves existing cron jobs across install and removal', async t => {
  const f = await fixture(t);
  const previous = '# personal job\n0 1 * * * echo keep\n';
  await fs.writeFile(path.join(f.directory, 'crontab'), previous);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { install, remove, registered } from './lib/scheduler.mjs';
    await install('linux');
    assert.equal(await registered('linux'), true);
    await install('linux');
    await remove('linux');
    assert.equal(await registered('linux'), false);
  `], { cwd: root, env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await fs.readFile(path.join(f.directory, 'crontab'), 'utf8'), previous);
});

test('provider timeout terminates the process instead of hanging', async () => {
  const result = await execute(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 80 });
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, 'SIGKILL');
});

test('delivery requires a successful structured response, not just exit zero', () => {
  const success = { type: 'result', subtype: 'success', is_error: false, result: 'hi' };
  assert.equal(deliveryConfirmed('claude', JSON.stringify(success)), true);
  for (const result of [{ ...success, is_error: true }, { ...success, subtype: 'error' }, { ...success, result: '' }]) {
    assert.equal(deliveryConfirmed('claude', JSON.stringify(result)), false);
  }
  assert.equal(deliveryConfirmed('claude', 'not json'), false);
  const message = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'hi' } });
  const completed = JSON.stringify({ type: 'turn.completed' });
  assert.equal(deliveryConfirmed('codex', `${message}\n${completed}`), true);
  assert.equal(deliveryConfirmed('codex', completed), false);
  assert.equal(deliveryConfirmed('codex', message), false);
  assert.equal(deliveryConfirmed('codex', `${message}\n${JSON.stringify({ type: 'turn.failed' })}\n${completed}`), false);
});

test('an unconfirmed zero-exit response is not marked sent or immediately repeated', async t => {
  const f = await fixture(t);
  assert.equal(f.call(['setup', '--providers', 'claude,codex']).status, 0);
  const result = f.call(['run', '--scheduled'], { BAD_OUTPUT: 'claude' });
  assert.equal(result.status, 0);
  const state = JSON.parse(await fs.readFile(path.join(f.env.HI_AI_HOME, 'state.json'), 'utf8'));
  assert.equal(state.claude.ok, false);
  assert.equal(state.claude.error, 'unconfirmed_response');
  assert.equal(state.claude.lastSuccessAt, undefined);
  assert.ok(state.claude.pendingAt);
  assert.ok(state.codex.lastSuccessAt);
  assert.match(f.call(['status']).stdout, /delivery uncertain/);
  assert.equal(f.call(['run', '--scheduled']).status, 0);
  assert.equal((await f.calls()).length, 2);
  const log = await fs.readFile(path.join(f.env.HI_AI_HOME, 'runs.log'), 'utf8');
  assert.ok(!log.includes('stdout') && !log.includes('result":"hi'));
});

test('real concurrent runs and control commands cannot duplicate or uninstall an active ping', async t => {
  const f = await fixture(t);
  assert.equal(f.call(['setup', '--providers', 'claude']).status, 0);
  const active = f.start(['run', '--scheduled'], { SLOW_PROVIDER: 'claude', SLOW_MS: '2500' });
  await waitForFile(path.join(f.directory, 'provider.pid'));
  const controls = await Promise.all(['setup', 'pause', 'resume', 'uninstall'].map(action => f.start([action]).result));
  for (const control of controls) {
    assert.equal(control.status, 1, control.stderr);
    assert.match(control.stderr, /running/);
  }
  const contenders = await Promise.all(Array.from({ length: 8 }, () => f.start(['run', '--scheduled']).result));
  for (const contender of contenders) assert.equal(contender.status, 0, contender.stderr);
  const finished = await active.result;
  assert.equal(finished.status, 0, finished.stderr);
  assert.equal((await f.calls()).length, 1);
  assert.equal(f.call(['uninstall']).status, 0);
});

test('concurrent stale-lock recovery has only one sender', async t => {
  const f = await fixture(t);
  assert.equal(f.call(['setup', '--providers', 'claude']).status, 0);
  await fs.writeFile(path.join(f.env.HI_AI_HOME, 'run.lock'), '2147483647');
  const results = await Promise.all(Array.from({ length: 12 }, () => f.start(['run', '--scheduled'], { SLOW_PROVIDER: 'claude' }).result));
  for (const result of results) assert.equal(result.status, 0, result.stderr);
  assert.equal((await f.calls()).length, 1);
});

async function interrupt(f, signal, extra) {
  const temporary = path.join(f.directory, 'tmp');
  await fs.mkdir(temporary);
  const active = f.start(['run', '--scheduled'], { TMPDIR: temporary, SLOW_MS: '60000', ...extra });
  await waitForFile(path.join(f.directory, 'provider.pid'));
  active.child.kill(signal);
  const result = await active.result;
  assert.equal(result.signal, signal);
  assert.deepEqual(await fs.readdir(temporary), [], 'the temporary workspace is removed');
  assert.equal(await fs.access(path.join(f.env.HI_AI_HOME, 'run.lock')).then(() => true, () => false), false, 'the lock is released');
  return JSON.parse(await fs.readFile(path.join(f.env.HI_AI_HOME, 'state.json'), 'utf8').catch(() => '{}'));
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`${signal} during a hello leaves an uncertain delivery on cooldown and cleans up its lock and workspace`, async t => {
    const f = await fixture(t);
    assert.equal(f.call(['setup', '--providers', 'claude']).status, 0);
    const state = await interrupt(f, signal, { SLOW_PROVIDER: 'claude' });
    assert.ok(state.claude.pendingAt);
    assert.ok(nextDueAt({}, state.claude) > Date.now());
    const resumed = f.call(['run', '--scheduled']);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal((await f.calls()).length, 0);
  });
}

test('SIGTERM during a usage check cleans up and is not counted as a failed usage read', async t => {
  const f = await fixture(t);
  assert.equal(f.call(['setup', '--providers', 'claude,codex']).status, 0);
  // Remove the fixture's idle readings so the scheduled run reads usage itself.
  await fs.rm(path.join(f.env.HI_AI_HOME, 'state.json'));
  for (const provider of ['claude', 'codex']) {
    await fs.rm(path.join(f.directory, 'provider.pid'), { force: true });
    await fs.rm(path.join(f.directory, 'tmp'), { recursive: true, force: true });
    await fs.writeFile(path.join(f.env.HI_AI_HOME, 'config.json'), JSON.stringify({
      ...JSON.parse(await fs.readFile(path.join(f.env.HI_AI_HOME, 'config.json'), 'utf8')),
      providers: [{ name: provider, executable: path.join(f.directory, 'bin', provider), model: 'test-model' }],
    }));
    const state = await interrupt(f, 'SIGTERM', { SLOW_PROVIDER: provider });
    assert.deepEqual(state[provider] ?? {}, {}, `${provider} records no usage failure or delivery attempt`);
  }
  assert.equal((await f.calls()).length, 0);
});

test('corrupt state and invalid config fail before making provider calls', async t => {
  const f = await fixture(t);
  assert.equal(f.call(['setup', '--providers', 'claude']).status, 0);
  const target = path.join(f.env.HI_AI_HOME, 'state.json');
  for (const content of ['{', 'null', '[]', '{"claude":{"lastSuccessAt":"bad-date"}}']) {
    await fs.writeFile(target, content);
    assert.equal(f.call(['run', '--scheduled']).status, 1);
  }
  await fs.rm(target);
  const settingsPath = path.join(f.env.HI_AI_HOME, 'config.json');
  const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
  await fs.writeFile(settingsPath, JSON.stringify({ ...settings, enabled: 'yes' }));
  assert.equal(f.call(['run', '--scheduled']).status, 1);
  assert.equal((await f.calls()).length, 0);
});

test('a missing provider executable does not block the other provider', async t => {
  const f = await fixture(t);
  assert.equal(f.call(['setup', '--providers', 'claude,codex']).status, 0);
  await fs.rm(path.join(f.directory, 'bin', 'claude'));
  assert.equal(f.call(['run', '--scheduled']).status, 0);
  assert.deepEqual((await f.calls()).map(call => call.name), ['codex']);
  const state = JSON.parse(await fs.readFile(path.join(f.env.HI_AI_HOME, 'state.json'), 'utf8'));
  assert.equal(state.claude.error, 'ENOENT');
  assert.equal(state.claude.pendingAt, undefined);
});

test('provider output is bounded and excessive output cannot be mistaken for success', async () => {
  const result = await execute(process.execPath, ['-e', 'process.stdout.write("x".repeat(400000)); setInterval(()=>{}, 1000)']);
  assert.equal(result.outputTooLarge, true);
  assert.ok(Buffer.byteLength(result.stdout) <= 262_144);
  assert.equal(result.signal, 'SIGKILL');
});

test('an interrupted recovery lock reports an actionable error without sending a message', async t => {
  const f = await fixture(t);
  assert.equal(f.call(['setup', '--providers', 'claude']).status, 0);
  await fs.writeFile(path.join(f.env.HI_AI_HOME, 'run.lock'), '2147483647');
  await fs.writeFile(path.join(f.env.HI_AI_HOME, 'recovery.lock'), '2147483647');
  const result = f.call(['run', '--scheduled']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Interrupted lock recovery/);
  assert.equal((await f.calls()).length, 0);
});

test('the scheduler keeps a stable Node alias across a simulated Homebrew upgrade', async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hi-ai-node-upgrade-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const first = path.join(directory, 'Cellar/node/1/bin/node');
  const second = path.join(directory, 'Cellar/node/2/bin/node');
  const bin = path.join(directory, 'bin');
  await fs.mkdir(path.dirname(first), { recursive: true });
  await fs.mkdir(path.dirname(second), { recursive: true });
  await fs.mkdir(bin);
  await fs.writeFile(first, '#!/bin/sh\nprintf v1', { mode: 0o755 });
  await fs.writeFile(second, '#!/bin/sh\nprintf v2', { mode: 0o755 });
  const alias = path.join(bin, 'node');
  await fs.symlink(first, alias);
  const multishell = path.join(directory, 'fnm_multishells/48213/bin');
  await fs.mkdir(multishell, { recursive: true });
  await fs.symlink(first, path.join(multishell, 'node'));
  const selected = await nodeExecutable({ current: first, searchPath: `${multishell}${path.delimiter}${bin}`, aliases: [] });
  assert.equal(selected, alias);
  assert.ok(plistText({ node: selected }).includes(`<string>${alias}</string>`));
  assert.ok(!plistText({ node: selected }).includes('/Cellar/'));
  assert.ok(!cronText('', { node: selected }).includes('/Cellar/'));
  await fs.rm(first);
  await fs.rm(alias);
  await fs.symlink(second, alias);
  const result = spawnSync(selected, ['--version'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'v2');
});

test('fnm keeps its resolved installation path instead of a per-shell Node link', async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hi-ai-fnm-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const installation = path.join(directory, 'fnm/node-versions/v22/installation/bin/node');
  const shellBin = path.join(directory, 'fnm_multishells/48213/bin');
  await fs.mkdir(path.dirname(installation), { recursive: true });
  await fs.mkdir(shellBin, { recursive: true });
  await fs.writeFile(installation, '#!/bin/sh\nprintf fnm-installation', { mode: 0o755 });
  const shellNode = path.join(shellBin, 'node');
  await fs.symlink(installation, shellNode);
  for (const current of [installation, shellNode]) {
    assert.equal(await nodeExecutable({ current, searchPath: shellBin, aliases: [] }), installation);
  }
  await fs.rm(path.join(directory, 'fnm_multishells'), { recursive: true });
  assert.equal(spawnSync(installation, ['--version'], { encoding: 'utf8' }).stdout, 'fnm-installation');
});

test('a saved provider failure is a completed scheduler check, while manual runs and runner crashes exit nonzero', async t => {
  const f = await fixture(t);
  assert.equal(f.call(['setup', '--providers', 'claude,codex']).status, 0);
  const automatic = f.call(['run', '--scheduled'], { FAIL_PROVIDER: 'claude' });
  assert.equal(automatic.status, 0, automatic.stderr);
  const state = JSON.parse(await fs.readFile(path.join(f.env.HI_AI_HOME, 'state.json'), 'utf8'));
  assert.equal(state.claude.ok, false);
  assert.equal(state.codex.ok, true);
  const heartbeat = JSON.parse(await fs.readFile(path.join(f.env.HI_AI_HOME, 'heartbeat.json'), 'utf8'));
  assert.equal(heartbeat.phase, 'finished');
  assert.equal(heartbeat.ok, false);
  const status = f.call(['status'], { REPORTED_EXIT: '0' });
  assert.match(status.stdout, /^Scheduled:/);
  assert.match(status.stdout, /provider failure/);
  assert.match(status.stdout, /claude \(haiku\): failed/);
  assert.ok(!status.stdout.includes('Broken schedule'));
  assert.equal(f.call(['run'], { FAIL_PROVIDER: 'claude' }).status, 1);
  await fs.writeFile(path.join(f.env.HI_AI_HOME, 'state.json'), '{');
  assert.equal(f.call(['run', '--scheduled']).status, 1);
});

test('macOS status parses named launchd exit codes with an existing runtime', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t);
  assert.equal(f.call(['setup', '--providers', 'claude']).status, 0);
  for (const code of ['78: EX_CONFIG', '78']) {
    const status = f.call(['status'], { REPORTED_EXIT: code });
    assert.match(status.stdout, /^Broken schedule:/);
    assert.match(status.stdout, /last exit code was 78/);
  }
});

test('status distinguishes a loaded schedule from observed checks and notices stale heartbeats', async t => {
  const f = await fixture(t);
  assert.equal(f.call(['setup', '--providers', 'claude']).status, 0);
  assert.match(f.call(['status']).stdout, /Waiting for first scheduler check/);
  assert.match(f.call(['status']).stdout, /Last scheduled check: not observed/);
  assert.equal(f.call(['run']).status, 0);
  await assert.rejects(fs.access(path.join(f.env.HI_AI_HOME, 'heartbeat.json')), { code: 'ENOENT' });
  assert.match(f.call(['status']).stdout, /Waiting for first scheduler check/);
  assert.equal(f.call(['run', '--scheduled']).status, 0);
  assert.match(f.call(['status']).stdout, /^Scheduled:/);
  const heartbeat = path.join(f.env.HI_AI_HOME, 'heartbeat.json');
  await fs.writeFile(heartbeat, JSON.stringify({ at: new Date(Date.now() - 11 * 60 * 1000).toISOString(), phase: 'finished', ok: true }));
  assert.match(f.call(['status']).stdout, /Scheduler inactive/);
  assert.equal((await f.calls()).length, 1);
});

test('status reports a missing runtime or provider instead of claiming a healthy schedule', async t => {
  const f = await fixture(t);
  assert.equal(f.call(['setup', '--providers', 'claude']).status, 0);
  const target = path.join(f.env.HI_AI_HOME, 'config.json');
  const settings = JSON.parse(await fs.readFile(target, 'utf8'));
  settings.scheduler.node = path.join(f.directory, 'deleted-node');
  await fs.writeFile(target, JSON.stringify(settings));
  const status = f.call(['status']);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Broken schedule/);
  assert.match(status.stdout, /Node executable is missing/);
  assert.equal(f.call(['setup', '--providers', 'claude']).status, 0);
  await fs.rm(path.join(f.directory, 'bin/claude'));
  assert.match(f.call(['status']).stdout, /claude executable is missing/);
});

test('macOS status inspects the loaded job executable, not just saved settings', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t);
  assert.equal(f.call(['setup', '--providers', 'claude']).status, 0);
  const status = f.call(['status'], { REPORTED_NODE: '/missing/Cellar/node/bin/node', REPORTED_EXIT: '78: EX_CONFIG' });
  assert.match(status.stdout, /Broken schedule/);
  assert.match(status.stdout, /Node executable is missing/);
  assert.match(status.stdout, /last exit code was 78/);
});

test('--version follows package.json instead of a duplicated string', async t => {
  const f = await fixture(t);
  const metadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(f.call(['--version']).stdout.trim(), metadata.version);
});

test('PATH discovery skips the versioned Codex binary bundled inside the IDE extension', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hi-ai-path-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const extension = path.join(directory, 'openai.chatgpt-1.2.3/bin');
  const standalone = path.join(directory, 'bin');
  await fs.mkdir(extension, { recursive: true });
  await fs.mkdir(standalone);
  for (const bin of [extension, standalone]) await fs.writeFile(path.join(bin, 'codex'), '#!/bin/sh\nexit 0', { mode: 0o755 });
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import {findExecutable} from './lib/core.mjs';
    console.log(await findExecutable('codex'));
  `], { cwd: root, env: { ...process.env, PATH: `${extension}${path.delimiter}${standalone}` }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), path.join(standalone, 'codex'));
});
