-- Add MCP (Model Context Protocol) session tables.
--
-- These tables exist in the PG schema but were omitted from the initial
-- SQLite migration. The application queries them when listing MCP sessions
-- for a project (listMcpSessions) and stores chat history / tool calls here.
--
-- Schema choices:
--   - source_ids: stored as JSON text (PG had uuid[]). The list query no
--     longer uses the `&&` overlap operator; it filters in JS instead
--     (see repositories.ts: listMcpSessions).
--   - arguments/result/metadata: stored as JSON text (PG had jsonb).
--   - timestamps: stored as text (current_timestamp).
--   - status on mcp_sessions: added so the McpSessionRecord mapper can
--     read it; default 'active'.

create table if not exists mcp_sessions (
  id text primary key,
  tenant_id text not null default 'default',
  title text not null,
  status text not null default 'active',
  model text,
  source_ids text not null default '[]',
  metadata text not null default '{}',
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp
);
create index if not exists mcp_sessions_tenant_idx on mcp_sessions(tenant_id);
create index if not exists mcp_sessions_updated_idx on mcp_sessions(updated_at desc);

create table if not exists mcp_messages (
  id text primary key,
  session_id text not null references mcp_sessions(id) on delete cascade,
  role text not null,
  content text not null,
  metadata text not null default '{}',
  created_at text not null default current_timestamp
);
create index if not exists mcp_messages_session_idx on mcp_messages(session_id);

create table if not exists mcp_tool_calls (
  id text primary key,
  session_id text not null references mcp_sessions(id) on delete cascade,
  message_id text references mcp_messages(id) on delete set null,
  tool_name text not null,
  arguments text not null default 'null',
  result text,
  status text not null,
  duration_ms integer,
  error text,
  created_at text not null default current_timestamp
);
create index if not exists mcp_tool_calls_session_idx on mcp_tool_calls(session_id);