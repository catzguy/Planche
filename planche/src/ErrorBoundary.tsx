import { Component, type ReactNode } from "react";
import { t } from "./i18n";

type Props = { children: ReactNode; onReset?: () => void };
type State = { error: string | null };

/** Keeps one failing panel (a catalog feed that React cannot render, for
 * instance) from unmounting the whole window. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(e: unknown): State {
    return { error: String(e) };
  }

  render() {
    if (this.state.error === null) return this.props.children;
    return (
      <div className="notice error" role="alert">
        <p>{t("errors.panelFailed")}</p>
        <pre>{this.state.error}</pre>
        <button
          onClick={() => {
            this.setState({ error: null });
            this.props.onReset?.();
          }}
        >
          {t("errors.retry")}
        </button>
      </div>
    );
  }
}
