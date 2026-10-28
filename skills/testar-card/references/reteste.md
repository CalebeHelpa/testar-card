# Reteste: o card voltou para a coluna

Quando: `QA_MODO=reteste` (modo autônomo; o orquestrador já decidiu) ou, no interativo, `node $S/reteste.mjs $card`
devolveu `modo=reteste`. O objetivo é responder rápido duas perguntas: **os defeitos de antes foram corrigidos?** e
**a correção quebrou algo perto?** Não refaça o roteiro inteiro.

## Entradas

| De onde | O quê |
|---|---|
| `<pasta>/reteste.txt` (saída do `reteste.mjs`) | relatório anterior, veredito, versão testada × atual, defeitos anteriores e seus testes de reprodução |
| `QA_RELATORIO_ANTERIOR` | o relatório anterior (leia o mapa de fluxo, o roteiro e os achados de lá; não remonte do zero) |
| `QA_REPRO_RESULTADOS` | JSON do `rodar-repro.mjs` que o orquestrador já rodou (no interativo, rode você) |
| `<pasta>/reteste-arquivos-mudados.txt` | arquivos que mudaram desde a versão testada, por repositório |
| `card.md` e `comentarios.json` | o que mudou no card desde o teste anterior (critério novo, resposta da PO) |

O Passo 1 (preparo e as regras duras de publicação e ambiente) vale igual.

## Escopo

1. **Defeitos anteriores**, um por um:
   - teste de reprodução **VERMELHO** (2/2): **PERSISTE**. Cite o vídeo. Não refaça à mão.
   - teste **VERDE**: refaça os passos do achado **uma vez à mão**, com evidência tripla (tela, rede, banco). Bateu →
     **CORRIGIDO**. Não bateu → **PERSISTE**, e o teste estava frouxo: corrija-o (`references/repro.md`).
   - teste **QUEBRADO**, **INSTAVEL**, **INFRA** ou sem teste: refaça à mão → CORRIGIDO ou PERSISTE, e escreva ou
     conserte o teste de reprodução.
2. **Regressão do que mudou** (pule se `arquivos_mudados=0`): cruze a lista com o mapa de fluxo do relatório
   anterior (componente, serviço, endpoint, tabela). Reexecute os itens do roteiro anterior que tocam esses
   arquivos, mais a heurística 18 (vizinhança) para arquivo que não estava no mapa. Arquivo de outro assunto que veio
   no merge da stage entra só como vizinhança.
3. **Dúvidas para a PO**: procure em `comentarios.json` respostas posteriores a `quando_anterior`. Respondida →
   registre a resposta e, se ela transformar a dúvida em defeito, trate como defeito novo. Sem resposta → repita.
4. **Não coberto** anterior: não refaça, a menos que o diff toque.

## Relatório

`relatorio-<card>-<AAAA-MM-DD>-reteste.md` (se já existir, `-reteste-2`, `-reteste-3`), no mesmo modelo, com:

- cabeçalho: `tipo: reteste` e `relatorio_anterior: <nome do arquivo>`, além dos campos de sempre;
- seção **Achados anteriores** logo depois do Resumo:

  | Achado | Antes | Agora | Evidência |
  |---|---|---|---|
  | F1 <título> | defeito | PERSISTE | `repro/1234-F1.repro.mjs` VERMELHO 2/2 · vídeo |

- seção **Regressão** com os itens reexecutados e o motivo de cada um (qual arquivo mudado);
- defeito que **persiste** volta a aparecer na seção Achados com o **mesmo id** e o teste de reprodução, para o
  próximo reteste achar; defeito **novo** continua a numeração (F4, F5...).

Revisor (`revisor-achados`): chame só se houver achado **novo**. Defeito que persiste com teste vermelho já tem
evidência determinística.

Veredito: algum PERSISTE ou defeito novo → **REPROVADO**. Todos CORRIGIDOS e nada novo → **APROVADO**. Não deu para
verificar os defeitos anteriores (infra, sessão) → **BLOQUEADO**.

No `## Resumo`, a primeira linha diz o placar: `**Reteste:** F1 PERSISTE · F2 CORRIGIDO · regressão 4 itens, 0 falhas`.
