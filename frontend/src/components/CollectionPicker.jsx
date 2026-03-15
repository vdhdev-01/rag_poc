/**
 * CollectionPicker.jsx
 *
 * Lists all collections and lets the user select one or create a new one.
 * Props:
 *   onSelect(collection) — called when a collection is chosen
 */

import { useState, useEffect } from "react";

const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";

async function apiFetch(path, opts = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...opts.headers },
    ...opts,
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

const api = {
  list:   ()           => apiFetch("/collections"),
  create: (name, desc) => apiFetch("/collections", {
    method: "POST",
    body: JSON.stringify({ name, description: desc || null }),
  }),
};

function fmt(ts) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", year: "numeric",
  }).format(new Date(ts));
}

// ── Create modal ──────────────────────────────────────────────────────────────

function CreateModal({ onCreate, onCancel }) {
  const [name, setName]   = useState("");
  const [desc, setDesc]   = useState("");
  const [busy, setBusy]   = useState(false);
  const [err,  setErr]    = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const col = await api.create(name.trim(), desc.trim());
      onCreate(col);
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={s.overlay}>
      <form style={s.modal} onSubmit={handleSubmit}>
        <h3 style={s.modalTitle}>New Collection</h3>
        <p style={s.modalSub}>
          Collections group related datasources together for targeted RAG search.
        </p>

        <label style={s.label}>Name *</label>
        <input
          style={s.input}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Legal Contracts"
          autoFocus
        />

        <label style={{ ...s.label, marginTop: 14 }}>Description (optional)</label>
        <textarea
          style={{ ...s.input, height: 72, resize: "vertical" }}
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder="What documents belong in this collection?"
        />

        {err && <p style={s.err}>{err}</p>}

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 22 }}>
          <button type="button" style={s.btnGhost} onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" style={s.btnPrimary} disabled={busy || !name.trim()}>
            {busy ? "Creating…" : "Create Collection"}
          </button>
        </div>
      </form>
    </div>
  );
}

// ── Collection card ───────────────────────────────────────────────────────────

function CollectionCard({ col, onSelect }) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      style={{
        ...s.card,
        ...(hovered ? s.cardHover : {}),
      }}
      onClick={() => onSelect(col)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Icon + name */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
            <div style={s.colIcon}>⊞</div>
            <span style={s.colName}>{col.name}</span>
          </div>

          {col.description && (
            <p style={s.colDesc}>{col.description}</p>
          )}
        </div>

        {/* Arrow */}
        <div style={{ ...s.arrow, ...(hovered ? s.arrowHover : {}) }}>→</div>
      </div>

      {/* Footer stats */}
      <div style={s.cardFooter}>
        <span style={s.stat}>
          <span style={s.statNum}>{col.datasource_count}</span>
          {" "}file{col.datasource_count !== 1 ? "s" : ""}
        </span>
        {col.created_at && (
          <span style={s.stat}>Created {fmt(col.created_at)}</span>
        )}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function CollectionPicker({ onSelect }) {
  const [collections, setCollections] = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState(null);
  const [showCreate,  setShowCreate]  = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setCollections(await api.list());
    } catch (ex) {
      setError(ex.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  function handleCreated(col) {
    setShowCreate(false);
    setCollections((prev) => [...prev, col]);
    // Immediately navigate into the new collection
    onSelect(col);
  }

  return (
    <div style={s.root}>
      <link
        href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Syne:wght@500;700&display=swap"
        rel="stylesheet"
      />

      {/* Header */}
      <div style={s.header}>
        <div>
          <h1 style={s.title}>Collections</h1>
          <p style={s.subtitle}>Select a collection to view and upload datasources</p>
        </div>
        <button style={s.btnPrimary} onClick={() => setShowCreate(true)}>
          + New Collection
        </button>
      </div>

      {/* Error */}
      {error && <div style={s.errorBanner}>⚠ {error}</div>}

      {/* Loading */}
      {loading ? (
        <div style={s.empty}>Loading collections…</div>
      ) : collections.length === 0 ? (
        <div style={s.empty}>
          <div style={{ fontSize: 40, marginBottom: 16, color: "#1F2937" }}>⊞</div>
          <p style={{ marginBottom: 8 }}>No collections yet.</p>
          <p style={{ color: "#6B7280", fontSize: 12 }}>
            Create your first collection to start uploading datasources.
          </p>
          <button
            style={{ ...s.btnPrimary, marginTop: 20 }}
            onClick={() => setShowCreate(true)}
          >
            + Create First Collection
          </button>
        </div>
      ) : (
        <div style={s.grid}>
          {collections.map((col) => (
            <CollectionCard key={col.id} col={col} onSelect={onSelect} />
          ))}

          {/* Add new tile */}
          <div style={s.addTile} onClick={() => setShowCreate(true)}>
            <span style={{ fontSize: 28, color: "#374151" }}>+</span>
            <span style={{ fontSize: 12, color: "#4B5563", marginTop: 6, fontFamily: "'IBM Plex Mono', monospace" }}>
              New Collection
            </span>
          </div>
        </div>
      )}

      {showCreate && (
        <CreateModal
          onCreate={handleCreated}
          onCancel={() => setShowCreate(false)}
        />
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = {
  root: {
    minHeight: "100%",
    background: "#0A0C10",
    color: "#E5E7EB",
    padding: "40px 48px",
    fontFamily: "'Syne', sans-serif",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 36,
    borderBottom: "1px solid #1F2937",
    paddingBottom: 24,
  },
  title: {
    margin: 0,
    fontSize: 28,
    fontWeight: 700,
    letterSpacing: "-0.02em",
    color: "#F9FAFB",
  },
  subtitle: {
    margin: "6px 0 0",
    fontSize: 13,
    color: "#6B7280",
    fontFamily: "'IBM Plex Mono', monospace",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
    gap: 16,
  },
  card: {
    background: "#0D1017",
    border: "1px solid #1A1F2E",
    borderRadius: 10,
    padding: "20px 22px",
    cursor: "pointer",
    transition: "border-color 0.15s, background 0.15s",
  },
  cardHover: {
    background: "#111318",
    borderColor: "#374151",
  },
  cardFooter: {
    display: "flex",
    justifyContent: "space-between",
    marginTop: 16,
    paddingTop: 14,
    borderTop: "1px solid #111827",
  },
  colIcon: {
    width: 28, height: 28,
    borderRadius: 6,
    background: "#10B98118",
    border: "1px solid #10B98140",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: 14, color: "#10B981", flexShrink: 0,
  },
  colName: {
    fontSize: 15,
    fontWeight: 600,
    color: "#F9FAFB",
    letterSpacing: "-0.01em",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  colDesc: {
    fontSize: 12,
    color: "#6B7280",
    fontFamily: "'IBM Plex Mono', monospace",
    lineHeight: 1.5,
    marginBottom: 0,
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
  },
  arrow: {
    fontSize: 16,
    color: "#374151",
    transition: "color 0.15s, transform 0.15s",
    flexShrink: 0,
    paddingTop: 2,
  },
  arrowHover: {
    color: "#10B981",
    transform: "translateX(3px)",
  },
  stat: {
    fontSize: 11,
    color: "#4B5563",
    fontFamily: "'IBM Plex Mono', monospace",
  },
  statNum: {
    color: "#9CA3AF",
    fontWeight: 500,
  },
  addTile: {
    background: "transparent",
    border: "1px dashed #1F2937",
    borderRadius: 10,
    padding: "20px 22px",
    cursor: "pointer",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    minHeight: 110,
    transition: "border-color 0.15s",
  },
  empty: {
    textAlign: "center",
    padding: "80px 0",
    color: "#4B5563",
    fontSize: 14,
    fontFamily: "'IBM Plex Mono', monospace",
  },
  errorBanner: {
    background: "#1F0A0A",
    border: "1px solid #7F1D1D",
    color: "#FCA5A5",
    borderRadius: 6,
    padding: "10px 16px",
    fontSize: 13,
    marginBottom: 20,
  },
  // Modal
  overlay: {
    position: "fixed", inset: 0,
    background: "rgba(0,0,0,0.75)",
    display: "flex", alignItems: "center", justifyContent: "center",
    zIndex: 1000,
  },
  modal: {
    background: "#111318",
    border: "1px solid #1F2937",
    borderRadius: 10,
    padding: 28,
    width: 440,
    maxWidth: "90vw",
  },
  modalTitle: {
    margin: "0 0 6px",
    fontSize: 16,
    fontWeight: 700,
    color: "#F9FAFB",
  },
  modalSub: {
    margin: "0 0 20px",
    fontSize: 13,
    color: "#6B7280",
    fontFamily: "'IBM Plex Mono', monospace",
    lineHeight: 1.5,
  },
  label: {
    display: "block",
    fontSize: 11,
    color: "#6B7280",
    fontFamily: "'IBM Plex Mono', monospace",
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    marginBottom: 6,
  },
  input: {
    display: "block",
    width: "100%",
    background: "#0D1017",
    border: "1px solid #1F2937",
    color: "#E5E7EB",
    padding: "9px 12px",
    borderRadius: 6,
    fontSize: 13,
    fontFamily: "'IBM Plex Mono', monospace",
    outline: "none",
    boxSizing: "border-box",
  },
  err: {
    color: "#EF4444",
    fontSize: 12,
    marginTop: 8,
    fontFamily: "'IBM Plex Mono', monospace",
  },
  btnPrimary: {
    background: "#F9FAFB",
    color: "#0A0C10",
    border: "none",
    padding: "9px 18px",
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "'Syne', sans-serif",
    transition: "opacity 0.15s",
  },
  btnGhost: {
    background: "transparent",
    color: "#9CA3AF",
    border: "1px solid #374151",
    padding: "8px 16px",
    borderRadius: 6,
    fontSize: 13,
    cursor: "pointer",
    fontFamily: "'Syne', sans-serif",
  },
};
