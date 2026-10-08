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

export type ImageTier = 'preview' | 'original';

interface CacheEntry {
  img: HTMLImageElement;
  state: EntryState;
  /** 分辨率层级：淘汰时优先丢弃 original，保护 preview（防缩放回退重载风暴） */
  tier: ImageTier;
}

const MAX_ENTRIES = 240;
const cache = new Map<string, CacheEntry>();

/* 原图加载探针：1 秒内超过 8 张 original 层级加载时告警（限流） */
let originalLoadWindowStart = 0;
let originalLoadCount = 0;
let originalLoadLogAt = 0;
function noteOriginalLoad(): void {
  const now = Date.now();
  if (now - originalLoadWindowStart > 1000) {
    originalLoadWindowStart = now;
    originalLoadCount = 0;
  }
  originalLoadCount++;
  if (originalLoadCount > 8 && now - originalLoadLogAt > 3000) {
    originalLoadLogAt = now;
    console.warn(
      `[canvas2d] 1 秒内触发 ${originalLoadCount} 张原图加载（解码虽异步，仍可能造成 IO/内存压力）`,
    );
  }
}

/**
 * 请求图片。已就绪返回 <img>；加载中/失败返回 null（调用方画占位）。
 * onReady 在图片解码完成时回调一次（用于触发画布重绘）。
 */
export function getImage(
  url: string,
  onReady: () => void,
  tier: ImageTier = 'preview',
): HTMLImageElement | null {
  const existing = cache.get(url);
  if (existing) {
    // LRU touch：移到插入序末尾
    cache.delete(url);
    cache.set(url, existing);
    return existing.state === 'ready' ? existing.img : null;
  }

  if (tier === 'original') noteOriginalLoad();
  const img = new Image();
  img.decoding = 'async';
  const entry: CacheEntry = { img, state: 'loading', tier };
  cache.set(url, entry);
  img.onload = () => {
    // 用 decode() 把像素解码移到主线程外：避免首次 drawImage 同步解码大图冻帧
    const finish = () => {
      entry.state = 'ready';
      onReady();
    };
    if (typeof img.decode === 'function') {
      img.decode().then(finish, finish);
    } else {
      finish();
    }
  };
  img.onerror = () => {
    entry.state = 'error';
    // 诊断：图片源加载失败（常见原因：浏览器模式无法访问本地文件路径、
    // 文件被移动/删除、asset 协议范围不含该路径）
    console.warn('[canvas2d] image load failed:', url);
  };
  img.src = url;

  // 淘汰策略（loading 中的不淘汰，防加载风暴）：
  // 第一轮只淘汰 original 层（缩放回退时 preview 仍在缓存，免重载冻帧）；
  // 仍超限再按 LRU 淘汰任意已完成条目。
  if (cache.size > MAX_ENTRIES) {
    for (const key of cache.keys()) {
      if (cache.size <= MAX_ENTRIES) break;
      const candidate = cache.get(key);
      if (!candidate || candidate.state === 'loading' || candidate.tier !== 'original') continue;
      cache.delete(key);
    }
    for (const key of cache.keys()) {
      if (cache.size <= MAX_ENTRIES) break;
      const candidate = cache.get(key);
      if (!candidate || candidate.state === 'loading') continue;
      cache.delete(key);
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
