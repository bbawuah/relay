// Niet door biome gelint (biome.json sluit dit bestand uit): een workflow-script is een functie-body
// met top-level return en global args en parset daarom niet als module.
// Optioneel workflowsjabloon, uitsluitend voor expliciet gedelegeerde taken.
// Args: { taken: [{ id, tak, opdracht, model?, reviewModel? }], model?, reviewModel? }.
// Zonder modelkeuze geldt de bestaande hostselectie; geen rol- of toestemmingsbeleid.
export const meta = {
  name: 'vaste-cyclus',
  description: 'Werkwijze B: per taak een bouwagent (worktree, PR) → reviewer die niet plant → zo nodig één herstelronde; de lead doet poort en merge',
  phases: [
    { title: 'Bouwen', detail: 'bouwagent per taak in een eigen worktree, opent een PR' },
    { title: 'Review', detail: 'reviewer die niet plant toetst de diff aan AGENTS.md en de taak' },
    { title: 'Herstel', detail: 'één herstelronde bij blokkerende punten, daarna herreview' },
  ],
}

const WERKAFSPRAKEN = `Volg de gebruikersopdracht en de projectinstructies. Gebruik een eigen werkruimte voor onafhankelijke wijzigingen. Isoleer testdata en GIT_*-variabelen in tests. Geef resultaat, passende validatie en resterende punten terug.`

const BOUW = {
  type: 'object',
  properties: {
    tak: { type: 'string' }, pr: { type: 'number' }, sha: { type: 'string' },
    samenvatting: { type: 'string' }, tests: { type: 'string' }, openPunten: { type: 'string' },
  },
  required: ['tak', 'pr', 'sha', 'samenvatting', 'tests'],
}
const REVIEW = {
  type: 'object',
  properties: {
    blokkerend: { type: 'array', items: { type: 'string' } },
    nietBlokkerend: { type: 'array', items: { type: 'string' } },
    oordeel: { type: 'string', enum: ['akkoord', 'wijzigingen'] },
  },
  required: ['blokkerend', 'nietBlokkerend', 'oordeel'],
}

const reviewPrompt = (taak, b) => `Review PR #${b.pr} (\`gh pr diff ${b.pr}\`) op correctheid, scope en testkwaliteit aan de hand van de oorspronkelijke taak:\n${taak.opdracht}\nLees de projectinstructies. Geef concrete bevindingen met bestand/regel. Dit is een leesopdracht.`

const resultaten = await pipeline(
  args.taken,
  (taak) => agent(`${taak.opdracht}\n\nTak: \`${taak.tak}\`. ${WERKAFSPRAKEN}\nGeef terug: tak, PR-nummer, kop-SHA, korte samenvatting, testuitslag, open punten.`,
    { label: `bouw:${taak.id}`, phase: 'Bouwen', model: taak.model || args.model, isolation: 'worktree', schema: BOUW }),
  (b, taak) => b && agent(reviewPrompt(taak, b), { label: `review:${taak.id}`, phase: 'Review', model: taak.reviewModel || args.reviewModel || taak.model || args.model, isolation: 'worktree', schema: REVIEW })
    .then((r) => ({ taak, b, r })),
  async (x) => {
    if (!x || !x.r || x.r.blokkerend.length === 0) return x
    log(`${x.taak.id}: ${x.r.blokkerend.length} blokkerend punt(en), herstelronde`)
    const b2 = await agent(`Herstel PR #${x.b.pr} (tak \`${x.b.tak}\`): check de tak uit in een eigen worktree, verwerk deze blokkerende reviewpunten en push op dezelfde tak:\n- ${x.r.blokkerend.join('\n- ')}\n\nOorspronkelijke taak:\n${x.taak.opdracht}\n${WERKAFSPRAKEN}`,
      { label: `herstel:${x.taak.id}`, phase: 'Herstel', model: x.taak.model || args.model, isolation: 'worktree', schema: BOUW })
    const r2 = b2 && await agent(reviewPrompt(x.taak, b2), { label: `herreview:${x.taak.id}`, phase: 'Herstel', model: x.taak.reviewModel || args.reviewModel || x.taak.model || args.model, isolation: 'worktree', schema: REVIEW })
    return { taak: x.taak, b: b2 || x.b, r: r2 || x.r, hersteld: true }
  },
)

return resultaten.filter(Boolean).map((x) => ({
  taak: x.taak.id, pr: x.b.pr, tak: x.b.tak, sha: x.b.sha, tests: x.b.tests,
  oordeel: x.r.oordeel, blokkerend: x.r.blokkerend, nietBlokkerend: x.r.nietBlokkerend,
  hersteld: !!x.hersteld, openPunten: x.b.openPunten || '',
}))
