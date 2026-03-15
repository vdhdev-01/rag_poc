import { useState } from "react";
import DatasourceManager from "./components/DatasourceManager.jsx";
import CollectionPicker from "./components/CollectionPicker.jsx";
import ChatAgent from "./components/ChatAgent.jsx";

const NAV_ITEMS = [
  { key: "chat",    label: "◈  Chat Agent" },
  { key: "sources", label: "⊞  Datasources" },
];

export default function App() {
  const [activeTab, setActiveTab]           = useState("chat");
  const [activeCollection, setActiveCollection] = useState(null);

  function handleTabChange(key) {
    setActiveTab(key);
    // Reset collection selection when switching back to the tab
    if (key !== "sources") setActiveCollection(null);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "#080B10", overflow: "hidden" }}>

      {/* Top navigation bar */}
      <nav style={navStyle}>
        <span style={logoStyle}>RAG POC</span>
        <div style={{ display: "flex", gap: 4 }}>
          {NAV_ITEMS.map(({ key, label }) => (
            <button
              key={key}
              style={{ ...tabBtn, ...(activeTab === key ? tabBtnActive : {}) }}
              onClick={() => handleTabChange(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </nav>

      {/* Page content */}
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        <div style={{
          position: "absolute", inset: 0,
          display: activeTab === "chat" ? "flex" : "block",
          flexDirection: "column",
          overflowY: activeTab === "sources" ? "auto" : "hidden",
        }}>
          {/* Chat tab */}
          {activeTab === "chat" && <ChatAgent />}

          {/* Datasources tab — collection picker → datasource manager */}
          {activeTab === "sources" && (
            activeCollection
              ? (
                <DatasourceManager
                  collection={activeCollection}
                  onBack={() => setActiveCollection(null)}
                />
              )
              : (
                <CollectionPicker onSelect={setActiveCollection} />
              )
          )}
        </div>
      </div>

    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const navStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "0 24px",
  height: 52,
  background: "#0A0C10",
  borderBottom: "1px solid #111827",
  flexShrink: 0,
  zIndex: 100,
};

const logoStyle = {
  fontFamily: "'Syne', sans-serif",
  fontWeight: 700,
  fontSize: 15,
  letterSpacing: "-0.02em",
  color: "#10B981",
};

const tabBtn = {
  background: "transparent",
  border: "1px solid transparent",
  color: "#6B7280",
  padding: "6px 14px",
  borderRadius: 6,
  fontSize: 12,
  cursor: "pointer",
  fontFamily: "'IBM Plex Mono', monospace",
  letterSpacing: "0.02em",
  transition: "all 0.15s",
};

const tabBtnActive = {
  background: "#111318",
  border: "1px solid #1F2937",
  color: "#F9FAFB",
};
