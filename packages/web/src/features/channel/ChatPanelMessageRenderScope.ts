import { createContext } from "react";
import type { ReactNode } from "react";

// Test hook for render-count gates around message rows. Production leaves it null.
export const ChatPanelMessageRenderScope = createContext<((id: string, children: ReactNode) => ReactNode) | null>(null);
