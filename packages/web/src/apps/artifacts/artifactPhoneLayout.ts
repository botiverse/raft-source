import { useObjectWindow } from "../../features/objectWindows";
import { useMediaQuery } from "../../hooks/effectPrimitives";
import { PHONE_QUERY } from "./artifactPhoneHistory";

/**
 * Laid out as on a phone (PHONE_QUERY, in the window the surface is drawn in): never in an object window (#337 PR3),
 * which is a desktop's at every width (its comment list goes over the page where the window is narrow): the phone's
 * history entry, its sheets and its two-line head are the main window's. One answer for the viewer and every part of
 * it, so a narrow window never mixes a desktop head with phone sheets.
 */
export function useArtifactPhoneLayout(): boolean {
  const narrow = useMediaQuery(PHONE_QUERY);
  const inWindow = useObjectWindow() !== null;
  return narrow && !inWindow;
}
