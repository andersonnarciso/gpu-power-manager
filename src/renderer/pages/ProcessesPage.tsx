import { useEffect } from 'react';
import { Info, SquareTerminal } from 'lucide-react';
import { getLocale, useT } from '@renderer/lib/i18n';
import { formatInt, formatMiB } from '@renderer/lib/format';
import { useProcessesStore } from '@renderer/store/processes';
import { useTelemetryStore } from '@renderer/store/telemetry';
import { PageHeader, EmptyState } from '@renderer/components/common/PageStates';
import { Card, CardContent } from '@renderer/components/ui/card';
import { Badge } from '@renderer/components/ui/badge';
import { Alert, AlertDescription } from '@renderer/components/ui/alert';
import {
  Table,
  TableBody,
  TableBodyCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@renderer/components/ui/table';

export function ProcessesPage(): React.JSX.Element {
  const t = useT();
  const locale = getLocale();
  const processes = useProcessesStore((state) => state.processes);
  const load = useProcessesStore((state) => state.load);
  const devices = useTelemetryStore((state) => state.devices);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      void load();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [load]);

  const gpuName = (uuid: string | null): string => {
    if (!uuid) return t('proc.unknownGpu');
    const device = devices.find((item) => item.uuid === uuid);
    return device ? device.name : t('proc.unknownGpu');
  };

  return (
    <div className="animate-fade-in">
      <PageHeader title={t('proc.title')} description={t('proc.subtitle')} />

      <Alert variant="info" className="mb-3">
        <Info className="h-4 w-4" aria-hidden="true" />
        <AlertDescription>{t('proc.readOnlyHint')}</AlertDescription>
      </Alert>

      <Card>
        <CardContent className="p-0">
          {processes.length === 0 ? (
            <EmptyState
              icon={<SquareTerminal className="h-5 w-5" aria-hidden="true" />}
              title={t('proc.empty')}
              description={t('proc.emptyHint')}
              className="m-3 border-0 bg-transparent"
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('proc.pid')}</TableHead>
                  <TableHead>{t('proc.process')}</TableHead>
                  <TableHead>{t('proc.app')}</TableHead>
                  <TableHead>{t('proc.gpu')}</TableHead>
                  <TableHead>{t('proc.vram')}</TableHead>
                  <TableHead>{t('proc.type')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {processes.map((process) => (
                  <TableRow key={`${process.pid}-${process.name}`}>
                    <TableBodyCell className="font-mono text-[11px] text-muted-foreground">
                      {process.pid}
                    </TableBodyCell>
                    <TableBodyCell className="font-medium">{process.name}</TableBodyCell>
                    <TableBodyCell>
                      {process.friendlyApp ? (
                        <Badge variant="muted">{process.friendlyApp}</Badge>
                      ) : (
                        <span className="text-muted-foreground">{t('proc.unknownApp')}</span>
                      )}
                    </TableBodyCell>
                    <TableBodyCell className="max-w-56 truncate">{gpuName(process.gpuUuid)}</TableBodyCell>
                    <TableBodyCell className="font-mono text-[11px]">
                      {process.usedMemoryMiB === null ? '—' : formatMiB(locale, process.usedMemoryMiB)}
                    </TableBodyCell>
                    <TableBodyCell>
                      <Badge variant={process.type === 'compute' ? 'info' : 'secondary'}>
                        {process.type === 'compute' ? t('proc.typeCompute') : t('proc.typeGraphics')}
                      </Badge>
                    </TableBodyCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <p className="mt-3 text-[10px] text-muted-foreground">
        {formatInt(locale, processes.length)} · {t('proc.readOnlyHint')}
      </p>
    </div>
  );
}
