#!/usr/bin/env node
// Orquestração de referência: login (fixture) → agente com a skill → publicar resultado.
// Uso: node exemplo-sdk/run.mjs <card>
// Variáveis: ver README.md (QA_USER/QA_PASS para o login; ADO_PAT, FB_DB, QA_ESCREVE_ADO, QA_ESTADO_* ...)
// Exit: 0 APROVADO · 10 REPROVADO · 20 BLOQUEADO · 1 erro.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = path.join(PLUGIN_DIR, "skills", "testar-card", "scripts");
const card = process.argv[2];
if (!card || !/^\d+$/.test(card)) { console.error("uso: run.mjs <card>"); process.exit(1); }

const WIN = process.platform === "win32";
const TESTES_DIR = process.env.TESTES_DIR || path.resolve("testes-card");

// Uso local: variáveis num arquivo (QA_ENV_FILE ou <plugin>/.env). Em produção vêm do ambiente/cofre de segredos.
const envFile = process.env.QA_ENV_FILE || path.join(PLUGIN_DIR, ".env");
if (fs.existsSync(envFile)) for (const l of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const pasta = path.join(TESTES_DIR, card);
const QA_OUT_DIR = path.join(pasta, "screenshots");
const QA_STORAGE_STATE = path.join(pasta, "storage-state.json");
fs.mkdirSync(QA_OUT_DIR, { recursive: true });

const env = { ...process.env, TESTES_DIR, QA_OUT_DIR, QA_STORAGE_STATE, QA_AUTONOMO: "1" };
delete env.QA_PASS; // o agente não recebe a senha
// Nem a credencial do ADO: o agente lê texto de card (entrada não confiável). Só o preparo e a publicação usam.
const envAdo = { ...env };
for (const k of Object.keys(env)) if (/^(ADO_PAT|AZURE_)/.test(k)) delete env[k];

// 1) preparar: lê o card e resolve o ambiente (cliente/filial do card → front, banco, empresa do login)
console.log("[1/4] preparar card...");
const prep = spawnSync(process.execPath, [path.join(SCRIPTS, "preparar-card.mjs"), card], { env: envAdo, encoding: "utf8" });
process.stderr.write(prep.stderr || "");
if (prep.status !== 0) await bloqueado(`preparo do card falhou (exit ${prep.status})`);
const chaves = Object.fromEntries((prep.stdout || "").split(/\r?\n/).map((l) => l.match(/^([^=]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
for (const k of ["titulo", "estado", "cliente_nr", "cliente_nome", "filial", "qa_ambiente", "qa_front", "qa_banco", "qa_banco_cliente", "qa_empresa", "publicado_back", "publicado_front", "criterio_aceite"]) if (chaves[k] !== undefined) console.log(`  ${k}=${chaves[k]}`);
env.QA_FRONT = chaves.qa_front || env.QA_FRONT;
if (chaves.qa_banco) env.FB_DB = chaves.qa_banco;
if (chaves.qa_banco_cliente && chaves.qa_banco_cliente !== "NENHUM") env.QA_BANCO_CLIENTE = chaves.qa_banco_cliente;
env.QA_AMBIENTE = chaves.qa_ambiente || "padrao";

// 2) login na stage do ambiente resolvido, escolhendo a empresa/filial do card
console.log("[2/4] login na stage...");
const login = spawnSync(process.execPath, [path.join(SCRIPTS, "login-stage.mjs")], { env: { ...process.env, QA_STORAGE_STATE, QA_FRONT: env.QA_FRONT, QA_EMPRESA: chaves.qa_empresa || process.env.QA_EMPRESA || "" }, encoding: "utf8" });
process.stdout.write(login.stdout || ""); process.stderr.write(login.stderr || "");
if (login.status !== 0) await bloqueado(login.status === 4 ? `empresa/filial "${chaves.qa_empresa}" não existe para o usuário de teste` : `login na stage falhou (exit ${login.status})`);
const mEmp = (login.stdout || "").match(/empresa="([^"]*)" cdempresa=(\d+)(?: empresa_pedida_nao_encontrada="([^"]*)")?/);
if (mEmp) { env.QA_EMPRESA_LOGADA = `${mEmp[2]} - ${mEmp[1]}`; if (mEmp[3]) env.QA_EMPRESA_NAO_ENCONTRADA = mEmp[3]; }

// 3) agente
console.log("[3/4] agente...");
const { query } = await import("@anthropic-ai/claude-agent-sdk");
let resultado = null;
const t0 = Date.now();
for await (const m of query({
  prompt: `/testar-card:testar-card ${card}`,
  options: {
    cwd: pasta,
    plugins: [{ type: "local", path: PLUGIN_DIR }],
    env,
    settingSources: [],
    allowedTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "Skill", "Agent", "mcp__plugin_testar-card_playwright__*"],
    disallowedTools: ["mcp__plugin_testar-card_playwright__browser_run_code_unsafe"],
    maxTurns: Number(process.env.QA_MAX_TURNS || 400),
  },
})) {
  if (m.type === "system" && m.subtype === "init") {
    console.log("plugins:", JSON.stringify(m.plugins));
    console.log("mcp:", JSON.stringify(m.mcp_servers));
    console.log("skills:", JSON.stringify(m.skills));
    console.log("tools playwright:", (m.tools || []).filter((t) => /playwright/i.test(t)).length);
    if (m.plugin_errors?.length) console.log("plugin_errors:", JSON.stringify(m.plugin_errors));
  }
  if (m.type === "assistant") {
    for (const b of m.message.content) {
      if (b.type === "tool_use") console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] ${b.name} ${resumo(b.input)}`);
      if (b.type === "text" && b.text.trim()) console.log(`  > ${b.text.trim().slice(0, 300).replace(/\n/g, " ")}`);
    }
  }
  if (m.type === "result") { resultado = m; console.log("result:", m.subtype, m.duration_ms ? `${(m.duration_ms / 60000).toFixed(1)} min` : "", m.total_cost_usd ? `$${m.total_cost_usd.toFixed(2)}` : ""); }
}

// 4) publicar
console.log("[4/4] publicar...");
const rel = fs.readdirSync(pasta).filter((f) => /^relatorio-\d+-.*\.md$/.test(f)).sort().pop();
if (!rel) await bloqueado("agente não produziu relatório");
const pub = spawnSync(process.execPath, [path.join(SCRIPTS, "publicar-resultado.mjs"), card, path.join(pasta, rel)], { env: { ...envAdo, ...env, ...Object.fromEntries(Object.entries(envAdo).filter(([k]) => /^(ADO_PAT|AZURE_)/.test(k))) }, encoding: "utf8" });
process.stdout.write(pub.stdout || ""); process.stderr.write(pub.stderr || "");
const veredito = (pub.stdout.match(/veredito=(\w+)/) || [])[1] || "BLOQUEADO";
console.log(`veredito=${veredito} relatorio=${path.join(pasta, rel)}`);
process.exit({ APROVADO: 0, REPROVADO: 10, BLOQUEADO: 20 }[veredito] ?? 1);

function resumo(input) {
  try { const s = JSON.stringify(input); return s.length > 120 ? s.slice(0, 120) + "…" : s; } catch { return ""; }
}
async function bloqueado(motivo) {
  const data = new Date().toISOString().slice(0, 10);
  const arq = path.join(pasta, `relatorio-${card}-${data}.md`);
  if (!fs.existsSync(arq)) fs.writeFileSync(arq, `---\ncard: ${card}\nveredito: BLOQUEADO\nmotivo_bloqueio: ${motivo}\ndata: ${data}\nmodo: autonomo\n---\n\n# Teste do card ${card}\n\n## Resumo\n**Bloqueado:** ${motivo}\n`);
  const pub = spawnSync(process.execPath, [path.join(SCRIPTS, "publicar-resultado.mjs"), card, arq], { env: { ...envAdo, ...env, ...Object.fromEntries(Object.entries(envAdo).filter(([k]) => /^(ADO_PAT|AZURE_)/.test(k))) }, encoding: "utf8" });
  process.stdout.write(pub.stdout || ""); process.stderr.write(pub.stderr || "");
  console.log(`veredito=BLOQUEADO motivo=${motivo}`);
  process.exit(20);
}
