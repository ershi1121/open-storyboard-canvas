import { getImage } from './imageCache';
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
  selectedIds: ReadonlySet<string>;
  dragIds: ReadonlySet<string>;
  dragDx: number;
  dragDy: number;
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
const ORIGINAL_ZOOM = 1.45; // 与 imageData.shouldUseOriginalImageByZoom 保持一致

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
  const url = opts.preferOriginal ? n.imageUrl || n.previewUrl : n.previewUrl || n.imageUrl;
  const img = url ? getImage(url, opts.onImageReady) : null;
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
  const headerH = lod >= 1 ? 26 : 0;

  if (lod >= 2) {
    ctx.fillStyle = P.shadow;
    rr(ctx, n.x + 4 / zoom, n.y + 5 / zoom, n.w, n.h, 10);
    ctx.fill();
    calls++;
  }

  // 卡片底
  ctx.fillStyle = P.cardBg;
  rr(ctx, n.x, n.y, n.w, n.h, 10);
  ctx.fill();
  calls++;

  // 媒体 / 文本区
  const areaX = n.x + 3;
  const areaY = n.y + headerH + (lod >= 1 ? 3 : 3);
  const areaW = n.w - 6;
  const areaH = n.h - headerH - 6;
  const hasImage = Boolean(n.imageUrl || n.previewUrl);
  if (n.textPreview && !hasImage && lod >= 1 && n.w * zoom >= 70) {
    const fs = fontSize(11.5, zoom);
    const lineH = fs * 1.45;
    const maxLines = Math.max(1, Math.floor((areaH - 8) / lineH));
    const lines = wrapLines(n.textPreview, fs, areaW - 12, Math.min(maxLines, 12));
    ctx.fillStyle = P.titleText;
    ctx.font = `${fs}px system-ui, sans-serif`;
    ctx.textBaseline = 'top';
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], areaX + 6, areaY + 4 + i * lineH);
      calls++;
    }
  } else {
    calls += drawMedia(ctx, n, areaX, areaY, areaW, Math.max(0, areaH), 8, opts, P);
  }

  // 标题栏
  if (lod >= 1) {
    ctx.fillStyle = P.headerBg;
    rr(ctx, n.x, n.y, n.w, headerH, 10);
    ctx.fill();
    ctx.fillRect(n.x, n.y + headerH / 2, n.w, headerH / 2);
    calls += 2;
    const fs = fontSize(12.5, zoom);
    ctx.fillStyle = P.titleText;
    ctx.font = `600 ${fs}px system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    const glyph = GLYPH[n.kind];
    let textX = n.x + 8;
    if (glyph) {
      ctx.fillStyle = n.accent.startsWith('#') ? n.accent : SELECT_COLOR;
      ctx.fillText(glyph, textX, n.y + headerH / 2);
      textX += fs * 1.4;
      calls++;
    }
    ctx.fillStyle = P.titleText;
    ctx.fillText(truncate(n.title, fs, n.w - (textX - n.x) - 10), textX, n.y + headerH / 2);
    calls++;
  }

  // 徽标 chip
  if (lod >= 1 && n.badge && n.w * zoom >= 90) {
    const fs = fontSize(10, zoom);
    const chipW = Math.min(n.w * 0.45, fs * (n.badge.length + 1.6));
    const chipH = fs * 1.7;
    ctx.fillStyle = hexToRgba(n.accent.startsWith('#') ? n.accent : SELECT_COLOR, 0.9);
    rr(ctx, n.x + n.w - chipW - 6, n.y + headerH + 6, chipW, chipH, chipH / 2);
    ctx.fill();
    ctx.fillStyle = '#0b1020';
    ctx.font = `600 ${fs}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(n.badge, n.x + n.w - chipW / 2 - 6, n.y + headerH + 6 + chipH / 2);
    ctx.textAlign = 'left';
    calls += 2;
  }

  // 状态：生成中脉冲 / 失败红框
  if (n.status === 'gen') {
    const pulse = 0.45 + 0.35 * Math.sin(opts.time / 300);
    ctx.strokeStyle = hexToRgba(GEN_COLOR, pulse);
    ctx.lineWidth = 2.4 / zoom;
    rr(ctx, n.x, n.y, n.w, n.h, 10);
    ctx.stroke();
    calls++;
    if (lod >= 1) {
      const p = (Math.sin(opts.time / 500 + n.z) * 0.5 + 0.5);
      ctx.fillStyle = hexToRgba(GEN_COLOR, 0.9);
      ctx.fillRect(n.x + 8, n.y + n.h - 6, (n.w - 16) * p, 3);
      calls++;
    }
  } else if (n.status === 'fail') {
    ctx.strokeStyle = hexToRgba(FAIL_COLOR, 0.75);
    ctx.lineWidth = 2 / zoom;
    rr(ctx, n.x, n.y, n.w, n.h, 10);
    ctx.stroke();
    calls++;
  } else {
    ctx.strokeStyle = selected ? SELECT_COLOR : hovered ? 'rgba(148,197,255,0.75)' : P.cardBorder;
    ctx.lineWidth = (selected ? 2.2 : 1.2) / zoom;
    rr(ctx, n.x, n.y, n.w, n.h, 10);
    ctx.stroke();
    calls++;
  }

  // 选中手柄
  if (selected && lod >= 1) {
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
  for (const idx of candidates) {
    if (idx === prev) continue;
    prev = idx;
    const n = model.nodes[idx];
    if (!n) continue;
    const dx = opts.dragIds.has(n.id) ? opts.dragDx : 0;
    const dy = opts.dragIds.has(n.id) ? opts.dragDy : 0;
    if (n.x + dx + n.w + pad < view.x || n.x + dx - pad > view.x + view.w ||
        n.y + dy + n.h + pad < view.y || n.y + dy - pad > view.y + view.h) {
      continue;
    }
    visible++;
    if (dx !== 0 || dy !== 0) {
      ctx.save();
      ctx.translate(dx, dy);
      calls.n += drawNode(ctx, n, lod, opts, P);
      ctx.restore();
    } else {
      calls.n += drawNode(ctx, n, lod, opts, P);
    }
  }

  return { visible, edgesDrawn, calls: calls.n };
}

export const RENDER_CONSTANTS = { LOD0_ZOOM, LOD1_ZOOM, ORIGINAL_ZOOM };
