import { Magnet } from 'lucide-react';
import { useSnapStore } from '@/stores/snapStore';

/**
 * 磁吸开关（画布左下角）。
 * 开启后：拖动节点自动吸附网格；关闭后：自由拖拽。
 */
export function SnapToggle() {
  const snapEnabled = useSnapStore((s) => s.snapEnabled);
  const toggleSnap = useSnapStore((s) => s.toggleSnap);

  return (
    <button
      type="button"
      onClick={toggleSnap}
      aria-pressed={snapEnabled}
      title={snapEnabled ? '磁吸：开（点击关闭）' : '磁吸：关（点击开启）'}
      className="pointer-events-auto flex h-8 w-8 items-center justify-center rounded-lg border shadow-sm backdrop-blur-md transition-all duration-150 hover:scale-105"
      style={{
        background: 'var(--canvas-rail-button-bg)',
        borderColor: snapEnabled ? 'var(--accent)' : 'var(--canvas-rail-button-border)',
        color: snapEnabled ? 'var(--accent)' : 'var(--canvas-rail-button-text)',
        boxShadow: snapEnabled ? '0 0 0 2px rgb(var(--accent-rgb) / 0.2)' : undefined,
      }}
    >
      <Magnet size={16} strokeWidth={2} />
    </button>
  );
}