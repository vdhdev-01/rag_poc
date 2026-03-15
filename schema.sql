-- ============================================================
-- RAG POC — PostgreSQL Schema
-- Requires: pgvector extension
-- Embedding dimensions: 384 (sentence-transformers all-MiniLM-L6-v2)
--   Change vector(384) to vector(1536) if using OpenAI text-embedding-3-small
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS citext;

-- ============================================================
-- ENUM TYPES
-- ============================================================

DO $$ BEGIN
    CREATE TYPE datasource_status AS ENUM ('pending','processing','ready','failed','replaced');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE chunk_status AS ENUM ('pending','embedded','failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE user_role AS ENUM ('admin','manager','member','viewer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- TABLE: organizations
-- ============================================================

CREATE TABLE IF NOT EXISTS organizations (
    id                  UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
    guid                UUID            NOT NULL UNIQUE DEFAULT uuid_generate_v4(),
    name                TEXT            NOT NULL,
    slug                TEXT            NOT NULL UNIQUE,
    description         TEXT,
    website_url         TEXT,
    logo_url            TEXT,
    is_active           BOOLEAN         NOT NULL DEFAULT TRUE,
    metadata            JSONB           NOT NULL DEFAULT '{}',
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    deleted_at          TIMESTAMPTZ,
    CONSTRAINT chk_org_slug_format CHECK (slug ~ '^[a-z0-9\-]+$')
);

-- ============================================================
-- TABLE: users
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
    id                      UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
    guid                    UUID            NOT NULL UNIQUE DEFAULT uuid_generate_v4(),
    email                   CITEXT          NOT NULL UNIQUE,
    password_hash           TEXT            NOT NULL,
    email_verified          BOOLEAN         NOT NULL DEFAULT FALSE,
    email_verify_token      TEXT,
    email_verify_expires_at TIMESTAMPTZ,
    reset_token             TEXT,
    reset_token_expires_at  TIMESTAMPTZ,
    refresh_token_hash      TEXT,
    last_login_at           TIMESTAMPTZ,
    failed_login_attempts   SMALLINT        NOT NULL DEFAULT 0,
    locked_until            TIMESTAMPTZ,
    role                    user_role       NOT NULL DEFAULT 'member',
    is_active               BOOLEAN         NOT NULL DEFAULT TRUE,
    created_at              TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    deleted_at              TIMESTAMPTZ,
    CONSTRAINT chk_email_format CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);

-- ============================================================
-- TABLE: managers
-- ============================================================

CREATE TABLE IF NOT EXISTS managers (
    id                  UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id             UUID            NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id     UUID            NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    org_role            user_role       NOT NULL DEFAULT 'manager',
    title               TEXT,
    department          TEXT,
    notes               TEXT,
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_manager_user_org UNIQUE (user_id, organization_id)
);

-- ============================================================
-- TABLE: collections
-- ============================================================

CREATE TABLE IF NOT EXISTS collections (
    id                  UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
    guid                UUID            NOT NULL UNIQUE DEFAULT uuid_generate_v4(),
    organization_id     UUID            NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name                TEXT            NOT NULL,
    slug                TEXT            NOT NULL,
    description         TEXT,
    is_active           BOOLEAN         NOT NULL DEFAULT TRUE,
    metadata            JSONB           NOT NULL DEFAULT '{}',
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    deleted_at          TIMESTAMPTZ,
    CONSTRAINT uq_collection_slug_per_org UNIQUE (organization_id, slug),
    CONSTRAINT chk_collection_slug_format CHECK (slug ~ '^[a-z0-9\-]+$')
);

-- ============================================================
-- TABLE: datasources
-- ============================================================

CREATE TABLE IF NOT EXISTS datasources (
    id                  UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
    guid                UUID            NOT NULL UNIQUE DEFAULT uuid_generate_v4(),
    organization_id     UUID            NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    collection_id       UUID            NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    uploaded_by_user_id UUID            REFERENCES users(id) ON DELETE SET NULL,
    name                TEXT            NOT NULL,
    original_filename   TEXT            NOT NULL,
    file_extension      VARCHAR(20),
    mime_type           VARCHAR(120),
    file_size_bytes     BIGINT,
    storage_path        TEXT,
    status              datasource_status NOT NULL DEFAULT 'pending',
    replaced_by_id      UUID            REFERENCES datasources(id) ON DELETE SET NULL,
    metadata            JSONB           NOT NULL DEFAULT '{}',
    chunk_size          INT             NOT NULL DEFAULT 1000,
    chunk_overlap       INT             NOT NULL DEFAULT 100,
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    deleted_at          TIMESTAMPTZ,
    CONSTRAINT chk_chunk_overlap CHECK (chunk_overlap < chunk_size),
    CONSTRAINT chk_file_size     CHECK (file_size_bytes IS NULL OR file_size_bytes > 0)
);

-- ============================================================
-- TABLE: document_chunks
-- ============================================================

CREATE TABLE IF NOT EXISTS document_chunks (
    id                  UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
    datasource_id       UUID            NOT NULL REFERENCES datasources(id) ON DELETE CASCADE,
    datasource_guid     UUID            NOT NULL,
    collection_id       UUID            NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    organization_id     UUID            NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    chunk_index         INT             NOT NULL,
    content             TEXT            NOT NULL,
    token_count         INT,
    -- Adjust vector dimensions to match your embedding model:
    --   384  → sentence-transformers all-MiniLM-L6-v2  (default)
    --   1536 → OpenAI text-embedding-3-small / ada-002
    embedding           vector(384),
    status              chunk_status    NOT NULL DEFAULT 'pending',
    error_message       TEXT,
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_chunk_index     CHECK (chunk_index >= 0),
    CONSTRAINT uq_datasource_chunk UNIQUE (datasource_id, chunk_index)
);

-- ============================================================
-- TABLE: chat_sessions
-- ============================================================

CREATE TABLE IF NOT EXISTS chat_sessions (
    id                  UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
    organization_id     UUID            REFERENCES organizations(id) ON DELETE SET NULL,
    collection_id       UUID            REFERENCES collections(id) ON DELETE SET NULL,
    user_id             UUID            REFERENCES users(id) ON DELETE SET NULL,
    title               TEXT,
    metadata            JSONB           NOT NULL DEFAULT '{}',
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- ============================================================
-- TABLE: chat_messages
-- ============================================================

CREATE TABLE IF NOT EXISTS chat_messages (
    id                  UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id          UUID            NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    role                VARCHAR(20)     NOT NULL CHECK (role IN ('user','assistant','system')),
    content             TEXT            NOT NULL,
    retrieved_chunk_ids UUID[]          DEFAULT '{}',
    prompt_tokens       INT,
    completion_tokens   INT,
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_organizations_slug       ON organizations(slug);
CREATE INDEX IF NOT EXISTS idx_organizations_is_active  ON organizations(is_active) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_organizations_deleted_at ON organizations(deleted_at) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_users_email       ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_guid        ON users(guid);
CREATE INDEX IF NOT EXISTS idx_users_role        ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_is_active   ON users(is_active) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_users_reset_token ON users(reset_token) WHERE reset_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_managers_user_id ON managers(user_id);
CREATE INDEX IF NOT EXISTS idx_managers_org_id  ON managers(organization_id);

CREATE INDEX IF NOT EXISTS idx_collections_org_id     ON collections(organization_id);
CREATE INDEX IF NOT EXISTS idx_collections_slug       ON collections(slug);
CREATE INDEX IF NOT EXISTS idx_collections_deleted_at ON collections(deleted_at) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_datasources_guid       ON datasources(guid);
CREATE INDEX IF NOT EXISTS idx_datasources_org_id     ON datasources(organization_id);
CREATE INDEX IF NOT EXISTS idx_datasources_collection ON datasources(collection_id);
CREATE INDEX IF NOT EXISTS idx_datasources_status     ON datasources(status);
CREATE INDEX IF NOT EXISTS idx_datasources_created_at ON datasources(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_datasources_deleted_at ON datasources(deleted_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_datasources_metadata   ON datasources USING GIN(metadata);

CREATE INDEX IF NOT EXISTS idx_doc_chunks_datasource_id   ON document_chunks(datasource_id);
CREATE INDEX IF NOT EXISTS idx_doc_chunks_datasource_guid ON document_chunks(datasource_guid);
CREATE INDEX IF NOT EXISTS idx_doc_chunks_collection_id   ON document_chunks(collection_id);
CREATE INDEX IF NOT EXISTS idx_doc_chunks_org_id          ON document_chunks(organization_id);
CREATE INDEX IF NOT EXISTS idx_doc_chunks_status          ON document_chunks(status);

-- HNSW index — efficient for small-to-medium datasets, no training data required
CREATE INDEX IF NOT EXISTS idx_doc_chunks_embedding ON document_chunks
    USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_id    ON chat_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_org_id     ON chat_sessions(organization_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_collection ON chat_sessions(collection_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session    ON chat_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at ON chat_messages(created_at ASC);

-- ============================================================
-- AUTO-UPDATE updated_at
-- ============================================================

CREATE OR REPLACE FUNCTION fn_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

DO $$ BEGIN
    CREATE TRIGGER trg_organizations_updated_at
        BEFORE UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TRIGGER trg_users_updated_at
        BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TRIGGER trg_managers_updated_at
        BEFORE UPDATE ON managers FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TRIGGER trg_collections_updated_at
        BEFORE UPDATE ON collections FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TRIGGER trg_datasources_updated_at
        BEFORE UPDATE ON datasources FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TRIGGER trg_doc_chunks_updated_at
        BEFORE UPDATE ON document_chunks FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TRIGGER trg_chat_sessions_updated_at
        BEFORE UPDATE ON chat_sessions FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- VIEWS
-- ============================================================

CREATE OR REPLACE VIEW vw_datasource_summary AS
SELECT
    ds.id,
    ds.guid,
    ds.name,
    ds.original_filename,
    ds.mime_type,
    ds.file_size_bytes,
    ds.status,
    ds.chunk_size,
    ds.chunk_overlap,
    ds.metadata,
    ds.created_at,
    ds.updated_at,
    c.id            AS collection_id,
    c.name          AS collection_name,
    c.slug          AS collection_slug,
    o.id            AS organization_id,
    o.name          AS organization_name,
    o.slug          AS organization_slug,
    u.email         AS uploaded_by_email,
    COUNT(dc.id)                                        AS total_chunks,
    COUNT(dc.id) FILTER (WHERE dc.status = 'embedded') AS embedded_chunks,
    COUNT(dc.id) FILTER (WHERE dc.status = 'failed')   AS failed_chunks
FROM      datasources   ds
JOIN      collections   c  ON c.id  = ds.collection_id
JOIN      organizations o  ON o.id  = ds.organization_id
LEFT JOIN users         u  ON u.id  = ds.uploaded_by_user_id
LEFT JOIN document_chunks dc ON dc.datasource_id = ds.id
WHERE ds.deleted_at IS NULL
GROUP BY ds.id, c.id, o.id, u.id;

CREATE OR REPLACE VIEW vw_manager_roster AS
SELECT
    m.id            AS manager_id,
    m.org_role,
    m.title,
    m.department,
    m.created_at    AS manager_since,
    u.id            AS user_id,
    u.email,
    u.role          AS user_role,
    u.last_login_at,
    u.is_active     AS user_is_active,
    o.id            AS organization_id,
    o.name          AS organization_name,
    o.slug          AS organization_slug
FROM      managers      m
JOIN      users         u  ON u.id = m.user_id
JOIN      organizations o  ON o.id = m.organization_id
WHERE     u.deleted_at  IS NULL
  AND     o.deleted_at  IS NULL;

-- ============================================================
-- RAG SIMILARITY SEARCH FUNCTION
-- ============================================================

CREATE OR REPLACE FUNCTION fn_similarity_search(
    query_embedding  vector(384),
    p_collection_id  UUID,
    match_count      INT     DEFAULT 5,
    min_similarity   FLOAT   DEFAULT 0.3
)
RETURNS TABLE (
    chunk_id         UUID,
    datasource_id    UUID,
    datasource_guid  UUID,
    datasource_name  TEXT,
    collection_name  TEXT,
    chunk_index      INT,
    content          TEXT,
    similarity       FLOAT
)
LANGUAGE plpgsql AS $$
BEGIN
    RETURN QUERY
    SELECT
        dc.id,
        dc.datasource_id,
        dc.datasource_guid,
        ds.name,
        col.name,
        dc.chunk_index,
        dc.content,
        (1 - (dc.embedding <=> query_embedding))::FLOAT AS similarity
    FROM  document_chunks  dc
    JOIN  datasources      ds  ON ds.id  = dc.datasource_id
    JOIN  collections      col ON col.id = dc.collection_id
    WHERE dc.status            = 'embedded'
      AND dc.collection_id     = p_collection_id
      AND ds.deleted_at        IS NULL
      AND ds.status            = 'ready'
      AND (1 - (dc.embedding <=> query_embedding)) >= min_similarity
    ORDER BY dc.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

-- ============================================================
-- HELPER: collections accessible by a user
-- ============================================================

CREATE OR REPLACE FUNCTION fn_user_accessible_collections(p_user_id UUID)
RETURNS TABLE (
    collection_id     UUID,
    collection_name   TEXT,
    collection_slug   TEXT,
    organization_id   UUID,
    organization_name TEXT,
    org_role          user_role
)
LANGUAGE plpgsql AS $$
BEGIN
    RETURN QUERY
    SELECT
        col.id,
        col.name,
        col.slug,
        o.id,
        o.name,
        m.org_role
    FROM   managers      m
    JOIN   organizations o   ON o.id  = m.organization_id
    JOIN   collections   col ON col.organization_id = o.id
    WHERE  m.user_id     = p_user_id
      AND  col.deleted_at IS NULL
      AND  col.is_active  = TRUE
      AND  o.deleted_at   IS NULL
      AND  o.is_active    = TRUE;
END;
$$;
