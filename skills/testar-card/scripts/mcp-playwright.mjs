#!/usr/bin/env node
// Sobe o Playwright MCP deste plugin com os argumentos montados a partir do ambiente.
// É o `command` do .mcp.json. Variáveis:
//   QA_STORAGE_STATE  sessão salva pelo login-stage.mjs (obrigatória: sem ela o agente cai na tela de login)
//   QA_OUT_DIR        pasta dos screenshots (padrão: ./screenshots)
//   QA_HEADLESS       0 = navegador visível (padrão: headless)
//   QA_CHROME_EXE     caminho de um executável alternativo (ex.: headless shell numa máquina que bloqueia o chrome.exe)
//   QA_VIEWPORT       1280x800
//   QA_MCP_EXTRA      argumentos extras, separados por espaço (ex.: "--save-trace")
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const req = createRequire(path.join(raiz, "package.json"));
const cli = path.join(path.dirname(req.resolve("@playwright/mcp/package.json")), "cli.js");
const env = process.env;
const args = [cli, "--browser", "chromium", "--isolated", "--viewport-size", env.QA_VIEWPORT || "1280x800", "--output-dir", env.QA_OUT_DIR || path.resolve("screenshots")];
if (env.QA_HEADLESS !== "0") args.push("--headless");
if (env.QA_STORAGE_STATE) args.push("--storage-state", env.QA_STORAGE_STATE);
else process.stderr.write("mcp-playwright: AVISO: QA_STORAGE_STATE não definido; o navegador sobe deslogado\n");
if (env.QA_CHROME_EXE) args.push("--executable-path", env.QA_CHROME_EXE);
if (env.QA_MCP_EXTRA) args.push(...env.QA_MCP_EXTRA.split(/\s+/).filter(Boolean));

const p = spawn(process.execPath, args, { stdio: "inherit", env });
p.on("exit", (code) => process.exit(code ?? 1));
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => p.kill(s));
