/**
 * src/db/__tests__/migrate-vacuum.test.ts
 *
 * Locks the contract: a migration whose SQL ends with a standalone
 * `VACUUM;` runs the DDL inside the wrapping transaction and the
 * VACUUM outside it. SQLite throws "cannot VACUUM from within a
 * transaction" otherwise.
 *
 * This regression test is the seed-of-truth for the fix that
 * unlocked the desktop build on 2026-10-13. The desktop bundle's
 * `release-desktop/win-unpacked/resources/data/sag.db` is a fresh
 * install — every migration runs from 001 upward, including 014
 * which used to fail at its trailing `VACUUM;` because the migrate
 * runner wrapped the whole script in `db.transaction(...)`. The fix
 * detects a trailing VACUUM, runs the DDL inside the tx, then runs
 * the VACUUM after the tx commits.
 *
 * We exercise the runner on an in-memory SQLite so the test is
 * hermetic and doesn't touch the production DB.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";

// Import the helper from the source via the .js specifier that
// vitest's tsx loader resolves to the sibling .ts file. This
// avoids depending on the build-time dist/src/db/migrate.js
// snapshot, which would lag behind the source if we forget to
// re-run tsc.
import { findTrailingVacuumIndex, slicePreVacuumSql } from "../migrate.js";

function splitVacuum(sql: string): { pre: string; hasTrailingVacuum: boolean } {
  const idx = findTrailingVacuumIndex(sql);
  // Use the PRODUCTION slicing function so this test can't drift
  // from the runner again (the 2026-10-14 empty-schema bug shipped
  // because the old test had its own, correct, slicing while the
  // runner's inline ternary returned "" for the -1 case).
  return {
    pre: slicePreVacuumSql(sql, idx),
    hasTrailingVacuum: idx >= 0
  };
}

function applyWithVacuumSplit(db: Database.Database, name: string, sql: string): void {
  const { pre, hasTrailingVacuum } = splitVacuum(sql);
  // Mirror the production runner exactly: the tx ALWAYS runs
  // (even with an empty pre block, so the schema_migrations row
  // is recorded for a VACUUM-only script), then VACUUM post-commit.
  const tx = db.transaction((migrationSql: string, migrationName: string) => {
    db.exec(migrationSql);
    db.prepare("insert into schema_migrations (name) values (?)").run(migrationName);
  });
  tx(pre, name);
  if (hasTrailingVacuum) {
    db.exec("VACUUM");
  }
}

describe("migrate runner — VACUUM split", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      create table schema_migrations (
        name text primary key,
        applied_at text not null default current_timestamp
      );
    `);
  });
  afterEach(() => db.close());

  it("runs a no-VACUUM migration inside the wrapping transaction", () => {
    db.exec("create table t (x integer)");
    applyWithVacuumSplit(db, "001_init.sql", "create table u (y integer);");
    expect(
      db.prepare("select name from schema_migrations where name = '001_init.sql'").get()
    ).toBeDefined();
    // `u` was created inside the tx — its presence in sqlite_master
    // proves the tx committed.
    expect(
      db.prepare("select name from sqlite_master where name = 'u'").get()
    ).toBeDefined();
  });

  it("runs a migration with a trailing VACUUM (014-style) — used to throw, now succeeds", () => {
    db.exec("create table t (x integer)");
    applyWithVacuumSplit(
      db,
      "014_restore_events_fk.sql",
      "create table events (id text primary key);\nVACUUM;\n"
    );
    // Migration is recorded
    expect(
      db.prepare("select name from schema_migrations where name = '014_restore_events_fk.sql'").get()
    ).toBeDefined();
    // Table from the DDL portion exists (so the tx committed
    // even though the VACUUM was deferred to post-commit)
    expect(
      db.prepare("select name from sqlite_master where name = 'events'").get()
    ).toBeDefined();
  });

  it("VACUUM-only migration (no DDL) records the name and still runs", () => {
    applyWithVacuumSplit(db, "999_vacuum.sql", "VACUUM;");
    expect(
      db.prepare("select name from schema_migrations where name = '999_vacuum.sql'").get()
    ).toBeDefined();
  });

  it("regex matches `VACUUM` (uppercase) — the case 014 uses", () => {
    const { hasTrailingVacuum } = splitVacuum(
      "alter table events rename to events_old;\nVACUUM;\n"
    );
    expect(hasTrailingVacuum).toBe(true);
  });

  it("regex does NOT match mid-script VACUUM (only the trailing one)", () => {
    // A migration whose only VACUUM is mid-script is treated as
    // "no trailing VACUUM" — the runner runs the whole thing
    // inside the tx, which would still throw on SQLite. But none
    // of our migrations use that pattern; 014 puts VACUUM last.
    const { hasTrailingVacuum } = splitVacuum(
      "create table a (x integer);\nVACUUM;\ncreate table b (x integer);\n"
    );
    expect(hasTrailingVacuum).toBe(false);
  });

  it("VACUUM with leading whitespace + uppercase still matches", () => {
    const { hasTrailingVacuum, pre } = splitVacuum(
      "CREATE TABLE A;\n  VACUUM;"
    );
    expect(hasTrailingVacuum).toBe(true);
    expect(pre).toBe("CREATE TABLE A;");
  });

  it("REGRESSION: no-VACUUM migration body actually executes (empty-schema bug, 2026-10-14)", () => {
    // The desktop fresh-install boot failed because the runner's
    // slicing returned "" for findTrailingVacuumIndex === -1, so
    // migrations 001-013 were recorded as applied while their DDL
    // never ran; 014 then died with "no such table: events". This
    // test would have caught it: a VACUUM-free migration MUST leave
    // its table behind.
    db.exec("create table t (x integer)");
    applyWithVacuumSplit(
      db,
      "002_add_u.sql",
      "create table u (y integer); create index u_y on u(y);"
    );
    expect(
      db.prepare("select name from sqlite_master where name = 'u'").get()
    ).toBeDefined();
    expect(
      db.prepare("select name from sqlite_master where name = 'u_y'").get()
    ).toBeDefined();
  });

  it("slicePreVacuumSql: -1 returns full script, 0 returns empty, >0 returns prefix", () => {
    const sql = "create table a (x integer);\nVACUUM;\n";
    const idx = findTrailingVacuumIndex(sql);
    expect(idx).toBeGreaterThan(0);
    expect(slicePreVacuumSql(sql, idx)).toBe("create table a (x integer);");
    expect(slicePreVacuumSql("VACUUM;", 0)).toBe("");
    const noVacuum = "create table a (x integer);";
    expect(findTrailingVacuumIndex(noVacuum)).toBe(-1);
    expect(slicePreVacuumSql(noVacuum, -1)).toBe(noVacuum);
  });

  it("VACUUM at start of line (after newline, no leading semicolon) still matches — mirrors 014_restore_events_fk.sql", () => {
    // The actual 014 migration ends with `VACUUM;` on its own line
    // (preceded by a newline, not a `;`). Without the `m` flag in
    // the regex, `(?:^|;)` only matches input start and the
    // split silently fails — the migration then runs as one big
    // transaction and crashes with "cannot VACUUM from within a
    // transaction". This test pins the multiline behaviour.
    const { hasTrailingVacuum, pre } = splitVacuum(
      "alter table events rename to events_old;\n" +
        "create table events (id text primary key);\n" +
        "PRAGMA foreign_keys = on;\n" +
        "VACUUM;"
    );
    expect(hasTrailingVacuum).toBe(true);
    // pre ends with the `;` that terminated the previous DDL.
    expect(pre.endsWith(";")).toBe(true);
  });
});
