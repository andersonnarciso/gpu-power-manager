# Remoção

Procedimento completo para desinstalar o **GPU Power Manager** e restaurar o sistema ao estado anterior.

> **Importante:** remover o app ou o serviço **não** restaura automaticamente os limites de potência das GPUs. O *power limit* aplicado é gravado no hardware/driver e sobrevive à desinstalação. A seção 5 restaura os padrões de fábrica.

---

## 1. Remover via aplicativo

1. Abra **Configurações → Serviço privilegiado**.
2. Clique em **Remover serviço privilegiado** (requer autenticação administrativa).
3. Em **Configurações → Persistência**, desative **Aplicar perfil automaticamente ao iniciar o Linux**.

---

## 2. Remover via linha de comando

### 2.1 Desabilitar e parar a persistência

```bash
sudo systemctl disable --now gpu-power-manager-persist.service
```

### 2.2 Remover os arquivos do serviço

```bash
sudo rm -f /etc/systemd/system/gpu-power-manager-persist.service
sudo rm -f /usr/local/lib/gpu-power-manager/gpu-power-manager-apply.py
sudo rm -rf /usr/local/lib/gpu-power-manager
sudo rm -rf /var/lib/gpu-power-manager
sudo systemctl daemon-reload
sudo systemctl reset-failed
```

### 2.3 Remover o helper privilegiado e a política polkit

```bash
sudo rm -f /usr/local/libexec/gpu-power-manager-helper
sudo rm -f /usr/share/polkit-1/actions/com.gpupowermanager.policy
```

### 2.4 Remover o aplicativo

```bash
# Ubuntu / Debian
sudo apt remove gpu-power-manager
sudo apt autoremove

# AppImage — basta apagar o arquivo
rm -f GPU-Power-Manager-*.AppImage
```

### 2.5 Remover os dados do usuário (opcional)

```bash
rm -rf ~/.config/GPU\ Power\ Manager
rm -rf ~/.config/gpu-power-manager
```

> Os perfis, o histórico de benchmark e as preferências ficam no diretório de dados do app. Apagar esse diretório remove tudo.

---

## 3. Verificar que nada restou

```bash
ls /usr/local/libexec/ | grep -i gpu-power-manager   # vazio
ls /etc/systemd/system/ | grep -i gpu-power-manager   # vazio
ls /usr/share/polkit-1/actions/ | grep -i gpupower     # vazio
systemctl list-unit-files | grep -i gpu-power-manager  # vazio
```

---

## 4. Remover o código-fonte

```bash
cd "/home/anderson/Projetos/Electron Comfyui"
rm -rf node_modules out dist release
```

---

## 5. Restaurar os limites de potência padrão

Esta é a parte que realmente importa: o *power limit* fica gravado na GPU, não no app.

Para cada GPU, consulte o padrão e restaure:

```bash
nvidia-smi --query-gpu=uuid,name,power.limit,power.default_limit --format=csv
```

```bash
nvidia-smi -i GPU-e446ad0d-23c5-4ba3-93ad-e02de3969646 -pl 180
nvidia-smi -i GPU-ff55d89d-783a-8b9e-c442-155cf9a971f1 -pl 285
```

> Substitua os valores pelo `power.default_limit` real da sua GPU. Aplicar um valor fora de `[min_limit, max_limit]` é recusado pelo driver.

Se você registrou um helper antes de removê-lo, ele também faz isso:

```bash
sudo /usr/local/libexec/gpu-power-manager-helper --reset --uuid GPU-<uuid>
```

Confirme o resultado:

```bash
nvidia-smi --query-gpu=uuid,power.limit,power.default_limit --format=csv
```

---

## 6. Checklist final

- [ ] Unidade systemd desabilitada e removida
- [ ] Script de aplicação removido
- [ ] Helper privilegiado removido
- [ ] Política polkit removida
- [ ] App (.deb / AppImage) removido
- [ ] Dados do usuário apagados (opcional)
- [ ] **Limites de potência restaurados no padrão de fábrica**
- [ ] `systemctl daemon-reload` executado

---

Veja também: [`INSTALL.md`](INSTALL.md) · [`SECURITY.md`](SECURITY.md)
