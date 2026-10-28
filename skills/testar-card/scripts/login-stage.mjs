#!/usr/bin/env node
// Fixture de login na stage. Roda ANTES do agente: faz o login com o usuário de teste, escolhe a empresa
// na 2ª etapa (se houver) e salva a sessão (cookies + localStorage) num arquivo que o Playwright MCP
// recebe em --storage-state. O agente nasce logado e nunca vê a senha.
//
// Uso: node login-stage.mjs
// Variáveis (ver .env.exemplo):
//   QA_USER, QA_PASS          obrigatórias (ou num arquivo .env apontado por QA_ENV_FILE)
//   QA_FRONT                  URL do front da stage (obrigatória)
//   QA_EMPRESA                opcional: empresa da 2ª etapa. Número (código ou prefixo do apelido), apelido, parte do
//                             nome ou a filial do card ("23 - Loja Centro"). Vazio = QA_EMPRESA_PADRAO ou a primeira.
//   QA_EMPRESA_PADRAO         empresa usada quando a pedida não existe (padrão: "1"); QA_EMPRESA_OBRIGATORIA=1 falha (exit 4)
//   QA_STORAGE_STATE          caminho do arquivo de sessão (padrão: ./storage-state.json)
//   QA_HEADLESS               0 = mostra o navegador (padrão: 1)
//   QA_CHROME_EXE             executável alternativo do Chromium
//   Seletores do formulário (padrões do sistema de referência; ajuste ao seu):
//   QA_LOGIN_SEL_USER=input[name=login]  QA_LOGIN_SEL_PASS=input[name=senha]  QA_LOGIN_SEL_SUBMIT=#btnLogin
//   QA_LOGIN_SEL_EMPRESA=#empresa  QA_LOGIN_SEL_EMPRESA_SUBMIT=#btnEmpresa  QA_LOGIN_URL_PATTERN=login (regex; URL de login)
//   QA_LOGIN_LISTA_JS         expressão JS que devolve a lista [{CDEMPRESA, DSAPELIDO, NMFANTASIA}] da 2ª etapa
//                             (padrão: lê o scope AngularJS do campo; sem isso, digita o pedido e aceita a 1ª sugestão)
// Saída (stdout): ok url=... empresa="<APELIDO - NOME>" cdempresa=N [empresa_pedida_nao_encontrada="..."] storage_state=...
// Exit 2 = credencial/config ausente; 3 = login não completou; 4 = empresa pedida não existe (com QA_EMPRESA_OBRIGATORIA=1).

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const envFile = process.env.QA_ENV_FILE || path.join(raiz, ".env");
if (fs.existsSync(envFile)) {
  for (const linha of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const E = process.env;
const { QA_USER, QA_PASS, QA_FRONT } = E;
const EMPRESA = (E.QA_EMPRESA || "").trim();
const OUT = path.resolve(E.QA_STORAGE_STATE || "storage-state.json");
const HEADLESS = E.QA_HEADLESS !== "0";
const SEL = { user: E.QA_LOGIN_SEL_USER || "input[name=login]", pass: E.QA_LOGIN_SEL_PASS || "input[name=senha]", submit: E.QA_LOGIN_SEL_SUBMIT || "#btnLogin", empresa: E.QA_LOGIN_SEL_EMPRESA || "#empresa", empresaSubmit: E.QA_LOGIN_SEL_EMPRESA_SUBMIT || "#btnEmpresa" };
const LOGIN_RE = new RegExp(E.QA_LOGIN_URL_PATTERN || "login", "i");
const LISTA_JS = E.QA_LOGIN_LISTA_JS || `(() => { const el = document.querySelector(${JSON.stringify(SEL.empresa)}); const s = window.angular && el ? window.angular.element(el).scope() : null; return (s && s.listEmpresa || []).map(e => ({ CDEMPRESA: e.CDEMPRESA, DSAPELIDO: e.DSAPELIDO, NMFANTASIA: e.NMFANTASIA })); })()`;
if (!QA_USER || !QA_PASS) { console.error("ERRO: defina QA_USER e QA_PASS (ou QA_ENV_FILE)."); process.exit(2); }
if (!QA_FRONT) { console.error("ERRO: defina QA_FRONT (URL do front da stage)."); process.exit(2); }

// mesmo playwright-core (e mesmo Chromium) que o Playwright MCP do plugin usa
const req = createRequire(path.join(raiz, "node_modules", "@playwright", "mcp", "package.json"));
const pw = await import(pathToFileURL(req.resolve("playwright-core")).href);
const chromium = pw.chromium ?? pw.default?.chromium;

const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

// Escolhe a empresa na lista: por código/número do apelido, por apelido/nome exato, por palavras do nome.
function escolherEmpresa(lista, pedido) {
  if (!lista?.length) return null;
  if (!pedido) return lista[0];
  const p = norm(pedido);
  const numero = (p.match(/^\s*(\d{1,4})\b/) || [])[1];
  const rotulo = (e) => norm(`${e.DSAPELIDO} - ${e.NMFANTASIA}`);
  if (numero) {
    const porCodigo = lista.find((e) => String(e.CDEMPRESA) === numero);
    if (porCodigo) return porCodigo;
    const porApelido = lista.find((e) => norm(e.DSAPELIDO).match(/^\d+/)?.[0] === numero);
    if (porApelido) return porApelido;
  }
  const exato = lista.find((e) => rotulo(e) === p || norm(e.DSAPELIDO) === p || norm(e.NMFANTASIA) === p);
  if (exato) return exato;
  const palavras = p.replace(/\(.*?\)/g, "").replace(/^\d+\s*[-–—]?\s*/, "").split(/[\s-]+/).filter((w) => w.length > 2);
  let melhor = null, melhorPts = 0;
  for (const e of lista) {
    const r = rotulo(e);
    const pts = palavras.filter((w) => r.includes(w)).length;
    if (pts > melhorPts) { melhor = e; melhorPts = pts; }
  }
  return melhorPts > 0 ? melhor : null;
}

const browser = await chromium.launch({ headless: HEADLESS, executablePath: E.QA_CHROME_EXE || undefined });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
try {
  await page.goto(QA_FRONT, { waitUntil: "domcontentloaded", timeout: 60000 });
  // Etapa 1: usuário e senha
  await page.waitForSelector(SEL.user, { timeout: 30000 });
  await page.fill(SEL.user, QA_USER);
  await page.fill(SEL.pass, QA_PASS);
  await page.click(SEL.submit);

  // Etapa 2 (se aparecer): empresa, num autocomplete.
  const campoEmpresa = page.locator(SEL.empresa);
  let escolhida = null, empresaPedidaNaoEncontrada = "";
  try {
    await campoEmpresa.waitFor({ state: "visible", timeout: 20000 });
    await page.waitForFunction((js) => { try { return (eval(js) || []).length > 0; } catch { return false; } }, LISTA_JS, { timeout: 20000 }).catch(() => {});
    const lista = await page.evaluate((js) => { try { return eval(js) || []; } catch { return []; } }, LISTA_JS);
    if (lista.length) {
      escolhida = escolherEmpresa(lista, EMPRESA);
      if (!escolhida) {
        console.error(`AVISO: empresa "${EMPRESA}" não está na lista deste usuário. Disponíveis:`);
        for (const e of lista) console.error(`  ${e.CDEMPRESA}\t${e.DSAPELIDO} - ${e.NMFANTASIA}`);
        if (E.QA_EMPRESA_OBRIGATORIA === "1") { await browser.close(); process.exit(4); }
        escolhida = escolherEmpresa(lista, E.QA_EMPRESA_PADRAO || "1") || lista[0];
        console.error(`AVISO: usando a empresa padrão ${escolhida.CDEMPRESA} (${escolhida.DSAPELIDO} - ${escolhida.NMFANTASIA})`);
        empresaPedidaNaoEncontrada = EMPRESA;
      }
    }
    // autocomplete: o modelo só é preenchido ao escolher uma sugestão; digita-se o apelido e clica-se na sugestão exata
    const digitar = escolhida ? escolhida.DSAPELIDO : (EMPRESA || E.QA_EMPRESA_PADRAO || "1");
    const rotulo = escolhida ? `${escolhida.DSAPELIDO} - ${escolhida.NMFANTASIA}` : digitar;
    await campoEmpresa.click();
    await campoEmpresa.fill("");
    await campoEmpresa.pressSequentially(String(digitar), { delay: 40 });
    const popup = page.locator("ul[uib-typeahead-popup] li, ul.dropdown-menu li, [role=listbox] [role=option], .autocomplete li");
    await popup.first().waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
    const alvo = popup.filter({ hasText: rotulo }).first();
    if (await alvo.count()) await alvo.click(); else await page.keyboard.press("Enter");
    await page.waitForTimeout(400);
    await page.click(SEL.empresaSubmit);
  } catch { /* sem etapa de empresa */ }

  await page.waitForURL((u) => !LOGIN_RE.test(u.href), { timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
  if (LOGIN_RE.test(page.url()) || (await page.locator(SEL.pass).count())) {
    console.error("ERRO: ainda na tela de login após enviar o formulário. Usuário/senha/empresa?");
    process.exit(3);
  }
  await ctx.storageState({ path: OUT });
  const emp = escolhida ? ` empresa="${escolhida.DSAPELIDO} - ${escolhida.NMFANTASIA}" cdempresa=${escolhida.CDEMPRESA}` : "";
  const aviso = empresaPedidaNaoEncontrada ? ` empresa_pedida_nao_encontrada="${empresaPedidaNaoEncontrada}"` : "";
  console.log(`ok url=${page.url()}${emp}${aviso} storage_state=${OUT}`);
} catch (e) {
  console.error(`ERRO no login: ${e.message}`);
  try { await page.screenshot({ path: OUT.replace(/\.json$/, "") + "-erro.png" }); } catch {}
  process.exit(3);
} finally {
  await browser.close();
}
