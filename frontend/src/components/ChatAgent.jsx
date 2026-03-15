/**
 * ChatAgent.jsx
 *
 * RAG chat interface — streams responses from the Python backend,
 * which performs similarity search against document_chunks and
 * calls the LLM with retrieved context.
 */

import { useState, useEffect, useRef, useCallback } from "react";

// ─── Constants ────────────────────────────────────────────────────────────────

const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";

const SYSTEM_NOTE =
  "Answers are grounded in your indexed datasources. " +
  "Cited source files appear beneath each response.";

// ─── Utilities ────────────────────────────────────────────────────────────────

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function formatTime(ts) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit", minute: "2-digit",
  }).format(new Date(ts));
}

// ─── API ──────────────────────────────────────────────────────────────────────

/**
 * POST /api/chat/stream
 * Body: { session_id, message, history }
 * Expects: newline-delimited JSON stream
 *   { type: "token",   content: "..." }
 *   { type: "sources", sources: [{ name, chunk_index, similarity }] }
 *   { type: "done" }
 *   { type: "error",   message: "..." }
 */
async function streamChat({ sessionId, message, history, onToken, onSources, onDone, onError }) {
  try {
    const res = await fetch(`${API_BASE}/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        message,
        history: history.map((m) => ({ role: m.role, content: m.content })),
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      onError(err || `HTTP ${res.status}`);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed);
          if (event.type === "token")   onToken(event.content);
          if (event.type === "sources") onSources(event.sources ?? []);
          if (event.type === "done")    onDone();
          if (event.type === "error")   onError(event.message);
        } catch {
          // skip malformed line
        }
      }
    }
  } catch (e) {
    onError(e.message ?? "Network error");
  }
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SourceChip({ source }) {
  return (
    <span style={chipStyle}>
      <span style={{ opacity: 0.6 }}>📄</span>
      {source.name}
      {source.chunk_index != null && (
        <span style={{ opacity: 0.5, marginLeft: 4, fontStyle: "italic" }}>
          §{source.chunk_index}
        </span>
      )}
      {source.similarity != null && (
        <span style={{
          marginLeft: 6, fontSize: 9, color: "#10B981",
          fontFamily: "'IBM Plex Mono', monospace",
        }}>
          {(source.similarity * 100).toFixed(0)}%
        </span>
      )}
    </span>
  );
}

const chipStyle = {
  display: "inline-flex", alignItems: "center", gap: 5,
  background: "#0D1117", border: "1px solid #1F2937",
  borderRadius: 4, padding: "3px 8px",
  fontSize: 11, color: "#9CA3AF",
  fontFamily: "'IBM Plex Mono', monospace",
};

function Message({ msg, isStreaming }) {
  const isUser = msg.role === "user";

  return (
    <div style={{
      display: "flex",
      justifyContent: isUser ? "flex-end" : "flex-start",
      marginBottom: 20,
      gap: 10,
      alignItems: "flex-start",
    }}>
      {!isUser && (
        <div style={styles.avatar}>
          <span style={{ fontSize: 14 }}>◈</span>
        </div>
      )}

      <div style={{ maxWidth: "72%", minWidth: 0 }}>
        <div style={{
          ...styles.bubble,
          ...(isUser ? styles.bubbleUser : styles.bubbleAssistant),
        }}>
          {isStreaming && !msg.content && (
            <span style={styles.cursor} />
          )}
          <div style={styles.messageText}>
            {msg.content}
            {isStreaming && <span style={styles.cursor} />}
          </div>
        </div>

        {msg.sources?.length > 0 && (
          <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 5 }}>
            <span style={{ fontSize: 10, color: "#4B5563", alignSelf: "center", fontFamily: "'IBM Plex Mono', monospace" }}>
              Sources:
            </span>
            {msg.sources.map((s, i) => <SourceChip key={i} source={s} />)}
          </div>
        )}

        <div style={{
          fontSize: 10, color: "#4B5563", marginTop: 5,
          fontFamily: "'IBM Plex Mono', monospace",
          textAlign: isUser ? "right" : "left",
        }}>
          {formatTime(msg.ts)}
        </div>
      </div>

      {isUser && (
        <div style={{ ...styles.avatar, background: "#1A1F2E", fontSize: 12 }}>
          U
        </div>
      )}
    </div>
  );
}

function EmptyState() {
  const suggestions = [
    "Summarize the key themes across all documents",
    "What compliance requirements are mentioned?",
    "Find any action items or deadlines",
    "Compare the content across uploaded files",
  ];

  return (
    <div style={styles.emptyState}>
      <div style={styles.emptyIcon}>◈</div>
      <h2 style={styles.emptyTitle}>RAG Agent Ready</h2>
      <p style={styles.emptySubtitle}>{SYSTEM_NOTE}</p>
      <div style={styles.suggestions}>
        {suggestions.map((s) => (
          <button
            key={s}
            style={styles.suggestionBtn}
            onClick={() => {
              window.dispatchEvent(new CustomEvent("rag:suggestion", { detail: s }));
            }}
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function ChatAgent({ title = "RAG Agent" }) {
  const [sessionId]               = useState(uid);
  const [messages, setMessages]   = useState([]);
  const [input, setInput]         = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError]         = useState(null);
  const bottomRef                 = useRef(null);
  const inputRef                  = useRef(null);
  const streamingIdRef            = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    const handler = (e) => {
      setInput(e.detail);
      inputRef.current?.focus();
    };
    window.addEventListener("rag:suggestion", handler);
    return () => window.removeEventListener("rag:suggestion", handler);
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming) return;

    setInput("");
    setError(null);

    const userMsg = { id: uid(), role: "user",      content: text, ts: Date.now() };
    const asstId  = uid();
    const asstMsg = { id: asstId, role: "assistant", content: "", sources: [], ts: Date.now() };

    setMessages((prev) => [...prev, userMsg, asstMsg]);
    setStreaming(true);
    streamingIdRef.current = asstId;

    const history = messages.map((m) => ({ role: m.role, content: m.content }));

    await streamChat({
      sessionId,
      message: text,
      history,

      onToken: (token) => {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === asstId ? { ...m, content: m.content + token } : m
          )
        );
      },

      onSources: (sources) => {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === asstId ? { ...m, sources } : m
          )
        );
      },

      onDone: () => {
        setStreaming(false);
        streamingIdRef.current = null;
      },

      onError: (err) => {
        setError(err);
        setStreaming(false);
        streamingIdRef.current = null;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === asstId
              ? { ...m, content: "⚠ An error occurred. Please try again." }
              : m
          )
        );
      },
    });
  }, [input, streaming, messages, sessionId]);

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  function clearSession() {
    setMessages([]);
    setError(null);
    setInput("");
  }

  return (
    <div style={styles.root}>
      <link
        href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Syne:wght@500;700&display=swap"
        rel="stylesheet"
      />

      {/* Header */}
      <div style={styles.header}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={styles.logoMark}>◈</div>
          <div>
            <h1 style={styles.headerTitle}>{title}</h1>
            <span style={styles.headerSub}>
              Session: <span style={{ color: "#6B7280" }}>{sessionId}</span>
            </span>
          </div>
        </div>
        <button style={styles.clearBtn} onClick={clearSession}>
          Clear session
        </button>
      </div>

      {/* Messages */}
      <div style={styles.messages}>
        {messages.length === 0 ? (
          <EmptyState />
        ) : (
          messages.map((msg) => (
            <Message
              key={msg.id}
              msg={msg}
              isStreaming={streaming && msg.id === streamingIdRef.current}
            />
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {/* Error banner */}
      {error && (
        <div style={styles.errorBanner}>⚠ {error}</div>
      )}

      {/* Input */}
      <div style={styles.inputRow}>
        <textarea
          ref={inputRef}
          style={styles.textarea}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask a question about your documents…"
          rows={1}
          disabled={streaming}
        />
        <button
          style={{
            ...styles.sendBtn,
            opacity: !input.trim() || streaming ? 0.4 : 1,
          }}
          onClick={send}
          disabled={!input.trim() || streaming}
        >
          {streaming ? (
            <span style={styles.spinnerDot} />
          ) : (
            "↑"
          )}
        </button>
      </div>

      <p style={styles.footer}>
        Shift+Enter for new line · Enter to send · Responses grounded in indexed datasources
      </p>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = {
  root: {
    display: "flex", flexDirection: "column",
    position: "absolute", inset: 0,
    background: "#080B10",
    color: "#E5E7EB",
    fontFamily: "'Syne', sans-serif",
    overflow: "hidden",
  },
  header: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    padding: "16px 28px",
    borderBottom: "1px solid #111827",
    background: "#0A0C10",
    flexShrink: 0,
  },
  logoMark: {
    width: 36, height: 36,
    border: "1px solid #1F2937",
    borderRadius: 8,
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: 18, color: "#10B981",
  },
  headerTitle: {
    margin: 0, fontSize: 16, fontWeight: 700, color: "#F9FAFB",
    letterSpacing: "-0.01em",
  },
  headerSub: {
    fontSize: 10, fontFamily: "'IBM Plex Mono', monospace", color: "#4B5563",
  },
  clearBtn: {
    background: "transparent", border: "1px solid #1F2937",
    color: "#6B7280", padding: "6px 14px", borderRadius: 5,
    fontSize: 12, cursor: "pointer",
    fontFamily: "'IBM Plex Mono', monospace",
  },
  messages: {
    flex: 1, overflowY: "auto",
    padding: "32px 28px",
    scrollBehavior: "smooth",
  },
  avatar: {
    width: 30, height: 30, borderRadius: 6,
    background: "#0D1117", border: "1px solid #1F2937",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: 14, color: "#10B981", flexShrink: 0,
    fontFamily: "'IBM Plex Mono', monospace",
    fontWeight: 500,
  },
  bubble: {
    borderRadius: 10, padding: "12px 16px",
    lineHeight: 1.65, wordBreak: "break-word",
  },
  bubbleUser: {
    background: "#1A1F2E",
    border: "1px solid #1F2937",
    borderTopRightRadius: 3,
    color: "#E5E7EB",
  },
  bubbleAssistant: {
    background: "#0D1117",
    border: "1px solid #1A2030",
    borderTopLeftRadius: 3,
    color: "#D1D5DB",
  },
  messageText: {
    fontSize: 14, whiteSpace: "pre-wrap",
  },
  cursor: {
    display: "inline-block",
    width: 2, height: "1em",
    background: "#10B981",
    marginLeft: 2, verticalAlign: "text-bottom",
    animation: "blink 0.9s step-start infinite",
  },
  emptyState: {
    display: "flex", flexDirection: "column",
    alignItems: "center", justifyContent: "center",
    height: "100%", textAlign: "center",
    padding: "0 24px",
  },
  emptyIcon: {
    fontSize: 40, color: "#1F2937", marginBottom: 20,
    lineHeight: 1,
  },
  emptyTitle: {
    margin: "0 0 8px", fontSize: 22, fontWeight: 700,
    color: "#374151", letterSpacing: "-0.02em",
  },
  emptySubtitle: {
    margin: "0 0 32px", fontSize: 13, color: "#374151",
    fontFamily: "'IBM Plex Mono', monospace", maxWidth: 380,
    lineHeight: 1.6,
  },
  suggestions: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 10, maxWidth: 540,
  },
  suggestionBtn: {
    background: "#0D1117", border: "1px solid #1F2937",
    color: "#6B7280", padding: "12px 14px",
    borderRadius: 8, fontSize: 12, cursor: "pointer",
    fontFamily: "'IBM Plex Mono', monospace",
    textAlign: "left", lineHeight: 1.4,
    transition: "all 0.15s",
  },
  inputRow: {
    display: "flex", gap: 10, padding: "16px 28px",
    borderTop: "1px solid #111827",
    background: "#0A0C10",
    flexShrink: 0,
    alignItems: "flex-end",
  },
  textarea: {
    flex: 1,
    background: "#0D1117", border: "1px solid #1F2937",
    color: "#E5E7EB", padding: "12px 16px",
    borderRadius: 8, fontSize: 14,
    fontFamily: "'Syne', sans-serif",
    resize: "none", outline: "none",
    lineHeight: 1.5, minHeight: 48, maxHeight: 200,
    overflowY: "auto",
  },
  sendBtn: {
    width: 44, height: 44, borderRadius: 8,
    background: "#F9FAFB", color: "#0A0C10",
    border: "none", cursor: "pointer",
    fontSize: 20, fontWeight: 700,
    display: "flex", alignItems: "center", justifyContent: "center",
    flexShrink: 0, transition: "opacity 0.15s",
  },
  spinnerDot: {
    width: 8, height: 8, borderRadius: "50%",
    background: "#0A0C10",
    animation: "pulse 0.8s ease-in-out infinite",
  },
  errorBanner: {
    margin: "0 28px 8px",
    background: "#1F0A0A", border: "1px solid #7F1D1D",
    color: "#FCA5A5", borderRadius: 6, padding: "8px 14px",
    fontSize: 12, fontFamily: "'IBM Plex Mono', monospace",
  },
  footer: {
    textAlign: "center", fontSize: 10,
    color: "#374151", fontFamily: "'IBM Plex Mono', monospace",
    padding: "8px 0 14px", flexShrink: 0,
  },
};

// Inject keyframe animations
if (typeof document !== "undefined") {
  const sheet = document.createElement("style");
  sheet.textContent = `
    @keyframes blink {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0; }
    }
    @keyframes pulse {
      0%, 100% { transform: scale(1);   opacity: 1; }
      50%       { transform: scale(1.4); opacity: 0.6; }
    }
    textarea:focus { border-color: #374151 !important; }
    button:hover   { opacity: 0.85; }
    tr:hover td    { background: #0D1017; }
  `;
  document.head.appendChild(sheet);
}
