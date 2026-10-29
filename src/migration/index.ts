import { join, sep } from "node:path";
import type { Envelope, MessageStore } from "../messages/contracts";
import { createMessageStore } from "../storage/index";
import { checkDestination, ensureQuarantine, openLedger, type HeldAction } from "./ledger";
import { fail, MAX_IMPORT_MESSAGES, MAX_LEGACY_BYTES, safePath, snapshot } from "./source";

export type MigrationOptions = { sourceDir: string; destinationDir: string; namespace: string; sourceQuiesced: boolean; held?: HeldAction; now?: () => number };
export type MigrationReport = {
  state: "complete"; completed: true; resumed: boolean; sourceDigest: string; peerMapping: Record<string, string>;
  peers: number; messages: number; acknowledgements: number; importedThisRun: number; acknowledgedThisRun: number;
  held: { total: number; quarantined: number; imported: number; skipped: number; action: HeldAction };
  legacyBodiesAboveSendLimit: number; orphanAcknowledgements: number;
  limits: { maxMessages: number; maxBodyBytes: number }; quiescence: "operator-asserted";
};
const same = (a: Envelope, b: Envelope) => a.version === b.version && a.id === b.id && a.namespace === b.namespace && a.from === b.from && a.to === b.to
  && a.conversationId === b.conversationId && a.replyTo === b.replyTo && a.createdAt === b.createdAt && a.body === b.body;

/** Explicit one-way cutover. The caller must stop old writers before asserting sourceQuiesced. */
export function migrateLegacy({ sourceDir, destinationDir, namespace, sourceQuiesced, held = "quarantine", now = Date.now }: MigrationOptions): MigrationReport {
  if (sourceQuiesced !== true) fail("stop old writers first, then explicitly set sourceQuiesced: true; the flag cannot prove liveness");
  if (typeof namespace !== "string" || !namespace.trim() || namespace.includes("\0") || namespace.length > 1024) fail("invalid namespace");
  if (!["quarantine", "import", "skip"].includes(held)) fail("invalid held action");
  const time = now(); if (!Number.isSafeInteger(time) || time < 0) fail("invalid migration time");
  sourceDir = safePath(sourceDir); destinationDir = safePath(destinationDir);
  const within = (path: string, parent: string) => path === parent || path.startsWith(parent.endsWith(sep) ? parent : parent + sep);
  if (within(sourceDir, destinationDir) || within(destinationDir, sourceDir)) fail("source and destination overlap");
  const data = snapshot(sourceDir, namespace);
  const afterRead = snapshot(sourceDir, namespace);
  if (data.digest !== afterRead.digest || data.signature !== afterRead.signature) fail("source changed during validated snapshot; stop old writers");
  const resumed = checkDestination(destinationDir);
  const ledger = openLedger(destinationDir, sourceDir, namespace, data, time, resumed);
  let store: MessageStore | undefined;
  let importedThisRun = 0; let acknowledgedThisRun = 0;
  try {
    if (held !== "quarantine" && ledger.header.heldAction !== "quarantine" && held !== ledger.header.heldAction) fail("held decision is already recorded and cannot be reversed");
    ensureQuarantine(destinationDir, data, namespace, ledger);
    store = createMessageStore({ path: join(destinationDir, "messages.sqlite"), now: () => time });
    // Preflight every target conflict before registering or enqueuing anything in this run.
    for (const entry of data.entries) {
      const existing = store.getMessage(namespace, entry.message.id);
      if (existing && !same(existing, entry.message)) fail("conflicting target message ID");
      const reference = store.getMessageReference(namespace, entry.message.id);
      if (reference && (reference.from !== entry.message.from || reference.to !== entry.message.to || reference.conversationId !== entry.message.conversationId || reference.createdAt !== entry.message.createdAt)) fail("conflicting target message reference");
      if ((existing || reference) && ledger.stage(entry.message.id) === "waiting") fail("target message ID exists outside this import");
    }
    for (const [name, id] of Object.entries(data.mapping)) {
      const byName = store.findPeer(namespace, name); const byId = store.getPeer(namespace, id);
      if ((byName && byName.id !== id) || (byId && (byId.name !== name || byId.endpoint.host !== "manual" || byId.endpoint.sessionId !== id || byId.endpoint.generation !== 1 || Object.keys(byId.endpoint.target).length))) fail("conflicting target peer binding");
    }
    if (held !== "quarantine" && held !== ledger.header.heldAction) {
      ledger.header.heldAction = held; ledger.header.complete = false; ledger.save();
    }
    for (const [name, id] of Object.entries(data.mapping)) store.register({ id, namespace, name, endpoint: { host: "manual", sessionId: id, generation: 1, target: {} }, presence: "offline", registeredAt: ledger.header.createdAt, lastSeenAt: ledger.header.createdAt });
    const action = ledger.header.heldAction;
    for (const entry of data.entries) {
      const id = entry.message.id;
      if (entry.held && action !== "import") {
        if (action === "skip") ledger.stageAs(id, "skipped");
        continue;
      }
      let stage = ledger.stage(id);
      if (stage === "done") continue;
      if (stage === "skipped") fail("skipped held data cannot be delivered");
      if (stage === "waiting") { ledger.stageAs(id, "pending"); stage = "pending"; }
      if (stage === "pending") {
        const existing = store.getMessage(namespace, id);
        if (!existing) {
          const receipt = store.enqueue({ message: entry.message, requestKey: `legacy:${data.digest}:${id}`, fingerprint: entry.fingerprint, maxPending: MAX_IMPORT_MESSAGES, maxBodyBytes: MAX_LEGACY_BYTES });
          if (receipt.id !== id) fail("import receipt has a conflicting message ID");
          if (!receipt.duplicate) importedThisRun++;
        }
        // This durable stage precedes ack: pruning can never erase our evidence of storage.
        ledger.stageAs(id, "stored");
      }
      if (entry.acked) acknowledgedThisRun += store.ack(namespace, entry.message.to, [id], time);
      ledger.stageAs(id, "done");
    }
    const final = snapshot(sourceDir, namespace);
    if (data.digest !== final.digest || data.signature !== final.signature) fail("source changed during import; target is partial, stop writers before resume");
    ledger.header.complete = true; ledger.save();
    const heldCount = data.entries.filter(entry => entry.held).length;
    const imported = data.entries.filter(entry => !entry.held || action === "import");
    return { state: "complete", completed: true, resumed, sourceDigest: data.digest, peerMapping: data.mapping, peers: Object.keys(data.mapping).length,
      messages: imported.length, acknowledgements: imported.filter(entry => entry.acked).length, importedThisRun, acknowledgedThisRun,
      held: { total: heldCount, quarantined: action === "quarantine" ? heldCount : 0, imported: action === "import" ? heldCount : 0, skipped: action === "skip" ? heldCount : 0, action },
      legacyBodiesAboveSendLimit: data.wide, orphanAcknowledgements: data.orphanAcks, limits: { maxMessages: MAX_IMPORT_MESSAGES, maxBodyBytes: MAX_LEGACY_BYTES }, quiescence: "operator-asserted" };
  } finally { store?.close(); ledger.close(); }
}
