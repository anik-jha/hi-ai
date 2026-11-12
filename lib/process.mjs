import { spawn } from 'node:child_process';

// Thrown instead of exiting, so callers release locks and temporary files
// before the entry point re-raises the signal.
export class Interrupted extends Error {
  constructor(signal) {
    super(`Interrupted by ${signal}.`);
    this.signal = signal;
  }
}

// No shell, no unbounded output, and terminate the whole process group on timeout.
export function execute(executable, args, { cwd, env = process.env, timeout = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let timedOut = false;
    let outputTooLarge = false;
    let size = 0;
    const chunks = [];
    const stop = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ } };
    const interrupt = signal => { stop(); cleanup(); reject(new Interrupted(signal)); };
    const onInterrupt = () => interrupt('SIGINT');
    const onTerminate = () => interrupt('SIGTERM');
    const cleanup = () => {
      clearTimeout(timer);
      process.off('SIGINT', onInterrupt); process.off('SIGTERM', onTerminate);
    };
    process.once('SIGINT', onInterrupt); process.once('SIGTERM', onTerminate);
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > 262_144) { outputTooLarge = true; stop(); }
      else chunks.push(chunk);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeout);
    child.on('error', error => { cleanup(); reject(error); });
    child.on('close', (code, signal) => {
      cleanup();
      resolve({ code, signal, timedOut, outputTooLarge, stdout: Buffer.concat(chunks).toString('utf8') });
    });
  });
}
