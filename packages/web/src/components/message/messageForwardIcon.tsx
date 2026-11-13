import { Forward } from "lucide-react";

/** Forward uses the same glyph as the select-mode toolbar's Forward (task #35). */
export function ForwardIcon({ size = 16 }: { size?: number }) {
  return <Forward size={size} strokeWidth={2} />;
}
