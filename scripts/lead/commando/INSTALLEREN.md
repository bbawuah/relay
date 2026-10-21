# Commando-runner installeren (alleen Brian)

De commando-knop in Terminal B voert een verzoek pas uit als jij het met Face ID goedkeurt. Dat uitvoeren doet de runner (`runner.ts`, PLAN §2.5): een LaunchAgent die als jou draait, maar uit een **root-eigen bundel**, met een **root-eigen kopie van je publieke passkey-sleutels**. Zo kan een agent de runner en de sleutels niet vervangen. Zonder jouw handtekening over precies dat verzoek draait er niets.

In fase 1 draait de runner live alleen `tailnet-open` en `tailnet-dicht`: `/Applications/Tailscale.app/Contents/MacOS/Tailscale` met een vast absoluut pad en cwd `/`. Hij draait niets uit een clone of een andere map die jouw gebruiker (en dus een agent) kan wijzigen. `tak-weg` weigert hij live (zie "Open punten").

Alle stappen draai je zelf in een gewone terminal (niet via een agent). Er zijn drie sudo-stappen. Agents installeren niets en laden geen LaunchAgent.

## 0. Vooraf

- De PR's van de kern (`lead/commando-kern`) en de runner (`lead/commando-runner`) zijn gemerged. Voor de kaart in Terminal B ook die van de server (`tmux/commando-kaart`), en tmux is uitgerold.
- Je werkt vanuit een schone checkout op `origin/main`: `git status` is leeg en `git log -1` is de top van main. `installeer-grens.ts` bouwt de bundel zelf uit `origin/main` en print alleen. Uit de werkkopie installeert het niets.
- `/usr/local/lib` bestaat op een verse Mac soms nog niet. Dat is geen probleem: de eerste sudo-regel (`install -d`) maakt `/usr/local/lib/lab-lead` en de mappen erboven aan, als root en met modus 755. De runner eist dat het bestand met sleutels en elke map erboven root-eigen is en niet schrijfbaar voor groep of anderen. Controleer dat na de installatie met `ls -ld /usr/local /usr/local/lib /usr/local/lib/lab-lead`. Staat er een map van jou tussen (bijvoorbeeld door Homebrew), zet die dan op root met `sudo chown root:wheel <map>`. Anders weigert de runner te starten, en meldt `--controleer` welke map het is.
- Maak de logmap: `mkdir -p "$HOME/Library/Logs/lab-b"`.

## 1. Runner en merge.sh (sudo)

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

## 2. Je publieke passkey-sleutels (sudo)

De runner controleert de WebAuthn-handtekening zelf, tegen `/usr/local/lib/lab-lead/passkeys.pub`. Dat bestand heeft dit formaat (de runner beheert het):

```json
{ "versie": 1, "rpID": "<host van Terminal B>", "origins": ["https://<host van Terminal B>"],
  "sleutels": [{ "credentialId": "<base64url>", "publicKey": "<base64url COSE>", "apparaat": "<naam> <JJJJ-MM-DD>" }] }
```

Er staan alleen jouw passkeys in: de credential-id, de publieke sleutel, en bij `apparaat` de naam en aanmaakdatum uit Terminal B, zodat je ze herkent. Geen login, tellers of passkeys van andere logins. `rpID` is de hostnaam waarop je Terminal B opent (de ts.net-naam, zonder poort). `origins` is de volledige origin, met `:<poort>` als die niet 443 is.

Exporteer de sleutels uit de passkey-opslag van de tmux-app (`~/.config/tmux-pwa/passkeys.json`). Dit subcommando leest die opslag. **Alleen jij draait het, nooit een agent.**

```sh
uit="$(mktemp -d)/passkeys.pub"
bun scripts/lead/installeer-grens.ts --sleutels-export "$uit" --login <jouw login in Terminal B> --rpid <host> --origin https://<host>
```

Het schrijft `$uit` met modus 600 en print:

```sh
# 2 publieke sleutels van <login> in <uit> (modus 600). Vergelijk met de passkeys in Terminal B:
#   Y3JlZGVu  iPhone 2026-10-01
#   dHdlZWRl  MacBook 2026-10-15
# sha256 <64 tekens>  (na de installatie: shasum -a 256 /usr/local/lib/lab-lead/passkeys.pub)
# Installeer en wis:
sudo install -o root -g wheel -m 644 '<uit>' '/usr/local/lib/lab-lead/passkeys.pub'
rm '<uit>'
```

1. **Vergelijk** de namen en datums met de passkey-lijst in Terminal B (instellingen, passkeys). Staat er een sleutel bij die je niet kent, of mist er een, installeer dan niet.
2. Draai de `sudo`-regel en daarna de `rm`-regel. Het tijdelijke bestand mag niet blijven staan.
3. Draai `shasum -a 256 /usr/local/lib/lab-lead/passkeys.pub`. De sha256 moet gelijk zijn aan de geprinte.

**Een nieuwe passkey** (ander toestel, of een passkey opnieuw aangemaakt) werkt pas voor de commando-knop na een nieuwe export en installatie van stap 2. Dat is bewust: een agent kan geen sleutel toevoegen.

## 3. De LaunchAgent (zonder sudo)

`installeer-grens.ts` print onder `#|` de LaunchAgent uit het sjabloon (`nl.lab-b.commando.plist.sjabloon`), met jouw thuismap ingevuld. Zet hem neer en laad hem:

```sh
bun scripts/lead/installeer-grens.ts | sed -n 's/^#| //p' > ~/Library/LaunchAgents/nl.lab-b.commando.plist
plutil -lint ~/Library/LaunchAgents/nl.lab-b.commando.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/nl.lab-b.commando.plist
```

**HOME moet gelijk zijn aan die van de tmux-LaunchAgent.** HOME zit in de hash waarover je tekent (de env van de soort). De server rekent met zijn HOME, de runner met de zijne. Wijken ze af, dan is elk akkoord onbewezen en draait er niets. Controleer het:

```sh
grep -A1 '<key>HOME</key>' ~/Library/LaunchAgents/nl.lab-b.commando.plist
launchctl print gui/$(id -u)/nl.lab-b.tmux | grep -w HOME
```

Beide moeten hetzelfde pad tonen. Zet `nl.lab-b.tmux` (geschreven door `apps/tmux/scripts/uitrollen.sh`) geen eigen HOME, dan geldt die van jouw gebruiker (`echo $HOME`), en dat is wat het sjabloon invult.

De agent start `/opt/homebrew/bin/bun /usr/local/lib/lab-lead/commando-runner.js --live`. Hij heeft `WatchPaths` op `~/.local/state/lab-commando/akkoord` en krijgt alleen `PATH`, `HOME` en `LANG`. Elke start verwerkt wat er in `akkoord/` ligt en stopt daarna. De log staat in `~/Library/Logs/lab-b/commando-runner.log`. Daar staat ook een akkoord dat niet van jou bewezen is (zie stap 4).

## 4. Controleren

```sh
bun scripts/lead/installeer-grens.ts --controleer
```

Dit eist:
- `merge.sh`, `lead.conf` en `commando-runner.js`: root-eigen, de juiste modus, geen ACL, geen symlink, en dezelfde sha256 als origin/main (de bundel opnieuw gebouwd). Bij een afwijkende bundel noemt de melding de bun-versie: een andere bun geeft een andere bundel. Installeer dan opnieuw met de huidige bun.
- `passkeys.pub`: root-eigen, 644, een geldig formaat. Erbij staan de sha256 (gelijk aan die van de export) en per sleutel het korte id en het apparaat. Vergelijk die met de passkeys in Terminal B.
- `~/Library/LaunchAgents/nl.lab-b.commando.plist`: gelijk aan het sjabloon uit origin/main.

Een rookproef met een onschuldige soort: laat de lead `bun scripts/lead/vraag-brian.ts tailnet-dicht --https <een ongebruikte poort uit 8440–8459> --waarom "rookproef runner"` indienen. Keur de kaart goed in Terminal B. De uitslag (vaak een exitcode die niet 0 is, omdat er niets dicht te zetten valt) komt op de kaart en in de inbox van de lead. Daarmee heb je het hele pad gezien: kaart, Face ID, akkoord, runner, handtekening, uitvoering en uitslag.

Wat de runner doet met een akkoord dat niet klopt:
- **Niet bewezen van jou** (ongeldig akkoord of verzoek, een id of hash die niet klopt, een handtekening die niet klopt): hij voert niets uit en schrijft geen uitslag. Het akkoord gaat weg, het verzoek blijft open, en er komt een regel in de log en hooguit één regel in de inbox van de lead. Wie een akkoord kan neerleggen, kan zo dus geen verzoek van jou afsluiten.
- **Wel van jou, maar niet toegestaan** (verlopen, langer geldig dan 5 minuten plus 30 seconden klokmarge, stiltevenster, `maxPerDag` van de soort bereikt, of live niet toegestaan): uitslag `fout` of `verlopen` met de reden. Er draait niets.

## Na een wijziging

- Een merge die `scripts/lead/commando/`, `scripts/stiltevenster.ts`, `scripts/lead/hooks/register.ts`, `bun.lock` of `@simplewebauthn/server` raakt, of een nieuwe bun-versie: herhaal stap 1 en 4. `--controleer` meldt een oude runner.
- Een gewijzigd plist-sjabloon: herhaal stap 3. Eerst `launchctl bootout gui/$(id -u)/nl.lab-b.commando`.
- Een nieuwe passkey: herhaal stap 2.

## Weghalen

```sh
launchctl bootout gui/$(id -u)/nl.lab-b.commando
rm ~/Library/LaunchAgents/nl.lab-b.commando.plist
sudo rm /usr/local/lib/lab-lead/commando-runner.js /usr/local/lib/lab-lead/passkeys.pub
```

Zonder runner blijft een goedgekeurd verzoek liggen tot het akkoord na 5 minuten verloopt. Er gebeurt dan niets.

## Open punten en wat overblijft

- **`tak-weg` draait live niet (fase 1).** Het zou `scripts/lead/push.sh` uit een clone draaien. Die clone is van jouw gebruiker, dus een agent kan het script, de hooks of de git-config daar wijzigen voordat de runner het met jouw akkoord draait. Daarom weigert de runner live alles wat niet het vaste tailscale-pad is. Fase 1b: `tak-weg` via de GitHub-API, zonder code uit de repo. In de tests draait `tak-weg` met een nep-bash.
- **Dezelfde gebruiker blijft het fundament** (PLAN §8.1). De LaunchAgent draait `/opt/homebrew/bin/bun` en staat in `~/Library/LaunchAgents`. Beide kan jouw gebruiker wijzigen, en een agent dus ook. Een andere runner of een andere bun kan zonder geldige handtekening nog steeds niets wat de agent niet zelf al kon (PLAN §3.11). `--controleer` meldt een gewijzigde plist.
- **Replay binnen 5 minuten** (PLAN §3.3). Wie `gebruikt/` en `uitslag/` wist en een geclaimd akkoord terugzet, kan hetzelfde verzoek nog eens laten draaien zolang het akkoord geldt. Dat vereist bewust omzeilen, en de soorten in fase 1 zijn idempotent. Om dezelfde reden is `maxPerDag` (geteld uit `gebruikt/`) een rem op vergissingen, geen grens.
