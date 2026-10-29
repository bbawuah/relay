import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nieuwRecord, schrijfRecord } from "../hooks/register";
import { maakBus, RETENTIE_MS } from "./bus";
import { draai } from "./cli";
import { oudePost } from "./testhulp";

let dir: string;
let staat: string;
let klok: number;
const rollen = ["", "lead", "lead-proef", "agent", "sublead", "vervolg", "reviewer", "eigen-label"];
const bus = () => maakBus({ staat, nu: () => klok, wacht: async (ms) => void (klok += ms) });
function registreer(naam: string, rol = "agent") {
  schrijfRecord(staat, nieuwRecord(`sessie-${naam}`, { LAB_AGENT_NAAM: naam, LAB_AGENT_ROL: rol, LAB_LEAD_NAAM: `andere-lead-${naam}` }, join(dir, naam), klok));
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-policy-retired-"));
  staat = join(dir, "staat");
  klok = Date.now();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("één geregistreerde peer bereikt 17 niet-gerelateerde peers: lezen, ack en antwoord voor alle roletiketten", async () => {
  registreer("afzender", "lead-proef");
  const b = bus();
  for (let i = 0; i < 17; i++) {
    const naam = `peer-${i}`;
    registreer(naam, rollen[i % rollen.length]);
    expect(await b.send("afzender", naam, `vraag ${i}`)).toMatchObject({ ok: true, status: "afgeleverd" });
    const [vraag] = b.inbox(naam);
    expect(vraag!.van).toBe("afzender");
    b.ack(naam, [vraag!.id]);
    expect(b.inbox(naam)).toEqual([]);
    expect(await b.send(naam, "afzender", `antwoord ${i}`, { antwoord_op: vraag!.id })).toMatchObject({ ok: true, status: "afgeleverd" });
    expect(b.vastgehouden(naam)).toEqual([]);
  }
  expect(b.inbox("afzender")).toHaveLength(17);
  expect(b.inbox("afzender").every((e) => e.hop === 2)).toBe(true);
  b.ack("afzender", b.inbox("afzender").map((e) => e.id));
  expect(b.inbox("afzender")).toEqual([]);
});

test("een vreemde ack en ongeldige of dubbelzinnige identiteit krijgen geen mailboxrechten", async () => {
  registreer("a"); registreer("b"); registreer("c");
  const b = bus();
  const u = await b.send("a", "b", "alleen b");
  if (!u.ok) throw new Error("fixture send faalde");
  b.ack("c", [u.id]);
  expect(b.inbox("b").map((e) => e.id)).toEqual([u.id]);
  for (const naam of ["../b", ".", "a/b", "", "onbekend"]) {
    expect(await b.send(naam, "b", "x")).toMatchObject({ ok: false, reden: "geen_afzender" });
  }
  registreer("A");
  expect(await b.send("a", "b", "dubbelzinnig")).toMatchObject({ ok: false, reden: "geen_afzender" });
});

test("CLI laat ieder roletiket eigen oude post inspecteren en per id herstellen, zonder inhoud in de hersteluitslag", async () => {
  for (const [i, rol] of rollen.entries()) {
    const naam = `peer-${i}`;
    registreer(naam, rol);
    const e = oudePost(staat, naam, `private-inhoud-${i}`);
    const env = { LAB_AGENT_NAAM: naam, LAB_AGENT_ROL: rol, LAB_LEAD_STAAT: staat };
    const b = bus();
    expect((await draai(["vasthouden", naam], env, b)).uit).toContain(e.id);
    expect((await draai(["vrijgeven", naam], env, b)).code).toBe(1);
    expect((await draai(["vrijgeven", "ander", e.id], env, b)).code).toBe(1);
    const r = await draai(["vrijgeven", naam, e.id], env, b);
    expect(r.uit).toContain(`1 bericht vrijgegeven aan ${naam}`);
    expect(r.uit).not.toContain(e.tekst);
    expect((await draai(["vrijgeven", naam, e.id], env, b)).uit).toContain("0 berichten");
    expect(b.inbox(naam).map((e) => e.id)).toEqual([e.id]);
  }
});

test("herstel na onderbreking levert een al gepubliceerde en geackte envelop nooit opnieuw af, ook na retentie", async () => {
  registreer("a"); registreer("b");
  const b = bus();
  const e = oudePost(staat, "b", "al gepubliceerd", { ts: new Date(klok).toISOString() });
  mkdirSync(join(staat, "peers/inbox"), { recursive: true });
  writeFileSync(join(staat, "peers/inbox/b.jsonl"), `${JSON.stringify(e)}\n`);
  b.ack("b", [e.id]);
  klok += RETENTIE_MS + 1;
  await b.send("a", "b", "volgende schrijfactie");
  expect(await b.vrijgeven("b", [e.id])).toBe(0);
  expect(await b.vrijgeven("b", [e.id])).toBe(0);
  expect(b.vastgehouden("b")).toEqual([]);
  expect(b.inbox("b").map((x) => x.tekst)).toEqual(["volgende schrijfactie"]);
  expect(readFileSync(join(staat, "peers/inbox/b.jsonl"), "utf8").split(e.id).length - 1).toBe(1);
});

test("herstel is beperkt tot gekozen ontvanger en ids; vreemde of kapotte historische regels blijven behouden", async () => {
  registreer("a"); registreer("b");
  const e = oudePost(staat, "b", "gekozen");
  const ander = oudePost(staat, "b", "later");
  const bestand = join(staat, "peers/vastgehouden/b.jsonl");
  const vreemd = `${JSON.stringify({ ...e, id: "vreemd", naar: "a" })}\n`;
  const kapot = "{onleesbaar\n";
  appendFileSync(bestand, vreemd + kapot);
  expect(await bus().vrijgeven("b", [])).toBe(0);
  expect(await bus().vrijgeven("b", [e.id, "vreemd"])).toBe(1);
  expect(bus().inbox("b").map((x) => x.id)).toEqual([e.id]);
  const rest = readFileSync(bestand, "utf8");
  expect(rest).toContain(ander.id);
  expect(rest.endsWith(vreemd + kapot)).toBe(true);
  expect(bus().inbox("a")).toEqual([]);
});

test("twee herstelprocessen publiceren dezelfde historische envelop samen precies één keer", async () => {
  registreer("b");
  const e = oudePost(staat, "b", "parallelle fixture");
  const code = `const {maakBus}=await import(${JSON.stringify(join(import.meta.dir, "bus.ts"))}); console.log(await maakBus({staat:process.env.LAB_LEAD_STAAT}).vrijgeven("b",[${JSON.stringify(e.id)}]));`;
  const kinderen = [0, 1].map(() => Bun.spawn([process.execPath, "-e", code], {
    env: { PATH: process.env.PATH, LAB_LEAD_STAAT: staat }, stdout: "pipe", stderr: "pipe",
  }));
  const uitslagen = await Promise.all(kinderen.map(async (p) => {
    const uit = await new Response(p.stdout).text();
    expect(await p.exited).toBe(0);
    return Number(uit.trim());
  }));
  expect(uitslagen.sort()).toEqual([0, 1]);
  expect(bus().inbox("b").map((x) => x.id)).toEqual([e.id]);
  expect(bus().vastgehouden("b")).toEqual([]);
});

test("een id-conflict verliest geen heldpost en een ongeldige regel met hetzelfde id wordt niet opgeruimd", async () => {
  registreer("b");
  const e = oudePost(staat, "b", "versie één");
  oudePost(staat, "b", "versie twee", { id: e.id, draad: e.draad });
  const bestand = join(staat, "peers/vastgehouden/b.jsonl");
  const voor = readFileSync(bestand, "utf8");
  const r = await draai(["vrijgeven", "b", e.id], { LAB_AGENT_NAAM: "b", LAB_AGENT_ROL: "agent", LAB_LEAD_STAAT: staat }, bus());
  expect(r.code).toBe(1);
  expect(r.fout).toContain("conflicterende inhoud");
  expect(r.fout).not.toContain(e.tekst);
  expect(readFileSync(bestand, "utf8")).toBe(voor);
  expect(bus().inbox("b")).toEqual([]);

  const ongeldig = `${JSON.stringify({ id: e.id, naar: "b" })}\n`;
  writeFileSync(bestand, `${JSON.stringify(e)}\n${ongeldig}`);
  expect(await bus().vrijgeven("b", [e.id])).toBe(1);
  expect(readFileSync(bestand, "utf8")).toBe(ongeldig);
});

test("een corrupte inboxregel met een geselecteerd id verhindert dat geldige heldpost wordt weggegooid", async () => {
  registreer("b");
  const e = oudePost(staat, "b", "geldige historische post");
  mkdirSync(join(staat, "peers/inbox"), { recursive: true });
  const inboxPad = join(staat, "peers/inbox/b.jsonl");
  const corrupt = `${JSON.stringify({ id: e.id })}\n`;
  writeFileSync(inboxPad, corrupt);
  await expect(bus().vrijgeven("b", [e.id])).rejects.toThrow("conflicterende inhoud");
  expect(bus().vastgehouden("b").map((x) => x.id)).toEqual([e.id]);
  expect(readFileSync(inboxPad, "utf8")).toBe(corrupt);
});
