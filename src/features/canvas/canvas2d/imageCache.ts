/**
 * LRU 图片缓存：Canvas2D 渲染层的位图供给。
 *
 * - 懒加载：仅当渲染器请求某 URL 时才开始加载（视口驱动）。
 * - LRU 淘汰：上限 MAX_ENTRIES，超限淘汰最久未使用者，防止千级图片撑爆内存。
 * - 加载完成后回调 onReady 触发重绘（先糊后清：加载期间绘制占位）。
 *
 * 正式版路线（见设计文档 P1）：Rust 侧生成缩略图金字塔后，这里按
 * zoom 级别请求不同层级的 URL；当前先复用项目已有的 previewImageUrl。
 */
type EntryState = 'loading' | 'ready' | 'error';

interface CacheEntry {
  img: HTMLImageElement;
  state: EntryState;
}

const MAX_ENTRIES = 240;
const cache = new Map<string, CacheEntry>();

/**
 * 请求图片。已就绪返回 <img>；加载中/失败返回 null（调用方画占位）。
 * onReady 在图片解码完成时回调一次（用于触发画布重绘）。
 */
export function getImage(url: string, onReady: () => void): HTMLImageElement | null {
  const existing = cache.get(url);
  if (existing) {
    // LRU touch：移到插入序末尾
    cache.delete(url);
    cache.set(url, existing);
    return existing.state === 'ready' ? existing.img : null;
  }

  const img = new Image();
  img.decoding = 'async';
  const entry: CacheEntry = { img, state: 'loading' };
  cache.set(url, entry);
  img.onload = () => {
    entry.state = 'ready';
    onReady();
  };
  img.onerror = () => {
    entry.state = 'error';
  };
  img.src = url;

  // 淘汰最久未使用条目
  if (cache.size > MAX_ENTRIES) {
    for (const key of cache.keys()) {
      cache.delete(key);
      if (cache.size <= MAX_ENTRIES) break;
    }
  }
  return null;
}

export function clearImageCache(): void {
  cache.clear();
}

export function imageCacheSize(): number {
  return cache.size;
}
