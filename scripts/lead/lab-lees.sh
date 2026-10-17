#!/bin/bash -p
# Alleen-lezen op het lab via `ssh jump`. Gebruik:
#   scripts/lead/lab-lees.sh <get|describe|logs|events|top> [args] [--droog]
#   scripts/lead/lab-lees.sh auth can-i <werkwoord> <resource> [args] [--droog]
# Weigert (exit 1, met reden) elk ander subcommando, secrets, schrijf- en shell-acties, en elk
# argument met een teken buiten [A-Za-z0-9._:/=,@-]. Uitvoer gaat door het eag_-masker.
# Zie scripts/lead/README.md.
# Vangnet tegen vergissingen, geen grens (geen allow-regel tot er een read-only lab-account is).
set -euo pipefail
unset BASH_ENV ENV

fout() { echo "lab-lees: geweigerd: $*" >&2; exit 1; }
# Als root-kopie in /usr/local/lib/lab-lead: vaste PATH.
if [ "$(cd "$(dirname "$0")" && pwd -P)" = /usr/local/lib/lab-lead ]; then
  PATH=/usr/bin:/bin:/opt/homebrew/bin
  export PATH
fi

droog=0 args=()
for a in "$@"; do
  case $a in
    --droog) droog=1 ;;
    -h|--help) sed -n '2,7p' "$0"; exit 0 ;;
    *) args+=("$a") ;;
  esac
done
[ "${#args[@]}" -gt 0 ] || fout "geef een subcommando: get, describe, logs, events, top of auth can-i"

sub=${args[0]}
case $sub in
  get|describe|logs|events|top) ;;
  auth) [ "${#args[@]}" -ge 2 ] && [ "${args[1]}" = can-i ] || fout "van 'auth' mag alleen 'auth can-i'" ;;
  *) fout "subcommando '$sub' is geen alleen-lezen; toegestaan: get, describe, logs, events, top, auth can-i" ;;
esac

VERBODEN_WOORD=" exec rsh port-forward cp debug edit apply delete patch scale rollout attach run create replace label annotate set expose proxy "
for a in "${args[@]}"; do
  # Allowlist van tekens: de argumenten gaan als losse woorden naar de shell aan de jump-kant,
  # dus geen spatie, quote, ; | & $ ` \ * ? [ ] { } ~ ! < > of regeleinde.
  [[ $a =~ ^[A-Za-z0-9._:/=,@-]+$ ]] || fout "argument '$a' bevat een teken buiten [A-Za-z0-9._:/=,@-]"
  [[ $a != -* || $a =~ ^--?[A-Za-z] ]] || fout "argument '$a' is geen geldige optie"
  laag=$(printf '%s' "$a" | tr '[:upper:]' '[:lower:]')
  [[ $laag != *secret* ]] || fout "secrets lezen mag niet ('$a')"
  [[ $VERBODEN_WOORD != *" $laag "* ]] || fout "'$a' is een schrijf- of shellactie"
  case $laag in
    --raw|--raw=*) fout "--raw omzeilt de resourcecontrole" ;;
    --token|--token=*|--kubeconfig|--kubeconfig=*|--as|--as=*|--as-group|--as-group=*|--as-uid|--as-uid=*|--client-key*|--client-certificate*|--server|--server=*|-s|--context|--context=*|--cluster|--cluster=*|--user|--user=*|--insecure-skip-tls-verify*|--certificate-authority*)
      fout "optie '$a' verandert identiteit of doel; het lab-account van de jump geldt" ;;
    -f|--filename|--filename=*|-k|--kustomize|--kustomize=*)
      # bij logs is -f "volgen"; elders leest -f een bestand aan de jump-kant
      [ "$sub" = logs ] && [ "$laag" = -f ] || fout "optie '$a' leest bestanden aan de jump-kant" ;;
    --template*) fout "optie '$a' (templates lezen velden die -o niet toont)" ;;
    --cache-dir*|--log*|--v|--v=*|--vmodule*|-v) fout "optie '$a' schrijft logs of cache aan de jump-kant" ;;
  esac
  [[ $laag != *-file* ]] || fout "'$a' noemt een bestand (-file)"
  # Korte opties alleen los (-n x); samengestelde vormen (-Ao, -lapp=x) niet, behalve -o<vorm>/-o=<vorm>.
  [[ $a != -[!-]?* || $a == -o* ]] || fout "korte optie '$a': schrijf korte opties los, zoals -n <namespace>"
done

# -o/--output: alleen wide, name, yaml of json. yaml/json alleen bij get, en alleen op resources zonder
# sleutelinhoud (geen configmap, route, oauthclient, bc of dc).
UITVOER_VORM=""
YAML_MAG=" pod pods po deployment deployments deploy deployment.apps deployments.apps service services svc endpoints ep "
WAARDE_OPT=" -n --namespace -l --selector -o --output --field-selector -c --container --since --since-time --tail --sort-by -L --label-columns --chunk-size --request-timeout "
BOOL_OPT=" -A --all-namespaces --show-labels --no-headers --watch -w --ignore-not-found --show-kind --previous -p --follow --timestamps --all-containers "
posities=() i=1 onzeker=0
while [ "$i" -lt "${#args[@]}" ]; do
  a=${args[$i]} vorm=""
  case $a in
    -o|--output) vorm=${args[$((i + 1))]:-} ;;
    -o=*|--output=*) vorm=${a#*=} ;;
    -o*) vorm=${a#-o} ;;
  esac
  if [[ $a == -o* || $a == --output* ]]; then
    case $vorm in wide|name|yaml|json) ;; *) fout "-o '$vorm' mag niet; alleen wide, name, yaml of json" ;; esac
    UITVOER_VORM=$vorm
  fi
  if [[ $a == -* ]]; then
    if [[ $a != *=* && $WAARDE_OPT == *" $a "* ]]; then
      i=$((i + 1)) # het volgende woord is de waarde
    elif [[ $a == --* && $a != *=* && $BOOL_OPT != *" $a "* ]]; then
      onzeker=1 # onbekende lange optie: neemt hij een waarde of niet?
    fi
  else
    posities+=("$a")
  fi
  i=$((i + 1))
done
if [ "$UITVOER_VORM" = yaml ] || [ "$UITVOER_VORM" = json ]; then
  [ "$sub" = get ] || fout "-o $UITVOER_VORM alleen bij get"
  [ "$onzeker" = 0 ] || fout "bij -o $UITVOER_VORM: schrijf een onbekende lange optie als --optie=waarde (anders is de resource niet zeker)"
  [ "${#posities[@]}" -gt 0 ] || fout "-o $UITVOER_VORM zonder resource"
  if [[ ${posities[0]} == */* ]]; then soorten=("${posities[@]%%/*}"); else IFS=, read -r -a soorten <<<"${posities[0]}"; fi
  for s in "${soorten[@]}"; do
    s=$(printf '%s' "$s" | tr '[:upper:]' '[:lower:]')
    [[ $YAML_MAG == *" $s "* ]] || fout "-o $UITVOER_VORM op '$s' mag niet; alleen pods, deployments, services en endpoints"
  done
fi

masker() { sed -E "s/eag_[A-Za-z0-9]+/eag_<…>/g"; }

if [ "$droog" = 1 ]; then
  printf 'droog: zou draaien: ssh -T jump oc'
  printf ' %s' "${args[@]}"
  printf '\n'
  exit 0
fi

# Vaste argv; stdout en stderr elk door het masker (fd 3 = de echte stdout).
status=0
{ ssh -T jump oc "${args[@]}" 2>&1 1>&3 3>&- | masker 1>&2 3>&-; } 3>&1 | masker || status=$?
exit "$status"
