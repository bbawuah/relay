# Demo recordings: provenance

The README features one recording: [relay-terminal-four-panes.gif](../media/relay-terminal-four-panes.gif), a **replay of captured terminal panes** from a single real run of the native `claude` and `codex` CLIs in four tmux panes. No T3 API, task or thread took part. The earlier T3-based live replays and the scripted replays below are **historical**: they stay in the repository, are labelled as such in their own frames, and are no longer linked from the README.

| File | Kind | Length | Size |
| --- | --- | --- | --- |
| `relay-terminal-four-panes.gif` | Featured. Replay of captured tmux panes, one real run, native CLIs, no T3 | 43.6 s (cast timings add up to 47.3 s) | 0.82 MB, 1274x1328, 34 captured frames |
| `relay-live-handoff.gif` | Historical. Replay of what live T3-started Codex and Claude agents ran | 36 s | 0.42 MB |
| `relay-live-subagents.gif` | Historical. Same live T3 run, whole run | 62 s | 0.98 MB |
| `relay-scripted-handoff.gif` | Historical. Scripted roles, real CLI output, no model | 33 s | 0.63 MB |
| `relay-scripted-subagents.gif` | Historical. Scripted roles, real CLI output, no model | 40 s | 1.48 MB |

Each GIF has a `*-poster.png` (final frame); the terminal demo also has a full-size PNG. Casts are in [casts](casts), full transcripts in [transcripts](transcripts). None of the recordings is realtime and none makes a performance claim: waiting time is cut and each step is held for readability.

## The four-pane terminal demo

- **What ran.** One run of [terminal/run.sh](terminal/run.sh) in a normal terminal outside T3, started from the committed sources of this directory: about 85 s elapsed, 5 native CLI sessions (Claude parent, Claude subagent, Codex parent, Codex subagent, then a short second Claude parent session), all exit code 0, 24 Relay wrapper calls, all rc 0, two child-process requests, a keyed retry that returned the same id with `duplicate: true`, repeated inbox reads and explicit acknowledgements and replies. At most two model processes were live at once, each with a hard 240 s deadline; the owned tmux server was stopped and no supervisor was left. The runner was executed by the lead from an archive copy of the commit.
- **What the panes show.** Real `tmux capture-pane -e` output of a window of 93x42 characters, four panes of exactly 46x20, drawn by [render-panes.swift](render-panes.swift) at 22 pt with the same columns and rows. The agents are non-interactive (`claude -p`, `codex exec`): the panes show process status lines and the activity of the Relay wrapper, not an interactive TUI.
- **Host versus Relay.** Magenta `[process]` lines and SHELL events in the transcript are process creation by the shell. A parent starts its own subagent by calling a helper that takes no arguments and only asks the shell to start the child CLI in the fixed pane of its own parent; this is a shell/tmux child process, not a vendor-internal subagent feature. Relay carries the task bodies and results, starts nothing and wakes nothing; every agent polled.
- **Models and options.** Claude: `--model sonnet --effort low --no-session-persistence`, tools limited to its own wrapper, `sleep` and (parent only) the child helper. The CLI reported usage for both `claude-haiku-5-5` and `claude-sonnet-5-5` in every Claude session; no reason is claimed. Codex: `-m gpt-6.1-sol -s workspace-write`, header showed `gpt-6.1-sol` with its native default effort (medium). No approval or sandbox bypass, no environment stripping, no change to settings or hooks.
- **Bindings.** Four manually registered peers (no host session IDs) in a fresh private namespace and state, installed Relay in a private prefix and HOME, each agent behind a wrapper that fixes `--peer`, state and namespace and accepts only `send`, `inbox`, `ack`, `list`. Not an MCP demonstration. Acknowledgements mark receipt, not completion; mailbox scoping is not OS or user authentication.
- **What was changed for publication.** Peer, message and conversation IDs are aliases; paths of the private demo directory would appear as `<demo>` (none remained); [terminal/to-cast.ts](terminal/to-cast.ts) refuses to write the cast or transcript if a home or private path, UUID, vendor session marker or T3 name remains. Waits between frames are shortened (per-frame cap, total about 47 s for an 85 s run) and each step is held for readability. Message bodies over 42 characters are cut with `…` inside the panes; the transcript has the full bodies. Consecutive empty polls are shown once. Raw wrapper logs with real IDs and the raw CLI output stay private and unpublished.
- **Limits.** The panes are 46 characters wide, so text is about 12 px at GitHub's width; phones need the [full-size frame](../media/relay-terminal-four-panes-full.png) and the [text transcript](transcripts/terminal-four-panes.md). One short run on one machine, no performance claim.

## Historical: what the T3 live replays are

- **Who ran the commands.** Agents did, not a script. The H thread started a Codex agent (`codex-parent`) and a Claude agent (`claude-parent`) with the T3 `delegate_task` tool. Each parent then started its own subagent (`codex-sub`, `claude-sub`) with `delegate_task`; T3 lists those as child threads of the parent. Providers and models come from the task metadata T3 returned, not from names the agents chose: Codex `gpt-6.1-sol` (reasoning effort low for the two parents) and Claude `claude-sonnet-5-5` (effort low for the parent). Subagent effort was requested but is not recorded in the metadata, so it is not claimed.
- **Order, to stay at two live agents.** Codex parent plus its subagent, then Claude parent plus its subagent, then a short second Codex-parent session to read the final answer. Nothing woke an agent: the mailboxes are durable, so agents did not have to be live at the same time.
- **Host versus Relay.** Lines marked `HOST · T3 delegate_task` come from the T3 task API. They are not Relay messages and Relay did none of that. Relay never starts agents or wakes them; every agent polled `inbox` itself.
- **Wrappers, not MCP.** The agents used fixed CLI wrappers. Nothing here demonstrates the MCP server; MCP scoping is separate product behavior.
- **Message wording.** The message texts were written by the agents. Words such as "handled" are model wording, not a Relay guarantee; an acknowledgement confirms receipt, not that the work was done.
- **Bindings.** The peers are registered as manual CLI connections (no invented host session IDs). Each agent received a wrapper that fixes its own `--peer`, the private state and the namespace, accepts only `send`, `inbox`, `ack`, `list`, and logs each call with its output. No MCP server, token or global setting was involved. Peer scoping is mailbox scoping, not OS or user authentication: an acknowledgement with a binding for a message outside its mailbox counts 0, which the subagents demonstrate. Acknowledgements in the recordings mark receipt, not task completion.
- **Runtime.** A copy installed from commit `096c78f` (documentation-only on top of the frozen `7f3a63d`; runtime files identical) into a private prefix, HOME and state.

## What was changed for publication

- Peer, message and conversation IDs become aliases (`codex-parent`, `msg-1`, `conv-1`); `createdAt`, `expiresAt`, `version` and `namespace` are dropped from the JSON; the wrapper's `--state/--namespace/--peer` options are not shown. No home path, hostname, token or user transcript is included; only Relay commands and outputs plus T3 delegation metadata (provider, model, effort).
- The animation shows short summaries (long message bodies are cut with `…`); the transcripts under the README GIFs contain the full command lines and outputs. Events keep their recorded order, including retries; no failures occurred in this run.
- Consecutive identical empty polls by the same peer would be collapsed into one step with a marker (none needed here), and one extra `list` call by an agent was left out because its output only lists peers.
- The demo state and the raw wrapper log (with real IDs) are isolated, kept private for review, and are not published. They were not deleted, so nothing here claims the state was removed.

## Mermaid check

The three diagrams in the README are parsed and rendered from the files in [docs/diagrams](../diagrams) with `mermaid@11.17.2` (pinned CDN URL). T3's `html_preview` loaded the library, but its screenshot is taken before Mermaid's asynchronous render finishes, so it cannot show the result. As a fallback the check ran in a headless Google Chrome with a temporary profile (no existing tab or user profile) and a virtual-time budget; all three parse and render.

## Reproduce

The terminal demo needs a normal terminal outside T3 with `tmux`, `bun`, `claude` and `codex` installed and logged in, plus `ffmpeg` and macOS `swiftc` for rendering. It touches only a fresh `/private/tmp/relay-h6run.*` directory and its own tmux socket. See [terminal/README.md](terminal/README.md).

```sh
docs/demos/terminal/run.sh --preview   # layout only, no model
docs/demos/terminal/run.sh             # full run (refuses to start a model if the CLAUDECODE marker is present)
bun docs/demos/terminal/to-cast.ts RUNDIR/proof CAST.jsonl TRANSCRIPT.md
docs/demos/terminal/render.sh CAST.jsonl OUTBASE   # GIF, poster, full-size PNG
```

The older replays:

```sh
bun docs/demos/capture.ts handoff     # scripted replay: real run, writes casts/handoff.jsonl
bun docs/demos/capture.ts subagents   # scripted replay: casts/subagents.jsonl
bun docs/demos/live-cast.ts PRIVATE_DIR OUT.jsonl handoff|subagents   # live replay from the wrapper log
docs/demos/build.sh                   # renders casts + captions into docs/media
```

`capture.ts` installs Relay from this checkout into a temporary prefix with a temporary HOME and removes it afterwards. `live-cast.ts` needs the private wrapper log that is not published, so the live casts can be re-rendered but not regenerated from this repository. `build.sh` needs macOS (`swiftc`, CoreText) and `ffmpeg`; the renderer is compiled into a temporary directory and nothing is installed globally.
