import { useEffect } from 'react';
import { getBridge } from '@renderer/lib/bridge';
import { normaliseError } from '@renderer/lib/errors';
import { useTelemetryStore } from '@renderer/store/telemetry';
import { useSettingsStore } from '@renderer/store/settings';

/**
 * Subscribes the renderer to the telemetry stream.
 *
 * Inside Electron the preload bridge pushes samples; in the browser the mock
 * bridge does. The renderer never polls the driver directly.
 */
export function useTelemetrySubscription(): void {
  const setSnapshot = useTelemetryStore((state) => state.setSnapshot);
  const setError = useTelemetryStore((state) => state.setError);
  const setConnected = useTelemetryStore((state) => state.setConnected);
  const telemetryEnabled = useSettingsStore((state) => state.settings.telemetryEnabled);
  const telemetryIntervalMs = useSettingsStore((state) => state.settings.telemetryIntervalMs);

  useEffect(() => {
    const bridge = getBridge();
    let unsubscribeTelemetry: (() => void) | undefined;
    let unsubscribeError: (() => void) | undefined;
    let cancelled = false;

    void (async () => {
      try {
        const devices = await bridge.gpu.list();
        if (cancelled) return;
        if (devices.length > 0) {
          setSnapshot({ at: Date.now(), gpus: devices });
        }
        const snapshot = await bridge.gpu.snapshot();
        if (!cancelled && snapshot.gpus.length > 0) {
          setSnapshot(snapshot);
        }
        unsubscribeTelemetry = bridge.gpu.onTelemetry((sample) => {
          setSnapshot(sample);
        });
        unsubscribeError = bridge.gpu.onTelemetryError((error) => {
          setError(error);
        });
        setConnected(true);
      } catch (error) {
        if (!cancelled) {
          setError(normaliseError(error));
          setConnected(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      unsubscribeTelemetry?.();
      unsubscribeError?.();
      setConnected(false);
    };
  }, [setSnapshot, setError, setConnected, telemetryEnabled, telemetryIntervalMs]);
}
