import { describe, expect, it } from 'vitest';

import { SIMULATED_GPUS, SimulatedPowerState } from '../../src/shared/simulation';
import type { GpuDevice } from '../../src/shared/types';
import { SimulatedGpuSource } from '../../src/main/nvidia/simulator';

const UUID_4070 = SIMULATED_GPUS[0].uuid;
const UUID_5060 = SIMULATED_GPUS[1].uuid;

/** Checks that a device has every field the domain type declares. */
function expectValidGpuDevice(device: GpuDevice): void {
  expect(typeof device.uuid).toBe('string');
  expect(device.uuid).toMatch(/^GPU-[0-9a-f-]{36}$/);
  expect(typeof device.index).toBe('number');
  expect(typeof device.name).toBe('string');
  expect(typeof device.memory.totalMiB).toBe('number');
  expect(typeof device.memory.usedMiB).toBe('number');
  expect(typeof device.memory.freeMiB).toBe('number');
  expect(typeof device.utilizationGpuPercent).toBe('number');
  expect(typeof device.utilizationMemoryPercent).toBe('number');
  expect(device.temperatureC === null || typeof device.temperatureC === 'number').toBe(true);
  expect(typeof device.power.drawW === 'number' || device.power.drawW === null).toBe(true);
  expect(typeof device.power.limitW === 'number' || device.power.limitW === null).toBe(true);
  expect(typeof device.clocks.smMHz === 'number' || device.clocks.smMHz === null).toBe(true);
  expect(typeof device.fanSpeedPercent === 'number' || device.fanSpeedPercent === null).toBe(true);
  expect(typeof device.throttling.active).toBe('boolean');
  expect(Array.isArray(device.throttling.reasons)).toBe(true);
  expect(typeof device.capabilities.powerLimitAdjustable).toBe('boolean');
  expect(typeof device.capabilities.fanControl).toBe('boolean');
  expect(typeof device.capabilities.clockControl).toBe('boolean');
  expect(typeof device.capabilities.persistenceMode).toBe('boolean');
  expect(typeof device.present).toBe('boolean');
  expect(typeof device.lastSeenAt).toBe('number');
}

describe('simulador: dispositivos', () => {
  it('produz um dispositivo válido por GPU simulada', async () => {
    const source = new SimulatedGpuSource({ seed: 42, now: () => 1_700_000_000_000 });
    const devices = await source.poll();
    expect(devices).toHaveLength(SIMULATED_GPUS.length);
    for (const device of devices) {
      expectValidGpuDevice(device);
      expect(device.present).toBe(true);
      expect(device.lastSeenAt).toBe(1_700_000_000_000);
    }
  });

  it('usa UUIDs sintéticos, nunca os de uma GPU real', async () => {
    const source = new SimulatedGpuSource();
    const devices = await source.poll();
    expect(devices.map((device) => device.uuid)).toEqual([UUID_4070, UUID_5060]);

    // A simulated device must never be indistinguishable from a real one.
    for (const device of devices) {
      expect(device.uuid).toMatch(/^GPU-00000000-/);
      expect(device.name).toMatch(/simulado/i);
    }
    expect(devices[0]?.name).toBe('NVIDIA GeForce RTX 4070 Ti (simulado)');
    expect(devices[1]?.name).toBe('NVIDIA GeForce RTX 5060 Ti (simulado)');
    expect(devices[0]?.memory.totalMiB).toBe(12282);
    expect(devices[1]?.memory.totalMiB).toBe(16311);
    expect(devices[1]?.power.minLimitW).toBe(150);
    expect(devices[1]?.power.maxLimitW).toBe(180);
  });

  it('se declara como simulada', () => {
    expect(new SimulatedGpuSource().isSimulated()).toBe(true);
  });

  it('mexe os valores ao longo do tempo', async () => {
    const source = new SimulatedGpuSource({ seed: 7 });
    const first = await source.poll();
    const second = await source.poll();
    expect(second[0]?.power.drawW).not.toBe(first[0]?.power.drawW);
  });

  it('é determinístico para a mesma semente', async () => {
    const a = new SimulatedGpuSource({ seed: 99 });
    const b = new SimulatedGpuSource({ seed: 99 });
    const first = await a.poll();
    const second = await b.poll();
    expect(second[0]?.power.drawW).toBe(first[0]?.power.drawW);
    expect(second[0]?.utilizationGpuPercent).toBe(first[0]?.utilizationGpuPercent);
  });

  it('reflete o limite de potência aplicado no consumo', async () => {
    const state = new SimulatedPowerState();
    const source = new SimulatedGpuSource({ seed: 5, state });
    await source.poll();
    const before = (await source.poll())[0]?.power.drawW ?? 0;
    expect(state.setLimitW(UUID_4070, 120)).toBe(true);
    const after = (await source.poll())[0]?.power.drawW ?? 0;
    expect(after).toBeLessThan(before);
  });
});

describe('simulador: desconexão de dispositivo', () => {
  it('some com a GPU desconectada', async () => {
    const source = new SimulatedGpuSource();
    expect((await source.poll()).length).toBe(2);
    source.disconnect(UUID_5060);
    const devices = await source.poll();
    expect(devices).toHaveLength(1);
    expect(devices[0]?.uuid).toBe(UUID_4070);
  });

  it('faz a GPU voltar quando reconectada', async () => {
    const source = new SimulatedGpuSource();
    source.disconnect(UUID_5060);
    expect((await source.poll()).length).toBe(1);
    source.connect(UUID_5060);
    expect((await source.poll()).length).toBe(2);
  });

  it('desconecta depois de N ciclos', async () => {
    const source = new SimulatedGpuSource();
    source.disconnectAfterPolls(UUID_4070, 2);
    expect((await source.poll()).length).toBe(2);
    expect((await source.poll()).length).toBe(1);
    expect((await source.poll()).length).toBe(1);
  });

  it('informa se a GPU está conectada', async () => {
    const source = new SimulatedGpuSource();
    expect(source.isConnected(UUID_4070)).toBe(true);
    source.disconnect(UUID_4070);
    expect(source.isConnected(UUID_4070)).toBe(false);
  });
});
