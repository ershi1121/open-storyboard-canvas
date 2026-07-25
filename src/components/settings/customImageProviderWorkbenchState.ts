import {
  createEmptyCustomImageProviderDraft,
  type CustomImageProviderDraft,
} from '@/features/canvas/application/customImageProviderConfig';
import type { ImageRequestVariantV1, JsonTemplateValue } from '@/features/canvas/application/customImageProviderContract';

export type CustomImageProviderCreationRoute = 'ai' | 'manual';

export const CUSTOM_IMAGE_PROVIDER_WORKBENCH_STEPS = [
  'connection',
  'request',
  'images',
  'response',
  'capabilities',
  'review',
] as const;

export type CustomImageProviderWorkbenchStep = typeof CUSTOM_IMAGE_PROVIDER_WORKBENCH_STEPS[number];

export const DEFAULT_IMAGE_BODY_TEMPLATE: Record<string, JsonTemplateValue> = {
  model: '{{model}}',
  prompt: '{{prompt}}',
  size: '{{size}}',
  aspect_ratio: '{{aspectRatio}}',
};

export function createCustomImageProviderWorkbenchDraft(): CustomImageProviderDraft {
  const draft = createEmptyCustomImageProviderDraft();
  return {
    ...draft,
    apiStyle: 'generic-json',
    responseFormat: 'generic',
    imageRequestContract: {
      version: 1,
      textToImage: {
        endpointPath: '',
        method: 'POST',
        bodyMode: 'json',
        bodyTemplate: { ...DEFAULT_IMAGE_BODY_TEMPLATE },
        responseImagePaths: ['data[0].url'],
      },
    },
  };
}

export function splitWorkbenchValues(value: string): string[] {
  const seen = new Set<string>();
  return value
    .split(/[\n,，]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry && !seen.has(entry) && Boolean(seen.add(entry)));
}

export function getTextToImageVariant(draft: CustomImageProviderDraft): ImageRequestVariantV1 {
  return draft.imageRequestContract.textToImage ?? {
    endpointPath: draft.endpointPath,
    method: draft.httpMethod ?? 'POST',
    bodyMode: 'json',
    bodyTemplate: { ...DEFAULT_IMAGE_BODY_TEMPLATE },
    responseImagePaths: ['data[0].url'],
  };
}

export function getImageToImageVariant(draft: CustomImageProviderDraft): ImageRequestVariantV1 {
  return draft.imageRequestContract.imageToImage ?? {
    endpointPath: getTextToImageVariant(draft).endpointPath ?? '',
    method: getTextToImageVariant(draft).method ?? 'POST',
    bodyMode: getTextToImageVariant(draft).bodyMode ?? 'json',
  };
}
