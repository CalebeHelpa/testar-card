# Modelo do relatório

Arquivo: `<TESTES_DIR>/<card>/relatorio-<card>-<AAAA-MM-DD>.md`. Screenshots em `<TESTES_DIR>/<card>/screenshots/`
(é o `--output-dir` do Playwright MCP), nome `<card>-<NN>-<slug>.png`.

O **cabeçalho YAML é lido por máquina** (`publicar-resultado.mjs` e o orquestrador). Mantenha as chaves exatamente.
O bloco `## Resumo` é o que vai no comentário do card: curto, uma linha por falha.

```markdown
---
card: 1234
titulo: Cadastro de exemplo
veredito: REPROVADO            # APROVADO | REPROVADO | BLOQUEADO
motivo_bloqueio:               # só quando BLOQUEADO: "build do Angular não contém a branch" / "sem critério de aceite" / "sessão expirou no item 3"
data: 2026-10-27
data_hora: 2026-10-27T14:05:00-03:00
modo: autonomo                 # autonomo | interativo
tipo: completo                 # completo | reteste
relatorio_anterior:            # só no reteste: nome do relatório anterior
testado_back: <sha completo>   # sha_back do preparo: a versão que este teste viu (o reteste compara com ela)
testado_front: <sha completo>  # sha_front do preparo
ambiente: <QA_FRONT> · back <sha8> · front <sha8> · banco <host:base>
publicado_back: SIM
publicado_front: SIM
criterio_aceite: presente      # presente | AUSENTE
passou: 12
falhou: 2
nao_coberto: 1
defeitos: 2                    # achados mantidos como defeito após a revisão
duvidas: 1
layout_divergencias: 3
paridade_delphi: feita         # feita | nao-se-aplica | NAO COBERTA
repro_vermelhos: 2             # testes de reprodução VERMELHO 2/2 (um por defeito, quando automatizável)
---

# Teste do card <card> — <título>

## Resumo
**Falhou:** F1 Salvar com série duplicada grava 2 registros (POST /api/entidade → 200; SELECT → 2 linhas) · F2 ...
**Layout:** 3 divergências com o protótipo (L1 rótulo ausente; L2 ...) · ou "sem protótipo no card"
**Dúvidas para a PO:** D1 ...
**Não coberto:** impressão (PDF em janela nova)
**Passou:** 12 de 15 itens
**Paridade Delphi:** 2 campos ausentes na web (tabela abaixo) · execução do Delphi NÃO COBERTA

## Mapa de fluxo
<rota, componente, permissão (Tela.CodigoInterno), campos, endpoints, tabelas, vizinhança — 10 a 20 linhas>

## Ciclo de vida e cobertura por transição
| Estado (tabela.coluna=valor) | Transição | Quem faz (tela / SP / trigger) | Item do roteiro | Coberto? |
|---|---|---|---|---|

## Roteiro executado
A. Critério de aceite: A1 ... A5 · B. Exploração: B1 ... B8 · C. Paridade Delphi: C1 ... C3
(em modo autônomo o roteiro não foi revisado por humano; registre isso)

## Resultado
| # | Item | Resultado | Evidência |
|---|------|-----------|-----------|
| A1 | <passo do roteiro> | PASSOU / FALHOU / NÃO COBERTO | `1234-01-lista.png` · `POST /api/x → 200` · `SELECT ... → 1 linha` |

## Achados (um por seção)

### F1 — <título curto>
**Classificação:** defeito | duvida | prototipo | fora-do-escopo     **Gravidade:** alta | média | baixa
**Passos:** 1. … 2. … 3. …
**Esperado:** … (fonte: critério de aceite item 2 / descrição / protótipo / `arquivo.ts:linha`)
**Obtido:** … (tela) · `POST /api/x → 400 {"erro":"..."}` (rede) · `SELECT ... → 0 linhas` (banco)
**Evidência:** `1234-07-salvar.png`
**Onde no código (hipótese):** `entidade.service.ts:48` ⚠️ HIPÓTESE
**Proposta de correção:** <o que mudar, em 2 a 4 linhas; se houver, um esboço de diff>
**Teste de regressão sugerido:** <o item do roteiro que reexecuta isto, ou um teste unitário>
**Teste de reprodução:** `repro/1234-F1.repro.mjs` · VERMELHO 2/2 · vídeo `repro-resultados/1234-F1/2/video.webm`
(ou: não automatizado — <motivo>)

## Layout — comparação com o protótipo
| Elemento | Protótipo | Stage | Veredito | Classificação |
|---|---|---|---|---|
(1280 px; não é pixel a pixel. `proto-NN-*.png` e `stage-NN-*.png` em `screenshots/layout/`)

## Paridade Delphi (estática) — <repo Delphi> @ <sha>
<tabelas de `references/paridade-dfm.md`: campos, abas, colunas, botões; regras do `.pas`/SP viradas itens C>

## Revisão dos achados (revisor com contexto zerado)
<saída do subagente `revisor-achados`, colada na íntegra>

## Descartados na revisão
- F3: <motivo do revisor>

## Não coberto
- <item>: <motivo> (PDF em janela nova; precisa de usuário sem permissão X; execução do Delphi)

## Dados alterados na base (para a QA)
- <tabela/registro>: antes → depois. Registro **criado** leva `TESTE <card>` no nome.

## Perguntas para a PO
- D1: <dúvida de regra, com o que o Delphi faz e o que a web faz>

## Rascunho de TaskBug (um por defeito mantido)
**Título:** <card> — <o que quebra em uma frase>
**Passos para reproduzir:** …
**Resultado esperado / obtido:** …
**Ambiente:** <igual ao cabeçalho>
```

Regras de preenchimento:

- `veredito`: **BLOQUEADO** quando o teste não pôde valer (build sem a branch, sem critério de aceite com
  `QA_EXIGE_CRITERIO=1`, login/ferramenta impediu a maioria dos itens). **REPROVADO** quando há ao menos um
  `defeito` mantido pela revisão. **APROVADO** nos demais casos, mesmo com dúvidas, divergências de protótipo ou
  itens fora do escopo (esses vão no comentário e nas perguntas à PO, não bloqueiam).
- Contadores do cabeçalho refletem o estado **depois** da revisão.
- Item que não deu para executar é NÃO COBERTO com motivo, nunca PASSOU.
