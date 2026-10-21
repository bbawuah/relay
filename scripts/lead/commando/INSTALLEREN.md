# Commando-runner installeren (alleen Brian)

De commando-knop in Terminal B voert een verzoek pas uit als jij het met Face ID goedkeurt. Dat uitvoeren doet de runner (`runner.ts`, PLAN §2.5): een LaunchAgent die als jou draait, maar uit een **root-eigen bundel**, met een **root-eigen kopie van je publieke passkey-sleutels**. Zo kan een agent de runner en de sleutels niet vervangen. Zonder jouw handtekening over precies dat verzoek draait er niets.

Alle stappen draai je zelf in een gewone terminal (niet via een agent). Er zijn drie sudo-stappen. Agents installeren niets en laden geen LaunchAgent.

## 0. Vooraf

- De PR's van de kern (`lead/commando-kern`) en de runner (`lead/commando-runner`) zijn gemerged. Voor de kaart in Terminal B ook die van de server (`tmux/commando-kaart`), en tmux is uitgerold.
- Je werkt vanuit een schone checkout op `origin/main`: `git status` is leeg en `git log -1` is de top van main. `installeer-grens.ts` bouwt de bundel zelf uit `origin/main` en print alleen. Uit de werkkopie installeert het niets.

## 1. De eigen clone van de runner

`tak-weg` draait `scripts/lead/push.sh` uit een eigen clone op `origin/main`, buiten `~/Desktop` (TCC). Een agent kan dat script dus niet in een worktree wijzigen.

```sh
mkdir -p "$HOME/Library/Application Support/lab-b/commando" "$HOME/Library/Logs/lab-b"
git clone git@github.com:bbawuah/LAB-BAWUAH.git "$HOME/Library/Application Support/lab-b/commando/bron"
```

De runner zet de clone voor elke `tak-weg` zelf op de top van `origin/main` (`git fetch` en `checkout --detach`). Een LaunchAgent krijgt geen invoer. Vraagt `git fetch` via ssh toch iets, gebruik dan een https-remote met `gh auth setup-git`, net als bij de tmux-uitrolwachter (`apps/tmux/deploy/README.md`). `push.sh` eist dat de fetch- en de push-URL gelijk zijn.

## 2. Runner en merge.sh (sudo)

```sh
bun scripts/lead/installeer-grens.ts
```

Dit print onder meer:

```sh
sudo install -d -o root -g wheel -m 755 '/usr/local/lib/lab-lead'
sudo install -o root -g wheel -m 755 '…/merge.sh' '/usr/local/lib/lab-lead/merge.sh'
sudo install -o root -g wheel -m 644 '…/lead.conf' '/usr/local/lib/lab-lead/lead.conf'
sudo install -o root -g wheel -m 755 '/var/folders/…/commando-runner-bouw-…/commando-runner.js' '/usr/local/lib/lab-lead/commando-runner.js'
```

Draai de `sudo`-regels zoals ze er staan. De bundel is gebouwd uit `git archive origin/main` met `bun install --frozen-lockfile --ignore-scripts` en `bun build`. Die build is deterministisch bij dezelfde bun-versie en `bun.lock`, dus `--controleer` bouwt hem later opnieuw en vergelijkt de sha256.

## 3. Je publieke passkey-sleutels (sudo)

De runner controleert de WebAuthn-handtekening zelf, tegen `/usr/local/lib/lab-lead/passkeys.pub`. Dat bestand heeft dit formaat (de runner beheert het):

```json
{ "versie": 1, "rpID": "<host van Terminal B>", "origins": ["https://<host van Terminal B>"],
  "sleutels": [{ "credentialId": "<base64url>", "publicKey": "<base64url COSE>" }] }
```

Er staan alleen publieke sleutels in, geen namen, logins of tellers. `rpID` is de hostnaam waarop je Terminal B opent (de ts.net-naam, zonder poort). `origins` is de volledige origin, met `:<poort>` als die niet 443 is.

Exporteer de sleutels uit de passkey-opslag van de tmux-app (`~/.config/tmux-pwa/passkeys.json`). Dit subcommando leest die opslag. **Alleen jij draait het, nooit een agent.**

```sh
uit="$(mktemp -d)/passkeys.pub"
bun scripts/lead/installeer-grens.ts --sleutels-export "$uit" --rpid <host> --origin https://<host>
```

Het schrijft `$uit` met modus 600 en print twee regels:

```sh
sudo install -o root -g wheel -m 644 '<uit>' '/usr/local/lib/lab-lead/passkeys.pub'
rm '<uit>'
```

Draai ze allebei. Het tijdelijke bestand mag niet blijven staan.

**Een nieuwe passkey** (ander toestel, of een passkey opnieuw aangemaakt) werkt pas voor de commando-knop na een nieuwe export en installatie van stap 3. Dat is bewust: een agent kan geen sleutel toevoegen.

## 4. De LaunchAgent (zonder sudo)

`installeer-grens.ts` print onder `#|` de LaunchAgent uit het sjabloon (`nl.lab-b.commando.plist.sjabloon`), met jouw thuismap ingevuld. Zet hem neer en laad hem:

```sh
bun scripts/lead/installeer-grens.ts | sed -n 's/^#| //p' > ~/Library/LaunchAgents/nl.lab-b.commando.plist
plutil -lint ~/Library/LaunchAgents/nl.lab-b.commando.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/nl.lab-b.commando.plist
```

De agent start `/opt/homebrew/bin/bun /usr/local/lib/lab-lead/commando-runner.js --live`. Hij heeft `WatchPaths` op `~/.local/state/lab-commando/akkoord` en krijgt alleen `PATH`, `HOME` en `LANG`. Elke start verwerkt wat er in `akkoord/` ligt en stopt daarna. De log staat in `~/Library/Logs/lab-b/commando-runner.log`.

## 5. Controleren

```sh
bun scripts/lead/installeer-grens.ts --controleer
```

Dit eist:
- `merge.sh`, `lead.conf` en `commando-runner.js`: root-eigen, de juiste modus, geen ACL, geen symlink, en dezelfde sha256 als origin/main (de bundel opnieuw gebouwd). Bij een afwijkende bundel noemt de melding de bun-versie: een andere bun geeft een andere bundel. Installeer dan opnieuw met de huidige bun.
- `passkeys.pub`: root-eigen, 644, een geldig formaat. Het aantal sleutels staat erbij, de inhoud niet.
- `~/Library/LaunchAgents/nl.lab-b.commando.plist`: gelijk aan het sjabloon uit origin/main.

Een rookproef met een onschuldige soort: laat de lead `bun scripts/lead/vraag-brian.ts tailnet-dicht --https <een ongebruikte poort> --waarom "rookproef runner"` indienen. Keur de kaart goed in Terminal B. De uitslag (vaak een exitcode die niet 0 is, omdat er niets dicht te zetten valt) komt op de kaart en in de inbox van de lead. Daarmee heb je het hele pad gezien: kaart, Face ID, akkoord, runner, handtekening, uitvoering en uitslag.

## Na een wijziging

- Een merge die `scripts/lead/commando/`, `scripts/stiltevenster.ts`, `scripts/lead/hooks/register.ts`, `bun.lock` of `@simplewebauthn/server` raakt, of een nieuwe bun-versie: herhaal stap 2 en 5. `--controleer` meldt een oude runner.
- Een gewijzigd plist-sjabloon: herhaal stap 4. Eerst `launchctl bootout gui/$(id -u)/nl.lab-b.commando`.
- Een nieuwe passkey: herhaal stap 3.

## Weghalen

```sh
launchctl bootout gui/$(id -u)/nl.lab-b.commando
rm ~/Library/LaunchAgents/nl.lab-b.commando.plist
sudo rm /usr/local/lib/lab-lead/commando-runner.js /usr/local/lib/lab-lead/passkeys.pub
```

Zonder runner blijft een goedgekeurd verzoek liggen tot het akkoord na 5 minuten verloopt. Er gebeurt dan niets.

## Open punten en wat overblijft

- **`tak-weg` werkt live nog niet.** `push.sh` pusht met de pre-push-hook van de repo, en die draait de volledige poort (`bun run check`), ook bij een push die alleen een tak verwijdert. In de clone van de runner faalt dat, of het duurt veel langer dan de timeout. Dit wacht op jouw besluit over de pre-push, bijvoorbeeld geen poort als elke gepushte ref een verwijdering is. `tailnet-open` en `tailnet-dicht` werken wel. In de tests draait `tak-weg` met een nep-bash.
- **Dezelfde gebruiker blijft het fundament** (PLAN §8.1). De LaunchAgent draait `/opt/homebrew/bin/bun` en staat in `~/Library/LaunchAgents`. Beide kan jouw gebruiker wijzigen, en een agent dus ook. Een andere runner of een andere bun kan zonder geldige handtekening nog steeds niets wat de agent niet zelf al kon (PLAN §3.11). `--controleer` meldt een gewijzigde plist.
- **Replay binnen 5 minuten** (PLAN §3.3). Wie `gebruikt/` en `uitslag/` wist en een geclaimd akkoord terugzet, kan hetzelfde verzoek nog eens laten draaien zolang het akkoord geldt. Dat vereist bewust omzeilen, en de soorten in fase 1 zijn idempotent.
