#!/usr/bin/env node
// Instala o Chromium que o Playwright MCP deste plugin usa. Roda no `npm install` (postinstall)
// e pode ser rodado à mão: node skills/testar-card/scripts/instalar-navegador.mjs [--with-deps]
// Resolve o playwright-core a partir do @playwright/mcp, para o navegador bater com a versão do MCP.
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const req = createRequire(path.join(root, "node_modules", "@playwright", "mcp", "package.json"));
// "playwright-core/cli.js" não está nos exports do pacote: resolve o main e monta o caminho do cli ao lado
const cli = path.join(path.dirname(req.resolve("playwright-core")), "cli.js");
const args = [cli, "install", ...(process.argv.includes("--with-deps") ? ["--with-deps"] : []), "chromium"];
const r = spawnSync(process.execPath, args, { stdio: "inherit" });
process.exit(r.status ?? 1);
