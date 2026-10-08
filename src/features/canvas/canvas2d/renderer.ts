import { getImage, getImageState } from './imageCache';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import type { RenderNode, SceneModel } from './sceneModel';
import type { SpatialGrid } from './spatialGrid';

/**
 * Canvas2D 渲染器：纯绘制，无状态、无 React。
 *
 * 每帧流程：清屏 → 点阵背景 → 边 → 节点（网格裁剪 + 三级 LOD）。
 * LOD 策略：
 *   L0 (zoom < 0.28)  缩略图 + 边框 + 状态点（全览模式，千级节点的主力档位）
 *   L1 (zoom < 0.75)  + 标题栏 / 徽标 / 文本预览
 *   L2 (zoom >= 0.75) + 阴影 / 进度脉冲 / 选中手柄 / 悬停高亮
 * 文字采用"屏幕恒定"策略：zoom <= 1 时字号补偿 1/zoom（始终可读），
 * zoom > 1 时回归世界固定尺寸（与 DOM 节点视觉一致）。
 */

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export interface DrawStats {
  visible: number;
  edgesDrawn: number;
  calls: number;
}

export interface SnapGuideLine {
  orientation: 'vertical' | 'horizontal';
  position: number;
}

export interface MinimapLayout {
  x: number;
  y: number;
  w: number;
  h: number;
  worldX: number;
  worldY: number;
  worldW: number;
  worldH: number;
  scale: number;
}

export interface DrawSceneOptions {
  ctx: CanvasRenderingContext2D;
  model: SceneModel;
  grid: SpatialGrid;
  cam: Camera;
  vw: number;
  vh: number;
  dpr: number;
  theme: 'dark' | 'light';
  time: number;
  hoverId: string | null;
  hoverHandle: { nodeId: string; handle: 'source' | 'target' } | null;
  selectedIds: ReadonlySet<string>;
  dragIds: ReadonlySet<string>;
  dragDx: number;
  dragDy: number;
  guides: SnapGuideLine[];
  marqueeRect: { x: number; y: number; w: number; h: number } | null;
  /** 多选联合包围盒（世界坐标），选中 ≥2 个节点时绘制浅色虚线框 */
  selectionBounds: { x: number; y: number; w: number; h: number } | null;
  /** 以 DOM 岛渲染的节点（画布不绘制其卡片与手柄） */
  domIslands: ReadonlySet<string>;
  connectPreview: { fromX: number; fromY: number; toX: number; toY: number; valid: boolean; hasTarget: boolean } | null;
  resizeOverride: { id: string; w: number; h: number } | null;
  minimap: MinimapLayout | null;
  showHandles: boolean;
  preferOriginal: boolean;
  onImageReady: () => void;
}

interface Palette {
  theme: 'dark' | 'light';
  bg: string;
  cardBg: string;
  cardBorder: string;
  headerBg: string;
  titleText: string;
  mutedText: string;
  dot: string;
  edgeIdle: string;
  shadow: string;
  placeholderText: string;
}

const DARK: Palette = {
  theme: 'dark',
  bg: '#0f131c',
  cardBg: '#1c2333',
  cardBorder: 'rgba(255,255,255,0.14)',
  headerBg: 'rgba(255,255,255,0.055)',
  titleText: '#e5eaf3',
  mutedText: '#93a0b8',
  dot: 'rgba(148,163,184,0.16)',
  edgeIdle: 'rgba(148,163,184,0.32)',
  shadow: 'rgba(0,0,0,0.35)',
  placeholderText: 'rgba(226,232,240,0.5)',
};

const LIGHT: Palette = {
  theme: 'light',
  bg: '#f4f6fa',
  cardBg: '#ffffff',
  cardBorder: 'rgba(15,23,42,0.14)',
  headerBg: 'rgba(15,23,42,0.04)',
  titleText: '#0f172a',
  mutedText: '#64748b',
  dot: 'rgba(100,116,139,0.28)',
  edgeIdle: 'rgba(71,85,105,0.38)',
  shadow: 'rgba(15,23,42,0.16)',
  placeholderText: 'rgba(51,65,85,0.45)',
};

const GEN_COLOR = '#34d399';
const FAIL_COLOR = '#f87171';
const SELECT_COLOR = '#38bdf8';
const LOD0_ZOOM = 0.28;
const LOD1_ZOOM = 0.75;
const ORIGINAL_ZOOM = 1.2; // 与 imageData.shouldUseOriginalImageByZoom 保持一致

const GLYPH: Record<string, string> = {
  image: '▣',
  video: '▶',
  audio: '♪',
  text: '¶',
  json: '{}',
  ai: '✦',
  storyboardSplit: '▦',
  storyboardGen: '▦',
  panorama: '◎',
  blueprint: '⌂',
  tag: '',
  tagGroup: '',
  group: '',
};

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** 屏幕恒定字号：zoom<=1 补偿，zoom>1 世界固定 */
function fontSize(px: number, zoom: number): number {
  return px / Math.min(zoom, 1);
}

function charWidth(ch: string, fs: number): number {
  return ch.charCodeAt(0) >= 0x2e80 ? fs : fs * 0.56;
}

function truncate(text: string, fs: number, maxWidth: number): string {
  let w = 0;
  for (let i = 0; i < text.length; i++) {
    w += charWidth(text[i], fs);
    if (w > maxWidth) return text.slice(0, Math.max(1, i - 1)) + '…';
  }
  return text;
}

/** CJK 感知换行，返回最多 maxLines 行 */
function wrapLines(text: string, fs: number, maxWidth: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = '';
  let w = 0;
  for (const ch of text) {
    if (ch === '\n') {
      lines.push(line);
      line = '';
      w = 0;
      if (lines.length >= maxLines) return lines;
      continue;
    }
    const cw = charWidth(ch, fs);
    if (w + cw > maxWidth && line) {
      lines.push(line);
      line = ch;
      w = cw;
      if (lines.length >= maxLines) return lines;
    } else {
      line += ch;
      w += cw;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  return lines;
}

/* ---------- 换行结果缓存（key: 文本+每行字符数+行数上限） ---------- */
const wrapCache = new Map<string, string[]>();
function wrapLinesCached(
  text: string,
  fs: number,
  maxWidth: number,
  maxLines: number,
  zoomBucket = 0,
): string[] {
  const charsPerLine = Math.max(1, Math.floor(maxWidth / (fs * 0.86)));
  const key = `${zoomBucket}|${charsPerLine}|${maxLines}|${text.length}|${text.slice(0, 48)}`;
  const hit = wrapCache.get(key);
  if (hit) return hit;
  const lines = wrapLines(text, fs, maxWidth, maxLines);
  if (wrapCache.size > 800) wrapCache.clear();
  wrapCache.set(key, lines);
  return lines;
}

function hexToRgba(hex: string, alpha: number): string {
  if (!hex.startsWith('#') || hex.length < 7) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/* ------------------------------------------------------------------ */

function drawDotGrid(ctx: CanvasRenderingContext2D, cam: Camera, vw: number, vh: number, dpr: number, P: Palette, calls: { n: number }): void {
  const spacings = [100, 250, 500, 1000, 2500, 5000];
  let spacing = 0;
  for (const s of spacings) {
    if (s * cam.zoom >= 26) {
      spacing = s;
      break;
    }
  }
  if (!spacing) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = P.dot;
  const startX = Math.floor(cam.x / spacing) * spacing;
  const startY = Math.floor(cam.y / spacing) * spacing;
  const endX = cam.x + vw / cam.zoom;
  const endY = cam.y + vh / cam.zoom;
  for (let wx = startX; wx <= endX; wx += spacing) {
    for (let wy = startY; wy <= endY; wy += spacing) {
      const sx = (wx - cam.x) * cam.zoom;
      const sy = (wy - cam.y) * cam.zoom;
      ctx.fillRect(sx, sy, 1.4, 1.4);
      calls.n++;
    }
  }
}

function drawEdges(ctx: CanvasRenderingContext2D, opts: DrawSceneOptions, P: Palette, view: { x: number; y: number; w: number; h: number }): number {
  const { model, cam, time, dragIds, dragDx, dragDy } = opts;
  let drawn = 0;
  ctx.lineCap = 'round';
  for (const edge of model.edges) {
    const a = model.byId.get(edge.sourceId);
    const b = model.byId.get(edge.targetId);
    if (!a || !b) continue;
    const adx = dragIds.has(a.id) ? dragDx : 0;
    const ady = dragIds.has(a.id) ? dragDy : 0;
    const bdx = dragIds.has(b.id) ? dragDx : 0;
    const bdy = dragIds.has(b.id) ? dragDy : 0;
    const ax = a.x + a.w + adx;
    const ay = a.y + a.h / 2 + ady;
    const bx = b.x + bdx;
    const by = b.y + b.h / 2 + bdy;
    const pad = 120;
    if (
      Math.max(ax, bx) + pad < view.x ||
      Math.min(ax, bx) - pad > view.x + view.w ||
      Math.max(ay, by) + pad < view.y ||
      Math.min(ay, by) - pad > view.y + view.h
    ) {
      continue;
    }
    const gap = Math.max(48, Math.abs(bx - ax) * 0.4);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.bezierCurveTo(ax + gap, ay, bx - gap, by, bx, by);
    if (edge.state === 'gen') {
      ctx.strokeStyle = GEN_COLOR;
      ctx.lineWidth = 2 / cam.zoom;
      ctx.setLineDash([7 / cam.zoom, 5 / cam.zoom]);
      ctx.lineDashOffset = (-time * 0.06) / cam.zoom;
    } else if (edge.state === 'fail') {
      ctx.strokeStyle = hexToRgba(FAIL_COLOR, 0.65);
      ctx.lineWidth = 1.6 / cam.zoom;
      ctx.setLineDash([]);
    } else {
      ctx.strokeStyle = P.edgeIdle;
      ctx.lineWidth = 1.4 / cam.zoom;
      ctx.setLineDash([]);
    }
    ctx.stroke();
    drawn++;
  }
  ctx.setLineDash([]);
  return drawn;
}

function drawMedia(
  ctx: CanvasRenderingContext2D,
  n: RenderNode,
  areaX: number,
  areaY: number,
  areaW: number,
  areaH: number,
  radius: number,
  opts: DrawSceneOptions,
  P: Palette,
): number {
  let calls = 0;
  // 双源回退（与旧版节点组件 imageFallbackSources 语义一致）：
  // 首选源已知加载失败时自动尝试另一源，避免单次失败永久灰块
  const candidates = opts.preferOriginal
    ? [n.imageUrl, n.previewUrl]
    : [n.previewUrl, n.imageUrl];
  let url: string | null = null;
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (getImageState(candidate) === 'error') continue;
    url = candidate;
    break;
  }
  if (!url) url = candidates.find((candidate): candidate is string => Boolean(candidate)) ?? null;
  const isOriginalTier =
    opts.preferOriginal && Boolean(n.imageUrl) && url === n.imageUrl &&
    Boolean(n.previewUrl) && n.previewUrl !== n.imageUrl;
  const img = url ? getImage(url, opts.onImageReady, isOriginalTier ? 'original' : 'preview') : null;
  if (img && areaW > 0 && areaH > 0) {
    const scale = Math.min(areaW / img.naturalWidth, areaH / img.naturalHeight);
    const dw = img.naturalWidth * scale;
    const dh = img.naturalHeight * scale;
    ctx.save();
    rr(ctx, areaX, areaY, areaW, areaH, radius);
    ctx.clip();
    ctx.drawImage(img, areaX + (areaW - dw) / 2, areaY + (areaH - dh) / 2, dw, dh);
    ctx.restore();
    calls += 2;
  } else {
    // 占位：类型色淡染 + 居中字形
    ctx.save();
    rr(ctx, areaX, areaY, areaW, areaH, radius);
    ctx.clip();
    ctx.fillStyle = hexToRgba(n.accent.startsWith('#') ? n.accent : '#38bdf8', 0.1);
    ctx.fillRect(areaX, areaY, areaW, areaH);
    const glyph = GLYPH[n.kind] || '▣';
    const fs = Math.min(areaW, areaH) * 0.34;
    if (fs > 6 / opts.cam.zoom) {
      ctx.fillStyle = P.placeholderText;
      ctx.font = `${fs}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(url ? glyph : glyph, areaX + areaW / 2, areaY + areaH / 2);
      calls++;
    }
    ctx.restore();
    calls++;
  }
  return calls;
}

function drawTagCapsule(ctx: CanvasRenderingContext2D, n: RenderNode, opts: DrawSceneOptions): number {
  const { cam, selectedIds, hoverId } = opts;
  let calls = 0;
  const selected = selectedIds.has(n.id);
  ctx.fillStyle = n.accent;
  ctx.globalAlpha = 0.92;
  rr(ctx, n.x, n.y, n.w, n.h, n.h / 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  calls++;
  if (selected || hoverId === n.id) {
    ctx.strokeStyle = selected ? SELECT_COLOR : 'rgba(255,255,255,0.7)';
    ctx.lineWidth = (selected ? 2.2 : 1.4) / cam.zoom;
    rr(ctx, n.x, n.y, n.w, n.h, n.h / 2);
    ctx.stroke();
    calls++;
  }
  if (n.w * cam.zoom >= 26) {
    const fs = fontSize(11, cam.zoom);
    ctx.fillStyle = '#ffffff';
    ctx.font = `600 ${fs}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(truncate(n.title, fs, n.w - fs), n.x + n.w / 2, n.y + n.h / 2);
    calls++;
  }
  ctx.textAlign = 'left';
  return calls;
}

function drawGroup(ctx: CanvasRenderingContext2D, n: RenderNode, opts: DrawSceneOptions, P: Palette): number {
  const { cam, selectedIds } = opts;
  let calls = 0;
  ctx.fillStyle = P.theme === 'light' ? 'rgba(100,116,139,0.06)' : 'rgba(100,116,139,0.09)';
  rr(ctx, n.x, n.y, n.w, n.h, 10);
  ctx.fill();
  calls++;
  ctx.strokeStyle = selectedIds.has(n.id) ? SELECT_COLOR : 'rgba(100,116,139,0.4)';
  ctx.lineWidth = (selectedIds.has(n.id) ? 2 : 1.2) / cam.zoom;
  ctx.setLineDash([6 / cam.zoom, 4 / cam.zoom]);
  rr(ctx, n.x, n.y, n.w, n.h, 10);
  ctx.stroke();
  ctx.setLineDash([]);
  calls++;
  if (n.w * cam.zoom >= 60) {
    const fs = fontSize(13, cam.zoom);
    ctx.fillStyle = P.mutedText;
    ctx.font = `600 ${fs}px system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillText(truncate(n.title, fs, n.w - fs * 2), n.x + fs * 0.6, n.y + fs * 1.1);
    calls++;
  }
  return calls;
}

function drawCard(ctx: CanvasRenderingContext2D, n: RenderNode, lod: 0 | 1 | 2, opts: DrawSceneOptions, P: Palette, zoom: number): number {
  let calls = 0;
  const selected = opts.selectedIds.has(n.id);
  const hovered = opts.hoverId === n.id;
  const screenW = n.w * zoom;
  const micro = screenW < 60;
  /** 换行缓存分桶：避免 zoom 连续变化导致每帧全量重算换行 */
  const zoomBucket = Math.round(zoom * 4);
  /** 比例缩放 + 可读下限（与 DOM 编辑器整体缩放行为一致，极缩时保底可读） */
  const px = (base: number, floor: number): number => Math.max(floor, base * zoom) / zoom;

  // 标题标签行（悬浮小标签，与编辑器布局一致）；屏幕宽 <32px 时省略
  const headerScreen = screenW >= 32 ? Math.max(10, 26 * zoom) : 0;
  const headerH = headerScreen / zoom;
  const titleFs = px(12.5, 6);
  const titleFsScreen = Math.min(headerScreen - 4, 12.5 * zoom < 6 ? 6 : 12.5 * zoom);

  // 白卡主体（标签行之下）
  const bodyY = n.y + headerH;
  const bodyH = n.h - headerH;
  const radius = micro ? 4 : 10;

  if (lod >= 2 && !micro) {
    ctx.fillStyle = P.shadow;
    rr(ctx, n.x + 4 / zoom, bodyY + 5 / zoom, n.w, bodyH, radius);
    ctx.fill();
    calls++;
  }
  ctx.fillStyle = P.cardBg;
  rr(ctx, n.x, bodyY, n.w, bodyH, radius);
  ctx.fill();
  calls++;

  // 主体内容：文本区（上）+ 图像区（下），与编辑器垂直布局一致
  const areaX = n.x + 3;
  const areaY = bodyY + 3;
  const areaW = n.w - 6;
  const areaH = bodyH - 6;
  const hasImage = Boolean(n.imageUrl || n.previewUrl);
  const showText = Boolean(n.textPreview) && screenW >= 24;
  const textFs = px(11.5, 5);
  const textFsScreen = Math.max(5, 11.5 * zoom);
  const lineH = textFs * 1.45;
  if (showText && hasImage) {
    const textH = Math.max(14, areaH * 0.42);
    const maxLines = Math.max(1, Math.min(12, Math.floor((textH * zoom) / (textFsScreen * 1.45))));
    const lines = wrapLinesCached(n.textPreview as string, textFs, areaW - 12, maxLines, zoomBucket);
    // 文本区描边（ mimics 编辑器输入框边框）
    ctx.strokeStyle = P.cardBorder;
    ctx.lineWidth = 1 / zoom;
    rr(ctx, areaX, areaY, areaW, textH, micro ? 3 : 6);
    ctx.stroke();
    ctx.fillStyle = P.titleText;
    ctx.font = `${textFs}px system-ui, sans-serif`;
    ctx.textBaseline = 'top';
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], areaX + 6, areaY + 4 + i * lineH);
      calls++;
    }
    calls += drawMedia(ctx, n, areaX, areaY + textH + 3, areaW, Math.max(0, areaH - textH - 3), micro ? 3 : 8, opts, P);
  } else if (showText) {
    const maxLines = Math.max(1, Math.min(12, Math.floor((areaH * zoom) / (textFsScreen * 1.45))));
    const lines = wrapLinesCached(n.textPreview as string, textFs, areaW - 12, maxLines, zoomBucket);
    ctx.strokeStyle = P.cardBorder;
    ctx.lineWidth = 1 / zoom;
    rr(ctx, areaX, areaY, areaW, areaH, micro ? 3 : 6);
    ctx.stroke();
    ctx.fillStyle = P.titleText;
    ctx.font = `${textFs}px system-ui, sans-serif`;
    ctx.textBaseline = 'top';
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], areaX + 6, areaY + 4 + i * lineH);
      calls++;
    }
  } else {
    calls += drawMedia(ctx, n, areaX, areaY, areaW, Math.max(0, areaH), micro ? 3 : 8, opts, P);
  }

  // 悬浮标题小标签（编辑器同款：圆角描边小chip）
  if (headerH > 0) {
    const glyph = GLYPH[n.kind];
    const titleText = truncate(n.title, titleFs, n.w - 16 / zoom);
    let tw = 0;
    for (const ch of titleText) tw += charWidth(ch, titleFs);
    const chipW = Math.min(n.w, tw + (glyph ? titleFs * 1.5 : 0) + 14 / zoom);
    const chipH = headerH * 0.82;
    ctx.fillStyle = P.theme === 'dark' ? 'rgba(255,255,255,0.06)' : 'rgba(15,23,42,0.045)';
    rr(ctx, n.x, n.y + (headerH - chipH) / 2, chipW, chipH, chipH / 2);
    ctx.fill();
    ctx.strokeStyle = P.cardBorder;
    ctx.lineWidth = 1 / zoom;
    rr(ctx, n.x, n.y + (headerH - chipH) / 2, chipW, chipH, chipH / 2);
    ctx.stroke();
    calls += 2;
    ctx.textBaseline = 'middle';
    let tx = n.x + 7 / zoom;
    if (glyph && !micro) {
      ctx.fillStyle = n.accent.startsWith('#') ? n.accent : SELECT_COLOR;
      ctx.font = `${titleFs}px system-ui, sans-serif`;
      ctx.fillText(glyph, tx, n.y + headerH / 2);
      tx += titleFs * 1.5;
      calls++;
    }
    ctx.fillStyle = P.titleText;
    ctx.font = `600 ${titleFs}px system-ui, sans-serif`;
    ctx.fillText(titleText, tx, n.y + headerH / 2);
    calls++;
    void titleFsScreen;
  }

  // 徽标 chip（时长/批次等，编辑器同款右上深色chip）
  if (lod >= 1 && n.badge && !micro && screenW >= 90) {
    const fs = px(10, 5);
    const chipW = Math.min(n.w * 0.45, fs * (n.badge.length + 1.6));
    const chipH = fs * 1.7;
    ctx.fillStyle = 'rgba(15,23,42,0.72)';
    rr(ctx, n.x + n.w - chipW, n.y - chipH * 1.3, chipW, chipH, chipH / 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = `600 ${fs}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(n.badge, n.x + n.w - chipW / 2, n.y - chipH * 0.8);
    ctx.textAlign = 'left';
    calls += 2;
  }

  // 底部按钮行（编辑器同款：灰chip + 蓝色主按钮）——仅真实拥有生成按钮的类型
  const hasGenerateButton =
    n.type === CANVAS_NODE_TYPES.imageEdit ||
    n.type === CANVAS_NODE_TYPES.aiVideo ||
    n.type === CANVAS_NODE_TYPES.aiText ||
    n.type === CANVAS_NODE_TYPES.storyboardGen;
  if (lod >= 1 && !micro && screenW >= 90 && hasGenerateButton) {
    const bh = Math.max(8, 24 * zoom) / zoom;
    const bw = 34 / zoom;
    const gw = 26 / zoom;
    const by = n.y + n.h - bh - 6 / zoom;
    ctx.fillStyle = P.theme === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(15,23,42,0.06)';
    rr(ctx, n.x + n.w - bw - gw - 10 / zoom, by, gw, bh, bh / 2);
    ctx.fill();
    ctx.fillStyle = '#6366f1';
    rr(ctx, n.x + n.w - bw - 6 / zoom, by, bw, bh, bh / 2);
    ctx.fill();
    calls += 2;
  }

  // 状态：生成中脉冲 / 失败红框 / 常规描边（围绕整节点）
  if (n.status === 'gen') {
    const pulse = 0.45 + 0.35 * Math.sin(opts.time / 300);
    ctx.strokeStyle = hexToRgba(GEN_COLOR, pulse);
    ctx.lineWidth = 2.4 / zoom;
    rr(ctx, n.x, n.y, n.w, n.h, radius);
    ctx.stroke();
    calls++;
    if (lod >= 1 && !micro) {
      const p = (Math.sin(opts.time / 500 + n.z) * 0.5 + 0.5);
      ctx.fillStyle = hexToRgba(GEN_COLOR, 0.9);
      ctx.fillRect(n.x + 8, n.y + n.h - 6, (n.w - 16) * p, 3);
      calls++;
    }
  } else if (n.status === 'fail') {
    ctx.strokeStyle = hexToRgba(FAIL_COLOR, 0.75);
    ctx.lineWidth = 2 / zoom;
    rr(ctx, n.x, n.y, n.w, n.h, radius);
    ctx.stroke();
    calls++;
  } else {
    ctx.strokeStyle = selected ? SELECT_COLOR : hovered ? 'rgba(148,197,255,0.75)' : P.cardBorder;
    ctx.lineWidth = (selected ? 2.2 : micro ? 0.8 : 1.2) / zoom;
    rr(ctx, n.x, bodyY, n.w, bodyH, radius);
    ctx.stroke();
    calls++;
  }

  // 选中手柄
  if (selected && lod >= 1 && !micro) {
    ctx.fillStyle = SELECT_COLOR;
    const hs = 6 / zoom;
    const corners: Array<[number, number]> = [
      [n.x, n.y],
      [n.x + n.w, n.y],
      [n.x, n.y + n.h],
      [n.x + n.w, n.y + n.h],
    ];
    for (const [cx, cy] of corners) {
      ctx.fillRect(cx - hs / 2, cy - hs / 2, hs, hs);
      calls++;
    }
  }
  return calls;
}

function drawNode(ctx: CanvasRenderingContext2D, n: RenderNode, lod: 0 | 1 | 2, opts: DrawSceneOptions, P: Palette): number {
  if (n.kind === 'group') return drawGroup(ctx, n, opts, P);
  if (n.kind === 'tag' || n.kind === 'tagGroup') return drawTagCapsule(ctx, n, opts);
  return drawCard(ctx, n, lod, opts, P, opts.cam.zoom);
}

/* ---------- v1 叠加层 ---------- */

function drawHandles(ctx: CanvasRenderingContext2D, n: RenderNode, opts: DrawSceneOptions, dx: number, dy: number): number {
  if (!opts.showHandles || n.isGroup || n.kind === 'tag' || n.kind === 'tagGroup') return 0;
  const zoom = opts.cam.zoom;
  const isHot = (h: 'source' | 'target') => opts.hoverHandle?.nodeId === n.id && opts.hoverHandle?.handle === h;
  let calls = 0;
  const dots: Array<{ handle: 'source' | 'target'; x: number; y: number; ok: boolean }> = [
    { handle: 'source', x: n.x + n.w + dx, y: n.y + n.h / 2 + dy, ok: n.canSource },
    { handle: 'target', x: n.x + dx, y: n.y + n.h / 2 + dy, ok: n.canTarget },
  ];
  for (const dot of dots) {
    if (!dot.ok) continue;
    const r = (isHot(dot.handle) ? 7 : 5) / zoom;
    ctx.beginPath();
    ctx.arc(dot.x, dot.y, r, 0, Math.PI * 2);
    ctx.fillStyle = dot.handle === 'source' ? SELECT_COLOR : opts.theme === 'dark' ? '#1c2333' : '#ffffff';
    ctx.fill();
    ctx.lineWidth = 1.6 / zoom;
    ctx.strokeStyle = dot.handle === 'source' ? '#e0f2fe' : SELECT_COLOR;
    ctx.stroke();
    calls += 2;
  }
  return calls;
}

function drawConnectPreview(ctx: CanvasRenderingContext2D, opts: DrawSceneOptions): number {
  const c = opts.connectPreview;
  if (!c) return 0;
  const zoom = opts.cam.zoom;
  const gap = Math.max(48, Math.abs(c.toX - c.fromX) * 0.4);
  ctx.beginPath();
  ctx.moveTo(c.fromX, c.fromY);
  ctx.bezierCurveTo(c.fromX + gap, c.fromY, c.toX - gap, c.toY, c.toX, c.toY);
  ctx.strokeStyle = c.hasTarget ? (c.valid ? GEN_COLOR : FAIL_COLOR) : SELECT_COLOR;
  ctx.lineWidth = 2 / zoom;
  ctx.setLineDash([8 / zoom, 6 / zoom]);
  ctx.lineDashOffset = (-opts.time * 0.05) / zoom;
  ctx.stroke();
  ctx.setLineDash([]);
  return 1;
}

function drawMarquee(ctx: CanvasRenderingContext2D, opts: DrawSceneOptions): number {
  const m = opts.marqueeRect;
  if (!m || m.w < 1 || m.h < 1) return 0;
  const zoom = opts.cam.zoom;
  ctx.fillStyle = 'rgba(56,189,248,0.10)';
  ctx.fillRect(m.x, m.y, m.w, m.h);
  ctx.strokeStyle = SELECT_COLOR;
  ctx.lineWidth = 1 / zoom;
  ctx.setLineDash([4 / zoom, 3 / zoom]);
  ctx.strokeRect(m.x, m.y, m.w, m.h);
  ctx.setLineDash([]);
  return 2;
}

function drawSelectionBounds(ctx: CanvasRenderingContext2D, opts: DrawSceneOptions): number {
  const b = opts.selectionBounds;
  if (!b) return 0;
  const zoom = opts.cam.zoom;
  const pad = 6 / zoom;
  ctx.fillStyle = 'rgba(56,189,248,0.05)';
  ctx.fillRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
  ctx.strokeStyle = 'rgba(56,189,248,0.55)';
  ctx.lineWidth = 1 / zoom;
  ctx.setLineDash([6 / zoom, 4 / zoom]);
  ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
  ctx.setLineDash([]);
  return 2;
}

function drawGuides(ctx: CanvasRenderingContext2D, opts: DrawSceneOptions, view: { x: number; y: number; w: number; h: number }): number {
  if (opts.guides.length === 0) return 0;
  const zoom = opts.cam.zoom;
  const blue = 'rgba(59, 130, 246, 0.9)';
  ctx.strokeStyle = blue;
  ctx.lineWidth = Math.max(0.5, 1 / zoom);
  ctx.setLineDash([8 / zoom, 6 / zoom]);
  let calls = 0;
  for (const g of opts.guides) {
    ctx.beginPath();
    if (g.orientation === 'vertical') {
      ctx.moveTo(g.position, view.y - view.h);
      ctx.lineTo(g.position, view.y + view.h * 2);
    } else {
      ctx.moveTo(view.x - view.w, g.position);
      ctx.lineTo(view.x + view.w * 2, g.position);
    }
    ctx.stroke();
    calls++;
  }
  ctx.setLineDash([]);
  return calls;
}

function drawResizeGhost(ctx: CanvasRenderingContext2D, model: SceneModel, opts: DrawSceneOptions): number {
  const r = opts.resizeOverride;
  if (!r) return 0;
  const n = model.byId.get(r.id);
  if (!n) return 0;
  const zoom = opts.cam.zoom;
  ctx.strokeStyle = SELECT_COLOR;
  ctx.lineWidth = 1.5 / zoom;
  ctx.setLineDash([6 / zoom, 4 / zoom]);
  ctx.strokeRect(n.x, n.y, r.w, r.h);
  ctx.setLineDash([]);
  const fs = 11 / Math.min(zoom, 1);
  ctx.fillStyle = SELECT_COLOR;
  ctx.font = `${fs}px system-ui, sans-serif`;
  ctx.textBaseline = 'bottom';
  ctx.fillText(`${Math.round(r.w)} × ${Math.round(r.h)}`, n.x, n.y - 4 / zoom);
  return 2;
}

interface MinimapCacheState {
  canvas: HTMLCanvasElement;
  layout: MinimapLayout;
  model: SceneModel;
  theme: string;
  dpr: number;
  t: number;
}
let minimapCacheState: MinimapCacheState | null = null;
/** 小地图点阵刷新周期（毫秒）：运动期 5Hz 足够，每帧仅 blit + 视口框 */
const MINIMAP_REFRESH_MS = 200;

/** 小地图静态部分（背景/边框/节点点阵）渲染到离屏画布 */
function renderMinimapBase(
  cctx: CanvasRenderingContext2D,
  model: SceneModel,
  m: MinimapLayout,
  opts: DrawSceneOptions,
): void {
  cctx.setTransform(opts.dpr, 0, 0, opts.dpr, 0, 0);
  cctx.clearRect(0, 0, m.w, m.h);
  cctx.fillStyle = opts.theme === 'dark' ? 'rgba(11,15,24,0.82)' : 'rgba(255,255,255,0.85)';
  rr(cctx, m.x, m.y, m.w, m.h, 8);
  cctx.fill();
  cctx.strokeStyle = opts.theme === 'dark' ? 'rgba(255,255,255,0.14)' : 'rgba(15,23,42,0.16)';
  cctx.lineWidth = 1;
  rr(cctx, m.x, m.y, m.w, m.h, 8);
  cctx.stroke();
  cctx.save();
  rr(cctx, m.x, m.y, m.w, m.h, 8);
  cctx.clip();
  const mx = (wx: number) => m.x + 6 + (wx - m.worldX) * m.scale;
  const my = (wy: number) => m.y + 6 + (wy - m.worldY) * m.scale;
  for (const n of model.nodes) {
    const x = mx(n.x);
    const y = my(n.y);
    const w = Math.max(1, n.w * m.scale);
    const h = Math.max(1, n.h * m.scale);
    if (x + w < m.x || x > m.x + m.w || y + h < m.y || y > m.y + m.h) continue;
    cctx.fillStyle = opts.selectedIds.has(n.id)
      ? SELECT_COLOR
      : n.isGroup
        ? 'rgba(100,116,139,0.35)'
        : opts.theme === 'dark'
          ? 'rgba(148,163,184,0.55)'
          : 'rgba(71,85,105,0.5)';
    cctx.fillRect(x, y, w, h);
  }
  cctx.restore();
}

/** 小地图：离屏缓存 blit + 实时视口框（O(1)/帧，替代 O(N)/帧） */
function drawMinimapCached(
  ctx: CanvasRenderingContext2D,
  model: SceneModel,
  opts: DrawSceneOptions,
  P: Palette,
): number {
  const m = opts.minimap;
  if (!m) return 0;
  const now = opts.time;
  let st = minimapCacheState;
  if (
    !st ||
    st.model !== model ||
    st.theme !== opts.theme ||
    st.dpr !== opts.dpr ||
    now - st.t > MINIMAP_REFRESH_MS
  ) {
    if (!st) {
      st = minimapCacheState = {
        canvas: document.createElement('canvas'),
        layout: { ...m },
        model,
        theme: opts.theme,
        dpr: opts.dpr,
        t: now,
      };
    }
    st.layout = { ...m };
    st.model = model;
    st.theme = opts.theme;
    st.dpr = opts.dpr;
    st.t = now;
    const c = st.canvas;
    c.width = Math.max(1, Math.round(m.w * opts.dpr));
    c.height = Math.max(1, Math.round(m.h * opts.dpr));
    const cctx = c.getContext('2d');
    if (!cctx) return drawMinimap(ctx, model, opts, P);
    renderMinimapBase(cctx, model, m, opts);
  }
  const L = st.layout;
  ctx.setTransform(opts.dpr, 0, 0, opts.dpr, 0, 0);
  ctx.drawImage(st.canvas, L.x, L.y, L.w, L.h);
  const mx = (wx: number) => L.x + 6 + (wx - L.worldX) * L.scale;
  const my = (wy: number) => L.y + 6 + (wy - L.worldY) * L.scale;
  const vx = mx(opts.cam.x);
  const vy = my(opts.cam.y);
  const vw2 = (opts.vw / opts.cam.zoom) * L.scale;
  const vh2 = (opts.vh / opts.cam.zoom) * L.scale;
  ctx.fillStyle = 'rgba(56,189,248,0.10)';
  ctx.fillRect(vx, vy, vw2, vh2);
  ctx.strokeStyle = SELECT_COLOR;
  ctx.lineWidth = 1.2;
  ctx.strokeRect(vx, vy, vw2, vh2);
  return 4;
}

/** 旧版逐帧小地图（离屏不可用时的回退） */
function drawMinimap(ctx: CanvasRenderingContext2D, model: SceneModel, opts: DrawSceneOptions, P: Palette): number {
  const m = opts.minimap;
  if (!m) return 0;
  let calls = 0;
  ctx.setTransform(opts.dpr, 0, 0, opts.dpr, 0, 0);
  ctx.fillStyle = opts.theme === 'dark' ? 'rgba(11,15,24,0.82)' : 'rgba(255,255,255,0.85)';
  rr(ctx, m.x, m.y, m.w, m.h, 8);
  ctx.fill();
  ctx.strokeStyle = opts.theme === 'dark' ? 'rgba(255,255,255,0.14)' : 'rgba(15,23,42,0.16)';
  ctx.lineWidth = 1;
  rr(ctx, m.x, m.y, m.w, m.h, 8);
  ctx.stroke();
  calls += 2;
  ctx.save();
  rr(ctx, m.x, m.y, m.w, m.h, 8);
  ctx.clip();
  const mx = (wx: number) => m.x + 6 + (wx - m.worldX) * m.scale;
  const my = (wy: number) => m.y + 6 + (wy - m.worldY) * m.scale;
  for (const n of model.nodes) {
    const x = mx(n.x);
    const y = my(n.y);
    const w = Math.max(1, n.w * m.scale);
    const h = Math.max(1, n.h * m.scale);
    if (x + w < m.x || x > m.x + m.w || y + h < m.y || y > m.y + m.h) continue;
    ctx.fillStyle = opts.selectedIds.has(n.id)
      ? SELECT_COLOR
      : n.isGroup
        ? 'rgba(100,116,139,0.35)'
        : opts.theme === 'dark'
          ? 'rgba(148,163,184,0.55)'
          : 'rgba(71,85,105,0.5)';
    ctx.fillRect(x, y, w, h);
    calls++;
  }
  // 视口框
  const vx = mx(opts.cam.x);
  const vy = my(opts.cam.y);
  const vw2 = (opts.vw / opts.cam.zoom) * m.scale;
  const vh2 = (opts.vh / opts.cam.zoom) * m.scale;
  ctx.fillStyle = 'rgba(56,189,248,0.10)';
  ctx.fillRect(vx, vy, vw2, vh2);
  ctx.strokeStyle = SELECT_COLOR;
  ctx.lineWidth = 1.2;
  ctx.strokeRect(vx, vy, vw2, vh2);
  calls += 2;
  ctx.restore();
  void P;
  return calls;
}

export function drawScene(opts: DrawSceneOptions): DrawStats {
  const { ctx, model, grid, cam, vw, vh, dpr } = opts;
  const P: Palette = opts.theme === 'light' ? LIGHT : DARK;
  const zoom = cam.zoom;
  const calls = { n: 0 };

  // 清屏
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = P.bg;
  ctx.fillRect(0, 0, vw, vh);
  calls.n++;

  drawDotGrid(ctx, cam, vw, vh, dpr, P, calls);

  const view = { x: cam.x, y: cam.y, w: vw / zoom, h: vh / zoom };

  // 世界变换
  ctx.setTransform(zoom * dpr, 0, 0, zoom * dpr, -cam.x * zoom * dpr, -cam.y * zoom * dpr);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  // 边
  const edgesDrawn = drawEdges(ctx, opts, P, view);
  calls.n += edgesDrawn;

  // 节点：裁剪 + LOD
  const lod: 0 | 1 | 2 = zoom < LOD0_ZOOM ? 0 : zoom < LOD1_ZOOM ? 1 : 2;
  const pad = 8 / zoom;
  const padded = { x: view.x - pad, y: view.y - pad, w: view.w + pad * 2, h: view.h + pad * 2 };
  const candidates = grid.queryRect(padded);
  let visible = 0;
  // 网格候选按绘制顺序排序（候选数通常远小于总量；全览极端情况下为 O(V log V)）
  candidates.sort((a, b) => a - b);
  let prev = -1;
  const handleNodes: Array<{ node: RenderNode; dx: number; dy: number }> = [];
  for (const idx of candidates) {
    if (idx === prev) continue;
    prev = idx;
    let n = model.nodes[idx];
    if (!n) continue;
    if (opts.domIslands.has(n.id)) continue;
    const dx = opts.dragIds.has(n.id) ? opts.dragDx : 0;
    const dy = opts.dragIds.has(n.id) ? opts.dragDy : 0;
    if (n.x + dx + n.w + pad < view.x || n.x + dx - pad > view.x + view.w ||
        n.y + dy + n.h + pad < view.y || n.y + dy - pad > view.y + view.h) {
      continue;
    }
    visible++;
    // 缩放中的实时尺寸覆盖
    if (opts.resizeOverride && opts.resizeOverride.id === n.id) {
      n = { ...n, w: opts.resizeOverride.w, h: opts.resizeOverride.h };
    }
    if (dx !== 0 || dy !== 0) {
      ctx.save();
      ctx.translate(dx, dy);
      calls.n += drawNode(ctx, n, lod, opts, P);
      ctx.restore();
    } else {
      calls.n += drawNode(ctx, n, lod, opts, P);
    }
    if (opts.selectedIds.has(n.id) || opts.hoverId === n.id) {
      handleNodes.push({ node: n, dx, dy });
    }
  }

  // 连接桩（悬停/选中的节点）
  for (const item of handleNodes) {
    calls.n += drawHandles(ctx, item.node, opts, item.dx, item.dy);
  }

  // 叠加层：连线预览 / 框选 / 磁吸参考线 / 缩放幽灵框
  calls.n += drawSelectionBounds(ctx, opts);
  calls.n += drawConnectPreview(ctx, opts);
  calls.n += drawMarquee(ctx, opts);
  calls.n += drawGuides(ctx, opts, view);
  calls.n += drawResizeGhost(ctx, model, opts);

  // 小地图（离屏缓存 blit + 实时视口框）
  calls.n += drawMinimapCached(ctx, model, opts, P);

  return { visible, edgesDrawn, calls: calls.n };
}

export const RENDER_CONSTANTS = { LOD0_ZOOM, LOD1_ZOOM, ORIGINAL_ZOOM };
