# testar-card

Plugin para Claude Code e Claude Agent SDK que **testa um card na stage** e devolve um relatório com veredito
(`APROVADO`, `REPROVADO`, `BLOQUEADO`), achados com evidência tripla (tela, rede, banco), proposta de correção e
rascunho de bug. Funciona em sessão interativa (Claude Code na máquina do dev) e em modo autônomo (Agent SDK num
container, disparado quando o card entra numa coluna do board).

Foi escrito para um sistema com front Angular, API .NET, legado Delphi e banco Firebird, com cards no Azure DevOps.
As partes específicas desse contexto estão isoladas em variáveis de ambiente e nas referências da skill; para outro
sistema, troque os seletores de login, os nomes dos repositórios e, se não houver Delphi, ignore a paridade.

```
.claude-plugin/plugin.json        manifesto
.mcp.json                         servidor MCP do Playwright (navegador), via scripts/mcp-playwright.mjs
agents/revisor-achados.md         subagente com contexto zerado que revisa os achados antes de publicar
skills/testar-card/SKILL.md       o procedimento (6 passos)
skills/testar-card/references/    heurísticas de exploração, paridade com o Delphi (.dfm), modelo do relatório
skills/testar-card/scripts/       preparar-card · login-stage · consultar-banco · publicar-resultado · ambiente · mcp-playwright
skills/testar-card/assets/upload  arquivos para teste de upload
exemplo-sdk/run.mjs               orquestração de referência com o Agent SDK (preparar → login → agente → publicar)
.env.exemplo                      todas as variáveis, com valores fictícios
```

## Instalação

```bash
npm install            # traz @playwright/mcp (fixado) e o Agent SDK; o postinstall instala o Chromium certo
cp .env.exemplo .env   # preencha
```

Linux: `node skills/testar-card/scripts/instalar-navegador.mjs --with-deps` instala as libs do sistema. Firebird:
pacote `firebird3.0-utils` (isql-fb). Também precisa de git e Node 22+.

Claude Code: `claude --plugin-dir .` e, na sessão, `/testar-card:testar-card <card>`.
Agent SDK: `node exemplo-sdk/run.mjs <card>` (exit 0 aprovado, 10 reprovado, 20 bloqueado).

## Como uma rodada funciona (modo autônomo)

1. **Preparar.** `preparar-card.mjs <card>` lê o card por REST e imprime `chave=valor`: título, estado, anexos (baixados),
   branches e PRs, se a branch está em `origin/stage` e se o último build da stage a contém (`publicado_*`). Também lê o
   template do card ("Grupo de empresa / NR Cliente", "Filial") e resolve o ambiente (`qa_*`).
2. **Login (fixture).** `login-stage.mjs` abre a stage com o usuário de teste, escolhe a empresa na 2ª etapa (se houver)
   e salva a sessão em `QA_STORAGE_STATE`. O agente nasce logado e nunca vê a senha.
3. **Agente.** O Agent SDK sobe com o plugin, o Playwright MCP com a sessão salva e o prompt
   `/testar-card:testar-card <card>`. A skill monta o mapa de fluxo do código, executa roteiro e exploração no
   navegador com evidência de banco, compara protótipo e paridade Delphi, escreve o relatório e chama o revisor.
4. **Publicação.** `publicar-resultado.mjs <card> <relatorio.md>` anexa o `.md`, comenta o resumo e move o card.
   Só escreve com `QA_ESCREVE_ADO=1`; sem isso, imprime o que faria.

O orquestrador lê o veredito no cabeçalho YAML do relatório (`veredito:`), não no texto do agente.

## Regras que valem a pena conhecer

- **Três vereditos.** BLOQUEADO (build sem a branch, sem critério de aceite, login ou ferramenta impediu o teste) é
  diferente de REPROVADO. Um falso REPROVADO custa mais que um bug escapado.
- **Só SELECT no banco.** `consultar-banco.sh` recusa qualquer outra coisa. Quem grava é a tela.
- **Nada é escrito no Azure DevOps** fora do `publicar-resultado.mjs`, e esse só com `QA_ESCREVE_ADO=1`.
- **Ninguém digita senha.** O login é fixture; tela de login no meio do teste é artefato, não defeito.
- **`browser_run_code_unsafe` fica em `disallowedTools`.** Executa código arbitrário no processo do Playwright.

## O defeito vira teste, e o reteste fica barato

Cada achado que fica como **defeito** depois da revisão sai com um **teste de reprodução**
(`repro/<card>-F1.repro.mjs`): um script Playwright curto que afirma o comportamento **correto** e por isso falha
hoje. Ele vai anexado ao card com o **vídeo da falha**.

- **Para o dev:** é o critério de pronto. `node skills/testar-card/scripts/rodar-repro.mjs 1234-F1.repro.mjs --login`
  roda na máquina dele (faz o login sozinho) e diz VERMELHO ou VERDE.
- **Para o reteste:** quando o card volta para a coluna, o `reteste.mjs` acha o relatório anterior (na pasta ou nos
  anexos do card) e compara a versão testada com a atual. O modo sai daí:

| Situação quando o card volta | Modo | Custo |
|---|---|---|
| Nenhum commit novo e os testes de reprodução continuam VERMELHO 2/2 | `so-repro`: reprova de novo com os vídeos, **sem agente** | ~4 min, sem tokens |
| Commit novo, ou defeito ainda sem teste | `reteste`: agente só nos defeitos anteriores e nos itens que tocam os arquivos mudados | caso medido: 6 min contra 55 min da rodada completa |
| Primeira vez, ou voltou depois de APROVADO/BLOQUEADO | `completo` | rodada inteira |

Resultados do `rodar-repro.mjs`: **VERMELHO** (falhou na asserção do comportamento correto, nas 2 execuções) ·
**VERDE** · **INSTAVEL** (vermelho uma vez só) · **QUEBRADO** (não chegou à asserção: seletor ou tela mudaram) ·
**INFRA** (sessão expirada, stage fora). Só VERMELHO 2/2 reprova sem agente; qualquer outro chama o agente para
conferir. Contrato do teste em `skills/testar-card/references/repro.md`; procedimento do reteste em
`references/reteste.md`.

Antes de subir o agente, o orquestrador também decide sozinho os bloqueios óbvios (build da stage sem a branch, card
sem branch, critério de aceite ausente com `QA_EXIGE_CRITERIO=1`) e carimba no cabeçalho do relatório
`testado_back`/`testado_front`, `execucao`, `custo_usd`, `duracao_min` e `turnos`.

## Integração com o Agent SDK (TypeScript)

```js
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const m of query({
  prompt: `/testar-card:testar-card ${card}`,
  options: {
    cwd: pastaDoCard,
    plugins: [{ type: "local", path: PLUGIN_DIR }],
    env: { ...process.env, QA_AUTONOMO: "1", QA_STORAGE_STATE, QA_OUT_DIR },   // sem QA_PASS
    settingSources: [],
    allowedTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "Skill", "Agent",
                   "mcp__plugin_testar-card_playwright__*"],
    disallowedTools: ["mcp__plugin_testar-card_playwright__browser_run_code_unsafe"],
    maxTurns: 400,
  },
})) {
  if (m.type === "system" && m.subtype === "init") console.log(m.plugins, m.mcp_servers);
  if (m.type === "result") console.log(m.subtype);
}
```

O servidor MCP aparece como `plugin:testar-card:playwright`. Uma rodada típica num card de cadastro com seis abas
levou 55 minutos, cerca de 500 ações de navegador e 47 itens de roteiro.

## Ambiente: uma stage, base do cliente como referência

A stage grava num banco só (`FB_DB`), e a lista de empresas do login é a tabela de empresas desse banco. A filial
citada no card é pedida na etapa de empresa; se não existir, o login usa a padrão e avisa. A base do cliente citado no
card (achada pelo nome num arquivo de conexões, `QA_CONEXOES`) vai para o agente como `QA_BANCO_CLIENTE`, só para
consultas de referência. Veja `skills/testar-card/clientes.json`.

## Variáveis

Todas estão em `.env.exemplo`, com comentários. As obrigatórias: `ADO_ORG`, `ADO_PROJECT`, `ADO_PAT` (ou `az login`),
`REPO_NOME_BACK`, `REPO_NOME_FRONT`, `QA_FRONT`, `QA_USER`, `QA_PASS`, `FB_DB`, `FB_PASS`, e no modo autônomo
`QA_AUTONOMO=1`, `QA_STORAGE_STATE`, `QA_OUT_DIR`.

## Fora do escopo (ideias para depois)

Execução do Delphi (espelho de UI), conhecimento acumulado por tela, jornadas de usuário ponta a ponta,
autoaprimoramento a partir de bugs escapados, parte estática rodando na abertura do PR, teste direto na base do
cliente (quando o login da stage permite escolher a base).

## Licença

MIT.
