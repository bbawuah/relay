# Configuration and host integration

All peers on a bus must use the same state directory. Use a separate directory for independent projects or tests.

| Relay setting | Compatible legacy setting | Meaning |
| --- | --- | --- |
| `RELAY_NAME` / global `--name` | `LAB_AGENT_NAAM` | Sender/session name |
| `RELAY_LEAD` / global `--lead` | `LAB_LEAD_NAAM` | Session to report to; default trust relationship |
| `RELAY_ROLE` / global `--role` | `LAB_AGENT_ROL` | Legacy CLI operator/worker checks |
| `RELAY_STATE_DIR` / global `--state` | `LAB_LEAD_STAAT` | Shared state; default `~/.local/state/relay` |

Relay variables take precedence. Global options go **before** the command; launch and register have their own `--name` options. Message arguments are never interpreted by the global parser. Names contain letters, digits, `.`, `_` and `-`, at most 100 characters, and cannot start with `.`. Case-only duplicate live names are refused.

The extracted files under `scripts/lead/` keep their original `LAB_*` interface and default `~/.local/state/lab-lead`. The `relay` command normalizes settings before calling them. To join the existing monorepo bus explicitly:

```sh
RELAY_STATE_DIR="$HOME/.local/state/lab-lead" relay list
```

Do not point a demo at live state. Changing a global Codex home's state affects all hooks using that home; use a separate Codex home for independent buses.

## Direct MCP configuration

An MCP server must be called `peers` to preserve the extracted hook matchers and wake-up instructions. Use absolute executable paths:

```json
{
  "mcpServers": {
    "peers": {
      "command": "/absolute/path/to/.local/bin/relay",
      "args": ["--name", "worker", "--state", "/absolute/path/to/state", "mcp"]
    }
  }
}
```

The server does not register a session itself. Use Relay's launcher/session hooks or `relay register` first. Manual peers have `host: "geen"`, so messages are delivered without wake-ups. They remain registered until `unregister` is called.

In Codex TOML, use the equivalent `mcp_servers.peers.command`, `args` and `env` fields. Prefer Relay's launcher for a TUI: it supplies a fresh identity and MCP environment per session rather than storing a worker's name globally.

## T3 Code

The extracted adapter recognizes `host: "t3"` records with `t3_thread` and wakes them through the `t3` CLI. It checks `pendingRequestCount` before sending a count-only notification, so a pending user question is not intentionally answered by a wake-up. Configure `LAB_T3` if the CLI is not on PATH. Without it, peers can still poll their inboxes.

T3 threads do not inherit a per-thread shell environment. Configure the `peers` MCP server in the provider, use the existing workspace identity integration from `scripts/lead/hooks/`, and set the same state directory for hooks and MCP. The existing `spawn.sh --t3` implementation is preserved for reference, but app-owned orchestration should use T3's current thread/delegation APIs. Relay does not automatically alter T3 provider settings or create threads.

## Wake-up requirements

| Host | Requirement | Fallback |
| --- | --- | --- |
| Claude TUI | Messaging socket advertised by the CLI under `/tmp/cc-socks` or `$TMPDIR/cc-socks` | Hook count notification / inbox polling |
| Codex TUI | `codex queue`, target thread ID and correct Codex home | Hook count notification / inbox polling |
| T3 | `t3 thread show/send`, target thread ID, no pending request | Inbox polling |
| ACP / manual peer | No active wake-up adapter in this extraction | Inbox polling |

Wake-ups are coalesced in five-second windows. A send inside that window can wait up to five seconds. Successful persistence is independent of successful waking. See the protocol README for queue and lock limits and remaining known races.

## Existing hook policy

`relay setup` wraps the extracted installers. Both support dry-run, removal, explicit destinations and backups. Codex setup persists the selected state in every hook command, so a stale daemon environment cannot redirect hooks to a different bus. The installers still use `lab-lead-hooks` markers to recognize existing installations; take care when migrating a shared home.

The preserved `grenzen.sh` has LAB-specific restrictions (including an Amsterdam quiet window), and `lead.conf` targets the original monorepo. These are legacy policy, not a generic permission system or configurable Relay merge workflow. The launcher does not run merge, push, release, sudo, passkey-export or MOD-access workflows. Personal skills are not enabled by installing Relay.
