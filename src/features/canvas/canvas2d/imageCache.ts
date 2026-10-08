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
export type EntryState = 'loading' | 'ready' | 'error';

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
    // 诊断：图片源加载失败（常见原因：浏览器模式无法访问本地文件路径、
    // 文件被移动/删除、asset 协议范围不含该路径）
    console.warn('[canvas2d] image load failed:', url);
  };
  img.src = url;

  // 淘汰最久未使用的【已完成】条目（loading 中的不淘汰，
  // 否则全览几百张图时会互相驱逐造成加载风暴、图片永远显示不出来）
  if (cache.size > MAX_ENTRIES) {
    for (const key of cache.keys()) {
      const candidate = cache.get(key);
      if (candidate && candidate.state === 'loading') continue;
      cache.delete(key);
      if (cache.size <= MAX_ENTRIES) break;
    }
  }
  return null;
}

/** 查询某 URL 的缓存状态；未缓存返回 null（调用方可据此做备源回退） */
export function getImageState(url: string): EntryState | null {
  return cache.get(url)?.state ?? null;
}

/** 使某 URL 的缓存失效（下次请求重新加载） */
export function invalidateImage(url: string): void {
  cache.delete(url);
}

export function clearImageCache(): void {
  cache.clear();
}

export function imageCacheSize(): number {
  return cache.size;
}
