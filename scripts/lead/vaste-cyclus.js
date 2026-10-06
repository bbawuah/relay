// Sjabloon voor de sub-lead (scripts/lead/sublead.md). Draait alleen als Brian workflows toestond
// (spawn.sh --sublead --workflow <datum>). Zonder die toestemming volgt de sub-lead hetzelfde
// stappenplan met de Agent-tool. Args: { taken: [{ id, tak, opdracht, zwaar? }] }; zwaar = true
// (diff raakt packages/*, passkey, schrijfcheck of serverroutes) geeft een opus-reviewer.
export const meta = {
  name: 'vaste-cyclus',
  description: 'Werkwijze B: per taak een bouwagent (worktree, PR) → reviewer die niet plant → zo nodig één herstelronde; de lead doet poort en merge',
  phases: [
    { title: 'Bouwen', detail: 'bouwagent per taak in een eigen worktree, opent een PR' },
    { title: 'Review', detail: 'reviewer die niet plant toetst de diff aan AGENTS.md en de taak' },
    { title: 'Herstel', detail: 'één herstelronde bij blokkerende punten, daarna herreview' },
  ],
}

const GRENZEN = `Vaste grenzen: werk alleen in je eigen worktree en tak vanaf origin/main; raak alleen de genoemde bestanden; tests die git aanroepen halen alle GIT_*-variabelen uit de omgeving; nooit de echte tmux-server, live poorten of ~/.claude/settings.json; geen sleutels lezen; niet mergen en niet uitrollen; GEEN volledige poort met e2e (alleen \`bun run check\` en unit-tests). Controleer vóór push dat \`git log origin/main..HEAD\` alleen jouw commits toont. Open een PR met de body volgens .github/pull_request_template.md (Samenvatting, Bewijs, Merge-gevaar). Nederlands. Lees schermfoto's niet zelf in: laat een sonnet-subagent ze bekijken en alleen een oordeel teruggeven.`

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

const reviewPrompt = (taak, b) => `Je bent de reviewer die niet plant. Repo ~/Desktop/LAB-BAWUAH/lab-bawuah. Toets PR #${b.pr} (\`gh pr diff ${b.pr}\`) aan AGENTS.md en aan deze taak:\n${taak.opdracht}\nAlleen lezen; niets draaien tegen echte diensten. Let op correctheid, scope (alleen de genoemde bestanden), testkwaliteit (zou de test de fout echt vangen?), GIT_*-scrub in tests, en of de PR-body het sjabloon volgt. Geef blokkerende punten met bestand/regel; laat stijlvoorkeuren weg.`

const resultaten = await pipeline(
  args.taken,
  (taak) => agent(`${taak.opdracht}\n\nTak: \`${taak.tak}\`. ${GRENZEN}\nGeef terug: tak, PR-nummer, kop-SHA, korte samenvatting, testuitslag, open punten.`,
    { label: `bouw:${taak.id}`, phase: 'Bouwen', model: 'sonnet', isolation: 'worktree', schema: BOUW }),
  (b, taak) => b && agent(reviewPrompt(taak, b), { label: `review:${taak.id}`, phase: 'Review', model: taak.zwaar ? 'opus' : 'sonnet', schema: REVIEW })
    .then((r) => ({ taak, b, r })),
  async (x) => {
    if (!x || !x.r || x.r.blokkerend.length === 0) return x
    log(`${x.taak.id}: ${x.r.blokkerend.length} blokkerend punt(en), herstelronde`)
    const b2 = await agent(`Herstel PR #${x.b.pr} (tak \`${x.b.tak}\`): check de tak uit in een eigen worktree, verwerk deze blokkerende reviewpunten en push op dezelfde tak:\n- ${x.r.blokkerend.join('\n- ')}\n\nOorspronkelijke taak:\n${x.taak.opdracht}\n${GRENZEN}`,
      { label: `herstel:${x.taak.id}`, phase: 'Herstel', model: 'sonnet', isolation: 'worktree', schema: BOUW })
    const r2 = b2 && await agent(reviewPrompt(x.taak, b2), { label: `herreview:${x.taak.id}`, phase: 'Herstel', model: x.taak.zwaar ? 'opus' : 'sonnet', schema: REVIEW })
    return { taak: x.taak, b: b2 || x.b, r: r2 || x.r, hersteld: true }
  },
)

return resultaten.filter(Boolean).map((x) => ({
  taak: x.taak.id, pr: x.b.pr, tak: x.b.tak, sha: x.b.sha, tests: x.b.tests,
  oordeel: x.r.oordeel, blokkerend: x.r.blokkerend, nietBlokkerend: x.r.nietBlokkerend,
  hersteld: !!x.hersteld, openPunten: x.b.openPunten || '',
}))
