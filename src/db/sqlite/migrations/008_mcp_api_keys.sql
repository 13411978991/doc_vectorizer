-- 008_mcp_api_keys.sql — DB-backed API keys for the MCP HTTP transport.
--
-- Why this table exists: csv-only API key auth (`MCP_API_KEYS`) is fine for
-- local dev but breaks down for multi-team deployments — no rotation, no
-- revocation, no per-team scoping, no audit trail. Storing the key in the
-- DB let ops create + revoke + label keys individually.
--
-- Security notes:
--   * Plaintext key never touches the table. We store SHA-256 hex of the
--     raw key as the `hash` column; authenticating is a constant-time
--     compare against this hash.
--   * `label` is human-managed (e.g. "Production CI", "Acme audit team"),
--     surfaced in the identity string and audit log instead of `key:****…`
--   * `fingerprint` is derived from the first 8 chars of the plaintext
--     key (NOT the label) so it doesn't reveal the hash yet lets ops
--     distinguish keys at a glance ("fingerprint: abcd1234…").
--   * `revoked_at` is the soft-delete marker; a revoked row stays in
--     place so audit trail for past usage remains queryable.
--   * `last_used_at` / `last_used_ip` are updated on the (in-memory)
--     cache-miss path; revoking also clears the in-memory cache.

create table if not exists mcp_api_keys (
  id text primary key,
  tenant_id text not null default 'default',
  label text not null,
  fingerprint text not null,
  hash text not null,
  scopes_json text not null default '[]',
  enabled integer not null default 1,
  rate_limit_rpm integer,
  created_at text not null default current_timestamp,
  created_by text not null default 'system',
  revoked_at text,
  last_used_at text,
  last_used_ip text
);

create unique index if not exists mcp_api_keys_fingerprint_idx
  on mcp_api_keys(fingerprint);

create index if not exists mcp_api_keys_tenant_idx
  on mcp_api_keys(tenant_id);

create index if not exists mcp_api_keys_enabled_idx
  on mcp_api_keys(enabled, revoked_at);
