# Registro do Gauntlet Loop

Este documento registra o ciclo Executor ↔ **Verificador Cego** usado para construir e validar o GPU Power Manager.

O método: cada área é implementada por um **Executor** e depois julgada por um **Verificador** que **não sabe como ela foi implementada**. O verificador só pode aprovar com evidência real: executando o código, medindo o hardware, renderizando os componentes. "Compila" e "os testes passam" nunca bastam. Rejeição devolve o achado ao executor e o ciclo continua.

---

## Por que verificação cega

Um executor que conhece a própria implementação julga o próprio trabalho com a mesma modelo mental que o construiu. O verificador cego quebra esse viés: ele recebe apenas a **especificação**, não a solução, e precisa redescobrir o comportamento por evidência. Foi exatamente isso que o método pagou aqui.

---

## Rodadas

| Rodada | Executor | Verificador cego | Veredito |
|---|---|---|---|
| 1 | T1 telemetria · T2 power limit · T3 perfis · T4 benchmark · T5 interface | (julgado na rodada 2) | (julgado na rodada 2) |
| 2 | T6 main + IPC + preload + hardening | A (telemetria/power/segurança) e B (energia/benchmark) | **REPROVADO** ×2 |
| 3 | W1 (motor) + orquestrador (preload/polkit/simulador/testes) | (julgado na rodada 4) | (julgado na rodada 4) |
| 4 | W2 (motor) + W3 (interface) | B (energia/benchmark/interface) | **REPROVADO** |
| 5 | W3 (interface) | B (energia/benchmark/interface) | **REPROVADO** |
| 6 | W3 (interface) | A (segurança) + B (energia/interface) | **REPROVADO** (B) |
| 7 | correções finais aplicadas pelo orquestrador | B (revisão focada da Round 6) | **REPROVADO** |

**6 rodadas de verificação, 4 rejeições, todas com defeitos reais e reproduzíveis.**

---

## Achados que mudaram o produto

### Rodada 2: Verificador A (segurança e power limit)

| Severidade | Achado | Correção |
|---|---|---|
| 🔴 BLOCKER | O preload roda **sandboxed**; um `require` relativo não resolve nesse regime. O preload inteiro falhava ao carregar, `window.gpuPm` ficava `undefined` e o renderer caía **silenciosamente no mock**, e a UI mostrava **dados simulados carregando os UUIDs reais das GPUs da máquina**. | Preload empacotado em arquivo único (`vite.preload.config.ts`, só `require("electron")`). Dentro do Electron, a ausência da ponte agora mostra um **painel de erro explícito** em vez de mock. |
| 🔴 BLOCKER | `src/renderer/**` não existia: a interface nunca tinha sido construída. | T5: 64 arquivos, 9 seções, design system shadcn, gráficos, i18n pt-BR/en. |
| 🔴 MAJOR | A ação polkit `set-power-limit` estava com `allow_active=yes`, **sem senha**. | `auth_admin_keep`: autorização administrativa real, com cache de poucos minutos. |
| 🔴 MAJOR | Testes do helper fixavam os UUIDs desta máquina → falhavam em qualquer outra máquina NVIDIA. | Asserções estruturais (o driver reporta faixas coerentes) em vez de valores fixos. |
| 🟡 MAJOR | O simulador reusava os **UUIDs reais** do hardware de referência. | UUIDs sintéticos (`GPU-00000000-…`) e nome marcado como "(simulado)". |
| 🟡 MINOR | `INVOKE_CHANNELS`/`SUBSCRIBE_CHANNELS` declarados e não aplicados. | A allow-list passa a **bloquear** o registro de qualquer canal fora da lista. |
| 🟡 MINOR | `nvidiaSmiPath` devolvia sempre `null`. | Caminho real do binário, resolvido sob demanda. |

### Rodada 2: Verificador B (energia e benchmark)

| Severidade | Achado | Correção |
|---|---|---|
| 🔴 BLOCKER | O caminho padrão de LLM reportava **0 J/token**: uma carga de 0,8 s produzia 1 amostra → 0 J → `0 / 32 = 0`. A energia **não medida** era publicada como medida. | Amostragem **direta do driver a 5 Hz** (o benchmark não depende mais do cache de 1 Hz da UI); `measuredMs` exposto; `efficiency()` devolve `null` quando a energia não é resolvível. |
| 🔴 BLOCKER | **Temperatura nunca era registrada**, embora a especificação exija média e máxima. | Temperatura capturada, agregar e exposta por GPU e no resumo. |
| 🔴 MAJOR | O otimizador recomendava o **maior** limite quando todas as energias davam 0 J. | Só candidata com energia **medida e positiva**; recusa com motivo explícito. |
| 🔴 MAJOR | `energyDeltaPct: 0` fixo no fallback, uma **porcentagem de economia fictícia**. | Derivado da medição real; `null` quando a referência é desconhecida. |
| 🔴 MAJOR | `perSecond` não existia no contrato público; a taxa era alcançada por cast. | Campo opcional adicionado ao contrato; o cast foi removido. |
| 🔴 MAJOR | A suíte de testes **nunca era typecheckada**: 4 arquivos quebrados passavam como verdes. | `tsconfig.test.json` incluindo `tests/**`, adicionado ao `typecheck`. |
| 🔴 MAJOR | Um **total** era usado como se fosse **taxa**. | A contagem não é uma taxa: sem taxa medida, o valor é `null`. |
| 🔴 MAJOR | Execuções de **adaptadores diferentes** eram comparadas entre si. | Adaptador entra no critério de elegibilidade. |
| 🔴 MAJOR | O llama.cpp reportava "disponível" para um servidor **só de embeddings** (`:8088`), e descartava a mensagem real do servidor. | A detecção sonda uma completion real; a mensagem original do servidor é preservada. |

### Rodada 4: Verificador B (de novo, agora com a interface)

| Severidade | Achado | Correção |
|---|---|---|
| 🔴 BLOCKER | A **energia de uma GPU não selecionada** era somada ao total: o mesmo run produzia **três números diferentes** na tela. | Integração escopada às GPUs selecionadas (`uuids` obrigatório na função). |
| 🔴 MAJOR | "Potência alvo **aplicada** durante a medição" era **falso**: o alvo era só um rótulo. | O motor passa a **observar** o `power.limit` real do driver e marca a execução como não verificada quando diverge; a interface mostra `alvo` / `observado` e tem um botão "Aplicar limite antes de medir". |
| 🔴 MAJOR | O renderer **contornava** os quatro guardas de `efficiency()` e imprimia "500,00 por token" para zero tokens. | A interface passa a usar a `efficiency()` **compartilhada**; o módulo duplicado foi removido. |
| 🔴 MAJOR | O painel de comparação aceitava execuções **abortadas** e de **adaptadores diferentes**, imprimindo "-95,00 %" entre medições incomparáveis. | Só execuções comparáveis são oferecidas: concluídas, totalmente medidas, mesmo adaptador, mesma carga, mesmas GPUs, limite verificado. |
| 🔴 MAJOR | O renderer escolhia o **próprio** "melhor" (`?? 0`) e destacava uma candidata que o serviço havia recusado. | O `best` foi **removido**: a interface usa a recomendação do serviço, com o selo "Recomendação do serviço". |
| 🔴 MAJOR | Temperatura capturada mas **nunca exibida**. | Colunas de temperatura média e máxima, com marcador quando `null`. |
| 🟡 MINOR | Validação de watts fixada em 100–500 W, contradizendo a faixa real da GPU. | Usa `power.minLimitW` / `maxLimitW` do driver. |
| 🟡 MINOR | O aviso "energia da GPU ≠ consumo do computador" existia só no README. | Visível nas páginas de Benchmark e Otimizador. |
| 🟡 MINOR | Zero testes de interface. | 19 testes de renderer. |

### Rodada 5: Verificador B (de novo)

| Severidade | Achado | Correção |
|---|---|---|
| 🔴 BLOCKER | **Cobertura desconhecida passava no guarda.** `energy.ts` só recusava quando a cobertura era um número baixo; `null` (desconhecida) caía no cálculo e a tabela imprimia "0,761 por token" para um run persistido sem cobertura. Dois módulos irmãos codificavam **regras opostas**. | A regra canônica foi movida para `src/shared/energy.ts` (`scopeEnergy`, `isFullyMeasured`) e o renderer passou a **delegar** a ela: uma única definição, usada pelo motor, pelo otimizador e pela interface. Cobertura desconhecida ⇒ `null`. |
| 🔴 MAJOR | Uma carga de adapter **interrompida** era publicada como `completed` e podia virar a referência do otimizador. | Adapter sem throughput ⇒ `aborted`. Execução manual parada pelo usuário continua `completed`. |
| 🔴 MAJOR | O diagnóstico era calculado e **descartado**: runs `failed` sumiam da tabela e o motivo nunca aparecia; a cobertura não era mostrada. | Runs `failed` visíveis com a mensagem de erro; percentual de cobertura exibido. |
| 🟡 MINOR | O fallback "nada qualificou" aparecia como recomendação verde com "Δ energia 0,00 %" e botão de aplicar. | Flag `fallback`, selo de **aviso**, deltas vazios e **sem botão de aplicar**. |
| 🟡 MINOR | Endpoints de adapter fixos no código, sem campo de configuração. | `ollamaUrl`, `llamaCppUrl`, `comfyUiUrl` e o comando do Unsloth agora são configuráveis e validados, com os padrões preservados. |

---

## Rodada 7: a rejeição que fechava o ciclo

O verificador da rodada final concentrou-se nas cinco correções da rodada 6 e encontrou o que ainda impedia o fallback de existir.

| Severidade | Achado | Correção |
|---|---|---|
| 🔴 MAJOR | **O fallback "nenhum limite qualificou" nunca disparava.** A referência era avaliada como candidata **contra si mesma**, o que dá delta 0 %, sempre dentro da restrição. A ramificação `fallback: true` era inalcançável, e o usuário via uma recomendação verde que não economizava nada. | A referência é removida do conjunto de candidatas (`evaluation.watts !== baselineWatts`). Ela continua aparecendo honestamente na lista dos outros limites, mas não pode se auto-qualificar. |
| 🟡 MINOR | O painel de comparação aceitava runs que o otimizador recusa (throughput ausente, limite não confirmado): a seleção terminava em toast de erro em vez de uma lista filtrada. | `isComparableRun` espelha exatamente o portão do otimizador (`limitVerified === true` e adapter sem throughput é recusado). Um teste antigo que codificava a regra mais frouxa foi corrigido. |
| 🟡 MINOR | "A energia não pôde ser medida" era usado também quando o motivo real era **não existir medição naquele limite**: dois fatos diferentes com a mesma frase. | O fallback distingue os dois casos: "não há medição nos limites candidatos: execute o benchmark antes de comparar" quando o run simplesmente não existe. |

O caso da rodada 7 foi travado com um **teste de regressão** em `tests/optimizer/optimizer-service.test.ts`, que monta uma referência de 180 W, uma candidata de 150 W que perde 50 % do throughput e uma faixa de candidatos que **inclui os 180 W da própria referência**, exatamente o fluxo padrão, e exige que a recomendação saia com `fallback === true`, sem `energyDeltaPct` de economia e com a candidata recusada listada com o motivo real.

---

| Métrica | Valor |
|---|---|
| Testes | **461**, em 33 arquivos, todos verdes |
| Typecheck | 4 configs (`main`, `preload`, `renderer`, `test`), limpos |
| Fontes | 124 arquivos · ~22.600 linhas |
| Testes | 33 arquivos · ~8.200 linhas |
| Pacotes | `AppImage` 110 MB · `.deb` 76 MB |
| Execução real | app Electron contra 2 GPUs NVIDIA, telemetria ao vivo |
| Integridade do hardware | `power.limit` **inalterado** (285,00 W / 180,00 W) em todas as execuções |

### Propriedades garantidas por teste

- **Energia** = integral trapezoidal da **potência medida**; nunca `limite × duração`; lacunas não são integradas; múltiplas GPUs são somadas.
- **Medição não realizada nunca vira número**: sem cobertura conhecida, sem energia resolvível, sem taxa medida ou sem tokens, o valor é `null` e a interface mostra "não medido".
- **O driver nunca é escrito** pelo caminho de benchmark; o *power limit* só muda por ação explícita do usuário, via helper privilegiado autorizado por polkit, com re-leitura de confirmação.
- **Nenhum comando de shell** é montado por concatenação de entrada do usuário.
- **O app Electron nunca roda como root** e o `sudo` sem senha nunca é configurado.

---

## Limitação honesta

O caminho de benchmark **nunca** escreveu no driver, verificado por `nvidia-smi` antes e depois de cada execução (limites idênticos). A aplicação real de um *power limit* via `pkexec` + polkit **não foi exercitada de ponta a ponta** nesta máquina, porque o usuário tem cargas de IA em execução e alterar o estado do hardware estava fora do escopo autorizado. O caminho está implementado, tem testes que cobrem a construção do argv, o mapeamento de falhas do `pkexec` e a revalidação no helper, e o helper foi executado contra as GPUs reais em seus modos de leitura, mas a escrita privilegiada não foi testada ao vivo.
