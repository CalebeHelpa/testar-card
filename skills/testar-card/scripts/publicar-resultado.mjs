#!/usr/bin/env node
// Publica o resultado do teste no card do Azure DevOps: anexa o relatório .md,
// comenta o resumo e (opcional) move o card de estado/coluna.
// É o ÚNICO script da skill que escreve no ADO, e só escreve com QA_ESCREVE_ADO=1.
// Sem isso, imprime o que faria (dry-run) e sai com 0.
//
// Uso: node publicar-resultado.mjs <card> <relatorio.md> [anexo-extra ...]
// Lê o veredito do cabeçalho YAML do relatório (veredito: APROVADO | REPROVADO | BLOQUEADO).
//
// Variáveis:
//   QA_ESCREVE_ADO        1 = escreve de verdade. Qualquer outro valor = dry-run.
//   ADO_PAT / ADO_ORG / ADO_PROJECT   como no preparar-card.mjs
//   QA_ESTADO_APROVADO    estado para onde o card vai se APROVADO (ex.: Revisado). Vazio = não move.
//   QA_ESTADO_REPROVADO   idem para REPROVADO (ex.: Committed = coluna Fazendo). Vazio = não move.
//   QA_ESTADO_BLOQUEADO   idem para BLOQUEADO. Vazio = não move (só comenta).
//   QA_BOARD_ID           alternativa: id do board (GUID) para mover por coluna Kanban em vez de estado,
//   QA_COLUNA_APROVADO / QA_COLUNA_REPROVADO / QA_COLUNA_BLOQUEADO   nomes das colunas nesse board.
//   QA_SEM_COMENTARIO     1 = não comenta (só anexa).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const env = process.env;
const WIN = process.platform === "win32";
const [CARD, RELATORIO, ...EXTRAS] = process.argv.slice(2);
if (!CARD || !RELATORIO) die(1, "uso: publicar-resultado.mjs <card> <relatorio.md> [anexo ...]");
if (!fs.existsSync(RELATORIO)) die(1, `relatório não encontrado: ${RELATORIO}`);
const ESCREVE = env.QA_ESCREVE_ADO === "1";
const ORG = env.ADO_ORG || die(2, "defina ADO_ORG");
const PROJ = env.ADO_PROJECT || die(2, "defina ADO_PROJECT");

function die(c, m) { process.stderr.write(m + "\n"); process.exit(c); }
function log(m) { process.stderr.write(m + "\n"); }

// --- Cabeçalho do relatório ----------------------------------------------------
const texto = fs.readFileSync(RELATORIO, "utf8");
const fm = texto.match(/^---\r?\n([\s\S]*?)\r?\n---/);
if (!fm) die(1, "relatório sem cabeçalho YAML (--- ... ---) com `veredito:`");
const cab = {};
for (const l of fm[1].split(/\r?\n/)) { const m = l.match(/^([\w-]+):\s*(.*)$/); if (m) cab[m[1]] = m[2].trim().replace(/^["']|["']$/g, ""); }
const VEREDITO = (cab.veredito || "").toUpperCase();
if (!["APROVADO", "REPROVADO", "BLOQUEADO"].includes(VEREDITO)) die(1, `veredito inválido no cabeçalho: "${cab.veredito}"`);

// Resumo para o comentário: blocos "Falhou / Layout / Não coberto / Passou" se existirem, senão o cabeçalho
const resumoMatch = texto.match(/## Resumo\s*\r?\n([\s\S]*?)(?:\r?\n## |\s*$)/);
const resumo = (resumoMatch ? resumoMatch[1] : Object.entries(cab).map(([k, v]) => `${k}: ${v}`).join("\n")).trim();

// --- Credencial ------------------------------------------------------------------
let AUTH;
if (env.ADO_PAT) AUTH = `Basic ${Buffer.from(":" + env.ADO_PAT).toString("base64")}`;
else {
  try {
    AUTH = `Bearer ${execFileSync("az", ["account", "get-access-token", "--resource", "499b84ac-1321-427f-aa17-267ca6975798", "--query", "accessToken", "-o", "tsv"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], shell: WIN }).trim()}`;
  } catch { die(2, "sem ADO_PAT e `az` não está logado"); }
}
async function api(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { Authorization: AUTH, ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} em ${url}: ${(await r.text()).slice(0, 300)}`);
  return r.status === 204 ? null : r.json();
}

// --- Plano -----------------------------------------------------------------------
const anexos = [RELATORIO, ...EXTRAS].filter((a) => fs.existsSync(a));
const estado = env[`QA_ESTADO_${VEREDITO}`] || "";
const coluna = env[`QA_COLUNA_${VEREDITO}`] || "";
const boardId = env.QA_BOARD_ID || "";
const comenta = env.QA_SEM_COMENTARIO !== "1";
const icone = { APROVADO: "✅", REPROVADO: "❌", BLOQUEADO: "⛔" }[VEREDITO];
const reprosAnexados = anexos.filter((a) => a.endsWith(".repro.mjs")).map((a) => path.basename(a));
const comentarioRepro = reprosAnexados.length
  ? `<p>Teste de reprodução anexado (falha hoje, passa quando corrigir): ${reprosAnexados.map((r) => `<code>${r}</code>`).join(", ")}. Para conferir a correção: <code>node &lt;plugin testar-card&gt;/skills/testar-card/scripts/rodar-repro.mjs ${reprosAnexados[0]} --login</code></p>`
  : "";
const comentarioHtml = `<p><b>${icone} Teste automático (Claude QA): ${VEREDITO}</b></p><pre>${escapeHtml(resumo)}</pre><p>Relatório completo anexado: <code>${path.basename(RELATORIO)}</code></p>${comentarioRepro}`;

log(`Card ${CARD} · veredito ${VEREDITO}`);
log(`- anexar: ${anexos.map((a) => path.basename(a)).join(", ")}`);
log(`- comentar: ${comenta ? "sim" : "não"}`);
log(`- mover: ${estado ? `estado → ${estado}` : coluna && boardId ? `coluna → ${coluna} (board ${boardId})` : "não"}`);
if (!ESCREVE) { log("DRY-RUN (QA_ESCREVE_ADO != 1): nada foi escrito no ADO."); process.stdout.write(`publicado=NAO (dry-run) veredito=${VEREDITO}\n`); process.exit(0); }

// --- Escrita ---------------------------------------------------------------------
(async () => {
  const patch = [];
  for (const a of anexos) {
    const nome = path.basename(a);
    const up = await api(`${ORG}/${PROJ}/_apis/wit/attachments?fileName=${encodeURIComponent(nome)}&api-version=7.1`, {
      method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: fs.readFileSync(a),
    });
    patch.push({ op: "add", path: "/relations/-", value: { rel: "AttachedFile", url: up.url, attributes: { comment: `Claude QA: ${VEREDITO}` } } });
    log(`anexado ${nome} → ${up.url}`);
  }
  if (estado) patch.push({ op: "add", path: "/fields/System.State", value: estado });
  else if (coluna && boardId) patch.push({ op: "add", path: `/fields/WEF_${boardId.replace(/-/g, "").toUpperCase()}_Kanban.Column`, value: coluna });
  if (patch.length) {
    await api(`${ORG}/${PROJ}/_apis/wit/workitems/${CARD}?api-version=7.1`, { method: "PATCH", headers: { "Content-Type": "application/json-patch+json" }, body: JSON.stringify(patch) });
    log("work item atualizado");
  }
  if (comenta) {
    await api(`${ORG}/${PROJ}/_apis/wit/workItems/${CARD}/comments?api-version=7.1-preview.4`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: comentarioHtml }) });
    log("comentário publicado");
  }
  process.stdout.write(`publicado=SIM veredito=${VEREDITO} anexos=${anexos.length} movido=${estado || coluna || "nao"}\n`);
})().catch((e) => die(1, `ERRO ao publicar: ${e.message}`));

function escapeHtml(s) { return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
