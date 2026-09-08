import { useEffect, useState } from 'react';
import { Download, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

export function ManualUpdateNotification() {
  const { t } = useTranslation();
  const [update, setUpdate] = useState<ManualUpdateInfo | null>(null);

  useEffect(() => {
    return window.electron.onManualUpdateAvailable((nextUpdate) => {
      setUpdate(nextUpdate);
    });
  }, []);

  if (!update) {
    return null;
  }

  const dismiss = async () => {
    await window.electron.dismissManualUpdate(update.version);
    setUpdate(null);
  };

  const download = async () => {
    await window.electron.openExternalUrl(update.releaseUrl);
    await window.electron.dismissManualUpdate(update.version);
    setUpdate(null);
  };

  return (
    <div className="pointer-events-none fixed top-4 right-4 z-110 w-[min(calc(100vw-2rem),24rem)]">
      <div className="bg-popover text-popover-foreground pointer-events-auto rounded-md border p-4 shadow-lg">
        <div className="flex items-start gap-3">
          <div className="flex-1 space-y-1">
            <div className="text-sm font-semibold">{t('update.available.title')}</div>
            <div className="text-muted-foreground text-sm">
              {t('update.available.description', { version: update.version })}
            </div>
            {update.platform === 'darwin' && (
              <div className="text-muted-foreground text-xs">
                {t('update.available.macosUnsignedNote')}
              </div>
            )}
          </div>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground rounded-md p-1 transition-colors"
            aria-label={t('update.available.dismiss')}
            onClick={dismiss}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-3 flex justify-end">
          <Button size="sm" onClick={download}>
            <Download className="mr-2 h-4 w-4" />
            {t('update.available.download')}
          </Button>
        </div>
      </div>
    </div>
  );
}
