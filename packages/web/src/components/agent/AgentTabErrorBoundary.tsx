import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { Button, ScrollArea } from "@botiverse/raft-ui";
import { RefreshCw } from "lucide-react";
import { useIntl } from "react-intl";
import Banner from "../ui/Banner";

// One agent-detail tab whose data has an unexpected shape must not blank the
// whole panel (header, tab bar and the other tabs stay usable). The boundary
// wraps only the active tab's content.

interface AgentTabErrorBoundaryProps {
  /** Changes when the agent or the tab changes; clears a caught error. */
  resetKey: string;
  children: ReactNode;
}

interface AgentTabErrorBoundaryState {
  resetKey: string;
  error: Error | null;
}

export default class AgentTabErrorBoundary extends Component<
  AgentTabErrorBoundaryProps,
  AgentTabErrorBoundaryState
> {
  state: AgentTabErrorBoundaryState = {
    resetKey: this.props.resetKey,
    error: null,
  };

  static getDerivedStateFromProps(
    props: AgentTabErrorBoundaryProps,
    state: AgentTabErrorBoundaryState,
  ): Partial<AgentTabErrorBoundaryState> | null {
    if (props.resetKey !== state.resetKey) {
      return { resetKey: props.resetKey, error: null };
    }
    return null;
  }

  static getDerivedStateFromError(error: Error): Partial<AgentTabErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[AgentDetail] tab render failed", error, info.componentStack);
  }

  // The fallback replaced the tab, so clearing the error mounts it fresh:
  // tabs that load their own data (apps, workspace, activity, chat) fetch again.
  private readonly retry = () => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (this.state.error) {
      return <AgentTabErrorFallback onRetry={this.retry} />;
    }
    return this.props.children;
  }
}

// A class component can't call useIntl, so the fallback is a function child.
function AgentTabErrorFallback({ onRetry }: { onRetry: () => void }) {
  const { formatMessage } = useIntl();
  return (
    // A raft-ui ScrollArea; its one control (Retry) takes focus, so no tab stop.
    <ScrollArea tabIndex={-1} className="flex-1 bg-layer-canvas" contentClassName="p-4" data-testid="agent-tab-error">
      <Banner
        intent="warning"
        density="sm"
        actions={(
          <Button variant="outline" size="md" type="button" onClick={onRetry}>
            <RefreshCw size={16} />
            {formatMessage({ id: "agent.detail.tabFailedRetry" })}
          </Button>
        )}
      >
        {formatMessage({ id: "agent.detail.tabFailed" })}
      </Banner>
    </ScrollArea>
  );
}
