import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface SnapState {
  /** 磁吸（网格吸附）是否开启 */
  snapEnabled: boolean;
  setSnapEnabled: (enabled: boolean) => void;
  toggleSnap: () => void;
}

/**
 * 磁吸开关独立 store。
 * 不混入 settingsStore，独立持久化，老用户升级零迁移风险。
 */
export const useSnapStore = create<SnapState>()(
  persist(
    (set) => ({
      snapEnabled: false, // 默认关闭，保持自由拖拽；想默认开启改成 true
      setSnapEnabled: (snapEnabled) => set({ snapEnabled }),
      toggleSnap: () => set((state) => ({ snapEnabled: !state.snapEnabled })),
    }),
    { name: 'snap-storage' } // 独立的 localStorage key
  )
);