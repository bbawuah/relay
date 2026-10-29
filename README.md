# Relay

Relay 0.2.0 provides durable local mailboxes between explicitly registered peers. CLI and the `peers` MCP server share one SQLite message store. Reading never acknowledges a message; acknowledgement is an explicit operation.

Bun **>= 1.4.2** is the only runtime prerequisite on macOS or Linux. Relay uses Bun's built-in SQLite and has no third-party runtime dependencies. The package remains private; no registry publication is part of this release.

## Install from a public HTTPS clone

```sh
git clone https://github.com/bbawuah/relay.git
cd relay
./install.sh --prefix "$HOME/.local"
export PATH="$HOME/.local/bin:$PATH"
relay --version
relay doctor
```

Select a checkout containing the 0.2.0 implementation. Installation needs no development dependency installation. It copies an explicit manifest of message-runtime paths and writes a CLI launcher; the checkout may then be moved or deleted. For another prefix, replace both paths above. `./install.sh --prefix /absolute/prefix --dry-run` validates the package and reports the destination without writing it.

Installation never edits shell profiles, provider settings, permissions, hooks or existing message state. Unmanaged targets and paths into the source checkout are refused. Updating a managed installation replaces its runtime copy. `relay uninstall` removes the verified installation from which it runs and preserves state and vendor/project safeguards. Use `--prefix /absolute/prefix` to select a managed installation explicitly when provenance cannot be verified.

## Two manual mailboxes

```sh
one=$(relay register --name one)
two=$(relay register --name two)
relay --peer "$one" send "$two" 'hello from one' --request-key hello-1 --json
relay --peer "$one" send "$two" 'hello from one' --request-key hello-1 --json
relay --peer "$two" inbox --json
relay --peer "$two" inbox --json
```

The retry returns the same message ID with `duplicate: true`. Keys are scoped to the sending peer and namespace, retained for 30 days by default; a changed payload with the same live key is a conflict. A different key permits identical text. `inbox` remains non-destructive. Copy the returned message ID and acknowledge it:

```sh
relay --peer "$two" ack MESSAGE_ID
relay --peer "$two" inbox --json
```

A stored receipt means durable storage, not host notification or task completion. An offline registered mailbox can receive mail. `unregister` marks a peer offline without deleting its inbox. Aliases are case-insensitively unique in a namespace. Reconnecting to another host session uses explicit `rebind` with the expected endpoint generation.

Global options precede the command: `relay --state /absolute/private/state --namespace demo --peer PEER_ID inbox --json`. Default state is `~/.local/state/relay/v2`, default namespace `local`. A legacy state root is refused; see [configuration](docs/configuration.md) and the [migration guide](docs/message-migration.md).

## Explicit MCP binding

Register a mailbox, then configure the host to invoke exactly one fixed peer per connection:

```sh
relay --state /absolute/private/state --namespace demo --peer STABLE_PEER_ID mcp
```

Use the absolute installed `relay` executable as the MCP command, server name **`peers`**, and the arguments shown above. The tools are `send`, `inbox`, `list`, `ack`. MCP requires an explicit stable peer ID on its command line. Tool arguments cannot override the sender, inbox, namespace or peer. Two threads sharing a checkout need separate registered peers and separate MCP bindings. cwd and shared provider environment do not identify a mailbox. Legacy send aliases `naar`, `tekst`, `draad`, `antwoord_op` remain wrapper compatibility fields.

## Notifications and T3

T3 currently uses **polling**. No safe external T3 notification route has been proven; the injected agent MCP tools are not a background transport. Relay does not reuse their credentials. Register a T3 mailbox with an explicit `--host t3 --session-id THREAD_ID`, bind its MCP connection explicitly, and poll `inbox`. See the [adapter feasibility report](docs/t3-message-poc.md).

`relay serve` starts the bounded notification dispatcher (`--once` for one pass). Mailbox send/read/ack work without it; unattended notification retries pause while it is stopped. `doctor` and `status --json` expose requirements and stored notification diagnoses. No vendor hook installer or agent launcher is supplied.

## Breaking changes and verification

0.2.0 retires agent launch (`claude`, `codex`), `setup`, policy/role options, `hold`, `release`, `notify-when-idle`, orchestration, Git/merge helpers, tmux management and personal skills. Existing project/harness policy stays outside Relay and is never uninstalled. The [migration guide](docs/message-migration.md) is maintained by the migration stream; do not point old and new writers at one state directory or assume an importer is available before that guide is delivered.

For development, `bun install --frozen-lockfile --ignore-scripts` then `bun run poort` runs current message tests, surviving startup/install tests, typecheck and package-boundary checks. Every test uses disposable state; no live provider session is required. Test retirement is documented [per file](docs/test-retirement.md), and historical extraction provenance remains in [source-manifest.json](docs/source-manifest.json). Worker verification and remaining integration gaps are reported in [verification](docs/verification.md).
