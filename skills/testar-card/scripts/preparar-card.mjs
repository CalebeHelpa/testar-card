#!/usr/bin/env node
// Prepara o teste de um card: lê o work item no Azure DevOps, acha branches/PRs nos repos,
// confere se o código está na branch stage e no último build publicado. Só REST (sem `az boards`).
//
// Uso:  node preparar-card.mjs <numero-do-card>
// Saída (stdout): bloco chave=valor, uma por linha. Diagnóstico no stderr.
// Exit 2 = pré-voo falhou (configuração ou credencial ausente). Exit 1 = card não encontrado.
//
// Variáveis (ver .env.exemplo):
//   ADO_ORG, ADO_PROJECT        obrigatórias (ex.: https://dev.azure.com/minha-org, MeuProjeto)
//   ADO_PAT                     PAT do Azure DevOps. Sem ele, usa `az account get-access-token`.
//   REPO_NOME_BACK, REPO_NOME_FRONT   nomes dos repositórios no ADO (obrigatórios); REPO_NOME_MVC, REPO_NOME_DELPHI opcionais
//   REPO_BACK / REPO_FRONT / REPO_MVC / REPO_DELPHI   caminho local de cada repo (padrão: REPOS_DIR/<nome>)
//   REPOS_DIR                   pasta dos repos (padrão ./repos); TESTES_DIR pasta de saída (padrão ./testes-card)
//   STAGE_BRANCH                stage
//   PIPELINE_BACK, PIPELINE_FRONT, PIPELINE_MVC   ids das pipelines que publicam a stage (opcionais)
//   CLONAR_REPOS                1 (padrão) = clona o repo que não existir (blobless)

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolverAmbiente } from "./ambiente.mjs";

const env = process.env;
const WIN = process.platform === "win32";
const CARD = process.argv[2];
if (!CARD || !/^\d+$/.test(CARD)) die(1, "uso: preparar-card.mjs <card>");

const ORG = env.ADO_ORG || die(2, "PRE-VOO FALHOU: defina ADO_ORG (ex.: https://dev.azure.com/minha-org)");
const PROJ = env.ADO_PROJECT || die(2, "PRE-VOO FALHOU: defina ADO_PROJECT");
const REPOS_DIR = env.REPOS_DIR || path.resolve("repos");
const REPOS = {
  back: { nome: env.REPO_NOME_BACK || die(2, "PRE-VOO FALHOU: defina REPO_NOME_BACK"), pipeline: Number(env.PIPELINE_BACK || 0), build: "back" },
  front: { nome: env.REPO_NOME_FRONT || die(2, "PRE-VOO FALHOU: defina REPO_NOME_FRONT"), pipeline: Number(env.PIPELINE_FRONT || 0), build: "front" },
  mvc: { nome: env.REPO_NOME_MVC || "", pipeline: Number(env.PIPELINE_MVC || 0), build: "mvc" },
  delphi: { nome: env.REPO_NOME_DELPHI || "", pipeline: 0, build: null },
};
for (const [k, r] of Object.entries(REPOS)) { r.dir = env[`REPO_${k.toUpperCase()}`] || (r.nome ? `${REPOS_DIR}/${r.nome}` : ""); r.guid = null; }
const OUTDIR = env.TESTES_DIR || path.resolve("testes-card");
const STAGE = env.STAGE_BRANCH || "stage";
const CLONAR = env.CLONAR_REPOS ? env.CLONAR_REPOS === "1" : true;
const PASTA = path.join(OUTDIR, CARD);

function die(code, msg) { process.stderr.write(msg + "\n"); process.exit(code); }
function msg(s) { process.stderr.write(s + "\n"); }
const LINHAS = []; // tudo que vai para o stdout também vai para <pasta>/preparo.txt (o reteste lê de lá)
function out(k, v) { const l = `${k}=${String(v ?? "").replace(/\r?\n/g, " ").trim()}`; LINHAS.push(l); process.stdout.write(l + "\n"); }

// --- Credencial -------------------------------------------------------------
let AUTH; // header Authorization
let GIT_AUTH; // valor para http.extraheader
if (env.ADO_PAT) {
  const b64 = Buffer.from(":" + env.ADO_PAT).toString("base64");
  AUTH = `Basic ${b64}`;
  GIT_AUTH = `AUTHORIZATION: basic ${b64}`;
} else {
  try {
    // 499b84ac-... é o id público do recurso Azure DevOps para tokens do Entra ID
    const tok = execFileSync("az", ["account", "get-access-token", "--resource", "499b84ac-1321-427f-aa17-267ca6975798", "--query", "accessToken", "-o", "tsv"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], shell: WIN }).trim();
    if (!tok) throw new Error("vazio");
    AUTH = `Bearer ${tok}`;
    GIT_AUTH = `AUTHORIZATION: bearer ${tok}`;
  } catch {
    die(2, "PRE-VOO FALHOU: sem ADO_PAT e `az` não está logado. Defina ADO_PAT ou rode: az login --allow-no-subscriptions");
  }
}

async function api(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { Authorization: AUTH, Accept: "application/json", ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return opts.raw ? r : r.json();
}

// --- Git --------------------------------------------------------------------
function git(dir, args, { ok = false } = {}) {
  const r = spawnSync("git", ["-C", dir, "-c", `http.extraheader=${GIT_AUTH}`, ...args], { encoding: "utf8" });
  if (ok) return r.status === 0;
  return r.status === 0 ? r.stdout.trim() : null;
}
function garantirRepo(r) {
  if (!r.nome) return false;
  if (git(r.dir, ["rev-parse", "--git-dir"], { ok: true })) return true;
  if (!CLONAR) { msg(`AVISO: ${r.dir} não é repo git (CLONAR_REPOS=0)`); return false; }
  msg(`Clonando ${r.nome} em ${r.dir} (blobless)...`);
  fs.mkdirSync(path.dirname(r.dir), { recursive: true });
  const res = spawnSync("git", ["-c", `http.extraheader=${GIT_AUTH}`, "clone", "--filter=blob:none", `${ORG}/${PROJ}/_git/${r.nome}`, r.dir], { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] });
  if (res.status !== 0) { msg(`AVISO: clone de ${r.nome} falhou: ${res.stderr.slice(0, 300)}`); return false; }
  return true;
}

// --- HTML -> texto -----------------------------------------------------------
function htmlParaTexto(html) {
  if (!html) return "";
  return html
    .replace(/<\s*(br|\/p|\/div|\/li|\/tr|\/h\d)\s*\/?>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// --- Principal --------------------------------------------------------------
(async () => {
  fs.mkdirSync(path.join(PASTA, "anexos"), { recursive: true });

  // ids dos repositórios no ADO (aparecem nos ArtifactLink do card), resolvidos pelo nome
  try {
    const repos = await api(`${ORG}/${PROJ}/_apis/git/repositories?api-version=7.1`);
    for (const r of Object.values(REPOS)) { const hit = (repos.value || []).find((x) => x.name.toLowerCase() === r.nome.toLowerCase()); if (hit) r.guid = hit.id.toLowerCase(); }
  } catch (e) { msg(`AVISO: não consegui listar repositórios: ${e.message}`); }

  for (const k of ["back", "front"]) if (garantirRepo(REPOS[k])) {
    if (!git(REPOS[k].dir, ["fetch", "origin", "--prune", "--quiet"], { ok: true })) msg(`AVISO: fetch falhou em ${REPOS[k].dir}`);
  }
  for (const k of ["mvc", "delphi"]) garantirRepo(REPOS[k]);

  const WIT = `${ORG}/${PROJ}/_apis/wit`;
  let wi;
  try { wi = await api(`${WIT}/workitems/${CARD}?api-version=7.1&$expand=relations`); }
  catch (e) { die(1, `Card ${CARD} não encontrado (${e.message})`); }
  fs.writeFileSync(path.join(PASTA, "card.json"), JSON.stringify(wi, null, 2));
  const f = wi.fields;
  let coment = { totalCount: 0, comments: [] };
  try { coment = await api(`${WIT}/workItems/${CARD}/comments?api-version=7.1-preview.4`); } catch (e) { msg(`AVISO: comentários: ${e.message}`); }
  fs.writeFileSync(path.join(PASTA, "comentarios.json"), JSON.stringify(coment, null, 2));

  const rels = wi.relations || [];
  const pai = rels.find((r) => r.rel === "System.LinkTypes.Hierarchy-Reverse");
  out("card", CARD);
  out("tipo", f["System.WorkItemType"]);
  out("titulo", f["System.Title"]);
  out("estado", f["System.State"]);
  out("coluna", f["System.BoardColumn"]);
  out("responsavel", f["System.AssignedTo"]?.displayName);
  out("pai", pai ? pai.url.split("/").pop() : "");
  out("card_json", path.join(PASTA, "card.json"));
  out("comentarios_json", `${path.join(PASTA, "comentarios.json")}  (total: ${coment.totalCount ?? coment.comments?.length ?? 0})`);

  // card.md: descrição, critério e repro em texto, mais comentários
  const ca = f["Microsoft.VSTS.Common.AcceptanceCriteria"];
  const md = [
    `# ${CARD} — ${f["System.Title"]}`, "",
    `Tipo: ${f["System.WorkItemType"]} · Estado: ${f["System.State"]} · Coluna: ${f["System.BoardColumn"] ?? ""} · Responsável: ${f["System.AssignedTo"]?.displayName ?? ""}`, "",
    "## Descrição", "", htmlParaTexto(f["System.Description"]) || "(vazia)", "",
    "## Critério de aceite", "", ca ? htmlParaTexto(ca) : "AUSENTE", "",
    ...(f["Microsoft.VSTS.TCM.ReproSteps"] ? ["## Passos para reproduzir", "", htmlParaTexto(f["Microsoft.VSTS.TCM.ReproSteps"]), ""] : []),
    "## Comentários", "",
    ...((coment.comments || []).map((c) => `- **${c.createdBy?.displayName ?? "?"}** (${(c.createdDate || "").slice(0, 10)}): ${htmlParaTexto(c.text).replace(/\n/g, " ")}`)),
  ].join("\n");
  fs.writeFileSync(path.join(PASTA, "card.md"), md);
  out("card_md", path.join(PASTA, "card.md"));

  // --- Cliente, filial e ambiente de stage (template dos cards) ---
  const amb = resolverAmbiente(md);
  out("cliente_nr", amb.clienteNr ?? "NENHUM");
  out("cliente_nome", amb.clienteNome ?? "");
  out("filial", amb.filial ?? "");
  out("qa_ambiente", amb.ambiente);
  out("qa_front", amb.front);
  out("qa_banco", amb.banco);
  out("qa_banco_cliente", amb.bancoCliente || "NENHUM");
  out("qa_empresa", amb.empresa);

  // anexos
  let nAnexos = 0;
  for (const r of rels.filter((r) => r.rel === "AttachedFile")) {
    const nome = r.attributes?.name || `anexo-${nAnexos}`;
    try {
      const resp = await api(`${r.url}?api-version=7.1&download=true`, { raw: true, headers: { Accept: "*/*" } });
      const buf = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(path.join(PASTA, "anexos", nome), buf);
      // artefatos do próprio bot (relatório anterior, teste de reprodução, vídeo, trace) não são anexo do card
      if (/^relatorio-\d+-.*\.md$|\.repro\.mjs$|\.webm$|^trace.*\.zip$/i.test(nome)) { out("anexo_qa", `${path.join(PASTA, "anexos", nome)} (${buf.length} bytes)`); continue; }
      out("anexo", `${path.join(PASTA, "anexos", nome)} (${buf.length} bytes)`);
      nAnexos++;
    } catch (e) { out("anexo", `FALHOU ${nome} (${e.message})`); }
  }
  if (!nAnexos) out("anexo", "NENHUM");
  out("criterio_aceite", ca && htmlParaTexto(ca) ? "presente" : "AUSENTE");

  // branches e PRs
  const links = rels.filter((r) => r.rel === "ArtifactLink");
  const repoDe = (url) => { const u = url.toLowerCase(); for (const [k, r] of Object.entries(REPOS)) if (r.guid && u.includes(r.guid)) return k; return "outro"; };
  const branches = [];
  for (const l of links.filter((l) => /^Branch/i.test(l.attributes?.name || ""))) {
    const ref = decodeURIComponent(l.url).replace(/.*\/GB/, "");
    const repo = repoDe(l.url);
    branches.push({ repo, ref });
    out(`branch_${repo}`, ref);
  }
  for (const l of links.filter((l) => /^Pull Request/i.test(l.attributes?.name || ""))) {
    const id = decodeURIComponent(l.url).split("/").pop();
    const repo = repoDe(l.url);
    try {
      const pr = await api(`${ORG}/${PROJ}/_apis/git/pullrequests/${id}?api-version=7.1`);
      out(`pr_${repo}`, `${id} ${pr.status} ${pr.sourceRefName} ${pr.targetRefName} ${pr.lastMergeSourceCommit?.commitId ?? ""} ${pr.lastMergeTargetCommit?.commitId ?? ""}`);
    } catch (e) { out(`pr_${repo}`, `${id} (erro: ${e.message})`); }
  }

  // está na stage?
  for (const b of branches) {
    const r = REPOS[b.repo]; if (!r || !r.dir) continue;
    const sha = git(r.dir, ["rev-parse", `origin/${b.ref}`]);
    if (!sha) { out(`na_stage_${b.repo}`, "branch não existe na origin"); continue; }
    out(`sha_${b.repo}`, sha);
    out(`repo_dir_${b.repo}`, r.dir);
    const ok = git(r.dir, ["merge-base", "--is-ancestor", sha, `origin/${STAGE}`], { ok: true });
    out(`na_stage_${b.repo}`, ok ? `SIM (${sha.slice(0, 8)})` : `NAO (${sha.slice(0, 8)} não está em origin/${STAGE})`);
  }

  // último build de cada pipeline da stage (quando configurada)
  const ultimo = {};
  for (const k of ["back", "front", "mvc"]) {
    const r = REPOS[k]; if (!r.pipeline) continue;
    try {
      const j = await api(`${ORG}/${PROJ}/_apis/build/builds?definitions=${r.pipeline}&$top=1&queryOrder=finishTimeDescending&api-version=7.1`);
      const b = j.value?.[0];
      if (b) { ultimo[k] = b.sourceVersion; out(`build_${r.build}`, `${b.sourceVersion} ${b.result} ${b.finishTime} (${b.sourceBranch})`); }
      else out(`build_${r.build}`, "sem build");
    } catch (e) { out(`build_${r.build}`, `erro: ${e.message}`); }
  }
  for (const b of branches) {
    const r = REPOS[b.repo]; if (!r || !r.dir) continue;
    const sha = git(r.dir, ["rev-parse", `origin/${b.ref}`]); if (!sha) continue;
    if (!ultimo[b.repo]) {
      // sem pipeline configurada: "publicado" = está na branch stage
      const ok = git(r.dir, ["merge-base", "--is-ancestor", sha, `origin/${STAGE}`], { ok: true });
      out(`publicado_${b.repo}`, ok ? "SIM (pela branch stage; PIPELINE_* não configurada)" : `NAO (não está em origin/${STAGE})`);
      continue;
    }
    if (!git(r.dir, ["cat-file", "-e", ultimo[b.repo]], { ok: true })) git(r.dir, ["fetch", "origin", ultimo[b.repo], "--quiet"], { ok: true });
    const ok = git(r.dir, ["merge-base", "--is-ancestor", sha, ultimo[b.repo]], { ok: true });
    out(`publicado_${b.repo}`, ok ? "SIM" : `NAO (build ${r.build} não contém a branch)`);
  }
  if (!branches.length) out("publicado", "SEM BRANCH VINCULADA (não dá para conferir a stage)");

  out("pasta", PASTA);
  fs.writeFileSync(path.join(PASTA, "preparo.txt"), LINHAS.join("\n") + "\n");
  msg(`OK. Arquivos em ${PASTA}`);
})().catch((e) => die(1, `ERRO: ${e.stack || e}`));
