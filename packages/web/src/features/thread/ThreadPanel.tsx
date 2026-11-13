import { AuthenticatedThreadPanel } from "./AuthenticatedThreadPanel";
import { ReadOnlyThreadPanel } from "./ReadOnlyThreadPanel";
import type { ThreadPanelProps } from "./threadPanelTypes";

export function ThreadPanel(props: ThreadPanelProps) {
  return props.readOnlyData
    ? <ReadOnlyThreadPanel {...props} readOnlyData={props.readOnlyData} />
    : <AuthenticatedThreadPanel {...props} />;
}
