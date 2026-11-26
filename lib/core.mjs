import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execute, Interrupted } from './process.mjs';
import { ANTIGRAVITY_SETTINGS, bootId, readUsage } from './usage.mjs';
export { execute, Interrupted } from './process.mjs';

export const defaults = { claude: 'haiku', codex: 'gpt-6-luna', antigravity: 'gemini-4-hydrogen-low' };
export const SESSION_ENV_KEYS = ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'];
export const SSH_ENV_KEYS = ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY'];
export const AUTH_ENV_KEYS = [
  'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
  ...SESSION_ENV_KEYS,
  'AGY_ADC_AUTH', 'AGY_CLI_FORCE_FILE_TOKEN_STORAGE',
  'GOOGLE_APPLICATION_CREDENTIALS', 'CLOUDSDK_CONFIG',
];
export const STRIPPED_API_KEYS = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'];

export function captureAuthPaths(providers, env = process.env, platform = process.platform) {
  const authPaths = Object.fromEntries(AUTH_ENV_KEYS.filter(key => env[key]).map(key => [key, env[key]]));
  // Over SSH, agy stores OAuth tokens in a local file instead of the OS keyring.
  // Cron lacks SSH_* variables, so persist file-storage mode for Linux SSH setups.
  if (platform === 'linux' && !authPaths.AGY_CLI_FORCE_FILE_TOKEN_STORAGE
      && providers.some(provider => provider.name === 'antigravity')
      && SSH_ENV_KEYS.some(key => env[key])) {
    authPaths.AGY_CLI_FORCE_FILE_TOKEN_STORAGE = '1';
  }
  return authPaths;
}
export const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
export const RETRY_DELAY_MS = 5 * 60 * 1000;
export const USAGE_FAILURE_LIMIT = 3;
export const home = () => path.resolve(process.env.HI_AI_HOME || path.join(os.homedir(), '.hi-ai'));
export const file = name => path.join(home(), name);

export async function readJSON(name, fallback) {
  try { return JSON.parse(await fs.readFile(file(name), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export async function writeJSON(name, value) {
  await fs.mkdir(home(), { recursive: true, mode: 0o700 });
  const target = file(name);
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, target);
  } finally { await fs.rm(temporary, { force: true }); }
}

export async function config() {
  const value = await readJSON('config.json');
  if (!value) throw new Error('Run hi-ai setup first.');
  if (!value || typeof value !== 'object' || typeof value.enabled !== 'boolean') throw new Error('Invalid configuration. Run hi-ai setup again.');
  if (value.firstAt !== undefined && (typeof value.firstAt !== 'string' || !Number.isFinite(Date.parse(value.firstAt)))) throw new Error('Invalid start time. Run hi-ai setup again.');
  if (!Array.isArray(value.providers) || !value.providers.length) throw new Error('No providers configured. Run setup again.');
  for (const provider of value.providers) {
    if (!provider || !Object.hasOwn(defaults, provider.name) || typeof provider.executable !== 'string' || !path.isAbsolute(provider.executable) || typeof provider.model !== 'string' || !provider.model.trim() || provider.model.startsWith('-')) {
      throw new Error('Invalid provider configuration. Run setup again.');
    }
  }
  if (new Set(value.providers.map(provider => provider.name)).size !== value.providers.length) throw new Error('Duplicate providers in configuration. Run hi-ai setup again.');
  return value;
}

export async function readState() {
  const state = await readJSON('state.json', {});
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Invalid state.json; repair or restore it before sending more pings.');
  for (const last of Object.values(state)) {
    if (!last || typeof last !== 'object' || (last.ok !== undefined && typeof last.ok !== 'boolean')) throw new Error('Invalid provider state; repair state.json before sending more pings.');
    for (const key of ['at', 'lastSuccessAt', 'pendingAt', 'resetAt', 'usageRetryAt']) {
      if (last[key] !== undefined && (typeof last[key] !== 'string' || !Number.isFinite(Date.parse(last[key])))) throw new Error(`Invalid ${key} in state.json; repair it before sending more pings.`);
    }
    if (last.usageFailures !== undefined && (!Number.isSafeInteger(last.usageFailures) || last.usageFailures < 0)) throw new Error('Invalid usage failure count in state.json.');
  }
  return state;
}

export function validateTime(value) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('Time must be HH:MM in 24-hour local time, for example 06:00.');
  return value;
}

export async function findExecutable(name) {
  const binary = name === 'antigravity' ? 'agy' : name;
  const userHome = process.env.HOME || os.homedir();
  const directories = [
    ...(process.env.PATH || '').split(path.delimiter).filter(Boolean),
    ...(binary === 'agy' ? [path.join(userHome, '.gemini', 'bin'), path.join(userHome, '.local', 'bin')] : []),
  ];
  for (const directory of directories) {
    const candidate = path.resolve(directory, binary);
    if (binary === 'codex' && /[/\\]openai\.chatgpt-[^/\\]+[/\\]/.test(candidate)) continue;
    try {
      await fs.access(candidate, constants.X_OK);
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch { /* Try the next directory. */ }
  }
  return null;
}

export function providerArgs(provider) {
  const prompt = 'hi. Reply only: hi';
  if (provider.name === 'claude') return [
    '-p', prompt, '--model', provider.model, '--tools', '', '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence',
    '--setting-sources', '', '--settings', '{"disableAllHooks":true}',
    '--system-prompt', 'Reply with hi.', '--output-format', 'json',
  ];
  if (provider.name === 'antigravity') return [
    '-p', prompt, '--model', provider.model, '--output-format', 'json',
    '--disable-slash-commands', '--sandbox', '--print-timeout', '90s',
    '--settings', ANTIGRAVITY_SETTINGS,
  ];
  return [
    'exec', '--model', provider.model, '--json', '--ephemeral', '--skip-git-repo-check',
    '--ignore-user-config', '--sandbox', 'read-only', '--color', 'never',
    '-c', 'model_provider="openai"', '-c', 'model_reasoning_effort="low"',
    '-c', 'developer_instructions="Reply with hi. Do not use tools."', prompt,
  ];
}

export function deliveryConfirmed(name, stdout) {
  try {
    if (name === 'claude') {
      const result = JSON.parse(stdout);
      return result.type === 'result' && result.subtype === 'success' && result.is_error === false && typeof result.result === 'string' && !!result.result.trim();
    }
    if (name === 'antigravity') {
      const result = JSON.parse(stdout);
      return result.status === 'SUCCESS' && !result.error && typeof result.response === 'string' && !!result.response.trim();
    }
    const events = stdout.trim().split('\n').map(line => JSON.parse(line));
    return !events.some(event => ['error', 'turn.failed'].includes(event.type))
      && events.some(event => event.type === 'turn.completed')
      && events.some(event => event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string' && !!event.item.text.trim());
  } catch { return false; }
}

export function firstStart(time, now = new Date()) {
  if (time === undefined) return now.toISOString();
  validateTime(time);
  const [hour, minute] = time.split(':').map(Number);
  const first = new Date(now);
  first.setHours(hour, minute, 0, 0);
  if (first <= now) first.setDate(first.getDate() + 1);
  return first.toISOString();
}

export function nextDueAt(settings, last) {
  const successAt = Date.parse(last?.lastSuccessAt);
  const resetAt = Date.parse(last?.resetAt);
  let due = Number.isFinite(resetAt) ? resetAt : Number.isFinite(successAt) ? successAt + FIVE_HOURS_MS : Date.parse(settings.firstAt || '1970-01-01T00:00:00Z');
  const attemptAt = Date.parse(last?.at);
  if (last?.ok === false && Number.isFinite(attemptAt)) due = Math.max(due, attemptAt + RETRY_DELAY_MS);
  const pendingAt = Date.parse(last?.pendingAt);
  if (Number.isFinite(pendingAt)) due = Math.max(due, pendingAt + FIVE_HOURS_MS);
  const retryAt = Date.parse(last?.usageRetryAt);
  if (Number.isFinite(retryAt)) due = Math.max(due, retryAt);
  return due;
}

export async function prepareScheduled(provider, settings, last, { boot, now = Date.now(), usageReader = readUsage, env = process.env, cwd } = {}) {
  const coolingDown = Math.max(
    Date.parse(last.pendingAt) + FIVE_HOURS_MS || 0,
    last.ok === false ? Date.parse(last.at) + RETRY_DELAY_MS || 0 : 0,
    Date.parse(last.usageRetryAt) || 0,
  );
  if (now < coolingDown) return false;
  if (!last.lastSuccessAt && !last.resetAt && now < Date.parse(settings.firstAt)) return false;
  const deadline = Date.parse(last.resetAt);
  const cachedAt = Date.parse(last.usage?.checkedAt);
  const observationValid = observation => ['idle', 'active', 'blocked'].includes(observation?.state)
    && Number.isFinite(Date.parse(observation.checkedAt))
    && typeof observation.usedPercent === 'number' && Number.isFinite(observation.usedPercent)
    && (observation.state === 'idle' ? observation.resetAt === null : Number.isFinite(Date.parse(observation.resetAt)));
  const sameSession = observationValid(last.usage) && last.usage.boot === boot
    && cachedAt >= (Date.parse(settings.scheduler?.installedAt) || 0);
  // Latch a known deadline: re-reading a newly advanced quota window here could
  // postpone the hello forever. A recorded reset produces one attempt.
  if (Number.isFinite(deadline) && deadline <= now && sameSession) return true;
  if (Number.isFinite(deadline) && deadline > now && sameSession) return false;
  if (!sameSession || cachedAt > now || now - cachedAt >= RETRY_DELAY_MS) {
    try {
      const observation = await usageReader(provider, { env, cwd });
      if (!observationValid(observation)) throw new Error('Provider usage response is invalid.');
      last.usage = { ...observation, boot };
      delete last.usageError; delete last.usageRetryAt; delete last.usageFailures; delete last.usageFallback;
    } catch (error) {
      if (error instanceof Interrupted) throw error;
      last.usageError = `${provider.name} usage check unavailable: ${error.message || 'request failed'}`.slice(0, 200);
      const delay = Number.isFinite(error.retryAfterMs) ? Math.max(RETRY_DELAY_MS, error.retryAfterMs) : RETRY_DELAY_MS;
      last.usageRetryAt = new Date(now + Math.min(delay, 7 * 24 * 60 * 60 * 1000)).toISOString();
      if (error.pauseFallback) {
        delete last.usageFallback;
        return false;
      }
      last.usageFailures = Math.min((last.usageFailures || 0) + 1, 1_000_000);
      if (last.usageFailures < USAGE_FAILURE_LIMIT) return false;
      last.usageFallback = true;
      // Keep known reset deadlines and delivery cooldowns. A failed read never
      // becomes an idle observation; this is explicitly the local timer mode.
      return now >= nextDueAt(settings, { ...last, usageRetryAt: undefined });
    }
  }
  const observedReset = Date.parse(last.usage.resetAt);
  if (last.usage.state !== 'idle' && Number.isFinite(observedReset) && observedReset > now) {
    last.resetAt = last.usage.resetAt;
    return false;
  }
  delete last.resetAt;
  if (Number.isFinite(deadline) && deadline <= now) return true;
  // If a successful hi is followed by an idle reading (reporting lag, an
  // unmetered plan, or a separate quota pool), do not send a hi on every tick.
  return now >= nextDueAt(settings, last);
}

export async function acquireLock() {
  await fs.mkdir(home(), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(file('run.lock'), 'wx', 0o600);
      try { await handle.writeFile(String(process.pid)); }
      catch (error) { await fs.rm(file('run.lock'), { force: true }); throw error; }
      finally { await handle.close(); }
      return () => fs.rm(file('run.lock'), { force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Only one process may reclaim a stale lock. Otherwise two reapers can
      // accidentally unlink a new owner's live lock.
      let recovery;
      try { recovery = await fs.open(file('recovery.lock'), 'wx', 0o600); }
      catch (failure) {
        if (failure.code !== 'EEXIST') throw failure;
        const owner = Number(await fs.readFile(file('recovery.lock'), 'utf8').catch(() => ''));
        if (Number.isInteger(owner) && owner > 0) {
          try { process.kill(owner, 0); }
          catch (problem) {
            if (problem.code === 'ESRCH') throw new Error(`Interrupted lock recovery. Confirm no HiAI process is running before removing ${file('recovery.lock')}.`);
          }
        } else {
          const stat = await fs.stat(file('recovery.lock')).catch(() => null);
          if (stat && Date.now() - stat.mtimeMs > RETRY_DELAY_MS) throw new Error(`Incomplete lock recovery. Confirm no HiAI process is running before removing ${file('recovery.lock')}.`);
        }
        return null;
      }
      try {
        await recovery.writeFile(String(process.pid));
        const pid = Number(await fs.readFile(file('run.lock'), 'utf8').catch(() => ''));
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); return null; }
          catch (failure) { if (failure.code !== 'ESRCH') return null; }
        } else {
          const stat = await fs.stat(file('run.lock')).catch(() => null);
          if (stat && Date.now() - stat.mtimeMs < 300_000) return null;
        }
        await fs.rm(file('run.lock'), { force: true });
      } finally {
        await recovery.close();
        await fs.rm(file('recovery.lock'), { force: true });
      }
    }
  }
  return null;
}

async function log(entry) {
  const previous = await fs.readFile(file('runs.log'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return ''; throw error;
  });
  const lines = [...previous.trim().split('\n').filter(Boolean), JSON.stringify(entry)].slice(-100);
  await fs.writeFile(file('runs.log'), `${lines.join('\n')}\n`, { mode: 0o600 });
}

export async function run({ scheduled = false, dryRun = false, output = console.log, usageReader = readUsage, bootIdentifier } = {}) {
  if (dryRun) {
    const settings = await config();
    for (const provider of settings.providers) output(JSON.stringify([provider.executable, ...providerArgs(provider)]));
    return true;
  }
  const unlock = await acquireLock();
  if (!unlock) { output('A ping is already running; skipped.'); return true; }
  let workspace;
  let scheduledCheck = false;
  try {
    const settings = await config();
    if (scheduled && !settings.enabled) { output('Paused.'); return true; }
    if (scheduled) {
      await writeJSON('heartbeat.json', { at: new Date().toISOString(), phase: 'started' });
      scheduledCheck = true;
    }
    const state = await readState();
    const env = { ...process.env, PATH: settings.path || process.env.PATH };
    for (const key of AUTH_ENV_KEYS) {
      if (settings.authPaths?.[key] && (!SESSION_ENV_KEYS.includes(key) || !env[key])) env[key] = settings.authPaths[key];
    }
    // Prefer the CLI's saved subscription login over inherited API keys.
    for (const key of STRIPPED_API_KEYS) delete env[key];
    const boot = scheduled ? bootIdentifier || await bootId() : null;
    let success = true;
    for (const provider of settings.providers) {
      state[provider.name] ||= {};
      if (scheduled) {
        workspace ||= await fs.mkdtemp(path.join(os.tmpdir(), 'hi-ai-'));
        const ready = await prepareScheduled(provider, settings, state[provider.name], { boot, usageReader, env, cwd: workspace });
        await writeJSON('state.json', state);
        if (state[provider.name].usageFallback) output(`${provider.name}: five-hour timer fallback (${state[provider.name].usageFailures} consecutive usage checks failed).`);
        if (!ready) {
          output(state[provider.name].usageError || `${provider.name}: waiting for its usage window reset.`);
          if (state[provider.name].usageError) success = false;
          continue;
        }
      }
      workspace ||= await fs.mkdtemp(path.join(os.tmpdir(), 'hi-ai-'));
      state[provider.name] = { ...state[provider.name], pendingAt: new Date().toISOString() };
      // If interrupted after delivery, the next run waits five hours rather
      // than immediately repeating a message whose outcome is unknown.
      await writeJSON('state.json', state);
      let result;
      try {
        const { stdout, ...details } = await execute(provider.executable, providerArgs(provider), { cwd: workspace, env });
        result = { ...details, confirmed: details.code === 0 && deliveryConfirmed(provider.name, stdout) };
      } catch (error) {
        // Leave pendingAt in place: the hello may have been delivered.
        if (error instanceof Interrupted) throw error;
        result = { code: null, error: error.code || 'spawn failed' };
      }
      const ok = result.confirmed === true && !result.timedOut && !result.outputTooLarge;
      const entry = { at: new Date().toISOString(), provider: provider.name, ok, ...result };
      if (!ok && result.code === 0) entry.error = 'unconfirmed_response';
      if (ok || (result.code !== 0 && !result.signal && !result.timedOut && !result.outputTooLarge)) delete state[provider.name].pendingAt;
      state[provider.name] = { ...state[provider.name], ...entry, ...(ok ? { lastSuccessAt: entry.at } : {}) };
      delete state[provider.name].resetAt;
      // Persist each provider immediately: a later provider failure must not cause duplicate pings.
      await writeJSON('state.json', state);
      await log(entry);
      output(ok ? `${provider.name}: hi sent.` : `${provider.name}: failed${result.timedOut ? ' (timed out)' : ''}. Check its CLI login, model access, and version.`);
      if (!ok) success = false;
    }
    if (scheduledCheck) await writeJSON('heartbeat.json', { at: new Date().toISOString(), phase: 'finished', ok: success });
    return success;
  } catch (error) {
    if (scheduledCheck && !(error instanceof Interrupted)) await writeJSON('heartbeat.json', { at: new Date().toISOString(), phase: 'failed' }).catch(() => {});
    throw error;
  } finally {
    try { if (workspace) await fs.rm(workspace, { recursive: true, force: true }); }
    finally { await unlock(); }
  }
}
