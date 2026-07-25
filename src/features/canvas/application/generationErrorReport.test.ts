import { describe, expect, it } from 'vitest';

import {
  buildGenerationErrorReport,
  sanitizeGenerationDiagnosticText,
} from './generationErrorReport';

describe('generation error diagnostic redaction', () => {
  it('redacts credentials, signed query values, and inline media from copied reports', () => {
    const inlineImage = `data:image/png;base64,${'A'.repeat(240)}`;
    const report = buildGenerationErrorReport({
      errorMessage: 'request failed with Authorization: Bearer report-secret-token',
      errorDetails: 'download https://cdn.example.com/result?id=123&signature=url-secret',
      context: {
        sourceType: 'imageEdit',
        providerId: 'provider-1',
        prompt: 'keep this prompt; Token prompt-secret',
        extraParams: {
          apiKey: 'top-level-secret',
          headers: {
            Authorization: 'Bearer nested-secret',
            'X-Goog-Api-Key': 'google-secret',
          },
          query: {
            callbackUrl: 'https://api.example.com/poll?task=abc&token=query-secret',
          },
          request: {
            image: inlineImage,
            refresh_token: 'refresh-secret',
          },
        },
      },
    });

    for (const secret of [
      'report-secret-token',
      'url-secret',
      'prompt-secret',
      'top-level-secret',
      'nested-secret',
      'google-secret',
      'query-secret',
      'refresh-secret',
      inlineImage,
    ]) {
      expect(report).not.toContain(secret);
    }
    expect(report).toContain('keep this prompt');
    expect(report).toContain('[data-url omitted]');
    expect(report).toContain('[redacted]');
    expect(report).toContain('https://cdn.example.com/result');
  });

  it('sanitizes diagnostic text independently of structured context', () => {
    const sanitized = sanitizeGenerationDiagnosticText(
      `Basic basic-secret api_key=inline-secret ${'B'.repeat(200)}`,
    );

    expect(sanitized).not.toContain('basic-secret');
    expect(sanitized).not.toContain('inline-secret');
    expect(sanitized).not.toContain('B'.repeat(200));
    expect(sanitized).toContain('Basic [redacted]');
    expect(sanitized).toContain('[base64 omitted]');
  });

  it('handles circular diagnostic context without throwing', () => {
    const circular: Record<string, unknown> = { safe: 'value' };
    circular.self = circular;

    const report = buildGenerationErrorReport({
      errorMessage: 'failed',
      context: { sourceType: 'unknown', extraParams: circular },
    });

    expect(report).toContain('"safe": "value"');
    expect(report).toContain('"self": "[circular]"');
  });
});
