# Heurísticas de exploração — o que o caminho feliz não cobre

Use como lista de verificação, não como roteiro. Para cada item que se aplica à tela do card,
execute e registre os três olhos: **tela** (o que apareceu), **rede** (o que a API respondeu) e
**banco** (o que ficou gravado). "Salvo com sucesso" na tela sem linha no banco é bug.

## Navegação
1. **Voltar do navegador** no meio do fluxo (form preenchido, modal aberto, aba interna). Para onde foi? Perdeu dado sem avisar?
2. **F5** com form sujo. Avisou? Recarregou limpo ou em estado quebrado?
3. **URL direta** da tela, sem passar pelo menu (colar a rota **sem** `#` (`<QA_FRONT>/<rota>/123`); com `#` a stage de referência caía na Home). Carrega? E com id inexistente?
4. **Duas abas** na mesma tela editando o mesmo registro. Quem ganha? Sobrescreve em silêncio?
5. **Botão "Voltar" da tela** vindo por rotas diferentes (menu, listagem, link de outra tela). Caso real: um "voltar" genérico mandava para a Home quando não havia navegação anterior.

## Formulário
6. **Duplo clique em Salvar**. Gravou dois?
7. **Limite dos campos**: tamanho máximo, zero, negativo, vazio, só espaços, caractere especial, acento, emoji.
8. **Campo obrigatório em branco** um por vez. A mensagem aponta o campo certo?
9. **Combos dependentes**: mudar o pai depois de escolher o filho. O filho limpou?
10. **Editar e cancelar**. Ficou algo gravado? A listagem voltou igual?
11. **Salvar, reabrir, comparar**. Todo campo voltou como foi gravado? (data, decimal, switch, texto com acento)

## Dado legado
12. **Registro antigo do Delphi** aberto na tela nova. Campos que a tela nova exige e o registro não tem: quebra ou trata?
13. **Registro criado na tela nova** lido pelo Delphi, quando houver a mesma tela lá. Sem executar o Delphi, confira pelo banco: a linha tem todas as colunas que o `TNeoFieldsDef` do `.dfm` marca como `Required` (ver `paridade-dfm.md`).
14. **Registro com dependentes** (usado em venda, OS, nota): excluir ou inativar. Bloqueou? Mensagem faz sentido?

## Permissão e contexto
15. **Usuário sem a permissão** da tela (o `Tela.CodigoInterno` do mapa de fluxo). Menu esconde? URL direta bloqueia? API bloqueia? (Sem segundo usuário na sessão: NÃO COBERTO, motivo.)
16. **Trocar de empresa/filial** com a tela aberta. Dado da empresa errada aparece?
17. **Sessão expirada** no meio do salvar. Perdeu o form? Redirecionou?

## Vizinhança do diff
18. **Quem mais usa o que mudou.** Para cada serviço, componente ou endpoint tocado no PR, abra pelo menos uma outra tela que o usa e repita o fluxo básico dela. É onde regressão mora.
19. **Listagem e filtros** da tela: ordenar, filtrar, paginar, com e sem o registro novo.
20. **Impressão e exportação**, se a tela tiver. PDF em janela nova o agente não vê: registre como **NÃO COBERTO** para o testador. Upload de arquivo funciona (`browser_file_upload`): teste com arquivo válido, vazio e de tipo errado (`assets/upload/`).

## Silêncio
21. **Console do navegador** vazio ao fim de cada fluxo? Erro JS silencioso conta.
22. **Resposta 4xx/5xx** com a tela dizendo sucesso. Caso real: um método de gravação engolia a falha e a tela dizia "salvo com sucesso" com a API devolvendo 400.
23. **Worker/log em segundo plano**: tabelas de log da entidade ganharam linha? (ex.: uma tabela `<ENTIDADE>LOG`)

## Paridade com o Delphi
24. **Card que replica regra ou tela do Delphi** ("como o Delphi faz", "igual à tela antiga", migração): faça a paridade **estática** de `references/paridade-dfm.md` (campos, abas, colunas, botões, regras do `.pas` e SPs) e transforme cada regra do Delphi em item do roteiro na web. Caso real: a web não gravava BAIXA/LANCAMENTO e o Delphi gravava; só o banco mostrou. A execução do Delphi (espelho) não faz parte do modo autônomo: registre "execução do Delphi: NÃO COBERTA".
25. **Mesma O.S. nos dois sistemas**: quando a regra é de confirmação cruzada (web→Delphi ou Delphi→web), confira pelo banco o que o outro lado exigiria (vínculos, campos obrigatórios da SP). Caso real: o Delphi pediu vendedor/mecânico porque *outro* item da O.S. estava sem vínculo.
26. **Ciclo de vida da entidade.** Antes do roteiro, desenhe os estados da entidade do card (coluna e valores) e quem faz cada transição: tela, stored procedure, trigger, job. O roteiro tem um item por transição e usa **o mesmo registro** do primeiro ao último item. Não pegue registro antigo já no estado do meio como atalho. Transição cujo mecanismo você não achou no código é item de investigação, não "não coberto". Caso real: a pré-reserva nasce "aguardando estoque" e só vira lançável por uma stored procedure na entrada de estoque; ficou de fora até a revisão humana perguntar.

## Não faça
- Não altere banco por SQL. Quem grava é a tela. O helper `consultar-banco.sh` só aceita SELECT.
- Não digite senha. O login é fixture (`login-stage.mjs`) ou do testador.
- Não escreva no Azure DevOps fora do `publicar-resultado.mjs`, e esse só escreve com `QA_ESCREVE_ADO=1`.
- Não invente achado. Item que passou é "passou"; item que não deu para executar é "não coberto, motivo".
