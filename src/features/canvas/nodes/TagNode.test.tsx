import { describe, expect, it } from 'vitest';
import { resolveTagColorKey } from './TagNode';

describe('resolveTagColorKey', () => {
  it('uses the source id as the color key when a source is connected', () => {
    expect(resolveTagColorKey('Alpha', 'source-1')).toBe('src:source-1');
  });

  it('falls back to the trimmed label text when no source is connected', () => {
    expect(resolveTagColorKey('  Beta  ', null)).toBe('text:Beta');
  });
});
