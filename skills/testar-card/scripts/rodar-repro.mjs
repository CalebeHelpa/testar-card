#!/usr/bin/env node
// Roda testes de reprodução (*.repro.mjs) SEM IA. Cada teste afirma o comportamento CORRETO, então:
//   VERMELHO = o defeito continua (asserção falhou, confirmada em 2 execuções)
//   VERDE    = o comportamento correto aconteceu (defeito corrigido, ou o teste não captura o defeito)
//   INSTAVEL = vermelho numa execução e outro resultado na outra
//   QUEBRADO = o teste não chegou à asserção (seletor sumiu, tela mudou): não diz nada sobre o defeito
//   INFRA    = sessão expirada / caiu na tela de login / stage fora do ar
//
// Formato do teste (ver references/repro.md):
//   export const meta = { card: 1234, achado: "F1", titulo: "..." };
//   export default async function ({ page, expect, irPara, rede, banco, aguardar, verificar, log }) {
//     ...preparação: navegar, preencher (falha aqui = QUEBRADO, nunca VERMELHO)...
//     await verificar(async () => { ...só as asserções do comportamento correto... });   // falha aqui = VERMELHO
//   }
//
// Uso:  node rodar-repro.mjs <arquivo.repro.mjs | pasta> [...] [--saida <pasta>] [--json <arquivo>] [--login]
//   --login  faz o login da stage antes (usa QA_USER/QA_PASS do ambiente ou do arquivo .env), para o dev
//            rodar o teste na própria máquina sem passo extra.
// Ambiente: QA_FRONT (obrigatória), QA_STORAGE_STATE (sessão do login-stage.mjs), QA_CHROME_EXE, QA_HEADLESS,
//           QA_LOGIN_URL_PATTERN (padrão "login"), QA_REPRO_TIMEOUT (ms por execução, padrão 120000), FB_DB etc. (banco).
//           QA_REPRO_TRACE=1 grava também o trace do Playwright. Desligado por padrão: o trace guarda o tráfego de rede
//           com os cabeçalhos de autenticação da sessão. Use só na máquina do dev; não anexe nem suba para bucket.
// Saída (stdout): uma linha por teste
//   repro=<arquivo> achado=F1 resultado=VERMELHO execucoes=2 video=<webm> trace=<zip> motivo="..."
// e o JSON completo em --json (padrão <saida>/repro-resultados.json).
// Exit 0 quando rodou (qualquer resultado). Exit 2 quando não há teste ou falta configuração.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, "..", "..", "..");

// --- argumentos -----------------------------------------------------------------
const args = process.argv.slice(2);
const opt = (nome) => { const i = args.indexOf(nome); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const flag = (nome) => { const i = args.indexOf(nome); if (i < 0) return false; args.splice(i, 1); return true; };
const FAZER_LOGIN = flag("--login");
const SAIDA = path.resolve(opt("--saida") || "repro-resultados");
const JSON_OUT = path.resolve(opt("--json") || path.join(SAIDA, "repro-resultados.json"));
const alvos = args;
if (!alvos.length) { console.error("uso: rodar-repro.mjs <arquivo.repro.mjs | pasta> [...] [--saida pasta] [--json arq] [--login]"); process.exit(2); }

// --- ambiente: arquivo local opcional (para o dev); não sobrescreve o que já veio do processo ---------------
for (const f of [process.env.QA_ENV_FILE, path.join(RAIZ, ".env")].filter(Boolean)) {
  if (!fs.existsSync(f)) continue;
  for (const l of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  break;
}
const E = process.env;
let FRONT = E.QA_FRONT || "";
if (!FRONT) { console.error("ERRO: defina QA_FRONT (URL do front da stage)"); process.exit(2); }
const LOGIN_RE = new RegExp(E.QA_LOGIN_URL_PATTERN || "login", "i");
const TIMEOUT = Number(E.QA_REPRO_TIMEOUT || 120000);
fs.mkdirSync(SAIDA, { recursive: true });

// --- arquivos -----------------------------------------------------------------------
const arquivos = [];
for (const a of alvos) {
  const p = path.resolve(a);
  if (!fs.existsSync(p)) { console.error(`AVISO: não existe: ${a}`); continue; }
  if (fs.statSync(p).isDirectory()) for (const f of fs.readdirSync(p).sort()) { if (f.endsWith(".repro.mjs")) arquivos.push(path.join(p, f)); }
  else arquivos.push(p);
}
if (!arquivos.length) { console.error("ERRO: nenhum *.repro.mjs encontrado"); process.exit(2); }

// --- sessão ---------------------------------------------------------------------------
let SESSAO = E.QA_STORAGE_STATE && fs.existsSync(E.QA_STORAGE_STATE) ? E.QA_STORAGE_STATE : null;
if (FAZER_LOGIN || !SESSAO) {
  if (!E.QA_USER || !E.QA_PASS) {
    if (!SESSAO) { console.error("ERRO: sem sessão (QA_STORAGE_STATE) e sem QA_USER/QA_PASS para fazer o login. Rode login-stage.mjs ou use --login."); process.exit(2); }
  } else {
    SESSAO = path.join(SAIDA, "storage-state-repro.json"); // "storage-state" no nome: os filtros de upload já pulam
    const r = spawnSync(process.execPath, [path.join(AQUI, "login-stage.mjs")], { cwd: RAIZ, env: { ...E, QA_STORAGE_STATE: SESSAO }, encoding: "utf8" });
    if (r.status !== 0) { console.error(`ERRO: login falhou (exit ${r.status}): ${(r.stderr || "").trim().split("\n").pop()}`); process.exit(2); }
  }
}

// o login grava ao lado da sessão o endereço em que ela vale (a stage pode redirecionar IP → DNS)
if (SESSAO && fs.existsSync(`${SESSAO}.front`)) { const f = fs.readFileSync(`${SESSAO}.front`, "utf8").trim(); if (f && f !== FRONT) { console.error(`nota: usando o endereço da sessão ${f} (QA_FRONT era ${FRONT})`); FRONT = f; } }

// --- Playwright: o mesmo do MCP do plugin (mesmo Chromium) ---------------------------------
const req = createRequire(path.join(RAIZ, "node_modules", "@playwright", "mcp", "package.json"));
const pw = await import(pathToFileURL(req.resolve("playwright-core")).href);
const chromium = pw.chromium ?? pw.default?.chromium;
const pt = await import(pathToFileURL(req.resolve("playwright/test")).href);
const expect = pt.expect ?? pt.default?.expect;

class ErroInfra extends Error { constructor(m) { super(m); this.name = "ErroInfra"; } }

function bancoHelper() {
  const script = path.join(AQUI, "consultar-banco.sh");
  return async function banco(sql, { db } = {}) {
    const r = spawnSync("bash", [script, sql], { encoding: "utf8", env: { ...E, ...(db ? { FB_DB: db } : {}) } });
    if (r.status !== 0) throw new Error(`banco: ${(r.stderr || r.stdout || "").trim().split("\n").slice(-2).join(" ")}`);
    return r.stdout;
  };
}

async function executarUma(fn, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const browser = await chromium.launch({ headless: E.QA_HEADLESS !== "0", executablePath: E.QA_CHROME_EXE || undefined });
  const ctx = await browser.newContext({ storageState: SESSAO, viewport: { width: 1280, height: 800 }, recordVideo: { dir, size: { width: 1280, height: 800 } } });
  const TRACE = E.QA_REPRO_TRACE === "1";
  if (TRACE) await ctx.tracing.start({ screenshots: true, snapshots: true });
  const page = await ctx.newPage();
  const respostas = [];
  page.on("response", (r) => { try { respostas.push({ metodo: r.request().method(), url: r.url(), status: r.status() }); } catch {} });
  page.on("requestfailed", (q) => { try { respostas.push({ metodo: q.method(), url: q.url(), status: 0, falha: q.failure()?.errorText }); } catch {} });
  const notas = [];
  const rede = {
    todas: () => respostas.slice(),
    chamadas: (padrao) => respostas.filter((x) => (padrao instanceof RegExp ? padrao.test(x.url) : x.url.includes(String(padrao)))),
    limpar: () => { respostas.length = 0; },
  };
  const irPara = async (rota) => {
    const url = /^https?:/i.test(rota) ? rota : new URL(String(rota).replace(/^\/+/, ""), FRONT).href;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    if (LOGIN_RE.test(page.url())) throw new ErroInfra(`caiu na tela de login (${page.url()}): sessão expirada`);
  };
  let naVerificacao = false, verificou = false;
  const verificar = async (cb) => { naVerificacao = true; try { await cb(); verificou = true; } catch (e) { if (e && typeof e === "object") e.naVerificacao = true; throw e; } finally { naVerificacao = false; } };
  const t0 = Date.now();
  let resultado = "VERDE", motivo = "";
  try {
    await Promise.race([
      fn({ page, expect, irPara, rede, banco: bancoHelper(), aguardar: (ms) => page.waitForTimeout(ms), verificar, log: (m) => notas.push(String(m)), env: { QA_FRONT: FRONT } }),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`tempo esgotado (${TIMEOUT} ms)`)), TIMEOUT)),
    ]);
    if (!verificou) { resultado = "QUEBRADO"; motivo = "o teste terminou sem chamar verificar(): não há asserção do comportamento correto"; }
  } catch (e) {
    const msg = String(e?.message || e).split("\n").filter(Boolean).slice(0, 2).join(" | ").slice(0, 300);
    if (e instanceof ErroInfra || LOGIN_RE.test(page.url()) || /net::ERR_|ERR_CONNECTION|ECONNRESET|ENOTFOUND|ETIMEDOUT/.test(msg)) { resultado = "INFRA"; motivo = msg; }
    else if (e?.naVerificacao && e?.matcherResult) { resultado = "VERMELHO"; motivo = msg; }
    else { resultado = "QUEBRADO"; motivo = `${e?.naVerificacao ? "" : "falhou na preparação, antes de verificar(): "}${e?.name || "Erro"}: ${msg}`; }
  }
  const screenshot = path.join(dir, "final.png");
  await page.screenshot({ path: screenshot }).catch(() => {});
  const trace = TRACE ? path.join(dir, "trace.zip") : null;
  if (TRACE) await ctx.tracing.stop({ path: trace }).catch(() => {});
  const video = page.video();
  await ctx.close().catch(() => {});
  await browser.close().catch(() => {});
  let videoPath = null; try { videoPath = await video?.path(); } catch {}
  if (videoPath && fs.existsSync(videoPath)) { const dest = path.join(dir, "video.webm"); try { fs.renameSync(videoPath, dest); videoPath = dest; } catch {} }
  return { resultado, motivo, duracao_s: Math.round((Date.now() - t0) / 100) / 10, video: videoPath, trace, screenshot, notas, chamadas_api: respostas.filter((x) => /\/api\//i.test(x.url)).length };
}

const resultados = [];
for (const arq of arquivos) {
  const nome = path.basename(arq).replace(/\.repro\.mjs$/, "");
  let mod;
  try { mod = await import(pathToFileURL(arq).href); }
  catch (e) { resultados.push({ arquivo: arq, nome, resultado: "QUEBRADO", motivo: `não carregou: ${e.message.split("\n")[0]}`, execucoes: [] }); continue; }
  const meta = mod.meta || {};
  const fn = mod.default;
  if (typeof fn !== "function") { resultados.push({ arquivo: arq, nome, ...meta, resultado: "QUEBRADO", motivo: "sem export default function", execucoes: [] }); continue; }

  const execs = [];
  const r1 = await executarUma(fn, path.join(SAIDA, nome, "1"));
  execs.push(r1);
  let final = r1.resultado;
  if (r1.resultado === "VERMELHO") {
    const r2 = await executarUma(fn, path.join(SAIDA, nome, "2"));
    execs.push(r2);
    final = r2.resultado === "VERMELHO" ? "VERMELHO" : r2.resultado === "INFRA" ? "INFRA" : "INSTAVEL";
  } else if (r1.resultado === "QUEBRADO") {
    const r2 = await executarUma(fn, path.join(SAIDA, nome, "2"));
    execs.push(r2);
    final = r2.resultado === "VERMELHO" ? "INSTAVEL" : r2.resultado; // um vermelho isolado não confirma o defeito
  }
  const ult = execs[execs.length - 1];
  const reg = { arquivo: arq, nome, achado: meta.achado || (nome.match(/-(F\d+)\b/) || [])[1] || "", titulo: meta.titulo || "", card: meta.card || "", resultado: final, motivo: ult.motivo, video: ult.video, trace: ult.trace, screenshot: ult.screenshot, execucoes: execs };
  resultados.push(reg);
  const q = (s) => `"${String(s || "").replace(/"/g, "'")}"`;
  console.log(`repro=${arq} achado=${reg.achado} resultado=${final} execucoes=${execs.length} video=${reg.video || ""} trace=${reg.trace || ""} motivo=${q(reg.motivo)}`);
}

fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
fs.writeFileSync(JSON_OUT, JSON.stringify({ quando: new Date().toISOString(), front: FRONT, resultados }, null, 2));
const cont = resultados.reduce((a, r) => ((a[r.resultado] = (a[r.resultado] || 0) + 1), a), {});
console.log(`resumo=${Object.entries(cont).map(([k, v]) => `${k}:${v}`).join(",")} json=${JSON_OUT}`);
