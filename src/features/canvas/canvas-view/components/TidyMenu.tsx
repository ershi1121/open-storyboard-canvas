import { useEffect, useRef, useState } from 'react';
import { LayoutGrid } from 'lucide-react';

export type ArrangeSort = 'name' | 'position';

/**
 * 「整理 / 自动排列」下拉：选「按名称」或「按位置」把目标节点排成整齐网格。
 * 样式由调用方通过 triggerClassName / menuClassName / itemClassName 传入，
 * 这样深色浮层工具栏和浅色主工具栏都能复用同一份开合逻辑。
 */
export function TidyMenu({
  label,
  onPick,
  onTidyAndGroup,
  triggerClassName,
  menuClassName,
  itemClassName,
}: {
  label?: string;
  onPick: (sortBy: ArrangeSort) => void;
  onTidyAndGroup?: (sortBy: ArrangeSort) => void;
  triggerClassName?: string;
  menuClassName?: string;
  itemClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener('pointerdown', handlePointerDown, true);
    return () => window.removeEventListener('pointerdown', handlePointerDown, true);
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className={triggerClassName}
        title="整理 / 自动排列"
      >
        <LayoutGrid className="h-3.5 w-3.5 shrink-0" />
        {label ? <span>{label}</span> : null}
      </button>
      {open && (
        <div className={menuClassName}>
          <button
            type="button"
            className={itemClassName}
            onClick={() => {
              onPick('name');
              setOpen(false);
            }}
          >
            按名称排列
          </button>
          <button
            type="button"
            className={itemClassName}
            onClick={() => {
              onPick('position');
              setOpen(false);
            }}
          >
            按位置排列
          </button>
          {onTidyAndGroup && (
            <>
              <div className="my-1 h-px bg-[rgba(255,255,255,0.12)]" />
              <button
                type="button"
                className={itemClassName}
                onClick={() => {
                  onTidyAndGroup('name');
                  setOpen(false);
                }}
              >
                整理并打组·按名称
              </button>
              <button
                type="button"
                className={itemClassName}
                onClick={() => {
                  onTidyAndGroup('position');
                  setOpen(false);
                }}
              >
                整理并打组·按位置
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
