import { describe, expect, it } from 'vitest';

import {
  CROP_TOOL_STATE_KEY,
  buildCropToolStatePatch,
  mergeToolOptions,
  readCropToolState,
} from './cropToolState';

function makeNodeLike(data: Record<string, unknown>) {
  // 测试只关心 data 上的 cropToolState，构造一个形状够用的伪节点。
  return { data } as unknown as Parameters<typeof readCropToolState>[0];
}

describe('readCropToolState', () => {
  it('returns null when the node is missing', () => {
    expect(readCropToolState(null)).toBeNull();
    expect(readCropToolState(undefined)).toBeNull();
  });

  it('returns null when cropToolState is absent', () => {
    expect(readCropToolState(makeNodeLike({}))).toBeNull();
  });

  it('returns null for non-object payloads (string / number / array / null)', () => {
    expect(readCropToolState(makeNodeLike({ [CROP_TOOL_STATE_KEY]: 'garbage' }))).toBeNull();
    expect(readCropToolState(makeNodeLike({ [CROP_TOOL_STATE_KEY]: 42 }))).toBeNull();
    expect(readCropToolState(makeNodeLike({ [CROP_TOOL_STATE_KEY]: null }))).toBeNull();
    expect(readCropToolState(makeNodeLike({ [CROP_TOOL_STATE_KEY]: [] }))).toBeNull();
  });

  it('returns null when all entries are filtered out', () => {
    // 全部是非 string/number/boolean → 过滤后 hasAny=false → null
    const dirty = { [CROP_TOOL_STATE_KEY]: { aspectRatio: { value: 'free' }, layers: [] } };
    expect(readCropToolState(makeNodeLike(dirty))).toBeNull();
  });

  it('keeps only entries that are string / number / boolean', () => {
    const data = {
      [CROP_TOOL_STATE_KEY]: {
        aspectRatio: '16:9',
        cropX: 0,
        cropY: 0,
        cropWidth: 800,
        cropHeight: 450,
        borderStrokePercent: 1.5,
        borderLayers: '[]',
        // 混入的非合法类型应被丢弃
        oops: { nested: true },
        nope: [1, 2],
      },
    };

    expect(readCropToolState(makeNodeLike(data))).toEqual({
      aspectRatio: '16:9',
      cropX: 0,
      cropY: 0,
      cropWidth: 800,
      cropHeight: 450,
      borderStrokePercent: 1.5,
      borderLayers: '[]',
    });
  });

  it('round-trips through buildCropToolStatePatch', () => {
    const options = {
      aspectRatio: 'free',
      customAspectRatio: '',
      borderLayers: '[]',
      borderStrokePercent: 0,
      borderRadiusPercent: 0,
      borderRatioMode: '16:9',
      borderCustomRatio: '',
    };

    const patch = buildCropToolStatePatch(options);
    expect(readCropToolState(makeNodeLike(patch))).toEqual(options);
  });
});

describe('buildCropToolStatePatch', () => {
  it('shallow-copies so mutating the source options does not bleed in', () => {
    const original = { aspectRatio: 'free', customAspectRatio: '' };
    const patch = buildCropToolStatePatch(original);

    original.aspectRatio = '16:9';
    expect((patch[CROP_TOOL_STATE_KEY] as Record<string, unknown>).aspectRatio).toBe('free');
  });

  it('only carries the cropToolState key, nothing else', () => {
    const patch = buildCropToolStatePatch({ aspectRatio: 'free' });
    expect(Object.keys(patch)).toEqual([CROP_TOOL_STATE_KEY]);
  });
});

describe('mergeToolOptions（批量套用：共享覆盖、各自保留）', () => {
  it('保留目标图自己的裁剪框 / 目标比例，只覆盖共享规则', () => {
    const existing = {
      aspectRatio: '16:9',
      cropX: 120,
      cropY: 40,
      cropWidth: 640,
      cropHeight: 360,
      borderStrokePercent: 0,
      autoCropEnabled: false,
    };
    const shared = {
      borderStrokePercent: 3,
      borderRatioMode: '1:1',
      borderPadPercent: 10,
      autoCropEnabled: true,
      autoCropColor: '#FFFFFF',
      textOrderIndex: 2,
    };

    expect(mergeToolOptions(existing, shared)).toEqual({
      // 各自：shared 没提到的键原样保留
      aspectRatio: '16:9',
      cropX: 120,
      cropY: 40,
      cropWidth: 640,
      cropHeight: 360,
      // 共享：以当前图为准
      borderStrokePercent: 3,
      borderRatioMode: '1:1',
      borderPadPercent: 10,
      autoCropEnabled: true,
      autoCropColor: '#FFFFFF',
      textOrderIndex: 2,
    });
  });

  it('existing 为 null / undefined（目标图从没调过）时 = 直接返回 shared', () => {
    const shared = { borderStrokePercent: 3, autoCropEnabled: true };
    expect(mergeToolOptions(null, shared)).toEqual(shared);
    expect(mergeToolOptions(undefined, shared)).toEqual(shared);
  });

  it('返回新对象，不改动传入的 existing / shared', () => {
    const existing = { cropX: 5 };
    const shared = { borderStrokePercent: 3 };
    const merged = mergeToolOptions(existing, shared);
    merged.cropX = 999;
    merged.borderStrokePercent = 999;
    expect(existing.cropX).toBe(5);
    expect(shared.borderStrokePercent).toBe(3);
  });
});