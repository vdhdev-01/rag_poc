"""
services/rag.py

Retrieval-Augmented Generation pipeline:
  embed query → similarity search → build context → stream LLM response
"""
import asyncio
import json
import logging
from typing import AsyncGenerator

from database import get_conn, app_config
from services.ingestion import embed_texts, _vec_to_pg

logger = logging.getLogger(__name__)


# ── Similarity search ─────────────────────────────────────────────────────────

def similarity_search(
    query_embedding: list[float],
    collection_id: str | None = None,
    match_count: int = 6,
    min_similarity: float = 0.25,
) -> list[dict]:
    """
    Cosine similarity search against document_chunks.
    If collection_id is None, searches across ALL collections.
    """
    vec_str = _vec_to_pg(query_embedding)
    with get_conn() as conn:
        with conn.cursor() as cur:
            if collection_id:
                # Scoped to one collection — use the stored function
                try:
                    cur.execute(
                        """
                        SELECT chunk_id, datasource_id, datasource_guid,
                               datasource_name, collection_name,
                               chunk_index, content, similarity
                        FROM fn_similarity_search(%s::vector, %s::uuid, %s, %s)
                        """,
                        (vec_str, collection_id, match_count, min_similarity),
                    )
                except Exception:
                    conn.rollback()
                    cur.execute(
                        """
                        SELECT dc.id, dc.datasource_id, dc.datasource_guid,
                               ds.name, col.name,
                               dc.chunk_index, dc.content,
                               (1 - (dc.embedding <=> %s::vector))::float AS similarity
                        FROM   document_chunks dc
                        JOIN   datasources     ds  ON ds.id  = dc.datasource_id
                        JOIN   collections     col ON col.id = dc.collection_id
                        WHERE  dc.status        = 'embedded'
                          AND  dc.collection_id = %s::uuid
                          AND  ds.deleted_at    IS NULL
                          AND  ds.status        = 'ready'
                        ORDER BY dc.embedding <=> %s::vector
                        LIMIT  %s
                        """,
                        (vec_str, collection_id, vec_str, match_count),
                    )
            else:
                # No collection filter — search all embedded chunks
                cur.execute(
                    """
                    SELECT dc.id         AS chunk_id,
                           dc.datasource_id,
                           dc.datasource_guid,
                           ds.name       AS datasource_name,
                           col.name      AS collection_name,
                           dc.chunk_index,
                           dc.content,
                           (1 - (dc.embedding <=> %s::vector))::float AS similarity
                    FROM   document_chunks dc
                    JOIN   datasources     ds  ON ds.id  = dc.datasource_id
                    JOIN   collections     col ON col.id = dc.collection_id
                    WHERE  dc.status     = 'embedded'
                      AND  ds.deleted_at IS NULL
                      AND  ds.status     = 'ready'
                      AND  (1 - (dc.embedding <=> %s::vector)) >= %s
                    ORDER BY dc.embedding <=> %s::vector
                    LIMIT  %s
                    """,
                    (vec_str, vec_str, min_similarity, vec_str, match_count),
                )

            rows = cur.fetchall()
            cols = [d[0] for d in cur.description]

    return [dict(zip(cols, row)) for row in rows]


# ── LLM streaming ─────────────────────────────────────────────────────────────

async def stream_rag_response(
    message: str,
    history: list[dict],
    collection_id: str,
) -> AsyncGenerator[str, None]:
    """
    Full RAG pipeline that yields newline-delimited JSON events:
      {"type": "sources", "sources": [...]}
      {"type": "token",   "content": "..."}
      {"type": "done"}
      {"type": "error",   "message": "..."}
    """
    cfg = app_config()

    try:
        # 1 — embed the query in a thread
        query_vec = await asyncio.to_thread(embed_texts, [message])
        query_vec = query_vec[0]

        # 2 — similarity search
        chunks = await asyncio.to_thread(
            similarity_search, query_vec, collection_id
        )

        # 3 — emit sources
        sources = [
            {
                "name":        c.get("datasource_name", ""),
                "chunk_index": c.get("chunk_index"),
                "similarity":  round(float(c.get("similarity", 0)), 4),
            }
            for c in chunks
        ]
        yield json.dumps({"type": "sources", "sources": sources}) + "\n"

        # 4 — build context string
        context_parts = [
            f"[{c['datasource_name']} — chunk {c['chunk_index']}]\n{c['content']}"
            for c in chunks
        ]
        context = "\n\n---\n\n".join(context_parts) if context_parts else ""

        system_prompt = (
            "You are a helpful assistant. "
            "Answer the user's question using ONLY the context below. "
            "If the answer is not in the context, say so clearly.\n\n"
            f"CONTEXT:\n{context}"
            if context
            else
            "You are a helpful assistant. "
            "No relevant documents were found in the knowledge base for this query. "
            "Inform the user politely."
        )

        # 5 — call LLM (OpenAI) if API key is configured
        openai_key = cfg["openai"].get("api_key", "").strip()
        if openai_key:
            async for line in _stream_openai(
                api_key=openai_key,
                model=cfg["openai"]["model"],
                system_prompt=system_prompt,
                history=history,
                message=message,
            ):
                yield line
            return

        # Fallback: echo context as a simple response (no LLM)
        if context:
            fallback = (
                "**Note:** No LLM is configured (set `openai.api_key` in config.json). "
                "Here is the raw context retrieved from your documents:\n\n" + context[:3000]
            )
        else:
            fallback = (
                "No relevant documents were found. "
                "Please upload and index some files first."
            )

        for word in fallback.split(" "):
            yield json.dumps({"type": "token", "content": word + " "}) + "\n"
            await asyncio.sleep(0.01)

        yield json.dumps({"type": "done"}) + "\n"

    except Exception as exc:
        logger.exception("RAG pipeline error: %s", exc)
        yield json.dumps({"type": "error", "message": str(exc)}) + "\n"


async def _stream_openai(
    api_key: str,
    model: str,
    system_prompt: str,
    history: list[dict],
    message: str,
) -> AsyncGenerator[str, None]:
    """Yield token/done/error events from the OpenAI streaming API."""
    from openai import AsyncOpenAI

    client = AsyncOpenAI(api_key=api_key)
    messages = [{"role": "system", "content": system_prompt}]
    # Keep last 10 turns to avoid exceeding context window
    for turn in history[-10:]:
        messages.append({"role": turn["role"], "content": turn["content"]})
    messages.append({"role": "user", "content": message})

    try:
        stream = await client.chat.completions.create(
            model=model,
            messages=messages,
            stream=True,
            temperature=0.3,
        )
        async for chunk in stream:
            delta = chunk.choices[0].delta.content
            if delta:
                yield json.dumps({"type": "token", "content": delta}) + "\n"

        yield json.dumps({"type": "done"}) + "\n"

    except Exception as exc:
        logger.exception("OpenAI streaming error: %s", exc)
        yield json.dumps({"type": "error", "message": str(exc)}) + "\n"
