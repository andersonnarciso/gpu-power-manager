import { useCallback, useEffect, useState } from 'react';
import { Info, Lock, Settings as SettingsIcon, ShieldCheck, Unlock } from 'lucide-react';
import type {
  Locale,
  PersistenceStatus,
  ThemeMode,
  WorkloadAdapterInfo,
} from '@shared/types';
import { getLocale, useT } from '@renderer/lib/i18n';
import { getBridge } from '@renderer/lib/bridge';
import { EM_DASH, formatDateTime } from '@renderer/lib/format';
import { cn } from '@renderer/lib/utils';
import { useSettingsStore } from '@renderer/store/settings';
import { useTelemetryStore } from '@renderer/store/telemetry';
import { useProfilesStore } from '@renderer/store/profiles';
import { useAppStore } from '@renderer/store/app';
import { useUiStore } from '@renderer/store/ui';
import { PageHeader } from '@renderer/components/common/PageStates';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@renderer/components/ui/card';
import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';
import { Label } from '@renderer/components/ui/label';
import { Switch } from '@renderer/components/ui/switch';
import { Badge } from '@renderer/components/ui/badge';
import { Separator } from '@renderer/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import { Alert, AlertDescription, AlertTitle } from '@renderer/components/ui/alert';

const TELEMETRY_INTERVALS = [250, 500, 1000, 2000, 5000] as const;
const RETENTION_MINUTES = [15, 30, 60, 120] as const;

export function SettingsPage(): React.JSX.Element {
  const t = useT();
  const locale = getLocale();
  const settings = useSettingsStore((state) => state.settings);
  const updateSettings = useSettingsStore((state) => state.update);
  const setWindow = useTelemetryStore((state) => state.setWindow);
  const profiles = useProfilesStore((state) => state.profiles);
  const loadProfiles = useProfilesStore((state) => state.load);
  const info = useAppStore((state) => state.info);
  const simulated = useAppStore((state) => state.simulated);
  const pushToast = useUiStore((state) => state.pushToast);

  const [persistence, setPersistence] = useState<PersistenceStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [installProfileId, setInstallProfileId] = useState('');

  // The endpoints of the adapters, edited locally and applied on demand: the
  // main process validates them, and an invalid URL is rejected instead of
  // being silently coerced.
  const [endpoints, setEndpoints] = useState({
    ollamaUrl: '',
    llamaCppUrl: '',
    comfyUiUrl: '',
    unslothCommand: '',
    unslothArgs: '',
  });
  const [detectedAdapters, setDetectedAdapters] = useState<WorkloadAdapterInfo[]>([]);

  const refreshAdapters = useCallback(async (): Promise<void> => {
    try {
      setDetectedAdapters(await getBridge().benchmark.adapters());
    } catch {
      setDetectedAdapters([]);
    }
  }, []);

  useEffect(() => {
    setEndpoints({
      ollamaUrl: settings.ollamaUrl ?? '',
      llamaCppUrl: settings.llamaCppUrl ?? '',
      comfyUiUrl: settings.comfyUiUrl ?? '',
      unslothCommand: settings.unslothCommand ?? '',
      unslothArgs: (settings.unslothArgs ?? []).join(' '),
    });
  }, [settings]);

  const refreshPersistence = useCallback(async (): Promise<void> => {
    try {
      setPersistence(await getBridge().persistence.status());
    } catch {
      setPersistence(null);
    }
  }, []);

  useEffect(() => {
    void refreshPersistence();
    void loadProfiles();
    void refreshAdapters();
  }, [refreshPersistence, loadProfiles, refreshAdapters]);

  const saveEndpoints = async (): Promise<void> => {
    setBusy(true);
    try {
      const saved = await getBridge().settings.update({
        ollamaUrl: endpoints.ollamaUrl.trim(),
        llamaCppUrl: endpoints.llamaCppUrl.trim(),
        comfyUiUrl: endpoints.comfyUiUrl.trim(),
        unslothCommand: endpoints.unslothCommand.trim(),
        unslothArgs: endpoints.unslothArgs.trim() === '' ? [] : endpoints.unslothArgs.trim().split(/\s+/),
      });
      useSettingsStore.setState({ settings: saved });
      pushToast({ variant: 'success', title: t('set.endpointsSaved') });
      await refreshAdapters();
    } catch (error) {
      pushToast({
        variant: 'error',
        title: t('error.title'),
        description: (error as Error).message,
      });
    } finally {
      setBusy(false);
    }
  };

  const runPersistenceAction = async (
    action: () => Promise<{ ok: boolean; error?: { message: string } }>,
    successKey:
      | 'set.persistenceInstallSuccess'
      | 'set.persistenceUninstallSuccess'
      | 'set.persistenceEnableSuccess'
      | 'set.persistenceDisableSuccess'
      | 'set.persistenceApplySuccess',
  ): Promise<void> => {
    setBusy(true);
    try {
      const result = await action();
      if (result.ok) {
        pushToast({ variant: 'success', title: t(successKey) });
      } else {
        pushToast({
          variant: 'error',
          title: t('error.title'),
          description: result.error?.message ?? t('error.unknown'),
        });
      }
    } catch (error) {
      pushToast({
        variant: 'error',
        title: t('error.title'),
        description: (error as Error).message,
      });
    } finally {
      setBusy(false);
      await refreshPersistence();
    }
  };

  return (
    <div className="animate-fade-in">
      <PageHeader title={t('set.title')} description={t('set.subtitle')} />

      <div className="grid gap-3 lg:grid-cols-2">
        <SettingsCard title={t('set.appearance')} icon={<SettingsIcon className="h-4 w-4" />}>
          <Field label={t('set.theme')}>
            <Select
              value={settings.theme}
              onValueChange={(value: string) => void updateSettings({ theme: value as ThemeMode })}
            >
              <SelectTrigger aria-label={t('set.theme')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="dark">{t('set.themeDark')}</SelectItem>
                <SelectItem value="light">{t('set.themeLight')}</SelectItem>
                <SelectItem value="system">{t('set.themeSystem')}</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field label={t('set.language')}>
            <Select
              value={settings.locale}
              onValueChange={(value: string) => void updateSettings({ locale: value as Locale })}
            >
              <SelectTrigger aria-label={t('set.language')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pt-BR">{t('set.languagePt')}</SelectItem>
                <SelectItem value="en">{t('set.languageEn')}</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <SwitchField
            label={t('set.reduceMotion')}
            hint={t('set.reduceMotionHint')}
            checked={settings.reduceMotion}
            onChange={(value) => void updateSettings({ reduceMotion: value })}
          />
        </SettingsCard>

        <SettingsCard title={t('set.telemetry')} icon={<Info className="h-4 w-4" />}>
          <SwitchField
            label={t('set.telemetryEnabled')}
            hint={t('set.telemetryEnabledHint')}
            checked={settings.telemetryEnabled}
            onChange={(value) => void updateSettings({ telemetryEnabled: value })}
          />

          <Field label={t('set.telemetryInterval')}>
            <Select
              value={String(settings.telemetryIntervalMs)}
              onValueChange={(value: string) =>
                void updateSettings({ telemetryIntervalMs: Number(value) })
              }
            >
              <SelectTrigger aria-label={t('set.telemetryInterval')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TELEMETRY_INTERVALS.map((interval) => (
                  <SelectItem key={interval} value={String(interval)}>
                    {t('set.telemetryIntervalValue', { value: interval })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </SettingsCard>

        <SettingsCard title={t('set.history')} icon={<SettingsIcon className="h-4 w-4" />}>
          <Field label={t('set.historyWindow')}>
            <Select
              value={String(settings.historyWindowMinutes)}
              onValueChange={(value: string) => {
                const minutes = Number(value) as 1 | 5 | 15 | 60;
                setWindow(minutes);
                void updateSettings({ historyWindowMinutes: minutes });
              }}
            >
              <SelectTrigger aria-label={t('set.historyWindow')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[1, 5, 15, 60].map((minutes) => (
                  <SelectItem key={minutes} value={String(minutes)}>
                    {t('dashboard.windowMinutes', { minutes })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label={t('set.historyRetention')}>
            <Select
              value={String(settings.historyRetentionMinutes)}
              onValueChange={(value: string) =>
                void updateSettings({ historyRetentionMinutes: Number(value) })
              }
            >
              <SelectTrigger aria-label={t('set.historyRetention')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RETENTION_MINUTES.map((minutes) => (
                  <SelectItem key={minutes} value={String(minutes)}>
                    {t('set.historyRetentionValue', { minutes })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </SettingsCard>

        <SettingsCard title={t('set.simulation')} icon={<SettingsIcon className="h-4 w-4" />}>
          <SwitchField
            label={t('set.simulateMode')}
            hint={t('set.simulateModeHint')}
            checked={settings.simulateMode}
            onChange={(value) => void updateSettings({ simulateMode: value })}
          />
          <div className="flex items-center justify-between rounded-md border border-border bg-muted/30 px-3 py-2">
            <span className="text-[11px] text-muted-foreground">{t('set.simulatedSource')}</span>
            <Badge variant={simulated ? 'warning' : 'success'}>
              {simulated ? t('set.simulatedSourceMock') : t('set.simulatedSourceReal')}
            </Badge>
          </div>
        </SettingsCard>

        <SettingsCard title={t('set.boot')} icon={<Lock className="h-4 w-4" />}>
          <SwitchField
            label={t('set.applyOnBoot')}
            hint={t('set.applyOnBootHint')}
            checked={settings.autoApplyProfileOnBoot}
            onChange={(value) => void updateSettings({ autoApplyProfileOnBoot: value })}
          />
        </SettingsCard>

        <SettingsCard title={t('set.endpoints')} icon={<Info className="h-4 w-4" />}>
          <p className="text-[10px] leading-relaxed text-muted-foreground">
            {t('set.endpointsHint')}
          </p>

          <Field label={t('set.endpointOllama')}>
            <Input
              value={endpoints.ollamaUrl}
              placeholder="http://127.0.0.1:11434"
              aria-label={t('set.endpointOllama')}
              onChange={(event) =>
                setEndpoints((current) => ({ ...current, ollamaUrl: event.target.value }))
              }
            />
          </Field>

          <Field label={t('set.endpointLlamaCpp')}>
            <Input
              value={endpoints.llamaCppUrl}
              placeholder="http://127.0.0.1:8080"
              aria-label={t('set.endpointLlamaCpp')}
              onChange={(event) =>
                setEndpoints((current) => ({ ...current, llamaCppUrl: event.target.value }))
              }
            />
          </Field>

          <Field label={t('set.endpointComfyUi')}>
            <Input
              value={endpoints.comfyUiUrl}
              placeholder="http://127.0.0.1:8188"
              aria-label={t('set.endpointComfyUi')}
              onChange={(event) =>
                setEndpoints((current) => ({ ...current, comfyUiUrl: event.target.value }))
              }
            />
          </Field>

          <Field label={t('set.unslothCommand')}>
            <Input
              value={endpoints.unslothCommand}
              placeholder="python3"
              aria-label={t('set.unslothCommand')}
              onChange={(event) =>
                setEndpoints((current) => ({ ...current, unslothCommand: event.target.value }))
              }
            />
          </Field>

          <Field label={t('set.unslothArgs')}>
            <Input
              value={endpoints.unslothArgs}
              placeholder="~/benchmarks/unsloth_bench.py"
              aria-label={t('set.unslothArgs')}
              onChange={(event) =>
                setEndpoints((current) => ({ ...current, unslothArgs: event.target.value }))
              }
            />
            <p className="text-[10px] text-muted-foreground">{t('set.unslothArgsHint')}</p>
          </Field>

          <Button size="sm" disabled={busy} onClick={() => void saveEndpoints()}>
            {t('set.endpointsSave')}
          </Button>

          <Separator />

          <div className="space-y-1.5">
            <p className="text-[11px] font-medium">{t('set.endpointsDetected')}</p>
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              {t('set.endpointsDetectedHint')}
            </p>
            {detectedAdapters.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">{EM_DASH}</p>
            ) : (
              detectedAdapters.map((adapter) => (
                <div
                  key={adapter.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-[11px]"
                >
                  <span className="font-medium">{adapter.name}</span>
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-mono text-[10px] text-muted-foreground">
                      {adapter.endpoint ?? t('set.unslothCommand')}
                    </span>
                    <Badge variant={adapter.available ? 'success' : 'muted'}>
                      {adapter.available ? t('common.enabled') : t('common.disabled')}
                    </Badge>
                  </span>
                </div>
              ))
            )}
          </div>
        </SettingsCard>

        <SettingsCard title={t('set.persistence')} icon={<ShieldCheck className="h-4 w-4" />}>
          {persistence === null ? (
            <Alert variant="info">
              <Info className="h-4 w-4" aria-hidden="true" />
              <AlertTitle>{t('set.persistenceUnavailable')}</AlertTitle>
              <AlertDescription>{t('set.persistenceInstallHint')}</AlertDescription>
            </Alert>
          ) : (
            <>
              <div className="space-y-1.5 rounded-md border border-border bg-muted/30 px-3 py-2.5 text-[11px]">
                <StatusLine
                  label={t('set.persistenceInstalled')}
                  value={persistence.installed ? t('common.enabled') : t('common.disabled')}
                  ok={persistence.installed}
                />
                <StatusLine
                  label={t('set.persistenceEnabled')}
                  value={persistence.enabled ? t('common.enabled') : t('common.disabled')}
                  ok={persistence.enabled}
                />
                <StatusLine
                  label={t('set.persistenceHelper')}
                  value={persistence.helperInstalled ? t('common.enabled') : t('common.disabled')}
                  ok={persistence.helperInstalled}
                />
                <StatusLine
                  label={t('set.persistencePolkit')}
                  value={persistence.polkitInstalled ? t('common.enabled') : t('common.disabled')}
                  ok={persistence.polkitInstalled}
                />
                <StatusLine
                  label={t('set.persistenceProfile')}
                  value={persistence.profileId ?? t('set.persistenceNone')}
                  ok={Boolean(persistence.profileId)}
                />
                {persistence.unitPath && (
                  <p className="break-all font-mono text-[10px] text-muted-foreground">
                    {persistence.unitPath}
                  </p>
                )}
                {persistence.lastAppliedAt !== null && (
                  <p className="text-[10px] text-muted-foreground">
                    {formatDateTime(locale, persistence.lastAppliedAt)}
                  </p>
                )}
                {persistence.lastError && (
                  <p className="text-[10px] text-destructive">{persistence.lastError}</p>
                )}
              </div>

              <Field label={t('set.installProfile')}>
                <Select value={installProfileId} onValueChange={setInstallProfileId}>
                  <SelectTrigger aria-label={t('set.installProfile')}>
                    <SelectValue placeholder={t('set.persistenceNone')} />
                  </SelectTrigger>
                  <SelectContent>
                    {profiles.map((profile) => (
                      <SelectItem key={profile.id} value={profile.id}>
                        {profile.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <div className="flex flex-wrap items-center gap-2">
                {persistence.installed ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void runPersistenceAction(
                        () => getBridge().persistence.uninstall(),
                        'set.persistenceUninstallSuccess',
                      )
                    }
                  >
                    {t('set.uninstall')}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    disabled={busy || installProfileId === ''}
                    onClick={() =>
                      void runPersistenceAction(
                        () => getBridge().persistence.install(installProfileId),
                        'set.persistenceInstallSuccess',
                      )
                    }
                  >
                    <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                    {t('set.install')}
                  </Button>
                )}

                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || !persistence.installed}
                  onClick={() =>
                    void runPersistenceAction(
                      () => getBridge().persistence.setEnabled(!persistence.enabled),
                      persistence.enabled
                        ? 'set.persistenceDisableSuccess'
                        : 'set.persistenceEnableSuccess',
                    )
                  }
                >
                  {persistence.enabled ? (
                    <Unlock className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : (
                    <Lock className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  {persistence.enabled ? t('set.disable') : t('set.enable')}
                </Button>

                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || !persistence.installed || !persistence.profileId}
                  onClick={() =>
                    void runPersistenceAction(
                      () => getBridge().persistence.applyNow(),
                      'set.persistenceApplySuccess',
                    )
                  }
                >
                  {t('set.applyNow')}
                </Button>
              </div>

              <p className="text-[10px] leading-relaxed text-muted-foreground">
                {t('set.persistenceInstallHint')}
              </p>
            </>
          )}
        </SettingsCard>

        <SettingsCard title={t('set.about')} icon={<SettingsIcon className="h-4 w-4" />}>
          <div className="space-y-1.5 rounded-md border border-border bg-muted/30 px-3 py-2.5 text-[11px]">
            <StatusLine label={t('app.name')} value={t('app.version', { version: info?.version ?? '—' })} />
            <StatusLine
              label={t('set.electronVersion')}
              value={info?.electronVersion ?? '—'}
            />
            <StatusLine label={t('set.platform')} value={info?.platform ?? '—'} />
            <StatusLine
              label={t('set.driver')}
              value={info?.driverAvailable ? t('common.enabled') : t('common.disabled')}
              ok={info?.driverAvailable ?? false}
            />
            <StatusLine label={t('set.nvidiaSmiPath')} value={info?.nvidiaSmiPath ?? '—'} />
          </div>
        </SettingsCard>
      </div>
    </div>
  );
}

function SettingsCard({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">{icon}</span>
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">{children}</CardContent>
    </Card>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function SwitchField({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4 rounded-md border border-border bg-muted/20 px-3 py-2.5">
      <div className="min-w-0">
        <p className="text-xs font-medium">{label}</p>
        <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">{hint}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </div>
  );
}

function StatusLine({
  label,
  value,
  ok,
}: {
  label: string;
  value: string;
  ok?: boolean;
}): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn('text-right font-medium', ok === false && 'text-muted-foreground/70')}>
        {value}
      </span>
    </div>
  );
}
