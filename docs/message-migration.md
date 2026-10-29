# One-way import of legacy Relay mailboxes

The v2 message store is a separate database at `destinationDir/messages.sqlite`.
The CLI's default v2 state directory is `~/.local/state/relay/v2`; importing is an
explicit operator action. The migration module exports
`migrateLegacy({sourceDir,destinationDir,namespace,sourceQuiesced,held?,now?})`
from `src/migration/index.ts`. CLI wiring belongs to the integration stream.

## Cutover

1. Stop **all old writers**: old bus processes, hooks and any consumers that ack
   or prune the legacy files. Keep them stopped. Run one importer at a time.
2. Retain the original state directory and choose a separate, new or empty,
   private destination directory. Use absolute paths with no symlink components.
3. Call the importer with an explicit namespace and `sourceQuiesced: true`.
   The flag is the operator's assertion; it does **not** prove writers stopped.
4. Inspect the returned report. An exception is a failed or partial migration,
   never successful completion. Resume with the same source, destination and
   namespace after fixing an operational failure. Preserve all destination files.
5. Start v2 clients only after successful completion. Bind clients to the reported
   stable peer IDs. Historical vendor/T3 endpoints become offline **manual polling**
   bindings; importing never contacts those hosts.

Do not run old and new writers against one state directory. The importer opens
only the known legacy data files, never the old executable bus, register module,
hooks, provider settings or launch-reservation database. No credentials or live
host access are needed.

For example, from a source checkout, after stopping old writers:

```ts
import { migrateLegacy } from "./src/migration/index.ts";

const report = migrateLegacy({
  sourceDir: "/absolute/path/to/old-state",
  destinationDir: "/absolute/path/to/new-state",
  namespace: "local",
  sourceQuiesced: true,
  // held defaults to "quarantine"
});
console.log(JSON.stringify(report, null, 2));
```

## Validated source data

The source root contains `register/*.json`, `peers/inbox/<name>.jsonl`,
`peers/inbox/<name>.gelezen` (newline-separated acknowledged message IDs), and
`peers/vastgehouden/<name>.jsonl`. Missing optional directories are allowed;
at least one recognized data directory must exist. Other state trees are not
imported. Unexpected entries inside these input directories fail explicitly.

Register records supply named aliases. Envelope sender/recipient aliases and
empty mailboxes also retain an address, even if their old session is gone.
Unnamed register records have no peer address. Roles, admission settings, taint
and historical endpoint targets do not control the new mailbox.

All envelopes are validated before any destination write. Invalid JSON/UTF-8,
invalid identifiers, invalid envelope metadata, duplicate message IDs, wrong
mailboxes and ambiguous case-folded aliases fail the import. Mailbox filenames
must use the legacy lowercase spelling. Symlinks, hardlinks, foreign-owned and
nonregular input files, unsafe path components and overlapping source/destination
trees are rejected. Destination files must additionally be private.

The importer reads the source twice before writing, comparing both a content
digest and file identity/size/change timestamps. It checks again before marking
completion. These checks detect observed changes; they cannot establish liveness
or exclude a writer that acts after the checks. Source bytes are never modified,
renamed, acknowledged, chmodded or deleted. Reads may update filesystem access
times. A source change during import leaves partial destination state and an
explicit failure; restore the original snapshot before attempting its resume.

Original message, conversation and reply IDs, text and acknowledged/unread state
are retained. Historical ack IDs whose envelopes were already pruned are counted
as `orphanAcknowledgements`; no missing body is invented. A foreign mailbox ack
for a known envelope is an error. Original ack timestamps are unavailable in the
old format, so v2 uses the import time.

Aliases map deterministically to `legacy-` plus SHA-256 of the namespace and
case-folded alias. The mapping is persisted and returned. Separate namespaces get
separate stable addresses. Register sessions never silently become live host
bindings.

The old send limit was 16,000 JavaScript string code units, rather than v2's
16,000 UTF-8 bytes. Valid legacy text is preserved up to 16,000 code units and
64,000 UTF-8 bytes, without truncation. `legacyBodiesAboveSendLimit` reports
messages above the ordinary byte limit. Migration allows at most 100,000 messages
and a 100,000-message unread mailbox quota, with a 128 MiB source-input budget
and at most 100,000 input files. These bounds do not change ordinary send limits.

## Held messages

The default `held: "quarantine"` writes held envelopes and their ack flags to the
separately labelled `legacy-quarantine.json`. They are absent from active inboxes.
This is historical data storage, not a new admission policy.

With the unchanged original source available, rerun with `held: "import"` to
deliver those exact held envelopes once. Their original IDs and ack state remain
intact. `held: "skip"` instead records a durable decision to leave them out.
Import and skip decisions cannot be reversed by a later run. A later default run
retains the already recorded decision. The quarantine artifact remains available
for audit, including after import or skip.

## Resume and retention

A nonempty destination is accepted only with the recognized private
`migration.sqlite` ledger, its exact schema, and a matching source path, digest,
namespace and peer mapping. Unknown/corrupt markers, unknown target files and
conflicting message IDs fail explicitly and are not replaced. Preserve the
ledger, quarantine and message database together. SQLite sidecars belong with
their databases during crash recovery.

The ledger uses SQLite FULL synchronization independently of message-store
retention. Each envelope gets a stable import request key and a durable pending
entry before enqueue. After the message transaction commits, the ledger records
storage **before** applying the legacy ack, then records completion. A restart
after enqueue checks the exact existing body; a restart after ack uses durable
storage evidence even if the body was subsequently pruned. Completed entries are
never enqueued again, including after the store's default 30-day request receipt
and reply-reference horizons expire. Do not remove the migration ledger to force
a retry, or start normal clients during a partial import.

The JSON-safe report contains cumulative imported peer/message/ack counts,
per-run enqueue/ack counts, held disposition counts, source digest, peer mapping,
quotas and explicit completion/resume state. Cumulative counts describe the
import plan, including messages subsequently pruned; they are not current inbox
counts. Any partial failure throws and retains evidence for a resume.

## Rollback and evidence

Before new v2 writes, rollback can return to the untouched old source after
stopping v2 clients. Once new messages or acks exist in v2, returning to the old
source loses that new history. Preserve/export the v2 database and reconcile it
explicitly; this importer has no reverse or dual-write mode.

Focused tests use disposable local files and real SQLite stores, including
SIGKILL immediately after message/ack commits and retries after retention. They
exercise import semantics and local crash recovery; they provide no evidence of
live host delivery or of an operator having stopped old writers.
