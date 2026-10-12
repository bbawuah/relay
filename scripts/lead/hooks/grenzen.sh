#!/bin/bash
# Grenzen voor elke Claude-sessie en subagent op de mini (PreToolUse, werkwijze B, 6 okt 2026).
# Weigert met exit 2 (de melding gaat naar Claude) wat in AGENTS.md als "niets" stond:
#   - sleutels lezen (klaarover, douane, agentwerkbank, .env-bestanden)
#   - uitrolscripts draaien (uitrol gaat via Brian)
#   - zware runs (poort, e2e, bekijk) in het stiltevenster 05:00–07:15
#   - een rauwe `gh pr merge` (alleen via scripts/lead/merge.sh), zodra LAB_GRENS_MERGE=1 of
#     ~/.claude/hooks/grenzen.merge bestaat (aan na de merge van scripts/lead/merge.sh)
# Faalt open: bij een fout in dit script zelf exit 0, zodat het werk niet stilvalt.
invoer="$(cat)" || exit 0
/usr/bin/python3 - "$invoer" <<'PY'
import json, os, re, sys, datetime
try:
    d = json.loads(sys.argv[1])
except Exception:
    sys.exit(0)
tool = d.get("tool_name", "")
ti = d.get("tool_input") or {}

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
        if len(t) < 2 or "$(" in t or "`" in t:
            return False
        if t[0] == "'":
            return t.count("'") == 2 and t[-1] == "'"
        if t[0] == '"':
            k = 1
            while k < len(t):
                if t[k] == "\\":
                    k += 2
                    continue
                if t[k] == '"':
                    return k == len(t) - 1
                k += 1
        return False
    def leegmaken(cmd):
        try:
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
    cz = leegmaken(c)
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
    nu = datetime.datetime.now().time()
    if datetime.time(5, 0) <= nu < datetime.time(7, 15):
        if re.search(r"bun run (poort|bekijk|test:tmux|test:e2e)|playwright", c):
            weiger("stiltevenster 05:00–07:15: geen poort, e2e of bekijk. Plan het na 07:15.")
    merge_aan = os.environ.get("LAB_GRENS_MERGE") == "1" or os.path.exists(os.path.expanduser("~/.claude/hooks/grenzen.merge"))
    if merge_aan and re.search(r"\bgh\s+pr\s+merge\b", c):
        weiger("mergen gaat alleen via scripts/lead/merge.sh <pr> (controleert review, poort en state).")
sys.exit(0)
PY
status=$?
# Alleen een bewuste weigering (2) doorgeven; elke andere fout = open.
[ "$status" -eq 2 ] && exit 2
exit 0
