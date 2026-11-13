export interface PublicVisibilityReadback {
  publiclyVisible: boolean;
  publicSearchEnabled: boolean;
  slug: string;
  exposedChannels: Array<{ id: string; name: string; description: string | null }>;
}

export interface PublicVisibilityUiState {
  readback: PublicVisibilityReadback | null;
  loading: boolean;
  saving: boolean;
  error: string;
  confirmOpen: boolean;
}

export type PublicVisibilityUiAction =
  | { type: "load" }
  | { type: "loaded"; readback: PublicVisibilityReadback }
  | { type: "failed"; error: string }
  | { type: "saving" }
  | { type: "saved"; publiclyVisible: boolean }
  | { type: "searchSaved"; publicSearchEnabled: boolean }
  | { type: "confirm"; open: boolean };

export function publicVisibilityUiReducer(state: PublicVisibilityUiState, action: PublicVisibilityUiAction): PublicVisibilityUiState {
  switch (action.type) {
    case "load": return { ...state, readback: null, loading: true, error: "", confirmOpen: false };
    case "loaded": return { ...state, loading: false, readback: action.readback };
    case "failed": return { ...state, loading: false, saving: false, error: action.error };
    case "saving": return { ...state, saving: true, error: "" };
    case "saved": return {
      ...state,
      saving: false,
      readback: state.readback ? { ...state.readback, publiclyVisible: action.publiclyVisible } : null,
    };
    case "searchSaved": return {
      ...state,
      saving: false,
      readback: state.readback ? { ...state.readback, publicSearchEnabled: action.publicSearchEnabled } : null,
    };
    case "confirm": return { ...state, confirmOpen: action.open };
  }
}
