#!/usr/bin/env node
import * as fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { acquireLock, config, defaults, file, findExecutable, firstStart, home, Interrupted, nextDueAt, readJSON, readState, run, writeJSON } from '../lib/core.mjs';
import * as scheduler from '../lib/scheduler.mjs';

const help = `hi-ai — a tiny scheduled hello for Claude Code and Codex

  setup [--time HH:MM] [--providers claude,codex]
        [--claude-model haiku] [--codex-model gpt-6-luna]
  run [--dry-run]       Send one hello now, or preview the CLI arguments
  status               Show the schedule and last results
  pause                Remove the schedule; keep settings
  resume               Reinstall the saved schedule
  uninstall            Remove the schedule, settings, and local logs

Checks provider usage on startup and after a system restart.
Sends hi if idle, or waits for the provider's reported reset time.
--time HH:MM delays the first automatic check (local time).
Requires Node.js 22+, a logged-in provider CLI, and cron on Linux.
Pings consume usage; they cannot force a quota reset.
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      time: { type: 'string' }, providers: { type: 'string' },
      'claude-model': { type: 'string' }, 'codex-model': { type: 'string' },
      'dry-run': { type: 'boolean' }, scheduled: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
    },
  });
  if (values.version) { console.log(JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).version); return; }
  if (values.help || !positionals.length) { console.log(help); return; }
  if (positionals.length !== 1) throw new Error('Expected one command. See hi-ai --help.');
  const action = positionals[0];
  const allowed = action === 'setup' ? ['time', 'providers', 'claude-model', 'codex-model']
    : action === 'run' ? ['dry-run', 'scheduled'] : [];
  for (const key of Object.keys(values)) if (!allowed.includes(key)) throw new Error(`--${key} is not valid for ${action}.`);

  let unlock;
  if (['setup', 'pause', 'resume', 'uninstall'].includes(action)) {
    unlock = await acquireLock();
    if (!unlock) throw new Error('A ping or settings change is running. Wait and retry this command.');
  }
  try {
    if (action === 'setup') {
      const previous = await readJSON('config.json');
      const detected = [];
      for (const name of Object.keys(defaults)) {
        const executable = await findExecutable(name);
        if (executable) detected.push({ name, executable });
      }
      let names = values.providers;
      let time = values.time;
      if (process.stdin.isTTY && (!values.providers || !values.time)) {
        const reader = createInterface({ input: process.stdin, output: process.stdout });
        try {
          if (!names) names = (await reader.question(`Providers [${detected.map(p => p.name).join(',')}]: `)).trim();
          if (!values.time) time = (await reader.question('First usage check at HH:MM [start now]: ')).trim() || undefined;
        } finally { reader.close(); }
      }
      const firstAt = firstStart(time);
      const selected = names === undefined || names === '' ? detected.map(p => p.name) : [...new Set(names.split(',').map(name => name.trim()))];
      if (!selected.length) throw new Error('No provider CLIs found on PATH. Install Claude Code or Codex and log in first.');
      const providers = selected.map(name => {
        if (!Object.hasOwn(defaults, name)) throw new Error(`Unknown provider: ${name}. Choose claude,codex.`);
        const executable = detected.find(p => p.name === name)?.executable;
        if (!executable) throw new Error(`${name} is not on PATH. Install it and log in first.`);
        const model = values[`${name}-model`] ?? previous?.providers.find(p => p.name === name)?.model ?? defaults[name];
        if (!model.trim() || model.startsWith('-')) throw new Error(`Invalid ${name} model.`);
        return { name, executable, model };
      });
      const runtime = await scheduler.runtime();
      const authPaths = Object.fromEntries(['CODEX_HOME', 'CLAUDE_CONFIG_DIR'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
      const next = { firstAt, providers, path: process.env.PATH, authPaths, enabled: true, scheduler: { ...runtime, installedAt: new Date().toISOString() } };
      await writeJSON('config.json', next);
      try { await scheduler.install(undefined, runtime); }
      catch (error) {
        if (previous) await writeJSON('config.json', previous);
        else await fs.rm(file('config.json'), { force: true });
        throw error;
      }
      await fs.rm(file('heartbeat.json'), { force: true });
      console.log(`Scheduled ${providers.map(p => `${p.name} (${p.model})`).join(', ')} using each provider's reported reset time.`);
      console.log(`First usage check ${time ? `from ${new Date(firstAt).toLocaleString()}` : 'due now'}, within about a minute. Idle windows get hi; active windows wait until reset.`);
    } else if (action === 'run') {
      const success = await run({ scheduled: values.scheduled, dryRun: values['dry-run'] });
      // A saved provider failure is a completed scheduler check. Actual runner
      // errors still throw and exit nonzero through main's error handler.
      if (!success && !values.scheduled) process.exitCode = 1;
    } else if (action === 'status') {
      const settings = await config();
      const state = await readState();
      const health = await scheduler.inspect(settings);
      const heartbeat = await readJSON('heartbeat.json');
      const since = Date.parse(heartbeat?.at || settings.scheduler?.installedAt);
      const stale = Number.isFinite(since) && Date.now() - since > 10 * 60 * 1000;
      const label = !settings.enabled ? 'Paused' : !health.registered ? 'Schedule missing' : health.issues.length ? 'Broken schedule' : stale ? 'Scheduler inactive' : !heartbeat ? 'Waiting for first scheduler check' : 'Scheduled';
      console.log(`${label}: provider reset times; checked every minute.`);
      console.log(`Last scheduled check: ${heartbeat ? `${heartbeat.at} (${heartbeat.phase}${heartbeat.ok === false ? ', provider failure' : ''})` : 'not observed yet'}.`);
      for (const issue of health.issues) console.log(`  ${issue}`);
      if (stale && settings.enabled && health.registered) console.log('  No scheduler check observed in over ten minutes. Check the OS scheduler and rerun hi-ai setup.');
      for (const provider of settings.providers) {
        const last = state[provider.name];
        console.log(`${provider.name} (${provider.model}): ${last?.pendingAt ? `delivery uncertain since ${last.pendingAt}` : last?.at ? `${last.ok ? 'sent' : 'failed'} at ${last.at}` : 'no pings yet'}`);
        const due = nextDueAt(settings, last);
        console.log(`  Usage: ${last?.usage ? `${last.usage.state} (${last.usage.usedPercent}% used)` : 'awaiting first usage check'}.`);
        if (last?.usageError) console.log(`  ${last.usageError}`);
        if (last?.usageFallback) console.log(`  Automatic mode: five-hour timer fallback (${last.usageFailures} consecutive usage checks failed).`);
        console.log(`  Next hello: ${!last?.usage && !last?.lastSuccessAt ? 'after checking provider usage' : due <= Date.now() ? 'due now' : new Date(due).toLocaleString()}`);
      }
      console.log(`Settings and recent results: ${home()}`);
    } else if (action === 'pause') {
      const settings = await config();
      await scheduler.remove();
      await writeJSON('config.json', { ...settings, enabled: false });
      console.log('Paused. Use hi-ai resume to restart.');
    } else if (action === 'resume') {
      const settings = await config();
      const runtime = await scheduler.runtime();
      await scheduler.install(undefined, runtime);
      await writeJSON('config.json', { ...settings, enabled: true, scheduler: { ...runtime, installedAt: new Date().toISOString() } });
      await fs.rm(file('heartbeat.json'), { force: true });
      console.log('Resumed: provider reset times. Usage is checked before starting an idle window.');
    } else if (action === 'uninstall') {
      await scheduler.remove();
      for (const name of ['config.json', 'state.json', 'runs.log', 'heartbeat.json']) await fs.rm(file(name), { force: true });
      console.log('Schedule, settings, and logs removed. Remove the CLI with npm uninstall -g hi-ai-cli.');
    } else throw new Error(`Unknown command: ${action}. See hi-ai --help.`);
  } finally { if (unlock) await unlock(); }
}

main().catch(error => {
  // Cleanup has finished and the handlers are gone, so this ends the process
  // with the original signal status.
  if (error instanceof Interrupted) { process.kill(process.pid, error.signal); return; }
  console.error(`hi-ai: ${error.message}`);
  process.exitCode = 1;
});
