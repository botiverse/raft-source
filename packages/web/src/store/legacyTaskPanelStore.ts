import { create } from "zustand";
import type { Task } from "./taskStore";

interface LegacyTaskPanelState {
  task: Task | null;
  openLegacyTask: (task: Task) => void;
  closeLegacyTask: () => void;
}

export const useLegacyTaskPanelStore = create<LegacyTaskPanelState>((set) => ({
  task: null,
  openLegacyTask: (task) => set({ task }),
  closeLegacyTask: () => set({ task: null }),
}));
