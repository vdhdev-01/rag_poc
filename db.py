import json
from pathlib import Path

import psycopg2


_CONFIG_PATH = Path(__file__).with_name("config.json")


def _load_db_config():
    with _CONFIG_PATH.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    return data["postgres"]


def get_connection():
    config = _load_db_config()
    return psycopg2.connect(
        host=config["host"],
        port=config["port"],
        user=config["user"],
        password=config["password"],
        dbname=config["database"],
    )


if __name__ == "__main__":
    # Basic connectivity check when running directly.
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT 1;")
            print(cur.fetchone())
