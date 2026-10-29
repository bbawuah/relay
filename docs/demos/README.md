# Demo recordings: provenance

Both GIFs in [docs/media](../media) are **replays of real Relay CLI runs with scripted roles. No AI model, Claude or Codex process took part.** Each frame says so in its top bar. They show what the installed `relay` CLI actually printed; they are not live provider recordings.

| File | What it shows | Length | Size |
| --- | --- | --- | --- |
| `relay-handoff.gif` | A claude-host peer hands a task to a codex-host peer: stored receipt, request-key retry (`duplicate: true`), non-destructive `inbox`, explicit `ack`, reply in the same conversation, an unrelated peer that sees nothing | 37 s | 0.6 MB |
| `relay-subagents.gif` | Parent and subagent peers on two runtimes: cross-runtime task, parent-to-subagent delegation, result back, fan-out, and a subagent that cannot acknowledge its parent's mail | 45 s | 1.5 MB |

Each GIF has a static `*-poster.png` (its final frame) and a plain-text transcript in [casts](casts).

## What is real and what is scripted

- **Real:** every command line and every output line comes from running the installed `relay` 0.2.0 (copy installed from commit `7f3a63d`) in a disposable HOME, prefix, cwd and state directory under a private temporary path, namespace `showcase`. The directory is deleted afterwards.
- **Scripted:** which peer acts next, the message texts, and the captions. The `# HOST step (marker, not Relay)` lines are markers only. In real use the host runtime (Claude, Codex, T3) starts subagents; Relay never does, and nothing in these recordings started one.
- **Sanitised:** peer, message and conversation IDs are replaced by readable aliases (`claude-lead`, `msg-1`, `conv-1`); timestamps, schema version and namespace fields are dropped from the JSON; the global `--state` and `--namespace` options are omitted from the displayed command to fit the width. No home path, hostname, token or user conversation appears. Peer names, session IDs and message texts are made up for the demo.
- **Polling:** all hosts poll. Nothing in these runs wakes or notifies an agent.

## Reproduce

```sh
bun docs/demos/capture.ts handoff     # real run, writes casts/handoff.jsonl
bun docs/demos/capture.ts subagents   # real run, writes casts/subagents.jsonl
docs/demos/build.sh                   # renders casts + captions into docs/media
```

`capture.ts` installs Relay from this checkout into a temporary prefix with a temporary HOME and removes everything when it finishes. `build.sh` needs macOS (`swiftc`, CoreText) and `ffmpeg`; the renderer `render.swift` is compiled into a temporary directory and nothing is installed globally.
