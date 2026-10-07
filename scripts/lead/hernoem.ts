// Hernoemt een lead in het register en zet haar volgers om, zonder sessies te herstarten.
//
//   bun scripts/lead/hernoem.ts --sessie <id> --naam <nieuw> [--volgers a,b] [--droog]
//
// --sessie   record-id van de lead (of een uniek begin ervan)
// --naam     nieuwe leadnaam (letters, cijfers, punt, streepje, underscore)
// --volgers  namen (of ids) van levende sessies die voortaan aan de nieuwe lead melden; hun
//            subagent-records gaan mee. Zonder --volgers wordt geen enkele volger omgezet:
//            er wordt nooit geraden welke sessies van wie zijn.
// --droog    alleen tonen.
//
// Staat: ${LAB_LEAD_STAAT:-~/.local/state/lab-lead}. Schrijft atomair (register.ts). Raakt de
// lopende sessies niet aan: de hooks lezen naam en lead bij elk event uit het record. In de lead
// zelf: `/rename <nieuw>` zodat SendMessage (to: <nieuw>) aankomt.

import { type Rec, alleRecords, dubbeleLeads, schrijfRecord, staatMap, tmuxPanes } from "./hooks/register";

export type HernoemUitslag = { code: number; uit: string[]; fout: string[] };

export function hernoem(
  staat: string,
  o: { sessie: string; naam: string; volgers: string[]; droog: boolean },
  panes: Set<string> | null = tmuxPanes(),
): HernoemUitslag {
  const stop = (m: string): HernoemUitslag => ({ code: 1, uit: [], fout: [`hernoem: ${m}`] });
  if (!o.sessie) return stop("--sessie ontbreekt");
  if (!o.naam) return stop("--naam ontbreekt");
  if (!/^[A-Za-z0-9._-]+$/.test(o.naam)) return stop(`naam '${o.naam}' mag alleen letters, cijfers, punt, streepje en underscore bevatten`);
  const records = alleRecords(staat);
  const kandidaten = records.filter((r) => r.soort === "sessie" && r.rol === "lead" && (r.id === o.sessie || r.id.startsWith(o.sessie)));
  const exact = kandidaten.filter((r) => r.id === o.sessie);
  const leads = exact.length === 1 ? exact : kandidaten;
  if (leads.length === 0) return stop(`geen lead-record met id '${o.sessie}'`);
  if (leads.length > 1) return stop(`'${o.sessie}' past op meerdere leads (${leads.map((r) => r.id.slice(0, 12)).join(", ")}); geef meer van het id`);
  const lead = leads[0] as Rec;
  const oud = lead.naam;
  const dubbel = dubbeleLeads(staat, o.naam, lead.id, panes);
  if (dubbel.length > 0) return stop(`er draait al een lead met de naam '${o.naam}' (sessie ${dubbel[0]?.id.slice(0, 8)}); kies een unieke naam`);

  const wijzigingen: Rec[] = [{ ...lead, naam: o.naam }];
  const uit = [`lead ${lead.id.slice(0, 8)}: naam ${oud || "(leeg)"} -> ${o.naam}`];
  const fout: string[] = [];
  const sessies = records.filter((r) => r.soort === "sessie" && r.rol !== "lead" && r.toestand !== "weg");
  for (const v of o.volgers) {
    const treffers = sessies.filter((r) => r.naam === v || r.id === v);
    if (treffers.length !== 1) {
      return stop(treffers.length === 0 ? `volger '${v}' is geen levende sessie (niet weg, geen lead)` : `volger '${v}' past op ${treffers.length} levende sessies; noem het id`);
    }
    const s = treffers[0] as Rec;
    wijzigingen.push({ ...s, lead: o.naam });
    uit.push(`volger ${s.naam || s.id.slice(0, 8)}: lead ${s.lead || "(leeg)"} -> ${o.naam}`);
    for (const k of records.filter((r) => r.soort === "subagent" && r.ouder === s.id)) {
      wijzigingen.push({ ...k, lead: o.naam });
      uit.push(`  subagent ${k.id.slice(0, 8)}: lead ${k.lead || "(leeg)"} -> ${o.naam}`);
    }
  }
  if (o.volgers.length === 0) uit.push("geen --volgers: geen enkele volger omgezet");
  if (o.droog) return { code: 0, uit: ["droog: niets geschreven", ...uit], fout };
  for (const r of wijzigingen) schrijfRecord(staat, r);
  return { code: 0, uit, fout };
}

function lees(argv: string[]): { sessie: string; naam: string; volgers: string[]; droog: boolean } | string {
  const o = { sessie: "", naam: "", volgers: [] as string[], droog: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const w = () => {
      const x = argv[++i];
      return x === undefined || x.startsWith("--") ? null : x;
    };
    if (a === "--droog") o.droog = true;
    else if (a === "--sessie" || a === "--naam" || a === "--volgers") {
      const x = w();
      if (x === null) return `${a} heeft een waarde nodig`;
      if (a === "--sessie") o.sessie = x;
      else if (a === "--naam") o.naam = x;
      else o.volgers = x.split(",").map((n) => n.trim()).filter(Boolean);
    } else return `onbekende optie: ${a}`;
  }
  return o;
}

if (import.meta.main) {
  process.umask(0o077);
  const o = lees(process.argv.slice(2));
  if (typeof o === "string") {
    console.error(`hernoem: ${o}\ngebruik: hernoem.ts --sessie <id> --naam <nieuw> [--volgers a,b] [--droog]`);
    process.exit(1);
  }
  const u = hernoem(staatMap(process.env), o);
  for (const r of u.uit) console.log(r);
  for (const r of u.fout) console.error(r);
  process.exit(u.code);
}
