import { useEffect } from "react";

/**
 * Says, once it is on screen, that what it stands beside showed (an open-in-app event, utils/openInAppTrace's
 * reportOncePerOffer, which also keeps it to once per offer and to when it can be sent). Rendered beside the offer
 * while the offer shows, so the report follows what is on screen, not a state an effect reads.
 */
export default function ReportShown({ onShown }: { onShown: () => void }) {
  useEffect(() => {
    onShown();
  }, [onShown]);
  return null;
}
