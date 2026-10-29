# Demo recordings: provenance

The README shows two **live-agent replays** (`relay-live-*.gif`). Two older **scripted replays** (`relay-scripted-*.gif`) are kept only as clearly labelled illustrations. Every frame says which kind it is in its top bar. None of them is a realtime recording and none makes a performance claim: waiting time is cut and each step is held for readability.

| File | Kind | Length | Size |
| --- | --- | --- | --- |
| `relay-live-handoff.gif` | Replay of what live Codex and Claude agents ran: cross-provider handoff between two peers | 36 s | 0.42 MB |
| `relay-live-subagents.gif` | Replay of live agents: two parents and their own subagents, with scoping checks | 62 s | 0.98 MB |
| `relay-scripted-handoff.gif` | Scripted roles, real CLI output, no model | 33 s | 0.63 MB |
| `relay-scripted-subagents.gif` | Scripted roles, real CLI output, no model | 40 s | 1.48 MB |

Each GIF has a `*-poster.png` (final frame). Live casts are in [casts](casts), full command transcripts in [transcripts](transcripts).

## What the live replays are

- **Who ran the commands.** Agents did, not a script. The H thread started a Codex agent (`codex-parent`) and a Claude agent (`claude-parent`) with the T3 `delegate_task` tool. Each parent then started its own subagent (`codex-sub`, `claude-sub`) with `delegate_task`; T3 lists those as child threads of the parent. Providers and models come from the task metadata T3 returned, not from names the agents chose: Codex `gpt-6.1-sol` (reasoning effort low for the two parents) and Claude `claude-sonnet-5-5` (effort low for the parent). Subagent effort was requested but is not recorded in the metadata, so it is not claimed.
- **Order, to stay at two live agents.** Codex parent plus its subagent, then Claude parent plus its subagent, then a short second Codex-parent session to read the final answer. Nothing woke an agent: the mailboxes are durable, so agents did not have to be live at the same time.
- **Host versus Relay.** Lines marked `HOST · T3 delegate_task` come from the T3 task API. They are not Relay messages and Relay did none of that. Relay never starts agents or wakes them; every agent polled `inbox` itself.
- **Bindings.** The peers are registered as manual CLI connections (no invented host session IDs). Each agent received a wrapper that fixes its own `--peer`, the private state and the namespace, accepts only `send`, `inbox`, `ack`, `list`, and logs each call with its output. No MCP server, token or global setting was involved. Peer scoping is mailbox scoping, not OS authentication: an acknowledgement of a message outside the bound mailbox counts 0, which the subagents demonstrate.
- **Runtime.** A copy installed from commit `096c78f` (documentation-only on top of the frozen `7f3a63d`; runtime files identical) into a private prefix, HOME and state.

## What was changed for publication

- Peer, message and conversation IDs become aliases (`codex-parent`, `msg-1`, `conv-1`); `createdAt`, `expiresAt`, `version` and `namespace` are dropped from the JSON; the wrapper's `--state/--namespace/--peer` options are not shown. No home path, hostname, token or user transcript is included; only Relay commands and outputs plus T3 delegation metadata (provider, model, effort).
- The animation shows short summaries (long message bodies are cut with `…`); the transcripts under the README GIFs contain the full command lines and outputs. Events keep their recorded order, including retries; no failures occurred in these runs.
- Consecutive identical empty polls by the same peer would be collapsed into one step with a marker (none needed here), and one extra `list` call by an agent was left out because its output only lists peers.
- The demo state and the raw wrapper log (with real IDs) are isolated, kept private for review, and are not published. They were not deleted, so nothing here claims the state was removed.

## Mermaid check

The three diagrams in the README are parsed and rendered from the files in [docs/diagrams](../diagrams) with `mermaid@11.17.2` (pinned CDN URL). T3's `html_preview` loaded the library, but its screenshot is taken before Mermaid's asynchronous render finishes, so it cannot show the result. As a fallback the check ran in a headless Google Chrome with a temporary profile (no existing tab or user profile) and a virtual-time budget; all three parse and render.

## Reproduce

```sh
bun docs/demos/capture.ts handoff     # scripted replay: real run, writes casts/handoff.jsonl
bun docs/demos/capture.ts subagents   # scripted replay: casts/subagents.jsonl
bun docs/demos/live-cast.ts PRIVATE_DIR OUT.jsonl handoff|subagents   # live replay from the wrapper log
docs/demos/build.sh                   # renders casts + captions into docs/media
```

`capture.ts` installs Relay from this checkout into a temporary prefix with a temporary HOME and removes it afterwards. `live-cast.ts` needs the private wrapper log that is not published, so the live casts can be re-rendered but not regenerated from this repository. `build.sh` needs macOS (`swiftc`, CoreText) and `ffmpeg`; the renderer is compiled into a temporary directory and nothing is installed globally.
