#!/usr/bin/env python3
"""Privileged helper of the GPU Power Manager.

This is the only component allowed to change the power limit of an NVIDIA GPU.
It is installed root owned, with mode 0755, inside a root only writable
directory and it is executed through `pkexec`, so polkit asks the user for
administrator authorization before anything happens.

Design rules:
  - the accepted arguments are fixed and strictly validated;
  - every external command is executed with an argument list, never with a
    shell string;
  - the live limits are read again right before the change, and the result is
    read back right after it, so a change is only reported as successful when
    the driver confirms it;
  - a single JSON object is written to stdout, human readable details go to
    stderr (so journald/systemd capture them).

Exit codes:
  0  success
  2  validation error
  3  unsupported by this GPU/driver
  4  driver command failed
  5  verification mismatch
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys

EXIT_OK = 0
EXIT_VALIDATION = 2
EXIT_UNSUPPORTED = 3
EXIT_DRIVER = 4
EXIT_VERIFICATION = 5

UUID_RE = re.compile(
    r"^GPU-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
WATTS_RE = re.compile(r"^[0-9]{1,4}$")

QUERY_FIELDS = "uuid,name,power.min_limit,power.default_limit,power.max_limit,power.limit"
NVIDIA_SMI_CANDIDATES = (
    "/usr/bin/nvidia-smi",
    "/usr/local/bin/nvidia-smi",
    "/usr/sbin/nvidia-smi",
)
COMMAND_TIMEOUT_SECONDS = 60


class HelperError(Exception):
    """Error that carries the machine readable code and the exit code."""

    def __init__(self, code, message, exit_code, detail=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.exit_code = exit_code
        self.detail = detail


class ArgumentParser(argparse.ArgumentParser):
    """Parser that reports usage problems as a regular helper error."""

    def error(self, message):
        raise HelperError(
            "VALIDATION_FAILED",
            "Argumentos inválidos: %s" % message,
            EXIT_VALIDATION,
        )


def log(message):
    """Writes a human readable line to stderr."""
    text = (message or "").strip()
    if not text:
        return
    sys.stderr.write("gpu-power-manager-helper: %s\n" % text)
    sys.stderr.flush()


def emit(payload):
    """Writes the single JSON object of this run to stdout."""
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def fail(error):
    """Prints the error object and returns the exit code."""
    payload = {
        "ok": False,
        "error": {"code": error.code, "message": error.message},
        "message": error.message,
    }
    emit(payload)
    log(error.message)
    if error.detail:
        log(error.detail)
    return error.exit_code


def find_nvidia_smi():
    """Absolute path of the nvidia-smi binary."""
    for candidate in NVIDIA_SMI_CANDIDATES:
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    found = shutil.which("nvidia-smi")
    if found:
        return found
    raise HelperError(
        "DRIVER_UNAVAILABLE",
        "O utilitário nvidia-smi não foi encontrado neste sistema.",
        EXIT_DRIVER,
    )


def parse_watt(raw):
    """Parses one numeric field of the CSV output. `[N/A]` becomes None."""
    value = (raw or "").strip()
    if value in ("", "N/A", "[N/A]"):
        return None
    try:
        return int(round(float(value)))
    except ValueError:
        return None


def parse_limits(stdout):
    """Parses the CSV produced by `nvidia-smi --query-gpu`."""
    gpus = []
    for line in (stdout or "").splitlines():
        line = line.strip()
        if not line:
            continue
        fields = [field.strip() for field in line.split(",")]
        if len(fields) < 6:
            continue
        uuid = fields[0]
        if not uuid.startswith("GPU-"):
            continue
        gpus.append(
            {
                "uuid": uuid,
                "name": " ".join(fields[1:-4]),
                "minWatts": parse_watt(fields[-4]),
                "defaultWatts": parse_watt(fields[-3]),
                "maxWatts": parse_watt(fields[-2]),
                "currentWatts": parse_watt(fields[-1]),
            }
        )
    return gpus


def query_limits(smi, uuid=None):
    """Reads the live limits of every GPU, or of a single one."""
    args = [smi]
    if uuid is not None:
        args += ["-i", uuid]
    args += ["--query-gpu=" + QUERY_FIELDS, "--format=csv,noheader,nounits"]
    try:
        # Argument list, never a shell string.
        completed = subprocess.run(
            args,
            shell=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            universal_newlines=True,
            timeout=COMMAND_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        raise HelperError(
            "TIMEOUT",
            "O driver NVIDIA não respondeu a tempo.",
            EXIT_DRIVER,
        )
    except OSError as exc:
        raise HelperError(
            "DRIVER_UNAVAILABLE",
            "Não foi possível executar o nvidia-smi: %s" % exc,
            EXIT_DRIVER,
        )

    if completed.returncode != 0:
        stderr = (completed.stderr or "").strip()
        if "No devices were found" in stderr:
            raise HelperError(
                "GPU_NOT_FOUND",
                "A GPU %s não foi encontrada pelo driver NVIDIA." % (uuid or ""),
                EXIT_UNSUPPORTED,
            )
        raise HelperError(
            "COMMAND_FAILED",
            "A consulta ao driver NVIDIA falhou.",
            EXIT_DRIVER,
            detail=stderr,
        )
    return parse_limits(completed.stdout)


def set_power_limit(smi, uuid, watts):
    """Asks the driver to apply a new power limit."""
    try:
        # Argument list, never a shell string.
        completed = subprocess.run(
            [smi, "-i", uuid, "-pl", str(watts)],
            shell=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            universal_newlines=True,
            timeout=COMMAND_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        raise HelperError(
            "TIMEOUT",
            "O driver NVIDIA não respondeu a tempo durante a alteração.",
            EXIT_DRIVER,
        )
    except OSError as exc:
        raise HelperError(
            "DRIVER_UNAVAILABLE",
            "Não foi possível executar o nvidia-smi: %s" % exc,
            EXIT_DRIVER,
        )

    output = (completed.stdout or "").strip()
    if completed.returncode != 0:
        raise HelperError(
            "COMMAND_FAILED",
            "O driver recusou a alteração do limite de potência para %d W." % watts,
            EXIT_DRIVER,
            detail=(completed.stderr or "").strip() or output,
        )
    if output:
        log(output)


def build_parser():
    """Builds the argument parser. Only the documented options exist."""
    parser = ArgumentParser(prog="gpu-power-manager-helper", add_help=False)
    parser.add_argument("--uuid", dest="uuid")
    parser.add_argument("--watts", dest="watts")
    parser.add_argument("--reset", dest="reset", action="store_true")
    parser.add_argument("--print-limits", dest="print_limits", action="store_true")
    return parser


def validate_arguments(args):
    """Validates the argument combination and the value formats."""
    if args.print_limits and (args.watts is not None or args.reset):
        raise HelperError(
            "VALIDATION_FAILED",
            "--print-limits não pode ser combinado com --watts ou --reset.",
            EXIT_VALIDATION,
        )
    if args.reset and args.watts is not None:
        raise HelperError(
            "VALIDATION_FAILED",
            "--reset não pode ser combinado com --watts.",
            EXIT_VALIDATION,
        )
    if not args.print_limits and args.uuid is None:
        raise HelperError(
            "VALIDATION_FAILED",
            "É necessário informar --uuid.",
            EXIT_VALIDATION,
        )
    if args.watts is None and not args.reset and not args.print_limits:
        raise HelperError(
            "VALIDATION_FAILED",
            "É necessário informar --watts, --reset ou --print-limits.",
            EXIT_VALIDATION,
        )
    if args.uuid is not None and not UUID_RE.match(args.uuid):
        raise HelperError(
            "VALIDATION_FAILED",
            "Identificador de GPU inválido: %s" % args.uuid,
            EXIT_VALIDATION,
        )
    if args.watts is not None:
        if not WATTS_RE.match(args.watts):
            raise HelperError(
                "VALIDATION_FAILED",
                "O limite de potência deve ser um número inteiro de watts.",
                EXIT_VALIDATION,
            )
        if int(args.watts) < 1:
            raise HelperError(
                "VALIDATION_FAILED",
                "O limite de potência deve ser maior que zero.",
                EXIT_VALIDATION,
            )


def run(argv):
    """Runs the helper and returns its exit code."""
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
    except HelperError as error:
        return fail(error)

    try:
        validate_arguments(args)
    except HelperError as error:
        return fail(error)

    target_watts = int(args.watts) if args.watts is not None else None

    try:
        smi = find_nvidia_smi()

        if args.print_limits:
            gpus = query_limits(smi, args.uuid)
            payload = {"ok": True, "gpus": gpus}
            if args.uuid is not None:
                payload["uuid"] = args.uuid
            emit(payload)
            log("Limites lidos de %d GPU(s)." % len(gpus))
            return EXIT_OK

        # The live limits are read again right before the change.
        gpus = query_limits(smi, args.uuid)
        if not gpus:
            return fail(
                HelperError(
                    "GPU_NOT_FOUND",
                    "A GPU %s não foi encontrada pelo driver NVIDIA." % args.uuid,
                    EXIT_UNSUPPORTED,
                )
            )
        gpu = gpus[0]
        minimum = gpu["minWatts"]
        maximum = gpu["maxWatts"]
        default_limit = gpu["defaultWatts"]

        if minimum is None or maximum is None:
            return fail(
                HelperError(
                    "UNSUPPORTED_BY_DRIVER",
                    "O driver não informa a faixa de limite de potência desta GPU.",
                    EXIT_UNSUPPORTED,
                )
            )

        if args.reset:
            if default_limit is None:
                return fail(
                    HelperError(
                        "UNSUPPORTED_BY_DRIVER",
                        "O driver não informa o limite de potência padrão desta GPU.",
                        EXIT_UNSUPPORTED,
                    )
                )
            target_watts = default_limit

        # The value is refused, never clamped.
        if target_watts < minimum or target_watts > maximum:
            return fail(
                HelperError(
                    "VALIDATION_FAILED",
                    "O limite de %d W está fora da faixa suportada por esta GPU (%d–%d W)."
                    % (target_watts, minimum, maximum),
                    EXIT_VALIDATION,
                )
            )

        if getattr(os, "geteuid", lambda: 0)() != 0:
            return fail(
                HelperError(
                    "PERMISSION_DENIED",
                    "Este utilitário precisa ser executado com privilégios de root (use pkexec).",
                    EXIT_DRIVER,
                )
            )

        set_power_limit(smi, gpu["uuid"], target_watts)

        # The result is read back so the change is only reported when the
        # driver confirms it.
        after = query_limits(smi, gpu["uuid"])
        observed = after[0]["currentWatts"] if after else None
        if observed != target_watts:
            return fail(
                HelperError(
                    "COMMAND_FAILED",
                    "O driver informou %s W depois da alteração, mas foram pedidos %d W."
                    % (observed, target_watts),
                    EXIT_VERIFICATION,
                )
            )

        emit(
            {
                "ok": True,
                "uuid": gpu["uuid"],
                "appliedWatts": target_watts,
                "verified": True,
            }
        )
        log("Limite de %d W aplicado e confirmado na GPU %s." % (target_watts, gpu["uuid"]))
        return EXIT_OK
    except HelperError as error:
        return fail(error)


def main(argv):
    """Entry point that turns every failure into a JSON object plus exit code."""
    try:
        return run(argv)
    except HelperError as error:
        return fail(error)
    except Exception as exc:  # unexpected failure, still reported as JSON
        return fail(
            HelperError(
                "UNKNOWN",
                "Erro inesperado no utilitário privilegiado: %s" % exc,
                EXIT_DRIVER,
            )
        )


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
