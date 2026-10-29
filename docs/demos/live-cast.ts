// Turns the private wrapper log of a LIVE agent run into a sanitised cast.
// Usage: bun docs/demos/live-cast.ts PRIVATE_DIR OUT.jsonl handoff|subagents
// PRIVATE_DIR holds proof/peers.json, proof/log.jsonl (every relay command the
// agents ran, with output) and proof/host.json (T3 delegation metadata:
// {alias: {provider, model, effort, startedBy}}). Only the sanitised cast is
// published; the raw log stays private.
import { readFileSync, writeFileSync } from "node:fs";

const [dir, outFile, view] = process.argv.slice(2);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const peers: Record<string, string> = JSON.parse(readFileSync(`${dir}/proof/peers.json`, "utf8"));
const host: Record<string, { provider: string; model: string; effort: string; startedBy: string }> =
  JSON.parse(readFileSync(`${dir}/proof/host.json`, "utf8"));
type Row = { ts: number; alias: string; argv: string[]; out: string; err: string; rc: number };
const rows: Row[] = readFileSync(`${dir}/proof/log.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l));

const ids = new Map<string, string>();
for (const [a, id] of Object.entries(peers)) ids.set(id, a);
let m = 0, c = 0;
const learn = (o: unknown, key = ""): void => {
  if (Array.isArray(o)) return o.forEach((x) => learn(x));
  if (o && typeof o === "object") {
    const e = o as { name?: string; endpoint?: { sessionId?: string } };
    const sid = e.endpoint?.sessionId?.match(/^manual-(.+)$/)?.[1];
    if (sid && e.name && !ids.has(sid)) ids.set(sid, e.name);
    return Object.entries(o).forEach(([k, v]) => learn(v, k));
  }
  if (typeof o === "string" && /^[0-9a-f-]{36}$/.test(o) && !ids.has(o)) {
    if (key === "conversationId") ids.set(o, `conv-${++c}`);
    else if (key === "id") ids.set(o, `msg-${++m}`);
  }
};
for (const r of rows) { try { learn(JSON.parse(r.out)); } catch { /* not JSON */ } }
let leftovers = 0;
const alias = (s: string) => s.replace(UUID, (u) => ids.get(u) ?? (leftovers++, "id-unknown"));
const drop = ["createdAt", "expiresAt", "version", "namespace"];
const strip = (v: unknown): unknown => Array.isArray(v) ? v.map(strip)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => !drop.includes(k)).map(([k, x]) => [k, strip(x)])) : v;
const clean = (t: string) => { try { return alias(JSON.stringify(strip(JSON.parse(t)))); } catch { return alias(t); } };
const quote = (a: string) => (/^[\w.:=@%+\/-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);

const pair = new Map<string, [string, string]>(); // message id -> [from, to]
const note = (o: unknown): void => {
  if (Array.isArray(o)) return o.forEach(note);
  const e = o as { id?: string; from?: string; to?: string } | null;
  if (e && typeof e === "object" && e.id && e.from && e.to) pair.set(e.id, [e.from, e.to]);
};
for (const r of rows) { try { note(JSON.parse(r.out)); } catch { /* not JSON */ } }
const parents = ["claude-parent", "codex-parent"];
const aliasOf = Object.fromEntries(Object.entries(peers).map(([a, id]) => [id, a]));
const isParentMsg = (id: string) => { const p = pair.get(id); return !!p && p.every((x) => parents.includes(aliasOf[x])); };
const involves = (r: Row) => r.argv.some((a) => /(claude|codex)-sub/.test(a));
const lastRow = rows.length - 1;
const keep = (r: Row, i: number) => r.argv[0] !== "list" && (view === "subagents" || (parents.includes(r.alias) && !involves(r) &&
  !/"from":"(claude|codex)-sub"|"to":"(claude|codex)-sub"/.test(clean(r.out)) &&
  (r.argv[0] !== "ack" || isParentMsg(r.argv[1])) &&
  (r.out.trim() !== "[]" || i === lastRow)));
const hostText = (a: string) => {
  const h = host[a];
  return `# HOST (T3 delegate_task, not Relay): ${h.startedBy} starts ${a} [${h.provider} ${h.model}${h.effort ? `, effort ${h.effort}` : ""}]`;
};

type Line = [string, string]; // [text, tone]
const trunc = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t);
const prov = (a: string) => (a.startsWith("claude") ? "claude" : "codex");
const modelShort = (a: string) => host[a].model.replace(/^claude-/, "");
const hostLines = (a: string, again: boolean): Line[] => {
  const h = host[a];
  return [["HOST · T3 delegate_task", "host"],
    [`${h.startedBy} starts ${again ? "a new session of " : ""}${a}`, "host"],
    [`${h.provider} ${h.model}${h.effort ? ` · effort ${h.effort}` : ""}`, "host"],
    ["(task API, not a Relay message)", "host"]];
};
const summary = (r: Row, out: string, polls: number): Line[] => {
  const who: Line = [`${r.alias} · ${modelShort(r.alias)}`, `alias-${prov(r.alias)}`];
  const verb = r.argv[0];
  let o: any = null; try { o = JSON.parse(out); } catch { /* error text */ }
  if (r.rc !== 0 || o === null) return [who, [`${verb} failed (rc ${r.rc})`, "warn"], [trunc(out, 50), "warn"]];
  if (verb === "send") {
    const f = (k: string) => { const i = r.argv.indexOf(k); return i > 0 ? alias(r.argv[i + 1]) : ""; };
    const ls: Line[] = [who, [`send → ${r.argv[1]}   key ${f("--request-key")}`, "text"]];
    if (f("--reply-to")) ls.push([`reply-to ${f("--reply-to")} · ${f("--conversation")}`, "dim"]);
    ls.push([`"${trunc(alias(r.argv[2]), 46)}"`, "quote"], [`stored ${o.id} · duplicate ${o.duplicate}`, "ok"]);
    return ls;
  }
  if (verb === "inbox") {
    const ls: Line[] = [who, [`inbox${polls > 1 ? ` ×${polls} polls` : ""}`, "text"]];
    if (!o.length) return [...ls, ["empty", "dim"]];
    for (const m of o) ls.push([`${m.id} from ${m.from}`, "ok"], [`"${trunc(m.body, 46)}"`, "quote"]);
    return ls;
  }
  return [who, [`ack ${alias(r.argv[1])}`, "text"], [`acknowledged: ${o.acknowledged}`, o.acknowledged ? "ok" : "warn"]];
};

const events: any[] = [{ kind: "meta", scenario: `live-${view}`, label: "replay-live-agents" }];
const md: string[] = [];
const lastTs = new Map<string, number>();
let prev = "";
let n = 0;
for (const r of rows.filter((r, i) => keep(r, i))) {
  const gap = lastTs.has(r.alias) ? r.ts - lastTs.get(r.alias)! : Infinity;
  if (host[r.alias] && gap > 20000) {
    const again = gap !== Infinity;
    const t = hostText(r.alias).slice(2);
    events.push({ kind: "host", text: again ? t.replace(" starts ", " starts a new session of ") : t, lines: hostLines(r.alias, again) });
    md.push(`> ${events[events.length - 1].text}\n`);
  }
  lastTs.set(r.alias, r.ts);
  const text = ["relay", "--peer", r.alias, ...r.argv].map((a) => quote(alias(a))).join(" ");
  const out = clean(r.out) + (r.err ? ` ${alias(r.err)}` : "");
  const key = `${text}|${out}`;
  if (out === "[]" && key === prev) {
    n++; const last = events[events.length - 1];
    last.text = text + `   # x${n + 1} (empty polls collapsed)`; last.lines = summary(r, out, n + 1);
    md[md.length - 1] = "```\n$ " + last.text + "\n" + out + "\n```\n";
    continue;
  }
  prev = key; n = 0;
  events.push({ kind: "cmd", text, out, rc: r.rc, lines: summary(r, out, 1) });
  md.push("```\n$ " + text + "\n" + out + "\n```\n");
}
writeFileSync(outFile, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
const tdir = outFile.replace(/casts\/.*$/, "transcripts");
Bun.spawnSync(["mkdir", "-p", tdir]);
writeFileSync(`${tdir}/live-${view}.md`, md.join("\n"));
console.log(`${events.length} events, ${leftovers} unmapped ids`);
