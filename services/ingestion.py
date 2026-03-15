"""
services/ingestion.py

Full ingestion pipeline:
  extract text → chunk → embed → store in document_chunks
"""
import io
import json
import logging
from pathlib import Path
from typing import Optional

import numpy as np

from database import get_conn, app_config

logger = logging.getLogger(__name__)

# ── Lazy-loaded sentence-transformer model ───────────────────────────────────

_embed_model = None


def _get_embed_model():
    global _embed_model
    if _embed_model is None:
        cfg = app_config()["embedding"]
        model_name = cfg["local_model"]
        logger.info("Loading embedding model '%s' …", model_name)
        from sentence_transformers import SentenceTransformer
        _embed_model = SentenceTransformer(model_name)
        logger.info("Embedding model ready.")
    return _embed_model


# ── Text extraction ───────────────────────────────────────────────────────────

def extract_text(content: bytes, mime_type: str, filename: str) -> str:
    """Return plain text from the uploaded file bytes."""
    mt = (mime_type or "").lower()

    if mt == "application/pdf":
        import pypdf
        reader = pypdf.PdfReader(io.BytesIO(content))
        return "\n\n".join(
            page.extract_text() or "" for page in reader.pages
        )

    if mt in ("text/plain", "text/csv", "text/markdown"):
        return content.decode("utf-8", errors="replace")

    if mt == "application/json":
        try:
            data = json.loads(content)
            return json.dumps(data, indent=2)
        except Exception:
            return content.decode("utf-8", errors="replace")

    if "wordprocessingml" in mt or filename.lower().endswith(".docx"):
        import docx
        doc = docx.Document(io.BytesIO(content))
        return "\n".join(p.text for p in doc.paragraphs)

    # Fallback: attempt UTF-8 decode
    return content.decode("utf-8", errors="replace")


# ── Chunking ──────────────────────────────────────────────────────────────────

def chunk_text(text: str, chunk_size: int = 1000, overlap: int = 100) -> list[str]:
    """Split text into overlapping character-based chunks."""
    chunks: list[str] = []
    start = 0
    text = text.strip()
    while start < len(text):
        end = min(start + chunk_size, len(text))
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        if end == len(text):
            break
        start += chunk_size - overlap
    return chunks


# ── Embedding ─────────────────────────────────────────────────────────────────

def embed_texts(texts: list[str]) -> list[list[float]]:
    """Return a list of embedding vectors (one per text)."""
    model = _get_embed_model()
    vectors: np.ndarray = model.encode(texts, show_progress_bar=False, batch_size=32)
    return vectors.tolist()


def _vec_to_pg(v: list[float]) -> str:
    """Format a float list as a pgvector literal: '[0.1,0.2,...]'"""
    return "[" + ",".join(f"{x:.8f}" for x in v) + "]"


# ── Main pipeline ─────────────────────────────────────────────────────────────

def process_datasource(
    datasource_id: str,
    content: bytes,
    mime_type: str,
    filename: str,
    collection_id: str,
    organization_id: str,
    chunk_size: int = 1000,
    overlap: int = 100,
) -> None:
    """
    Full ingestion pipeline.  Runs in a background thread (FastAPI BackgroundTask).

    Steps:
      1. Mark datasource as 'processing'
      2. Extract text
      3. Chunk
      4. Embed (batch)
      5. Upsert document_chunks
      6. Mark datasource as 'ready'
    """
    try:
        # 1 — processing
        _update_status(datasource_id, "processing")

        # 2 — extract
        text = extract_text(content, mime_type, filename)
        if not text.strip():
            raise ValueError("No text could be extracted from the file.")

        # 3 — chunk
        chunks = chunk_text(text, chunk_size, overlap)
        if not chunks:
            raise ValueError("Text produced no chunks after splitting.")

        logger.info("[%s] %d chunks created", filename, len(chunks))

        # 4 — embed (batched)
        embeddings = embed_texts(chunks)

        # 5 — fetch datasource guid, then upsert chunks
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT guid FROM datasources WHERE id = %s",
                    (datasource_id,),
                )
                row = cur.fetchone()
                if not row:
                    raise RuntimeError(f"Datasource {datasource_id} not found.")
                datasource_guid = str(row[0])

                for idx, (chunk, vec) in enumerate(zip(chunks, embeddings)):
                    cur.execute(
                        """
                        INSERT INTO document_chunks
                            (datasource_id, datasource_guid, collection_id,
                             organization_id, chunk_index, content,
                             token_count, embedding, status)
                        VALUES (%s, %s::uuid, %s::uuid, %s::uuid,
                                %s, %s, %s, %s::vector, 'embedded')
                        ON CONFLICT (datasource_id, chunk_index) DO UPDATE
                            SET content       = EXCLUDED.content,
                                embedding     = EXCLUDED.embedding,
                                token_count   = EXCLUDED.token_count,
                                status        = 'embedded',
                                error_message = NULL,
                                updated_at    = NOW()
                        """,
                        (
                            datasource_id,
                            datasource_guid,
                            collection_id,
                            organization_id,
                            idx,
                            chunk,
                            len(chunk.split()),
                            _vec_to_pg(vec),
                        ),
                    )

                # 6 — ready
                cur.execute(
                    "UPDATE datasources SET status = 'ready' WHERE id = %s",
                    (datasource_id,),
                )
            conn.commit()

        logger.info("[%s] ingestion complete — %d chunks", filename, len(chunks))

    except Exception as exc:
        logger.exception("Ingestion failed for datasource %s: %s", datasource_id, exc)
        _update_status(datasource_id, "failed")


def _update_status(datasource_id: str, status: str) -> None:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE datasources SET status = %s WHERE id = %s",
                (status, datasource_id),
            )
        conn.commit()
