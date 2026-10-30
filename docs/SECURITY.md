# Modelo de Segurança

Este documento descreve as garantias de segurança do **GPU Power Manager** e como elas são implementadas e verificadas.

---

## 1. Princípios

1. **O app Electron nunca roda como root.** Toda operação privilegiada é delegada a um helper separado, acionado via `pkexec` e autorizado pelo **polkit**.
2. **A interface é entrada não confiável.** Nenhum valor vindo do renderer é usado antes de ser validado no processo main.
3. **Nenhuma string de shell é montada com entrada do usuário.** Todo comando externo é executado com `execFile` e um **argv array**.
4. **Privilégio mínimo.** O helper faz exatamente uma coisa — ajustar o power limit — e nada mais.
5. **Nada de BIOS, firmware ou tensão.** O app não toca em volts, clocks ou firmware.

---

## 2. Superfície de ataque e mitigações

| Vetor | Mitigação |
|---|---|
| Renderer comprometido | `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; preload expõe uma API fechada |
| IPC malicioso | Todos os payloads são validados por tipo/formato antes de qualquer efeito |
| Injeção de shell | `execFile` com argv array; `shell: true` nunca é usado |
| UUID malicioso | Regex estrita `GPU-<8>-<4>-<4>-<4>-<12>` validada no main **e** no helper |
| Valor de watts fora de faixa | Faixa real do driver consultada; valor **rejeitado**, nunca ajustado silenciosamente |
| Escalação via helper | Helper instalado como `root:root` `0755`; o instalador **verifica** e aborta se estiver incorreto |
| Escalação via sudo | `sudo` sem senha **nunca** é configurado; tudo passa pelo polkit |
| Escalação via systemd | Unidade `0644` root-owned; o payload do perfil é `root:root` `0644` |
| Navegação externa | `will-navigate` e `setWindowOpenHandler` bloqueados; CSP restritiva |
| Carregamento remoto | `webSecurity` ligado; `setWindowOpenHandler` retorna `deny` |
| Denial of service | Timeouts em toda chamada externa; polling sem sobreposição |
| Vazamento de segredo | Nenhuma credencial é armazenada, lida ou exibida |
| Clipboard do usuário | Toda permissão do Chromium é negada por padrão; **apenas a escrita** (`clipboard-write`) é liberada, para o botão "copiar". A **leitura** (`clipboard-read`) permanece negada — o aplicativo nunca lê o que o usuário copiou |

---

## 3. Modelo de privilégios

```
┌─────────────────────────┐   usuário normal
│  Electron (renderer)    │   sem privilégios
│  Electron (main)        │   sem privilégios
└───────────┬─────────────┘
            │ pkexec  (polkit: auth_admin)
            ▼
┌─────────────────────────┐   root
│  helper privilegiado    │   único binário privilegiado
│    → valida UUID       │
│    → valida faixa      │
│    → nvidia-smi -pl     │
└─────────────────────────┘
```

O helper é a **única** superfície com privilégio administrativo. Ele:

- aceita apenas `--uuid`, `--watts`, `--reset` e `--print-limits`;
- re-lê os limites reais do driver **antes** de alterar qualquer coisa;
- recusa valores fora de `[power.min_limit, power.max_limit]`;
- executa `nvidia-smi` com `subprocess.run([...])` e `shell=False`;
- **re-lê o limite depois** e reporta falha se não confirmar;
- imprime JSON estruturado em stdout e log em stderr (→ journald).

### Por que o helper revalida

O main process já validou o pedido. A revalidação no helper existe porque **entre** a validação no main e a execução, o estado do driver pode ter mudado (outro processo aplicou um limite, o usuário trocou de GPU, o driver foi recarregado). O helper confia no driver, não no main.

---

## 4. Canais IPC

A lista completa vive em `src/shared/ipc.ts`. Cada canal:

1. valida a forma do payload (`src/shared/validation.ts`);
2. chama o serviço correspondente;
3. devolve um resultado tipado ou um `AppError` com código legível.

O renderer **não** tem acesso a `ipcRenderer`, `require`, `process` ou `fs`. A ponte `contextBridge` expõe apenas métodos nomeados, sem canal genérico ("invoke anything").

---

## 5. Persistência

| Item | Garantia |
|---|---|
| Unidade systemd | `0644`, `root:root`, em `/etc/systemd/system/` |
| Script de aplicação | `0755`, `root:root`, em `/usr/local/lib/gpu-power-manager/` |
| Payload do perfil | `0644`, `root:root`, em `/var/lib/gpu-power-manager/` |
| Escopo | O script só aplica limites de GPUs listadas no payload, validados contra o driver |

A persistência é **desativada por padrão** e requer autorização administrativa para ser habilitada.

---

## 6. O que o app deliberadamente NÃO faz

- ❌ Não executa o Electron como root.
- ❌ Não configura `sudo` sem senha nem edita `/etc/sudoers`.
- ❌ Não aceita comandos arbitrários vindos da interface.
- ❌ Não modifica BIOS, firmware, VBIOS ou tensão elétrica.
- ❌ Não implementa *undervolting* real (o app não promete esse recurso).
- ❌ Não confunde redução de power limit com redução de tensão — são coisas diferentes e a interface as trata separadamente.
- ❌ Não implementa *overclocking* nesta versão.
- ❌ Não encerra processos automaticamente.
- ❌ Não altera o power limit com base no nome de um processo.
- ❌ Não inventa números de desempenho, economia ou tokens/s.
- ❌ Não habilita Coolbits para o que não precisa dele.

---

## 7. Verificação

```bash
# o app não está rodando como root
ps -o user= -C gpu-power-manager

# o helper é root-owned e não é gravável pelo grupo
ls -l /usr/local/libexec/gpu-power-manager-helper

# a política polkit existe e exige admin
pkaction | grep gpupowermanager

# nenhuma string de shell concatenada com entrada do usuário
grep -rn "exec(" src/main/ | grep -v "execFile"   # deve ser vazio
grep -rn "shell: true" src/                        # deve ser vazio
grep -rn "\${" src/main/ | grep -i "uuid\|watts"   # deve ser vazio
```

Os testes automatizados cobrem: validação de UUID, validação de Watts, rejeição de valores fora de faixa, construção do argv do helper, mapeamento de falhas do `pkexec`, verificação pós-alteração, e a recusa do instalador quando o helper não é root-owned.

---

## 8. Relato de vulnerabilidade

Problemas de segurança devem ser reportados ao mantenedor do repositório com: passos de reprodução, impacto e versão afetada.
