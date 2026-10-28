#!/usr/bin/env node
// Decide, sem IA, como testar de novo um card que voltou para a coluna.
// Lê o relatório anterior do bot (na pasta do card ou baixado dos anexos do card), os testes de reprodução
// (*.repro.mjs) e o que mudou no código desde a versão testada.
//
// Uso:  node reteste.mjs <card>        (depois do preparar-card.mjs, que grava <pasta>/preparo.txt)
// Saída (stdout) chave=valor, também gravada em <pasta>/reteste.txt:
//   relatorio_anterior=<arquivo>|NENHUM  veredito_anterior=  quando_anterior=
//   testado_back= atual_back= mudou_back=SIM|NAO|DESCONHECIDO   (idem front)   base_comparacao=exata|aproximada|nenhuma
//   arquivos_mudados=<n>  arquivos_mudados_lista=<pasta>/reteste-arquivos-mudados.txt
//   defeito_anterior=F1|<título>|<arquivo do repro ou NENHUM>   (um por linha)
//   repro=<arquivo>                                              (um por linha)
//   modo=completo|reteste|so-repro  motivo="..."
// Modos: completo = roteiro inteiro · reteste = agente só nos defeitos anteriores e no que mudou ·
//        so-repro = nenhum commit novo e há teste de reprodução para todo defeito: roda os testes, sem agente.
// QA_MODO=completo|reteste|so-repro força o modo.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const WIN = process.platform === "win32";
const CARD = process.argv[2];
if (!CARD || !/^\d+$/.test(CARD)) { console.error("uso: reteste.mjs <card>"); process.exit(1); }
const TESTES_DIR = process.env.TESTES_DIR || path.resolve("testes-card");
const PASTA = path.join(TESTES_DIR, CARD);
const LINHAS = [];
const out = (k, v) => { const l = `${k}=${String(v ?? "").replace(/\r?\n/g, " ").trim()}`; LINHAS.push(l); console.log(l); };

// --- preparo atual ---------------------------------------------------------------------
const preparoArq = path.join(PASTA, "preparo.txt");
if (!fs.existsSync(preparoArq)) { console.error(`ERRO: ${preparoArq} não existe. Rode preparar-card.mjs ${CARD} antes.`); process.exit(2); }
const prep = {};
for (const l of fs.readFileSync(preparoArq, "utf8").split(/\r?\n/)) { const m = l.match(/^([^=]+)=(.*)$/); if (m && !(m[1] in prep)) prep[m[1]] = m[2]; }

// --- cabeçalho YAML simples ------------------------------------------------------------------
function cabecalho(texto) {
  const m = texto.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const c = {};
  if (!m) return c;
  for (const l of m[1].split(/\r?\n/)) { const k = l.match(/^([\w-]+):\s*(.*)$/); if (k) c[k[1]] = k[2].replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, ""); }
  c._texto = m[1];
  return c;
}

// --- relatório anterior ---------------------------------------------------------------------
const candidatos = [];
for (const dir of [PASTA, path.join(PASTA, "anexos")]) {
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    if (!new RegExp(`^relatorio-${CARD}-.*\\.md$`).test(f)) continue;
    const arq = path.join(dir, f);
    const texto = fs.readFileSync(arq, "utf8");
    const c = cabecalho(texto);
    const veredito = (c.veredito || "").toUpperCase();
    if (!["APROVADO", "REPROVADO", "BLOQUEADO"].includes(veredito)) continue;
    if (candidatos.some((x) => path.basename(x.arq) === f)) continue; // o da pasta tem prioridade sobre o anexo
    candidatos.push({ arq, texto, c, veredito, quando: c.data_hora || c.data || "", mtime: fs.statSync(arq).mtimeMs });
  }
}
candidatos.sort((a, b) => (a.quando === b.quando ? a.mtime - b.mtime : a.quando < b.quando ? -1 : 1));
const ant = candidatos.pop();

// --- testes de reprodução ----------------------------------------------------------------------
const repros = new Map();
for (const dir of [path.join(PASTA, "repro"), path.join(PASTA, "anexos")]) {
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) if (f.endsWith(".repro.mjs") && !repros.has(f)) repros.set(f, path.join(dir, f));
}
const achadoDoRepro = (arq) => {
  const t = fs.readFileSync(arq, "utf8");
  return (t.match(/achado:\s*["'`](F\d+)["'`]/) || [])[1] || (path.basename(arq).match(/-(F\d+)\b/) || [])[1] || "";
};

if (!ant) {
  out("relatorio_anterior", "NENHUM");
  for (const a of repros.values()) out("repro", a);
  decidir("completo", "primeiro teste do card (nenhum relatório anterior do bot)");
}

out("relatorio_anterior", ant.arq);
out("veredito_anterior", ant.veredito);
out("quando_anterior", ant.quando);
out("tipo_anterior", ant.c.tipo || "completo");

// --- versões: testada × atual ------------------------------------------------------------------
function git(dir, args) { const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" }); return r.status === 0 ? r.stdout.trim() : null; }
let base = "exata";
const mudados = [];
const lados = {};
for (const lado of ["back", "front"]) {
  const atual = prep[`sha_${lado}`];
  const dir = prep[`repo_dir_${lado}`];
  const branch = prep[`branch_${lado}`];
  if (!atual || !dir) { lados[lado] = "SEM BRANCH"; continue; }
  let testado = ant.c[`testado_${lado}`] || "";
  if (!testado) { // relatório antigo, sem o campo: tenta o texto do cabeçalho ("contém back ac4457f3")
    testado = (ant.c._texto.match(new RegExp(`\\b${lado}\\s+([0-9a-f]{7,40})\\b`)) || [])[1] || "";
    if (testado) base = base === "exata" ? "aproximada" : base;
  }
  if (!testado && ant.quando && branch) { // último recurso: a ponta da branch no dia do teste
    testado = git(dir, ["rev-list", "-1", `--before=${ant.quando.length <= 10 ? ant.quando + " 23:59:59" : ant.quando}`, `origin/${branch}`]) || "";
    if (testado) base = "aproximada";
  }
  if (!testado) { out(`mudou_${lado}`, "DESCONHECIDO"); lados[lado] = "DESCONHECIDO"; base = "nenhuma"; continue; }
  let completo = git(dir, ["rev-parse", "--verify", `${testado}^{commit}`]);
  if (!completo) { git(dir, ["fetch", "origin", "--quiet"]); completo = git(dir, ["rev-parse", "--verify", `${testado}^{commit}`]); }
  out(`testado_${lado}`, completo || testado);
  out(`atual_${lado}`, atual);
  if (!completo) { out(`mudou_${lado}`, "DESCONHECIDO"); lados[lado] = "DESCONHECIDO"; base = "nenhuma"; continue; }
  if (completo === atual) { out(`mudou_${lado}`, "NAO"); lados[lado] = "NAO"; continue; }
  const lista = (git(dir, ["diff", "--name-only", `${completo}..${atual}`]) || "").split(/\r?\n/).filter(Boolean);
  const commits = (git(dir, ["log", "--oneline", `${completo}..${atual}`]) || "").split(/\r?\n/).filter(Boolean);
  for (const f of lista) mudados.push(`${lado}: ${f}`);
  out(`mudou_${lado}`, `SIM (${commits.length} commit(s), ${lista.length} arquivo(s))`);
  lados[lado] = "SIM";
}
out("base_comparacao", base);
const listaArq = path.join(PASTA, "reteste-arquivos-mudados.txt");
fs.writeFileSync(listaArq, mudados.join("\n") + (mudados.length ? "\n" : ""));
out("arquivos_mudados", mudados.length);
out("arquivos_mudados_lista", listaArq);

// --- defeitos do relatório anterior ----------------------------------------------------------------
const defeitos = [];
const secoes = ant.texto.split(/\r?\n(?=### )/);
for (const s of secoes) {
  const m = s.match(/^### (F\d+)\s*[—–-]\s*(.+)/);
  if (!m) continue;
  const cls = (s.match(/\*\*Classifica[çc][aã]o:\*\*\s*([\w-]+)/i) || [])[1] || "";
  if (cls.toLowerCase() !== "defeito") continue;
  defeitos.push({ id: m[1], titulo: m[2].trim() });
}
const reproPorAchado = new Map([...repros.values()].map((a) => [achadoDoRepro(a), a]));
for (const d of defeitos) out("defeito_anterior", `${d.id}|${d.titulo}|${reproPorAchado.get(d.id) || "NENHUM"}`);
for (const a of repros.values()) out("repro", a);

// --- decisão ------------------------------------------------------------------------------------------
const algumMudou = Object.values(lados).includes("SIM");
const desconhecido = Object.values(lados).includes("DESCONHECIDO");
if (ant.veredito === "BLOQUEADO") decidir("completo", "o teste anterior foi BLOQUEADO: nada foi testado de fato");
if (ant.veredito === "APROVADO") decidir("completo", "o card foi APROVADO antes e voltou: roteiro inteiro");
if (!defeitos.length) decidir("completo", "relatório anterior REPROVADO sem defeito identificável");
if (desconhecido) decidir("reteste", "não deu para comparar a versão testada com a atual: reteste nos defeitos anteriores, sem regressão por diff");
if (!algumMudou && defeitos.every((d) => reproPorAchado.has(d.id))) decidir("so-repro", "nenhum commit novo desde o teste anterior e todo defeito tem teste de reprodução");
if (!algumMudou) decidir("reteste", "nenhum commit novo; falta teste de reprodução para algum defeito: o agente confirma e escreve");
decidir("reteste", `${mudados.length} arquivo(s) mudaram desde a versão testada: defeitos anteriores + regressão do que mudou`);

function decidir(modo, motivo) {
  const forcado = process.env.QA_MODO;
  if (forcado && ["completo", "reteste", "so-repro"].includes(forcado) && forcado !== modo) { motivo = `forçado por QA_MODO (sugestão era ${modo}: ${motivo})`; modo = forcado; }
  out("modo", modo);
  out("motivo", `"${motivo}"`);
  fs.mkdirSync(PASTA, { recursive: true });
  fs.writeFileSync(path.join(PASTA, "reteste.txt"), LINHAS.join("\n") + "\n");
  process.exit(0);
}
