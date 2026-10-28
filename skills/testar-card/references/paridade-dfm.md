# Paridade Delphi × web pelo código (sem executar o Delphi)

Quando se aplica: card de migração de tela, card que diz "igual ao Delphi" / "como a tela antiga", ou qualquer tela
web que tenha equivalente em `$REPOS_DIR/$REPO_NOME_DELPHI/$DELPHI_SOURCE_DIR/<Tela>/`. O objetivo é responder, campo a campo, "a tela web
tem tudo que a Delphi tem, com o mesmo rótulo, obrigatoriedade e tamanho?". É o que um testador faz abrindo as duas
telas lado a lado, só que lendo a declaração da tela em vez de olhar para ela.

Fontes Delphi estão em **cp1252**: leia com `iconv -f cp1252 -t utf-8 <arquivo>`. Em `Caption`, acentos aparecem como
`'S'#233'ries'` (= "Séries"): `#NNN` é o código decimal do caractere.

## 1. Achar a tela Delphi

```bash
cd $REPOS_DIR/$REPO_NOME_DELPHI/$DELPHI_SOURCE_DIR
ls | grep -i <palavra-da-tela>                       # ex.: Cliente, Pedido, Produto
grep -rli "<NOME_DA_TABELA>" --include=*.dfm . | head  # pela tabela que a tela web grava
```

Anote `git -C $REPOS_DIR/$REPO_NOME_DELPHI rev-parse --short HEAD` no relatório.

## 2. Extrair a lista de campos do `.dfm`

Três lugares, do mais declarativo ao menos:

1. **componente de definição de campos** (no sistema de referência, `TNeoFieldsDef`; bloco `Campos = < item ... end >`): é a lista oficial de campos do dataset da tela.
   Por item: `DisplayLabel` (rótulo), `NomeCampo`/`Origin` (coluna), `Required` (obrigatório), `Size` (tamanho),
   `Visible`, `Precision`. Quando existe, é a fonte primária.
2. **Controles de edição**: `TcxDBTextEdit`, `TcxDBLookupComboBox`, `TcxDBImageComboBox`, `TcxDBCheckBox`,
   `TcxDBDateEdit`, `TcxDBMemo`, `TcxDBEditorRow`. Propriedades: `DataBinding.FieldName` (coluna),
   `Properties.MaxLength`, `Properties.ReadOnly`, `Enabled`, `Visible`, `TabOrder`, `Hint`. O rótulo é o `TLabel` /
   `TcxLabel` vizinho (`Caption`) ou, em `TcxDBEditorRow`, `Properties.Caption`.
3. **Grid**: `TcxGridDBColumn` com `Caption` + `DataBinding.FieldName` + `Width` + `Visible`. É a lista de colunas da
   listagem.

Abas: `TcxTabSheet` (`Caption`). Botões: `TcxButton` / `TAction` (`Caption`, `Hint`). Regras de obrigatoriedade fora do
`Required`: procure no `.pas` por `BeforePost`, `Obrigat`, `MessageDlg('Informe`, `raise`.

Extração rápida (um bloco por objeto, com as propriedades que importam):

```bash
iconv -f cp1252 -t utf-8 u<Tela>.dfm | awk '
  /^ *object / {obj=$2" "$3}
  /^ *item$/ {obj="item"}
  /(DisplayLabel|NomeCampo|Required|Size|Caption|DataBinding\.FieldName|MaxLength|ReadOnly|Visible|Enabled) = / {print obj" | "$0}
' | sed -E 's/^ +//; s/ +\| +/ | /'
```

## 3. Extrair a lista de campos do Angular

No repo do front, componente da tela (achado no Passo 2 pelo `*-routing.module.ts`):

- Template (`.html`): rótulos (`label`, `[label]`, `placeholder`), `formControlName`, `[required]`/`required`,
  `maxlength`/`[maxLength]`, `mask`, componentes `app-input-*` e `app-select-*`, abas (`app-tab`, `mat-tab`,
  `p-tabPanel`), colunas da listagem (definições de `columns` no `.ts` ou `<th>` no html), botões.
- Classe (`.ts`): `FormBuilder.group({...})` com `Validators.required`, `Validators.maxLength(n)`; a entidade/DTO que o
  serviço envia (nomes das propriedades = colunas de destino, via a API).

## 4. Montar a tabela

| Campo (Delphi: rótulo) | Coluna | Web (`formControlName`) | Rótulo web | Obrig. D / W | Tam. D / W | Veredito |
|---|---|---|---|---|---|---|
| Modelo Doc. Fiscal | CDMODELODOCUMENTOFISCAL | codigo | Código | S / S | 2 / 2 | Igual |
| Séries Válidas | DSSERIEVALIDA | — | — | N / — | 100 / — | **Ausente na web** |
| — | — | observacao | Observação | — / N | — / 500 | Só na web |

Vereditos: `Igual` · `Ausente na web` · `Só na web` · `Rótulo diferente` · `Obrigatoriedade diferente` ·
`Tamanho diferente` · `Oculto no Delphi` (Visible=False: não conta como ausência).

Faça o mesmo para **abas**, **colunas da listagem** e **botões/ações** (três tabelas curtas).

## 5. Comportamento (o que o `.dfm` não mostra)

Do `.pas`: `OnExit`, `OnChange`, `BeforePost`, `AfterPost`, validações, cálculos, chamadas de SP (`SPxxx`). Das SPs e
triggers: `RDB$PROCEDURES` / `RDB$TRIGGERS` via `consultar-banco.sh` (fonte em `RDB$PROCEDURE_SOURCE`).
Liste "regras do Delphi que a web precisa ter" com `arquivo:linha` ou nome da SP. Cada regra vira **um item do
roteiro** (parte C): testar na web se o comportamento existe. Não é achado até ser testado.

## 6. Classificar as divergências

- `defeito`: campo/regra ausente ou diferente **e** o card pede paridade (critério, descrição ou título "migração").
- `duvida`: diferença que pode ser decisão de produto (campo descontinuado, rótulo modernizado). Vira pergunta à PO,
  não bloqueia.
- `fora-do-escopo`: campo que pertence a outra história ou aba que será outro card. Registre e sugira card.

Registre no relatório a seção "Paridade Delphi (estática)" com as tabelas, o SHA do repo Delphi e a frase
"execução do Delphi: NÃO COBERTA neste modo" quando for o caso.
