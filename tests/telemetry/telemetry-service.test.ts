import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_TELEMETRY_INTERVAL_MS,
  MAX_TELEMETRY_INTERVAL_MS,
  MIN_TELEMETRY_INTERVAL_MS,
  TelemetryService,
  clampIntervalMs,
} from '../../src/main/telemetry/telemetry-service';
import type { Clock } from '../../src/main/telemetry/clock';
import type { GpuSource } from '../../src/main/nvidia/source';
import type { GpuDevice, TelemetrySample } from '../../src/shared/types';

const UUID_A = 'GPU-11111111-1111-1111-1111-111111111111';
const UUID_B = 'GPU-22222222-2222-2222-2222-222222222222';

/** Builds a complete device, ready to be used by the service. */
function makeDevice(uuid: string, index: number, name: string): GpuDevice {
  return {
    uuid,
    index,
    name,
    pciBusId: `00000000:0${index + 1}:00.0`,
    driverVersion: '595.84',
    vbiosVersion: '95.04.3C.C0.1A',
    cudaVersion: '13.2',
    memory: { totalMiB: 12282, usedMiB: 1024, freeMiB: 11258 },
    utilizationGpuPercent: 10,
    utilizationMemoryPercent: 8,
    temperatureC: 45,
    power: {
      drawW: 12.5,
      limitW: 285,
      defaultLimitW: 285,
      minLimitW: 100,
      maxLimitW: 285,
      enforcedLimitW: 285,
    },
    clocks: { smMHz: 495, memMHz: 810, maxSmMHz: 3105, maxMemMHz: 10501 },
    fanSpeedPercent: 0,
    throttling: { active: false, reasons: [], raw: null },
    capabilities: {
      powerLimitAdjustable: true,
      fanControl: true,
      clockControl: true,
      persistenceMode: true,
    },
    computeMode: 'Default',
    persistenceMode: 'Disabled',
    present: true,
    lastSeenAt: 0,
  };
}

/** A clock the test drives by hand. */
class FakeClock implements Clock<number> {
  private time = 1_700_000_000_000;
  private handlers = new Map<number, () => void>();
  private nextId = 1;
  intervals: number[] = [];

  now(): number {
    return this.time;
  }

  setInterval(handler: () => void, ms: number): number {
    const id = this.nextId;
    this.nextId += 1;
    this.handlers.set(id, handler);
    this.intervals.push(ms);
    return id;
  }

  clearInterval(handle: number): void {
    this.handlers.delete(handle);
  }

  /** Advances the wall clock without firing the timers. */
  advance(ms: number): void {
    this.time += ms;
  }

  /** Fires every registered timer, like a real tick would. */
  tick(): void {
    for (const handler of [...this.handlers.values()]) handler();
  }

  get timerCount(): number {
    return this.handlers.size;
  }
}

/** A source the test fully controls. */
class FakeSource implements GpuSource {
  devices: GpuDevice[] = [];
  error: Error | null = null;
  pollCount = 0;
  /** When set, the poll waits for this promise before resolving. */
  pending: Promise<void> | null = null;
  primed = 0;

  async list(): Promise<GpuDevice[]> {
    return this.poll();
  }

  async poll(): Promise<GpuDevice[]> {
    this.pollCount += 1;
    if (this.pending !== null) {
      await this.pending;
    }
    if (this.error !== null) throw this.error;
    return this.devices;
  }

  isSimulated(): boolean {
    return true;
  }

  async prime(): Promise<void> {
    this.primed += 1;
  }
}

function createService(
  source: GpuSource,
  clock: FakeClock,
): TelemetryService {
  return new TelemetryService({ source, clock, intervalMs: 1000 });
}

describe('telemetria: identidade por UUID', () => {
  it('mantém a identidade quando os índices do driver são permutados', async () => {
    const clock = new FakeClock();
    const source = new FakeSource();
    const service = createService(source, clock);

    const deviceA = makeDevice(UUID_A, 0, 'GPU Alfa');
    const deviceB = makeDevice(UUID_B, 1, 'GPU Beta');
    source.devices = [deviceA, deviceB];
    await service.pollOnce();

    // O driver troca os índices entre dois ciclos.
    source.devices = [
      { ...deviceB, index: 0 },
      { ...deviceA, index: 1 },
    ];
    await service.pollOnce();

    const devices = await service.list();
    expect(devices).toHaveLength(2);
    // A ordem de descoberta e a identidade permanecem as mesmas.
    expect(devices[0]?.uuid).toBe(UUID_A);
    expect(devices[1]?.uuid).toBe(UUID_B);
    expect(devices[0]?.name).toBe('GPU Alfa');
    expect(devices[1]?.name).toBe('GPU Beta');
    // Só o índice (que é apenas uma dica de exibição) acompanha o driver.
    expect(devices[0]?.index).toBe(1);
    expect(devices[1]?.index).toBe(0);
  });

  it('preserva o histórico de cada GPU através da permutação', async () => {
    const clock = new FakeClock();
    const source = new FakeSource();
    const service = createService(source, clock);

    const deviceA = makeDevice(UUID_A, 0, 'GPU Alfa');
    const deviceB = makeDevice(UUID_B, 1, 'GPU Beta');
    source.devices = [deviceA, deviceB];
    await service.pollOnce();
    clock.advance(1000);
    source.devices = [
      { ...deviceB, index: 0 },
      { ...deviceA, index: 1 },
    ];
    await service.pollOnce();

    const history = service.history();
    expect(history).toHaveLength(2);
    for (const entry of history) {
      const byUuid = new Map(entry.gpus.map((device) => [device.uuid, device.name]));
      expect(byUuid.get(UUID_A)).toBe('GPU Alfa');
      expect(byUuid.get(UUID_B)).toBe('GPU Beta');
    }
  });
});

describe('telemetria: GPU que some', () => {
  it('mantém a GPU na lista com present: false', async () => {
    const clock = new FakeClock();
    const source = new FakeSource();
    const service = createService(source, clock);

    source.devices = [makeDevice(UUID_A, 0, 'GPU Alfa'), makeDevice(UUID_B, 1, 'GPU Beta')];
    await service.pollOnce();
    clock.advance(1000);
    source.devices = [makeDevice(UUID_A, 0, 'GPU Alfa')];
    await service.pollOnce();

    const devices = await service.list();
    expect(devices).toHaveLength(2);
    const gone = devices.find((device) => device.uuid === UUID_B);
    expect(gone).toBeDefined();
    expect(gone?.present).toBe(false);
    expect(gone?.name).toBe('GPU Beta');
  });

  it('congela o lastSeenAt da GPU que sumiu', async () => {
    const clock = new FakeClock();
    const source = new FakeSource();
    const service = createService(source, clock);

    source.devices = [makeDevice(UUID_A, 0, 'GPU Alfa'), makeDevice(UUID_B, 1, 'GPU Beta')];
    await service.pollOnce();
    const lastSeen = (await service.list()).find((device) => device.uuid === UUID_B)?.lastSeenAt;

    clock.advance(5000);
    source.devices = [makeDevice(UUID_A, 0, 'GPU Alfa')];
    await service.pollOnce();

    const gone = (await service.list()).find((device) => device.uuid === UUID_B);
    expect(gone?.lastSeenAt).toBe(lastSeen);
    expect(gone?.lastSeenAt).toBe(1_700_000_000_000);
  });

  it('faz a GPU voltar quando ela é detectada de novo', async () => {
    const clock = new FakeClock();
    const source = new FakeSource();
    const service = createService(source, clock);

    source.devices = [makeDevice(UUID_A, 0, 'GPU Alfa'), makeDevice(UUID_B, 1, 'GPU Beta')];
    await service.pollOnce();
    source.devices = [makeDevice(UUID_A, 0, 'GPU Alfa')];
    await service.pollOnce();
    source.devices = [makeDevice(UUID_A, 0, 'GPU Alfa'), makeDevice(UUID_B, 1, 'GPU Beta')];
    clock.advance(1000);
    await service.pollOnce();

    const back = (await service.list()).find((device) => device.uuid === UUID_B);
    expect(back?.present).toBe(true);
    expect(back?.lastSeenAt).toBe(1_700_000_001_000);
  });
});

describe('telemetria: falhas do driver', () => {
  it('não rejeita e não quebra quando o driver falha', async () => {
    const clock = new FakeClock();
    const source = new FakeSource();
    const service = createService(source, clock);

    source.devices = [makeDevice(UUID_A, 0, 'GPU Alfa')];
    await service.pollOnce();

    source.error = new Error('nvidia-smi: command failed');
    await expect(service.pollOnce()).resolves.toBe(false);
    await expect(service.list()).resolves.toHaveLength(1);
  });

  it('entrega o erro aos assinantes e ao callback onError', async () => {
    const clock = new FakeClock();
    const source = new FakeSource();
    const onError = vi.fn();
    const service = new TelemetryService({ source, clock, onError });
    const errors: unknown[] = [];
    service.onError((error) => errors.push(error));

    source.error = new Error('driver ausente');
    await service.pollOnce();

    expect(errors).toHaveLength(1);
    expect(onError).toHaveBeenCalledTimes(1);
    const error = errors[0] as { code: string; message: string };
    expect(error.code).toBe('UNKNOWN');
    expect(error.message).toContain('driver NVIDIA');
  });

  it('preserva o último snapshot conhecido quando a leitura falha', async () => {
    const clock = new FakeClock();
    const source = new FakeSource();
    const service = createService(source, clock);

    source.devices = [makeDevice(UUID_A, 0, 'GPU Alfa')];
    await service.pollOnce();
    const before = service.snapshot();

    source.error = new Error('falhou');
    await service.pollOnce();

    const after = service.snapshot();
    expect(after.gpus).toHaveLength(1);
    expect(after.gpus[0]?.uuid).toBe(UUID_A);
    expect(after.at).toBe(before.at);
  });

  it('não publica amostras quando a leitura falha', async () => {
    const clock = new FakeClock();
    const source = new FakeSource();
    const service = createService(source, clock);
    const samples: TelemetrySample[] = [];
    service.subscribe((sample) => samples.push(sample));

    source.error = new Error('falhou');
    await service.pollOnce();
    expect(samples).toHaveLength(0);
  });
});

describe('telemetria: agendamento', () => {
  it('faz exatamente uma leitura por ciclo', async () => {
    const clock = new FakeClock();
    const source = new FakeSource();
    const service = createService(source, clock);
    source.devices = [makeDevice(UUID_A, 0, 'GPU Alfa')];

    service.start();
    await vi.waitFor(() => expect(source.pollCount).toBeGreaterThanOrEqual(1));
    const afterStart = source.pollCount;

    clock.tick();
    await vi.waitFor(() => expect(source.pollCount).toBe(afterStart + 1));
    expect(source.pollCount).toBe(afterStart + 1);
    service.stop();
  });

  it('pula o ciclo quando a leitura anterior ainda está em curso', async () => {
    const clock = new FakeClock();
    const source = new FakeSource();
    const service = createService(source, clock);

    let release: () => void = () => undefined;
    source.pending = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = service.pollOnce();
    expect(source.pollCount).toBe(1);
    // A segunda leitura é ignorada enquanto a primeira não termina.
    await expect(service.pollOnce()).resolves.toBe(false);
    expect(source.pollCount).toBe(1);

    release();
    await expect(first).resolves.toBe(true);
    expect(source.pollCount).toBe(1);
  });

  it('limpa o temporizador ao parar', () => {
    const clock = new FakeClock();
    const source = new FakeSource();
    const service = createService(source, clock);

    service.start();
    expect(clock.timerCount).toBe(1);
    expect(service.isRunning()).toBe(true);
    service.stop();
    expect(clock.timerCount).toBe(0);
    expect(service.isRunning()).toBe(false);
    // Parar duas vezes não deve explodir.
    service.stop();
  });

  it('não cria mais de um temporizador', () => {
    const clock = new FakeClock();
    const source = new FakeSource();
    const service = createService(source, clock);
    service.start();
    service.start();
    expect(clock.timerCount).toBe(1);
    service.stop();
  });

  it('usa o intervalo configurado', () => {
    const clock = new FakeClock();
    const source = new FakeSource();
    const service = new TelemetryService({ source, clock, intervalMs: 500 });
    service.start();
    expect(clock.intervals[0]).toBe(500);
    service.stop();
  });

  it('limita o intervalo para a faixa suportada', () => {
    expect(clampIntervalMs(10)).toBe(MIN_TELEMETRY_INTERVAL_MS);
    expect(clampIntervalMs(99_999)).toBe(MAX_TELEMETRY_INTERVAL_MS);
    expect(clampIntervalMs(1000)).toBe(1000);
    expect(clampIntervalMs(Number.NaN)).toBe(DEFAULT_TELEMETRY_INTERVAL_MS);
  });
});

describe('telemetria: assinantes', () => {
  it('publica uma amostra por leitura para todos os assinantes', async () => {
    const clock = new FakeClock();
    const source = new FakeSource();
    const service = createService(source, clock);
    const first: TelemetrySample[] = [];
    const second: TelemetrySample[] = [];
    service.subscribe((sample) => first.push(sample));
    service.subscribe((sample) => second.push(sample));

    source.devices = [makeDevice(UUID_A, 0, 'GPU Alfa')];
    await service.pollOnce();

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]?.gpus[0]?.uuid).toBe(UUID_A);
  });

  it('cancela a assinatura de forma idempotente', async () => {
    const clock = new FakeClock();
    const source = new FakeSource();
    const service = createService(source, clock);
    const samples: TelemetrySample[] = [];
    const unsubscribe = service.subscribe((sample) => samples.push(sample));

    await service.pollOnce();
    expect(samples).toHaveLength(1);

    unsubscribe();
    unsubscribe();
    await service.pollOnce();
    expect(samples).toHaveLength(1);
  });

  it('isola um assinante que lança exceção', async () => {
    const clock = new FakeClock();
    const source = new FakeSource();
    const service = createService(source, clock);
    const good: TelemetrySample[] = [];
    service.subscribe(() => {
      throw new Error('assinante quebrado');
    });
    service.subscribe((sample) => good.push(sample));

    source.devices = [makeDevice(UUID_A, 0, 'GPU Alfa')];
    await expect(service.pollOnce()).resolves.toBe(true);
    expect(good).toHaveLength(1);
  });

  it('informa se a fonte é simulada', () => {
    const clock = new FakeClock();
    const service = createService(new FakeSource(), clock);
    expect(service.isSimulated()).toBe(true);
  });

  it('faz o bootstrap uma única vez', async () => {
    const clock = new FakeClock();
    const source = new FakeSource();
    const service = createService(source, clock);
    const samples: TelemetrySample[] = [];
    service.subscribe((sample) => samples.push(sample));

    service.start();
    await vi.waitFor(() => expect(samples).toHaveLength(1));
    expect(source.primed).toBe(1);
    expect(source.pollCount).toBe(1);

    // Deixa o ciclo de bootstrap terminar antes de disparar o temporizador.
    await new Promise((resolve) => setTimeout(resolve, 0));
    clock.tick();
    await vi.waitFor(() => expect(source.pollCount).toBe(2));
    // O bootstrap não pode rodar de novo a cada ciclo.
    expect(source.primed).toBe(1);
    service.stop();
  });
});
