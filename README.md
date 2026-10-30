<div align="center">

<img src="resources/icons/icon.png" width="128" height="128" alt="GPU Power Manager">

# GPU Power Manager

**Gerenciador de energia para GPUs NVIDIA no Linux — ajuste o *power limit* e meça a eficiência energética real de cargas de IA local.**

[![Licença](https://img.shields.io/badge/licença-Apache%202.0-blue.svg)](LICENSE)
[![Plataforma](https://img.shields.io/badge/plataforma-Linux-lightgrey.svg)](https://www.kernel.org/)
[![Electron](https://img.shields.io/badge/Electron-33-47848F.svg)](https://www.electronjs.org/)
[![Testes](https://img.shields.io/badge/testes-450%20verde-brightgreen.svg)](#testes)

[Português (Brasil)](#) · [English](#english)

</div>

---

## O problema

Rodar IA local consome energia. E é fácil cair em três erros:

1. **Confundir *power limit* com consumo.** O limite é um **teto** que o driver permite; o consumo real é outro número. Uma placa ociosa a 7 W com limite de 285 W não está "usando" 285 W.
2. **Achar que reduzir o limite reduz o custo na mesma proporção.** Não reduz. O ganho de energia é **medido**, não suposto.
3. **Inventar números de desempenho.** Tokens por segundo não se estimam — se medem.

Este app existe para não cair em nenhum dos três.

## O que ele faz

| | |
|---|---|
| **Detecção real** | Lê `nvidia-smi` na inicialização e expõe UUID, PCI Bus ID, driver, CUDA, VRAM, utilização, temperatura, potência instantânea, *power limit* (atual/padrão/mín/máx), clocks, ventoinha e *throttling* — **identificando a GPU por UUID**, nunca por índice |
| **Controle de potência** | Slider + campo numérico por GPU, faixa real do driver sempre visível, **valores fora da faixa rejeitados** (nunca ajustados em silêncio), alteração por helper privilegiado com **polkit** e **re-leitura de confirmação** |
| **Energia medida** | Integral trapezoidal da **potência medida ao longo do tempo** — nunca `limite × duração`. Multi-GPU somada. J/token, Wh/imagem, Wh/segundo de vídeo |
| **Otimizador** | Compara limites **medidos** e recomenda o de menor energia dentro da perda de desempenho aceitável — ou diz que nada qualificou |
| **Persistência opcional** | Unidade systemd que aplica o perfil no boot, **depois** que o driver estiver pronto, revalidando cada faixa |
| **Monitoramento de processos** | PID, processo, GPU e VRAM, com detecção de família (ComfyUI, llama.cpp, Ollama, Unsloth). **Nunca encerra processos** |

### A regra que governa o app inteiro

> **Uma medição que não foi feita nunca aparece como número.**

Carga de 0,8 s não produz amostra suficiente? O app mostra **"—"**, não `0 J/token`. Cobertura de medição desconhecida? **"—"**. Sem taxa medida? **"—"**. Sem throughput de adapter? **"—"**.

---

## Capturas

### Painel — tempo real, duas GPUs

![Painel com duas GPUs, gráficos ao vivo](docs/screenshots/01-painel-dark.png)

> Execução real: RTX 4070 Ti + RTX 5060 Ti, telemetria ao vivo do driver.

### Limite de potência

![Página de limite de potência](docs/screenshots/03-power-limit-dark.png)

A página separa explicitamente **potência instantânea**, **limite de potência** e **energia consumida** — as três grandezas que o app nunca confunde.

### Detalhe da GPU

![Página de detalhe da GPU](docs/screenshots/02-gpus-dark.png)

### Perfis de energia

![Perfis de energia](docs/screenshots/04-profiles-dark.png)

### Benchmark de eficiência

![Benchmark](docs/screenshots/05-benchmark-dark.png)

### Otimizador

![Otimizador](docs/screenshots/06-optimizer-dark.png)

### Processos

![Processos](docs/screenshots/07-processes-dark.png)

### Histórico

![Histórico](docs/screenshots/08-history-dark.png)

### Configurações

![Configurações](docs/screenshots/09-settings-dark.png)

### Tema claro

<details>
<summary>Ver as 9 páginas no tema claro</summary>

| | |
|---|---|
| ![Painel claro](docs/screenshots/01-painel-light.png) | ![GPUs claro](docs/screenshots/02-gpus-light.png) |
| ![Power limit claro](docs/screenshots/03-power-limit-light.png) | ![Perfis claro](docs/screenshots/04-profiles-light.png) |
| ![Benchmark claro](docs/screenshots/05-benchmark-light.png) | ![Otimizador claro](docs/screenshots/06-optimizer-light.png) |
| ![Processos claro](docs/screenshots/07-processes-light.png) | ![Histórico claro](docs/screenshots/08-history-light.png) |

![Configurações no tema claro](docs/screenshots/09-settings-light.png)

</details>

### Honestidade verificável

Dentro do Electron, se a ponte privilegiada não carregar, o app **recusa exibir dados simulados** e mostra o erro:

![Painel de erro da ponte](docs/screenshots/electron-bridge-error.png)

---

## Instalação

### AppImage

```bash
chmod +x GPU-Power-Manager-1.0.0-x86_64.AppImage
./GPU-Power-Manager-1.0.0-x86_64.AppImage
```

### Pacote `.deb`

```bash
sudo apt install ./gpu-power-manager_1.0.0_amd64.deb
```

Dependências: `nvidia-utils | libnvidia-ml1`, `python3`, `policykit-1`.

### Habilitando o controle de potência

O app abre em modo **somente leitura**. Para permitir alterar o *power limit*:

1. **Configurações → Serviço privilegiado → Instalar**.
2. Autentique-se no diálogo do polkit (pede a senha de administrador).

O helper vai para `/usr/local/libexec/gpu-power-manager-helper` (`root:root`, `0755`) e a política para `/usr/share/polkit-1/actions/com.gpupowermanager.policy`.

> **O Electron nunca roda como root e o `sudo` sem senha nunca é configurado.** A ação polkit de ajuste de potência exige autorização administrativa (`auth_admin_keep` — pede uma vez e vale por alguns minutos).

Detalhes: [`docs/INSTALL.md`](docs/INSTALL.md) · Remoção: [`docs/REMOVE.md`](docs/REMOVE.md)

---

## Como a qualidade foi assegurada

O projeto foi construído em um **loop Executor ↔ Verificador cego**: cada área foi implementada por um executor e depois julgada por um verificador que **não sabia como ela havia sido construída** e que só podia aprová-la com evidência real — executando código, medindo hardware, renderizando os componentes. Nada foi liberado por "compila" ou "os testes passam".

**6 rodadas de verificação, 4 rejeições.** Os defeitos que o loop pegou e o código sozinho não pegaria:

| Defeito | Por que só a medição revealing |
|---|---|
| O preload sandboxed não resolvia `require` relativo | O preload morria ao carregar e a UI caía **silenciosamente no mock**, mostrando **dados simulados com os UUIDs reais das GPUs** |
| `0 J/token` no caminho padrão de LLM | Carga de 0,8 s = 1 amostra = 0 J → "eficiência" infinita |
| Energia de GPU **não selecionada** somada ao total | O mesmo run aparecia com **3 números diferentes** na tela |
| O renderizador contornava os 4 guardas de `efficiency()` | Imprimia "500,00 por token" para uma execução com zero tokens |
| Cobertura **desconhecida** passava no guarda | A tabela mostrava "0,761 por token" onde nada foi medido |
| `allow_active=yes` no polkit | Alterar *power limit* sem senha de administrador |
| O fallback "nenhum limite qualificou" era inalcançável | A referência se auto-qualificava com delta 0 % e exibia uma recomendação verde que não economizava nada |

O registro completo: [`docs/GAUNTLET.md`](docs/GAUNTLET.md) · Modelo de segurança: [`docs/SECURITY.md`](docs/SECURITY.md)

---

## Arquitetura

```
┌──────────────────────────────────────────────────────────────┐
│ Renderer (React + TS + Tailwind + shadcn/ui + Recharts)     │
│   pages/ · components/ui/ · store/ (Zustand) · lib/i18n      │
│   └── fala SOMENTE com window.gpuPm (contextBridge)         │
└───────────────────────────┬──────────────────────────────────┘
                            │ IPC (canais tipados, validados)
┌───────────────────────────┴──────────────────────────────────┐
│ Preload — contextBridge, sandboxed, sem node, empacotado     │
└───────────────────────────┬──────────────────────────────────┘
                            │
┌───────────────────────────┴──────────────────────────────────┐
│ Main (Electron)                                               │
│   ipc/         validação de todos os payloads                │
│   nvidia/      parser de nvidia-smi + simulador              │
│   telemetry/   polling + histórico + downsample              │
│   power/       regra de faixa + backend real/simulado        │
│   privileged/  cliente do helper + polkit                     │
│   profiles/    perfis CRUD + resolução de estratégias        │
│   persistence/ unidade systemd + script de aplicação          │
│   benchmark/   amostragem + adapters + integração de energia │
│   optimizer/   recomendação baseada em medições              │
└──────────────┬────────────────────────────┬──────────────────┘
               │                            │
   nvidia-smi (leitura, sem privilégio)    │ pkexec → helper privilegiado
                                            │   valida UUID + faixa
                                            │   nvidia-smi -i <uuid> -pl <W>
                                            ▼
                                   driver NVIDIA
```

---

## Testes

```bash
npm test             # vitest — 450 testes, 30 arquivos
npm run typecheck    # main + preload + renderer + testes
```

Cobertura: parsing do `nvidia-smi`, telemetria, validação de limites, power limit, restauração de padrões, persistência systemd, erros de permissão, perda de GPU, benchmark, cálculo de energia, otimizador, adapters, e a **camada de interface** (renderização de números, comparabilidade de execuções, estados de erro).

Os testes **nunca exigem GPU real** nem alteram o hardware.

---

## Desenvolvimento

```bash
npm install
npm run dev          # tsc --watch + Vite + Electron
npm run build        # renderer (Vite) + main (tsc) + preload (Vite)
npm start            # executa o app compilado
npm start -- --simulate
```

Verificação visual do app real, headless:

```bash
node scripts/capture-app.mjs --out /tmp/gpupm --shots 2
```

---

## Stack

**Electron 33** · **React 18** · **TypeScript 5.7** · **Vite 6** · **Tailwind CSS 3.4** · **shadcn/ui** (Radix) · **Recharts** · **Zustand** · **Vitest** · **electron-builder**

---

## Licença

Apache-2.0 — veja [`LICENSE`](LICENSE).

Copyright © 2026 Anderson Narciso.
