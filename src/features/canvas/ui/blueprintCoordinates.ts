import type { BlueprintItem } from '@/features/canvas/domain/canvasNodes';

/**
 * Shared blueprint coordinate utilities.
 *
 * Coordinate convention
 * ---------------------
 * The blueprint UI exposes Z-up math/CAD axes to users (so a Blender / CAD
 * background user reads "Z = height" intuitively), while the underlying
 * Three.js scene uses its native Y-up convention. We keep `pos3d` stored in
 * the Three.js order (`{ x, y: height, z: depth }`) on disk so node data
 * stays compatible with the canvas graph state and Three.js rendering;
 * the UI translates X <-> Z and labels them per right-hand-rule physics
 * intuition (Z up, Y right, X coming out of the screen toward the viewer).
 *
 *   UI label X  <->  pos3d.z   (depth — +X comes out of the screen) — blue
 *   UI label Y  <->  pos3d.x   (horizontal left/right)              — red
 *   UI label Z  <->  pos3d.y   (vertical up/down)                   — green
 *
 * Colors mirror Three.js's default AxesHelper so the on-screen world-axis
 * lines visually match the slider labels: world.x is drawn red (= UI Y),
 * world.y green (= UI Z), world.z blue (= UI X).
 */

export type UiAxis = 'x' | 'y' | 'z';

export type Pos3d = { x: number; y: number; z: number };

export const AXIS_COLORS: Record<UiAxis, string> = {
  x: '#3b82f6', // blue — depth (Three.js +Z)
  y: '#ef4444', // red — horizontal (Three.js +X)
  z: '#10b981', // green — height (Three.js +Y)
};

export function readUiAxis(p: Pos3d, axis: UiAxis): number {
  if (axis === 'x') return p.z; // UI X = depth = world Z
  if (axis === 'y') return p.x; // UI Y = horizontal = world X
  return p.y;                   // UI Z = height = world Y
}

export function writeUiAxis(p: Pos3d, axis: UiAxis, value: number): Pos3d {
  if (axis === 'x') return { ...p, z: value };
  if (axis === 'y') return { ...p, x: value };
  return { ...p, y: value };
}

export function uiAxisRange(axis: UiAxis): { min: number; max: number } {
  if (axis === 'z') return { min: 0, max: 6 }; // height never below floor
  return { min: -10, max: 10 };
}

/**
 * Legacy 2D canvas dimensions used by old node data before pos3d existed.
 * Kept around for forward-compat: items persisted with only `(x, y)` are
 * back-mapped into the 3D world here.
 */
export const LEGACY_2D_W = 520;
export const LEGACY_2D_H = 260;

export function legacyTo3D(x: number, y: number): Pos3d {
  return {
    x: (x / LEGACY_2D_W - 0.5) * 10,
    y: 0,
    z: (y / LEGACY_2D_H - 0.5) * 6,
  };
}

export function pos3dToLegacy(p: Pos3d): { x: number; y: number } {
  return {
    x: ((p.x / 10) + 0.5) * LEGACY_2D_W,
    y: ((p.z / 6) + 0.5) * LEGACY_2D_H,
  };
}

export function itemPos(item: BlueprintItem): Pos3d {
  return item.pos3d ?? legacyTo3D(item.x ?? LEGACY_2D_W / 2, item.y ?? LEGACY_2D_H / 2);
}

/** Alias kept for ergonomic call sites — `ensurePos3d(item)` reads naturally
 *  in mesh code that just wants "get me a usable Pos3d for this item". */
export const ensurePos3d = itemPos;

/**
 * Generate a guaranteed-unique blueprint item id. `Date.now()` alone is too
 * coarse — two items added in the same millisecond would collide and the
 * UI's `data.items.find(id)` would return whichever item happened to come
 * first, causing the right console to alternate between them.
 */
export function genBlueprintItemId(): string {
  return `item-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export { BLUEPRINT_SCENE_PRESETS } from '@/features/canvas/domain/blueprintPresetCatalog';

export const BLUEPRINT_PERSON_ACTIONS: ReadonlyArray<string> = [
  '站立', '行走', '奔跑', '坐下', '蹲下', '回头', '伸手', '对话', '观察', '半蹲检查',
];

export const BLUEPRINT_DEFAULT_COLORS: ReadonlyArray<string> = [
  '#f87171', '#60a5fa', '#34d399', '#fbbf24', '#a78bfa', '#fb7185', '#4ade80', '#38bdf8',
];
