import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

/**
 * Draws `fallback` (nothing by default) instead of a message's link card or
 * chip whose rendering throws, so the rest of the message, and the
 * conversation around it, stay (#triage:#351: one malformed link took a whole
 * conversation down through the root boundary). Used around an App's card
 * elements (the hover card's and the block card's), the chip in the text
 * (whose fallback is the author's own link) and the cards under a message.
 * The error is still logged.
 */
export class LinkCardBoundary extends Component<{ children: ReactNode; fallback?: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown, info: ErrorInfo) { console.error("[LinkCardBoundary]", error, info.componentStack); }
  render() { return this.state.failed ? (this.props.fallback ?? null) : this.props.children; }
}
