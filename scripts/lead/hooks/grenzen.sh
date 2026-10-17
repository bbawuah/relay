#!/bin/bash
# Grenzen voor elke Claude-sessie en subagent op de mini (PreToolUse, werkwijze B, 6 okt 2026).
# Weigert met exit 2 (de melding gaat naar Claude) wat in AGENTS.md als "niets" stond:
#   - sleutels lezen (klaarover, douane, agentwerkbank, .env-bestanden)
#   - uitrolscripts draaien (uitrol gaat via Brian)
#   - zware runs (poort, e2e, bekijk) in het stiltevenster 05:00–07:15
#   - een rauwe `gh pr merge` (alleen via scripts/lead/merge.sh), zodra LAB_GRENS_MERGE=1 of
#     ~/.claude/hooks/grenzen.merge bestaat (aan na de merge van scripts/lead/merge.sh); herkend op de
#     woorden, ook met gh-vlaggen als -R o/r ervoor
#   - een schrijvende `gh api` (methode anders dan GET, of -f/-F/--field/--raw-field/--input zonder
#     expliciete GET), `gh api graphql` met een mutation, en `gh alias set|import`
#   - een rauwe `git push` met force, verwijderen, naar main, --no-verify of POORT_OVERSLAAN
#     (alleen via scripts/lead/push.sh), en een rauwe `ssh jump … oc` (alleen via scripts/lead/lab-lees.sh)
#   - elke aanroep van merge.sh (elk pad) vanuit een subagent of fork (`agent_id`/`agent_type` in de invoer)
# Faalt dicht (17 okt 2026): bij een eigen fout (invoer geen JSON of van de verkeerde vorm, een
# python-status anders dan 0 of 2) exit 2 met een melding: weigeren. 0 = toestaan.
# De hookinvoer gaat via stdin naar python (niet via argv: geen ARG_MAX-grens bij lange commando's).
faal() { echo "Geweigerd door grenzen.sh: eigen fout ($1); faalt dicht. Meld het de lead of Brian." >&2; exit 2; }
code=""
IFS= read -r -d '' code <<'PY' || true
import json, os, re, sys, datetime
try:
    d = json.loads(sys.stdin.read())
except Exception:
    sys.exit(3)
if not isinstance(d, dict):
    sys.exit(4)
tool = d.get("tool_name", "")
ti = d.get("tool_input") or {}
if not isinstance(ti, dict):
    sys.exit(4)

def weiger(reden):
    print(f"Geweigerd door grenzen.sh: {reden}", file=sys.stderr)
    sys.exit(2)

SLEUTEL = re.compile(r"(\.config/(klaarover|douane|agentwerkbank)\b|(^|[/\s'\"])\.env(\.[A-Za-z0-9_-]+)?($|[\s'\"]))")
LEES = re.compile(r"(^|[;&|(\s])(cat|head|tail|less|more|bat|strings|xxd|od|grep|rg|awk|sed|source|\.|base64|cp|scp|open)\s")

if tool in ("Read", "NotebookRead"):
    p = str(ti.get("file_path", ""))
    if SLEUTEL.search(p) and not p.endswith(".example"):
        weiger("dit is een sleutelbestand. Sleutels lezen mag niet; vraag het Brian.")
if tool in ("Grep", "Glob"):
    p = " ".join(str(ti.get(k, "")) for k in ("path", "pattern", "glob"))
    if re.search(r"\.config/(klaarover|douane|agentwerkbank)", p):
        weiger("zoeken in een sleutelmap mag niet.")

if tool == "Bash":
    c = str(ti.get("command", ""))
    for deel in re.split(r"&&|\|\||;|\n", c):
        if LEES.search(deel) and SLEUTEL.search(deel) and ".example" not in deel:
            weiger("dit commando leest een sleutelbestand. Sleutels lezen mag niet; vraag het Brian.")
    # Berichtargumenten leegmaken (enige versoepeling t.o.v. de strenge check hieronder): de waarde van
    # `-m`/`--message` bij git commit|tag, `--title`/`--body` bij gh pr create|edit|comment en gh issue,
    # `--title`/`--description`/`--message` bij glab mr create|update|note, wordt `''`, maar alleen als het
    # commando op de commandopositie van een segment staat en de waarde één goed afgesloten quote-token
    # is zonder `$(` of backtick. Tekst daarin is nooit een commando (vals alarm 6 en 12 okt). Bij elke
    # twijfel of parseerfout blijft het commando ongewijzigd, dus streng.
    BERICHT = [
        (("git", "commit"), ("-m", "--message")),
        (("git", "tag"), ("-m", "--message")),
        (("gh", "pr", "create"), ("--title", "--body")),
        (("gh", "pr", "edit"), ("--title", "--body")),
        (("gh", "pr", "comment"), ("--body",)),
        (("gh", "issue", "*"), ("--title", "--body")),
        (("glab", "mr", "create"), ("--title", "--description", "--message")),
        (("glab", "mr", "update"), ("--title", "--description", "--message")),
        (("glab", "mr", "note"), ("--message",)),
    ]
    def een_quote(t):
        # één quote-token zonder het andere quoteteken erin ('…' zonder " of "…" zonder ')
        if len(t) < 2 or t[0] not in "'\"" or t[-1] != t[0]:
            return False
        andere = '"' if t[0] == "'" else "'"
        return t.count(t[0]) == 2 and andere not in t
    def leegmaken(cmd):
        try:
            # Zonder deze tekens hebben bash, zsh en sh dezelfde, eenduidige quote-regels (geen expansie,
            # escape, commentaar, here-doc, ANSI-C-quote, ${..}, redirect of glob): anders streng.
            if re.search(r"[$`\\#<>{}!*?\[]", cmd):
                return cmd
            toks, seg, i, n = [], 0, 0, len(cmd)
            while i < n:
                ch = cmd[i]
                if ch in " \t":
                    i += 1
                elif ch in "\n;&|()`":
                    seg += 1; i += 1
                elif cmd.startswith("$(", i):
                    seg += 1; i += 2
                else:
                    start = i
                    while i < n:
                        ch = cmd[i]
                        if ch == "\\":
                            i += 2
                        elif ch == "'":
                            j = cmd.find("'", i + 1)
                            if j < 0:
                                raise ValueError("quote")
                            i = j + 1
                        elif ch == '"':
                            i += 1
                            while True:
                                if i >= n:
                                    raise ValueError("quote")
                                if cmd[i] == "\\":
                                    i += 2
                                elif cmd[i] == '"':
                                    i += 1
                                    break
                                else:
                                    i += 1
                        elif ch in " \t\n;&|()`" or cmd.startswith("$(", i):
                            break
                        else:
                            i += 1
                    toks.append((seg, start, i))
            uit = []
            for s_id in sorted({t[0] for t in toks}):
                tk = [t for t in toks if t[0] == s_id]
                tx = [cmd[a:b] for _, a, b in tk]
                k0 = 0
                while k0 < len(tx) and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", tx[k0]):
                    k0 += 1
                for naam, vlaggen in BERICHT:
                    m = len(naam)
                    if len(tx) >= k0 + m and all(a == "*" or a == b for a, b in zip(naam, tx[k0:k0 + m])):
                        for q in range(k0 + m, len(tx) - 1):
                            if tx[q] in vlaggen and een_quote(tx[q + 1]):
                                uit.append((tk[q + 1][1], tk[q + 1][2]))
                        break
            for a, b in sorted(uit, reverse=True):
                cmd = cmd[:a] + "''" + cmd[b:]
            return cmd
        except Exception:
            return cmd
    # Here-doc-berichten leegmaken: `gh pr create|edit|comment --body "$(cat <<'EOF' … EOF\n)"` en
    # `git commit -m "$(cat <<EOF … EOF\n)"` worden `--body ''`, maar alleen als alles ervóór op de
    # regel eenduidig is (gewone woorden en eenvoudige quotes), de tekst geen regel met de eindmarkering
    # bevat, en bij een ongequote marker geen `$`, backtick of `\`. Anders blijft het commando streng.
    WOORD = r"(?:[A-Za-z0-9_./:=@,+%-]+|'[^'\n]*'|\"[^\"$`\\\n]*\")"
    # Een kop `cd <map> && ` ervoor en `git -C <map> commit` mogen ook.
    KOP = re.compile(r"[ \t]*(?:cd[ \t]+" + WOORD + r"[ \t]*&&[ \t]*)?(?:gh[ \t]+pr[ \t]+(?:create|edit|comment)|git(?:[ \t]+-C[ \t]+" + WOORD + r")?[ \t]+commit)(?:[ \t]+" + WOORD + r")*[ \t]+")
    HD = re.compile(r"(--body|--title|-m|--message)(?:[ \t]+|=)\"\$\(cat[ \t]+<<(-?)[ \t]*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\3[ \t]*\n(.*?)\n(\t*)\4\n[ \t]*\)\"(?=[ \t\n;&|]|$)", re.S)
    def heredoc_leeg(cmd):
        try:
            for _ in range(10):
                m = HD.search(cmd)
                if not m:
                    break
                vlag, streep, q, eind, tekst, tabs = m.groups()
                if not KOP.fullmatch(cmd[:m.start()]):
                    return cmd
                if tabs and not streep:
                    return cmd
                if re.search(r"(^|\n)" + ("\t*" if streep else "") + re.escape(eind) + r"(\n|$)", tekst):
                    return cmd
                if not q and re.search(r"[$`\\]", tekst):
                    return cmd
                cmd = cmd[:m.start()] + vlag + " ''" + cmd[m.end():]
            return cmd
        except Exception:
            return cmd
    cz = leegmaken(heredoc_leeg(c))
    # Alleen als een uitrolscript echt gestart wordt: het pad staat op de commandopositie van een
    # segment (eventueel na VAR=x, exec/sudo/env/nohup/time of sh/bash/zsh), of `bun run … uitrollen`.
    # Een pad als argument (grep, cat, sed, git diff, ls) is geen start (vals alarm 6 okt).
    def start_uitrol(cmd):
        for seg in re.split(r"&&|\|\||[;&|()\n`]|\$\(", cmd):
            w = seg.split()
            while w and (re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", w[0]) or w[0] in ("exec", "sudo", "env", "nohup", "time", "command")):
                w = w[1:]
            if not w or w[0] in ("-", "#", "echo", "printf"):
                continue
            if re.fullmatch(r"(/\S*/)?(ba|z)?sh", w[0]):
                w = [x for x in w[1:] if not x.startswith("-")]
                if not w:
                    continue
            if re.search(r"uitrollen(\.sh)?$", w[0].strip("'\"")):
                return True
            if w[0] == "bun" and "run" in w and any(x.strip("'\"") == "uitrollen" for x in w):
                return True
        return False
    if start_uitrol(cz):
        weiger("uitrollen gaat via Brian (`! <commando>`) of straks via het akkoord in Terminal B.")
    # Brede kill op naam of patroon stopt andermans mocks, diensten en sessies (twee keer gezien,
    # 9 okt 2026: gw-sleutelflow `pkill -f dev-mock`, gw-teksten `pkill -f "x"`). Alleen eigen PID.
    for seg in re.split(r"&&|\|\||[;&|()\n`]|\$\(", cz):
        w = seg.split()
        while w and (re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", w[0]) or w[0] in ("exec", "sudo", "env", "nohup", "time", "command", "xargs")):
            w = w[1:]
        if w and re.fullmatch(r"(/\S*/)?(pkill|killall)", w[0]):
            weiger("pkill/killall stopt ook processen van anderen. Stop alleen je eigen proces: `kill <pid>` (pid uit je eigen start, of `lsof -ti tcp:<eigen poort>`).")
    # Rauwe `git push` met force, verwijderen of naar main, rauwe git-config voor aliassen en hooks,
    # schrijvende `gh api`, merge.sh vanuit een subagent en een rauwe `ssh jump … oc`: alleen via de smalle
    # scripts (17 okt 2026). Streng: segmenten en woorden worden gesplitst zonder op quotes te letten en
    # quotes vallen van de woorden af, dus `bash -c '…'`, `ssh host '…'` en `nice …` tellen ook. Alleen
    # een segment dat met echo/printf/grep/rg begint, telt niet (tekst, geen start).
    PUSH_SH = "scripts/lead/push.sh"
    LAB_SH = "scripts/lead/lab-lees.sh"
    BUITEN = " Buiten lab-bawuah: met het volledige pad ~/Desktop/LAB-BAWUAH/lab-bawuah/scripts/lead/."
    TEKST = ("echo", "printf", "grep", "rg", "egrep", "fgrep")
    LEZEN = TEKST + ("cat", "head", "tail", "less", "more", "bat", "wc", "diff", "ls", "stat", "file", "shellcheck", "git")
    GIT_OPT_WAARDE = ("-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env")
    PUSH_OPT_WAARDE = ("-o", "--push-option", "--repo", "--receive-pack", "--exec")
    SSH_OPT_WAARDE = set("BbcDEeFIiJLlmOoPpQRSWw")
    # Lange push-opties die git ook afgekort aanneemt (--forc, --del, --no-veri): een `--`-woord van
    # minstens 2 letters dat een prefix is van een van deze, telt als die optie.
    VERBODEN_LANG = {
        "--force": "force", "--force-with-lease": "force", "--force-if-includes": "force", "--mirror": "force",
        "--delete": "weg", "--prune": "weg", "--all": "main", "--branches": "main", "--no-verify": "poort",
    }
    MELDING = {
        "force": f"force-push mag niet. Push je eigen tak met {PUSH_SH}.{BUITEN}",
        "weg": f"een remote tak verwijderen gaat alleen via {PUSH_SH} --verwijder <tak> (alleen als hij in origin/main zit).{BUITEN}",
        "main": f"naar main gaat alles via een PR. Push je eigen tak met {PUSH_SH}.{BUITEN}",
        "poort": "--no-verify slaat de poort over; dat mag alleen Brian.",
    }
    MAIN = re.compile(r"(\S*:)?(refs/heads/)?(main|master)", re.I)
    def woorden(seg):
        return [x.strip("'\"") for x in seg.split()]
    def eerste(w):
        while w and (re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", w[0]) or w[0] in ("exec", "sudo", "env", "nohup", "time", "command", "xargs", "nice")):
            w = w[1:]
        return w[0] if w else ""
    def git_aanroepen(w):
        # per `git` in het segment: (globale opties als paren, subcommando, argumenten)
        uit = []
        for i, x in enumerate(w):
            if not re.fullmatch(r"(\S*/)?git", x):
                continue
            j, glob = i + 1, []
            while j < len(w) and w[j].startswith("-"):
                if w[j] in GIT_OPT_WAARDE:
                    glob.append((w[j], w[j + 1] if j + 1 < len(w) else ""))
                    j += 2
                else:
                    glob.append((w[j], ""))
                    j += 1
            if j < len(w):
                uit.append((glob, w[j], w[j + 1:]))
        return uit
    def push_bezwaar(a):
        # geeft (melding of None, lijst positionele argumenten: remote en refspecs)
        k, pos = 0, []
        while k < len(a):
            x = a[k]
            if x in PUSH_OPT_WAARDE:
                k += 2
                continue
            if x.startswith("--"):
                naam = x.split("=", 1)[0]
                if len(naam) >= 4:
                    for v, soort in VERBODEN_LANG.items():
                        if v.startswith(naam):
                            return MELDING[soort], pos
            elif x.startswith("-") and len(x) > 1:
                if "f" in x[1:]:
                    return MELDING["force"], pos
                if "d" in x[1:]:
                    return MELDING["weg"], pos
            elif x.startswith("+") and len(x) > 1:
                return MELDING["force"], pos
            elif re.fullmatch(r":\S+", x):
                return MELDING["weg"], pos
            else:
                if pos and MAIN.fullmatch(x):
                    return MELDING["main"], pos
                pos.append(x)
            k += 1
        return None, pos
    def huidige_tak(map_):
        try:
            import subprocess
            env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
            r = subprocess.run(["git", "-C", map_, "symbolic-ref", "--short", "-q", "HEAD"], capture_output=True, text=True, timeout=3, env=env)
            return r.stdout.strip() if r.returncode == 0 else ""
        except Exception:
            return ""
    def ssh_naar_jump(w):
        for i, x in enumerate(w):
            if not re.fullmatch(r"(\S*/)?ssh", x):
                continue
            j = i + 1
            via_jump = False
            while j < len(w) and w[j].startswith("-"):
                o = w[j]
                if o == "--":
                    j += 1
                    break
                if len(o) == 2 and o[1] in SSH_OPT_WAARDE:
                    if j + 1 < len(w) and re.search(r"(^|[@,=])jump($|[,:])", w[j + 1]):
                        via_jump = True
                    j += 2
                else:
                    j += 1
            if via_jump or (j < len(w) and re.fullmatch(r"([^@\s]+@)?jump", w[j])):
                return True
        return False
    # gh-opties met een waarde: overslaan bij het zoeken naar het subcommando en het endpoint.
    GH_OPT_WAARDE = ("-R", "--repo", "--hostname", "-X", "--method", "-f", "-F", "--field", "--raw-field",
                     "--input", "-H", "--header", "-q", "--jq", "-t", "--template", "--cache", "-p", "--preview")
    def gh_posities(a):
        uit, k = [], 0
        while k < len(a):
            y = a[k]
            if y in GH_OPT_WAARDE:
                k += 2
                continue
            if not y.startswith("-"):
                uit.append((k, y))
            k += 1
        return uit
    def gh_bezwaar(w):
        for i, x in enumerate(w):
            if not re.fullmatch(r"(\S*/)?gh", x):
                continue
            a = w[i + 1:]
            pos = gh_posities(a)
            namen = [y for _, y in pos]
            if namen[:2] == ["pr", "merge"] and merge_aan:
                return "mergen gaat alleen via scripts/lead/merge.sh <pr> (controleert review, poort en state)."
            if namen[:1] == ["alias"] and namen[1:2] in (["set"], ["import"]):
                return "gh alias set|import mag niet: een alias kan een merge of push verstoppen. Vraag het Brian."
            if namen[:1] != ["api"]:
                continue
            a = a[pos[0][0] + 1:]
            methode, velden = None, False
            for k, y in enumerate(a):
                if y in ("-X", "--method"):
                    methode = a[k + 1] if k + 1 < len(a) else ""
                elif y.startswith("--method="):
                    methode = y.split("=", 1)[1]
                elif y.startswith("-X") and len(y) > 2:
                    methode = y[2:]
                if re.fullmatch(r"-[fF].*|--(raw-)?field(=.*)?|--input(=.*)?", y):
                    velden = True
            eind = [y for _, y in gh_posities(a)][:1]
            if eind == ["graphql"]:
                # graphql gaat altijd via POST; lezen mag, een mutation (of een query uit een bestand) niet
                if re.search(r"(?i)mutation", " ".join(a)) or any(y.startswith("--input") or "=@" in y for y in a):
                    return "gh api graphql met een mutation (of een query uit een bestand) schrijft naar GitHub; dat mag niet rauw."
                continue
            # zonder expliciete methode maken -f/-F/--field/--raw-field/--input er een POST van
            schrijven = (methode.upper() != "GET") if methode is not None else velden
            if schrijven:
                return f"gh api met methode {methode or 'POST (door -f/-F/--input)'} schrijft naar GitHub; alleen lezen (GET) mag rauw. Mergen via scripts/lead/merge.sh."
        return None
    merge_aan = os.environ.get("LAB_GRENS_MERGE") == "1" or os.path.exists(os.path.expanduser("~/.claude/hooks/grenzen.merge"))
    is_subagent = bool(d.get("agent_id") or d.get("agent_type"))
    basis = str(d.get("cwd") or os.getcwd())
    hier = basis
    jump = False
    for seg in re.split(r"&&|\|\||[;&|()\n`]|\$\(", cz):
        w = woorden(seg)
        e = eerste(w)
        if e == "cd":
            rest = [x for x in w[w.index("cd") + 1:] if not x.startswith("-")]
            hier = os.path.join(hier, os.path.expanduser(rest[0])) if rest else os.path.expanduser("~")
            continue
        if e in TEKST:
            continue
        # merge.sh (elk pad) nooit vanuit een subagent of fork: de rol van de lead erft anders mee via env.
        if is_subagent and e not in LEZEN and any(re.search(r"(^|/)merge\.sh$", x) for x in w):
            weiger("een subagent of fork merget niet: alleen de lead zelf draait scripts/lead/merge.sh.")
        for glob, sub, args in git_aanroepen(w):
            for o, v in glob:
                if o == "-c" and re.search(r"(?i)(^alias\.|hookspath)", v):
                    weiger("git -c met alias.* of core.hooksPath mag niet rauw (zo gaat een push langs de poort).")
                if o.startswith("--config-env") and (sub == "push" or re.search(r"(?i)(alias\.|hookspath)", o + v)):
                    weiger("git --config-env bij een push mag niet rauw.")
            if sub == "config" and any(re.match(r"(?i)(alias\.|core\.hookspath$)", x) for x in args):
                weiger("een git-alias of core.hooksPath zetten mag niet rauw (zo gaat een push langs de grenzen). Vraag het Brian.")
            if sub != "push":
                continue
            if "POORT_OVERSLAAN" in cz:
                weiger("POORT_OVERSLAAN bij een push mag alleen Brian. Draai bun run check en push zonder.")
            if "GIT_CONFIG" in cz:
                weiger("GIT_CONFIG* bij een push mag niet rauw (zo gaat een push langs de poort).")
            b, pos = push_bezwaar(args)
            if b:
                weiger(b)
            # zonder expliciete doeltak (of met HEAD) gaat de push naar de huidige tak: niet als dat main is
            if len(pos) <= 1 or any(re.fullmatch(r"(?i)\+?HEAD", x) for x in pos[1:]):
                map_ = hier
                for o, v in glob:
                    if o == "-C" and v:
                        map_ = os.path.join(map_, os.path.expanduser(v))
                if MAIN.fullmatch(huidige_tak(map_) or "-"):
                    weiger(MELDING["main"])
        b = gh_bezwaar(w)
        if b:
            weiger(b)
        if ssh_naar_jump(w):
            jump = True
    if jump and re.search(r"(^|[\s'\"/;&|(`])oc($|[\s'\";&|)])", cz):
        weiger(f"het lab lees je alleen via {LAB_SH} <get|describe|logs|events|top|auth can-i> … (alleen-lezen, geen secrets).{BUITEN}")
    nu = datetime.datetime.now().time()
    if datetime.time(5, 0) <= nu < datetime.time(7, 15):
        if re.search(r"bun run (poort|bekijk|test:tmux|test:e2e)|playwright", c):
            weiger("stiltevenster 05:00–07:15: geen poort, e2e of bekijk. Plan het na 07:15.")
    if merge_aan and re.search(r"\bgh\s+pr\s+merge\b", cz):
        weiger("mergen gaat alleen via scripts/lead/merge.sh <pr> (controleert review, poort en state).")
sys.exit(0)
PY
# De invoer van de hook (stdin) gaat rechtstreeks naar python; de code staat in argv.
/usr/bin/python3 -c "$code"
status=$?
# 0 = toestaan, 2 = bewuste weigering; elke andere status is een eigen fout: dicht (ook weigeren).
case $status in
  0) exit 0 ;;
  2) exit 2 ;;
  3) faal "invoer is geen geldige JSON" ;;
  4) faal "invoer heeft de verkeerde vorm" ;;
  *) faal "python-status $status" ;;
esac
