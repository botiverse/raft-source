import { Component } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { Button } from "@botiverse/raft-ui";
import AppBanner from "../../components/ui/Banner";

interface SearchResultsBoundaryProps {
  resetKey: string;
  onRetry: () => void;
  children: ReactNode;
}

interface SearchResultsBoundaryState {
  hasError: boolean;
}

// Localized fallback UI for the error boundary. A class component can't call
// useIntl, so the boundary delegates its error render to this functional child
// (it mounts inside the app's IntlProvider like any other component).
function SearchResultsBoundaryFallback({ onRetry }: { onRetry: () => void }) {
  const { formatMessage } = useIntl();
  // A problem is orange (DS Banner warning): what broke, and the one way out.
  // The Banner is full width: the page inset goes on a wrapper, since a margin
  // on the Banner itself pushes it past the right edge.
  return (
    <div className="px-(--column-margin)">
      <AppBanner
        intent="warning"
        live={false}
        withIcon
        className="text-left"
        title={formatMessage({ id: "search.boundaryTitle" })}
        actions={(
          <Button
            variant="outline"
            size="md"
            type="button"
            onClick={onRetry}
          >
            {formatMessage({ id: "search.retry" })}
          </Button>
        )}
      >
        {formatMessage({ id: "search.boundaryBody" })}
      </AppBanner>
    </div>
  );
}

export class SearchResultsBoundary extends Component<SearchResultsBoundaryProps, SearchResultsBoundaryState> {
  state: SearchResultsBoundaryState = { hasError: false };

  static getDerivedStateFromError(): SearchResultsBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.error("[Search] render failed", error);
  }

  componentDidUpdate(prevProps: SearchResultsBoundaryProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
      // oxlint-disable-next-line react/no-did-update-set-state -- canonical error-boundary reset: clear the caught error when the caller bumps resetKey (new search), guarded by a prop-change condition so it cannot loop. This is the documented componentDidUpdate setState pattern.
      this.setState({ hasError: false });
    }
  }

  render() {
    if (this.state.hasError) {
      return <SearchResultsBoundaryFallback onRetry={this.props.onRetry} />;
    }

    return this.props.children;
  }
}
