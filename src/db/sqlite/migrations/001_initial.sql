-- 001_initial.sql — SQLite schema for SAG
--
-- Mirrors the essential subset of the PostgreSQL migrations. Only the tables
-- actually used at runtime are included; the rest of the PG schema is parked
-- until we need it.

-- ─── Watcher (Phase 1) ────────────────────────────────────────────────────

create table if not exists watched_folders (
  id text primary key,
  tenant_id text not null default 'default',
  display_name text not null,
  path text not null,
  enabled integer not null default 1,
  recursive integer not null default 1,
  file_extensions_filter text,
  ignore_patterns text,
  metadata text not null default '{}',
  source_id text,
  last_scan_at text,
  last_scan_status text,
  last_scan_error text,
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp
);

create index if not exists watched_folders_tenant_idx on watched_folders(tenant_id);

create table if not exists watched_folder_manifests (
  folder_id text not null references watched_folders(id) on delete cascade,
  rel_path text not null,
  document_id text,
  last_seen_at text not null default current_timestamp,
  last_event text not null,
  size integer,
  hash text,
  primary key (folder_id, rel_path)
);

create table if not exists watched_folder_runs (
  id text primary key,
  folder_id text not null references watched_folders(id) on delete cascade,
  tenant_id text not null default 'default',
  trigger text not null,
  status text not null,
  started_at text not null default current_timestamp,
  completed_at text,
  stats_added integer default 0,
  stats_updated integer default 0,
  stats_deleted integer default 0,
  stats_failed integer default 0,
  error text
);

-- ─── Documents / chunks / entities (ingestion) ─────────────────────────────

create table if not exists sources (
  id text primary key,
  tenant_id text not null default 'default',
  kind text not null,
  name text not null,
  description text,
  folder_id text references watched_folders(id) on delete set null,
  metadata text not null default '{}',
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp
);

create table if not exists documents (
  id text primary key,
  source_id text not null references sources(id) on delete cascade,
  title text not null,
  file_name text,
  content text not null,
  parse_status text not null default 'pending',
  metadata text not null default '{}',
  archived_at text,
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp
);

create index if not exists documents_source_idx on documents(source_id);

create table if not exists chunks (
  id text primary key,
  document_id text not null references documents(id) on delete cascade,
  source_id text not null,
  rank integer not null,
  heading text,
  content text not null,
  raw_content text,
  token_count integer,
  metadata text not null default '{}'
);

create index if not exists chunks_document_idx on chunks(document_id);

-- Embedding table (vector stored as JSON blob; sqlite-vec optional).
create table if not exists chunk_embeddings (
  chunk_id text primary key references chunks(id) on delete cascade,
  model text not null,
  embedding_json text not null,
  embedding blob,
  created_at text not null default current_timestamp
);

create table if not exists entities (
  id text primary key,
  source_id text not null,
  document_id text references documents(id) on delete cascade,
  entity_type_id text references entity_types(id) on delete set null,
  name text not null,
  normalized_name text not null default '',
  type text not null,
  metadata text not null default '{}'
);

create index if not exists entities_source_idx on entities(source_id);
create index if not exists entities_entity_type_idx on entities(entity_type_id);

-- ─── Compatibility views for PG-specific queries ───────────────────────────

-- entity_types — small PG-only lookup table previously; we add a stub here
-- so repositories.ts can query it without errors. SQLite doesn't enforce
-- the discriminator semantics; we only seed a small starter set.
-- entity_types — global catalog of entity types seeded by seed.ts.
-- Used by ingestion to classify entities and by KB aggregations for
-- `aggregateAndCacheKbProjectCounts`. `source_id` is nullable so global
-- scope rows can exist without a source; per-source overrides can
-- reference a source row via FK.
create table if not exists entity_types (
  id text primary key,
  source_id text references sources(id) on delete set null,
  scope text not null default 'global',
  type text not null,
  name text not null,
  description text,
  weight real not null default 1.0,
  similarity_threshold real not null default 0.8,
  is_default integer not null default 0,
  is_active integer not null default 1,
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp
);

create index if not exists entity_types_scope_idx on entity_types(scope);


-- source_chunks is a table in the SQLite schema so that test seeds (and
-- ingestion in the future) can INSERT into it directly. PG schema uses a
-- view; we keep a real table here and mirror the chunks row into it from
-- ingestion-service so the kb-projects aggregations stay identical.
create table if not exists source_chunks (
  id text primary key,
  document_id text not null references documents(id) on delete cascade,
  source_id text not null,
  source_type text not null default 'document',
  heading text,
  content text not null,
  raw_content text,
  token_count integer,
  metadata text not null default '{}',
  rank integer not null default 0
);
create index if not exists source_chunks_source_idx on source_chunks(source_id);
create index if not exists source_chunks_document_idx on source_chunks(document_id);

-- ─── Audit (Phase 2) ───────────────────────────────────────────────────────

create table if not exists audit_projects (
  id text primary key,
  tenant_id text not null default 'default',
  name text not null,
  description text,
  objective text,
  scope text,
  status text not null default 'active',
  source_id text references sources(id) on delete set null,
  watched_folder_id text references watched_folders(id) on delete set null,
  template_id text,
  metadata text not null default '{}',
  created_by text not null default 'user',
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp
);

create table if not exists audit_procedures (
  id text primary key,
  project_id text not null references audit_projects(id) on delete cascade,
  name text not null,
  objective text,
  scope text,
  steps text not null default '[]',
  status text not null default 'draft',
  position integer not null default 0,
  source_procedure_id text,
  metadata text not null default '{}',
  created_by text not null default 'user',
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp
);

create index if not exists audit_procedures_project_idx on audit_procedures(project_id);

create table if not exists audit_analyses (
  id text primary key,
  procedure_id text not null references audit_procedures(id) on delete cascade,
  status text not null default 'pending',
  started_at text not null default current_timestamp,
  completed_at text,
  findings_json text,
  summary text,
  metadata text not null default '{}'
);

create index if not exists audit_analyses_procedure_idx on audit_analyses(procedure_id);

-- ─── Audit templates (Phase 1 KB templates) ────────────────────────────────

create table if not exists audit_templates (
  id text primary key,
  tenant_id text not null default 'default',
  name text not null,
  description text,
  category text not null default 'general',
  steps text not null default '[]',
  tags_json text not null default '[]',
  created_by text not null default 'user',
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp
);

-- ─── KB projects (legacy, kept for back-compat) ───────────────────────────

create table if not exists kb_projects (
  id text primary key,
  tenant_id text not null default 'default',
  name text not null,
  description text,
  metadata text not null default '{}',
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp,
  cached_documents_count integer not null default 0,
  cached_chunks_count integer not null default 0,
  cached_entities_count integer not null default 0,
  cached_updated_at text,
  cached_upload_documents_count integer not null default 0,
  cached_upload_chunks_count integer not null default 0,
  cached_upload_entities_count integer not null default 0
);

create table if not exists kb_sources (
  id text primary key,
  kb_project_id text not null references kb_projects(id) on delete cascade,
  source_type text not null,
  name text,
  watched_folder_id text references watched_folders(id) on delete cascade,
  upload_id text,
  enabled integer not null default 1,
  status text not null default 'pending',
  last_sync_at text,
  metadata text not null default '{}',
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp,
  file_name text,
  file_size integer,
  file_extension text
);

create index if not exists kb_sources_project_idx on kb_sources(kb_project_id);

-- ─── Audit log ─────────────────────────────────────────────────────────────

create table if not exists audit_logs (
  id text primary key,
  tenant_id text not null default 'default',
  entity_type text not null,
  entity_id text not null,
  action text not null,
  actor text not null default 'system',
  payload_json text,
  created_at text not null default current_timestamp
);

create index if not exists audit_logs_entity_idx on audit_logs(entity_type, entity_id);

-- ─── Audit skills (Sprint 6 Wave 3) ────────────────────────────────────────

create table if not exists audit_skills (
  id text primary key,
  tenant_id text not null default 'default',
  source_project_id text,
  source_procedure_id text,
  name text not null,
  category text not null default 'general',
  description text,
  trigger_json text not null default '{}',
  actions_json text not null default '{}',
  signals_to_watch_json text not null default '{}',
  caveats_json text not null default '{}',
  tags_json text not null default '[]',
  status text not null default 'draft',
  quality_score real not null default 0.5,
  usage_count integer not null default 0,
  last_used_at text,
  created_by text not null default 'system',
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp
);

create table if not exists audit_skill_usage (
  id text primary key,
  skill_id text not null references audit_skills(id) on delete cascade,
  used_in_kind text not null,
  used_in_id text not null,
  outcome text not null,
  score real,
  notes text,
  created_at text not null default current_timestamp
);

-- draft_content: keep raw skill body so the catalog UI can preview/edit
-- without re-deriving it from trigger+actions+signals+caveats.
alter table audit_skills add column draft_content text;

create index if not exists audit_skill_usage_skill_idx on audit_skill_usage(skill_id);


-- audit_indexes — case-study indexes linked to analyses. The full PG
-- schema modelled a separate table for indexing; SQLite inherits a
-- simplified mirror so audit-mcp, listIndexes, and createIndex work.
create table if not exists audit_indexes (
  id text primary key,
  analysis_id text not null references audit_analyses(id) on delete cascade,
  title text not null,
  content text not null,
  chunks_json text not null default '[]',
  tools_used_json text not null default '[]',
  position integer not null default 0,
  metadata text not null default '{}',
  created_at text not null default current_timestamp
);
create index if not exists audit_indexes_analysis_idx on audit_indexes(analysis_id);

-- audit_reports — generated report artifacts (markdown/html/pdf). PG
-- schema had a separate table; SQLite preserves it so createReport /
-- listReports / getLatestReport can keep their original SQL shape and
-- cascade deletes from audit_projects work cleanly via the project_id
-- FK (which itself doesn't enforce FK since we use audit_logs entity_id,
-- but a real report row is still useful for the report list view).
create table if not exists audit_reports (
  id text primary key,
  project_id text not null,
  format text not null default 'md',
  content text not null,
  metadata text not null default '{}',
  generated_at text not null default current_timestamp
);
create index if not exists audit_reports_project_idx on audit_reports(project_id);

-- events — extracted facts/observations from documents. Mirrors PG schema
-- subset (source_id, document_id, source_type, title, category, status,
-- content, rank, deleted_at) needed by getProjectStats / getProjectGraph.
create table if not exists events (
  id text primary key,
  source_id text not null references sources(id) on delete cascade,
  document_id text references documents(id) on delete set null,
  source_type text not null default 'document',
  title text not null,
  content text not null default '',
  category text not null default 'fact',
  status text not null default 'CONFIRMED',
  rank integer not null default 0,
  deleted_at text,
  created_at text not null default current_timestamp
);
create index if not exists events_source_idx on events(source_id);
create index if not exists events_document_idx on events(document_id);

-- event_entities — many-to-many between events and entities.
create table if not exists event_entities (
  id text primary key,
  event_id text not null references events(id) on delete cascade,
  entity_id text not null references entities(id) on delete cascade
);
create index if not exists event_entities_event_idx on event_entities(event_id);
create index if not exists event_entities_entity_idx on event_entities(entity_id);

-- ─── Shared folder (audit task redesign) ──────────────────────────────────

create table if not exists shared_folder_config (
  tenant_id text primary key default 'default',
  shared_root_path text not null,
  enabled integer not null default 1,
  scan_interval_seconds integer not null default 300,
  last_scan_at text,
  last_scan_status text,
  updated_at text not null default current_timestamp
);

create table if not exists audit_programs (
  id text primary key,
  tenant_id text not null default 'default',
  name text not null,
  description text,
  program_path text not null,
  shared_root_path text not null,
  status text not null default 'draft',
  steps text not null default '[]',
  project_id text,
  metadata text not null default '{}',
  discovered_at text not null default current_timestamp,
  updated_at text not null default current_timestamp
);

create table if not exists audit_tasks (
  id text primary key,
  program_id text not null references audit_programs(id) on delete cascade,
  tenant_id text not null default 'default',
  program_name text not null,
  task_path text not null,
  program_path text not null,
  shared_root_path text not null,
  status text not null default 'running',
  started_at text not null default current_timestamp,
  completed_at text,
  summary text,
  flow_svg_path text,
  report_html_path text,
  event_count integer not null default 0,
  assignee text,
  metadata text not null default '{}',
  updated_at text not null default current_timestamp
);