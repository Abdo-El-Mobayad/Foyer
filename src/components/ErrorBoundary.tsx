import { Component, type ReactNode } from "react";

interface Props {
  label: string;
  resetKeys?: unknown[];
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** A crash in one pane degrades to a visible message, not a blank window. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKeys !== this.props.resetKeys) {
      const a = prev.resetKeys ?? [];
      const b = this.props.resetKeys ?? [];
      if (a.length !== b.length || a.some((v, i) => v !== b[i])) this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="pane-error" role="alert">
          <strong>{this.props.label} failed to render.</strong>
          <code>{this.state.error.message}</code>
          <button className="btn" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
