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
    # Quote-bewuste splitsing in commandosegmenten: operatoren (&& || ; & | ( ) newline, backtick, $( )
    # tellen alleen buiten quotes. Tekst binnen quotes (commitbericht, MR-body) is nooit een nieuwe
    # commandopositie (vals alarm 6 en 12 okt). Een $(...) of backtick-subcommando, ook binnen
    # dubbele quotes, wordt wel een eigen segment en dus gecontroleerd. Tekst in dubbele quotes die
    # na zo'n subcommando verdergaat, wordt overgeslagen. Faalt het (ongebalanceerde quote of
    # haakje): terug op de strenge oude splitsing.
    def segmenten_streng(cmd):
        return re.split(r"&&|\|\||[;&|()\n`]|\$\(", cmd)
    def segmenten(cmd):
        try:
            segs, huidig, negeer, stack, i, n = [], [], False, ["top"], 0, len(cmd)
            def sluit(nieuw_negeer=False):
                nonlocal huidig, negeer
                if not negeer:
                    segs.append("".join(huidig))
                huidig, negeer = [], nieuw_negeer
            while i < n:
                ch, mode = cmd[i], stack[-1]
                if ch == "\\":
                    huidig.append(cmd[i:i + 2]); i += 2; continue
                if mode == "dq":
                    if ch == '"':
                        stack.pop(); huidig.append(ch)
                    elif cmd.startswith("$(", i):
                        sluit(); stack.append("sub"); i += 1
                    elif ch == "`":
                        sluit(); stack.append("bt")
                    else:
                        huidig.append(ch)
                    i += 1; continue
                if ch == "'":
                    j = cmd.find("'", i + 1)
                    if j < 0:
                        raise ValueError("quote")
                    huidig.append(cmd[i:j + 1]); i = j + 1; continue
                if ch == '"':
                    stack.append("dq"); huidig.append(ch)
                elif cmd.startswith("$(", i):
                    sluit(); stack.append("sub"); i += 1
                elif ch == "`":
                    stack_in_dq = mode == "bt"
                    sluit()
                    if stack_in_dq:
                        stack.pop()
                        if stack[-1] == "dq":
                            negeer = True
                    else:
                        stack.append("bt")
                elif ch == ")" and mode == "sub":
                    stack.pop(); sluit(stack[-1] == "dq")
                elif ch in "&|;()\n":
                    sluit()
                    if cmd.startswith(ch, i + 1) and ch in "&|":
                        i += 1
                else:
                    huidig.append(ch)
                i += 1
            if stack != ["top"]:
                raise ValueError("onbalans")
            sluit()
            return segs
        except Exception:
            return segmenten_streng(cmd)
    # Alleen als een uitrolscript echt gestart wordt: het pad staat op de commandopositie van een
    # segment (eventueel na VAR=x, exec/sudo/env/nohup/time of sh/bash/zsh), of `bun run … uitrollen`.
    # Een pad als argument (grep, cat, sed, git diff, ls) is geen start (vals alarm 6 okt).
    def start_uitrol(cmd):
        for seg in segmenten(cmd):
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
    if start_uitrol(c):
        weiger("uitrollen gaat via Brian (`! <commando>`) of straks via het akkoord in Terminal B.")
    # Brede kill op naam of patroon stopt andermans mocks, diensten en sessies (twee keer gezien,
    # 9 okt 2026: gw-sleutelflow `pkill -f dev-mock`, gw-teksten `pkill -f "x"`). Alleen eigen PID.
    for seg in segmenten(c):
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
