import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { NodeToolbar as FloatingNodeToolbar, useViewport } from '@/features/canvas/compat/nodeHostApi';
import { AlertCircle, Camera, Check, ChevronDown, Copy, Download, FolderOpen, Grid3x3, Link2, Maximize2, PenLine, RotateCcw, Scissors, Settings2, SlidersHorizontal, Sparkles, Sun, Trash2, X } from 'lucide-react';
import { save } from '@tauri-apps/plugin-dialog';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { useTranslation } from 'react-i18next';
import {
isExportImageNode,
isAiVideoNode,
isAudioNode,
isImageEditNode,
isUploadNode,
isVideoNode,
type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';
import { MULTI_FUNCTION_ITEMS } from '@/features/canvas/ui/MultiFunctionPanel';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import {
resolveGeneratedVideoSaveFileName,
resolveSuggestedImageStem,
resolveSuggestedVideoStem,
} from '@/features/canvas/application/generatedMediaNaming';
import {
copyImageSourceToClipboard,
saveAudioSourceToPath,
saveImageSourceToDownloads,
saveImageSourceToDirectory,
saveImageSourceToPath,
saveVideoSourceToDirectory,
saveVideoSourceToPath,
} from '@/commands/image';
import { useSettingsStore } from '@/stores/settingsStore';
import { useCanvasStore } from '@/stores/canvasStore';
import { usePanelStateStore } from '@/stores/panelStateStore';
import { openSettingsDialog } from '@/features/settings/settingsEvents';
import { showErrorDialog } from '@/features/canvas/application/errorDialog';
import {
buildRetryGenerationFetchPatch,
canRetryGenerationFetch,
} from '@/features/canvas/application/generationRetry';
import { nodeHasSourceHandle } from '@/features/canvas/domain/nodeRegistry';
import { UI_POPOVER_TRANSITION_MS } from '@/components/ui/motion';
import { UiChipButton, UiPanel } from '@/components/ui';
import { BatchConnectModal } from './BatchConnectModal';
import {
NODE_TOOLBAR_ALIGN,
NODE_TOOLBAR_CLASS,
NODE_TOOLBAR_OFFSET,
NODE_TOOLBAR_POSITION,
} from './nodeToolbarConfig';

interface NodeActionToolbarProps {
node: CanvasNode;
offset?: number;
}

const TOOLBAR_BUTTON_RADIUS_CLASS = 'rounded-full';
const TOOLBAR_NEUTRAL_BUTTON_CLASS =
'border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-menu-bg)] text-text-dark shadow-sm hover:border-[var(--canvas-node-border-hover)] hover:bg-[var(--canvas-node-menu-hover)]';
const PROMPT_PRESET_MENU_WIDTH = 260;
const PROMPT_PRESET_MENU_GAP = 8;

const CREATION_TOOLS: ReadonlyArray<{
panelType: 'multiAngle' | 'lighting' | 'multiFunction' | 'edit' | 'gridSplit';
icon: typeof Camera;
labelKey: string;
}> = [
{ panelType: 'multiAngle', icon: Camera, labelKey: 'nodeToolbar.multiAngle' },
{ panelType: 'lighting', icon: Sun, labelKey: 'nodeToolbar.lighting' },
{ panelType: 'multiFunction', icon: Grid3x3, labelKey: 'nodeToolbar.multiFunction' },
{ panelType: 'edit', icon: PenLine, labelKey: 'nodeToolbar.edit' },
{ panelType: 'gridSplit', icon: Scissors, labelKey: 'nodeToolbar.gridSplit' },
];

function normalizeDownloadPresetPaths(paths: string[]): string[] {
return Array.from(new Set(paths.map((path) => path.trim()).filter(Boolean)));
}

function resolvePromptPresetMenuPosition(button: HTMLButtonElement): { x: number; y: number } {
const rect = button.getBoundingClientRect();
const centeredLeft = rect.left + rect.width / 2 - PROMPT_PRESET_MENU_WIDTH / 2;
const maxLeft = Math.max(PROMPT_PRESET_MENU_GAP, window.innerWidth - PROMPT_PRESET_MENU_WIDTH - PROMPT_PRESET_MENU_GAP);
return {
x: Math.min(Math.max(PROMPT_PRESET_MENU_GAP, centeredLeft), maxLeft),
y: rect.bottom + PROMPT_PRESET_MENU_GAP,
};
}

function sanitizeAudioFileStem(raw: string): string {
const compact = raw.trim().replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '').replace(/\s+/g, '-');
return compact.replace(/^\.+|\.+$/g, '') || 'audio';
}

function inferAudioExtension(source: string, fallback = 'wav'): string {
const mimeMatch = /^data:audio\/([^;,]+)/i.exec(source.trim());
if (mimeMatch) {
const subtype = mimeMatch[1].toLowerCase();
if (subtype.includes('mpeg')) return 'mp3';
if (subtype.includes('x-wav') || subtype.includes('wave')) return 'wav';
return subtype.replace(/[^a-z0-9]+/g, '') || fallback;
}
try {
const parsed = new URL(source);
const fileName = parsed.pathname.split('/').pop() ?? '';
const ext = /\.([a-z0-9]{2,5})$/i.exec(fileName)?.[1];
return ext?.toLowerCase() || fallback;
} catch {
const ext = /\.([a-z0-9]{2,5})(?:[?#].*)?$/i.exec(source)?.[1];
return ext?.toLowerCase() || fallback;
}
}

export const NodeActionToolbar = memo(({ node, offset = NODE_TOOLBAR_OFFSET }: NodeActionToolbarProps) => {
const { t } = useTranslation();
const { zoom } = useViewport();
const toolbarScale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
const nodeFlowWidth = node.measured?.width ?? (typeof node.width === 'number' ? node.width : 680);
const panelMaxWidth = `clamp(460px, ${Math.round(nodeFlowWidth)}px, 720px)`;
const deleteNode = useCanvasStore((state) => state.deleteNode);
const updateNodeData = useCanvasStore((state) => state.updateNodeData);
const openPanel = usePanelStateStore((state) => state.openPanel);
const [isBatchConnectOpen, setIsBatchConnectOpen] = useState(false);
const [functionMenu, setFunctionMenu] = useState<{ x: number; y: number } | null>(null);
const functionButtonRef = useRef<HTMLButtonElement | null>(null);
const functionMenuRef = useRef<HTMLDivElement | null>(null);

/** Three UX variants:
A: upload node (user's raw image) — full tool set.
B: empty AI image node (no imageUrl yet) — toolbar is just the multi-function
  module chips + delete; click a chip to select/deselect it, and the chip's
  prompt template is composed at submit time.
C: image-bearing AI node (imageEdit with image OR exportImage) — same as A. */
const caseKind: 'A' | 'B' | 'C' | 'V' | 'AUDIO' | 'AI_VIDEO_INPUT' = useMemo(() => {
if (isAiVideoNode(node)) return 'AI_VIDEO_INPUT';
if (isVideoNode(node)) return 'V';
if (isAudioNode(node)) return 'AUDIO';
if (isUploadNode(node)) return 'A';
if (isImageEditNode(node)) {
return node.data.imageUrl ? 'C' : 'B';
}
if (isExportImageNode(node)) return 'C';
return 'A';
}, [node]);

const canBeBatchSource = useMemo(() => nodeHasSourceHandle(node.type), [node.type]);

const selectedChipId: string | null = useMemo(() => {
if (caseKind !== 'B' || !isImageEditNode(node)) return null;
return node.data.selectedFunctionChip ?? null;
}, [caseKind, node]);

const selectedPromptPresetId: string | null = useMemo(() => {
if (isImageEditNode(node) || isAiVideoNode(node)) {
return node.data.selectedPromptPresetId ?? null;
}
return null;
}, [node]);

const handleToggleChip = useCallback((chipId: string) => {
if (!isImageEditNode(node)) return;
const next = selectedChipId === chipId ? null : chipId;
updateNodeData(node.id, { selectedFunctionChip: next, selectedPromptPresetId: null });
}, [node, selectedChipId, updateNodeData]);

const isFunctionMenuOpen = functionMenu !== null;
const closeFunctionMenu = useCallback(() => setFunctionMenu(null), []);
const handleOpenFunctionMenu = useCallback((event: MouseEvent<HTMLButtonElement>) => {
event.stopPropagation();
const button = event.currentTarget;
if (isFunctionMenuOpen && functionButtonRef.current === button) {
closeFunctionMenu();
return;
}
functionButtonRef.current = button;
setFunctionMenu(resolvePromptPresetMenuPosition(button));
}, [closeFunctionMenu, isFunctionMenuOpen]);
const handleSelectFunctionChip = useCallback((chipId: string) => {
handleToggleChip(chipId);
closeFunctionMenu();
}, [handleToggleChip, closeFunctionMenu]);
const functionTriggerLabel = useMemo(() => {
if (caseKind === 'B' && selectedChipId) {
const item = MULTI_FUNCTION_ITEMS.find((entry) => entry.id === selectedChipId);
if (item) return t(item.titleKey) as string;
}
return t('nodeToolbar.function') as string;
}, [caseKind, selectedChipId, t]);

useEffect(() => {
if (!isFunctionMenuOpen) {
return;
}
const onPointerDown = (event: PointerEvent) => {
const menuElement = functionMenuRef.current;
if (menuElement?.contains(event.target as Node)) {
return;
}
const anchorElement = functionButtonRef.current;
if (anchorElement?.contains(event.target as Node)) {
return;
}
closeFunctionMenu();
};
window.addEventListener('pointerdown', onPointerDown, true);
return () => {
window.removeEventListener('pointerdown', onPointerDown, true);
};
}, [closeFunctionMenu, isFunctionMenuOpen]);

useEffect(() => {
if (!isFunctionMenuOpen) {
return;
}
let frameId: number | null = null;
const updatePosition = () => {
const button = functionButtonRef.current;
if (!button || !button.isConnected) {
closeFunctionMenu();
return;
}
const nextPosition = resolvePromptPresetMenuPosition(button);
setFunctionMenu((current) => {
if (!current || (current.x === nextPosition.x && current.y === nextPosition.y)) {
return current;
}
return nextPosition;
});
frameId = window.requestAnimationFrame(updatePosition);
};
updatePosition();
return () => {
if (frameId !== null) {
window.cancelAnimationFrame(frameId);
}
};
}, [closeFunctionMenu, isFunctionMenuOpen]);

const downloadPresetPaths = useSettingsStore((state) => state.downloadPresetPaths);
const normalizedDownloadPresetPaths = useMemo(
() => normalizeDownloadPresetPaths(downloadPresetPaths),
[downloadPresetPaths]
);
const promptPresets = useSettingsStore((state) => state.promptPresets);

const [downloadMenu, setDownloadMenu] = useState<{ x: number; y: number } | null>(null);
const [promptPresetMenu, setPromptPresetMenu] = useState<{ x: number; y: number } | null>(null);
const [isDownloadMenuVisible, setIsDownloadMenuVisible] = useState(false);
const [isCopySuccess, setIsCopySuccess] = useState(false);
const [feedbackToast, setFeedbackToast] = useState<{ message: string; tone: 'success' | 'error'; action?: { label: string; onClick: () => void } } | null>(null);
const [videoPreviewSource, setVideoPreviewSource] = useState<string | null>(null);

const downloadMenuRef = useRef<HTMLDivElement | null>(null);
const promptPresetMenuRef = useRef<HTMLDivElement | null>(null);
const promptPresetAnchorRef = useRef<HTMLButtonElement | null>(null);
const promptPresetPanelButtonRef = useRef<HTMLButtonElement | null>(null);
const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
const feedbackToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
const downloadMenuCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
const openToolPanel = useCallback((panelType: Parameters<typeof openPanel>[0]) => {
const el = functionButtonRef.current;
if (!el) {
return;
}
// Anchor the opened panel to the 功能 trigger button so it tracks the node.
el.dataset.panelAnchor = `${node.id}:${panelType}`;
closeFunctionMenu();
openPanel(panelType, {
nodeId: node.id,
buttonKey: panelType,
fallbackRect: el.getBoundingClientRect(),
}, 'click');
}, [closeFunctionMenu, node.id, openPanel]);

const functionMenuEntries = useMemo(() => {
if (caseKind === 'B') {
return MULTI_FUNCTION_ITEMS.map((item) => ({
id: item.id,
icon: item.icon as typeof Camera,
label: t(item.titleKey) as string,
title: t(item.descKey) as string,
active: selectedChipId === item.id,
onSelect: () => handleSelectFunctionChip(item.id),
}));
}
return CREATION_TOOLS.map((tool) => ({
id: tool.panelType,
icon: tool.icon,
label: t(tool.labelKey) as string,
title: t(tool.labelKey) as string,
active: false,
onSelect: () => openToolPanel(tool.panelType),
}));
}, [caseKind, selectedChipId, t, handleSelectFunctionChip, openToolPanel]);

const rawImageSource = useMemo(() => {
if (isUploadNode(node) || isImageEditNode(node) || isExportImageNode(node)) {
return node.data.imageUrl || node.data.previewImageUrl || null;
}
return null;
}, [node]);

const rawVideoSource = useMemo(() => {
if (isVideoNode(node)) {
return node.data.localVideoUrl || node.data.videoUrl || null;
}
return null;
}, [node]);

const rawAudioSource = useMemo(() => {
if (isAudioNode(node)) {
return node.data.localAudioUrl || node.data.audioUrl || null;
}
return null;
}, [node]);

const imageSource = useMemo(
() => (rawImageSource ? resolveImageDisplayUrl(rawImageSource) : null),
[rawImageSource]
);
const videoSource = useMemo(
() => (rawVideoSource ? resolveImageDisplayUrl(rawVideoSource) : null),
[rawVideoSource]
);
const audioSource = useMemo(
() => (rawAudioSource ? resolveImageDisplayUrl(rawAudioSource) : null),
[rawAudioSource]
);

const referenceImageSource = useMemo(() => {
if (isUploadNode(node) || isImageEditNode(node) || isExportImageNode(node)) {
return node.data.imageUrl || node.data.previewImageUrl || null;
}
return null;
}, [node]);

const canHandleImage = Boolean(imageSource);
const canHandleVideo = Boolean(rawVideoSource && videoSource);
const canHandleAudio = Boolean(rawAudioSource && audioSource);
const canRetryGeneration = canRetryGenerationFetch(node);

const suggestedImageStem = useMemo(() => {
if (isExportImageNode(node)) {
return resolveSuggestedImageStem(node.data);
}
return `node-${node.id}`;
}, [node]);

const suggestedVideoSavePath = useMemo(() => {
if (isVideoNode(node)) {
return resolveGeneratedVideoSaveFileName(node.data);
}
return `node-${node.id}.mp4`;
}, [node]);

const suggestedVideoStem = useMemo(() => {
if (isVideoNode(node)) {
return resolveSuggestedVideoStem(node.data);
}
return `node-${node.id}`;
}, [node]);

const suggestedAudioStem = useMemo(() => {
if (isAudioNode(node)) {
return sanitizeAudioFileStem(
node.data.generatedFileName
|| node.data.sourceFileName
|| node.data.displayName
|| `audio-${node.id}`
);
}
return `audio-${node.id}`;
}, [node]);

const suggestedAudioSavePath = useMemo(() => {
const extension = rawAudioSource ? inferAudioExtension(rawAudioSource) : 'wav';
return `${suggestedAudioStem}.${extension}`;
}, [rawAudioSource, suggestedAudioStem]);

const closePromptPresetMenu = useCallback(() => {
setPromptPresetMenu(null);
}, []);
const isPromptPresetMenuOpen = promptPresetMenu !== null;

const closeDownloadMenu = useCallback(() => {
setIsDownloadMenuVisible(false);
if (downloadMenuCloseTimerRef.current) {
clearTimeout(downloadMenuCloseTimerRef.current);
}
downloadMenuCloseTimerRef.current = setTimeout(() => {
setDownloadMenu(null);
downloadMenuCloseTimerRef.current = null;
}, UI_POPOVER_TRANSITION_MS);
}, []);

const showFeedbackToast = useCallback((
message: string,
tone: 'success' | 'error' = 'success',
action?: { label: string; onClick: () => void },
) => {
setFeedbackToast({ message, tone, action });
if (feedbackToastTimerRef.current) {
clearTimeout(feedbackToastTimerRef.current);
}
// 带“打开文件夹”这类操作按钮时多留一会儿，免得还没点 toast 就消失了。
feedbackToastTimerRef.current = setTimeout(() => {
setFeedbackToast(null);
feedbackToastTimerRef.current = null;
}, action ? 6000 : 1800);
}, []);

const revealDownloadedFile = useCallback((path: string | null | undefined) => {
if (!path) return;
void revealItemInDir(path).catch((error) => {
console.error('Failed to reveal downloaded file', error);
});
}, []);

const handleRetryGenerationFetch = useCallback((event: MouseEvent<HTMLButtonElement>) => {
event.stopPropagation();
if (!canRetryGenerationFetch(node)) {
return;
}
updateNodeData(node.id, buildRetryGenerationFetchPatch(node));
}, [node, updateNodeData]);

useEffect(() => {
if (!downloadMenu) {
return;
}
const onPointerDown = (event: PointerEvent) => {
const menuElement = downloadMenuRef.current;
if (!menuElement) {
closeDownloadMenu();
return;
}
if (menuElement.contains(event.target as Node)) {
return;
}
closeDownloadMenu();
};
window.addEventListener('pointerdown', onPointerDown, true);
return () => {
window.removeEventListener('pointerdown', onPointerDown, true);
};
}, [closeDownloadMenu, downloadMenu]);

useEffect(() => {
if (!isPromptPresetMenuOpen) {
return;
}
const onPointerDown = (event: PointerEvent) => {
const menuElement = promptPresetMenuRef.current;
if (!menuElement) {
closePromptPresetMenu();
return;
}
if (menuElement.contains(event.target as Node)) {
return;
}
const anchorElement = promptPresetAnchorRef.current;
if (anchorElement?.contains(event.target as Node)) {
return;
}
closePromptPresetMenu();
};
window.addEventListener('pointerdown', onPointerDown, true);
return () => {
window.removeEventListener('pointerdown', onPointerDown, true);
};
}, [closePromptPresetMenu, isPromptPresetMenuOpen]);

useEffect(() => {
if (!videoPreviewSource) {
return;
}
const handleKeyDown = (event: KeyboardEvent) => {
if (event.key === 'Escape') {
setVideoPreviewSource(null);
}
};
window.addEventListener('keydown', handleKeyDown);
return () => {
window.removeEventListener('keydown', handleKeyDown);
};
}, [videoPreviewSource]);

useEffect(() => {
if (!isPromptPresetMenuOpen) {
return;
}
let frameId: number | null = null;
const updatePosition = () => {
const button = promptPresetAnchorRef.current;
if (!button || !button.isConnected) {
closePromptPresetMenu();
return;
}
const nextPosition = resolvePromptPresetMenuPosition(button);
setPromptPresetMenu((current) => {
if (!current || (current.x === nextPosition.x && current.y === nextPosition.y)) {
return current;
}
return nextPosition;
});
frameId = window.requestAnimationFrame(updatePosition);
};
updatePosition();
return () => {
if (frameId !== null) {
window.cancelAnimationFrame(frameId);
}
};
}, [closePromptPresetMenu, isPromptPresetMenuOpen]);

useEffect(() => {
if (!downloadMenu) {
return;
}
const frameId = requestAnimationFrame(() => {
setIsDownloadMenuVisible(true);
});
return () => {
cancelAnimationFrame(frameId);
};
}, [downloadMenu]);

useEffect(() => {
return () => {
if (copyFeedbackTimerRef.current) {
clearTimeout(copyFeedbackTimerRef.current);
}
if (feedbackToastTimerRef.current) {
clearTimeout(feedbackToastTimerRef.current);
}
if (downloadMenuCloseTimerRef.current) {
clearTimeout(downloadMenuCloseTimerRef.current);
}
};
}, []);

const handleCopyImage = useCallback(async () => {
if (!rawImageSource) return;
try {
await copyImageSourceToClipboard(rawImageSource);
setIsCopySuccess(true);
if (copyFeedbackTimerRef.current) {
clearTimeout(copyFeedbackTimerRef.current);
}
copyFeedbackTimerRef.current = setTimeout(() => {
setIsCopySuccess(false);
copyFeedbackTimerRef.current = null;
}, 1100);
showFeedbackToast(t('nodeToolbar.copySuccess'));
} catch (error) {
console.error('Failed to copy image to clipboard', error);
setIsCopySuccess(false);
showFeedbackToast(t('nodeToolbar.copyFailed'), 'error');
}
}, [rawImageSource, showFeedbackToast, t]);

const handleCopyVideoSource = useCallback(async () => {
if (!rawVideoSource) return;
try {
await navigator.clipboard.writeText(rawVideoSource);
setIsCopySuccess(true);
if (copyFeedbackTimerRef.current) {
clearTimeout(copyFeedbackTimerRef.current);
}
copyFeedbackTimerRef.current = setTimeout(() => {
setIsCopySuccess(false);
copyFeedbackTimerRef.current = null;
}, 1100);
showFeedbackToast(t('nodeToolbar.copySuccess'));
} catch (error) {
console.error('Failed to copy video source to clipboard', error);
setIsCopySuccess(false);
showFeedbackToast(t('nodeToolbar.copyFailed'), 'error');
}
}, [rawVideoSource, showFeedbackToast, t]);

const handleDownloadSaveAs = useCallback(async () => {
if (!rawImageSource) return;
try {
// 有预设目录时，把保存框的默认位置指到第一个预设目录，用户只需选格式、不必重挑文件夹。
const presetDir = (normalizedDownloadPresetPaths[0] ?? '').replace(/[\\/]+$/, '');
const defaultPath = presetDir ? `${presetDir}/${suggestedImageStem}` : suggestedImageStem;
const selectedPath = await save({
defaultPath,
filters: [
{ name: 'PNG', extensions: ['png'] },
{ name: 'JPEG', extensions: ['jpg'] },
{ name: 'WebP', extensions: ['webp'] },
],
});
if (!selectedPath || Array.isArray(selectedPath)) return;
const savedPath = await saveImageSourceToPath(rawImageSource, selectedPath);
closeDownloadMenu();
showFeedbackToast(t('nodeToolbar.downloadSuccess'), 'success', {
label: t('nodeToolbar.openInFolder'),
onClick: () => revealDownloadedFile(savedPath),
});
} catch (error) {
console.error('Failed to save image with save-as', error);
showFeedbackToast(t('nodeToolbar.downloadFailed'), 'error');
}
}, [closeDownloadMenu, normalizedDownloadPresetPaths, rawImageSource, revealDownloadedFile, showFeedbackToast, suggestedImageStem, t]);

const handleDownloadToDownloads = useCallback(async () => {
if (!rawImageSource) return;
try {
const savedPath = await saveImageSourceToDownloads(rawImageSource, suggestedImageStem);
closeDownloadMenu();
showFeedbackToast(t('nodeToolbar.downloadSuccess'), 'success', {
label: t('nodeToolbar.openInFolder'),
onClick: () => revealDownloadedFile(savedPath),
});
} catch (error) {
console.error('Failed to save image to downloads', error);
showFeedbackToast(t('nodeToolbar.downloadFailed'), 'error');
}
}, [closeDownloadMenu, rawImageSource, suggestedImageStem, t]);

const handleDownloadToPreset = useCallback(
async (targetDir: string) => {
if (!rawImageSource) return;
try {
const savedPath = await saveImageSourceToDirectory(rawImageSource, targetDir, suggestedImageStem);
closeDownloadMenu();
showFeedbackToast(t('nodeToolbar.downloadSuccess'), 'success', {
label: t('nodeToolbar.openInFolder'),
onClick: () => revealDownloadedFile(savedPath),
});
} catch (error) {
console.error('Failed to save image to preset dir', error);
showFeedbackToast(t('nodeToolbar.downloadFailed'), 'error');
}
},
[closeDownloadMenu, rawImageSource, suggestedImageStem, t]
);

const handleDownloadVideoSaveAs = useCallback(async () => {
if (!rawVideoSource) return;
try {
const selectedPath = await save({ defaultPath: suggestedVideoSavePath });
if (!selectedPath || Array.isArray(selectedPath)) return;
await saveVideoSourceToPath(rawVideoSource, selectedPath);
closeDownloadMenu();
showFeedbackToast(t('nodeToolbar.downloadSuccess'));
} catch (error) {
console.error('Failed to save video with save-as', error);
showFeedbackToast(t('nodeToolbar.downloadFailed'), 'error');
}
}, [closeDownloadMenu, rawVideoSource, showFeedbackToast, suggestedVideoSavePath, t]);

const handleDownloadVideoToPreset = useCallback(
async (targetDir: string) => {
if (!rawVideoSource) return;
try {
await saveVideoSourceToDirectory(rawVideoSource, targetDir, suggestedVideoStem);
closeDownloadMenu();
showFeedbackToast(t('nodeToolbar.downloadSuccess'));
} catch (error) {
console.error('Failed to save video to preset dir', error);
showFeedbackToast(t('nodeToolbar.downloadFailed'), 'error');
}
},
[closeDownloadMenu, rawVideoSource, showFeedbackToast, suggestedVideoStem, t]
);

const handleDownloadAudio = useCallback(async (event?: MouseEvent<HTMLButtonElement>) => {
event?.stopPropagation();
if (!rawAudioSource) return;
try {
const selectedPath = await save({ defaultPath: suggestedAudioSavePath });
if (!selectedPath || Array.isArray(selectedPath)) return;
await saveAudioSourceToPath(rawAudioSource, selectedPath);
showFeedbackToast(t('nodeToolbar.downloadSuccess'));
} catch (error) {
console.error('Failed to save audio', error);
showFeedbackToast(t('nodeToolbar.downloadFailed'), 'error');
}
}, [rawAudioSource, showFeedbackToast, suggestedAudioSavePath, t]);

const openAudioTrimMode = useCallback((event: MouseEvent<HTMLButtonElement>) => {
event.stopPropagation();
if (!isAudioNode(node)) {
return;
}
const duration = typeof node.data.durationSeconds === 'number' && node.data.durationSeconds > 0
? node.data.durationSeconds
: 1;
updateNodeData(node.id, {
isAudioTrimMode: true,
audioTrimStartSeconds: 0,
audioTrimEndSeconds: Math.min(duration, Math.max(0.1, duration * 0.5)),
});
showFeedbackToast('在音频条上拖动裁剪框');
}, [node, showFeedbackToast, updateNodeData]);

const handleOpenPromptPresetMenu = useCallback((event: MouseEvent<HTMLButtonElement>) => {
event.stopPropagation();
const button = event.currentTarget;
const usesInlinePresetMenu = caseKind === 'B' || caseKind === 'AI_VIDEO_INPUT';
if (!usesInlinePresetMenu) {
closePromptPresetMenu();
button.dataset.panelAnchor = `${node.id}:promptPreset`;
openPanel(
'promptPreset',
{ nodeId: node.id, buttonKey: 'promptPreset', fallbackRect: button.getBoundingClientRect() },
'click'
);
return;
}
if (isPromptPresetMenuOpen && promptPresetAnchorRef.current === button) {
closePromptPresetMenu();
return;
}
promptPresetAnchorRef.current = button;
setPromptPresetMenu(resolvePromptPresetMenuPosition(button));
}, [caseKind, closePromptPresetMenu, isPromptPresetMenuOpen, node.id, openPanel]);

const handleManagePromptPresets = useCallback(() => {
closePromptPresetMenu();
openSettingsDialog({ category: 'promptPresets' });
}, [closePromptPresetMenu]);

const handleSelectPromptPreset = useCallback(async (presetId: string) => {
const preset = promptPresets.find((item) => item.id === presetId);
if (!preset) {
await showErrorDialog(t('node.imageEdit.promptPresetMissing'), t('common.error'));
return;
}
if (caseKind === 'B' && isImageEditNode(node)) {
updateNodeData(node.id, {
selectedPromptPresetId: preset.id,
selectedFunctionChip: null,
});
closePromptPresetMenu();
return;
}
if (caseKind === 'AI_VIDEO_INPUT' && isAiVideoNode(node)) {
updateNodeData(node.id, {
selectedPromptPresetId: preset.id,
});
closePromptPresetMenu();
return;
}
closePromptPresetMenu();
}, [
caseKind,
closePromptPresetMenu,
node,
promptPresets,
t,
updateNodeData,
]);

const handleClearPromptPreset = useCallback(() => {
if (caseKind === 'B' && isImageEditNode(node)) {
updateNodeData(node.id, { selectedPromptPresetId: null });
closePromptPresetMenu();
return;
}
if (caseKind === 'AI_VIDEO_INPUT' && isAiVideoNode(node)) {
updateNodeData(node.id, { selectedPromptPresetId: null });
closePromptPresetMenu();
}
}, [caseKind, closePromptPresetMenu, node, updateNodeData]);

const renderPromptPresetButton = (disabled = false) => (
<UiChipButton
ref={caseKind === 'B' || caseKind === 'AI_VIDEO_INPUT' ? promptPresetAnchorRef : promptPresetPanelButtonRef}
type="button"
className={`h-7 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2 text-[11px] ${(caseKind === 'B' || caseKind === 'AI_VIDEO_INPUT') && selectedPromptPresetId ? 'border-accent bg-accent/35 text-white ring-2 ring-accent/40' : TOOLBAR_NEUTRAL_BUTTON_CLASS} ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
onClick={disabled ? undefined : handleOpenPromptPresetMenu}
onMouseEnter={disabled || (caseKind !== 'B' && caseKind !== 'AI_VIDEO_INPUT')
? undefined
: (event) => {
promptPresetAnchorRef.current = event.currentTarget;
setPromptPresetMenu(resolvePromptPresetMenuPosition(event.currentTarget));
}}
title={t('nodeToolbar.promptPreset') as string}
>
{(caseKind === 'B' || caseKind === 'AI_VIDEO_INPUT') && selectedPromptPresetId && <Check className="h-3 w-3 text-white" />}
<Sparkles className="h-3 w-3" />
{t('nodeToolbar.promptPreset')}
<ChevronDown className="h-3 w-3 opacity-70" />
</UiChipButton>
);

const promptPresetMenuElement = promptPresetMenu && typeof document !== 'undefined'
? createPortal(
<div
ref={promptPresetMenuRef}
className="fixed z-[1000] w-[260px] max-w-[calc(100vw-16px)] overflow-hidden rounded-xl border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-menu-bg)] p-2 shadow-2xl backdrop-blur-sm"
style={{ left: `${promptPresetMenu.x}px`, top: `${promptPresetMenu.y}px` }}
onClick={(event) => event.stopPropagation()}
>
<div className="px-2.5 pb-2 text-xs font-medium text-text-muted">
{t('nodeToolbar.promptPresetMenuTitle')}
</div>
{promptPresets.length > 0 ? (
<div className="max-h-[240px] space-y-1 overflow-y-auto pr-1">
{selectedPromptPresetId && (
<button
type="button"
className="mb-1 flex w-full items-center gap-2 rounded-lg border border-[var(--canvas-node-field-border)] px-2.5 py-2 text-left text-sm text-text-muted transition-colors hover:bg-[var(--canvas-node-menu-hover)]"
onClick={handleClearPromptPreset}
>
<X className="h-3 w-3 shrink-0" />
<span className="min-w-0 flex-1 truncate">清除当前预设</span>
</button>
)}
{promptPresets.map((preset) => {
const active = selectedPromptPresetId === preset.id;
return (
<button
key={preset.id}
type="button"
className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${active ? 'bg-[var(--canvas-node-menu-active)] text-text-dark' : 'text-text-dark hover:bg-[var(--canvas-node-menu-hover)]'}`}
title={preset.prompt}
onClick={() => { void handleSelectPromptPreset(preset.id); }}
>
<Sparkles className="h-3 w-3 shrink-0 text-accent" />
<span className="min-w-0 flex-1 truncate">{preset.name}</span>
{active && <Check className="h-3 w-3 shrink-0 text-accent" />}
</button>
);
})}
</div>
) : (
<div className="rounded-lg border border-dashed border-[var(--canvas-node-border)] bg-[var(--canvas-node-field-bg)] px-3 py-4 text-center text-xs text-text-muted">
{t('nodeToolbar.promptPresetEmpty')}
</div>
)}
<button
type="button"
className="mt-2 flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-[var(--canvas-node-field-border)] px-2.5 text-sm text-text-dark transition-colors hover:bg-[var(--canvas-node-menu-hover)]"
onClick={handleManagePromptPresets}
>
<Settings2 className="h-3 w-3" />
{t('nodeToolbar.managePromptPresets')}
</button>
</div>,
document.body
)
: null;

const renderFunctionDropdownButton = () => (
<UiChipButton
ref={functionButtonRef}
className={`h-7 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2 text-[11px] ${isFunctionMenuOpen || (caseKind === 'B' && selectedChipId) ? 'border-accent bg-accent/35 text-white ring-2 ring-accent/40' : TOOLBAR_NEUTRAL_BUTTON_CLASS}`}
onClick={handleOpenFunctionMenu}
title={t('nodeToolbar.function') as string}
>
<SlidersHorizontal className="h-3 w-3" />
{functionTriggerLabel}
<ChevronDown className="h-3 w-3 opacity-70" />
</UiChipButton>
);

const functionMenuElement = functionMenu && typeof document !== 'undefined'
? createPortal(
<div
ref={functionMenuRef}
className="fixed z-[1000] w-[260px] max-w-[calc(100vw-16px)] overflow-hidden rounded-xl border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-menu-bg)] p-2 shadow-2xl backdrop-blur-sm"
style={{ left: `${functionMenu.x}px`, top: `${functionMenu.y}px` }}
onClick={(event) => event.stopPropagation()}
>
<div className="px-2.5 pb-2 text-xs font-medium text-text-muted">{t('nodeToolbar.functionMenuTitle')}</div>
<div className="max-h-[320px] space-y-1 overflow-y-auto pr-1">
{selectedChipId && (
<button
type="button"
className="mb-1 flex w-full items-center gap-2 rounded-lg border border-[var(--canvas-node-field-border)] px-2.5 py-2 text-left text-sm text-text-muted transition-colors hover:bg-[var(--canvas-node-menu-hover)]"
onClick={() => { handleToggleChip(selectedChipId); closeFunctionMenu(); }}
>
<X className="h-3.5 w-3.5 shrink-0" />
<span className="min-w-0 flex-1 truncate">{t('nodeToolbar.clearFunction')}</span>
</button>
)}
{functionMenuEntries.map((entry) => {
const Icon = entry.icon;
return (
<button
key={entry.id}
type="button"
title={entry.title}
onClick={entry.onSelect}
className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${entry.active ? 'bg-[var(--canvas-node-menu-active)] text-text-dark' : 'text-text-dark hover:bg-[var(--canvas-node-menu-hover)]'}`}
>
<Icon className="h-3.5 w-3.5 shrink-0 text-accent" />
<span className="min-w-0 flex-1 truncate">{entry.label}</span>
{entry.active && <Check className="h-3.5 w-3.5 shrink-0 text-accent" />}
</button>
);
})}
</div>
</div>,
document.body
)
: null;

const feedbackToastElement = feedbackToast && typeof document !== 'undefined'
? createPortal(
<div className="pointer-events-none fixed left-1/2 top-5 z-[1300] -translate-x-1/2">
<div
className={`flex items-center gap-2 rounded-full border px-4 py-2 text-sm shadow-2xl backdrop-blur ${feedbackToast.tone === 'success' ? 'border-emerald-400/40 bg-emerald-500/20 text-emerald-50' : 'border-red-400/45 bg-red-500/20 text-red-50'}`}
>
{feedbackToast.tone === 'success'
? <Check className="h-4 w-4" />
: <AlertCircle className="h-4 w-4" />}
<span>{feedbackToast.message}</span>
{feedbackToast.action && (
<button
type="button"
onClick={() => {
feedbackToast.action?.onClick();
setFeedbackToast(null);
}}
className="pointer-events-auto ml-1 flex shrink-0 items-center gap-1 rounded-full border border-white/30 bg-white/15 px-2.5 py-0.5 text-xs font-medium text-white transition-colors hover:bg-white/25"
>
<FolderOpen className="h-3 w-3" />
{feedbackToast.action.label}
</button>
)}
</div>
</div>,
document.body
)
: null;

const videoPreviewElement = videoPreviewSource && typeof document !== 'undefined'
? createPortal(
<div
className="fixed inset-0 z-[1250] flex items-center justify-center bg-black/80 p-6 backdrop-blur-sm"
onClick={() => setVideoPreviewSource(null)}
>
<div
className="relative flex max-h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-white/15 bg-black shadow-2xl"
onClick={(event) => event.stopPropagation()}
>
<button
type="button"
className="absolute right-3 top-3 z-10 inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/20 bg-black/70 text-white shadow-lg transition-colors hover:bg-white/15"
aria-label={t('common.close')}
onClick={() => setVideoPreviewSource(null)}
>
<X className="h-4 w-4" />
</button>
<video
src={videoPreviewSource}
className="max-h-[88vh] w-full bg-black object-contain"
controls
autoPlay
playsInline
/>
</div>
</div>,
document.body
)
: null;

return (
<>
<FloatingNodeToolbar
nodeId={node.id}
isVisible
position={NODE_TOOLBAR_POSITION}
align={NODE_TOOLBAR_ALIGN}
offset={offset * toolbarScale}
className={NODE_TOOLBAR_CLASS}
>
<UiPanel style={{ transform: `scale(${toolbarScale})`, transformOrigin: 'bottom center', maxWidth: panelMaxWidth }} className="flex flex-wrap items-center justify-center gap-x-1 gap-y-0.5 rounded-2xl p-1">
{/* Case B: empty AI node — the multi-function modules are collapsed into a
single "功能 ▾" dropdown (row 1) instead of a wide row of chips; selecting a
module stores selectedFunctionChip and its prompt template is composed at
submit time (ImageEditNode.handleGenerate). */}
{caseKind === 'B' && renderFunctionDropdownButton()}
{caseKind === 'B' && renderPromptPresetButton()}
{caseKind === 'B' && <div className="w-full basis-full" />}
{caseKind === 'AI_VIDEO_INPUT' && renderPromptPresetButton()}
{/* Case A / C: full tool chips. */}
{caseKind !== 'B' && caseKind !== 'V' && caseKind !== 'AUDIO' && caseKind !== 'AI_VIDEO_INPUT' && (<>
{/* 功能下拉：多角度 / 打光 / 多功能 / 编辑 / 宫格切分 */}
{renderFunctionDropdownButton()}
{referenceImageSource && renderPromptPresetButton()}
{/* 复制 - Copy */}
{canHandleImage && (
<UiChipButton
className={`h-7 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2 text-[11px] ${TOOLBAR_NEUTRAL_BUTTON_CLASS} ${
isCopySuccess ? '!border-emerald-400/70 !bg-emerald-500/20 !text-emerald-200' : ''
}`}
onClick={() => { void handleCopyImage(); }}
>
<Copy className="h-3 w-3" />
{t('nodeToolbar.copy')}
</UiChipButton>
)}
{/* 下载 - Download */}
{canHandleImage && (
<UiChipButton
className={`h-7 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2 text-[11px] ${TOOLBAR_NEUTRAL_BUTTON_CLASS}`}
onClick={(event) => {
event.stopPropagation();
// 0 或 1 个预设目录时都弹保存框选格式(默认位置=该预设目录);≥2 个预设才走快捷菜单
if (normalizedDownloadPresetPaths.length <= 1) {
void handleDownloadSaveAs();
return;
}
setDownloadMenu({ x: event.clientX, y: event.clientY });
setIsDownloadMenuVisible(false);
}}
>
<Download className="h-3 w-3" />
{t('nodeToolbar.download')}
</UiChipButton>
)}
{/* 放大预览 - Zoom Preview */}
{canHandleImage && imageSource && (
<UiChipButton
className={`h-7 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2 text-[11px] ${TOOLBAR_NEUTRAL_BUTTON_CLASS}`}
onClick={(event) => {
event.stopPropagation();
useCanvasStore.getState().openImageViewer(imageSource);
}}
>
<Maximize2 className="h-3 w-3" />
{t('nodeToolbar.zoomPreview')}
</UiChipButton>
)}
{/* 换行：下排=节点操作（重试/批量/删除） */}
<div className="w-full basis-full" />
</>)}{/* end case A/C */}
{caseKind === 'V' && canHandleVideo && videoSource && (<>
<UiChipButton
className={`h-7 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2 text-[11px] ${TOOLBAR_NEUTRAL_BUTTON_CLASS}`}
onClick={(event) => {
event.stopPropagation();
setVideoPreviewSource(videoSource);
}}
>
<Maximize2 className="h-3 w-3" />
{t('nodeToolbar.zoomPreview')}
</UiChipButton>
<UiChipButton
className={`h-7 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2 text-[11px] ${TOOLBAR_NEUTRAL_BUTTON_CLASS} ${
isCopySuccess ? '!border-emerald-400/70 !bg-emerald-500/20 !text-emerald-200' : ''
}`}
onClick={(event) => {
event.stopPropagation();
void handleCopyVideoSource();
}}
>
<Copy className="h-3 w-3" />
{t('nodeToolbar.copy')}
</UiChipButton>
<UiChipButton
className={`h-7 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2 text-[11px] ${TOOLBAR_NEUTRAL_BUTTON_CLASS}`}
onClick={(event) => {
event.stopPropagation();
if (normalizedDownloadPresetPaths.length === 0) {
void handleDownloadVideoSaveAs();
return;
}
if (normalizedDownloadPresetPaths.length === 1) {
void handleDownloadVideoToPreset(normalizedDownloadPresetPaths[0]);
return;
}
setDownloadMenu({ x: event.clientX, y: event.clientY });
setIsDownloadMenuVisible(false);
}}
>
<Download className="h-3 w-3" />
{t('nodeToolbar.download')}
</UiChipButton>
</>)}
{caseKind === 'AUDIO' && canHandleAudio && (<>
<UiChipButton
className={`h-7 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2 text-[11px] ${TOOLBAR_NEUTRAL_BUTTON_CLASS}`}
onClick={(event) => { void handleDownloadAudio(event); }}
>
<Download className="h-3 w-3" />
{t('nodeToolbar.download')}
</UiChipButton>
<UiChipButton
className={`h-7 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2 text-[11px] ${TOOLBAR_NEUTRAL_BUTTON_CLASS}`}
onClick={openAudioTrimMode}
>
<Scissors className="h-3 w-3" />
{t('nodeToolbar.audioTrim')}
</UiChipButton>
</>)}
{canRetryGeneration && (
<UiChipButton
className={`h-7 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2 text-[11px] ${TOOLBAR_NEUTRAL_BUTTON_CLASS}`}
onClick={handleRetryGenerationFetch}
title={t('nodeToolbar.retryFetch') as string}
>
<RotateCcw className="h-3 w-3" />
{t('nodeToolbar.retryFetch')}
</UiChipButton>
)}
{/* 批量连接 - Batch Connect */}
{canBeBatchSource && (
<UiChipButton
className={`h-7 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-2 text-[11px] ${TOOLBAR_NEUTRAL_BUTTON_CLASS}`}
onClick={(event) => {
event.stopPropagation();
setIsBatchConnectOpen(true);
}}
title="批量连接"
>
<Link2 className="h-3 w-3" />
批量连接
</UiChipButton>
)}
{/* 删除 - Delete (shared by A / B / C / V) */}
<UiChipButton
className={`h-7 ${TOOLBAR_BUTTON_RADIUS_CLASS} border-red-500/45 bg-red-500/15 px-2 text-[11px] text-red-600 dark:text-red-400 hover:bg-red-500/25`}
onClick={(event) => {
event.stopPropagation();
deleteNode(node.id);
}}
>
<Trash2 className="h-3 w-3" />
{t('common.delete')}
</UiChipButton>
</UiPanel>
{downloadMenu && createPortal(
<div
ref={downloadMenuRef}
className={`fixed z-[1000] min-w-[280px] rounded-xl border border-[var(--canvas-node-field-border)] bg-[var(--canvas-node-menu-bg)] p-2 shadow-2xl backdrop-blur-sm transition-opacity duration-150 ${isDownloadMenuVisible ? 'opacity-100' : 'opacity-0'}`}
style={{ left: `${downloadMenu.x}px`, top: `${downloadMenu.y}px` }}
>
<button
type="button"
className="flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm text-text-dark transition-colors hover:bg-[var(--canvas-node-menu-hover)]"
onClick={() => {
void (caseKind === 'V'
? handleDownloadVideoSaveAs()
: handleDownloadSaveAs());
}}
>
<Download className="h-4 w-4" />
{t('nodeToolbar.saveAs')}
</button>
{caseKind !== 'V' && (
<button
type="button"
className="flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm text-text-dark transition-colors hover:bg-[var(--canvas-node-menu-hover)]"
onClick={() => {
void handleDownloadToDownloads();
}}
>
<Download className="h-4 w-4" />
{t('nodeToolbar.downloadToDownloadsFolder')}
</button>
)}
{normalizedDownloadPresetPaths.length > 0 ? (
<div className="mt-1 space-y-1 border-t border-[var(--canvas-node-divider)] pt-2">
{normalizedDownloadPresetPaths.map((path) => (
<button
key={path}
type="button"
className="flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-xs text-text-dark transition-colors hover:bg-[var(--canvas-node-menu-hover)]"
onClick={() => {
void (caseKind === 'V'
? handleDownloadVideoToPreset(path)
: handleDownloadToPreset(path));
}}
title={path}
>
<FolderOpen className="h-3 w-3 shrink-0 text-text-muted" />
<span className="truncate">{path}</span>
</button>
))}
</div>
) : (
<div className="mt-1 border-t border-[var(--canvas-node-divider)] px-2.5 pt-2 text-xs text-text-muted">
{t('nodeToolbar.noDownloadPresetPathsHint')}
</div>
)}
</div>
, document.body
)}
</FloatingNodeToolbar>
{promptPresetMenuElement}
{functionMenuElement}
{feedbackToastElement}
{videoPreviewElement}
{isBatchConnectOpen && (
<BatchConnectModal
sourceNode={node}
onClose={() => setIsBatchConnectOpen(false)}
/>
)}
</>
);
});
NodeActionToolbar.displayName = 'NodeActionToolbar';