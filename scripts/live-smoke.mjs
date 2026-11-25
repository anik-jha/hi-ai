import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaults, deliveryConfirmed, execute, findExecutable, Interrupted, providerArgs, STRIPPED_API_KEYS } from '../lib/core.mjs';

if (process.env.HI_AI_LIVE_TEST !== '1') {
  console.error('This sends one real hello to each provider and consumes usage. Run HI_AI_LIVE_TEST=1 npm run test:live to opt in.');
  process.exitCode = 1;
} else {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hi-ai-live-'));
  const env = { ...process.env };
  for (const key of STRIPPED_API_KEYS) delete env[key];
  let signal;
  try {
    for (const [name, model] of Object.entries(defaults)) {
      const executable = await findExecutable(name);
      if (!executable) { console.error(`${name}: CLI missing from PATH`); process.exitCode = 1; continue; }
      try {
        const { stdout, ...result } = await execute(executable, providerArgs({ name, model }), { cwd: directory, env });
        const confirmed = result.code === 0 && !result.timedOut && !result.outputTooLarge && deliveryConfirmed(name, stdout);
        console.log(JSON.stringify({ provider: name, model, ...result, confirmed }));
        if (!confirmed) process.exitCode = 1;
      } catch (error) {
        if (error instanceof Interrupted) { signal = error.signal; break; }
        console.error(`${name}: ${error.code || 'process failed'}`); process.exitCode = 1;
      }
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
  if (signal) process.kill(process.pid, signal);
}
