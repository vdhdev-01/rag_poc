/**
 * DatasourceManager.jsx
 *
 * Datasource upload + management panel.
 * Dependencies: @uppy/core @uppy/react @uppy/dashboard @uppy/xhr-upload
 */

import { useState, useEffect, useCallback, useRef } from "react";
import Uppy from "@uppy/core";
import { Dashboard } from "@uppy/react";
import XHRUpload from "@uppy/xhr-upload";

import "@uppy/core/dist/style.min.css";
import "@uppy/dashboard/dist/style.min.css";

// ─── Constants ────────────────────────────────────────────────────────────────

const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";

const STATUS_META = {
  pending:    { label: "Pending",    color: "#6B7280" },
  processing: { label: "Processing", color: "#F59E0B" },
  ready:      { label: "Ready",      color: "#10B981" },
  failed:     { label: "Failed",     color: "#EF4444" },
  replaced:   { label: "Replaced",   color: "#8B5CF6" },
};

const MIME_ICONS = {
  "application/pdf":    "📄",
  "text/plain":         "📝",
  "text/csv":           "📊",
  "application/json":   "🗂️",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "📘",
  default:              "📁",
};

// ─── Utilities ────────────────────────────────────────────────────────────────

const fmt = {
  date: (ts) =>
    new Intl.DateTimeFormat("en-US", {
      month: "short", day: "numeric", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    }).format(new Date(ts)),

  bytes: (n) => {
    if (!n) return "—";
    const units = ["B", "KB", "MB", "GB"];
    let i = 0, v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(i ? 1 : 0)} ${units[i]}`;
  },
};

const mimeIcon = (mime) => MIME_ICONS[mime] ?? MIME_ICONS.default;

// ─── API helpers ──────────────────────────────────────────────────────────────

async function apiFetch(path, opts = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...opts.headers },
    ...opts,
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

const api = {
  list:    ()           => apiFetch("/datasources"),
  delete:  (id)         => apiFetch(`/datasources/${id}`, { method: "DELETE" }),
  replace: (id, formData) =>
    fetch(`${API_BASE}/datasources/${id}/replace`, { method: "POST", body: formData }).then((r) => {
      if (!r.ok) throw new Error(`Replace failed: ${r.status}`);
      return r.json();
    }),
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  const meta = STATUS_META[status] ?? STATUS_META.pending;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      padding: "2px 9px", borderRadius: 3,
      fontSize: 11, fontFamily: "'IBM Plex Mono', monospace", letterSpacing: "0.04em",
      background: `${meta.color}18`, color: meta.color,
      border: `1px solid ${meta.color}40`,
    }}>
      <span style={{ width: 5, height: 5, borderRadius: "50%", background: meta.color, flexShrink: 0 }} />
      {meta.label.toUpperCase()}
    </span>
  );
}

function ConfirmModal({ message, onConfirm, onCancel }) {
  return (
    <div style={styles.overlay}>
      <div style={styles.modal}>
        <p style={{ color: "#E5E7EB", fontSize: 14, lineHeight: 1.6, marginBottom: 24 }}>{message}</p>
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button onClick={onCancel} style={styles.btnGhost}>Cancel</button>
          <button onClick={onConfirm} style={styles.btnDanger}>Confirm</button>
        </div>
      </div>
    </div>
  );
}

function ReplaceModal({ datasource, onSuccess, onCancel }) {
  const fileRef = useRef();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function handleReplace() {
    const file = fileRef.current?.files[0];
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      await api.replace(datasource.id, fd);
      onSuccess();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={styles.overlay}>
      <div style={styles.modal}>
        <h3 style={{ color: "#F9FAFB", fontSize: 15, fontWeight: 600, marginBottom: 6 }}>
          Replace Datasource
        </h3>
        <p style={{ color: "#9CA3AF", fontSize: 13, marginBottom: 20 }}>
          Replacing <strong style={{ color: "#E5E7EB" }}>{datasource.name}</strong>. The existing
          chunks will be purged and reprocessed.
        </p>
        <label style={styles.fileLabel}>
          <input ref={fileRef} type="file" style={{ display: "none" }} />
          <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: "#9CA3AF" }}>
            Click to select replacement file
          </span>
        </label>
        {err && <p style={{ color: "#EF4444", fontSize: 12, marginTop: 8 }}>{err}</p>}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 20 }}>
          <button onClick={onCancel} style={styles.btnGhost} disabled={busy}>Cancel</button>
          <button onClick={handleReplace} style={styles.btnPrimary} disabled={busy}>
            {busy ? "Uploading…" : "Replace"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ChunkProgress({ total, embedded, failed }) {
  if (!total) return null;
  const pct = Math.round((embedded / total) * 100);
  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
        <span style={{ fontSize: 10, color: "#6B7280", fontFamily: "'IBM Plex Mono', monospace" }}>
          {embedded}/{total} chunks embedded
        </span>
        {failed > 0 && (
          <span style={{ fontSize: 10, color: "#EF4444" }}>{failed} failed</span>
        )}
      </div>
      <div style={{ height: 2, background: "#1F2937", borderRadius: 2, overflow: "hidden" }}>
        <div style={{
          height: "100%", width: `${pct}%`,
          background: failed > 0 ? "#EF4444" : "#10B981",
          transition: "width 0.4s ease",
        }} />
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function DatasourceManager() {
  const [datasources, setDatasources] = useState([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState(null);
  const [search, setSearch]           = useState("");
  const [sort, setSort]               = useState({ key: "created_at", dir: "desc" });
  const [confirm, setConfirm]         = useState(null);
  const [replacing, setReplacing]     = useState(null);
  const [showUppy, setShowUppy]       = useState(false);
  const uppyRef                       = useRef(null);

  // Polling interval for in-progress datasources (ms)
  const pollRef = useRef(null);

  // ── Init Uppy ──────────────────────────────────────────────
  useEffect(() => {
    // Do NOT chain .use() on the constructor — store the instance first,
    // then configure plugins so `uppy` always references the live object.
    const uppy = new Uppy({
      autoProceed: false,
      allowMultipleUploadBatches: true,
      restrictions: {
        maxFileSize: 50 * 1024 * 1024,
        allowedFileTypes: [".pdf", ".txt", ".csv", ".json", ".docx"],
      },
    });

    uppy.use(XHRUpload, {
      endpoint: `${API_BASE}/datasources/upload`,
      fieldName: "files[]",
      bundle: true,
    });

    uppy.on("complete", (result) => {
      if (result.successful.length) {
        fetchDatasources();
        setTimeout(() => setShowUppy(false), 1200);
      }
    });

    uppyRef.current = uppy;

    return () => {
      uppyRef.current = null;
      if (uppy && typeof uppy.destroy === "function") uppy.destroy();
    };
  }, []);

  // ── Fetch ───────────────────────────────────────────────────
  const fetchDatasources = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.list();
      setDatasources(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchDatasources(); }, [fetchDatasources]);

  // ── Auto-poll while any datasource is processing ────────────
  useEffect(() => {
    const hasProcessing = datasources.some(
      (d) => d.status === "pending" || d.status === "processing"
    );
    if (hasProcessing && !pollRef.current) {
      pollRef.current = setInterval(fetchDatasources, 3000);
    } else if (!hasProcessing && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [datasources, fetchDatasources]);

  // ── Delete ──────────────────────────────────────────────────
  async function handleDelete(id) {
    try {
      await api.delete(id);
      setDatasources((prev) => prev.filter((d) => d.id !== id));
    } catch (e) {
      setError(e.message);
    } finally {
      setConfirm(null);
    }
  }

  // ── Sort / Filter ───────────────────────────────────────────
  const visible = datasources
    .filter((d) =>
      !search ||
      d.name.toLowerCase().includes(search.toLowerCase()) ||
      d.original_filename.toLowerCase().includes(search.toLowerCase())
    )
    .sort((a, b) => {
      const va = a[sort.key], vb = b[sort.key];
      const cmp = typeof va === "string" ? va.localeCompare(vb) : va - vb;
      return sort.dir === "asc" ? cmp : -cmp;
    });

  function toggleSort(key) {
    setSort((s) => s.key === key
      ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
      : { key, dir: "desc" }
    );
  }

  // ── Render ──────────────────────────────────────────────────
  return (
    <div style={styles.root}>
      <link
        href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Syne:wght@500;700&display=swap"
        rel="stylesheet"
      />

      {/* Header */}
      <div style={styles.header}>
        <div>
          <h1 style={styles.title}>Datasources</h1>
          <p style={styles.subtitle}>
            {datasources.length} source{datasources.length !== 1 ? "s" : ""} indexed
          </p>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <button style={styles.btnGhost} onClick={fetchDatasources} title="Refresh">
            ↺ Refresh
          </button>
          <button style={styles.btnPrimary} onClick={() => setShowUppy((v) => !v)}>
            {showUppy ? "✕ Close" : "+ Upload Files"}
          </button>
        </div>
      </div>

      {/* Uppy panel */}
      {showUppy && uppyRef.current && (
        <div style={styles.uppyWrap}>
          <Dashboard
            uppy={uppyRef.current}
            height={320}
            proudlyDisplayPoweredByUppy={false}
            theme="dark"
            note="PDF, TXT, CSV, JSON, DOCX — max 50 MB each"
          />
        </div>
      )}

      {/* Search & sort bar */}
      <div style={styles.toolbar}>
        <input
          style={styles.search}
          placeholder="Search datasources…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div style={{ display: "flex", gap: 6 }}>
          {["name", "file_size_bytes", "created_at"].map((k) => (
            <button
              key={k}
              style={{
                ...styles.sortBtn,
                ...(sort.key === k ? styles.sortBtnActive : {}),
              }}
              onClick={() => toggleSort(k)}
            >
              {{ name: "Name", file_size_bytes: "Size", created_at: "Date" }[k]}
              {sort.key === k && (sort.dir === "asc" ? " ↑" : " ↓")}
            </button>
          ))}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div style={styles.errorBanner}>⚠ {error}</div>
      )}

      {/* Table */}
      {loading ? (
        <div style={styles.emptyState}>Loading datasources…</div>
      ) : visible.length === 0 ? (
        <div style={styles.emptyState}>
          {search ? "No results match your search." : "No datasources yet. Upload your first file."}
        </div>
      ) : (
        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                {["File", "Size", "Status", "Chunks", "Uploaded", "Actions"].map((h) => (
                  <th key={h} style={styles.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((ds) => (
                <tr key={ds.id} style={styles.tr}>
                  {/* File */}
                  <td style={styles.td}>
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                      <span style={{ fontSize: 22, lineHeight: 1 }}>{mimeIcon(ds.mime_type)}</span>
                      <div>
                        <div style={{ color: "#F9FAFB", fontSize: 13, fontWeight: 500 }}>{ds.name}</div>
                        <div style={{ color: "#6B7280", fontSize: 11, fontFamily: "'IBM Plex Mono', monospace", marginTop: 2 }}>
                          {ds.original_filename}
                        </div>
                      </div>
                    </div>
                  </td>

                  {/* Size */}
                  <td style={{ ...styles.td, fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: "#9CA3AF" }}>
                    {fmt.bytes(ds.file_size_bytes)}
                  </td>

                  {/* Status */}
                  <td style={styles.td}><StatusBadge status={ds.status} /></td>

                  {/* Chunks */}
                  <td style={{ ...styles.td, minWidth: 140 }}>
                    <ChunkProgress
                      total={ds.total_chunks}
                      embedded={ds.embedded_chunks}
                      failed={ds.failed_chunks}
                    />
                  </td>

                  {/* Uploaded */}
                  <td style={{ ...styles.td, fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: "#6B7280", whiteSpace: "nowrap" }}>
                    {fmt.date(ds.created_at)}
                  </td>

                  {/* Actions */}
                  <td style={styles.td}>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button
                        style={styles.btnAction}
                        title="Replace file"
                        onClick={() => setReplacing(ds)}
                      >
                        ↺ Replace
                      </button>
                      <button
                        style={{ ...styles.btnAction, ...styles.btnActionDanger }}
                        title="Delete datasource"
                        onClick={() => setConfirm({ id: ds.id, name: ds.name })}
                      >
                        ✕ Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Modals */}
      {confirm && (
        <ConfirmModal
          message={`Permanently delete "${confirm.name}" and all its embedded chunks? This cannot be undone.`}
          onConfirm={() => handleDelete(confirm.id)}
          onCancel={() => setConfirm(null)}
        />
      )}

      {replacing && (
        <ReplaceModal
          datasource={replacing}
          onSuccess={() => { setReplacing(null); fetchDatasources(); }}
          onCancel={() => setReplacing(null)}
        />
      )}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = {
  root: {
    minHeight: "100%",
    background: "#0A0C10",
    color: "#E5E7EB",
    padding: "40px 48px",
    fontFamily: "'Syne', sans-serif",
  },
  header: {
    display: "flex", justifyContent: "space-between", alignItems: "flex-start",
    marginBottom: 32, borderBottom: "1px solid #1F2937", paddingBottom: 24,
  },
  title: {
    margin: 0, fontSize: 28, fontWeight: 700, letterSpacing: "-0.02em", color: "#F9FAFB",
  },
  subtitle: {
    margin: "6px 0 0", fontSize: 13, color: "#6B7280",
    fontFamily: "'IBM Plex Mono', monospace",
  },
  uppyWrap: {
    marginBottom: 28,
    borderRadius: 8,
    overflow: "hidden",
    border: "1px solid #1F2937",
  },
  toolbar: {
    display: "flex", gap: 12, alignItems: "center",
    marginBottom: 20,
  },
  search: {
    flex: 1, background: "#111318", border: "1px solid #1F2937",
    color: "#E5E7EB", padding: "9px 14px", borderRadius: 6,
    fontSize: 13, fontFamily: "'IBM Plex Mono', monospace",
    outline: "none",
  },
  sortBtn: {
    background: "transparent", border: "1px solid #1F2937",
    color: "#6B7280", padding: "6px 12px", borderRadius: 5,
    fontSize: 12, cursor: "pointer", fontFamily: "'IBM Plex Mono', monospace",
    transition: "all 0.15s",
  },
  sortBtnActive: {
    border: "1px solid #374151", color: "#D1D5DB", background: "#111318",
  },
  tableWrap: {
    overflowX: "auto",
    border: "1px solid #1A1F2E",
    borderRadius: 8,
  },
  table: {
    width: "100%", borderCollapse: "collapse",
  },
  th: {
    textAlign: "left", padding: "12px 16px",
    fontSize: 11, color: "#6B7280",
    fontFamily: "'IBM Plex Mono', monospace", letterSpacing: "0.07em",
    textTransform: "uppercase",
    borderBottom: "1px solid #1A1F2E",
    background: "#0D1017",
  },
  tr: {
    borderBottom: "1px solid #111318",
    transition: "background 0.1s",
  },
  td: {
    padding: "14px 16px", verticalAlign: "top",
  },
  emptyState: {
    textAlign: "center", padding: "80px 0",
    color: "#4B5563", fontSize: 14,
    fontFamily: "'IBM Plex Mono', monospace",
  },
  errorBanner: {
    background: "#1F0A0A", border: "1px solid #7F1D1D",
    color: "#FCA5A5", borderRadius: 6, padding: "10px 16px",
    fontSize: 13, marginBottom: 16,
  },
  overlay: {
    position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
    display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
  },
  modal: {
    background: "#111318", border: "1px solid #1F2937",
    borderRadius: 10, padding: 28, width: 420, maxWidth: "90vw",
  },
  fileLabel: {
    display: "block", border: "1px dashed #374151",
    borderRadius: 6, padding: "20px 16px",
    textAlign: "center", cursor: "pointer",
  },
  btnPrimary: {
    background: "#F9FAFB", color: "#0A0C10",
    border: "none", padding: "9px 18px", borderRadius: 6,
    fontSize: 13, fontWeight: 600, cursor: "pointer",
    fontFamily: "'Syne', sans-serif", letterSpacing: "-0.01em",
    transition: "opacity 0.15s",
  },
  btnGhost: {
    background: "transparent", color: "#9CA3AF",
    border: "1px solid #374151", padding: "8px 16px",
    borderRadius: 6, fontSize: 13, cursor: "pointer",
    fontFamily: "'Syne', sans-serif",
  },
  btnDanger: {
    background: "#7F1D1D", color: "#FCA5A5",
    border: "1px solid #991B1B", padding: "8px 16px",
    borderRadius: 6, fontSize: 13, cursor: "pointer",
    fontFamily: "'Syne', sans-serif",
  },
  btnAction: {
    background: "transparent", color: "#9CA3AF",
    border: "1px solid #1F2937", padding: "5px 10px",
    borderRadius: 5, fontSize: 11, cursor: "pointer",
    fontFamily: "'IBM Plex Mono', monospace",
    transition: "all 0.15s",
  },
  btnActionDanger: {
    color: "#F87171", borderColor: "#7F1D1D",
  },
};
