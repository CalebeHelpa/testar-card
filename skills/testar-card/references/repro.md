# Teste de reprodução: o defeito vira um teste vermelho

Para cada achado que **ficou como `defeito` depois da revisão**, escreva um teste curto que **afirma o comportamento
correto** e por isso **falha hoje**. Ele vai anexado ao card junto com o vídeo da falha. O dev roda o teste até ficar
verde, e o reteste do card roda o mesmo teste **sem IA**: se nada mudou e ele continua vermelho, o card volta sem
gastar um agente.

Arquivo: `<pasta>/repro/<card>-<F n>.repro.mjs` (ex.: `repro/1234-F1.repro.mjs`).

## Formato

```js
// <card> F1 — <título do achado>. Falha hoje; deve passar depois da correção.
export const meta = { card: 1234, achado: "F1", titulo: "Documento inválido não consulta duplicidade" };

export default async function ({ page, expect, irPara, rede, banco, aguardar, verificar, log }) {
  // 1) PREPARAÇÃO: chegar ao estado do defeito. Falha aqui = QUEBRADO (o teste não diz nada sobre o defeito).
  await irPara("cadastros/fornecedor/0");
  await expect(page.getByRole("heading", { name: "Novo Fornecedor" })).toBeVisible({ timeout: 30000 }); // tela pronta
  await page.getByLabel("Tipo de pessoa").selectOption({ label: "Física" });
  rede.limpar();
  await page.getByLabel("CPF").fill("111.111.111-11");
  await page.keyboard.press("Tab");
  await aguardar(1500); // debounce da consulta

  // 2) VERIFICAÇÃO: só o comportamento correto. Falha aqui = VERMELHO (o defeito continua).
  await verificar(async () => {
    await expect(page.getByText("já cadastrado")).toBeHidden();
    expect(rede.chamadas(/ValidarDocumento/)).toHaveLength(0);
  });
}
```

Os seletores acima são ilustrativos: use os da tela real.

O que cada parâmetro faz:

| Parâmetro | Uso |
|---|---|
| `irPara(rota)` | navega para `QA_FRONT` + rota, espera a rede assentar e acusa INFRA se cair na tela de login |
| `expect` | o `expect` do Playwright (`toBeVisible`, `toBeHidden`, `toHaveValue`, `toHaveText`, `toHaveLength`...) |
| `rede.chamadas(/regex/)` | respostas HTTP desde o início ou o último `rede.limpar()`: `{ metodo, url, status }` |
| `banco(sql)` | texto do `consultar-banco.sh` (só SELECT): `expect(await banco("SELECT ...")).toMatch(/.../)` |
| `verificar(async () => {...})` | **obrigatório**: só a falha aqui dentro conta como VERMELHO |
| `aguardar(ms)`, `log(texto)` | espera fixa (só para debounce) e nota no resultado |

## Regras

- **A asserção é do comportamento correto**, tirada do "Esperado" do achado (critério de aceite, legado, protótipo).
  Nunca afirme o comportamento errado ("o modal aparece"): o teste tem de ficar verde quando corrigirem.
- **Tela pronta antes do `verificar`.** Espere um elemento que só existe com a tela carregada (título, botão) com
  `timeout` folgado (30 s). Lentidão da stage na preparação vira QUEBRADO; dentro do `verificar` viraria falso VERMELHO.
- **Seletores** do jeito que o Playwright MCP imprime em "Ran Playwright code" nas respostas de clique e digitação:
  `getByRole`, `getByLabel`, `getByText`, `getByPlaceholder`. Nunca `ref=...`, nunca atributo gerado do framework
  (`_ngcontent-*`), nunca `nth()` por posição na tela. **Não use `getByText(...).first()`**: menus laterais escondidos
  costumam ter o nome de quase toda tela, e o primeiro elemento achado é o invisível. Prefira `getByRole("heading")`.
- **Dados:** crie o que precisar pela tela, com `TESTE <card> REPRO` no nome. Não grave no banco por SQL. Se o
  defeito exige um registro específico que já existe, leia o id por `banco()`.
- **Curto:** até ~40 linhas e 60 s. Um defeito por arquivo.

## Rodar e conferir

```bash
node $S/rodar-repro.mjs <pasta>/repro/<card>-F1.repro.mjs --saida <pasta>/repro-resultados
```

| Resultado | O que fazer |
|---|---|
| `VERMELHO` (2 execuções) | Abra `repro-resultados/<nome>/2/final.png` e confira que falhou **pelo defeito** (mesma tela e mesma condição do achado). Pronto |
| `VERDE` | O teste não captura o defeito: a asserção está frouxa ou a preparação não chega ao estado do bug. Corrija |
| `QUEBRADO` | Seletor ou preparação errados. Corrija o seletor com `browser_find` na tela real |
| `INSTAVEL` | Vermelho uma vez e outra coisa na outra: aumente o tempo da preparação ou troque a espera fixa por espera de elemento |
| `INFRA` | Sessão expirada ou stage fora do ar: registre e siga, não é problema do teste |

No máximo **duas correções** por teste. Não conseguiu VERMELHO por motivo legítimo (PDF em janela nova, senha de
autorização, depende de outra máquina)? Registre `**Teste de reprodução:** não automatizado — <motivo>` e siga.
**Nunca afrouxe a asserção para ficar vermelho, e nunca aceite vermelho por outro motivo**: um falso vermelho reprova o
card de novo no reteste sem ninguém olhar.

No achado do relatório:

```markdown
**Teste de reprodução:** `repro/1234-F1.repro.mjs` · VERMELHO 2/2 · vídeo `repro-resultados/1234-F1/2/video.webm`
```
