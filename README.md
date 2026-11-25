# HiAI

**A little hi, right on reset.**

[Source](https://github.com/anik-jha/hi-ai) · [Issues](https://github.com/anik-jha/hi-ai/issues) · [MIT license](LICENSE)

A small, usage-aware utility for **Claude Code, Codex, and Antigravity**, on macOS and Linux. Install it once, choose your providers, and let it follow their actual usage windows.

- **No active window:** send a minimal hello to start one.
- **An active window:** save the provider's reported reset time and send the next hello when that time arrives.
- **After a restart:** read usage again before deciding, rather than blindly starting another five-hour timer.
- **Usage unavailable:** retry first; after three consecutive failures, use a five-hour timer until usage reads recover.

HiAI uses lightweight models by default: Claude's `haiku` alias, Codex's `gpt-6-luna`, and Antigravity's `gemini-4-hydrogen-low`. It has no npm runtime dependencies, GUI, or HiAI account.

**Release status: 0.2.0.** Usage readers, timing decisions, failure recovery, and native schedulers have tests. Live usage reads, background delivery, and the idle → hello → newly active window transition have been observed on real accounts on macOS; see [Validation](#validation) for what is and is not covered. A hello consumes usage; the provider controls quota and billing.

## Install

Requires **Node.js 22+** and the selected provider CLIs, signed into your subscriptions:

- [Claude Code](https://code.claude.com/docs/en/overview): `claude auth login`.
- [Standalone Codex CLI](https://learn.chatgpt.com/docs/cli): `codex login`. HiAI skips copies inside versioned IDE extension folders.
- [Google Antigravity CLI](https://antigravity.google/docs/getting-started): sign in once with `agy`. HiAI searches `PATH` first and falls back to `~/.gemini/bin/agy` and `~/.local/bin/agy`. Antigravity is verified on macOS; Linux `cron` support with real credentials is unverified because `agy` stores personal OAuth tokens in the OS keyring (which requires an active D-Bus keyring session or Application Default Credentials under `cron`).
- On Linux: `crontab` and a running cron service. Debian/Ubuntu: `sudo apt install cron && sudo systemctl enable --now cron`.

```sh
npm install -g hi-ai-cli
hi-ai setup --providers claude,codex,antigravity
```

Setup detects CLI paths and installs a user schedule. The first automatic usage check normally runs within about a minute. It sends a hello only if the provider is idle; an existing window is allowed to reach its reported reset time first.

Use `--providers claude`, `--providers codex`, or `--providers antigravity` (`agy` is accepted as an alias) for any subset. Without `--providers`, setup offers the detected CLIs interactively.

To delay the first automatic check:

```sh
hi-ai setup --time 06:00 --providers claude,codex,antigravity
```

`--time` means the next occurrence of that local time. Subsequent hellos follow provider resets.

## Why use HiAI instead of a cron command?

Cron can launch a command. HiAI adds the account-state and recovery logic around that command, with one setup for both providers and the same management commands on macOS and Linux.

A cron expression such as `0 */5 * * *` runs at 00:00, 05:00, 10:00, 15:00, and 20:00, with only four hours between 20:00 and midnight. It also has no connection to a window you started manually at another time. HiAI reads that window and uses its reported reset instead.

| Task | HiAI handles it |
| --- | --- |
| Avoid an unnecessary startup hello | Check whether a usage window is already active. |
| Align with existing usage | Save the reset time returned by the provider. |
| Recover after restart | Refresh usage for the current boot before deciding. |
| Run multiple providers | Independent usage state, models, and deadlines. |
| Confirm delivery | Validate structured CLI responses before recording success. |
| Prevent overlapping calls | Share a lock across scheduled runs, manual runs, and settings changes. |
| Handle uncertainty | Apply timeouts, request backoff, and delivery cooldowns. |
| Manage the schedule | Preview, inspect status, pause, resume, and uninstall. |

You can implement this in your own script. HiAI packages it together, with tests and zero npm runtime dependencies.

## Use

```sh
hi-ai status        # Usage state, next hello, and last scheduler check
hi-ai run --dry-run # Preview hello arguments without sending anything
hi-ai run           # Explicitly send now, overriding the automatic usage decision
hi-ai pause         # Remove the schedule; retain settings and state
hi-ai resume        # Reinstall the schedule and refresh usage
hi-ai uninstall     # Remove the schedule, settings, state, and logs
npm uninstall -g hi-ai-cli
```

Change providers or models by rerunning setup:

```sh
hi-ai setup --providers claude,codex,antigravity \
  --claude-model haiku --codex-model gpt-6-luna \
  --antigravity-model gemini-4-hydrogen-low
```

Model access depends on your account. There is no automatic fallback to a more expensive model. Recent CLIs are required for the flags used here; see the validation notes below.

## How scheduling works

A user LaunchAgent on macOS, or a marked block in the user's crontab on Linux, checks due times once a minute. Model calls happen only when a hello is due. Reading usage does not run inference.

At the first check, after setup/resume, and after an OS reboot, HiAI reads current usage. If a window is active, its deadline is saved. A normal check at that deadline sends one hello; it does not keep chasing a newly advanced deadline. A reported exhausted weekly quota postpones the hello until that blocking window resets. Claude reset times have minute precision; HiAI waits until the displayed minute has fully elapsed to avoid sending early.

Usage readings are cached briefly. An active deadline can be followed without repeatedly querying the service. Failed usage checks retry no sooner than five minutes, honoring any longer retry deadline. After three consecutive failures (normally about ten minutes), that provider switches to a five-hour timer. With no previous hello or known reset, the third failed check can send the first hello. Existing reset deadlines and delivery cooldowns still apply. HiAI keeps trying usage reads and returns to provider reset times when they recover. `status` identifies timer fallback explicitly; failed reads are never labeled idle.

If a provider still reports an idle window after a successful hello, HiAI limits automatic sends to at most one per five hours. This prevents reporting lag, unmetered plans, or different quota pools from producing a hello on every check. A provider-reported reset takes precedence over this local safety interval.

Sleep and shutdown pause execution. The next available check handles an overdue deadline once; missed intervals do not create a burst of messages. HiAI does not wake the computer. macOS requires a logged-in user session; Linux requires cron to be running. Delivery can be about a minute after a deadline, plus OS and CLI delays.

Each provider has a two-minute hello timeout. HiAI records an attempt before calling the CLI. After interruption, timeout, or an unconfirmed response, a five-hour cooldown reduces duplicate sends when delivery is uncertain. This is not an exactly-once delivery guarantee. Known provider failures can retry after five minutes.

A saved provider failure is a completed scheduled check, so the scheduler process exits 0 and the provider error remains visible in `status`. Crashes, invalid state, and storage/configuration errors still exit nonzero. Explicit manual runs also exit nonzero on provider failure.

## Usage access and privacy

**Claude:** HiAI runs the installed, unmodified `claude -p /usage --safe-mode --no-session-persistence --output-format json` command. Claude Code owns login and credential refresh. HiAI does not read the Keychain, credential files, access tokens, or refresh tokens, and makes no direct Anthropic HTTP requests.

The command uses a deliberately invalid model name, so a CLI that stops recognizing `/usage` locally cannot silently turn the check into a normal model request. HiAI requires a local `usage` result with zero turns, zero API duration, zero cost, and no model usage before parsing the current-session and all-model weekly lines. The human-readable reset includes a timezone, and its wording follows the platform's date formatting: `Nov 13 at 5am` on macOS, `Nov 13, 5am` on Linux, with the year added when the reset falls in the next year. HiAI accepts both forms and handles timezone offsets, year rollover, and daylight-saving changes. Missing or changed output counts as a failed read. Both session states have been captured live: an active session names its reset time, and an idle session reads `0% used` with no reset time.

**Codex:** HiAI starts the installed CLI's app server and calls the documented [`account/rateLimits/read`](https://learn.chatgpt.com/docs/app-server) method. It creates no thread or inference turn and does not parse Codex credential files. An idle Codex account reports an unused window whose reset time moves forward with every read, while a started window keeps a fixed reset. When the window is unused, HiAI reads twice, two seconds apart, and treats a moving reset as idle.

**Antigravity:** HiAI runs the installed, unmodified `agy -p /usage --output-format json` command with session-only settings (`--settings`) and requires a local `usage` command response with zero turns and zero tokens. Unlike Claude Code, `agy` rejects unknown `--model` names before running local slash commands, so an invalid-model guard cannot be used; if a future CLI ever turns `/usage` into a model request (`num_turns > 0`, nonzero tokens, or a non-`usage` command), HiAI rejects the reading and pauses Antigravity usage checks for seven days rather than retrying every five minutes. Antigravity owns keyring sign-in and credential refresh; HiAI does not read keyring entries or credential files. Antigravity groups quota into `Gemini Models` and `Claude and GPT models`, each with five-hour and weekly buckets; HiAI selects the quota group matching `--antigravity-model` (falling back to the weekly bucket on weekly-only plans). Like Codex, an unused Antigravity bucket reports `remaining_fraction: 1` with a reset time that advances on each read, so HiAI rechecks two seconds later when `remaining_fraction` is `1`.

Custom `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, Linux D-Bus/runtime (`XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`), and Antigravity ADC (`AGY_ADC_AUTH`, `GOOGLE_APPLICATION_CREDENTIALS`, `CLOUDSDK_CONFIG`) variables are retained by setup when present. Inherited API-key variables (`OPENAI_API_KEY`, `CODEX_API_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`) are removed from subprocesses to prefer saved subscription logins; check that your CLIs use the intended account.

Hellos run in a temporary empty directory. Claude tools, MCP servers, and user hooks are disabled for the invocation. Codex ignores user config for the hello and uses its read-only sandbox. Antigravity disables slash commands, enables its sandbox, enforces `strict` tool permissions (which headless print mode soft-denies without executing), and disables paid AI credit overages (`useG1Credits: false`) for the invocation. Provider output is inspected in memory, not saved to the log.

Settings, sanitized quota observations, deadlines, the latest scheduler heartbeat, and the latest 100 result records live in `~/.hi-ai/`. Logs contain confirmation/process metadata, not provider output or credentials. `HI_AI_HOME` overrides this directory.

## Runtime and status

For Homebrew Node, setup selects a stable executable link such as `/opt/homebrew/bin/node`, rather than a versioned Cellar path. Other installations retain their resolved installation path, avoiding fnm's per-shell links. Rerun setup after moving the package or changing installation managers.

`status` distinguishes a loaded job from an observed scheduled check, reports missing executables and named launchd exit codes such as `78: EX_CONFIG`, and flags a heartbeat older than ten minutes. A provider error is shown separately from a broken scheduler.

Setup, pause, resume, and uninstall refuse to change settings while a check or hello is running; retry when it finishes. Invalid JSON or timestamps stop sending until the saved state is repaired. An interrupted lock-recovery error names the lock to remove after confirming no HiAI process is running.

## Test

From the repository:

```sh
npm test
npm run test:docker
HI_AI_TEST_LAUNCHD=1 node --test test/macos-launchd.test.mjs
```

The local suite covers idle/active usage, provider resets, reboot refresh, deadline latching, weekly blocks, malformed CLI output, timezone and year boundaries, daylight-saving gaps and folds, repeated-failure timer fallback and recovery, RPC requests without inference, and sanitized persisted observations. It also covers lifecycle commands, concurrency, interruption recovery, invalid state, Node upgrade links, fnm cleanup, named launchd exit codes, and provider versus scheduler failures.

The Docker test installs the actual npm archive on Node 22 with Debian cron. Real cron ticks send and repeat fake hellos using controlled usage fixtures, and lifecycle commands preserve unrelated jobs. Allow about two minutes. The macOS test uses a real timer: an active fixture receives no early hello, then both providers are invoked after its reset. It also simulates a Node-link upgrade and provider failure without labeling the schedule broken. No automated scheduler test reads real credentials or sends paid requests.

For explicit live checks:

```sh
HI_AI_LIVE_TEST=1 npm run test:live
HI_AI_LIVE_TEST=1 npm run test:live:scheduled
```

`test:live` forces one real hello per provider and consumes usage. `test:live:scheduled` installs a temporary macOS schedule, reads actual usage, and either sends if idle or confirms the saved reset deadline. It then removes the temporary schedule and refuses to replace an existing HiAI LaunchAgent.

## Validation

Verified on one Mac with Claude Code 2.1.311, standalone Codex CLI 0.167.1, and Antigravity CLI 1.5.16:

- **Claude Code and Codex:** live background hello delivery, live usage reads, and a real scheduled `launchd` startup that detected active windows, saved their reported reset times, and sent no early hellos. On 2026-11-12, both were followed through the full idle → hello → newly active window transition on live accounts.
- **Antigravity:** live zero-inference `agy -p /usage --output-format json` reads across both quota groups (`Gemini Models` active with a fixed five-hour reset, `Claude and GPT models` idle with an advancing reset), a sandboxed scheduled check under `launchd`-equivalent environment variables that latched the active Gemini reset without sending early, a confirmed live `gemini-4-hydrogen-low` hello on macOS, and `0.1.1` → `0.2.0` config compatibility.

On Linux, the unit suite and the Docker real-cron test passed in `0.1.1` on Ubuntu 24.04 (aarch64) with Node 22 using stand-in provider CLIs. Not yet verified for `0.2.0`: a live `launchd` tick and full idle → hello → active reset cycle on Antigravity, re-running `npm run test:docker` with the three-provider fixture, and live authenticated CLIs on Linux (particularly Antigravity under `cron`, where keyring access without a desktop D-Bus session or ADC is untested). Passing scheduler tests or a hello response does not prove that a provider replenishes quota.

HiAI delegates authentication to the unmodified Claude Code binary, following the boundary in Anthropic’s [authentication and credential-use rules](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use). Anthropic also [documents scripted CLI usage](https://code.claude.com/docs/en/headless). Provider terms and plan rules apply.

## Run from source

```sh
git clone https://github.com/anik-jha/hi-ai.git
cd hi-ai
npm install -g .
```

Maintained by [anik-jha](https://github.com/anik-jha).
