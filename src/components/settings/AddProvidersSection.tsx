import { memo } from 'react';
import { Image, Layers, MessageSquareText, Video } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ChatProvidersSection } from '@/components/settings/ChatProvidersSection';
import { CustomImageProviderWorkbench } from '@/components/settings/CustomImageProviderWorkbench';
import { ModernProvidersSection } from '@/components/settings/ModernProvidersSection';
import { VideoProvidersSection } from '@/components/settings/VideoProvidersSection';

export type AddProviderTab = 'imageNew' | 'imageOld' | 'video' | 'chat';

interface AddProvidersSectionProps {
  activeTab: AddProviderTab;
  onTabChange: (tab: AddProviderTab) => void;
}

const TABS: Array<{
  id: AddProviderTab;
  labelKey:
    | 'settings.imageProviderConfig.preset'
    | 'settings.imageProviderConfig.fullCustom'
    | 'settings.addProviders.tabs.videoLabel'
    | 'settings.addProviders.tabs.chatLabel';
  descriptionKey: string;
  icon: typeof Image;
}> = [
  {
    id: 'imageNew',
    labelKey: 'settings.imageProviderConfig.preset',
    descriptionKey: 'settings.addProviders.tabs.imagePreset',
    icon: Image,
  },
  {
    id: 'imageOld',
    labelKey: 'settings.imageProviderConfig.fullCustom',
    descriptionKey: 'settings.addProviders.tabs.imageCustom',
    icon: Layers,
  },
  {
    id: 'video',
    labelKey: 'settings.addProviders.tabs.videoLabel',
    descriptionKey: 'settings.addProviders.tabs.video',
    icon: Video,
  },
  {
    id: 'chat',
    labelKey: 'settings.addProviders.tabs.chatLabel',
    descriptionKey: 'settings.addProviders.tabs.chat',
    icon: MessageSquareText,
  },
];

export const AddProvidersSection = memo(function AddProvidersSection({
  activeTab,
  onTabChange,
}: AddProvidersSectionProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold text-text-dark">{t('settings.addProviders.title')}</h2>
        <p className="mt-1 text-xs leading-5 text-text-muted">
          {t('settings.addProviders.description')}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const selected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onTabChange(tab.id)}
              className={`rounded-lg border p-3 text-left transition-colors ${
                selected
                  ? 'border-accent bg-accent/12'
                  : 'border-border-dark bg-bg-dark hover:border-accent/45'
              }`}
            >
              <div className="flex items-center gap-2">
                <Icon className={`h-4 w-4 ${selected ? 'text-accent' : 'text-text-muted'}`} />
                <span className="text-sm font-medium text-text-dark">
                  {t(tab.labelKey)}
                </span>
              </div>
              <div className="mt-1 text-[11px] leading-4 text-text-muted">{t(tab.descriptionKey)}</div>
            </button>
          );
        })}
      </div>

      {activeTab === 'imageNew' && <ModernProvidersSection />}
      {activeTab === 'imageOld' && <CustomImageProviderWorkbench />}
      {activeTab === 'video' && <VideoProvidersSection />}
      {activeTab === 'chat' && <ChatProvidersSection />}
    </div>
  );
});
