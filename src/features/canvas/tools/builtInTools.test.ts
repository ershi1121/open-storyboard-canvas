import { describe, expect, it } from 'vitest';

import { cropToolPlugin } from './builtInTools';
import {
  CROP_TOOL_STATE_KEY,
  buildCropToolStatePatch,
  readCropToolState,
} from './border/cropToolState';
import { DEFAULT_BORDER_OPTIONS } from './border/types';
import {
  TEXT_LAYERS_KEY,
  buildTextLayersPatch,
  createTextLayer,
  readTextLayers,
  stringifyTextLayers,
} from './text';

function makeNodeLike(data: Record<string, unknown>) {
  return { data } as unknown as Parameters<typeof cropToolPlugin.createInitialOptions>[0];
}

describe('cropToolPlugin.createInitialOptions', () => {
  it('returns the default options when the node is missing', () => {
    // 防御性 null/undefined 也得给默认值，不能让调用方炸。
    const init = cropToolPlugin.createInitialOptions(makeNodeLike({}));
    expect(init.aspectRatio).toBe('free');
    expect(init.customAspectRatio).toBe('');
    expect(init.borderRatioMode).toBe(DEFAULT_BORDER_OPTIONS.borderRatioMode);
  });

  it('overlays the saved cropToolState on top of the defaults', () => {
    const node = makeNodeLike({
      [CROP_TOOL_STATE_KEY]: {
        aspectRatio: '16:9',
        customAspectRatio: '',
        cropX: 100,
        cropY: 50,
        cropWidth: 800,
        cropHeight: 450,
        borderStrokePercent: 3,
        borderRatioMode: '1:1',
        // borderLayers 故意留着 JSON 字符串，验证原样透传
        borderLayers: '[{"id":"x","color":"#FFFFFF","widthPercent":5}]',
      },
    });

    const init = cropToolPlugin.createInitialOptions(node);

    expect(init.aspectRatio).toBe('16:9');
    expect(init.cropWidth).toBe(800);
    expect(init.borderStrokePercent).toBe(3);
    expect(init.borderRatioMode).toBe('1:1');
    expect(init.borderRadiusPercent).toBe(DEFAULT_BORDER_OPTIONS.borderRadiusPercent);
  });

  it('ignores extra / unknown keys without complaining', () => {
    // 旧版本遗留下来的字段、或人为注入的脏值，都应该原样保留在 options 里，
    // 让 readBorderOptions / parseBorderLayers 自己去 sanitize（默认路径）。
    const node = makeNodeLike({
      [CROP_TOOL_STATE_KEY]: {
        aspectRatio: 'free',
        ancientField: 'whatever',
      },
    });

    const init = cropToolPlugin.createInitialOptions(node);

    expect(init.ancientField).toBe('whatever');
    // 关键：readCropToolState 已经过滤过非 string/number/boolean，
    // createInitialOptions 只是负责覆盖默认值 —— 字段去留由 readCropToolState 决定。
    expect(readCropToolState(node)).toBeTruthy();
  });

  it('always carries every default border key when no state is saved', () => {
    const init = cropToolPlugin.createInitialOptions(makeNodeLike({}));
    for (const key of Object.keys(DEFAULT_BORDER_OPTIONS)) {
      expect(init).toHaveProperty(key);
    }
  });
});

/**
 * 批量套用 = 「原地改图」+「把参数写进目标节点」两步。这里锁住第二步：
 * 目标图重新打开裁剪面板时，**边框和文字都必须能恢复**，否则用户套完就再也调不了。
 *
 * 踩过的坑：批量只写了 cropToolState，而 createInitialOptions 里的 `textLayers`
 * 是刻意以节点共享字段为准的（防止 cropToolState 里的旧副本复活），
 * 结果目标图打开后边框还在、文字却没了。
 */
describe('批量套用写回后目标节点能恢复出全部参数', () => {
  const mergedOptions = {
    aspectRatio: 'free',
    customAspectRatio: '',
    borderLayers: '[{"id":"l1","color":"#FFFFFF","widthPercent":5}]',
    borderStrokePercent: 2,
    borderRadiusPercent: 0,
    borderRatioMode: 'none',
    borderCustomRatio: '',
    [TEXT_LAYERS_KEY]: stringifyTextLayers([
      createTextLayer({ id: 'a', text: '图像', autoNumber: true }),
      createTextLayer({ id: 'b', text: '竖排', direction: 'vertical' }),
    ]),
    textOrderIndex: 3,
  };

  /** 复刻 handleApplyBatch 裁剪支路写进目标节点 data 的那几个 patch。 */
  const batchPatches = {
    ...buildCropToolStatePatch(mergedOptions),
    ...buildTextLayersPatch(readTextLayers(mergedOptions[TEXT_LAYERS_KEY])),
  };

  it('边框参数能恢复（来自 cropToolState）', () => {
    const init = cropToolPlugin.createInitialOptions(makeNodeLike(batchPatches));
    expect(init.borderLayers).toBe(mergedOptions.borderLayers);
    expect(init.borderStrokePercent).toBe(2);
  });

  it('文字图层也能恢复（来自共享的 textLayers 字段）', () => {
    const init = cropToolPlugin.createInitialOptions(makeNodeLike(batchPatches));
    const layers = readTextLayers(init[TEXT_LAYERS_KEY]);

    expect(layers).toHaveLength(2);
    expect(layers[0].text).toBe('图像');
    expect(layers[0].autoNumber).toBe(true);
    expect(layers[1].direction).toBe('vertical');
  });

  it('只写 cropToolState（漏写共享字段）时文字会丢 —— 这正是之前的 bug', () => {
    const init = cropToolPlugin.createInitialOptions(
      makeNodeLike(buildCropToolStatePatch(mergedOptions))
    );
    // 边框还在
    expect(init.borderLayers).toBe(mergedOptions.borderLayers);
    // 但文字没了
    expect(readTextLayers(init[TEXT_LAYERS_KEY])).toHaveLength(0);
  });
});