import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { MissingApiKeyHint } from '@/features/settings/MissingApiKeyHint';

export const EmptyHint = memo(function EmptyHint({
  hasConfiguredProvider,
}: { hasConfiguredProvider: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
      <div className="flex max-w-3xl flex-col items-center gap-5 px-6 text-center">
        {!hasConfiguredProvider && <MissingApiKeyHint />}
        <div>
          <div className="mb-2 text-2xl text-text-muted">{t('canvas.emptyHintTitle')}</div>
          <div className="text-sm text-text-muted opacity-60">{t('canvas.emptyHintSubtitle')}</div>
        </div>
      </div>
    </div>
  );
});