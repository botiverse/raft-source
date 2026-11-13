import { Badge } from "@botiverse/raft-ui";
import { useIntl } from "react-intl";

/** raft-ui's Experimental badge, in this locale's word. Every experimental
 *  surface uses this one, so the label is translated once (raft-ui keeps only
 *  the English fallback, since product copy lives in the app). */
export default function ExperimentalBadge() {
  const { formatMessage } = useIntl();
  return <Badge.Experimental>{formatMessage({ id: "common.experimental" })}</Badge.Experimental>;
}
