#!/usr/bin/env node
// Orquestração de referência:
//   preparar → portões sem IA → decidir modo (reteste.mjs) → login → testes de reprodução sem IA → agente → publicar
// Uso: node exemplo-sdk/run.mjs <card>
// Modos: completo (primeira vez, ou o card voltou depois de APROVADO/BLOQUEADO) · reteste (agente só nos defeitos de
//        antes e no que mudou) · so-repro (nenhum commit novo e os testes de reprodução continuam vermelhos: sem agente).
//        QA_MODO força um modo.
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
// Vídeo do teste vermelho vai para o card só com QA_ANEXAR_VIDEO=1; por padrão fica na pasta de resultados.
const ANEXAR_VIDEO = process.env.QA_ANEXAR_VIDEO === "1";
const pasta = path.join(TESTES_DIR, card);
const QA_OUT_DIR = path.join(pasta, "screenshots");
const QA_STORAGE_STATE = path.join(pasta, "storage-state.json");
const REPRO_OUT = path.join(pasta, "repro-resultados");
fs.mkdirSync(QA_OUT_DIR, { recursive: true });
const INICIO = new Date();

const env = { ...process.env, TESTES_DIR, QA_OUT_DIR, QA_STORAGE_STATE, QA_AUTONOMO: "1" };
delete env.QA_PASS; // o agente não recebe a senha
// Nem a credencial do ADO: o agente lê texto de card (entrada não confiável). Só o preparo e a publicação usam.
const envAdo = { ...env };
for (const k of Object.keys(env)) if (/^(ADO_PAT|AZURE_)/.test(k)) delete env[k];
const envPublicar = () => ({ ...env, ...Object.fromEntries(Object.entries(envAdo).filter(([k]) => /^(ADO_PAT|AZURE_)/.test(k))) });

const kv = (txt) => { const o = {}; for (const l of String(txt || "").split(/\r?\n/)) { const m = l.match(/^([^=]+)=(.*)$/); if (m && !(m[1] in o)) o[m[1]] = m[2]; } return o; };
const todas = (txt, chave) => String(txt || "").split(/\r?\n/).filter((l) => l.startsWith(`${chave}=`)).map((l) => l.slice(chave.length + 1));
const node = (script, args, opts = {}) => spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], { encoding: "utf8", ...opts });
let custo = { usd: 0, min: 0, turnos: 0 };
let chaves = {};

// 1) preparar: lê o card e resolve o ambiente (cliente/filial do card → front, banco, empresa do login)
console.log("[1/5] preparar card...");
const prep = node("preparar-card.mjs", [card], { env: envAdo });
process.stderr.write(prep.stderr || "");
if (prep.status !== 0) await bloqueado(`preparo do card falhou (exit ${prep.status})`);
chaves = kv(prep.stdout);
for (const k of ["titulo", "estado", "cliente_nome", "filial", "qa_ambiente", "qa_front", "qa_empresa", "publicado_back", "publicado_front", "criterio_aceite"]) if (chaves[k] !== undefined) console.log(`  ${k}=${chaves[k]}`);
env.QA_FRONT = chaves.qa_front || env.QA_FRONT;
if (chaves.qa_banco) env.FB_DB = chaves.qa_banco;
if (chaves.qa_banco_cliente && chaves.qa_banco_cliente !== "NENHUM") env.QA_BANCO_CLIENTE = chaves.qa_banco_cliente;
env.QA_AMBIENTE = chaves.qa_ambiente || "padrao";

// Portões que não precisam de agente: decidir aqui economiza a subida inteira de uma sessão.
const naoPublicado = ["back", "front"].filter((l) => /^NAO/.test(chaves[`publicado_${l}`] || ""));
if (naoPublicado.length) await bloqueado(`build da stage não contém a branch do card (${naoPublicado.join(" e ")})`);
if (/^SEM BRANCH/.test(chaves.publicado || "")) await bloqueado("card sem branch vinculada: não dá para afirmar o que está na stage");
if (chaves.criterio_aceite === "AUSENTE" && (process.env.QA_EXIGE_CRITERIO ?? "1") !== "0") await bloqueado("card sem critério de aceite (QA_EXIGE_CRITERIO=1)");

// 2) decidir o modo: primeira vez, reteste com agente, ou só os testes de reprodução
console.log("[2/5] decidir modo...");
const ret = node("reteste.mjs", [card], { env: { ...env, TESTES_DIR } });
process.stderr.write(ret.stderr || "");
const dec = kv(ret.stdout);
let modo = dec.modo || "completo";
const repros = todas(ret.stdout, "repro");
const defeitosAnteriores = todas(ret.stdout, "defeito_anterior").map((l) => { const [id, titulo, repro] = l.split("|"); return { id, titulo, repro }; });
console.log(`  modo=${modo} ${dec.motivo || ""}`);
if (dec.relatorio_anterior && dec.relatorio_anterior !== "NENHUM") console.log(`  anterior=${path.basename(dec.relatorio_anterior)} (${dec.veredito_anterior}) · back ${dec.mudou_back || "-"} · front ${dec.mudou_front || "-"} · testes de reprodução: ${repros.length}`);

// 3) login na stage, escolhendo a empresa/filial do card
console.log("[3/5] login na stage...");
const login = node("login-stage.mjs", [], { env: { ...process.env, QA_STORAGE_STATE, QA_FRONT: env.QA_FRONT, QA_EMPRESA: chaves.qa_empresa || process.env.QA_EMPRESA || "" } });
process.stdout.write(login.stdout || ""); process.stderr.write(login.stderr || "");
if (login.status !== 0) await bloqueado(login.status === 4 ? `empresa/filial "${chaves.qa_empresa}" não existe para o usuário de teste` : `login na stage falhou (exit ${login.status})`);
const mEmp = (login.stdout || "").match(/empresa="([^"]*)" cdempresa=(\d+)(?: empresa_pedida_nao_encontrada="([^"]*)")?/);
if (mEmp) { env.QA_EMPRESA_LOGADA = `${mEmp[2]} - ${mEmp[1]}`; if (mEmp[3]) env.QA_EMPRESA_NAO_ENCONTRADA = mEmp[3]; }
const mFront = (login.stdout || "").match(/front_efetivo=(\S+)/);
if (mFront && mFront[1] !== env.QA_FRONT) { console.log(`  a stage redirecionou: usando ${mFront[1]}`); env.QA_FRONT = mFront[1]; }

// 4) testes de reprodução sem IA (reteste) e, se precisar, o agente
console.log("[4/5] executar...");
let reproRes = null;
if (repros.length && modo !== "completo") {
  const t = Date.now();
  const rr = node("rodar-repro.mjs", [...repros, "--saida", REPRO_OUT], { env });
  for (const l of (rr.stdout || "").split(/\r?\n/)) if (/^(repro|resumo)=/.test(l)) console.log(`  ${l.replace(/ (video|trace)=\S+/g, "")}`);
  try { reproRes = JSON.parse(fs.readFileSync(path.join(REPRO_OUT, "repro-resultados.json"), "utf8")); } catch {}
  console.log(`  testes de reprodução: ${((Date.now() - t) / 1000).toFixed(0)} s, sem agente`);
  custo.min += (Date.now() - t) / 60000;
}

let rel = null;
if (modo === "so-repro") {
  const res = reproRes?.resultados || [];
  const vermelhos = res.filter((r) => r.resultado === "VERMELHO");
  if (res.length && vermelhos.length === res.length) {
    rel = relatorioSoRepro(res);
    console.log("  nenhum commit novo e todos os testes de reprodução continuam vermelhos: REPROVADO sem agente");
  } else {
    console.log("  algum teste de reprodução não ficou VERMELHO 2/2: o agente confere");
    modo = "reteste";
  }
}

if (!rel) {
  env.QA_MODO = modo;
  if (modo === "reteste") {
    env.QA_RELATORIO_ANTERIOR = dec.relatorio_anterior;
    env.QA_ARQUIVOS_MUDADOS = dec.arquivos_mudados_lista || "";
    if (reproRes) env.QA_REPRO_RESULTADOS = path.join(REPRO_OUT, "repro-resultados.json");
  }
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
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
      console.log("  plugins:", (m.plugins || []).map((p) => p.name).join(", "), "· playwright:", (m.tools || []).filter((t) => /playwright/i.test(t)).length, "ferramentas");
      if (m.plugin_errors?.length) console.log("  plugin_errors:", JSON.stringify(m.plugin_errors));
    }
    if (m.type === "assistant") {
      for (const b of m.message.content) {
        if (b.type === "tool_use") console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] ${b.name} ${resumo(b.input)}`);
        if (b.type === "text" && b.text.trim()) console.log(`  > ${b.text.trim().slice(0, 300).replace(/\n/g, " ")}`);
      }
    }
    if (m.type === "result") {
      custo = { usd: m.total_cost_usd || 0, min: custo.min + (m.duration_ms || 0) / 60000, turnos: m.num_turns || 0 };
      console.log("  result:", m.subtype, `${custo.min.toFixed(1)} min`, `$${custo.usd.toFixed(2)}`, `${custo.turnos} turnos`);
    }
  }
  const novos = fs.readdirSync(pasta).filter((f) => new RegExp(`^relatorio-${card}-.*\\.md$`).test(f)).map((f) => path.join(pasta, f)).filter((f) => fs.statSync(f).mtimeMs >= INICIO.getTime() - 1000);
  rel = novos.sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs).pop();
  if (!rel) await bloqueado("agente não produziu relatório");
}

// 5) carimbar o cabeçalho com o que o orquestrador sabe de fato, e publicar com os anexos
console.log("[5/5] publicar...");
marcarCabecalho(rel, {
  data_hora: INICIO.toISOString(),
  testado_back: chaves.sha_back || "",
  testado_front: chaves.sha_front || "",
  execucao: modo,
  custo_usd: custo.usd.toFixed(2),
  duracao_min: custo.min.toFixed(1),
  turnos: custo.turnos,
});
const anexos = anexosParaPublicar();
const pub = node("publicar-resultado.mjs", [card, rel, ...anexos], { env: envPublicar() });
process.stdout.write(pub.stdout || ""); process.stderr.write(pub.stderr || "");
// o veredito vem do cabeçalho do relatório (a fonte da verdade), não da saída da publicação
const veredito = ((fs.readFileSync(rel, "utf8").match(/^veredito:\s*(\w+)/m) || [])[1] || "BLOQUEADO").toUpperCase();
console.log(`veredito=${veredito} modo=${modo} custo=$${custo.usd.toFixed(2)} relatorio=${rel}`);
sair(veredito, pub);

// --- funções ------------------------------------------------------------------------------------------------------

function resumo(input) {
  try { const s = JSON.stringify(input); return s.length > 120 ? s.slice(0, 120) + "…" : s; } catch { return ""; }
}

function nomeLivre(base) {
  let arq = path.join(pasta, `${base}.md`), n = 2;
  while (fs.existsSync(arq)) arq = path.join(pasta, `${base}-${n++}.md`);
  return arq;
}

// Atualiza (ou acrescenta) chaves no cabeçalho YAML do relatório.
function marcarCabecalho(arq, campos) {
  let t = fs.readFileSync(arq, "utf8");
  const m = t.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return;
  let cab = m[1];
  for (const [k, v] of Object.entries(campos)) {
    const re = new RegExp(`^${k}:.*$`, "m");
    const linha = `${k}: ${v}`;
    cab = re.test(cab) ? cab.replace(re, linha) : `${cab}\n${linha}`;
  }
  fs.writeFileSync(arq, t.replace(m[0], `---\n${cab}\n---`));
}

// Relatório de reteste sem agente: nada mudou no código e os testes de reprodução continuam vermelhos.
function relatorioSoRepro(res) {
  const hoje = INICIO.toISOString().slice(0, 10);
  const anterior = fs.readFileSync(dec.relatorio_anterior, "utf8");
  const secao = (id) => (anterior.split(/\r?\n(?=#{2,3} )/).find((s) => new RegExp(`^### ${id}\\s*[—–-]`).test(s)) || "").trim();
  const porId = new Map(res.map((r) => [r.achado, r]));
  const videoRel = (r) => (r.video ? path.relative(pasta, r.video).replace(/\\/g, "/") : "-");
  const linhas = defeitosAnteriores.map((d) => {
    const r = porId.get(d.id);
    return `| ${d.id} ${d.titulo} | defeito | PERSISTE | \`${path.basename(d.repro)}\` VERMELHO 2/2 · vídeo \`${videoRel(r)}\` |`;
  });
  const secoes = defeitosAnteriores.map((d) => `${secao(d.id)}\n**Situação no reteste de ${hoje}:** PERSISTE · teste de reprodução VERMELHO 2/2 (${(porId.get(d.id)?.motivo || "").slice(0, 160)})`);
  const arq = nomeLivre(`relatorio-${card}-${hoje}-reteste`);
  fs.writeFileSync(arq, [
    "---",
    `card: ${card}`,
    `titulo: ${chaves.titulo || ""}`,
    "veredito: REPROVADO",
    "motivo_bloqueio:",
    `data: ${hoje}`,
    "modo: autonomo",
    "tipo: reteste",
    `relatorio_anterior: ${path.basename(dec.relatorio_anterior)}`,
    `publicado_back: ${chaves.publicado_back || ""}`,
    `publicado_front: ${chaves.publicado_front || ""}`,
    `criterio_aceite: ${chaves.criterio_aceite || ""}`,
    `defeitos: ${defeitosAnteriores.length}`,
    `repro_vermelhos: ${res.length}`,
    "---",
    "",
    `# Reteste do card ${card} — ${chaves.titulo || ""}`,
    "",
    "## Resumo",
    `**Reteste:** nenhum commit novo desde o teste de ${dec.quando_anterior}; ${defeitosAnteriores.map((d) => `${d.id} PERSISTE`).join(" · ")}.`,
    `**Falhou:** ${defeitosAnteriores.map((d) => `${d.id} ${d.titulo} (teste de reprodução vermelho 2/2${ANEXAR_VIDEO ? ", vídeo anexado" : ""})`).join(" · ")}`,
    "**Como:** só os testes de reprodução, sem agente. O código do card não mudou, então o roteiro não foi refeito.",
    "",
    "## Achados anteriores",
    "| Achado | Antes | Agora | Evidência |",
    "|---|---|---|---|",
    ...linhas,
    "",
    "## Achados (os que persistem, do relatório anterior)",
    "",
    ...secoes,
    "",
    "## Como conferir a correção",
    "Rode o teste de reprodução até ficar verde (ele faz o login sozinho com `--login`):",
    "```bash",
    ...defeitosAnteriores.map((d) => `node <plugin testar-card>/skills/testar-card/scripts/rodar-repro.mjs ${path.basename(d.repro)} --login`),
    "```",
    `Passos, esperado e proposta de correção completos: \`${path.basename(dec.relatorio_anterior)}\`.`,
    "",
  ].join("\n"));
  return arq;
}

// Anexos: testes de reprodução novos ou alterados (o card já tem os iguais) e, com QA_ANEXAR_VIDEO=1, o vídeo de cada vermelho.
function anexosParaPublicar() {
  const lista = [];
  const dirRepro = path.join(pasta, "repro");
  const dirAnexos = path.join(pasta, "anexos");
  if (fs.existsSync(dirRepro)) for (const f of fs.readdirSync(dirRepro).filter((f) => f.endsWith(".repro.mjs"))) {
    const arq = path.join(dirRepro, f), noCard = path.join(dirAnexos, f);
    if (fs.existsSync(noCard) && fs.readFileSync(noCard, "utf8") === fs.readFileSync(arq, "utf8")) continue;
    lista.push(arq);
  }
  if (!ANEXAR_VIDEO) return lista;
  let res = [];
  try { res = JSON.parse(fs.readFileSync(path.join(REPRO_OUT, "repro-resultados.json"), "utf8")).resultados || []; } catch {}
  for (const r of res) {
    if (!["VERMELHO", "INSTAVEL"].includes(r.resultado) || !r.video || !fs.existsSync(r.video)) continue;
    if (fs.statSync(r.video).size > 25 * 1024 * 1024) continue;
    const dest = path.join(REPRO_OUT, `${r.nome}-${r.resultado.toLowerCase()}.webm`);
    fs.copyFileSync(r.video, dest);
    lista.push(dest);
  }
  return lista;
}

async function bloqueado(motivo) {
  const data = INICIO.toISOString().slice(0, 10);
  const arq = nomeLivre(`relatorio-${card}-${data}-bloqueado`);
  fs.mkdirSync(pasta, { recursive: true });
  fs.writeFileSync(arq, `---\ncard: ${card}\ntitulo: ${chaves.titulo || ""}\nveredito: BLOQUEADO\nmotivo_bloqueio: ${motivo}\ndata: ${data}\ndata_hora: ${INICIO.toISOString()}\nmodo: autonomo\ncusto_usd: 0.00\n---\n\n# Teste do card ${card}\n\n## Resumo\n**Bloqueado:** ${motivo}\n`);
  const pub = node("publicar-resultado.mjs", [card, arq], { env: envPublicar() });
  process.stdout.write(pub.stdout || ""); process.stderr.write(pub.stderr || "");
  console.log(`veredito=BLOQUEADO motivo=${motivo}`);
  sair("BLOQUEADO", pub);
}

// Com QA_ESCREVE_ADO=1, publicar no card faz parte do trabalho: se falhar, é erro de execução (exit 1), não um
// veredito. O relatório continua na pasta do card. Em dry-run a publicação não escreve, então não decide nada.
function sair(veredito, pub) {
  if (pub.status !== 0 && process.env.QA_ESCREVE_ADO === "1") {
    console.log(`ERRO: a publicação no card falhou (exit ${pub.status}); o veredito ${veredito} ficou só no relatório local`);
    process.exit(1);
  }
  process.exit({ APROVADO: 0, REPROVADO: 10, BLOQUEADO: 20 }[veredito] ?? 1);
}
