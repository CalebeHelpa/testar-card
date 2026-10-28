#!/usr/bin/env bash
# Consulta SOMENTE LEITURA num banco Firebird de teste. Uso:
#   FB_DB=host:/caminho/Base.fdb FB_PASS=... bash consultar-banco.sh "SELECT ..."
# Recusa qualquer coisa que não comece com SELECT. Exit 3 = recusado.
# Variáveis: FB_DB (host:caminho.fdb, obrigatória), FB_USER (padrão sysdba), FB_PASS (obrigatória), ISQL (caminho do isql).
# Funciona no Windows (Git Bash + Firebird 3) e no Linux (pacote firebird3.0-utils: isql-fb).
set -uo pipefail
SQL="${1:-}"
[ -z "$SQL" ] && { echo "uso: consultar-banco.sh \"SELECT ...\"" >&2; exit 1; }
# Trava de leitura (defesa em profundidade; a garantia real é um usuário Firebird só leitura em FB_USER):
# 1) tira literais e comentários; 2) uma instrução só (nenhum ";" no meio); 3) começa com SELECT ou WITH;
# 4) nenhuma palavra de escrita/DDL/controle em lugar nenhum. SELECT em procedure selecionável ainda pode
# escrever: por isso o usuário só leitura continua sendo pré-requisito.
LIMPO=$(printf '%s' "$SQL" | tr '\n\r\t' '   ' \
  | sed -E "s/'([^']|'')*'/''/g" \
  | sed -E 's#/\*([^*]|\*+[^*/])*\*+/# #g' \
  | sed -E 's/--.*$//; s/[[:space:]]+/ /g; s/^ //; s/[ ;]+$//')
U=$(printf '%s' "$LIMPO" | tr '[:lower:]' '[:upper:]')
case "$U" in
  *";"*) echo "RECUSADO: uma instrução por vez (achei ';' no meio)." >&2; exit 3;;
esac
case "$U" in
  "SELECT "*|"WITH "*) ;;
  *) echo "RECUSADO: só SELECT. O agente não altera banco; quem altera é a tela." >&2; exit 3;;
esac
if printf ' %s ' "$U" | grep -qE '[^A-Z0-9_$](INSERT|UPDATE|DELETE|MERGE|UPSERT|EXECUTE|EXEC|ALTER|DROP|CREATE|RECREATE|GRANT|REVOKE|COMMIT|ROLLBACK|SET|INTO|TRUNCATE|DECLARE)[^A-Z0-9_$]'; then
  echo "RECUSADO: palavra de escrita/DDL na consulta." >&2; exit 3
fi
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
