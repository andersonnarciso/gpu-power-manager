import { describe, expect, it } from 'vitest';

import {
  GPU_QUERY_FIELDS,
  NvidiaParseError,
  buildThrottleMask,
  isMissingValue,
  isThrottleFlagActive,
  normalizeBusId,
  parseAccountedAppsCsv,
  parseComputeAppsCsv,
  parseCudaVersion,
  parseGpuCsv,
  parseNullableInt,
  parseNullableNumber,
  parseNullableString,
  parsePmonOutput,
  parseThrottleBitmask,
  parseThrottlePerformanceText,
  parseThrottleQueryCsv,
} from '../../src/main/nvidia/parse';
import {
  GPU_4070_UUID,
  GPU_5060_UUID,
  GPU_CSV_WITH_MISSING_VALUES,
  REAL_BANNER,
  REAL_COMPUTE_APPS_CSV,
  REAL_GPU_CSV,
  REAL_PERFORMANCE_OUTPUT,
  REAL_PMON_OUTPUT,
  REAL_THROTTLE_CSV,
  THROTTLE_CSV_ACTIVE,
} from './fixtures';

const AT = 1_700_000_000_000;

describe('parse: valores ausentes', () => {
  it('trata N/A, [N/A], vazio, Not Supported e [Not Supported] como ausentes', () => {
    expect(isMissingValue('N/A')).toBe(true);
    expect(isMissingValue('[N/A]')).toBe(true);
    expect(isMissingValue('')).toBe(true);
    expect(isMissingValue('   ')).toBe(true);
    expect(isMissingValue('Not Supported')).toBe(true);
    expect(isMissingValue('[Not Supported]')).toBe(true);
    expect(isMissingValue('-')).toBe(true);
    expect(isMissingValue(undefined)).toBe(true);
    expect(isMissingValue(null)).toBe(true);
  });

  it('não confunde um valor válido com um ausente', () => {
    expect(isMissingValue('0')).toBe(false);
    expect(isMissingValue('48')).toBe(false);
    expect(isMissingValue('Enabled')).toBe(false);
  });

  it('converte valores numéricos ausentes em null', () => {
    expect(parseNullableNumber('N/A')).toBeNull();
    expect(parseNullableNumber('[N/A]')).toBeNull();
    expect(parseNullableNumber('')).toBeNull();
    expect(parseNullableNumber('Not Supported')).toBeNull();
    expect(parseNullableNumber('nonsense')).toBeNull();
    expect(parseNullableNumber('48')).toBe(48);
    expect(parseNullableNumber(' 8.64 ')).toBe(8.64);
    expect(parseNullableInt('405')).toBe(405);
    expect(parseNullableInt('405.4')).toBe(405);
    expect(parseNullableInt('N/A')).toBeNull();
  });

  it('converte strings ausentes em null e preserva as reais', () => {
    expect(parseNullableString('N/A')).toBeNull();
    expect(parseNullableString('Disabled')).toBe('Disabled');
    expect(parseNullableString('Default')).toBe('Default');
  });
});

describe('parse: CSV real das GPUs', () => {
  const devices = parseGpuCsv(REAL_GPU_CSV, { at: AT, cudaVersion: '13.2' });

  it('encontra as duas GPUs reais', () => {
    expect(devices).toHaveLength(2);
    expect(devices[0]?.uuid).toBe(GPU_4070_UUID);
    expect(devices[1]?.uuid).toBe(GPU_5060_UUID);
  });

  it('lê os dados da RTX 4070 Ti', () => {
    const gpu = devices[0];
    expect(gpu?.name).toBe('NVIDIA GeForce RTX 4070 Ti');
    expect(gpu?.index).toBe(0);
    expect(gpu?.pciBusId).toBe('00000000:01:00.0');
    expect(gpu?.driverVersion).toBe('595.84');
    expect(gpu?.vbiosVersion).toBe('95.04.3C.C0.1A');
    expect(gpu?.memory.totalMiB).toBe(12282);
    expect(gpu?.memory.usedMiB).toBe(2491);
    expect(gpu?.memory.freeMiB).toBe(12282 - 2491);
    expect(gpu?.temperatureC).toBe(48);
    expect(gpu?.cudaVersion).toBe('13.2');
    expect(gpu?.computeMode).toBe('Default');
    expect(gpu?.persistenceMode).toBe('Disabled');
    expect(gpu?.present).toBe(true);
    expect(gpu?.lastSeenAt).toBe(AT);
  });

  it('lê os limites de potência da RTX 4070 Ti', () => {
    const gpu = devices[0];
    expect(gpu?.power.limitW).toBe(285);
    expect(gpu?.power.defaultLimitW).toBe(285);
    expect(gpu?.power.minLimitW).toBe(100);
    expect(gpu?.power.maxLimitW).toBe(285);
    expect(gpu?.power.enforcedLimitW).toBe(285);
    expect(gpu?.capabilities.powerLimitAdjustable).toBe(true);
  });

  it('lê os limites de potência da RTX 5060 Ti', () => {
    const gpu = devices[1];
    expect(gpu?.name).toBe('NVIDIA GeForce RTX 5060 Ti');
    expect(gpu?.memory.totalMiB).toBe(16311);
    expect(gpu?.power.limitW).toBe(180);
    expect(gpu?.power.minLimitW).toBe(150);
    expect(gpu?.power.maxLimitW).toBe(180);
    // min (150 W) != max (180 W): o driver aceita ajustar o limite.
    expect(gpu?.capabilities.powerLimitAdjustable).toBe(true);
  });

  it('mantém a ordem dos campos declarada em GPU_QUERY_FIELDS', () => {
    expect(GPU_QUERY_FIELDS).toHaveLength(24);
    expect(GPU_QUERY_FIELDS[0]).toBe('index');
    expect(GPU_QUERY_FIELDS[2]).toBe('uuid');
    expect(GPU_QUERY_FIELDS[23]).toBe('compute_mode');
  });
});

describe('parse: CSV com campos ausentes', () => {
  it('converte N/A, [N/A] e Not Supported em null', () => {
    const devices = parseGpuCsv(GPU_CSV_WITH_MISSING_VALUES, { at: AT });
    const gpu = devices[0];
    expect(gpu).toBeDefined();
    expect(gpu?.utilizationGpuPercent).toBe(0);
    expect(gpu?.utilizationMemoryPercent).toBe(0);
    expect(gpu?.temperatureC).toBeNull();
    expect(gpu?.power.drawW).toBeNull();
    expect(gpu?.fanSpeedPercent).toBeNull();
    expect(gpu?.persistenceMode).toBe('Enabled');
    expect(gpu?.cudaVersion).toBeNull();
  });

  it('nunca inventa uma velocidade de ventoinha igual a zero', () => {
    const devices = parseGpuCsv(GPU_CSV_WITH_MISSING_VALUES, { at: AT });
    expect(devices[0]?.fanSpeedPercent).not.toBe(0);
  });
});

describe('parse: entradas malformadas', () => {
  it('lança um erro controlado para uma linha truncada', () => {
    const truncated = '0, NVIDIA GeForce RTX 4070 Ti, GPU-ff55d89d-783a-8b9e-c442-155cf9a971f1';
    expect(() => parseGpuCsv(truncated, { at: AT })).toThrow(NvidiaParseError);
    expect(() => parseGpuCsv(truncated, { at: AT })).toThrow(/24/);
  });

  it('lança um erro controlado para um UUID inválido', () => {
    const bad = REAL_GPU_CSV.replace(GPU_4070_UUID, 'not-a-uuid');
    expect(() => parseGpuCsv(bad, { at: AT })).toThrow(NvidiaParseError);
  });

  it('nunca devolve undefined em caso de erro', () => {
    let result: unknown = 'untouched';
    try {
      result = parseGpuCsv('lixo', { at: AT });
    } catch (error) {
      expect(error).toBeInstanceOf(NvidiaParseError);
      expect((error as NvidiaParseError).code).toBe('NVIDIA_PARSE_FAILED');
    }
    expect(result).toBe('untouched');
  });

  it('aceita um payload vazio devolvendo uma lista vazia', () => {
    expect(parseGpuCsv('', { at: AT })).toEqual([]);
    expect(parseGpuCsv('\n\n', { at: AT })).toEqual([]);
  });
});

describe('parse: versão do CUDA', () => {
  it('lê a versão do banner real', () => {
    expect(parseCudaVersion(REAL_BANNER)).toBe('13.2');
  });

  it('lê a versão do relatório -q', () => {
    expect(parseCudaVersion(REAL_PERFORMANCE_OUTPUT)).toBe('13.2');
  });

  it('devolve null quando o banner não existe', () => {
    expect(parseCudaVersion('qualquer coisa')).toBeNull();
    expect(parseCudaVersion('')).toBeNull();
  });
});

describe('parse: motivos de throttling', () => {
  it('lê a query real sem motivos ativos', () => {
    const readings = parseThrottleQueryCsv(REAL_THROTTLE_CSV);
    expect(readings).toHaveLength(2);
    expect(readings[0]?.index).toBe(0);
    expect(readings[0]?.throttle.active).toBe(false);
    expect(readings[0]?.throttle.reasons).toEqual([]);
  });

  it('identifica SW Power Cap ativo', () => {
    const readings = parseThrottleQueryCsv(THROTTLE_CSV_ACTIVE);
    expect(readings[0]?.throttle.active).toBe(true);
    expect(readings[0]?.throttle.reasons).toEqual(['SW Power Cap']);
    expect(readings[0]?.throttle.raw).toBe('0x0000000000000004');
  });

  it('interpreta "Not Active" como inativo', () => {
    expect(isThrottleFlagActive('Not Active')).toBe(false);
    expect(isThrottleFlagActive('Active')).toBe(true);
    expect(isThrottleFlagActive('')).toBe(false);
  });

  it('faz o fallback para a saída -q -d PERFORMANCE', () => {
    const readings = parseThrottlePerformanceText(REAL_PERFORMANCE_OUTPUT);
    expect(readings).toHaveLength(2);
    expect(readings[0]?.busId).toBe('00000000:01:00.0');
    expect(readings[0]?.throttle.reasons).toEqual(['Idle']);
    expect(readings[1]?.throttle.reasons).toEqual([]);
  });

  it('decodifica o bitmask do driver', () => {
    const throttle = parseThrottleBitmask('0x0000000000000004');
    expect(throttle.active).toBe(true);
    expect(throttle.reasons).toEqual(['SW Power Cap']);
    expect(buildThrottleMask(['SW Power Cap'])).toBe('0x0000000000000004');
  });

  it('normaliza o bus id', () => {
    expect(normalizeBusId('00000000:01:00.0')).toBe('0:1:0.0');
    expect(normalizeBusId('0:1:0.0')).toBe('0:1:0.0');
    expect(normalizeBusId('N/A')).toBeNull();
  });
});

describe('parse: processos', () => {
  it('lê as aplicações de compute reais', () => {
    const rows = parseComputeAppsCsv(REAL_COMPUTE_APPS_CSV);
    expect(rows).toHaveLength(9);
    const llama = rows.find((row) => row.pid === 2973 && row.gpuUuid === GPU_4070_UUID);
    expect(llama?.processName).toBe('/home/anderson/llama.cpp/build/bin/llama-server');
    expect(llama?.usedMemoryMiB).toBe(768);
    expect(llama?.type).toBe('compute');
    // O mesmo processo aparece nas duas GPUs.
    expect(rows.filter((row) => row.pid === 2973)).toHaveLength(2);
  });

  it('separa o nome do processo que contém vírgulas', () => {
    const csv = '42, /opt/app/bin/run --list=a,b --other=c, 512, GPU-ff55d89d-783a-8b9e-c442-155cf9a971f1';
    const rows = parseComputeAppsCsv(csv);
    expect(rows[0]?.processName).toBe('/opt/app/bin/run --list=a,b --other=c');
    expect(rows[0]?.usedMemoryMiB).toBe(512);
    expect(rows[0]?.gpuUuid).toBe(GPU_4070_UUID);
  });

  it('aceita a consulta sem o campo gpu_uuid', () => {
    const csv = '2973, /usr/bin/python, 63';
    const rows = parseComputeAppsCsv(csv);
    expect(rows[0]?.pid).toBe(2973);
    expect(rows[0]?.processName).toBe('/usr/bin/python');
    expect(rows[0]?.usedMemoryMiB).toBe(63);
    expect(rows[0]?.gpuUuid).toBeNull();
  });

  it('lê as aplicações contabilizadas', () => {
    const rows = parseAccountedAppsCsv('1234, GPU-ff55d89d-783a-8b9e-c442-155cf9a971f1, 12, 256');
    expect(rows[0]?.pid).toBe(1234);
    expect(rows[0]?.gpuUuid).toBe(GPU_4070_UUID);
    expect(rows[0]?.gpuUtilizationPercent).toBe(12);
    expect(rows[0]?.usedMemoryMiB).toBe(256);
    expect(rows[0]?.type).toBe('graphics');
  });

  it('lê a saída do pmon', () => {
    const rows = parsePmonOutput(REAL_PMON_OUTPUT);
    expect(rows.length).toBeGreaterThan(10);
    const llama = rows.find((row) => row.pid === 2973 && row.gpuIndex === 0);
    expect(llama?.type).toBe('compute');
    expect(llama?.processName).toBe('llama-server');
    const shell = rows.find((row) => row.pid === 293856 && row.gpuIndex === 0);
    expect(shell?.type).toBe('graphics');
  });

  it('devolve uma lista vazia quando não há processos', () => {
    expect(parseComputeAppsCsv('')).toEqual([]);
    expect(parsePmonOutput('')).toEqual([]);
  });
});
