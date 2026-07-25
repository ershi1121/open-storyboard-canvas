import { describe, expect, it } from 'vitest';
import {
  applyCustomImageRatioMapping,
  diagnoseImageAspectMismatch,
  interpolateImageRequestTemplate,
  normalizeCustomImageRequestContract,
  normalizeImageFieldDescriptors,
  normalizeResponseImagePaths,
  selectImageRequestVariant,
  setValueAtSafePath,
} from './customImageProviderContract';

describe('custom image provider contract', () => {
  it('normalizes request variants, image field modes, and response paths', () => {
    const result = normalizeCustomImageRequestContract({
      version: 1,
      textToImage: {
        endpointPath: '/generate',
        method: 'post',
        bodyMode: 'json',
        bodyTemplate: { input: { prompt: '{{prompt}}' } },
        responseImagePaths: ['data[0].url', 'data[0].url', ' output.url '],
      },
      imageToImage: {
        endpointPath: '/edit',
        bodyMode: 'multipart',
        imageFields: [
          { name: 'image', mode: 'single' },
          { name: 'image[]', mode: 'repeat', encoding: 'base64' },
        ],
      },
    });

    expect(result.issues).toEqual([]);
    expect(result.value?.textToImage).toMatchObject({
      endpointPath: '/generate',
      method: 'POST',
      responseImagePaths: ['data[0].url', 'output.url'],
    });
    expect(result.value?.imageToImage?.imageFields).toEqual([
      { name: 'image', mode: 'single' },
      { name: 'image[]', mode: 'repeat', encoding: 'base64' },
    ]);
    expect(selectImageRequestVariant(result.value!, true)?.endpointPath).toBe('/edit');
    expect(selectImageRequestVariant(result.value!, false)?.endpointPath).toBe('/generate');
  });

  it('rejects executable values and prototype-mutating paths', () => {
    const result = normalizeCustomImageRequestContract({
      version: 1,
      textToImage: {
        bodyTemplate: {
          safe: 'ok',
          callback: () => 'bad',
        },
        imageFields: [{ name: '__proto__.polluted', mode: 'single' }],
      },
    });

    expect(result.issues.map((entry) => entry.path)).toEqual(expect.arrayContaining([
      'textToImage.bodyTemplate.callback',
      'textToImage.imageFields[0].name',
    ]));
    expect(() => setValueAtSafePath({}, 'constructor.prototype.polluted', true)).toThrow(/不安全/);
  });

  it('rejects unsupported template variables before a configuration is saved', () => {
    const result = normalizeCustomImageRequestContract({
      version: 1,
      textToImage: {
        bodyTemplate: {
          prompt: '{{prompt}}',
          secret: '{{apiKey}}',
          malformed: '{{extra.__proto__.token}}',
        },
      },
    });

    expect(result.issues.map((entry) => entry.path)).toEqual(expect.arrayContaining([
      'textToImage.bodyTemplate.secret',
      'textToImage.bodyTemplate.malformed',
    ]));
  });

  it('interpolates whole-value tokens without stringifying arrays', () => {
    const value = interpolateImageRequestTemplate({
      model: '{{model}}',
      prompt: 'prefix {{prompt}}',
      images: '{{images}}',
      first: '{{firstImage}}',
      strength: '{{extra.strength}}',
    }, {
      model: 'image-model',
      prompt: 'a castle',
      size: '3840x2160',
      aspectRatio: '16:9',
      images: ['data:image/png;base64,aaa', 'https://example.com/b.png'],
      extra: { strength: 0.75 },
    });

    expect(value).toEqual({
      model: 'image-model',
      prompt: 'prefix a castle',
      images: ['data:image/png;base64,aaa', 'https://example.com/b.png'],
      first: 'data:image/png;base64,aaa',
      strength: 0.75,
    });
  });

  it('writes safe nested object and array paths', () => {
    const target: Record<string, unknown> = {};
    setValueAtSafePath(target, 'input.items[0].aspectRatio', '16:9');
    setValueAtSafePath(target, 'input.items[0].size', '3840x2160');
    expect(target).toEqual({
      input: {
        items: [{ aspectRatio: '16:9', size: '3840x2160' }],
      },
    });
  });

  it('applies provider-specific ratio and arbitrary field mappings', () => {
    const normalized = normalizeCustomImageRequestContract({
      version: 1,
      ratioMappings: {
        '16:9': {
          ratio: 'landscape',
          size: '3840x2160',
          fields: {
            'parameters.aspectRatio': '{{aspectRatio}}',
            'parameters.output.size': '{{size}}',
          },
        },
      },
    }).value!;
    const applied = applyCustomImageRatioMapping(normalized, '16:9', {
      model: 'm',
      prompt: 'p',
      size: '2K',
      aspectRatio: '16:9',
      images: [],
    });

    expect(applied.aspectRatio).toBe('landscape');
    expect(applied.size).toBe('3840x2160');
    expect(applied.body).toEqual({
      parameters: {
        aspectRatio: 'landscape',
        output: { size: '3840x2160' },
      },
    });
  });

  it('preserves sibling template fields when applying nested ratio mappings', () => {
    const normalized = normalizeCustomImageRequestContract({
      version: 1,
      ratioMappings: {
        '16:9': {
          ratio: 'landscape',
          fields: {
            'input.aspectRatio': '{{aspectRatio}}',
            'input.output.size': '3840x2160',
          },
        },
      },
    }).value!;

    const applied = applyCustomImageRatioMapping(normalized, '16:9', {
      model: 'm',
      prompt: 'wide landscape',
      size: '2K',
      aspectRatio: '16:9',
      images: [],
    }, {
      input: { text: 'wide landscape' },
    });

    expect(applied.body).toEqual({
      input: {
        text: 'wide landscape',
        aspectRatio: 'landscape',
        output: { size: '3840x2160' },
      },
    });
  });

  it('normalizes helper inputs independently', () => {
    expect(normalizeImageFieldDescriptors([
      { name: 'image', mode: 'single' },
      { name: 'images', mode: 'array' },
      { name: 'image[]', mode: 'repeat' },
    ])).toHaveLength(3);
    expect(normalizeResponseImagePaths(['data[0].url', '', 'data[0].url', '__proto__.url']))
      .toEqual(['data[0].url']);
  });

  it('reports reversed and unrelated upstream aspect ratios without failing the result', () => {
    expect(diagnoseImageAspectMismatch({
      requestedRatio: '16:9',
      actualWidth: 2160,
      actualHeight: 3840,
    })).toMatchObject({ orientation: 'reversed' });

    expect(diagnoseImageAspectMismatch({
      requestedRatio: '16:9',
      actualWidth: 1024,
      actualHeight: 1024,
    })).toMatchObject({ orientation: 'different' });

    expect(diagnoseImageAspectMismatch({
      requestedRatio: '16:9',
      actualWidth: 1920,
      actualHeight: 1080,
    })).toBeNull();
  });
});
