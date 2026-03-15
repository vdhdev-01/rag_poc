"""
main.py — FastAPI application entry point.

Run:
  .venv\\Scripts\\uvicorn main:app --reload --host 0.0.0.0 --port 8000
"""
import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pathlib import Path

from routers import datasources, chat

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s — %(message)s",
)

app = FastAPI(
    title="RAG POC API",
    version="1.0.0",
    description="Retrieval-Augmented Generation proof-of-concept.",
)

# ── CORS (allow Vite dev server at :5173) ─────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── API routes ────────────────────────────────────────────────────────────────
app.include_router(datasources.router, prefix="/api", tags=["Datasources"])
app.include_router(chat.router, prefix="/api", tags=["Chat"])


@app.get("/api/health")
def health():
    return {"status": "ok"}


# ── Serve built frontend (production) ─────────────────────────────────────────
_dist = Path(__file__).parent / "frontend" / "dist"
if _dist.exists():
    app.mount("/", StaticFiles(directory=str(_dist), html=True), name="frontend")
