import { useEffect, useMemo, useState } from 'react';
import { Layers, Pencil, Play, Plus, RotateCcw, Trash2 } from 'lucide-react';
import type { GpuDevice, PowerProfile, ProfileEntry, ProfileKind, ProfileStrategy } from '@shared/types';
import type { PowerLimitBounds } from '@shared/contracts';
import { getLocale, useT } from '@renderer/lib/i18n';
import { formatInt, formatWatts } from '@renderer/lib/format';
import { resolveProfile, strategyLabelKey } from '@renderer/lib/profiles';
import { cn } from '@renderer/lib/utils';
import { useTelemetryStore } from '@renderer/store/telemetry';
import { usePowerStore } from '@renderer/store/power';
import { useProfilesStore } from '@renderer/store/profiles';
import { useUiStore } from '@renderer/store/ui';
import { PageHeader, EmptyState } from '@renderer/components/common/PageStates';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@renderer/components/ui/card';
import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';
import { Label } from '@renderer/components/ui/label';
import { Badge } from '@renderer/components/ui/badge';
import { Separator } from '@renderer/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';

interface EntryDraft {
  uuid: string;
  strategy: ProfileStrategy;
  watts: string;
  ratio: string;
}

export function ProfilesPage(): React.JSX.Element {
  const t = useT();
  const locale = getLocale();
  const devices = useTelemetryStore((state) => state.devices);
  const bounds = usePowerStore((state) => state.bounds);
  const loadBounds = usePowerStore((state) => state.loadBounds);
  const profiles = useProfilesStore((state) => state.profiles);
  const activeProfileId = useProfilesStore((state) => state.activeProfileId);
  const load = useProfilesStore((state) => state.load);
  const activate = useProfilesStore((state) => state.activate);
  const resetDefaults = useProfilesStore((state) => state.resetDefaults);
  const pushToast = useUiStore((state) => state.pushToast);

  const [editing, setEditing] = useState<PowerProfile | null>(null);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const uuids = useMemo(() => devices.map((device) => device.uuid), [devices]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (uuids.length > 0) void loadBounds(uuids);
  }, [uuids, loadBounds]);

  const activateProfile = async (profile: PowerProfile): Promise<void> => {
    setBusyId(profile.id);
    try {
      const results = await activate(profile.id);
      const failed = results.filter((result) => !result.ok);
      if (failed.length === 0) {
        pushToast({ variant: 'success', title: t('profiles.activateSuccess'), description: profile.name });
      } else {
        pushToast({
          variant: 'error',
          title: t('error.title'),
          description: failed[0]?.error?.message ?? t('error.unknown'),
        });
      }
    } catch (error) {
      pushToast({
        variant: 'error',
        title: t('error.title'),
        description: (error as Error).message,
      });
    } finally {
      setBusyId(null);
    }
  };

  const restoreDefaults = async (): Promise<void> => {
    try {
      await resetDefaults();
      pushToast({ variant: 'success', title: t('power.resetDone') });
    } catch (error) {
      pushToast({
        variant: 'error',
        title: t('error.title'),
        description: (error as Error).message,
      });
    }
  };

  return (
    <div className="animate-fade-in">
      <PageHeader
        title={t('profiles.title')}
        description={t('profiles.subtitle')}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => void restoreDefaults()}>
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              {t('profiles.restoreDefaults')}
            </Button>
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              {t('profiles.create')}
            </Button>
          </>
        }
      />

      {profiles.length === 0 ? (
        <EmptyState
          icon={<Layers className="h-5 w-5" aria-hidden="true" />}
          title={t('profiles.noProfiles')}
          description={t('profiles.editHint')}
          action={
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              {t('profiles.create')}
            </Button>
          }
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {profiles.map((profile) => {
            const targets = resolveProfile(profile.entries, devices, bounds);
            const targeted = targets.filter((target) => target.watts !== null);
            const isActive = activeProfileId === profile.id;

            return (
              <Card key={profile.id} className={cn('flex flex-col', isActive && 'border-primary/60')}>
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <CardTitle className="flex items-center gap-2 text-sm">
                        <span className="truncate">{profile.name}</span>
                        {isActive && <Badge variant="default">{t('profiles.active')}</Badge>}
                      </CardTitle>
                      <CardDescription className="mt-1 leading-relaxed">
                        {profile.description}
                      </CardDescription>
                    </div>
                    <Badge variant={profile.builtin ? 'info' : 'muted'} className="shrink-0">
                      {profile.builtin ? t('profiles.builtin') : t('profiles.custom')}
                    </Badge>
                  </div>
                </CardHeader>

                <CardContent className="flex flex-1 flex-col gap-3">
                  <div>
                    <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                      {t('profiles.resolve')}
                    </p>
                    {targeted.length === 0 ? (
                      <p className="text-[11px] text-muted-foreground">{t('profiles.notTargeted')}</p>
                    ) : (
                      <ul className="space-y-1">
                        {targeted.map((target) => (
                          <li
                            key={target.uuid}
                            className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-2.5 py-1.5"
                          >
                            <span className="min-w-0 truncate text-[11px]">{target.name}</span>
                            <span className="shrink-0 text-right">
                              <span className="metric font-mono text-[11px] font-semibold">
                                {formatWatts(locale, target.watts)}
                              </span>
                              <span className="ml-1.5 text-[10px] text-muted-foreground">
                                {t(strategyLabelKey(target.strategy))}
                              </span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <p className="text-[10px] leading-relaxed text-muted-foreground">
                    {t('profiles.targets')}: {targeted.length} / {devices.length}
                  </p>

                  <Separator />

                  <div className="mt-auto flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      disabled={busyId === profile.id}
                      onClick={() => void activateProfile(profile)}
                    >
                      <Play className="h-3.5 w-3.5" aria-hidden="true" />
                      {t('profiles.activate')}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setEditing(profile)}
                    >
                      <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                      {t('profiles.edit')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={profile.builtin}
                      title={profile.builtin ? t('profiles.deleteBlocked') : undefined}
                      onClick={() => {
                        void useProfilesStore
                          .getState()
                          .remove(profile.id)
                          .then((result) => {
                            if (result.ok) {
                              pushToast({
                                variant: 'success',
                                title: t('profiles.deleteSuccess'),
                                description: profile.name,
                              });
                            } else {
                              pushToast({
                                variant: 'error',
                                title: t('profiles.deleteBlocked'),
                                description: result.error?.message ?? t('error.unknown'),
                              });
                            }
                          })
                          .catch((error: unknown) => {
                            pushToast({
                              variant: 'error',
                              title: t('error.title'),
                              description: (error as Error).message,
                            });
                          });
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      {t('profiles.delete')}
                    </Button>
                  </div>

                  {profile.builtin && (
                    <p className="text-[10px] text-muted-foreground/80">{t('profiles.builtinHint')}</p>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <ProfileEditor
        open={creating || editing !== null}
        profile={editing}
        devices={devices}
        bounds={bounds}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        onSaved={(name) => {
          pushToast({ variant: 'success', title: t('profiles.saveSuccess'), description: name });
        }}
      />
    </div>
  );
}

interface ProfileEditorProps {
  open: boolean;
  profile: PowerProfile | null;
  devices: GpuDevice[];
  bounds: Record<string, PowerLimitBounds>;
  onClose: () => void;
  onSaved: (name: string) => void;
}

function ProfileEditor({
  open,
  profile,
  devices,
  bounds,
  onClose,
  onSaved,
}: ProfileEditorProps): React.JSX.Element {
  const t = useT();
  const locale = getLocale();
  const save = useProfilesStore((state) => state.save);
  const pushToast = useUiStore((state) => state.pushToast);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [entries, setEntries] = useState<Record<string, EntryDraft>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (profile) {
      setName(profile.name);
      setDescription(profile.description);
      const drafts: Record<string, EntryDraft> = {};
      for (const device of devices) {
        const entry = profile.entries.find((item) => item.uuid === device.uuid);
        drafts[device.uuid] = {
          uuid: device.uuid,
          strategy: entry?.strategy ?? (entry?.watts !== null ? 'fixed' : 'default'),
          watts: entry?.watts !== null && entry?.watts !== undefined ? String(entry.watts) : '',
          ratio: entry?.ratio !== undefined ? String(entry.ratio) : '0.7',
        };
      }
      setEntries(drafts);
    } else {
      setName('');
      setDescription('');
      const drafts: Record<string, EntryDraft> = {};
      for (const device of devices) {
        const bound = bounds[device.uuid];
        drafts[device.uuid] = {
          uuid: device.uuid,
          strategy: 'fixed',
          watts:
            bound?.currentWatts !== null && bound?.currentWatts !== undefined
              ? String(bound.currentWatts)
              : String(bound?.defaultWatts ?? 0),
          ratio: '0.7',
        };
      }
      setEntries(drafts);
    }
  }, [open, profile, devices, bounds]);

  const submit = async (): Promise<void> => {
    setSaving(true);
    try {
      const builtEntries: ProfileEntry[] = devices
        .map((device) => {
          const draft = entries[device.uuid];
          if (!draft) return null;
          const entry: ProfileEntry = {
            uuid: device.uuid,
            watts: draft.strategy === 'fixed' && draft.watts !== '' ? Number(draft.watts) : null,
            strategy: draft.strategy,
          };
          if (draft.strategy === 'ratio') {
            const ratio = Number(draft.ratio);
            entry.ratio = Number.isFinite(ratio) ? ratio : 0.7;
          }
          return entry;
        })
        .filter((entry): entry is ProfileEntry => entry !== null);

      const now = Date.now();
      const payload: PowerProfile = {
        id: profile?.id ?? `custom-${now.toString(36)}`,
        name: name.trim() || t('profiles.untitled'),
        kind: (profile?.kind ?? 'custom') as ProfileKind,
        description: description.trim(),
        builtin: profile?.builtin ?? false,
        entries: builtEntries,
        createdAt: profile?.createdAt ?? now,
        updatedAt: now,
      };

      await save(payload);
      onSaved(payload.name);
      onClose();
    } catch (error) {
      pushToast({
        variant: 'error',
        title: t('error.title'),
        description: (error as Error).message,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{profile ? t('profiles.edit') : t('profiles.create')}</DialogTitle>
          <DialogDescription>{t('profiles.editHint')}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="profile-name">{t('common.name')}</Label>
            <Input
              id="profile-name"
              value={name}
              placeholder={t('profiles.namePlaceholder')}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="profile-description">{t('common.description')}</Label>
            <Input
              id="profile-description"
              value={description}
              placeholder={t('profiles.descriptionPlaceholder')}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
        </div>

        <div>
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {t('profiles.entries')}
          </p>
          <p className="mb-2 text-[10px] text-muted-foreground">{t('profiles.entriesHint')}</p>
          <div className="space-y-2">
            {devices.map((device) => {
              const draft = entries[device.uuid];
              if (!draft) return null;
              const bound = bounds[device.uuid];
              return (
                <div
                  key={device.uuid}
                  className="grid gap-2 rounded-lg border border-border bg-muted/25 p-2.5 sm:grid-cols-[1fr_11rem_8rem]"
                >
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium">{device.name}</p>
                    <p className="mt-0.5 text-[10px] text-muted-foreground">
                      {t('power.rangeValues', {
                        min: formatInt(locale, bound?.minWatts ?? device.power.minLimitW),
                        max: formatInt(locale, bound?.maxWatts ?? device.power.maxLimitW),
                      })}
                    </p>
                  </div>

                  <Select
                    value={draft.strategy}
                    onValueChange={(value: string) => {
                      setEntries((current) => ({
                        ...current,
                        [device.uuid]: {
                          ...current[device.uuid],
                          strategy: value as ProfileStrategy,
                        },
                      }));
                    }}
                  >
                    <SelectTrigger aria-label={t('profiles.strategy')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">{t('profiles.strategyDefault')}</SelectItem>
                      <SelectItem value="min">{t('profiles.strategyMin')}</SelectItem>
                      <SelectItem value="ratio">{t('profiles.strategyRatio')}</SelectItem>
                      <SelectItem value="fixed">{t('profiles.strategyFixed')}</SelectItem>
                    </SelectContent>
                  </Select>

                  {draft.strategy === 'ratio' ? (
                    <Input
                      type="number"
                      step="0.05"
                      min="0"
                      max="1"
                      value={draft.ratio}
                      aria-label={t('profiles.ratioValue', { value: draft.ratio })}
                      onChange={(event) =>
                        setEntries((current) => ({
                          ...current,
                          [device.uuid]: { ...current[device.uuid], ratio: event.target.value },
                        }))
                      }
                    />
                  ) : draft.strategy === 'fixed' ? (
                    <Input
                      type="number"
                      step="1"
                      value={draft.watts}
                      placeholder={t('common.value')}
                      aria-label={t('power.limitLabel')}
                      onChange={(event) =>
                        setEntries((current) => ({
                          ...current,
                          [device.uuid]: { ...current[device.uuid], watts: event.target.value },
                        }))
                      }
                    />
                  ) : (
                    <div className="flex items-center justify-end text-[11px] text-muted-foreground">
                      {t(strategyLabelKey(draft.strategy))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={saving}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
