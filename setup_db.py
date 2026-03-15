"""
setup_db.py — One-time database initialisation script.

Steps:
  1. Create the 'poc' database (connects to 'postgres' first)
  2. Apply schema.sql
  3. Create a default organisation and collection
  4. Write their UUIDs back to config.json

Run:
  .venv\\Scripts\\python setup_db.py
"""
import json
import sys
from pathlib import Path

import psycopg2
from psycopg2.extensions import ISOLATION_LEVEL_AUTOCOMMIT

CONFIG_PATH = Path(__file__).with_name("config.json")
SCHEMA_PATH = Path(__file__).with_name("schema.sql")


def load_config() -> dict:
    with CONFIG_PATH.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def save_config(cfg: dict) -> None:
    with CONFIG_PATH.open("w", encoding="utf-8") as fh:
        json.dump(cfg, fh, indent=2)
    print("  [OK] config.json updated")


def pg_connect(cfg: dict, dbname: str) -> psycopg2.extensions.connection:
    return psycopg2.connect(
        host=cfg["host"],
        port=cfg["port"],
        user=cfg["user"],
        password=cfg["password"],
        dbname=dbname,
        connect_timeout=10,
    )


# ── Step 1: Create database ───────────────────────────────────────────────────

def create_database(cfg: dict) -> None:
    target = cfg["database"]
    print(f"\n[1/3] Ensuring database '{target}' exists …")
    try:
        conn = pg_connect(cfg, "postgres")
    except psycopg2.OperationalError as exc:
        print(f"\n  ✗ Cannot connect to Postgres: {exc}")
        print("  Check that the server is reachable and credentials are correct.")
        sys.exit(1)

    conn.set_isolation_level(ISOLATION_LEVEL_AUTOCOMMIT)
    cur = conn.cursor()
    cur.execute("SELECT 1 FROM pg_database WHERE datname = %s", (target,))
    if cur.fetchone():
        print(f"  [OK] Database '{target}' already exists.")
    else:
        cur.execute(f'CREATE DATABASE "{target}"')
        print(f"  [OK] Database '{target}' created.")
    cur.close()
    conn.close()


# ── Step 2: Apply schema ──────────────────────────────────────────────────────

def apply_schema(cfg: dict) -> None:
    print("\n[2/3] Applying schema.sql …")
    sql = SCHEMA_PATH.read_text(encoding="utf-8")
    conn = pg_connect(cfg, cfg["database"])
    try:
        with conn.cursor() as cur:
            cur.execute(sql)
        conn.commit()
        print("  [OK] Schema applied successfully.")
    except Exception as exc:
        conn.rollback()
        print(f"  ✗ Schema error: {exc}")
        raise
    finally:
        conn.close()


# ── Step 3: Seed default org + collection ─────────────────────────────────────

DEFAULT_ORG_NAME = "Default Organisation"
DEFAULT_ORG_SLUG = "default"
DEFAULT_COL_NAME = "Default Collection"
DEFAULT_COL_SLUG = "default"


def seed_defaults(cfg: dict) -> tuple[str, str]:
    print("\n[3/3] Seeding default organisation and collection …")
    conn = pg_connect(cfg, cfg["database"])
    try:
        with conn.cursor() as cur:
            # Organisation
            cur.execute(
                """
                INSERT INTO organizations (name, slug)
                VALUES (%s, %s)
                ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
                RETURNING id
                """,
                (DEFAULT_ORG_NAME, DEFAULT_ORG_SLUG),
            )
            org_id = str(cur.fetchone()[0])
            print(f"  [OK] Organisation  id = {org_id}")

            # Collection
            cur.execute(
                """
                INSERT INTO collections (organization_id, name, slug)
                VALUES (%s::uuid, %s, %s)
                ON CONFLICT (organization_id, slug) DO UPDATE SET name = EXCLUDED.name
                RETURNING id
                """,
                (org_id, DEFAULT_COL_NAME, DEFAULT_COL_SLUG),
            )
            col_id = str(cur.fetchone()[0])
            print(f"  [OK] Collection    id = {col_id}")

        conn.commit()
    finally:
        conn.close()

    return org_id, col_id


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    config = load_config()
    pg_cfg = config["postgres"]

    create_database(pg_cfg)
    apply_schema(pg_cfg)
    org_id, col_id = seed_defaults(pg_cfg)

    config["default_org_id"] = org_id
    config["default_collection_id"] = col_id
    save_config(config)

    print("\n[DONE] Database setup complete.")
    print(f"   Host       : {pg_cfg['host']}:{pg_cfg['port']}")
    print(f"   Database   : {pg_cfg['database']}")
    print(f"   Org ID     : {org_id}")
    print(f"   Collection : {col_id}")
    print("\nNext steps:")
    print("  1. Install dependencies : .venv\\Scripts\\pip install -r requirements.txt")
    print("  2. Start the API        : .venv\\Scripts\\uvicorn main:app --reload --port 8000")
    print("  3. Start the frontend   : cd frontend && npm install && npm run dev")


if __name__ == "__main__":
    main()
