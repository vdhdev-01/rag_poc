"""
routers/datasources.py

Endpoints:
  GET    /api/datasources               — list all (vw_datasource_summary)
  POST   /api/datasources/upload        — Uppy multi-file upload
  DELETE /api/datasources/{id}          — soft-delete
  POST   /api/datasources/{id}/replace  — replace file + re-ingest
"""
import logging
import mimetypes
import uuid
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request, status
from fastapi.responses import JSONResponse

from database import get_conn, app_config
from services.ingestion import process_datasource

logger = logging.getLogger(__name__)
router = APIRouter()


def _uploads_dir() -> Path:
    cfg = app_config()
    p = Path(cfg.get("uploads_dir", "uploads"))
    p.mkdir(parents=True, exist_ok=True)
    return p


def _default_ids() -> tuple[str, str]:
    cfg = app_config()
    org_id = cfg.get("default_org_id", "")
    col_id = cfg.get("default_collection_id", "")
    if not org_id or not col_id:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Default org/collection not set. Run setup_db.py first.",
        )
    return org_id, col_id


# ── List ──────────────────────────────────────────────────────────────────────

@router.get("/datasources")
def list_datasources():
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, guid, name, original_filename, mime_type,
                       file_size_bytes, status, chunk_size, chunk_overlap,
                       metadata, created_at, updated_at,
                       total_chunks, embedded_chunks, failed_chunks
                FROM   vw_datasource_summary
                ORDER  BY created_at DESC
                """
            )
            cols = [d[0] for d in cur.description]
            rows = cur.fetchall()

    result = []
    for row in rows:
        d = dict(zip(cols, row))
        # Convert UUID & datetime to JSON-serialisable types
        d["id"] = str(d["id"])
        d["guid"] = str(d["guid"])
        d["created_at"] = d["created_at"].isoformat() if d["created_at"] else None
        d["updated_at"] = d["updated_at"].isoformat() if d["updated_at"] else None
        d["total_chunks"] = int(d["total_chunks"] or 0)
        d["embedded_chunks"] = int(d["embedded_chunks"] or 0)
        d["failed_chunks"] = int(d["failed_chunks"] or 0)
        result.append(d)

    return result


# ── Upload ────────────────────────────────────────────────────────────────────

@router.post("/datasources/upload", status_code=status.HTTP_201_CREATED)
async def upload_datasources(request: Request, background_tasks: BackgroundTasks):
    """
    Accepts multipart/form-data from Uppy (field name: files[]).
    Creates a datasource record per file and queues ingestion.
    """
    org_id, col_id = _default_ids()
    cfg = app_config()
    chunk_size = int(cfg.get("chunk_size", 1000))
    chunk_overlap = int(cfg.get("chunk_overlap", 100))

    form = await request.form()
    files = form.getlist("files[]")
    if not files:
        # Also try without brackets (some Uppy versions)
        files = form.getlist("files")
    if not files:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No files received. Expected field 'files[]'.",
        )

    created = []
    uploads = _uploads_dir()

    for upload in files:
        content = await upload.read()
        original_filename = upload.filename or "unnamed"
        mime_type = upload.content_type or mimetypes.guess_type(original_filename)[0] or "application/octet-stream"
        ext = Path(original_filename).suffix.lstrip(".")
        display_name = Path(original_filename).stem

        # Save file to disk
        saved_path = uploads / f"{uuid.uuid4()}_{original_filename}"
        saved_path.write_bytes(content)

        # Insert datasource record
        ds_id = _create_datasource(
            name=display_name,
            original_filename=original_filename,
            mime_type=mime_type,
            file_extension=ext,
            file_size_bytes=len(content),
            storage_path=str(saved_path),
            organization_id=org_id,
            collection_id=col_id,
            chunk_size=chunk_size,
            chunk_overlap=chunk_overlap,
        )

        # Queue ingestion (non-blocking)
        background_tasks.add_task(
            process_datasource,
            datasource_id=ds_id,
            content=content,
            mime_type=mime_type,
            filename=original_filename,
            collection_id=col_id,
            organization_id=org_id,
            chunk_size=chunk_size,
            overlap=chunk_overlap,
        )

        created.append({"id": ds_id, "name": display_name, "original_filename": original_filename})
        logger.info("Queued ingestion for %s (id=%s)", original_filename, ds_id)

    return created


def _create_datasource(
    name: str,
    original_filename: str,
    mime_type: str,
    file_extension: str,
    file_size_bytes: int,
    storage_path: str,
    organization_id: str,
    collection_id: str,
    chunk_size: int,
    chunk_overlap: int,
) -> str:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO datasources
                    (organization_id, collection_id, name, original_filename,
                     file_extension, mime_type, file_size_bytes, storage_path,
                     chunk_size, chunk_overlap, status)
                VALUES
                    (%s::uuid, %s::uuid, %s, %s, %s, %s, %s, %s, %s, %s, 'pending')
                RETURNING id
                """,
                (
                    organization_id, collection_id,
                    name, original_filename,
                    file_extension, mime_type,
                    file_size_bytes, storage_path,
                    chunk_size, chunk_overlap,
                ),
            )
            ds_id = str(cur.fetchone()[0])
        conn.commit()
    return ds_id


# ── Delete ────────────────────────────────────────────────────────────────────

@router.delete("/datasources/{datasource_id}", status_code=status.HTTP_200_OK)
def delete_datasource(datasource_id: str):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE datasources SET deleted_at = NOW() WHERE id = %s::uuid AND deleted_at IS NULL",
                (datasource_id,),
            )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Datasource not found.")
        conn.commit()
    return {"deleted": datasource_id}


# ── Replace ───────────────────────────────────────────────────────────────────

@router.post("/datasources/{datasource_id}/replace", status_code=status.HTTP_200_OK)
async def replace_datasource(datasource_id: str, request: Request, background_tasks: BackgroundTasks):
    """
    Upload a replacement file for an existing datasource.
    Old chunks are deleted; the record is re-ingested.
    """
    org_id, col_id = _default_ids()
    cfg = app_config()
    chunk_size = int(cfg.get("chunk_size", 1000))
    chunk_overlap = int(cfg.get("chunk_overlap", 100))

    form = await request.form()
    upload = form.get("file")
    if not upload:
        raise HTTPException(status_code=400, detail="No file provided in field 'file'.")

    content = await upload.read()
    original_filename = upload.filename or "unnamed"
    mime_type = upload.content_type or mimetypes.guess_type(original_filename)[0] or "application/octet-stream"

    uploads = _uploads_dir()
    saved_path = uploads / f"{uuid.uuid4()}_{original_filename}"
    saved_path.write_bytes(content)

    with get_conn() as conn:
        with conn.cursor() as cur:
            # Verify the datasource exists
            cur.execute(
                "SELECT id FROM datasources WHERE id = %s::uuid AND deleted_at IS NULL",
                (datasource_id,),
            )
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Datasource not found.")

            # Delete existing chunks
            cur.execute(
                "DELETE FROM document_chunks WHERE datasource_id = %s::uuid",
                (datasource_id,),
            )

            # Update file info and mark as pending
            cur.execute(
                """
                UPDATE datasources
                SET    original_filename = %s,
                       mime_type         = %s,
                       file_size_bytes   = %s,
                       storage_path      = %s,
                       status            = 'pending',
                       updated_at        = NOW()
                WHERE  id = %s::uuid
                """,
                (
                    original_filename, mime_type,
                    len(content), str(saved_path),
                    datasource_id,
                ),
            )
        conn.commit()

    background_tasks.add_task(
        process_datasource,
        datasource_id=datasource_id,
        content=content,
        mime_type=mime_type,
        filename=original_filename,
        collection_id=col_id,
        organization_id=org_id,
        chunk_size=chunk_size,
        overlap=chunk_overlap,
    )

    return {"replaced": datasource_id, "new_filename": original_filename}
