import { StrictMode, Component } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{
          padding: 32, fontFamily: "monospace", color: "#FCA5A5",
          background: "#0A0C10", minHeight: "100vh",
        }}>
          <h2 style={{ color: "#EF4444", marginBottom: 16 }}>⚠ App render error</h2>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 13 }}>
            {this.state.error.message}
          </pre>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 11, color: "#6B7280", marginTop: 16 }}>
            {this.state.error.stack}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

const root = document.getElementById("root");
if (!root) {
  document.body.innerHTML = '<div style="color:red;padding:20px">ERROR: #root element not found</div>';
} else {
  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>
  );
}
