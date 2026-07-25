import { describe, expect, it } from 'vitest';
import {
  buildCustomImageProviderAssistantMessages,
  parseCustomImageProviderAssistantResponse,
  sanitizeProviderDocumentationForAi,
} from './customImageProviderAiPrompt';

describe('custom image provider AI prompt', () => {
  it('redacts credentials and base64 before documentation is sent to chat', () => {
    const longBase64 = 'a'.repeat(240);
    const sanitized = sanitizeProviderDocumentationForAi([
      'Authorization: Bearer sk-secret-value',
      'X-Api-Key: top-secret',
      `image=data:image/png;base64,${longBase64}`,
      `payload=${longBase64}`,
      'POST /v1/images/generations',
    ].join('\n'));

    expect(sanitized).toContain('POST /v1/images/generations');
    expect(sanitized).not.toContain('sk-secret-value');
    expect(sanitized).not.toContain('top-secret');
    expect(sanitized).not.toContain(longBase64);
    expect(sanitized).toContain('[redacted]');
    expect(sanitized).toContain('[base64');
  });

  it('redacts JSON-quoted credential fields in pasted documentation', () => {
    const sanitized = sanitizeProviderDocumentationForAi(
      '{"Authorization":"Bearer json-secret","apiKey":"sk-json-secret","client_secret":"client-secret","password":"password-secret","prompt":"draw"}',
    );

    expect(sanitized).not.toContain('json-secret');
    expect(sanitized).not.toContain('sk-json-secret');
    expect(sanitized).not.toContain('client-secret');
    expect(sanitized).not.toContain('password-secret');
    expect(sanitized).toContain('[redacted]');
    expect(sanitized).toContain('"prompt":"draw"');
  });

  it('redacts standalone auth schemes and credential query values in pasted docs', () => {
    const sanitized = sanitizeProviderDocumentationForAi([
      'Use Bearer standalone-secret-token when calling the endpoint.',
      'GET https://api.example.com/generate?version=2026-01-01&token=query-secret&x-goog-api-key=google-secret',
    ].join('\n'));

    expect(sanitized).not.toContain('standalone-secret-token');
    expect(sanitized).not.toContain('query-secret');
    expect(sanitized).not.toContain('google-secret');
    expect(sanitized).toContain('version=2026-01-01');
  });

  it('builds exactly a fixed schema instruction plus sanitized public documentation', () => {
    const messages = buildCustomImageProviderAssistantMessages(
      'curl -H "Authorization: Bearer secret" https://api.example.com/v1/images/generations',
    );

    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message.role)).toEqual(['system', 'user']);
    expect(messages[0].content).toContain('imageRequestContract');
    expect(messages[1].content).not.toContain('secret');
    expect(messages[1].content).not.toContain('imageRequestContract');
  });

  it('parses a fenced assistant result into the same editable draft schema', () => {
    const result = parseCustomImageProviderAssistantResponse(`\`\`\`json
{
  "label": "Provider",
  "baseUrl": "https://api.example.com",
  "models": ["image-model"],
  "imageRequestContract": {
    "version": 1,
    "textToImage": {
      "endpointPath": "/generate",
      "bodyMode": "json",
      "bodyTemplate": { "model": "{{model}}", "prompt": "{{prompt}}" }
    },
    "imageToImage": {
      "endpointPath": "/generate",
      "bodyMode": "multipart",
      "bodyTemplate": { "model": "{{model}}", "prompt": "{{prompt}}" },
      "imageFields": [{ "name": "image", "mode": "repeat", "encoding": "base64" }]
    }
  }
}
\`\`\``);

    expect(result.issues).toEqual([]);
    expect(result.value?.imageRequestContract.imageToImage).toMatchObject({
      endpointPath: '/generate',
      imageFields: [{ name: 'image', mode: 'repeat', encoding: 'base64' }],
    });
    expect(result.value?.apiKey).toBe('');
  });

  it('drops sensitive values that the model puts back into config fields', () => {
    const result = parseCustomImageProviderAssistantResponse(JSON.stringify({
      label: 'Provider',
      apiKey: 'sk-should-not-survive',
      extraHeaders: {
        Authorization: 'Bearer secret',
        'X-Api-Key': 'secret',
        'X-Title': 'Storyboard',
      },
      queryParams: {
        access_token: 'secret',
        'api-version': '2026-01-01',
      },
      defaultRequestParams: {
        prompt_prefix: 'cinematic',
        secret_key: 'secret',
        client_secret: 'secret',
        password: 'secret',
      },
      imageRequestContract: {
        version: 1,
        textToImage: {
          headers: {
            Authorization: 'Bearer secret',
            'X-Goog-Api-Key': 'secret',
            'X-Title': 'Storyboard',
          },
          query: { apiKey: 'secret', version: 'v1' },
          bodyTemplate: {
            model: '{{model}}',
            prompt: '{{prompt}}',
            access_token: 'secret',
            password: 'secret',
          },
        },
      },
    }));

    expect(result.value?.apiKey).toBe('');
    expect(result.value?.extraHeaders).toEqual({ 'X-Title': 'Storyboard' });
    expect(result.value?.queryParams).toEqual({ 'api-version': '2026-01-01' });
    expect(result.value?.defaultRequestParams).toEqual({ prompt_prefix: 'cinematic' });
    expect(result.value?.imageRequestContract.textToImage).toMatchObject({
      headers: { 'X-Title': 'Storyboard' },
      query: { version: 'v1' },
      bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}' },
    });
  });
});
