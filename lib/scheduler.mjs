import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { home } from './core.mjs';
import { constants } from 'node:fs';

const label = 'io.hi-ai';
const start = '# hi-ai:begin';
const end = '# hi-ai:end';
const entry = fileURLToPath(new URL('../bin/hi-ai.mjs', import.meta.url));
const plistPath = () => path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
const domain = () => `gui/${process.getuid()}`;

export async function nodeExecutable({ current = process.execPath, searchPath = process.env.PATH || '', aliases = ['/opt/homebrew/bin/node', '/usr/local/bin/node'] } = {}) {
  const target = await fs.realpath(current);
  // fnm's multishell links and other PATH shims can be temporary. Preserve the
  // resolved installation path unless Homebrew's removable Cellar is involved.
  const cellar = target.indexOf('/Cellar/');
  if (cellar === -1) return target;
  const prefix = target.slice(0, cellar);
  const formula = target.slice(cellar + '/Cellar/'.length).split('/')[0];
  const candidates = [
    path.join(prefix, 'bin', 'node'), path.join(prefix, 'opt', formula, 'bin', 'node'),
    ...aliases,
    ...searchPath.split(path.delimiter).filter(Boolean).map(directory => path.resolve(directory, 'node')),
  ].filter(candidate => !candidate.includes('/fnm_multishells/'));
  const matches = [];
  for (const candidate of new Set(candidates)) {
    try {
      await fs.access(candidate, constants.X_OK);
      if (await fs.realpath(candidate) === target) matches.push(candidate);
    } catch { /* Missing PATH entries are normal. */ }
  }
  // Keep an upgrade-stable alias instead of resolving it into Homebrew's Cellar.
  return matches.find(candidate => !candidate.includes('/Cellar/')) || matches[0] || current;
}

export async function runtime() {
  return { node: await nodeExecutable(), script: entry };
}

export function shellQuote(value) {
  if (/[\r\n\0]/.test(value)) throw new Error('Scheduler paths cannot contain line breaks or NUL.');
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function stripCron(value) {
  const lines = value.split('\n');
  const result = [];
  let inside = false;
  for (const line of lines) {
    if (line === start) {
      if (inside) throw new Error('Malformed hi-ai crontab block. Repair it with crontab -e.');
      inside = true;
    } else if (line === end) {
      if (!inside) throw new Error('Malformed hi-ai crontab block. Repair it with crontab -e.');
      inside = false;
    } else if (!inside) result.push(line);
  }
  if (inside) throw new Error('Unclosed hi-ai crontab block. Repair it with crontab -e.');
  return result.join('\n');
}

export function cronText(previous, { node, script = entry, directory = home(), searchPath = process.env.PATH || '' } = {}) {
  if (!node) throw new Error('A Node executable is required to build the schedule.');
  const args = ['env', `HI_AI_HOME=${directory}`, `PATH=${searchPath}`, node, script, 'run', '--scheduled'];
  // cron treats percent specially even inside shell quotes.
  const command = `${args.map(shellQuote).join(' ')} >/dev/null 2>&1`.replaceAll('%', '\\%');
  const preserved = stripCron(previous).replace(/\n*$/, '');
  return `${preserved ? `${preserved}\n` : ''}${start}\n* * * * * ${command}\n${end}\n`;
}

const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');

export function plistText({ node, script = entry, directory = home(), searchPath = process.env.PATH || '' } = {}) {
  if (!node) throw new Error('A Node executable is required to build the schedule.');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${[node, script, 'run', '--scheduled'].map(value => `<string>${xml(value)}</string>`).join('')}</array>
<key>EnvironmentVariables</key><dict><key>HI_AI_HOME</key><string>${xml(directory)}</string><key>PATH</key><string>${xml(searchPath)}</string></dict>
<key>StartInterval</key><integer>60</integer>
<key>ProcessType</key><string>Background</string>
</dict></plist>
`;
}

function command(executable, args, input) {
  const result = spawnSync(executable, args, { input, encoding: 'utf8', timeout: 10_000 });
  if (result.error) throw new Error(`${executable}: ${result.error.message}`);
  return result;
}

function check(result, message) {
  if (result.status !== 0) throw new Error(`${message}: ${result.stderr.trim() || `exit ${result.status}`}`);
}

function currentCron() {
  const result = command('crontab', ['-l']);
  if (result.status === 0) return result.stdout;
  if (result.status === 1 && /no crontab/i.test(result.stderr)) return '';
  check(result, 'Cannot read crontab (install cron and check user permissions)');
}

export async function registered(platform = process.platform) {
  if (platform === 'darwin') return command('launchctl', ['print', `${domain()}/${label}`]).status === 0;
  if (platform === 'linux') return currentCron().split('\n').includes(start);
  throw new Error('Only macOS and Linux are supported.');
}

export async function install(platform = process.platform, options) {
  options ||= await runtime();
  if (platform === 'linux') {
    check(command('crontab', ['-'], cronText(currentCron(), options)), 'Cannot install crontab');
  } else if (platform === 'darwin') {
    const target = plistPath();
    await fs.mkdir(path.dirname(target), { recursive: true });
    const previous = await fs.readFile(target, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return null; throw error;
    });
    const wasRegistered = await registered(platform);
    if (wasRegistered) check(command('launchctl', ['bootout', `${domain()}/${label}`]), 'Cannot unload old schedule');
    try {
      await fs.writeFile(target, plistText(options), { mode: 0o600 });
      check(command('launchctl', ['bootstrap', domain(), target]), 'Cannot load schedule');
    } catch (error) {
      if (previous !== null) {
        await fs.writeFile(target, previous, { mode: 0o600 });
        if (wasRegistered) check(command('launchctl', ['bootstrap', domain(), target]), 'Cannot restore previous schedule');
      } else await fs.rm(target, { force: true });
      throw error;
    }
  } else throw new Error('Only macOS and Linux are supported.');
}

export async function inspect(settings, platform = process.platform) {
  const issues = [];
  let active;
  let actualNode;
  let lastExitCode;
  if (platform === 'darwin') {
    const job = command('launchctl', ['print', `${domain()}/${label}`]);
    active = job.status === 0;
    if (active) {
      actualNode = job.stdout.match(/^\s*program = (.+)$/m)?.[1]?.trim();
      const code = job.stdout.match(/^[\t ]*last exit code = (\d+)(?:[\t ]*:[^\r\n]+)?[\t ]*$/m)?.[1];
      if (code !== undefined) lastExitCode = Number(code);
    }
  } else active = await registered(platform);
  const node = actualNode || settings.scheduler?.node;
  const script = settings.scheduler?.script;
  for (const [name, target, mode] of [['Node executable', node, constants.X_OK], ['HiAI script', script, constants.R_OK]]) {
    if (!target) { issues.push(`${name} path is unknown; rerun hi-ai setup.`); continue; }
    try { await fs.access(target, mode); }
    catch { issues.push(`${name} is missing or inaccessible: ${target}. Rerun hi-ai setup.`); }
  }
  for (const provider of settings.providers) {
    try { await fs.access(provider.executable, constants.X_OK); }
    catch { issues.push(`${provider.name} executable is missing or inaccessible: ${provider.executable}.`); }
  }
  if (lastExitCode !== undefined && lastExitCode !== 0) issues.push(`launchd's last exit code was ${lastExitCode}.`);
  return { registered: active, issues, lastExitCode };
}

export async function remove(platform = process.platform) {
  if (platform === 'linux') {
    const previous = currentCron();
    const next = stripCron(previous);
    if (next !== previous) check(command('crontab', ['-'], next), 'Cannot remove schedule');
  } else if (platform === 'darwin') {
    if (await registered(platform)) check(command('launchctl', ['bootout', `${domain()}/${label}`]), 'Cannot unload schedule');
    await fs.rm(plistPath(), { force: true });
  } else throw new Error('Only macOS and Linux are supported.');
}
