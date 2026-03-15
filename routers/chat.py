"""
routers/chat.py

POST /api/chat/stream
  Body : { session_id, message, history: [{role, content}] }
  Stream: newline-delimited JSON
    {"type": "sources",  "sources": [...]}
    {"type": "token",    "content": "..."}
    {"type": "done"}
    {"type": "error",    "message": "..."}
"""
import json
import logging
import uuid

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import StreamingResponse

from database import get_conn, app_config
from services.rag import stream_rag_response

logger = logging.getLogger(__name__)
router = APIRouter()


def _default_collection_id() -> str:
    cfg = app_config()
    col_id = cfg.get("default_collection_id", "")
    if not col_id:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Default collection not set. Run setup_db.py first.",
        )
    return col_id


def _ensure_session(session_id: str, collection_id: str) -> None:
    """Create a chat session record if one doesn't exist yet."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id FROM chat_sessions WHERE id = %s::uuid",
                (session_id,),
            )
            if not cur.fetchone():
                cur.execute(
                    """
                    INSERT INTO chat_sessions (id, collection_id)
                    VALUES (%s::uuid, %s::uuid)
                    ON CONFLICT DO NOTHING
                    """,
                    (session_id, collection_id),
                )
        conn.commit()


def _save_message(session_id: str, role: str, content: str, chunk_ids: list[str] | None = None) -> None:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO chat_messages (session_id, role, content, retrieved_chunk_ids)
                VALUES (%s::uuid, %s, %s, %s)
                """,
                (session_id, role, content, chunk_ids or []),
            )
        conn.commit()


@router.post("/chat/stream")
async def chat_stream(request: Request):
    body = await request.json()
    session_id: str = body.get("session_id") or str(uuid.uuid4())
    message: str = (body.get("message") or "").strip()
    history: list[dict] = body.get("history") or []
    # collection_id from client (optional) — None means search all collections
    collection_id: str | None = body.get("collection_id") or None

    if not message:
        raise HTTPException(status_code=400, detail="'message' is required.")

    # For DB session storage, fall back to default collection if none specified
    default_col = _default_collection_id()
    session_collection = collection_id or default_col

    # Ensure chat session exists in DB
    try:
        _ensure_session(session_id, session_collection)
        _save_message(session_id, "user", message)
    except Exception as exc:
        logger.warning("Could not persist chat session/message: %s", exc)

    # Accumulate assistant reply for persistence
    assistant_tokens: list[str] = []

    async def event_generator():
        async for line in stream_rag_response(message, history, collection_id):
            yield line
            # Track tokens for persistence
            try:
                evt = json.loads(line)
                if evt.get("type") == "token":
                    assistant_tokens.append(evt.get("content", ""))
                elif evt.get("type") == "done":
                    try:
                        _save_message(session_id, "assistant", "".join(assistant_tokens))
                    except Exception as exc:
                        logger.warning("Could not persist assistant message: %s", exc)
            except Exception:
                pass

    return StreamingResponse(
        event_generator(),
        media_type="text/plain",
        headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"},
    )
