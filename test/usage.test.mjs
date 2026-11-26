import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeAntigravityUsage, normalizeClaudeUsage, normalizeCodexUsage, readAntigravityUsage, readClaudeUsage, readCodexUsage } from '../lib/usage.mjs';
import { prepareScheduled, nextDueAt, run, writeJSON, FIVE_HOURS_MS } from '../lib/core.mjs';

const now = Date.now();
const stamp = value => new Date(value).toISOString();
const idle = { state: 'idle', resetAt: null, checkedAt: stamp(now), usedPercent: 0, source: 'fixture' };
const active = { ...idle, state: 'active', resetAt: stamp(now + 3600_000), usedPercent: 4 };
const provider = { name: 'claude', executable: '/unused/claude', model: 'haiku' };

const claudeResult = text => ({ type: 'result', subtype: 'success', is_error: false, local_command: 'usage', num_turns: 0, total_cost_usd: 0, duration_api_ms: 0, modelUsage: {}, result: text });
const claudeNow = Date.parse('2026-11-12T06:00:00Z');
const session = 'Current session: 7% used · resets Nov 12 at 3:19am (America/Phoenix)';
const week = 'Current week (all models): 31% used · resets Nov 17 at 4:59pm (America/Phoenix)';
// Captured live on 2026-11-12 after the five-hour window had expired.
const idleSession = `Current session: 0% used\n${week}\nCurrent week (Fable): 54% used · resets Nov 17 at 4:59pm (America/Phoenix)`;
// Captured live from an idle Codex account: every read reports an unused
// window that resets exactly one window length after the read itself.
const codexIdle = resetsAt => ({ rateLimits: { limitId: 'codex', primary: { usedPercent: 0, windowDurationMins: 300, resetsAt }, secondary: { usedPercent: 27, windowDurationMins: 10080, resetsAt: 1794987570 } } });
const codexNow = Date.parse('2026-11-12T14:53:22Z');
// Captured live from Antigravity CLI 1.5.16 on 2026-11-25: Gemini Models had an
// active 5-hour window with a fixed reset_time, while the unused 3P group moved
// its reset_time forward on each read.
const antigravityNow = Date.parse('2026-11-25T05:49:53Z');
const antigravityResult = ({ gemini5h = { remaining: 0.6350659728050232, reset: '2026-11-25T09:52:39Z' }, geminiWeekly = { remaining: 0.8977535963058472, reset: '2026-12-02T04:52:39Z' }, thirdParty5h = { remaining: 1, reset: '2026-11-25T10:49:53Z' }, thirdPartyWeekly = { remaining: 1, reset: '2026-12-02T05:49:53Z' } } = {}) => ({
  conversation_id: '', status: 'SUCCESS', response: '', duration_seconds: 0, num_turns: 0,
  usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
  command: {
    name: 'usage',
    data: {
      groups: [
        {
          name: 'Gemini Models',
          buckets: [
            { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: geminiWeekly.remaining, reset_time: geminiWeekly.reset },
            { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: gemini5h.remaining, reset_time: gemini5h.reset },
          ],
        },
        {
          name: 'Claude and GPT models',
          buckets: [
            { id: '3p-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: thirdPartyWeekly.remaining, reset_time: thirdPartyWeekly.reset },
            { id: '3p-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: thirdParty5h.remaining, reset_time: thirdParty5h.reset },
          ],
        },
      ],
    },
  },
});

test('Claude parses the captured local /usage result, including active zero-percent windows', () => {
  const reading = normalizeClaudeUsage(claudeResult(session), claudeNow);
  assert.equal(reading.state, 'active');
  assert.equal(reading.resetAt, '2026-11-12T10:20:00.000Z');
  assert.equal(reading.source, 'claude-cli-usage');
  assert.equal(normalizeClaudeUsage(claudeResult(session.replace('7%', '0%')), claudeNow).state, 'active');
  for (const text of ['', 'Current session: 5% used', 'Current session: Not started', session + '\n' + session, session.replace('7%', '101%'), session.replace('America/Phoenix', 'Invalid/Zone'), session.replace('Nov 12', 'Nov 31')]) {
    assert.throws(() => normalizeClaudeUsage(claudeResult(text), claudeNow));
  }
  for (const change of [{ local_command: undefined }, { num_turns: 1 }, { total_cost_usd: 1 }, { duration_api_ms: 1 }, { modelUsage: { haiku: {} } }]) {
    assert.throws(() => normalizeClaudeUsage({ ...claudeResult(session), ...change }, claudeNow));
  }
});

test('Claude reads the captured idle session, which has no reset time, as idle', () => {
  const reading = normalizeClaudeUsage(claudeResult(idleSession), claudeNow);
  assert.deepEqual([reading.state, reading.resetAt, reading.usedPercent], ['idle', null, 0]);
  const blocked = normalizeClaudeUsage(claudeResult(idleSession.replace('31% used', '100% used')), claudeNow);
  assert.deepEqual([blocked.state, blocked.resetAt], ['blocked', '2026-11-18T00:00:00.000Z']);
});

test('Claude resolves year rollover and time-only resets independently of the host timezone', () => {
  const beforeNewYear = Date.parse('2027-01-01T05:00:00Z');
  const reading = normalizeClaudeUsage(claudeResult('Current session: 1% used · resets Jan 1 at 1am (America/Phoenix)'), beforeNewYear);
  assert.equal(reading.resetAt, '2027-01-01T08:01:00.000Z');
  assert.equal(normalizeClaudeUsage(claudeResult('Current session: 1% used · resets 3:19am (America/Phoenix)'), claudeNow).resetAt, '2026-11-12T10:20:00.000Z');
});

// Claude Code formats resets with its runtime's ICU data: macOS system ICU joins
// the date and time with " at ", the ICU bundled on Linux with ", " (captured
// live), and both add the year when the reset falls in a different year.
test('Claude parses the reset formats of both ICU builds', () => {
  const linux = 'Current session: 4% used · resets Nov 13, 5am (America/Phoenix)';
  assert.equal(normalizeClaudeUsage(claudeResult(linux), Date.parse('2026-11-13T08:00:00Z')).resetAt, '2026-11-13T12:01:00.000Z');
  const comma = text => text.replaceAll(' at ', ', ');
  assert.equal(normalizeClaudeUsage(claudeResult(comma(`${session}\n${week}`)), claudeNow).resetAt, '2026-11-12T10:20:00.000Z');
  assert.equal(normalizeClaudeUsage(claudeResult(comma(idleSession.replace('31% used', '100% used'))), claudeNow).resetAt, '2026-11-18T00:00:00.000Z');
  for (const reset of ['Nov 12 3:19am', 'Nov 12,, 3:19am', 'Nov 12, at 3:19am', 'Nov 12 at, 3:19am', 'Nov 12, 26, 3:19am']) {
    assert.throws(() => normalizeClaudeUsage(claudeResult(session.replace('Nov 12 at 3:19am', reset)), claudeNow), /format is unrecognized/);
  }
});

test('Claude resolves resets in the next year, which both formats print with the year', () => {
  const newYearsEve = Date.parse('2027-01-01T05:00:00Z');
  for (const reset of ['Jan 1, 2027 at 1am', 'Jan 1, 2027, 1am']) {
    assert.equal(normalizeClaudeUsage(claudeResult(`Current session: 1% used · resets ${reset} (America/Phoenix)`), newYearsEve).resetAt, '2027-01-01T08:01:00.000Z');
  }
  assert.throws(() => normalizeClaudeUsage(claudeResult('Current session: 1% used · resets Jan 1, 2028, 1am (America/Phoenix)'), newYearsEve), /out of range/);
  const weekly = 'Current week (all models): 100% used · resets Jan 3, 2027, 4:59pm (America/Phoenix)';
  const reading = normalizeClaudeUsage(claudeResult(`${session.replace('Nov 12 at 3:19am', 'Dec 29 at 1am')}\n${weekly}`), Date.parse('2026-12-29T05:00:00Z'));
  assert.deepEqual([reading.state, reading.resetAt], ['blocked', '2027-01-04T00:00:00.000Z']);
});

test('Claude rejects DST gaps and waits for the later occurrence of ambiguous reset times', () => {
  assert.throws(() => normalizeClaudeUsage(claudeResult('Current session: 1% used · resets Mar 8 at 2:30am (America/New_York)'), Date.parse('2026-03-08T05:00:00Z')));
  assert.equal(normalizeClaudeUsage(claudeResult('Current session: 1% used · resets Nov 1 at 1:30am (America/New_York)'), Date.parse('2026-11-01T04:00:00Z')).resetAt, '2026-11-01T06:31:00.000Z');
});

test('exhausted weekly quota postpones a hello until the blocking window resets', () => {
  const reading = normalizeClaudeUsage(claudeResult(session + '\nCurrent week (all models): 100% used · resets Nov 17 at 4:59pm (America/Phoenix)'), claudeNow);
  assert.equal(reading.state, 'blocked');
  assert.equal(reading.resetAt, '2026-11-18T00:00:00.000Z');
});

test('Codex uses the codex bucket and Unix-second reset timestamps', () => {
  const reset = Math.floor((now + 3600_000) / 1000);
  const limits = { primary: { usedPercent: 14, resetsAt: reset }, secondary: null };
  const reading = normalizeCodexUsage({ rateLimits: { primary: null }, rateLimitsByLimitId: { codex: limits } }, now);
  assert.equal(reading.state, 'active');
  assert.equal(reading.resetAt, stamp(reset * 1000));
  assert.equal(normalizeCodexUsage({ rateLimits: { primary: null, secondary: null } }, now).state, 'idle');
  assert.throws(() => normalizeCodexUsage({}, now));
  assert.throws(() => normalizeCodexUsage({ rateLimits: { primary: {} } }, now));
});

test('first startup sends only for confirmed idle usage and stores active reset times', async () => {
  const settings = { firstAt: stamp(now) };
  const empty = {};
  assert.equal(await prepareScheduled(provider, settings, empty, { now, boot: 'boot-1', usageReader: async () => idle }), true);
  assert.equal(empty.usage.boot, 'boot-1');
  const busy = {};
  assert.equal(await prepareScheduled(provider, settings, busy, { now, boot: 'boot-1', usageReader: async () => active }), false);
  assert.equal(busy.resetAt, active.resetAt);
  assert.equal(nextDueAt(settings, busy), Date.parse(active.resetAt));
});

test('a latched reset fires once instead of chasing the next window forever', async () => {
  const last = { resetAt: stamp(now - 1000), usage: { ...active, boot: 'boot-1' } };
  let calls = 0;
  assert.equal(await prepareScheduled(provider, {}, last, { now, boot: 'boot-1', usageReader: async () => { calls++; return active; } }), true);
  assert.equal(calls, 0);
});

test('after a reboot an old deadline is refreshed against the actual active window', async () => {
  const last = { resetAt: stamp(now - 1000), usage: { ...active, boot: 'old-boot' } };
  let calls = 0;
  assert.equal(await prepareScheduled(provider, {}, last, { now, boot: 'new-boot', usageReader: async () => { calls++; return active; } }), false);
  assert.equal(calls, 1);
  assert.equal(last.resetAt, active.resetAt);
  assert.equal(last.usage.boot, 'new-boot');
});

test('setup/resume forces a fresh check even on the same boot', async () => {
  const last = { resetAt: active.resetAt, usage: { ...active, checkedAt: stamp(now - 2000), boot: 'boot-1' } };
  const settings = { scheduler: { installedAt: stamp(now - 1000) } };
  let calls = 0;
  await prepareScheduled(provider, settings, last, { now, boot: 'boot-1', usageReader: async () => { calls++; return active; } });
  assert.equal(calls, 1);
});

test('initial unknown usage waits and Retry-After survives a reboot', async () => {
  const last = {};
  let calls = 0;
  const usageReader = async () => { calls++; const error = new Error('HTTP 429'); error.retryAfterMs = 900_000; throw error; };
  assert.equal(await prepareScheduled(provider, {}, last, { now, boot: 'boot-1', usageReader }), false);
  assert.equal(last.usageRetryAt, stamp(now + 900_000));
  assert.equal(await prepareScheduled(provider, {}, last, { now: now + 60_000, boot: 'boot-2', usageReader }), false);
  assert.equal(calls, 1);
});

test('idle reporting lag cannot produce a hello on every check', async () => {
  const last = { lastSuccessAt: stamp(now - 60_000), usage: { ...idle, boot: 'boot-1' } };
  assert.equal(await prepareScheduled(provider, {}, last, { now, boot: 'boot-1', usageReader: async () => idle }), false);
  assert.equal(nextDueAt({}, last), now - 60_000 + FIVE_HOURS_MS);
});

test('three consecutive failed reads enable the five-hour timer and a successful read restores reset scheduling', async () => {
  const last = {};
  const failure = async () => { throw new Error('format changed'); };
  for (const [index, elapsed] of [0, 300_000, 600_000].entries()) {
    const ready = await prepareScheduled(provider, {}, last, { now: now + elapsed, boot: 'boot-1', usageReader: failure });
    assert.equal(ready, index === 2);
    assert.equal(last.usageFailures, index + 1);
  }
  assert.equal(last.usageFallback, true);
  assert.equal(last.usage, undefined, 'failed reads are not recorded as idle');
  last.lastSuccessAt = stamp(now + 600_000);
  assert.equal(await prepareScheduled(provider, {}, last, { now: now + 900_000, boot: 'boot-2', usageReader: failure }), false, 'fallback survives reboot without duplicating the hello');
  assert.equal(await prepareScheduled(provider, {}, last, { now: now + 600_000 + FIVE_HOURS_MS, boot: 'boot-2', usageReader: failure }), true);
  const resumedAt = now + 600_000 + FIVE_HOURS_MS + 300_000;
  assert.equal(await prepareScheduled(provider, {}, last, { now: resumedAt, boot: 'boot-2', usageReader: async () => ({ ...active, checkedAt: stamp(resumedAt), resetAt: stamp(resumedAt + 3600_000) }) }), false);
  assert.equal(last.usageFallback, undefined);
  assert.equal(last.usageFailures, undefined);
  assert.equal(last.usageError, undefined);
  assert.equal(last.resetAt, stamp(resumedAt + 3600_000));
});

test('timer fallback preserves a known active deadline, weekly block, and uncertain-delivery cooldown', async () => {
  const failure = async () => { throw new Error('unavailable'); };
  for (const state of [
    { resetAt: stamp(now + 3600_000), usageFailures: 2 },
    { resetAt: stamp(now + 24 * 3600_000), usageFailures: 2 },
    { pendingAt: stamp(now - 60_000), usageFailures: 3, usageFallback: true },
  ]) {
    assert.equal(await prepareScheduled(provider, {}, state, { now, boot: 'new-boot', usageReader: failure }), false);
  }
});

test('a reported reset earlier than five hours takes precedence over the local safety clock', () => {
  const last = { lastSuccessAt: stamp(now), resetAt: stamp(now + 4 * 3600_000) };
  assert.equal(nextDueAt({}, last), now + 4 * 3600_000);
});

test('malformed cached usage is refreshed rather than assumed idle', async () => {
  const last = { usage: { ...idle, state: 'garbage', boot: 'boot-1' } };
  assert.equal(await prepareScheduled(provider, {}, last, { now, boot: 'boot-1', usageReader: async () => { throw new Error('offline'); } }), false);
  assert.ok(last.usageError);
});

test('Codex reads an unused window whose reset moves with each read as idle', () => {
  const reading = normalizeCodexUsage(codexIdle(1794513202), codexNow, codexIdle(1794513206));
  assert.deepEqual([reading.state, reading.resetAt, reading.usedPercent], ['idle', null, 0]);
  // A started window keeps its reset time, even before any usage registers.
  const started = normalizeCodexUsage(codexIdle(1794513202), codexNow, codexIdle(1794513202));
  assert.deepEqual([started.state, started.resetAt], ['active', stamp(1794513202 * 1000)]);
  const weekly = codexIdle(1794513206);
  weekly.rateLimits.secondary.usedPercent = 100;
  const blocked = normalizeCodexUsage(codexIdle(1794513202), codexNow, weekly);
  assert.deepEqual([blocked.state, blocked.resetAt], ['blocked', stamp(1794987570 * 1000)]);
});

test('Claude reads only through its CLI with a deliberately invalid model and returns sanitized usage', async () => {
  const calls = [];
  const result = await readClaudeUsage(provider, {
    now: claudeNow,
    runner: async (executable, args, options) => { calls.push({ executable, args, options }); return { code: 0, stdout: JSON.stringify(claudeResult(idleSession)) }; },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, provider.executable);
  assert.deepEqual(calls[0].args.slice(0, 2), ['-p', '/usage']);
  assert.ok(calls[0].args.includes('--safe-mode'));
  assert.equal(calls[0].args.at(-1), 'hi-ai-usage-check-only-invalid-model');
  assert.equal(result.state, 'idle');
  assert.equal('result' in result, false);
});

test('Antigravity parses captured active Gemini usage, matches the model quota group, and handles weekly blocks', () => {
  const reading = normalizeAntigravityUsage(antigravityResult(), antigravityNow, undefined, 'gemini-4-hydrogen-low');
  assert.equal(reading.state, 'active');
  assert.equal(reading.resetAt, '2026-11-25T09:52:39.000Z');
  assert.equal(reading.usedPercent, 36.5);
  assert.equal(reading.source, 'antigravity-cli-usage');

  // An unused bucket whose reset_time moves forward across reads is idle.
  const later = antigravityResult({ thirdParty5h: { remaining: 1, reset: '2026-11-25T10:49:58Z' }, thirdPartyWeekly: { remaining: 1, reset: '2026-12-02T05:49:58Z' } });
  const idleThirdParty = normalizeAntigravityUsage(antigravityResult(), antigravityNow, later, 'claude-sonnet-5-5-low');
  assert.deepEqual([idleThirdParty.state, idleThirdParty.resetAt, idleThirdParty.usedPercent], ['idle', null, 0]);

  // A started 0%-used window keeps a fixed reset_time.
  const startedZero = normalizeAntigravityUsage(antigravityResult(), antigravityNow, antigravityResult(), 'gpt-oss-120b-medium');
  assert.deepEqual([startedZero.state, startedZero.resetAt], ['active', '2026-11-25T10:49:53.000Z']);
  const underscoreThirdParty = normalizeAntigravityUsage(antigravityResult(), antigravityNow, later, 'claude_sonnet_5_5');
  assert.deepEqual([underscoreThirdParty.state, underscoreThirdParty.resetAt], ['idle', null]);

  // An unstarted group can instead report the zero timestamp as its reset (captured live).
  const unset = antigravityResult({ thirdParty5h: { remaining: 1, reset: '1970-01-01T00:00:00Z' }, thirdPartyWeekly: { remaining: 1, reset: '1970-01-01T00:00:00Z' } });
  const unsetThirdParty = normalizeAntigravityUsage(unset, antigravityNow, undefined, 'claude-sonnet-5-5-low');
  assert.deepEqual([unsetThirdParty.state, unsetThirdParty.resetAt, unsetThirdParty.usedPercent], ['idle', null, 0]);

  // Near-exhausted weekly quota (99.99% used) does not block; 0 remaining does.
  const nearlyFull = antigravityResult({ geminiWeekly: { remaining: 0.0001, reset: '2026-12-02T04:52:39Z' } });
  assert.equal(normalizeAntigravityUsage(nearlyFull, antigravityNow).state, 'active');
  const blocked = antigravityResult({ geminiWeekly: { remaining: 0, reset: '2026-12-02T04:52:39Z' } });
  assert.deepEqual([normalizeAntigravityUsage(blocked, antigravityNow).state, normalizeAntigravityUsage(blocked, antigravityNow).resetAt], ['blocked', '2026-12-02T04:52:39.000Z']);

  // Weekly-only plan tiers use the weekly bucket rather than failing into a 5h timer.
  const weeklyOnly = antigravityResult();
  weeklyOnly.command.data.groups[0].buckets = [weeklyOnly.command.data.groups[0].buckets[0]];
  assert.equal(normalizeAntigravityUsage(weeklyOnly, antigravityNow).resetAt, '2026-12-02T04:52:39.000Z');

  for (const invalid of [
    { ...antigravityResult(), status: 'ERROR' },
    { ...antigravityResult(), num_turns: 1 },
    { ...antigravityResult(), usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } },
    { ...antigravityResult(), command: { name: 'model', data: { groups: [] } } },
    antigravityResult({ gemini5h: { remaining: -0.1, reset: '2026-11-25T09:52:39Z' } }),
    antigravityResult({ gemini5h: { remaining: 0.5, reset: 'not-a-date' } }),
    antigravityResult({ gemini5h: { remaining: 0.5, reset: null } }),
    antigravityResult({ gemini5h: { remaining: 0.5, reset: '1970-01-01T00:00:00Z' } }),
  ]) {
    assert.throws(() => normalizeAntigravityUsage(invalid, antigravityNow));
  }
});

test('Antigravity reads active windows once, rechecks unused windows, and hides subprocess output on error', async () => {
  const agy = { name: 'antigravity', executable: '/unused/agy', model: 'gemini-4-hydrogen-low' };
  let activeCalls = 0; let waits = 0;
  const activeReading = await readAntigravityUsage(agy, {
    now: antigravityNow,
    wait: async () => { waits++; },
    runner: async () => { activeCalls++; return { code: 0, stdout: JSON.stringify(antigravityResult()) }; },
  });
  assert.equal(activeCalls, 1);
  assert.equal(waits, 0);
  assert.equal(activeReading.state, 'active');

  let idleCalls = 0;
  const idleReading = await readAntigravityUsage({ ...agy, model: 'claude-sonnet-5-5-low' }, {
    now: antigravityNow,
    wait: async () => { waits++; },
    runner: async () => {
      idleCalls++;
      const reset = idleCalls === 1 ? '2026-11-25T10:49:53Z' : '2026-11-25T10:49:55Z';
      return { code: 0, stdout: JSON.stringify(antigravityResult({ thirdParty5h: { remaining: 1, reset } })) };
    },
  });
  assert.equal(idleCalls, 2);
  assert.equal(waits, 1);
  assert.equal(idleReading.state, 'idle');

  // A zero-timestamp reset already means no window, so it needs no recheck.
  let unsetCalls = 0;
  const unsetReset = { remaining: 1, reset: '1970-01-01T00:00:00Z' };
  const unsetReading = await readAntigravityUsage({ ...agy, model: 'claude-sonnet-5-5-low' }, {
    now: antigravityNow,
    wait: async () => { waits++; },
    runner: async () => { unsetCalls++; return { code: 0, stdout: JSON.stringify(antigravityResult({ thirdParty5h: unsetReset, thirdPartyWeekly: unsetReset })) }; },
  });
  assert.equal(unsetCalls, 1);
  assert.equal(waits, 1);
  assert.equal(unsetReading.state, 'idle');

  for (const response of [{ code: 1, stdout: 'secret token' }, { code: 0, timedOut: true }, { code: 0, outputTooLarge: true }, { code: 0, stdout: 'secret token' }]) {
    await assert.rejects(readAntigravityUsage(agy, { runner: async () => response }), error => !error.message.includes('secret token'));
  }

  // Since agy rejects fake model names upfront, a future CLI that turned /usage
  // into a real prompt must trigger a 7-day backoff instead of retrying every 5m
  // or falling back to five-hour timer sends, even after prior failures or
  // across repeated weekly checks.
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const modelTurn = { ...antigravityResult(), command: undefined, num_turns: 1, usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 } };
  const readModelTurn = at => () => readAntigravityUsage(agy, { now: at, runner: async () => ({ code: 0, stdout: JSON.stringify(modelTurn) }) });
  const state = {};
  for (let week = 0; week < 3; week++) {
    const checkAt = antigravityNow + week * weekMs;
    assert.equal(await prepareScheduled(agy, {}, state, { now: checkAt, boot: 'boot-1', usageReader: readModelTurn(checkAt) }), false);
    assert.equal(state.usageRetryAt, stamp(checkAt + weekMs));
    assert.equal(state.usageFallback, undefined);
  }
  let retries = 0;
  assert.equal(await prepareScheduled(agy, {}, state, { now: antigravityNow + 2 * weekMs + 60 * 60 * 1000, boot: 'boot-1', usageReader: async () => { retries++; return idle; } }), false);
  assert.equal(retries, 0);

  const priorFailures = { usageFailures: 2, usageFallback: true };
  assert.equal(await prepareScheduled(agy, {}, priorFailures, { now: antigravityNow, boot: 'boot-1', usageReader: readModelTurn(antigravityNow) }), false);
  assert.equal(priorFailures.usageRetryAt, stamp(antigravityNow + weekMs));
  assert.equal(priorFailures.usageFallback, undefined);

  // Any spent token counter is inference, including ones the validity check ignores.
  const thinkingOnly = { ...antigravityResult(), usage: { ...antigravityResult().usage, thinking_tokens: 12 } };
  assert.throws(() => normalizeAntigravityUsage(thinkingOnly, antigravityNow), error => error.retryAfterMs === weekMs && error.pauseFallback === true);

  // A renamed command field with zero turns and tokens is a format change: it
  // retries in five minutes and reaches the timer fallback after three reads.
  const renamed = { ...antigravityResult(), command: { ...antigravityResult().command, name: 'quota' } };
  const formatState = {};
  const readRenamed = () => readAntigravityUsage(agy, { now: antigravityNow, runner: async () => ({ code: 0, stdout: JSON.stringify(renamed) }) });
  for (const [index, elapsed] of [0, 300_000, 600_000].entries()) {
    const due = await prepareScheduled(agy, {}, formatState, { now: antigravityNow + elapsed, boot: 'boot-1', usageReader: readRenamed });
    assert.equal(formatState.usageRetryAt, stamp(antigravityNow + elapsed + 300_000));
    assert.equal(due, index === 2);
  }
  assert.equal(formatState.usageFallback, true);
});

test('Claude subprocess errors, invalid JSON, and model responses become unknown usage without logging output', async () => {
  for (const response of [{ code: 1, stdout: 'private output' }, { code: 0, timedOut: true }, { code: 0, outputTooLarge: true }, { code: 0, stdout: 'private output' }, { code: 0, stdout: JSON.stringify({ ...claudeResult(session), num_turns: 1 }) }]) {
    await assert.rejects(readClaudeUsage(provider, { runner: async () => response }), error => !error.message.includes('private output'));
  }
});

test('Codex RPC initializes then reads limits without starting an inference turn', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hi-ai-rpc-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, 'codex');
  const calls = path.join(directory, 'requests.jsonl');
  const result = { rateLimits: { primary: { usedPercent: 14, resetsAt: Math.floor((Date.now() + 3600_000) / 1000) }, secondary: null } };
  await fs.writeFile(executable, `#!/usr/bin/env node
const fs=require('node:fs');const rl=require('node:readline').createInterface({input:process.stdin});
rl.on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(m)+'\\n');
if(m.method==='initialize')console.log(JSON.stringify({id:m.id,result:{}}));
if(m.method==='account/rateLimits/read')console.log(JSON.stringify({id:m.id,result:${JSON.stringify(result)}}));});
`, { mode: 0o755 });
  const reading = await readCodexUsage({ executable });
  assert.equal(reading.state, 'active');
  const methods = (await fs.readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line).method);
  assert.deepEqual(methods, ['initialize', 'initialized', 'account/rateLimits/read']);
});

test('Codex RPC reads an unused window twice and reports idle when its reset moves', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hi-ai-rpc-idle-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, 'codex');
  const calls = path.join(directory, 'requests.jsonl');
  await fs.writeFile(executable, `#!/usr/bin/env node
const fs=require('node:fs');const rl=require('node:readline').createInterface({input:process.stdin});
rl.on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(m)+'\\n');
if(m.method==='initialize')console.log(JSON.stringify({id:m.id,result:{}}));
if(m.method==='account/rateLimits/read')console.log(JSON.stringify({id:m.id,result:{rateLimits:{primary:{usedPercent:0,windowDurationMins:300,resetsAt:Math.floor(Date.now()/1000)+18000},secondary:null}}}));});
`, { mode: 0o755 });
  const reading = await readCodexUsage({ executable });
  assert.deepEqual([reading.state, reading.resetAt], ['idle', null]);
  const methods = (await fs.readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line).method);
  assert.deepEqual(methods, ['initialize', 'initialized', 'account/rateLimits/read', 'account/rateLimits/read']);
});

test('the scheduled runner waits for an active provider while starting the idle provider, then survives a restart', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hi-ai-usage-runner-'));
  const saved = Object.fromEntries(['HI_AI_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'].map(key => [key, process.env[key]]));
  process.env.HI_AI_HOME = path.join(directory, 'state');
  process.env.CLAUDE_CONFIG_DIR = path.join(directory, 'claude-login');
  process.env.CODEX_HOME = path.join(directory, 'codex-login');
  t.after(async () => {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fs.rm(directory, { recursive: true, force: true });
  });
  const messages = path.join(directory, 'sent');
  const providers = [];
  for (const name of ['claude', 'codex']) {
    const executable = path.join(directory, name);
    const response = name === 'claude' ? JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'hi' })
      : [JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'hi' } }), JSON.stringify({ type: 'turn.completed' })].join('\n');
    await fs.writeFile(executable, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(messages)}, '${name}\\n');\nconsole.log(${JSON.stringify(response)});\n`, { mode: 0o755 });
    providers.push({ name, executable, model: name === 'claude' ? 'haiku' : 'gpt-6-luna' });
  }
  await writeJSON('config.json', { enabled: true, firstAt: stamp(Date.now() - 1000), providers });
  let checks = 0;
  const usageReader = async p => { checks++; return { ...(p.name === 'claude' ? active : idle), checkedAt: stamp(Date.now()) }; };
  assert.equal(await run({ scheduled: true, usageReader, bootIdentifier: 'boot-1', output: () => {} }), true);
  assert.equal(await fs.readFile(messages, 'utf8'), 'codex\n');
  assert.equal(await run({ scheduled: true, usageReader, bootIdentifier: 'boot-1', output: () => {} }), true);
  assert.equal(checks, 2, 'cached limits do not cause a new read on every minute check');
  assert.equal(await fs.readFile(messages, 'utf8'), 'codex\n');
  assert.equal(await run({ scheduled: true, usageReader: async () => ({ ...active, checkedAt: stamp(Date.now()) }), bootIdentifier: 'boot-2', output: () => {} }), true);
  assert.equal(await fs.readFile(messages, 'utf8'), 'codex\n', 'restart must not blindly send another hello');
  const statePath = path.join(process.env.HI_AI_HOME, 'state.json');
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(state.claude.usage.boot, 'boot-2');
  state.claude.resetAt = stamp(Date.now() - 1000);
  await fs.writeFile(statePath, JSON.stringify(state));
  assert.equal(await run({ scheduled: true, usageReader, bootIdentifier: 'boot-2', output: () => {} }), true);
  assert.equal(await fs.readFile(messages, 'utf8'), 'codex\nclaude\n');
});
