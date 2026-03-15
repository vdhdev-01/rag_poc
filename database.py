"""
database.py — Thread-safe psycopg2 connection pool.
Reads connection parameters from config.json.
"""
import json
from contextlib import contextmanager
from pathlib import Path

import psycopg2
from psycopg2 import pool

_CONFIG_PATH = Path(__file__).with_name("config.json")


def _load_pg_config() -> dict:
    with _CONFIG_PATH.open("r", encoding="utf-8") as fh:
        return json.load(fh)["postgres"]


def _load_app_config() -> dict:
    with _CONFIG_PATH.open("r", encoding="utf-8") as fh:
        return json.load(fh)


# Initialise on first import — fail fast if the DB is unreachable.
_pg = _load_pg_config()
_connection_pool: pool.ThreadedConnectionPool = pool.ThreadedConnectionPool(
    minconn=1,
    maxconn=20,
    host=_pg["host"],
    port=_pg["port"],
    user=_pg["user"],
    password=_pg["password"],
    dbname=_pg["database"],
)


@contextmanager
def get_conn():
    """Yield a psycopg2 connection, return it to the pool on exit."""
    conn = _connection_pool.getconn()
    try:
        yield conn
    except Exception:
        conn.rollback()
        raise
    finally:
        _connection_pool.putconn(conn)


def app_config() -> dict:
    """Return the full application config dict."""
    return _load_app_config()
