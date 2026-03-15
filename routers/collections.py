"""
routers/collections.py

Endpoints:
  GET  /api/collections       — list collections (with datasource count)
  POST /api/collections       — create a new collection
"""
import re
import logging

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from database import get_conn, app_config

logger = logging.getLogger(__name__)
router = APIRouter()


def _default_org_id() -> str:
    cfg = app_config()
    org_id = cfg.get("default_org_id", "")
    if not org_id:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Default org not set. Run setup_db.py first.",
        )
    return org_id


def _slugify(name: str) -> str:
    slug = name.lower().strip()
    slug = re.sub(r"[^a-z0-9\s-]", "", slug)
    slug = re.sub(r"[\s]+", "-", slug)
    slug = re.sub(r"-+", "-", slug).strip("-")
    return slug or "collection"


# ── List ──────────────────────────────────────────────────────────────────────

@router.get("/collections")
def list_collections():
    org_id = _default_org_id()
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT
                    c.id, c.name, c.slug, c.description, c.created_at,
                    COUNT(ds.id) AS datasource_count
                FROM   collections c
                LEFT JOIN datasources ds
                       ON ds.collection_id = c.id
                      AND ds.deleted_at IS NULL
                WHERE  c.deleted_at        IS NULL
                  AND  c.organization_id   = %s::uuid
                GROUP  BY c.id
                ORDER  BY c.created_at ASC
                """,
                (org_id,),
            )
            cols = [d[0] for d in cur.description]
            rows = cur.fetchall()

    result = []
    for row in rows:
        d = dict(zip(cols, row))
        d["id"] = str(d["id"])
        d["created_at"] = d["created_at"].isoformat() if d["created_at"] else None
        d["datasource_count"] = int(d["datasource_count"] or 0)
        result.append(d)
    return result


# ── Create ────────────────────────────────────────────────────────────────────

class CollectionCreate(BaseModel):
    name: str
    description: str | None = None


@router.post("/collections", status_code=status.HTTP_201_CREATED)
def create_collection(body: CollectionCreate):
    org_id = _default_org_id()
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Collection name is required.")

    base_slug = _slugify(name)

    with get_conn() as conn:
        with conn.cursor() as cur:
            # Ensure slug is unique within the org by appending a counter if needed
            slug = base_slug
            counter = 1
            while True:
                cur.execute(
                    "SELECT 1 FROM collections WHERE organization_id = %s::uuid AND slug = %s",
                    (org_id, slug),
                )
                if not cur.fetchone():
                    break
                slug = f"{base_slug}-{counter}"
                counter += 1

            cur.execute(
                """
                INSERT INTO collections (organization_id, name, slug, description)
                VALUES (%s::uuid, %s, %s, %s)
                RETURNING id, name, slug, description, created_at
                """,
                (org_id, name, slug, body.description),
            )
            row = cur.fetchone()
        conn.commit()

    return {
        "id": str(row[0]),
        "name": row[1],
        "slug": row[2],
        "description": row[3],
        "created_at": row[4].isoformat() if row[4] else None,
        "datasource_count": 0,
    }
