import * as fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { execute, Interrupted } from './process.mjs';

const packageVersion = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).version;

function window(value, names, now) {
  if (value === null) return { reset: null, used: 0 };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Usage window is missing.');
  if (!Object.hasOwn(value, names.used) || !Object.hasOwn(value, names.reset)) throw new Error('Usage window fields are missing.');
  const used = value[names.used];
  const raw = value[names.reset];
  const reset = raw == null ? null : names.seconds ? Number(raw) * 1000 : Date.parse(raw);
  if (reset !== null && (!Number.isFinite(reset) || reset <= 0)) throw new Error('Usage reset time is invalid.');
  if (used == null && reset === null) return { reset: null, used: 0 };
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) throw new Error('Usage percentage is invalid.');
  if (used > 0 && reset === null) throw new Error('Used quota has no reset time.');
  return { reset: reset && reset > now ? reset : null, used };
}

function normalize(primary, secondary, now, source) {
  const blocked = secondary?.used >= 100 && secondary.reset ? secondary.reset : null;
  const reset = blocked ? Math.max(blocked, primary.reset || 0) : primary.reset;
  return {
    source, checkedAt: new Date(now).toISOString(),
    state: reset ? blocked ? 'blocked' : 'active' : 'idle',
    resetAt: reset ? new Date(reset).toISOString() : null,
    usedPercent: primary.used,
  };
}

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function localParts(formatter, time) {
  const parts = Object.fromEntries(formatter.formatToParts(time).map(part => [part.type, part.value]));
  return ['year', 'month', 'day', 'hour', 'minute'].map(key => Number(parts[key]));
}

// Resolve a wall-clock time in the reported IANA timezone, independently of the
// host timezone. Reject DST gaps and choose the later occurrence of a fold.
function wallTime(formatter, parts) {
  const [year, month, day, hour, minute] = parts;
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const candidates = new Set();
  for (const shift of [-86400_000, 0, 86400_000]) {
    const sample = wall + shift;
    const local = localParts(formatter, sample);
    const offset = Date.UTC(local[0], local[1] - 1, ...local.slice(2)) - sample;
    const candidate = wall - offset;
    if (localParts(formatter, candidate).every((value, index) => value === parts[index])) candidates.add(candidate);
  }
  return candidates.size ? Math.max(...candidates) : NaN;
}

// Claude Code formats resets with its runtime's ICU data, which joins the date
// and time with " at " (macOS system ICU) or ", " (the ICU bundled on Linux),
// and adds the year only when the reset falls in a different year.
const CLAUDE_RESET = /^(?:(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s(\d{1,2})(?:,\s(\d{4}))?(?:\sat|,)\s)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s\(([^()]+)\)$/i;

function claudeReset(text, now, maximumDelay) {
  const match = CLAUDE_RESET.exec(text);
  if (!match) throw new Error('Claude /usage reset format is unrecognized.');
  const [, monthName, dayText, yearText, hourText, minuteText = '0', period, zone] = match;
  const hour = Number(hourText); const minute = Number(minuteText);
  if (hour < 1 || hour > 12 || minute > 59) throw new Error('Claude /usage reset time is invalid.');
  let formatter;
  try { formatter = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); }
  catch { throw new Error('Claude /usage timezone is invalid.'); }
  const current = localParts(formatter, now);
  const month = monthName && months.findIndex(name => name.toLowerCase() === monthName.toLowerCase()) + 1;
  const dates = monthName
    ? (yearText ? [Number(yearText)] : [-1, 0, 1].map(offset => current[0] + offset)).map(year => [year, month, Number(dayText)])
    : [0, 1].map(offset => { const date = new Date(Date.UTC(current[0], current[1] - 1, current[2] + offset)); return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()]; });
  const candidates = dates.map(date => wallTime(formatter, [...date, hour % 12 + (period.toLowerCase() === 'pm' ? 12 : 0), minute]) + 60_000)
    .filter(time => Number.isFinite(time) && time >= now - 60_000 && time <= now + maximumDelay);
  if (!candidates.length) throw new Error('Claude /usage reset date is invalid or out of range.');
  return Math.min(...candidates);
}

function claudeWindow(line, now, maximumDelay) {
  // An idle window is reported as unused with no reset time (captured live).
  // A started window always names its reset, even at 0%.
  if (line === '0% used') return { reset: null, used: 0 };
  const match = /^(\d+(?:\.\d+)?)% used · resets (.+)$/.exec(line);
  if (!match || Number(match[1]) > 100) throw new Error('Claude /usage window is unrecognized.');
  const reset = claudeReset(match[2], now, maximumDelay);
  return { reset: reset > now ? reset : null, used: Number(match[1]) };
}

export function normalizeClaudeUsage(raw, now = Date.now()) {
  if (raw?.type !== 'result' || raw.subtype !== 'success' || raw.is_error !== false || raw.local_command !== 'usage'
      || raw.num_turns !== 0 || raw.total_cost_usd !== 0 || raw.duration_api_ms !== 0
      || !raw.modelUsage || Object.keys(raw.modelUsage).length || typeof raw.result !== 'string') {
    throw new Error('Claude did not return a local, zero-inference /usage result.');
  }
  const lines = raw.result.split(/\r?\n/);
  const session = lines.filter(line => line.startsWith('Current session: '));
  if (session.length !== 1) throw new Error('Claude /usage has no unique current-session line.');
  const primary = claudeWindow(session[0].slice('Current session: '.length), now, 6 * 3600_000);
  const weekly = lines.filter(line => line.startsWith('Current week (all models): '));
  if (weekly.length > 1) throw new Error('Claude /usage has duplicate weekly windows.');
  const secondary = weekly.length ? claudeWindow(weekly[0].slice('Current week (all models): '.length), now, 8 * 86400_000) : null;
  return normalize(primary, secondary, now, 'claude-cli-usage');
}

const CODEX_RECHECK_MS = 2000;
const codexLimits = raw => raw?.rateLimitsByLimitId?.codex || raw?.rateLimits;
const codexUnused = raw => codexLimits(raw)?.primary?.usedPercent === 0 && Number.isFinite(codexLimits(raw).primary.resetsAt);

// An idle Codex account reports an unused window whose reset is recomputed as
// one window length after each read (captured live). A started window keeps a
// fixed reset, so a later reading tells them apart without trusting the clock.
export function normalizeCodexUsage(raw, now = Date.now(), later) {
  const limits = codexLimits(later || raw);
  if (!limits || !Object.hasOwn(limits, 'primary')) throw new Error('Codex usage response has no primary window.');
  const names = { used: 'usedPercent', reset: 'resetsAt', seconds: true };
  const idle = later && codexUnused(raw) && codexUnused(later) && limits.primary.resetsAt > codexLimits(raw).primary.resetsAt;
  const primary = idle ? { reset: null, used: 0 } : window(limits.primary, names, now);
  return normalize(primary, limits.secondary == null ? null : window(limits.secondary, names, now), now, 'codex-app-server');
}

export async function readClaudeUsage(provider, { env = process.env, cwd, runner = execute } = {}) {
  // The unmodified CLI owns all authentication. An invalid model prevents an
  // inference request if a future CLI stops recognizing /usage locally.
  const result = await runner(provider.executable, ['-p', '/usage', '--safe-mode', '--no-session-persistence', '--output-format', 'json', '--model', 'hi-ai-usage-check-only-invalid-model'], { env, cwd, timeout: 30_000 });
  if (result.code !== 0 || result.timedOut || result.outputTooLarge) throw new Error('Claude /usage command failed. Check the CLI login and version.');
  let raw;
  try { raw = JSON.parse(result.stdout); } catch { throw new Error('Claude /usage returned invalid JSON.'); }
  return normalizeClaudeUsage(raw);
}

export function readCodexUsage(provider, { env = process.env, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(provider.executable, ['app-server', '--stdio'], { env, cwd, detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let buffer = ''; let bytes = 0; let done = false; let first; let recheck;
    const finish = (error, result) => {
      if (done) return;
      done = true; clearTimeout(timer); clearTimeout(recheck);
      process.off('SIGINT', onInterrupt); process.off('SIGTERM', onTerminate);
      child.stdin.destroy(); child.stdout.destroy();
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
      if (error) reject(error); else resolve(result);
    };
    const onInterrupt = () => finish(new Interrupted('SIGINT'));
    const onTerminate = () => finish(new Interrupted('SIGTERM'));
    const timer = setTimeout(() => finish(new Error('Codex usage check timed out.')), 20_000);
    const send = message => child.stdin.write(`${JSON.stringify(message)}\n`);
    process.once('SIGINT', onInterrupt); process.once('SIGTERM', onTerminate);
    child.stdin.on('error', () => finish(new Error('Codex usage connection failed.')));
    child.on('error', () => finish(new Error('Cannot start Codex usage reader.')));
    child.on('close', () => { if (!done) finish(new Error('Codex usage reader exited before returning limits.')); });
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 262_144) { finish(new Error('Codex usage response is too large.')); return; }
      buffer += chunk.toString('utf8');
      let index;
      while (!done && (index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        let message;
        try { message = JSON.parse(line); } catch { finish(new Error('Invalid Codex usage response.')); return; }
        if (![1, 2, 3].includes(message.id)) continue;
        if (message.error) { finish(new Error('Codex usage unavailable. Check the subscription login.')); return; }
        if (message.id === 1) { send({ method: 'initialized', params: {} }); send({ id: 2, method: 'account/rateLimits/read' }); }
        else if (message.id === 2 && codexUnused(message.result)) {
          first = message.result;
          recheck = setTimeout(() => send({ id: 3, method: 'account/rateLimits/read' }), CODEX_RECHECK_MS);
        } else {
          try { finish(null, first ? normalizeCodexUsage(first, Date.now(), message.result) : normalizeCodexUsage(message.result)); }
          catch (error) { finish(error); }
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'hi_ai', title: 'HiAI', version: packageVersion } } });
  });
}

export async function bootId() {
  if (process.platform === 'linux') return (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  const result = await execute('/usr/sbin/sysctl', ['-n', 'kern.boottime'], { timeout: 5000 });
  if (result.code !== 0 || !result.stdout.trim()) throw new Error('Cannot determine system boot time.');
  return result.stdout.trim();
}

export async function readUsage(provider, options) {
  return provider.name === 'claude' ? readClaudeUsage(provider, options) : readCodexUsage(provider, options);
}
