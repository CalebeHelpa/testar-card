// Resolve o ambiente de teste a partir do texto do card.
// Lê o template dos cards ("Grupo de empresa / NR Cliente", "Filial", "Acesso ... base NN") e:
//   - clientes.json (empresa padrão do login, aliases por cliente)
//   - o arquivo de conexões (QA_CONEXOES; bloco "ConnectionStrings" com "Context<Cliente>": "Server=...;Database=...")
//     para achar a base do cliente pelo nome → banco de REFERÊNCIA (só leitura), não o banco da stage.
// Exporta resolverAmbiente(textoDoCard) → { clienteNr, clienteNome, filial, ambiente, front, banco, bancoCliente, empresa }
//   ambiente: "padrao" (sem cliente no card) | "cliente-com-base" (base do cliente encontrada) | "cliente-sem-base"
//   front/banco: sempre a stage (QA_FRONT / FB_DB). empresa: filial do card para a etapa "empresa" do login (se existir na lista).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const ROTULOS = "Grupo de empresa|Filia(?:l|is|ais)|Ramo do cliente|Acesso|Descri[çc][aã]o|Data da Solicita[çc][aã]o|In[ií]cio do Problema|Passos para|Vers[aã]o|Solicitante|Usu[aá]rio \\/ Cargo|Ticket|Sistema \\/ M[oó]dulo";

export const norm = (s) => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const chave = (s) => norm(s).replace(/[^a-z0-9]/g, "");

export function lerClientes(arquivo = process.env.QA_CLIENTES || path.join(AQUI, "..", "clientes.json")) {
  try { return JSON.parse(fs.readFileSync(arquivo, "utf8")); } catch { return { padrao: {}, clientes: {} }; }
}

// "ContextExemplo": "Server=db.interno;Database=D:\\Bases\\VisionExemplo.fdb;..." → { exemplo: { nome, banco: "db.interno:D:/Bases/VisionExemplo.fdb" } }
export function lerConexoes(arquivo = process.env.QA_CONEXOES || path.join(AQUI, "..", "..", "..", "conexoes.txt")) {
  const mapa = {};
  let txt; try { txt = fs.readFileSync(arquivo, "utf8"); } catch { return mapa; }
  for (const m of txt.matchAll(/"Context([A-Za-z0-9]*)"\s*:\s*"([^"]*)"/g)) {
    const nome = m[1]; const cs = m[2];
    const server = (cs.match(/Server=([^;]+)/i) || [])[1]; const db = (cs.match(/Database=([^;]+)/i) || [])[1];
    if (!nome || !server || !db) continue;
    mapa[chave(nome)] = { nome, banco: `${server.trim()}:${db.replace(/\\\\/g, "/").replace(/\\/g, "/").trim()}` };
  }
  return mapa;
}

export function extrairClienteFilial(texto) {
  // separa rótulos colados ("TIGrupo de empresa", "ExemploFilial:", "TodasRamo do cliente")
  const t = texto.replace(/\r/g, "").replace(new RegExp(`(?<=[^\\s/])(${ROTULOS})`, "g"), "\n$1");
  const i = t.search(/Grupo de empresa|NR\s*Cliente/i);
  if (i < 0) return { clienteNr: null, clienteNome: null, filial: null };
  let bloco = t.slice(i).replace(/^(?:Grupo de empresa)?\s*(?:\/\s*NR\s*Cliente)?(?:\s*\/\s*Filial)?(?:\s*\/\s*Ramo)?\s*:?\s*/i, "").slice(0, 600);
  // corta no próximo rótulo (só em começo de linha ou depois de ponto; "solicitante" no meio de parêntese não é rótulo)
  bloco = bloco.split(new RegExp(`(?<=^|[\\n.]\\s{0,3}-?\\s{0,3})(?:Ramo(?: do cliente)?|Acesso|Descri[çc][aã]o|Data da Solicita|In[ií]cio do|Passos para|Vers[aã]o|Solicitante|Usu[aá]rio \\/ Cargo)\\b`, "i"))[0];

  const semCliente = /todos os clientes|n[aã]o se aplica a um cliente|todas as bases|n[aã]o vinculad[ao] a (?:nenhum |um )?cliente/i.test(bloco);
  if (semCliente) return { clienteNr: null, clienteNome: null, filial: null };

  const mF = bloco.match(/(?<=(?:^|[\n.])\s*-?\s*)Filia(?:l|is|ais)\s*:?\s*/i);
  const parteCliente = mF ? bloco.slice(0, mF.index) : bloco;
  const parteFilial = mF ? bloco.slice(mF.index + mF[0].length) : "";

  let clienteNr = (parteCliente.match(/(?:NR\s*Cliente|cliente|base)\s*[:#]?\s*(\d{1,3})\b/i) || [])[1] || null;
  if (!clienteNr) {
    const acesso = (t.match(/\n\s*Acesso\s*:?\s*([^\n]{0,200})/i) || [])[1] || "";
    clienteNr = (acesso.match(/\b(?:base|cliente)\s+(\d{1,3})\b/i) || [])[1] || null;
  }
  // modelo com o cabeçalho "Grupo de empresa / NR Cliente / Filial / Ramo" e uma linha rotulada por campo ("- Grupo de
  // empresa: X", "- Grupo / NR Cliente: X", "- **Grupo:** X", "Cliente originador: X"): o nome é o valor do rótulo
  // ("NR Cliente: 102 — EXEMPLO MOTOS" vale pelo nome; GERAL é o grupo padrão, não cliente)
  const rotulado = [...parteCliente.matchAll(/(?:^|\n)[\s*•-]*(?:Grupos?(?: d[ae] empresa)?(?:\s*\/\s*NR(?:\s*Cliente)?)?|NR\s*Cliente|Clientes?(?: originador| de origem)?)\**\s*:\**\s*([^\n]+)/gi)]
    .map((m) => m[1].trim().replace(/^\d{1,3}\s*[-–—]\s*/, "")).find((v) => v && !/^(?:\d{1,3}|CNPJ|GERAL)\b/i.test(v));
  let clienteNome = (rotulado ?? parteCliente.replace(/^[\s:\/*-]*(?:Cliente\s*:\s*)?/i, "")).split(/\s*(?:,|\(|—|–|\s-\s|\s+cliente\s+\d|\s*NR\s*Cliente|\.\s|\n)/)[0].replace(/[*\s]+$/, "").trim() || null;
  const nrNoNome = clienteNome?.match(/^(.+?)\s*\/\s*(\d{1,3})$/); // "Grupo Exemplo / 86"
  if (nrNoNome) { clienteNome = nrNoNome[1]; clienteNr ||= nrNoNome[2]; }
  // "Grupo 1 - GERAL / NR Cliente 66 - EXEMPLO ...": o primeiro pedaço é o código do grupo; o cliente vem depois do NR
  if (!clienteNome || /^Grupo(?: de empresa)?\s+\d+\b/i.test(clienteNome)) {
    const depoisDoNr = (parteCliente.match(/NR\s*Cliente\s*\d{1,3}\s*[-–—]\s*([^\n(,·]+)/i) || [])[1]?.trim();
    if (depoisDoNr && !/^(Grupo|CNPJ|\d|tod)/i.test(depoisDoNr)) clienteNome = depoisDoNr;
  }
  if (clienteNome && /^(Grupo de empresa|Filia|NR\s*Cliente|cliente)\b/i.test(clienteNome)) clienteNome = null;
  if (clienteNome && /^\d{1,3}$/.test(clienteNome)) { clienteNr ||= clienteNome; clienteNome = null; } // "NR Cliente: 071"

  let filial = null;
  if (parteFilial) {
    // número, traço e nome na mesma linha: o "série 10" no fim de uma linha não casa com o "- Loja B" da de baixo;
    // "CDEMPRESA 3 — CNPJ 05..." não é filial
    const varias = [...parteFilial.matchAll(/(\d{1,3})[ \t]*[-–—](?![ \t]*CNPJ\b)[ \t]*([^,;\n(]+?)\s*(\([^)]*\))?(?=\s*,|\s*;|\s+e\s+\d|\s*\.|\n|$)/g)];
    if (varias.length > 1) {
      const esc = varias.find((m) => /solicitante/i.test(m[3] || "")) || varias[0];
      filial = `${esc[1]} - ${esc[2].trim()}`;
    } else {
      // primeira linha, sem marcador de lista nem negrito ("- Todas" é Todas; card de vários clientes: a do primeiro)
      filial = parteFilial.split(/,\s*CNPJ|\.\s+[A-ZÀ-Ú]|\n/)[0].replace(/^[-–—•*\s]+/, "").replace(/\s*\(filial da solicitante\)/i, "").replace(/[.,;*\s]+$/, "").trim() || null;
      if (filial && filial.length > 80) filial = filial.slice(0, 80).replace(/[.,;*\s]+$/, "");
    }
  }
  return { clienteNr, clienteNome, filial };
}

// Acha a base do cliente no arquivo de conexões pelo nome (ou por alias/contexto do clientes.json).
export function acharBaseCliente(clienteNome, clienteNr, cfg, conexoes) {
  const candidatos = [];
  // "EXEMPLO VEICULOS / Exemplo": cada nome do cliente é um candidato
  if (clienteNome) candidatos.push(clienteNome, ...(clienteNome.includes("/") ? clienteNome.split(/\s*\/\s*/) : []));
  const c = clienteNr ? cfg.clientes?.[clienteNr] ?? cfg.clientes?.[String(Number(clienteNr))] : null; // "063" é o 63
  if (c) candidatos.push(c.nome, ...(c.aliases || []), ...(c.contexto ? [c.contexto] : []));
  for (const [nr, e] of Object.entries(cfg.clientes || {})) {
    if (nr.startsWith("_") || !clienteNome) continue;
    const nomes = [e.nome, ...(e.aliases || [])].map(norm).filter(Boolean);
    if (nomes.some((n) => n === norm(clienteNome) || norm(clienteNome).includes(n))) candidatos.push(e.contexto || e.nome);
  }
  for (const cand of candidatos) {
    const k = chave(cand); if (!k) continue;
    if (conexoes[k]) return conexoes[k];
    // "EXEMPLO MOTO SHOP LTDA" → exemplo; "Grupo Exemplo" → grupoexemplo
    const semSufixo = chave(cand.replace(/\b(ltda|s\.?a\.?|motos?|moto shop|comercio|veiculos|ltda\.?)\b/gi, ""));
    if (semSufixo && conexoes[semSufixo]) return conexoes[semSufixo];
    const primeira = chave(cand.split(/\s+/)[0]);
    const hit = Object.keys(conexoes).find((ctx) => ctx === k || ctx === semSufixo || (primeira.length >= 4 && ctx === primeira) || (k.length >= 5 && (ctx.startsWith(k) || k.startsWith(ctx))));
    if (hit) return conexoes[hit];
  }
  return null;
}

export function resolverAmbiente(texto, env = process.env) {
  const { clienteNr, clienteNome, filial } = extrairClienteFilial(texto);
  const cfg = lerClientes();
  const conexoes = lerConexoes();
  const front = env.QA_FRONT || cfg.padrao?.front || "";
  const banco = env.FB_DB || cfg.padrao?.banco || "";
  let empresa = cfg.padrao?.empresa || "";
  let ambiente = "padrao", bancoCliente = "";
  if (clienteNr || clienteNome) {
    const base = acharBaseCliente(clienteNome, clienteNr, cfg, conexoes);
    if (base) { ambiente = "cliente-com-base"; bancoCliente = base.banco; } else ambiente = "cliente-sem-base";
    // a filial do card vira o pedido da etapa "empresa" do login; o login cai no padrão se ela não existir na lista da stage
    if (filial && !/^(?:aplic[aá]vel (?:a|para) )?tod[ao]s?\b/i.test(filial)) empresa = filial; // "aplicável a todas" também
  }
  return { clienteNr, clienteNome, filial, ambiente, front, banco, bancoCliente, empresa };
}
