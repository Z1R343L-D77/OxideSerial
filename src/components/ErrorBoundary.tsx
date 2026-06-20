import { Component, type ReactNode } from "react";
import i18n from "../locales";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

// R6: 错误边界 — 防止单个组件崩溃导致白屏
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          background: "var(--bg-primary)",
          color: "var(--text-primary)",
          fontFamily: "Consolas, monospace",
          gap: 16,
          padding: 32,
        }}>
          <h2 style={{ color: "var(--danger)", margin: 0 }}>{i18n.t("errorBoundary.title", { defaultValue: "组件渲染错误" })}</h2>
          <pre style={{
            background: "var(--bg-secondary)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: 16,
            maxWidth: 600,
            overflow: "auto",
            fontSize: 12,
            color: "var(--text-secondary)",
          }}>
            {this.state.error?.message}
          </pre>
          <button
            onClick={this.handleReload}
            style={{
              background: "var(--accent)",
              color: "var(--bg-primary)",
              border: "none",
              borderRadius: 8,
              padding: "8px 24px",
              cursor: "pointer",
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            {i18n.t("errorBoundary.retry", { defaultValue: "重试" })}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
