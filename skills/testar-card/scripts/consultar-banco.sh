#!/usr/bin/env bash
# Consulta SOMENTE LEITURA num banco Firebird de teste. Uso:
#   FB_DB=host:/caminho/Base.fdb FB_PASS=... bash consultar-banco.sh "SELECT ..."
# Recusa qualquer coisa que não comece com SELECT. Exit 3 = recusado.
# Variáveis: FB_DB (host:caminho.fdb, obrigatória), FB_USER (padrão sysdba), FB_PASS (obrigatória), ISQL (caminho do isql).
# Funciona no Windows (Git Bash + Firebird 3) e no Linux (pacote firebird3.0-utils: isql-fb).
set -uo pipefail
SQL="${1:-}"
[ -z "$SQL" ] && { echo "uso: consultar-banco.sh \"SELECT ...\"" >&2; exit 1; }
case "$(printf '%s' "$SQL" | tr -d ' \t\r\n' | tr '[:lower:]' '[:upper:]' | cut -c1-6)" in
  SELECT) ;;
  *) echo "RECUSADO: só SELECT. O agente não altera banco; quem altera é a tela." >&2; exit 3;;
esac
[ -z "${FB_DB:-}" ] && { echo "ERRO: FB_DB não definido (host:caminho.fdb)" >&2; exit 4; }
[ -z "${FB_PASS:-}" ] && { echo "ERRO: FB_PASS não definido" >&2; exit 4; }

if [ -z "${ISQL:-}" ]; then
  if command -v isql-fb >/dev/null 2>&1; then ISQL=isql-fb
  elif [ -x "/opt/firebird/bin/isql" ]; then ISQL=/opt/firebird/bin/isql
  elif [ -f "/c/Program Files/Firebird/Firebird_3_0/isql.exe" ]; then ISQL="/c/Program Files/Firebird/Firebird_3_0/isql.exe"
  elif command -v isql >/dev/null 2>&1; then ISQL=isql
  else echo "ERRO: isql do Firebird não encontrado. Defina ISQL=/caminho/isql" >&2; exit 4; fi
fi
FB_USER="${FB_USER:-sysdba}"

TMP=$(mktemp)
printf 'SET HEADING ON;\nSET LIST OFF;\n%s\n;\n' "${SQL%;}" > "$TMP"
"$ISQL" -user "$FB_USER" -password "$FB_PASS" -charset UTF8 -pagelength 100000 -i "$TMP" "$FB_DB" 2>&1
rc=$?
rm -f "$TMP"
exit $rc
