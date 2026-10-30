# Instalação

Este documento cobre a instalação do **GPU Power Manager** e a habilitação opcional do **serviço privilegiado**, que é o que permite alterar o *power limit* das GPUs.

> O app **nunca** precisa rodar como root. O serviço privilegiado é instalado à parte, com autorização administrativa via polkit.

---

## 1. Pré-requisitos

| Item | Verificação | Comando |
|---|---|---|
| Linux com systemd | obrigatório para persistência | `systemctl --version` |
| Driver NVIDIA proprietário | obrigatório para detecção | `nvidia-smi -L` |
| `nvidia-smi` no PATH | obrigatório | `command -v nvidia-smi` |
| polkit + `pkexec` | para o serviço privilegiado | `command -v pkexec && ls /usr/share/polkit-1/actions` |
| Node >= 20 | apenas para desenvolvimento | `node -v` |

Instalação dos requisitos no Ubuntu/Debian:

```bash
sudo apt update
sudo apt install nvidia-utils policykit-1
```

---

## 2. Instalar o aplicativo

### Opção A: AppImage (não requer instalação)

```bash
chmod +x GPU-Power-Manager-1.0.1-x86_64.AppImage
./GPU-Power-Manager-1.0.1-x86_64.AppImage
```

O AppImage é autocontido. Roda em modo **somente leitura** até que o serviço privilegiado seja instalado.

### Opção B: pacote `.deb`

```bash
sudo apt install ./gpu-power-manager_1.0.1_amd64.deb
```

Dependências declaradas no pacote: `nvidia-utils` (ou `libnvidia-ml1`), `python3` (usado pelo helper privilegiado) e `policykit-1`.

### Opção C: a partir do código

```bash
npm install
npm run build
npm start
```

---

## 3. Habilitar o controle de potência

### 3.1 Pelo aplicativo

1. Abra **Configurações → Serviço privilegiado**.
2. Clique em **Instalar serviço privilegiado**.
3. Autentique-se no diálogo do polkit (pede a senha de administrador).

O instalador faz:

| Arquivo | Destino | Dono | Modo |
|---|---|---|---|
| `gpu-power-manager-helper` | `/usr/local/libexec/gpu-power-manager-helper` | `root:root` | `0755` |
| `com.gpupowermanager.policy` | `/usr/share/polkit-1/actions/com.gpupowermanager.policy` | `root:root` | `0644` |

Depois de instalar, o app **verifica dono e modo** dos arquivos. Se o helper estiver gravável por usuários comuns, a instalação é abortada: um binário privilegiado gravável pelo usuário é uma escalação de privilégio.

### 3.2 Pela linha de comando

```bash
sudo install -o root -g root -m 0755 \
  resources/helper/gpu-power-manager-helper.py \
  /usr/local/libexec/gpu-power-manager-helper

sudo install -o root -g root -m 0644 \
  resources/polkit/com.gpupowermanager.policy \
  /usr/share/polkit-1/actions/com.gpupowermanager.policy
```

### 3.3 Ações polkit instaladas

| Ação | Uso | Autorização |
|---|---|---|
| `com.gpupowermanager.set-power-limit` | alterar power limit | `auth_admin` |
| `com.gpupowermanager.install-helper` | instalar/remover o helper | `auth_admin` |
| `com.gpupowermanager.manage-persistence` | gerenciar a unidade systemd | `auth_admin` |

**`sudo` sem senha nunca é configurado.** Toda operação privilegiada passa pelo polkit, que exibe a autenticação no ambiente gráfico.

---

## 4. Habilitar a persistência no boot

Opcional e **desativada por padrão**.

1. Em **Perfis**, crie ou escolha o perfil desejado.
2. Em **Configurações → Persistência**, selecione o perfil e ative **Aplicar perfil automaticamente ao iniciar o Linux**.
3. Confirme a autenticação administrativa.

O que é criado:

| Caminho | Conteúdo | Dono | Modo |
|---|---|---|---|
| `/etc/systemd/system/gpu-power-manager-persist.service` | unidade systemd | `root:root` | `0644` |
| `/usr/local/lib/gpu-power-manager/gpu-power-manager-apply.py` | script de aplicação | `root:root` | `0755` |
| `/var/lib/gpu-power-manager/profile.json` | perfil a aplicar | `root:root` | `0644` |

Comandos de verificação:

```bash
systemctl is-enabled gpu-power-manager-persist.service
systemctl status gpu-power-manager-persist.service
journalctl -u gpu-power-manager-persist.service -b
```

No boot, o script:

1. **aguarda o driver NVIDIA ficar disponível** (com timeout limitado), e só então aplica os limites;
2. lê o perfil;
3. **revalida cada valor contra os limites reais** da GPU correspondente;
4. aplica com `nvidia-smi -i <uuid> -pl <watts>`;
5. registra tudo no journal.

O processo Electron **não precisa estar em execução** para a persistência funcionar.

---

## 5. Permissões do usuário

O app roda com o usuário normal. Para que o polkit libere as ações administrativas, o usuário precisa pertencer a um grupo administrativo:

| Distribuição | Grupo |
|---|---|
| Ubuntu / Debian | `sudo` |
| Fedora | `wheel` |
| Arch | `wheel` |
| openSUSE | `wheel` |

```bash
sudo usermod -aG sudo "$USER"   # Ubuntu/Debian
# encerre a sessão e entre novamente
```

---

## 6. Verificação

```bash
# o helper está instalado e é root-owned, sem escrita para o grupo?
ls -l /usr/local/libexec/gpu-power-manager-helper

# a política polkit foi reconhecida?
pkaction | grep gpupowermanager

# o helper lê os limites reais das GPUs?
/usr/local/libexec/gpu-power-manager-helper --print-limits

# a persistência está habilitada?
systemctl is-enabled gpu-power-manager-persist.service
```

---

## 7. Problemas na instalação

| Erro | Causa | Solução |
|---|---|---|
| `pkexec` não encontrado | polkit ausente | `sudo apt install policykit-1` |
| `pkexec must be setuid root` | polkit mal instalado | `sudo apt reinstall policykit-1` |
| diálogo do polkit não aparece | sessão sem agente polkit (headless/SSH) | execute a partir de um login gráfico; para ambientes headless use o serviço systemd, que não depende do app |
| `Authorization denied` | senha cancelada ou usuário fora do grupo administrativo | verifique `id "$USER"` e reinicie a sessão após entrar no grupo |
| helper instalado mas sem permissão | cópia manual sem `install` | refaça com `sudo install -o root -g root -m 0755` |

---

Veja também: [`REMOVE.md`](REMOVE.md) · [`SECURITY.md`](SECURITY.md)
