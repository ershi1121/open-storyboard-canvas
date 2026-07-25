import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  FlaskConical,
  Loader2,
  Sparkles,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { CustomImageProviderContractEditor } from '@/components/settings/CustomImageProviderContractEditor';
import {
  UiButton,
  UiCheckbox,
  UiInput,
  UiSelect,
  UiTextArea,
} from '@/components/ui/primitives';
import {
  customImageProviderConfigToDraft,
  customImageProviderDraftToConfig,
  parseCustomImageProviderJsonRecord,
  stringifyCustomImageRequestContract,
  type CustomImageProviderDraft,
  type CustomImageProviderFieldIssue,
} from '@/features/canvas/application/customImageProviderConfig';
import {
  normalizeCustomImageRequestContract,
  type ImageFieldEncoding,
  type ImageFieldMode,
  type ImageRequestBodyMode,
  type ImageRequestMethod,
} from '@/features/canvas/application/customImageProviderContract';
import {
  testCustomProviderConnectivity,
  type CustomProviderTestResult,
} from '@/features/canvas/infrastructure/customProviderGateway';
import {
  isImageCustomProvider,
  useCustomProvidersStore,
} from '@/stores/customProvidersStore';
import { CustomImageProviderCreationChoice } from './CustomImageProviderCreationChoice';
import { CustomProviderConfigAssistantDialog } from './CustomProviderConfigAssistantDialog';
import {
  CUSTOM_IMAGE_PROVIDER_WORKBENCH_STEPS,
  createCustomImageProviderWorkbenchDraft,
  getImageToImageVariant,
  getTextToImageVariant,
  splitWorkbenchValues,
  type CustomImageProviderCreationRoute,
  type CustomImageProviderWorkbenchStep,
} from './customImageProviderWorkbenchState';

type AuthMode = 'bearer' | 'header' | 'query' | 'none';

const BODY_MODES: ImageRequestBodyMode[] = ['json', 'multipart', 'form-urlencoded'];
const METHODS: ImageRequestMethod[] = ['POST', 'GET'];
const IMAGE_FIELD_MODES: ImageFieldMode[] = ['single', 'array', 'repeat'];
const IMAGE_ENCODINGS: ImageFieldEncoding[] = ['data-url', 'base64', 'url'];

function generateProviderId(): string {
  return `cp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function isPresetImageProvider(provider: { extraParams?: Record<string, unknown> }): boolean {
  return provider.extraParams?.providerConfigVersion === 'new-v1';
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readAuth(draft: CustomImageProviderDraft): { mode: AuthMode; name: string; prefix: string } {
  const auth = isPlainRecord(draft.extraParams.auth) ? draft.extraParams.auth : {};
  const rawMode = String(auth.mode ?? auth.type ?? 'bearer');
  const mode: AuthMode = rawMode === 'header' || rawMode === 'query' || rawMode === 'none'
    ? rawMode
    : 'bearer';
  return {
    mode,
    name: String(auth.name ?? (mode === 'query' ? 'key' : 'x-api-key')),
    prefix: String(auth.prefix ?? ''),
  };
}

function formatIssues(issues: Array<{ path: string; message: string }>): string {
  return issues.slice(0, 10).map((entry) => `${entry.path}: ${entry.message}`).join('\n');
}

function stringRecordFromText(text: string, label: string): Record<string, string> {
  const record = parseCustomImageProviderJsonRecord(text, label);
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, String(value ?? '')]));
}

function jsonText(value: unknown): string {
  return value === undefined ? '' : JSON.stringify(value, null, 2);
}

function optionalJsonRecord(text: string, label: string): Record<string, unknown> | undefined {
  return text.trim() ? parseCustomImageProviderJsonRecord(text, label) : undefined;
}

function optionalJsonValue(text: string): unknown {
  return text.trim() ? JSON.parse(text) as unknown : undefined;
}

function variantWithOptionalBodyTemplate<T extends ReturnType<typeof getTextToImageVariant>>(
  variant: T,
  bodyTemplate: Record<string, unknown> | undefined,
): T {
  const { bodyTemplate: _previousBodyTemplate, ...withoutBodyTemplate } = variant;
  return {
    ...withoutBodyTemplate,
    ...(bodyTemplate !== undefined ? { bodyTemplate } : {}),
  } as T;
}

interface StepSurfaceProps {
  title: string;
  description: string;
  children: ReactNode;
}

function StepSurface({ title, description, children }: StepSurfaceProps) {
  return (
    <div className="rounded-xl border border-border-dark bg-bg-dark/55 p-4">
      <h3 className="text-sm font-semibold text-text-dark">{title}</h3>
      <p className="mt-1 text-xs leading-5 text-text-muted">{description}</p>
      <div className="mt-4">{children}</div>
    </div>
  );
}

interface JsonFieldProps {
  label: string;
  help: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

function JsonField({ label, help, value, onChange, className = '' }: JsonFieldProps) {
  return (
    <label className={`block text-xs font-medium text-text-muted ${className}`}>
      {label}
      <UiTextArea
        className="mt-1.5 h-32 font-mono text-[11px] leading-5"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
      />
      <span className="mt-1 block text-[10px] leading-4 text-text-muted/75">{help}</span>
    </label>
  );
}

export function CustomImageProviderWorkbench() {
  const { t } = useTranslation();
  const providers = useCustomProvidersStore((state) => state.providers);
  const pendingEditId = useCustomProvidersStore((state) => state.pendingEditId);
  const addProvider = useCustomProvidersStore((state) => state.addProvider);
  const updateProvider = useCustomProvidersStore((state) => state.updateProvider);
  const setPendingEditId = useCustomProvidersStore((state) => state.setPendingEditId);
  const [route, setRoute] = useState<CustomImageProviderCreationRoute | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [draft, setDraft] = useState<CustomImageProviderDraft>(() => createCustomImageProviderWorkbenchDraft());
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [generatedByAi, setGeneratedByAi] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<CustomProviderTestResult | null>(null);
  const [extraHeadersText, setExtraHeadersText] = useState('{}');
  const [queryParamsText, setQueryParamsText] = useState('{}');
  const [textBodyText, setTextBodyText] = useState('{}');
  const [imageBodyText, setImageBodyText] = useState('{}');
  const [ratioMappingsText, setRatioMappingsText] = useState('{}');
  const [defaultParamsText, setDefaultParamsText] = useState('{}');
  const [pollingRequestBodyText, setPollingRequestBodyText] = useState('');
  const [contractText, setContractText] = useState('{\n  "version": 1\n}');
  const [contractIssues, setContractIssues] = useState<CustomImageProviderFieldIssue[]>([]);

  const currentStep = CUSTOM_IMAGE_PROVIDER_WORKBENCH_STEPS[stepIndex];
  const textVariant = useMemo(() => getTextToImageVariant(draft), [draft]);
  const imageVariant = useMemo(() => getImageToImageVariant(draft), [draft]);
  const auth = useMemo(() => readAuth(draft), [draft]);
  const imageEnabled = Boolean(draft.imageRequestContract.imageToImage);
  const asyncTask = textVariant.asyncTask ?? {};

  const hydrateDraft = (nextDraft: CustomImageProviderDraft, nextRoute: CustomImageProviderCreationRoute) => {
    setDraft(nextDraft);
    setRoute(nextRoute);
    setStepIndex(0);
    setExtraHeadersText(jsonText(nextDraft.extraHeaders ?? {}));
    setQueryParamsText(jsonText(nextDraft.queryParams ?? {}));
    setTextBodyText(jsonText(getTextToImageVariant(nextDraft).bodyTemplate));
    setImageBodyText(jsonText(getImageToImageVariant(nextDraft).bodyTemplate));
    setRatioMappingsText(jsonText(nextDraft.imageRequestContract.ratioMappings));
    setDefaultParamsText(jsonText(nextDraft.defaultRequestParams ?? {}));
    setPollingRequestBodyText(jsonText(getTextToImageVariant(nextDraft).asyncTask?.requestBody));
    setContractText(stringifyCustomImageRequestContract(nextDraft.imageRequestContract));
    setContractIssues([]);
    setError('');
    setSaved(false);
    setTestResult(null);
  };

  useEffect(() => {
    if (!pendingEditId) return;
    const provider = providers.find((item) => item.id === pendingEditId);
    if (!provider || !isImageCustomProvider(provider) || isPresetImageProvider(provider)) return;
    hydrateDraft(customImageProviderConfigToDraft(provider), 'manual');
    setPendingEditId(null);
  }, [pendingEditId, providers, setPendingEditId]);

  const updateDraft = (updater: (current: CustomImageProviderDraft) => CustomImageProviderDraft) => {
    setDraft((current) => updater(current));
    setError('');
    setSaved(false);
    setTestResult(null);
  };

  const updateTextVariant = (patch: Partial<ReturnType<typeof getTextToImageVariant>>) => {
    updateDraft((current) => {
      const nextVariant = { ...getTextToImageVariant(current), ...patch };
      return {
        ...current,
        endpointPath: nextVariant.endpointPath ?? current.endpointPath,
        httpMethod: nextVariant.method ?? current.httpMethod,
        imageRequestContract: { ...current.imageRequestContract, textToImage: nextVariant },
      };
    });
  };

  const updateImageVariant = (patch: Partial<ReturnType<typeof getImageToImageVariant>>) => {
    updateDraft((current) => ({
      ...current,
      imageRequestContract: {
        ...current.imageRequestContract,
        imageToImage: { ...getImageToImageVariant(current), ...patch },
      },
    }));
  };

  const updateAuth = (patch: Partial<{ mode: AuthMode; name: string; prefix: string }>) => {
    updateDraft((current) => {
      const nextAuth = { ...readAuth(current), ...patch };
      return {
        ...current,
        extraParams: { ...current.extraParams, auth: nextAuth },
      };
    });
  };

  const normalizeFragmentState = (): CustomImageProviderDraft | null => {
    try {
      const extraHeaders = stringRecordFromText(extraHeadersText, t('settings.customProviders.workbench.fields.extraHeaders'));
      const queryParams = stringRecordFromText(queryParamsText, t('settings.customProviders.workbench.fields.queryParams'));
      const textBody = optionalJsonRecord(textBodyText, t('settings.customProviders.workbench.fields.bodyTemplate'));
      const imageBody = optionalJsonRecord(imageBodyText, t('settings.customProviders.workbench.fields.imageBodyTemplate'));
      const ratioMappings = optionalJsonRecord(ratioMappingsText, t('settings.customProviders.workbench.fields.ratioMappings'));
      const defaultRequestParams = parseCustomImageProviderJsonRecord(defaultParamsText, t('settings.customProviders.workbench.fields.defaultParams'));
      const pollingRequestBody = optionalJsonValue(pollingRequestBodyText);
      const normalizedTextVariant = variantWithOptionalBodyTemplate(textVariant, textBody);
      const textToImage = normalizedTextVariant.asyncTask
        ? {
            ...normalizedTextVariant,
            asyncTask: {
              ...normalizedTextVariant.asyncTask,
              ...(pollingRequestBody !== undefined
                ? { requestBody: pollingRequestBody }
                : { requestBody: undefined }),
            },
          }
        : normalizedTextVariant;
      const rawContract = {
        ...draft.imageRequestContract,
        textToImage,
        ...(imageEnabled ? { imageToImage: variantWithOptionalBodyTemplate(imageVariant, imageBody) } : { imageToImage: undefined }),
        ...(ratioMappings !== undefined ? { ratioMappings } : { ratioMappings: undefined }),
      };
      const normalized = normalizeCustomImageRequestContract(rawContract);
      if (!normalized.value || normalized.issues.length > 0) {
        setContractIssues(normalized.issues);
        setError(formatIssues(normalized.issues));
        return null;
      }
      const nextDraft: CustomImageProviderDraft = {
        ...draft,
        extraHeaders,
        queryParams,
        defaultRequestParams,
        imageRequestContract: normalized.value,
      };
      setDraft(nextDraft);
      setContractText(stringifyCustomImageRequestContract(normalized.value));
      setContractIssues([]);
      setError('');
      return nextDraft;
    } catch (fragmentError) {
      setError(fragmentError instanceof Error ? fragmentError.message : String(fragmentError));
      return null;
    }
  };

  const handleChoose = (nextRoute: CustomImageProviderCreationRoute) => {
    if (nextRoute === 'ai') {
      setAssistantOpen(true);
      return;
    }
    setGeneratedByAi(false);
    hydrateDraft(createCustomImageProviderWorkbenchDraft(), 'manual');
  };

  const handleAiApply = (nextDraft: CustomImageProviderDraft) => {
    setGeneratedByAi(true);
    setAssistantOpen(false);
    hydrateDraft(nextDraft, 'ai');
  };

  const handleApplyContract = () => {
    try {
      const normalized = normalizeCustomImageRequestContract(JSON.parse(contractText) as unknown);
      const issues = normalized.issues.map((entry) => ({ path: entry.path, message: entry.message }));
      setContractIssues(issues);
      if (!normalized.value || issues.length > 0) return;
      const nextDraft = { ...draft, imageRequestContract: normalized.value };
      hydrateDraft(nextDraft, route ?? 'manual');
      setStepIndex(CUSTOM_IMAGE_PROVIDER_WORKBENCH_STEPS.length - 1);
    } catch (contractError) {
      setContractIssues([{
        path: 'imageRequestContract',
        message: contractError instanceof Error ? contractError.message : String(contractError),
      }]);
    }
  };

  const buildConfig = () => {
    const normalizedDraft = normalizeFragmentState();
    if (!normalizedDraft) return null;
    const result = customImageProviderDraftToConfig(normalizedDraft, normalizedDraft.id ?? generateProviderId());
    if (!result.value) {
      setError(formatIssues(result.issues));
      return null;
    }
    return result.value;
  };

  const handleTest = async () => {
    const config = buildConfig();
    if (!config) return;
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await testCustomProviderConnectivity(config));
    } catch (testError) {
      setTestResult({ ok: false, errorMessage: testError instanceof Error ? testError.message : String(testError) });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = () => {
    const config = buildConfig();
    if (!config) return;
    if (draft.id) updateProvider(draft.id, config);
    else addProvider(config);
    hydrateDraft(customImageProviderConfigToDraft(config), route ?? 'manual');
    setStepIndex(CUSTOM_IMAGE_PROVIDER_WORKBENCH_STEPS.length - 1);
    setSaved(true);
  };

  const moveStep = (direction: -1 | 1) => {
    if (direction > 0 && !normalizeFragmentState()) return;
    setStepIndex((current) => Math.min(
      CUSTOM_IMAGE_PROVIDER_WORKBENCH_STEPS.length - 1,
      Math.max(0, current + direction),
    ));
  };

  const renderConnectionStep = () => (
    <StepSurface
      title={t('settings.customProviders.workbench.stepTitles.connection')}
      description={t('settings.customProviders.workbench.stepDescriptions.connection')}
    >
      <div className="grid gap-3 lg:grid-cols-2">
        <label className="block text-xs font-medium text-text-muted">
          {t('settings.customProviders.workbench.fields.label')}
          <UiInput className="mt-1.5" value={draft.label} onChange={(event) => updateDraft((current) => ({ ...current, label: event.target.value }))} />
        </label>
        <label className="block text-xs font-medium text-text-muted">
          {t('settings.customProviders.workbench.fields.baseUrl')}
          <UiInput className="mt-1.5 font-mono" value={draft.baseUrl} onChange={(event) => updateDraft((current) => ({ ...current, baseUrl: event.target.value }))} placeholder="https://api.example.com/v1" />
        </label>
        <label className="block text-xs font-medium text-text-muted">
          {t('settings.customProviders.workbench.fields.authMode')}
          <UiSelect className="mt-1.5 h-9" value={auth.mode} onChange={(event) => updateAuth({ mode: event.target.value as AuthMode })}>
            {(['bearer', 'header', 'query', 'none'] as AuthMode[]).map((mode) => <option key={mode} value={mode}>{t(`settings.customProviders.workbench.authModes.${mode}`)}</option>)}
          </UiSelect>
        </label>
        {auth.mode !== 'none' && (
          <label className="block text-xs font-medium text-text-muted">
            {t('settings.customProviders.workbench.fields.apiKey')}
            <UiInput className="mt-1.5 font-mono" type="password" value={draft.apiKey} onChange={(event) => updateDraft((current) => ({ ...current, apiKey: event.target.value }))} />
          </label>
        )}
        {(auth.mode === 'header' || auth.mode === 'query') && (
          <label className="block text-xs font-medium text-text-muted">
            {t('settings.customProviders.workbench.fields.authName')}
            <UiInput className="mt-1.5 font-mono" value={auth.name} onChange={(event) => updateAuth({ name: event.target.value })} placeholder={auth.mode === 'query' ? 'key' : 'x-api-key'} />
          </label>
        )}
        {(auth.mode === 'header' || auth.mode === 'query') && (
          <label className="block text-xs font-medium text-text-muted">
            {t('settings.customProviders.workbench.fields.authPrefix')}
            <UiInput className="mt-1.5 font-mono" value={auth.prefix} onChange={(event) => updateAuth({ prefix: event.target.value })} placeholder="Token" />
          </label>
        )}
        <JsonField label={t('settings.customProviders.workbench.fields.extraHeaders')} help={t('settings.customProviders.workbench.help.extraHeaders')} value={extraHeadersText} onChange={setExtraHeadersText} />
        <JsonField label={t('settings.customProviders.workbench.fields.queryParams')} help={t('settings.customProviders.workbench.help.queryParams')} value={queryParamsText} onChange={setQueryParamsText} />
      </div>
    </StepSurface>
  );

  const renderRequestStep = () => (
    <StepSurface title={t('settings.customProviders.workbench.stepTitles.request')} description={t('settings.customProviders.workbench.stepDescriptions.request')}>
      <div className="grid gap-3 lg:grid-cols-3">
        <label className="block text-xs font-medium text-text-muted lg:col-span-2">
          {t('settings.customProviders.workbench.fields.endpointPath')}
          <UiInput className="mt-1.5 font-mono" value={textVariant.endpointPath ?? ''} onChange={(event) => updateTextVariant({ endpointPath: event.target.value })} placeholder="/images/generations" />
        </label>
        <label className="block text-xs font-medium text-text-muted">
          {t('settings.customProviders.workbench.fields.method')}
          <UiSelect className="mt-1.5 h-9" value={textVariant.method ?? 'POST'} onChange={(event) => updateTextVariant({ method: event.target.value as ImageRequestMethod })}>
            {METHODS.map((method) => <option key={method} value={method}>{method}</option>)}
          </UiSelect>
        </label>
        <label className="block text-xs font-medium text-text-muted">
          {t('settings.customProviders.workbench.fields.bodyMode')}
          <UiSelect className="mt-1.5 h-9" value={textVariant.bodyMode ?? 'json'} onChange={(event) => updateTextVariant({ bodyMode: event.target.value as ImageRequestBodyMode })}>
            {BODY_MODES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
          </UiSelect>
        </label>
        <JsonField className="lg:col-span-2" label={t('settings.customProviders.workbench.fields.bodyTemplate')} help={t('settings.customProviders.workbench.help.bodyTemplate')} value={textBodyText} onChange={setTextBodyText} />
        <JsonField className="lg:col-span-3" label={t('settings.customProviders.workbench.fields.defaultParams')} help={t('settings.customProviders.workbench.help.defaultParams')} value={defaultParamsText} onChange={setDefaultParamsText} />
      </div>
    </StepSurface>
  );

  const renderImagesStep = () => {
    const imageField = imageVariant.imageFields?.[0] ?? { name: 'image', mode: 'single' as const, encoding: 'data-url' as const };
    return (
      <StepSurface title={t('settings.customProviders.workbench.stepTitles.images')} description={t('settings.customProviders.workbench.stepDescriptions.images')}>
        <div className="flex items-center gap-2 text-xs text-text-dark">
          <UiCheckbox checked={imageEnabled} onCheckedChange={(checked) => updateDraft((current) => ({
            ...current,
            imageRequestContract: {
              ...current.imageRequestContract,
              ...(checked ? { imageToImage: getImageToImageVariant(current) } : { imageToImage: undefined }),
            },
          }))} />
          {t('settings.customProviders.workbench.fields.enableImageToImage')}
        </div>
        {imageEnabled && (
          <div className="mt-4 grid gap-3 lg:grid-cols-3">
            <label className="block text-xs font-medium text-text-muted lg:col-span-2">
              {t('settings.customProviders.workbench.fields.imageEndpointPath')}
              <UiInput className="mt-1.5 font-mono" value={imageVariant.endpointPath ?? ''} onChange={(event) => updateImageVariant({ endpointPath: event.target.value })} />
            </label>
            <label className="block text-xs font-medium text-text-muted">
              {t('settings.customProviders.workbench.fields.bodyMode')}
              <UiSelect className="mt-1.5 h-9" value={imageVariant.bodyMode ?? 'json'} onChange={(event) => updateImageVariant({ bodyMode: event.target.value as ImageRequestBodyMode })}>
                {BODY_MODES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
              </UiSelect>
            </label>
            <label className="block text-xs font-medium text-text-muted">
              {t('settings.customProviders.workbench.fields.imageFieldName')}
              <UiInput className="mt-1.5 font-mono" value={imageField.name} onChange={(event) => updateImageVariant({ imageFields: [{ ...imageField, name: event.target.value }] })} />
            </label>
            <label className="block text-xs font-medium text-text-muted">
              {t('settings.customProviders.workbench.fields.imageFieldMode')}
              <UiSelect className="mt-1.5 h-9" value={imageField.mode} onChange={(event) => updateImageVariant({ imageFields: [{ ...imageField, mode: event.target.value as ImageFieldMode }] })}>
                {IMAGE_FIELD_MODES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
              </UiSelect>
            </label>
            <label className="block text-xs font-medium text-text-muted">
              {t('settings.customProviders.workbench.fields.imageEncoding')}
              <UiSelect className="mt-1.5 h-9" value={imageField.encoding ?? 'data-url'} onChange={(event) => updateImageVariant({ imageFields: [{ ...imageField, encoding: event.target.value as ImageFieldEncoding }] })}>
                {IMAGE_ENCODINGS.map((encoding) => <option key={encoding} value={encoding}>{encoding}</option>)}
              </UiSelect>
            </label>
            <JsonField className="lg:col-span-3" label={t('settings.customProviders.workbench.fields.imageBodyTemplate')} help={t('settings.customProviders.workbench.help.imageBodyTemplate')} value={imageBodyText} onChange={setImageBodyText} />
          </div>
        )}
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          <label className="block text-xs font-medium text-text-muted">
            {t('settings.customProviders.workbench.fields.supportedRatios')}
            <UiTextArea className="mt-1.5 h-24 font-mono text-xs" value={draft.supportedRatios.join('\n')} onChange={(event) => updateDraft((current) => ({ ...current, supportedRatios: splitWorkbenchValues(event.target.value) }))} />
          </label>
          <label className="block text-xs font-medium text-text-muted">
            {t('settings.customProviders.workbench.fields.supportedResolutions')}
            <UiTextArea className="mt-1.5 h-24 font-mono text-xs" value={(draft.supportedResolutions ?? []).join('\n')} onChange={(event) => updateDraft((current) => ({ ...current, supportedResolutions: splitWorkbenchValues(event.target.value) }))} />
          </label>
          <JsonField className="lg:col-span-2" label={t('settings.customProviders.workbench.fields.ratioMappings')} help={t('settings.customProviders.workbench.help.ratioMappings')} value={ratioMappingsText} onChange={setRatioMappingsText} />
        </div>
      </StepSurface>
    );
  };

  const renderResponseStep = () => (
    <StepSurface title={t('settings.customProviders.workbench.stepTitles.response')} description={t('settings.customProviders.workbench.stepDescriptions.response')}>
      <div className="grid gap-3 lg:grid-cols-2">
        <label className="block text-xs font-medium text-text-muted">
          {t('settings.customProviders.workbench.fields.responseImagePaths')}
          <UiTextArea className="mt-1.5 h-28 font-mono text-xs" value={(textVariant.responseImagePaths ?? []).join('\n')} onChange={(event) => updateTextVariant({ responseImagePaths: splitWorkbenchValues(event.target.value) })} />
        </label>
        {imageEnabled && (
          <label className="block text-xs font-medium text-text-muted">
            {t('settings.customProviders.workbench.fields.imageResponsePaths')}
            <UiTextArea className="mt-1.5 h-28 font-mono text-xs" value={(imageVariant.responseImagePaths ?? []).join('\n')} onChange={(event) => updateImageVariant({ responseImagePaths: splitWorkbenchValues(event.target.value) })} />
          </label>
        )}
      </div>
      <div className="mt-4 flex items-center gap-2 text-xs text-text-dark">
        <UiCheckbox checked={Boolean(textVariant.asyncTask)} onCheckedChange={(checked) => updateTextVariant({ asyncTask: checked ? {
          taskIdPath: 'id',
          resultEndpointPath: '/jobs/{taskId}',
          resultMethod: 'GET',
          statusPath: 'status',
          successValues: ['succeeded'],
          failedValues: ['failed'],
          errorPath: 'error',
          intervalMs: 2000,
          timeoutMs: 180000,
        } : undefined })} />
        {t('settings.customProviders.workbench.fields.enableAsync')}
      </div>
      {textVariant.asyncTask && (
        <div className="mt-4 grid gap-3 lg:grid-cols-3">
          {(['taskIdPath', 'resultEndpointPath', 'statusPath', 'errorPath'] as const).map((field) => (
            <label key={field} className="block text-xs font-medium text-text-muted">
              {t(`settings.customProviders.workbench.fields.${field}`)}
              <UiInput className="mt-1.5 font-mono" value={String(asyncTask[field] ?? '')} onChange={(event) => updateTextVariant({ asyncTask: { ...asyncTask, [field]: event.target.value } })} />
            </label>
          ))}
          <label className="block text-xs font-medium text-text-muted">
            {t('settings.customProviders.workbench.fields.imagePath')}
            <UiInput className="mt-1.5 font-mono" value={String(asyncTask.imagePath ?? '')} onChange={(event) => updateTextVariant({ asyncTask: { ...asyncTask, imagePath: event.target.value } })} />
          </label>
          <label className="block text-xs font-medium text-text-muted">
            {t('settings.customProviders.workbench.fields.resultMethod')}
            <UiSelect className="mt-1.5 h-9" value={String(asyncTask.resultMethod ?? 'GET')} onChange={(event) => updateTextVariant({ asyncTask: { ...asyncTask, resultMethod: event.target.value } })}>
              {METHODS.map((method) => <option key={method} value={method}>{method}</option>)}
            </UiSelect>
          </label>
          {(['successValues', 'pendingValues', 'failedValues'] as const).map((field) => (
            <label key={field} className="block text-xs font-medium text-text-muted">
              {t(`settings.customProviders.workbench.fields.${field}`)}
              <UiInput className="mt-1.5 font-mono" value={Array.isArray(asyncTask[field]) ? asyncTask[field].join(', ') : ''} onChange={(event) => updateTextVariant({ asyncTask: { ...asyncTask, [field]: splitWorkbenchValues(event.target.value) } })} />
            </label>
          ))}
          <label className="block text-xs font-medium text-text-muted">
            {t('settings.customProviders.workbench.fields.intervalMs')}
            <UiInput
              className="mt-1.5 font-mono"
              type="number"
              min={500}
              step={100}
              value={String(asyncTask.intervalMs ?? 2000)}
              onChange={(event) => updateTextVariant({ asyncTask: { ...asyncTask, intervalMs: Number(event.target.value) } })}
            />
          </label>
          <label className="block text-xs font-medium text-text-muted">
            {t('settings.customProviders.workbench.fields.timeoutMs')}
            <UiInput
              className="mt-1.5 font-mono"
              type="number"
              min={5000}
              step={1000}
              value={String(asyncTask.timeoutMs ?? 180000)}
              onChange={(event) => updateTextVariant({ asyncTask: { ...asyncTask, timeoutMs: Number(event.target.value) } })}
            />
          </label>
          {String(asyncTask.resultMethod ?? 'GET') === 'POST' && (
            <JsonField
              className="lg:col-span-3"
              label={t('settings.customProviders.workbench.fields.pollingRequestBody')}
              help={t('settings.customProviders.workbench.help.pollingRequestBody')}
              value={pollingRequestBodyText}
              onChange={setPollingRequestBodyText}
            />
          )}
        </div>
      )}
    </StepSurface>
  );

  const renderCapabilitiesStep = () => (
    <StepSurface title={t('settings.customProviders.workbench.stepTitles.capabilities')} description={t('settings.customProviders.workbench.stepDescriptions.capabilities')}>
      <div className="grid gap-3 lg:grid-cols-2">
        <label className="block text-xs font-medium text-text-muted">
          {t('settings.customProviders.workbench.fields.models')}
          <UiTextArea className="mt-1.5 h-32 font-mono text-xs" value={draft.models.join('\n')} onChange={(event) => updateDraft((current) => ({ ...current, models: splitWorkbenchValues(event.target.value) }))} />
        </label>
        <div className="space-y-3">
          <label className="block text-xs font-medium text-text-muted">
            {t('settings.customProviders.workbench.fields.modelListEndpointPath')}
            <UiInput className="mt-1.5 font-mono" value={draft.modelListEndpointPath ?? ''} onChange={(event) => updateDraft((current) => ({ ...current, modelListEndpointPath: event.target.value }))} />
          </label>
          <label className="block text-xs font-medium text-text-muted">
            {t('settings.customProviders.workbench.fields.supportedModelVersions')}
            <UiInput className="mt-1.5 font-mono" value={(draft.supportedModelVersions ?? []).join(', ')} onChange={(event) => updateDraft((current) => ({ ...current, supportedModelVersions: splitWorkbenchValues(event.target.value) }))} />
          </label>
        </div>
        <label className="block text-xs font-medium text-text-muted lg:col-span-2">
          {t('settings.customProviders.workbench.fields.note')}
          <UiTextArea className="mt-1.5 h-24 text-xs" value={draft.note ?? ''} onChange={(event) => updateDraft((current) => ({ ...current, note: event.target.value }))} />
        </label>
      </div>
    </StepSurface>
  );

  const renderReviewStep = () => (
    <StepSurface title={t('settings.customProviders.workbench.stepTitles.review')} description={t('settings.customProviders.workbench.stepDescriptions.review')}>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {([
          ['label', draft.label || '—'],
          ['baseUrl', draft.baseUrl || '—'],
          ['models', String(draft.models.length)],
          ['requestVariants', imageEnabled ? 'T2I + I2I' : 'T2I'],
        ] as const).map(([key, value]) => (
          <div key={key} className="rounded-lg border border-border-dark bg-surface-dark px-3 py-2">
            <div className="text-[10px] text-text-muted">{t(`settings.customProviders.workbench.review.${key}`)}</div>
            <div className="mt-1 truncate text-xs font-medium text-text-dark">{value}</div>
          </div>
        ))}
      </div>
      <div className="mt-4">
        <CustomImageProviderContractEditor
          value={contractText}
          issues={contractIssues}
          generatedByAi={generatedByAi}
          onChange={(value) => { setContractText(value); setContractIssues([]); }}
          onApply={handleApplyContract}
        />
      </div>
      {testResult && (
        <div className={`mt-4 rounded-lg border px-3 py-2 text-xs ${testResult.ok ? 'border-emerald-500/25 bg-emerald-500/5 text-emerald-300' : 'border-red-500/25 bg-red-500/5 text-red-300'}`}>
          {testResult.ok ? t('settings.customProviders.workbench.testPassed') : testResult.errorMessage}
        </div>
      )}
      {saved && (
        <div className="mt-4 flex items-center gap-1.5 rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-300">
          <CheckCircle2 className="h-3.5 w-3.5" />
          {t('settings.customProviders.workbench.saved')}
        </div>
      )}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <UiButton type="button" variant="muted" size="sm" disabled={testing} onClick={() => { void handleTest(); }}>
          {testing ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <FlaskConical className="mr-1.5 h-3.5 w-3.5" />}
          {testing ? t('settings.customProviders.workbench.testing') : t('settings.customProviders.workbench.test')}
        </UiButton>
        <UiButton type="button" variant="primary" size="sm" onClick={handleSave}>
          {t('settings.customProviders.workbench.save')}
        </UiButton>
      </div>
    </StepSurface>
  );

  const renderCurrentStep = (step: CustomImageProviderWorkbenchStep) => {
    if (step === 'connection') return renderConnectionStep();
    if (step === 'request') return renderRequestStep();
    if (step === 'images') return renderImagesStep();
    if (step === 'response') return renderResponseStep();
    if (step === 'capabilities') return renderCapabilitiesStep();
    return renderReviewStep();
  };

  if (!route) {
    return (
      <>
        <CustomImageProviderCreationChoice onChoose={handleChoose} />
        <CustomProviderConfigAssistantDialog isOpen={assistantOpen} onClose={() => setAssistantOpen(false)} onApply={handleAiApply} />
      </>
    );
  }

  return (
    <section className="space-y-4 rounded-xl border border-border-dark bg-surface-dark p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-text-dark">
            {route === 'ai' && <Sparkles className="h-4 w-4 text-accent" />}
            {t('settings.customProviders.workbench.title')}
          </div>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-text-muted">
            {generatedByAi ? t('settings.customProviders.workbench.aiDraftNotice') : t('settings.customProviders.workbench.description')}
          </p>
        </div>
        <UiButton type="button" variant="ghost" size="sm" onClick={() => { setRoute(null); setGeneratedByAi(false); setError(''); }}>
          {t('settings.customProviders.workbench.backToChoice')}
        </UiButton>
      </div>

      <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {CUSTOM_IMAGE_PROVIDER_WORKBENCH_STEPS.map((step, index) => (
          <button
            key={step}
            type="button"
            onClick={() => { if (normalizeFragmentState()) setStepIndex(index); }}
            className={`rounded-lg border px-3 py-2 text-left transition-colors ${index === stepIndex ? 'border-accent/60 bg-accent/10' : index < stepIndex ? 'border-emerald-500/25 bg-emerald-500/5' : 'border-border-dark bg-bg-dark hover:border-accent/35'}`}
          >
            <div className={`text-[10px] ${index <= stepIndex ? 'text-accent' : 'text-text-muted'}`}>{String(index + 1).padStart(2, '0')}</div>
            <div className="mt-0.5 text-xs font-medium text-text-dark">{t(`settings.customProviders.workbench.steps.${step}`)}</div>
          </button>
        ))}
      </div>

      {renderCurrentStep(currentStep)}

      {error && <pre className="whitespace-pre-wrap rounded-lg border border-red-500/25 bg-red-500/5 p-3 text-[11px] leading-5 text-red-300">{error}</pre>}

      <div className="flex items-center justify-between border-t border-border-dark pt-3">
        <UiButton type="button" variant="ghost" size="sm" disabled={stepIndex === 0} onClick={() => moveStep(-1)}>
          <ChevronLeft className="mr-1 h-3.5 w-3.5" />
          {t('settings.customProviders.workbench.previous')}
        </UiButton>
        {stepIndex < CUSTOM_IMAGE_PROVIDER_WORKBENCH_STEPS.length - 1 && (
          <UiButton type="button" variant="primary" size="sm" onClick={() => moveStep(1)}>
            {t('settings.customProviders.workbench.next')}
            <ChevronRight className="ml-1 h-3.5 w-3.5" />
          </UiButton>
        )}
      </div>

      <CustomProviderConfigAssistantDialog isOpen={assistantOpen} onClose={() => setAssistantOpen(false)} onApply={handleAiApply} />
    </section>
  );
}
