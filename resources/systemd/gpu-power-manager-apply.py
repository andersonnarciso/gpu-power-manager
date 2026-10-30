#!/usr/bin/env python3
"""GPU Power Manager - aplica os limites de potência do perfil no boot.

Este utilitário é iniciado pelo serviço do systemd
``gpu-power-manager-persist.service`` como root. Ele **não** depende do
aplicativo Electron: funciona mesmo com o aplicativo fechado.

O que ele faz:

  1. espera o driver NVIDIA ficar disponível (tempo limitado);
  2. lê o payload gravado pelo aplicativo em
     ``/var/lib/gpu-power-manager/profile.json``;
  3. lê novamente, no driver, os limites aceitos por cada GPU;
  4. resolve a estratégia de cada entrada (``default``, ``min``, ``ratio`` ou
     ``fixed``) contra esses limites e valida a faixa;
  5. aplica com ``nvidia-smi -i <uuid> -pl <watts>`` (argv, sem shell);
  6. grava ``lastAppliedAt`` / ``lastError`` no payload.

Todas as mensagens vão para a saída de erro (stderr), para aparecerem no
journal:

    journalctl -u gpu-power-manager-persist.service

O script é idempotente: pode rodar em toda inicialização sem problema.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time

DEFAULT_STATE_FILE = "/var/lib/gpu-power-manager/profile.json"
DEFAULT_NVIDIA_SMI = "/usr/bin/nvidia-smi"
DEFAULT_DEVICE_NODE = "/dev/nvidiactl"
DEFAULT_TIMEOUT = 120.0
DEFAULT_POLL_INTERVAL = 2.0

STRATEGIES = ("default", "min", "ratio", "fixed")


def log(message):
    """Escreve no stderr, para que a mensagem vá para o journal."""
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    sys.stderr.write("[gpu-power-manager] %s %s\n" % (stamp, message))
    sys.stderr.flush()


def run(command):
    """Executa um comando com uma lista de argumentos. O shell nunca é usado."""
    try:
        completed = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            universal_newlines=True,
            shell=False,
            check=False,
        )
    except OSError as error:
        return 127, "", str(error)
    return completed.returncode, completed.stdout, completed.stderr


def wait_for_driver(nvidia_smi, timeout, poll_interval, device_node):
    """Espera o driver NVIDIA responder. A espera tem tempo limite."""
    started = time.monotonic()
    deadline = started + timeout
    attempts = 0
    last_error = ""

    while True:
        attempts += 1
        code, stdout, stderr = run([nvidia_smi, "-L"])

        if code == 0 and stdout.strip() != "":
            present = os.path.exists(device_node)
            extra = "" if present else " (%s ausente)" % device_node
            log(
                "Driver NVIDIA disponível após %d tentativa(s) em %ds%s"
                % (attempts, int(time.monotonic() - started), extra)
            )
            return True

        if stderr.strip() != "":
            last_error = stderr.strip()

        remaining = deadline - time.monotonic()
        if remaining <= 0:
            log(
                "O driver NVIDIA não ficou disponível em %ds.%s"
                % (
                    int(timeout),
                    (" Última mensagem: %s" % last_error) if last_error else "",
                )
            )
            return False

        log(
            "Aguardando o driver NVIDIA (tentativa %d, %ds restantes)."
            % (attempts, int(remaining))
        )
        time.sleep(min(poll_interval, remaining))


def query_limits(nvidia_smi):
    """Lê do driver os limites de potência aceitos por cada GPU."""
    code, stdout, stderr = run(
        [
            nvidia_smi,
            "--query-gpu=uuid,power.min_limit,power.max_limit,power.default_limit",
            "--format=csv,noheader,nounits",
        ]
    )
    if code != 0:
        raise RuntimeError(stderr.strip() or "nvidia-smi --query-gpu falhou")

    limits = {}
    for raw_line in stdout.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        parts = [part.strip() for part in line.split(",")]
        if len(parts) < 4:
            continue
        try:
            minimum = int(float(parts[1]))
            maximum = int(float(parts[2]))
            default = int(float(parts[3]))
        except ValueError:
            continue
        limits[parts[0]] = (minimum, maximum, default)
    return limits


def effective_max(minimum, maximum, default):
    """O limite nunca sobe acima do padrão de fábrica da placa."""
    if default is not None and default < maximum:
        return default
    return maximum


def resolve_watts(entry, limits):
    """Resolve uma entrada do perfil. Devolve (watts, motivo_da_falha)."""
    uuid = entry.get("uuid", "")
    if uuid not in limits:
        return None, "A GPU não está presente neste computador."

    minimum, maximum, default = limits[uuid]
    maximum = effective_max(minimum, maximum, default)

    watts = entry.get("watts")
    strategy = entry.get("strategy")
    if not strategy:
        strategy = "fixed" if watts is not None else "default"

    if strategy == "default":
        if default is None:
            return None, "O driver não informou o limite padrão desta GPU."
        return max(minimum, min(int(default), maximum)), ""
    if strategy == "min":
        return minimum, ""
    if strategy == "ratio":
        ratio = entry.get("ratio")
        if ratio is None or ratio <= 0 or ratio > 1:
            return None, "A proporção do perfil deve estar entre 0 e 1."
        value = minimum + ratio * (maximum - minimum)
        return max(minimum, min(int(round(value)), maximum)), ""
    if strategy == "fixed":
        if watts is None:
            return None, "O limite fixo do perfil não foi informado."
        watts = int(watts)
        if watts < minimum or watts > maximum:
            return (
                None,
                "O limite fixo de %d W está fora da faixa aceita (%d–%d W)."
                % (watts, minimum, maximum),
            )
        return watts, ""
    return None, "Estratégia de perfil desconhecida."


def read_state(state_file):
    """Lê o payload gravado pelo aplicativo."""
    try:
        with open(state_file, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, ValueError) as error:
        log("Não foi possível ler o perfil em %s: %s" % (state_file, error))
        return None
    if not isinstance(payload, dict):
        log("O arquivo de perfil em %s tem um formato desconhecido." % state_file)
        return None
    return payload


def write_state(state_file, payload):
    """Grava o payload de forma atômica, mantendo o modo 0644."""
    directory = os.path.dirname(state_file) or "."
    handle = tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=directory,
        prefix=".profile.json.",
        delete=False,
    )
    try:
        with handle:
            handle.write(json.dumps(payload, indent=2, ensure_ascii=False))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(handle.name, 0o644)
        os.replace(handle.name, state_file)
    except BaseException:
        try:
            os.unlink(handle.name)
        except OSError:
            pass
        raise


def apply_payload(payload, nvidia_smi, dry_run):
    """Aplica o perfil. Devolve (aplicados, ignorados, falhas)."""
    limits = query_limits(nvidia_smi)
    applied = []
    skipped = []
    failed = []

    for entry in payload.get("entries", []):
        uuid = entry.get("uuid", "")
        watts, reason = resolve_watts(entry, limits)

        if watts is None:
            skipped.append((uuid, reason))
            log("%s: ignorado — %s" % (uuid, reason))
            continue

        if dry_run:
            applied.append((uuid, watts))
            log("(dry-run) %s: %d W" % (uuid, watts))
            continue

        code, stdout, stderr = run([nvidia_smi, "-i", uuid, "-pl", str(watts)])
        if code != 0:
            message = stderr.strip() or stdout.strip() or "nvidia-smi falhou"
            failed.append((uuid, message))
            log("%s: falha ao aplicar %d W — %s" % (uuid, watts, message))
            continue

        applied.append((uuid, watts))
        log("%s: limite aplicado em %d W" % (uuid, watts))

    return applied, skipped, failed


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Aplica os limites de potência do GPU Power Manager."
    )
    parser.add_argument("--state-file", default=DEFAULT_STATE_FILE)
    parser.add_argument("--nvidia-smi", default=DEFAULT_NVIDIA_SMI)
    parser.add_argument("--device-node", default=DEFAULT_DEVICE_NODE)
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    parser.add_argument("--poll-interval", type=float, default=DEFAULT_POLL_INTERVAL)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Valida o perfil e mostra o que seria aplicado, sem alterar nada.",
    )
    args = parser.parse_args(argv)

    payload = read_state(args.state_file)
    if payload is None:
        return 2

    log(
        "Perfil \"%s\" (%s), %d GPU(s)."
        % (
            payload.get("profileName", ""),
            payload.get("profileId", ""),
            len(payload.get("entries", [])),
        )
    )

    if not wait_for_driver(
        args.nvidia_smi, args.timeout, args.poll_interval, args.device_node
    ):
        return 3

    try:
        applied, skipped, failed = apply_payload(payload, args.nvidia_smi, args.dry_run)
    except RuntimeError as error:
        log("Falha ao ler os limites do driver: %s" % error)
        return 4

    for uuid, reason in skipped:
        log("Aviso: %s não foi aplicada — %s" % (uuid, reason))

    if not args.dry_run:
        payload["lastAppliedAt"] = int(time.time() * 1000)
        payload["lastError"] = failed[0][1] if failed else None
        try:
            write_state(args.state_file, payload)
        except OSError as error:
            log("Não foi possível atualizar o arquivo de perfil: %s" % error)

    log(
        "Resumo: %d aplicada(s), %d ignorada(s), %d falha(s)."
        % (len(applied), len(skipped), len(failed))
    )

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
