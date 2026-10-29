# Relay

Local peer messaging between Claude Code, Codex and T3 Code sessions. Relay combines a durable inbox, a stdio MCP server, session hooks and wake-up adapters. Messages stay on the machine; no hosted service, database or API key is needed by Relay itself.

## Install

Requires macOS or Linux and [Bun](https://bun.sh) 1.4.2 or newer. Install and authenticate Claude Code or Codex separately if you want to launch them. Codex hook setup also requires Python 3 and a Codex version supporting the `hooks/list` app-server API (the extracted integration was developed against 0.164.0).

```sh
git clone git@github.com:bbawuah/relay.git
cd relay
./install.sh --dry-run
./install.sh
~/.local/bin/relay doctor
```

The installer copies a complete runtime into `~/.local/lib/relay` and writes `~/.local/bin/relay`. Add `~/.local/bin` to PATH if needed. It does not change your shell profile, vendor settings, running sessions or existing monorepo installation. The checkout can be removed afterwards. Use `./install.sh --prefix /somewhere` for another location. No `bun install` is needed for normal use; runtime code has no third-party dependencies.

## Start sessions

In one terminal:

```sh
relay claude --name lead
```

In another:

```sh
relay claude --name worker --lead lead
```

Relay passes session hooks and the `peers` MCP server directly to Claude. Global Claude setup is unnecessary. Normal vendor trust and permission prompts still apply.

For Codex, configure and trust its hooks once in the Codex home you intend to use:

```sh
relay setup codex --dry-run
relay setup codex
relay codex --name coder --lead lead --cwd /path/to/its/worktree
```

Codex uses an identity per checkout because its daemon does not preserve each TUI's environment. Give simultaneous Codex sessions separate checkouts/worktrees. Relay does not select a sandbox, grant elevated roles or bypass hook trust. `--model MODEL` selects a model; arguments after `--` pass directly to the vendor CLI. Existing monorepo lead-proef/spawn policy is retained under `scripts/lead/`, separately from this launcher.

Each agent gets these MCP tools under server name `peers`: `send`, `inbox`, `list`, and `notify_when_idle`. A wake-up contains only an unread count. Message contents arrive when the agent calls `inbox`, surrounded by origin labels and message delimiters.

## CLI and other hosts

```sh
relay list --json
relay --name worker send lead "Finished the change"
relay --name lead inbox
relay --name lead notify-when-idle worker
relay hold lead
relay release lead
```

For a shell-only smoke test, register two manual peers. These use polling, without waking a model:

```sh
reader_id=$(relay register --name reader)
writer_id=$(relay register --name writer --lead reader)
relay --name writer send reader "Hello from Relay"
relay --name reader inbox
relay unregister "$writer_id"
relay unregister "$reader_id"
```

`relay --name NAME mcp` exposes the same bus over MCP stdio. See [configuration and host integration](docs/configuration.md) for T3, direct MCP configuration, state isolation and legacy environment variables.

## Delivery and trust

Lead/worker relationships accept messages in both directions by default. Unrelated sessions hold messages for operator review. `hold`, `refuse` and per-sender policies remain supported. Text limits, rate limits, duplicate suppression, queue bounds and hop limits are preserved. Messages are not user authorization; a message from a lead cannot grant permissions.

State defaults to `~/.local/state/relay`, with private directory/file permissions. Set `RELAY_STATE_DIR` to select another bus. Relay stores message bodies in inbox files but does not collect transcripts or prompts. This is a same-user coordination tool, not an isolation boundary against processes with access to those files. Wake-up failures leave messages available for polling.

## Update and remove

Pull a newer checkout, then run `./install.sh` again. The installer replaces only a marked Relay installation and refuses unrelated files. Re-run `relay setup codex` after changes to copied hooks so Codex can verify trust again.

Before uninstalling, remove any persistent hooks you configured:

```sh
relay setup codex --remove
# Only if you explicitly configured global Claude hooks:
relay setup claude --remove
relay uninstall --dry-run
relay uninstall
```

Uninstall preserves message state, vendor settings backups and copied hook files. In a shared legacy installation, removal uses the existing `lab-lead-hooks` marker; review `--dry-run` first.

## Development

```sh
bun install --frozen-lockfile
bun test tests/relay.test.ts tests/codex-state.test.ts
bun run typecheck
bun run poort
```

The complete gate includes the extracted policy, CLI, MCP, hook, installer and wake-up tests. Install `tmux`, `git`, `jq` and Python 3 for this suite. End-to-end tests use disposable state, fake model CLIs and their own tmux sockets. A real-Codex integration is opt-in with `RELAY_E2E_CODEX=1`; it is never required for installing Relay.

See [the extraction inventory](docs/extraction.md), [peerbus protocol and limits](scripts/lead/peers/README.md), and [product tests kept outside the suite](TESTS-UITGESLOTEN.md). The old LAB command runner, release/merge tooling and personal skills are preserved as source context, not installed as global policy. `relay.toml` is a legacy design example; the peerbus currently uses CLI options and environment variables.
