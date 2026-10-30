import { useEffect } from 'react';
import { getBridgeStatus } from '@renderer/lib/bridge';
import { useTelemetrySubscription } from '@renderer/hooks/useTelemetry';
import { useAppStore } from '@renderer/store/app';
import { useProfilesStore } from '@renderer/store/profiles';
import { useSettingsStore } from '@renderer/store/settings';
import { useUiStore, type SectionId } from '@renderer/store/ui';
import { useT } from '@renderer/lib/i18n';
import { Sidebar } from '@renderer/components/layout/Sidebar';
import { Header } from '@renderer/components/layout/Header';
import { BridgeErrorPanel } from '@renderer/components/layout/BridgeErrorPanel';
import { Toaster } from '@renderer/components/common/Toaster';
import { ErrorBoundary } from '@renderer/components/common/ErrorBoundary';
import { DashboardPage } from '@renderer/pages/DashboardPage';
import { GpusPage } from '@renderer/pages/GpusPage';
import { PowerLimitPage } from '@renderer/pages/PowerLimitPage';
import { ProfilesPage } from '@renderer/pages/ProfilesPage';
import { BenchmarkPage } from '@renderer/pages/BenchmarkPage';
import { OptimizerPage } from '@renderer/pages/OptimizerPage';
import { ProcessesPage } from '@renderer/pages/ProcessesPage';
import { HistoryPage } from '@renderer/pages/HistoryPage';
import { SettingsPage } from '@renderer/pages/SettingsPage';

function renderSection(section: SectionId): React.JSX.Element {
  switch (section) {
    case 'gpus':
      return <GpusPage />;
    case 'powerLimit':
      return <PowerLimitPage />;
    case 'profiles':
      return <ProfilesPage />;
    case 'benchmark':
      return <BenchmarkPage />;
    case 'optimizer':
      return <OptimizerPage />;
    case 'processes':
      return <ProcessesPage />;
    case 'history':
      return <HistoryPage />;
    case 'settings':
      return <SettingsPage />;
    case 'dashboard':
    default:
      return <DashboardPage />;
  }
}

export function App(): React.JSX.Element {
  const section = useUiStore((state) => state.section);
  const loadSettings = useSettingsStore((state) => state.load);
  const loadAppInfo = useAppStore((state) => state.load);
  const loadProfiles = useProfilesStore((state) => state.load);
  const t = useT();

  const bridgeStatus = getBridgeStatus();

  useTelemetrySubscription();

  useEffect(() => {
    void loadSettings();
    void loadAppInfo();
    void loadProfiles();
  }, [loadSettings, loadAppInfo, loadProfiles]);

  if (!bridgeStatus.available) {
    return <BridgeErrorPanel error={bridgeStatus.error} />;
  }

  return (
    <div className="flex h-full w-full overflow-hidden bg-background text-foreground">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header />
        <main className="min-h-0 flex-1 overflow-y-auto" tabIndex={-1}>
          <div className="mx-auto w-full max-w-[1680px] px-4 py-5 sm:px-6">
            <ErrorBoundary
              key={section}
              title={t('error.title')}
              description={t('error.unknown')}
              retryLabel={t('common.retry')}
            >
              {renderSection(section)}
            </ErrorBoundary>
          </div>
        </main>
      </div>
      <Toaster />
    </div>
  );
}
