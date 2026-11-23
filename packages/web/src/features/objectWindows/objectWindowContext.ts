import { createContext, useContext } from "react";

/** The object window a subtree is drawn in (ObjectWindowsHost). */
export interface ObjectWindowContextValue {
  /** Its frame name, `raft-object-window-<n>`. */
  name: string;
  doc: Document;
  win: Window;
  /** Close this window. */
  close: () => void;
}

export const ObjectWindowContext = createContext<ObjectWindowContextValue | null>(null);

/** The object window this component is drawn in, or null in the main window. */
export function useObjectWindow(): ObjectWindowContextValue | null {
  return useContext(ObjectWindowContext);
}
