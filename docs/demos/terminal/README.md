# Four-pane terminal demo (no T3 dependency)

Sources for the four-pane replay: four terminal panes in one tmux window, driven by the directly installed native `claude` and `codex` CLIs. The recorded agents run as independent native CLI processes in tmux; no T3 thread, delegation or messaging API takes part, and the demo has no T3 dependency; the host only creates processes, Relay carries every task body and result.

| File | Role |
| --- | --- |
| `run.sh` | Builds the private environment and the owned tmux server, runs the three sequenced native sessions, captures the panes. `--preview` runs no model. |
| `setup.sh` | Isolated Relay install (private prefix and HOME), new namespace and state, four manually registered peers, per-agent wrappers, the two child-start helpers. |
| `as.ts` | Fixed-peer wrapper: `--peer`, state and namespace are fixed per agent; only `send`, `inbox`, `ack`, `list` are accepted. Logs each call and prints an alias-only view into the agent's pane. |
| `launch.sh`, `pane-wait.sh`, `supervise.py` | Bounded launcher: starts one native CLI process in a pane through a small supervisor (own session/process group, hard 240 s deadline, TERM then KILL of that exact group, handles INT/TERM/HUP), prints its status and exit, and writes the exit code to a marker. Prompts for every session are in `launch.sh`. |
| `capture.ts` | `tmux capture-pane -p -e` of the four panes of the owned socket whenever something changed. |
| `to-cast.ts`, `render.sh`, `../render-panes.swift` | Sanitised cast and transcript, then a faithful 2x2 render of the captured panes into PNG frames and a GIF. |

## How to run

```sh
docs/demos/terminal/run.sh --preview   # no model: layout check
docs/demos/terminal/run.sh             # full run; refuses to start if the CLAUDECODE marker is present
```

Run from a normal terminal. The runner stops at the first problem: a missing or non-zero exit marker, a parent that exits without asking for its child, or a child that never starts ends the run, stops the capture, the owned tmux server and the supervisors. The full run is fail-closed: if `CLAUDECODE` is present in the environment it exits (status 3) before any model starts. Nothing is unset or overridden, and no approval or sandbox bypass is used. Everything lives in a fresh `/private/tmp/relay-h6run.*` directory; the tmux server uses its own socket there, with the default config disabled and `TMUX`/`TMUX_PANE` cleared for the tmux client.

## Layout

One tmux window of 93x42 characters holds four panes of exactly 46x20 (checked by `run.sh`; the title sits on the pane border). The renderer draws the same 46 columns and 20 rows at 22 pt, so the capture is wrapped by tmux at the real width, not cropped afterwards. The source frame is 1274 px wide, about 12 px text at GitHub's 728 px width; phones need the full-size image and transcript.

## Models and effort

Models: Claude `--model sonnet` (native alias), Codex `-m gpt-6.1-sol`. Reasoning effort is the native default of each CLI; `--effort low` is passed to Claude only because the option exists in its help. Codex effort is reported only if its own CLI header prints it. Resolved model names are shown only when the CLI's own output reports them, else "not reported".

## Process creation versus Relay

- **SHELL events** (magenta in the panes): the runner starts a parent CLI in its pane; the parent then calls a narrow helper that takes no arguments and only asks the shell to start the child CLI in the parent's own fixed pane. This is a shell/tmux child process, not a vendor-internal subagent feature.
- **RELAY events**: `send`, `inbox`, `ack` through the fixed wrappers. Relay starts and wakes nothing; every agent polls its own inbox.
- At most two model processes are live at once (parent plus its child), in the order Claude pair, Codex pair, then a short second Claude-parent session.

## What the GIF is

A **replay of captured terminal panes**: frames are real `tmux capture-pane -e` output rendered by `render-panes.swift`, with waits shortened. The agents run non-interactively (`claude -p`, `codex exec`), so the panes show the process status line and the Relay wrapper activity, not an interactive TUI. Peer, message and conversation IDs are aliases; paths of the private demo directory become `<demo>`; `to-cast.ts` refuses to write the cast if a home path, UUID, vendor session marker or T3 name remains. Raw wrapper logs with real IDs stay in the private proof directory and are not published.

Peer scoping is mailbox scoping, not OS or user authentication; an acknowledgement marks receipt, not completion.
