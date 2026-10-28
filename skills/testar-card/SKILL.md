---
name: testar-card
description: Use quando o usuário (testador, dev ou um orquestrador automático) quiser testar um card de um sistema web na stage pelo navegador, com evidência de tela, rede e banco. Só leitura no banco; escrita no Azure DevOps apenas pelo script de publicação e só com QA_ESCREVE_ADO=1.
arguments: [card, front, banco]
argument-hint: "<número do card> [url-do-front] [banco]"
---

# Testar um card na stage

Entrada: `/testar-card $card`. Opcionais: `$front` (URL do front; padrão `QA_FRONT` ou a stage) e `$banco`
(`host:caminho.fdb`, quando o card manda testar fora do padrão; vira `FB_DB`).

Saída: `relatorio-<card>-<data>.md` na pasta do card, com cabeçalho YAML legível por máquina (`veredito: APROVADO |
REPROVADO | BLOQUEADO`), resultado por item, achados com evidência tripla (tela, rede, banco), classificação, proposta
de correção e rascunho de TaskBug. Formato em `references/relatorio-modelo.md`.

Os scripts ficam em `${CLAUDE_PLUGIN_ROOT}/skills/testar-card/scripts/`. Abaixo, `$S` é essa pasta.

## Ambiente e modo

| Variável | Para quê | Padrão |
|---|---|---|
| `QA_AUTONOMO` | `1` = ninguém vai responder: não pergunte, registre e siga | vazio (interativo) |
| `QA_FRONT` | URL do front | obrigatório (URL do front) |
| `QA_STORAGE_STATE` | sessão salva pelo `login-stage.mjs` (o Playwright MCP sobe com ela) | obrigatório |
| `QA_OUT_DIR` | pasta dos screenshots (é o `--output-dir` do Playwright MCP) | obrigatório |
| `TESTES_DIR` | pasta raiz dos relatórios (`<TESTES_DIR>/<card>/`) | `./testes-card` |
| `REPOS_DIR` | onde estão os repos (`REPO_NOME_BACK`, `REPO_NOME_FRONT`, `REPO_NOME_MVC`, `REPO_NOME_DELPHI`) | `./repos` |
| `ADO_PAT` | PAT do bot no Azure DevOps; sem ele, usa o `az` logado | — |
| `FB_DB`, `FB_USER`, `FB_PASS`, `ISQL` | banco da stage para o `consultar-banco.sh` | obrigatórios |
| `QA_EXIGE_CRITERIO` | `1` = card sem critério de aceite é BLOQUEADO | `1` |
| `QA_ESCREVE_ADO` | `1` = `publicar-resultado.mjs` escreve no card; senão dry-run | vazio |
| `QA_ANEXAR_VIDEO` | `1` = o vídeo de cada teste vermelho também vai para o card | vazio (fica na pasta de resultados) |
| `QA_MODO` | `completo` \| `reteste` (o card voltou; ver `references/reteste.md`). O orquestrador decide com `reteste.mjs` | `completo` |
| `QA_RELATORIO_ANTERIOR`, `QA_REPRO_RESULTADOS` | no reteste: relatório anterior e resultado dos testes de reprodução já rodados | — |

**Modo interativo** (sem `QA_AUTONOMO`): há um humano na sessão; mostre o roteiro antes de executar e pergunte antes
de publicar. **Modo autônomo** (`QA_AUTONOMO=1`): nenhuma pergunta; tudo que você perguntaria vira seção do relatório.

Pré-condições (pare e devolva **BLOQUEADO** com o motivo se faltar):

- Servidor MCP `playwright` na sessão (ferramentas `browser_*`). Sem ele não há teste.
- Sessão logada: a primeira `browser_navigate` para `QA_FRONT` **não** pode cair na tela de login
  (URL que casa com `QA_LOGIN_URL_PATTERN`). Se cair, o `login-stage.mjs` não rodou ou a sessão expirou: você **não digita senha**.
- Credencial do ADO (`ADO_PAT` ou `az login`); o script de preparo avisa.
- Repos clonados em `REPOS_DIR` (o preparo clona sozinho se faltar).

## Passo 1 — Preparar

```bash
node $S/preparar-card.mjs $card
```

Devolve `chave=valor`: título, estado, coluna, pai, `card_md` (descrição, critério, repro e comentários em texto),
`card_json`, `comentarios_json`, `anexo=...` (baixados para `<pasta>/anexos/`), `anexo_qa=...` (relatório, teste de
reprodução e vídeo que o próprio bot anexou antes: **não** são protótipo), branches e PRs, `sha_*` (versão da branch),
`na_stage_*` (a branch está em `origin/stage`?), `build_*` e `publicado_*` (o último build da stage contém a branch?),
e o **ambiente do teste** lido do template do card ("Grupo de empresa / NR Cliente", "Filial", "Acesso"):
`cliente_nr`, `cliente_nome`, `filial`, `qa_ambiente` (`padrao` | `cliente-com-base` | `cliente-sem-base`),
`qa_front`, `qa_banco`, `qa_banco_cliente`, `qa_empresa`. Tudo fica também em `<pasta>/preparo.txt`.

**Ambiente.** A stage é uma só (`qa_front`) e grava num banco só (`qa_banco`): a evidência de banco dos itens
vem **sempre** de `FB_DB=<qa_banco>`. A lista de empresas do login da stage é a tabela de empresas desse banco; `qa_empresa` é a
filial pedida pelo card, e o login usa a padrão quando ela não existe nessa lista (`QA_EMPRESA_NAO_ENCONTRADA` no
ambiente diz qual foi pedida; `QA_EMPRESA_LOGADA` diz em qual você está). Card com cliente indicado ganha também
`qa_banco_cliente` (`QA_BANCO_CLIENTE`): a base daquele cliente, **só para consulta de referência** (como a tela, a
configuração ou o dado do cliente estão), nunca como evidência do que a stage gravou. Registre no cabeçalho do
relatório a empresa logada, o banco de evidência e o banco de referência (ou `cliente-sem-base`), e no "Não coberto"
que o teste não rodou na base do cliente.

Regras duras:

- **`publicado_back=NAO` ou `publicado_front=NAO` → BLOQUEADO**, `motivo_bloqueio: build do <lado> não contém a
  branch`. Testar build sem o fix gera reprovação falsa (caso real: a stage rotacionou e perdeu o merge).
  `publicado=SEM BRANCH VINCULADA` também bloqueia: não dá para afirmar o que está na stage.
- **`criterio_aceite=AUSENTE`** com `QA_EXIGE_CRITERIO=1` → BLOQUEADO, `motivo_bloqueio: sem critério de aceite`.
  Com `QA_EXIGE_CRITERIO=0`, siga com a descrição e o diff como oráculo e diga no relatório que a confiança é menor.
- Leia `card.md` inteiro (é texto; não precisa do JSON). Procure **banco indicado** ("testar na base X"): sem
  indicação, o banco é o da stage (`FB_DB`). Nenhuma base de teste manda para produção; boleto, e-mail e NF-e vão para
  homologação.
- **Especificação fora do card**: link `claude.ai/artifact/...` ou documento na descrição. Em modo interativo, leia
  com a ferramenta `Artifact` (action `read`) e trate como critério de aceite. Em modo autônomo, sem a ferramenta,
  registre no relatório "especificação externa não lida: <link>" e siga com o que o card diz.
- **Anexos**: protótipo (`.html`, `.png`, `.jpg`, `.pdf`, link do Figma na descrição) é **oráculo de layout** e entra
  no roteiro como item obrigatório (Passo 4b). `anexo=NENHUM` e descrição sem "protótipo"/"Figma" → registre "sem
  protótipo; layout não comparado". Caso real: um card tinha protótipo `.html` anexo e a primeira rodada validou só
  estrutura, não layout; a comparação veio depois, a pedido.

**Card que voltou.** Se o bot já testou este card (há `anexo_qa=relatorio-...` ou relatório na pasta), o teste não
recomeça do zero: `QA_MODO=reteste` (autônomo) ou `node $S/reteste.mjs $card` dizendo `modo=reteste` (interativo; mostre
a sugestão ao testador) → siga `references/reteste.md` **no lugar dos Passos 2 a 4**, e volte ao Passo 5.

## Passo 2 — Mapa de fluxo (gerado na hora, do código)

Objetivo: saber o que a tela faz **antes** de clicar. Faça no diff do PR e no código, não na tela.

1. **Diff do PR**: `git -C <repo> diff <tgtCommit>...<srcCommit>` em cada repo (commits vêm de `pr_back`/`pr_front`;
   se faltar local, `git fetch origin <sha>`). Liste arquivos tocados.
2. **Rota → componente**: no repo do front, grep do componente nos `*-routing.module.ts`; anote rota e guard. Anote o
   identificador de tela que controla a permissão (no sistema de referência, `Tela.CodigoInterno` do enum `Telas`).
3. **Formulário**: campos, validadores e `formControlName` do componente. É o roteiro de limites.
4. **Serviço → endpoint**: métodos do `*.service.ts` que o componente chama e o `Controller` da API que responde
   (projeto da API no repo do back). Anote método e rota.
5. **Tabelas**: entidade/repositório que o endpoint grava. É o que você consulta no banco.
6. **Vizinhança**: `grep -rl` de cada serviço, componente e endpoint do diff. Outras telas que usam o mesmo código
   entram no roteiro (heurística 18).
7. **Regra fora do código web entra no mapa.** Se a regra mora no Delphi, numa stored procedure ou num trigger, abra o
   `.pas`/`.dfm` em `REPOS_DIR/<repo Delphi>/<DELPHI_SOURCE_DIR>/<Tela>/` (cp1252: `iconv -f cp1252 -t utf-8`; busque sem
   acento; leia a procedure inteira, nunca um resumo; anote `git rev-parse --short HEAD`) ou o fonte da SP
   (`RDB$PROCEDURES`, via `consultar-banco.sh`) e anote `arquivo:linha` / nome da SP. "Limite do mapa" não é
   resposta: mecanismo que você não achou é item de investigação antes do roteiro.
8. **Ciclo de vida da entidade.** Desenhe os estados (tabela, coluna, valores) e quem faz cada transição (tela, SP,
   trigger, job). O roteiro ganha **um item por transição**, e o **mesmo registro** criado no primeiro item percorre
   todos os outros. Não use registro antigo já no estado do meio como atalho.
9. **Card que replica tela ou regra do Delphi** ("como o Delphi", "igual à tela antiga", migração): o roteiro ganha
   uma **parte C (paridade)** feita pelo código, conforme `references/paridade-dfm.md`. Cada regra do `.pas`/SP vira um
   item testado na web; cada campo do `.dfm` entra na tabela de paridade.

Escreva o mapa no início do relatório, em 10 a 20 linhas, mais o diagrama de estados.

## Passo 3 — Roteiro

Monte o roteiro numerado em até três partes:

- **A. Critério de aceite**: um item por critério do card (ou por afirmação da descrição, se o critério estiver ausente
  e `QA_EXIGE_CRITERIO=0`).
- **B. Exploração**: itens de `references/heuristicas.md` que se aplicam à tela, mais a vizinhança.
- **C. Paridade Delphi** (quando o Passo 2.9 se aplica): regras do Delphi a verificar na web.

Modo interativo: mostre o roteiro e pergunte se falta algo; é onde o conhecimento do testador entra. Modo autônomo:
grave o roteiro na seção "Roteiro executado" do relatório, com a nota "não revisado por humano", e siga.

## Passo 4 — Executar com o Playwright

Ferramentas do servidor Playwright deste plugin (prefixo `mcp__plugin_testar-card_playwright__`; nomes da versão
0.0.83, confira a lista da sessão): `browser_navigate`, `browser_find`, `browser_snapshot`, `browser_click`,
`browser_type`, `browser_fill_form`, `browser_select_option`, `browser_press_key`, `browser_hover`,
`browser_take_screenshot`, `browser_evaluate`, `browser_network_requests`, `browser_network_request`,
`browser_console_messages`, `browser_file_upload`, `browser_wait_for`, `browser_handle_dialog`, `browser_navigate_back`,
`browser_resize`, `browser_tabs`. **Nunca use `browser_run_code_unsafe`** (executa código no servidor).

Regras, com os limites medidos numa stage real por trás de cada uma:

- **Rotas sem `#`**: `QA_FRONT` + `cadastros/veiculo/...`. Com `#` a stage de referência caía na Home.
- **Para achar um elemento, `browser_find` (texto ou regex), não `browser_snapshot`.** A Home do sistema de referência tem centenas
  de itens de menu e grids ocultas: a árvore inteira passa de 500 mil tokens. `browser_find` devolve só os nós que
  casam, com o `ref`. Use `browser_snapshot` apenas com `target` (um elemento) ou `depth` pequeno, e nunca na Home
  nem com o menu aberto. Respostas de clique e digitação trazem um snapshot junto; se vier grande e for salvo em
  arquivo, não leia o arquivo: faça `browser_find` do que você precisa. Se a tela continuar grande, recolha o menu
  lateral por `browser_evaluate` antes.
- **Screenshot é o olho principal.** `browser_take_screenshot` com `filename` `<card>-<NN>-<slug>.png` a cada item
  (vai para `QA_OUT_DIR`). Snapshot e find são para obter `ref`s, não para "ver".
- **Ação é clique real** (`browser_click` com `ref`). `el.click()` por `browser_evaluate` **não** dispara alguns
  componentes do Angular (um componente de switch customizado ignorou). JS só como fallback, e registre que foi JS.
- **Estado do form** pelo DOM, via `browser_evaluate` (`value`, classe `ng-invalid`, texto do erro) ou pelo
  screenshot. `window.ng.getComponent` não existe em build de produção/stage.
- **Rede**: `browser_network_requests` ao fim de cada item. Registre método, rota, status. Chamada ao `/api` com
  4xx/5xx é achado mesmo com a tela dizendo sucesso. Para o corpo da resposta, `browser_network_request` com o índice
  (`part: "response-body"`): é a evidência de rede completa, sem precisar de `fetch` com o token da página.
- **Console**: `browser_console_messages` ao fim de cada item (heurística 21).
- **Banco**: após cada gravação, `bash $S/consultar-banco.sh "SELECT ..."` (só SELECT; `FB_DB=$banco` para outro
  banco). Compare com o que a tela mostrou. Aqui o mesmo processo tem navegador e banco: evidência por item, não por
  rodada.
- **Upload**: `browser_file_upload` com `${CLAUDE_PLUGIN_ROOT}/skills/testar-card/assets/upload/` (`teste.png`,
  `vazio.png`, `tipo-errado.txt`).
- **Tela de login no meio do fluxo**: pare o item, marque-o `ARTEFATO: sessão expirou`, tente **uma** vez renavegar
  para a rota. Se continuar na tela de login, o restante é NÃO COBERTO e o veredito é BLOQUEADO. Nunca digite senha.
- **Fora do alcance**: impressão, PDF em janela nova. Marque "NÃO COBERTO" com o motivo e siga.

Para cada item: executar, screenshot, rede, banco, veredito. Um item por vez. Não adivinhe o resultado de um item
pelo anterior. Registro criado no teste leva `TESTE <card>` no nome ou descrição, para a QA achar e limpar depois.

## Passo 4b — Layout contra o protótipo (quando houver anexo)

1. Sirva a pasta de anexos: `npx --yes http-server <pasta>/anexos -p 8139 -s` em background e navegue para
   `http://localhost:8139/<arquivo>.html` (imagem e PDF pelo mesmo servidor).
2. **Capture o protótipo inteiro**: listagem, form do topo ao rodapé, cada aba/modal. Extraia por `browser_evaluate`
   os textos: breadcrumb, título, rótulos de filtro, cabeçalhos de grid, abas, seções, rótulos com `*`, botões.
3. **Capture a stage nas mesmas telas e na mesma largura** (viewport 1280; anote `innerWidth`). Extraia os mesmos
   textos.
4. **Compare em tabela** (Elemento · Protótipo · Stage · Veredito) por tela. Cores, fontes e espaçamento: só o que
   salta aos olhos em 1280 px; não é pixel a pixel, e diga isso.
5. **Classifique cada divergência**: `prototipo` (deste card) · `fora-do-escopo` (campo de outra história) · do
   componente genérico · decisão já registrada que o protótipo não acompanhou (cite onde). Divergência sem dono vira
   pergunta para a PO, não defeito.
6. Screenshots `proto-NN-*.png` e `stage-NN-*.png` em `screenshots/layout/`. Mate o `http-server` ao terminar.

## Passo 4c — Paridade Delphi (estática)

Quando o Passo 2.9 se aplica, siga `references/paridade-dfm.md`: tabelas de campos, abas, colunas e botões (Delphi ×
web) a partir do `.dfm` e do template Angular, e regras do `.pas`/SP como itens C do roteiro. Registre o SHA do
o repo Delphi. A **execução** do Delphi não faz parte deste modo: escreva "execução do Delphi: NÃO COBERTA" e
`paridade_delphi: feita` no cabeçalho (ou `nao-se-aplica`).

## Passo 5 — Relatório e revisão

1. Escreva `<pasta>/relatorio-<card>-<data>.md` no formato de `references/relatorio-modelo.md`, com todos os achados
   classificados (`defeito`, `duvida`, `prototipo`, `fora-do-escopo`), cada um com esperado **com fonte**, obtido com
   evidência tripla, hipótese de causa com `arquivo:linha` e **proposta de correção**.
2. Chame o subagente **`revisor-achados`** deste plugin (ferramenta `Agent`), passando o caminho do relatório. Ele
   devolve uma tabela com MANTIDO / REBAIXADO / DERRUBADO / ARTEFATO por achado. Cole a tabela na seção "Revisão dos
   achados" e aplique: derrubado vai para "Descartados na revisão"; rebaixado muda de classificação; artefato vira
   NÃO COBERTO com motivo.
3. **Teste de reprodução** para cada `defeito` mantido: escreva `<pasta>/repro/<card>-F<n>.repro.mjs` e rode com
   `node $S/rodar-repro.mjs <arquivo> --saida <pasta>/repro-resultados` até dar **VERMELHO pelo motivo certo**, conforme
   `references/repro.md` (no máximo duas correções). Registre a linha **Teste de reprodução** no achado. É o que o dev
   usa para saber que corrigiu, e o que deixa o próximo reteste rodar sem agente.
4. Recalcule o cabeçalho (contadores e `veredito`): BLOQUEADO (build sem a branch, sem critério, ferramenta impediu a
   maioria dos itens) · REPROVADO (ao menos um `defeito` mantido) · APROVADO (nenhum defeito; dúvidas e divergências
   de protótipo não bloqueiam, vão para o comentário e para "Perguntas para a PO").
5. Termine **no chat** com os blocos do `## Resumo`: **Falhou**, **Layout**, **Dúvidas**, **Não coberto**, **Passou**,
   e diga onde o relatório ficou.

## Passo 6 — Publicar no card

```bash
node $S/publicar-resultado.mjs $card <pasta>/relatorio-<card>-<data>.md <pasta>/repro/*.repro.mjs
```

Anexe junto os testes de reprodução: no próximo reteste o preparo baixa esses anexos de volta, mesmo num container
novo. O vídeo de cada VERMELHO (`repro-resultados/<nome>/2/video.webm`) só vai para o card com `QA_ANEXAR_VIDEO=1`.
No modo autônomo o orquestrador anexa.

Anexa o `.md` ao card, comenta o `## Resumo` e move o card (`QA_ESTADO_APROVADO` / `QA_ESTADO_REPROVADO` /
`QA_ESTADO_BLOQUEADO`, ou coluna Kanban por `QA_BOARD_ID` + `QA_COLUNA_*`). **Só escreve com `QA_ESCREVE_ADO=1`**;
sem isso imprime o que faria. Modo interativo: mostre o dry-run e pergunte antes de rodar com escrita. Modo autônomo:
rode como está; quem decidiu se escreve foi o orquestrador, pela variável.

Se o dev tiver a skill `corrigir-card`, o relatório é a entrada dela: sugira `/corrigir-card <caminho>` quando houver
defeito.

## Limites

- Não altera banco por SQL. Não digita senha. Não faz commit. Não escreve no ADO fora do `publicar-resultado.mjs`.
- Não afirma "está na stage" sem o `publicado_*` do Passo 1. Rotação da stage já desfez merge entregue.
- Regra fiscal e de legislação não é assunto do teste: divergência vira `duvida` com handoff para o time fiscal.
- Item que não deu para executar é "NÃO COBERTO, motivo", nunca "PASSOU".
- Não invente achado. Relatório sem falha é resultado válido. Falso REPROVADO custa mais que bug escapado: na dúvida,
  `duvida`, não `defeito`.

## Manutenção

Bug que a QA humana ou o cliente achou e esta skill não achou (TaskBug filho de card que ela aprovou) vira heurística
nova em `references/heuristicas.md`, com o card de onde veio. É o único jeito de a skill ficar melhor que um clicador
genérico.
