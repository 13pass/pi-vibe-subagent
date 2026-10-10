# pi-vibe-subagent

[![CI](https://github.com/13pass/pi-vibe-subagent/actions/workflows/ci.yml/badge.svg)](https://github.com/13pass/pi-vibe-subagent/actions/workflows/ci.yml)

A [pi](https://github.com/earendil-works/pi) extension that delegates self-contained tasks to [Mistral Vibe](https://github.com/mistralai/mistral-vibe) subagents.

Each subagent runs a separate `vibe -p` process, so it gets its own context window and Vibe's own harness (tools, skills, MCP servers, agent profiles). The parent pi session receives only the final text and a compact log of tool calls, so large intermediate output never enters the parent context.

## Requirements

- [pi](https://github.com/earendil-works/pi) with extension support.
- `vibe` on `PATH`, authenticated, version `>= 2.26.0`. Check with `vibe --version`.

The extension enforces the minimum version because it parses Vibe's programmatic streaming output. Set `PI_VIBE_SKIP_VERSION_CHECK=1` to bypass the check on an untested version.

## Install

```bash
pi install npm:pi-vibe-subagent
```

From a git repository or a local checkout:

```bash
pi install git:github.com/13pass/pi-vibe-subagent
pi install /absolute/path/to/pi-vibe-subagent
```

Run `/reload` in an open pi session, or start a new one. The tool appears as `vibe`.

## Usage

Single task:

```
Use vibe to find every place the session file is written.
```

Parallel tasks:

```
Use vibe with two parallel tasks:
1. list the exported functions of packages/ai/src/providers
2. summarize the test layout under packages/tui/test
```

For parallel tasks that write files, ask for `worktree: true` so each task runs in its own git worktree.

## Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `agent` | string | Vibe agent profile for single mode. Default `auto-approve`. |
| `task` | string | Single-mode task. Must be self-contained. |
| `workdir` | string | Working directory for single mode. Default: the session cwd. |
| `tasks` | array | Parallel tasks with `{ agent?, task, workdir? }`. Max 8 tasks, 4 concurrent. |
| `approval` | `auto` \| `smart` \| `inherit` | Tool approval policy. Default `smart`. |
| `model` | string | Override the Vibe model through `VIBE_ACTIVE_MODEL`. |
| `maxTurns` | number | Max assistant turns per task. Default `30`. |
| `maxPrice` | number | Max cost in dollars per task. |
| `maxTokens` | number | Max total tokens per task. |
| `timeoutMs` | number | Kill a task after this many milliseconds. |
| `worktree` | boolean | Run each task in its own git worktree. Use for parallel edits. |
| `trust` | boolean | Pass `--trust` so Vibe reads project config without prompting. Default `true`. |

## Agent profiles

`agent` maps to `vibe --agent`. Built-in profiles: `ask`, `plan`, `accept-edits`, `smart-approve`, `auto-approve`. Custom profiles come from `~/.vibe/agents/<name>.toml`.

Use `plan` for read-only exploration, `auto-approve` (or `smart-approve`) when the subagent must edit files or run commands.

## Approval and safety

`vibe -p` runs in programmatic mode, where approval callbacks are denied automatically. A task that needs tools therefore requires one of:

- `approval: "smart"` (default) - adds `--smart-approve`. Safe tool calls run, risky calls are denied.
- `approval: "auto"` - adds `--auto-approve`. Every tool runs. Use only when you accept full autonomy.
- `approval: "inherit"` - adds no flag. The selected agent profile decides.

Set the default with the `PI_VIBE_APPROVAL` environment variable and the default agent with `PI_VIBE_AGENT`.

Other constraints:

- `auto` approval runs every tool the subagent chooses inside its working directory. Treat each run like a shell command from the model.
- A subagent cannot see the parent conversation. Every task must restate the repo path, the relevant files, the constraints, and the expected output.
- Verify results yourself: inspect the diff and run the tests. Subagent output is not trusted.

## Environment variables

| Variable | Effect |
|----------|--------|
| `PI_VIBE_APPROVAL` | Default approval mode (`auto`, `smart`, `inherit`). Default `smart`. |
| `PI_VIBE_AGENT` | Default Vibe agent profile. Default `auto-approve`. |
| `PI_VIBE_SKIP_VERSION_CHECK` | Set to `1` to skip the minimum version check. |
| `VIBE_ACTIVE_MODEL` | Set by the `model` parameter; overrides the Vibe model. |

## Development

```bash
npm install --ignore-scripts
npm run check   # tsc --noEmit && node --test
```

`src/vibe.ts` holds the host-independent core (arg building, stream parsing, result mapping) and is covered by unit tests. `src/extension.ts` registers the `vibe` tool and its TUI rendering.

## How it works

The extension spawns:

```
vibe --prompt=<task> --output streaming --agent <agent> --max-turns <n> [...]
```

`--output streaming` emits one completed history entry per JSON line (`message`, `reasoning`, `effect`). The extension accumulates entries, renders tool calls from `effect` entries, and returns the last assistant message text to the model. `Ctrl+C` propagates and kills the subagent process.

## Compatibility

This extension parses Vibe's internal programmatic output, which is not a documented stable API. A Vibe release can change it. The minimum version check fails loudly when the installed Vibe is older than the tested version, and unknown entries are ignored rather than crashing. If a future Vibe changes the entry shape, a run still ends with a warning instead of garbage.

## License

MIT. See [LICENSE](LICENSE).
