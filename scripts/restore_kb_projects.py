#!/usr/bin/env python3
"""Restore kb_projects and kb_sources from bak into live."""
import sqlite3, os

LIVE = r'd:\IT审计\SAG-windows-pack\data\sag.db'
BAK = r'd:\IT审计\SAG-windows-pack\data\sag.db.bak-20260722-212651'

def sql_dump(con, table):
    cur = con.cursor()
    cur.execute(f"SELECT * FROM {table}")
    cols = [d[0] for d in cur.description]
    rows = cur.fetchall()
    return cols, rows

# We need any extra columns live has but bak doesn't have.
def diff_cols(table):
    live_cols = []
    bak_cols = []
    with sqlite3.connect(LIVE) as lc:
        cur = lc.execute(f"PRAGMA table_info({table})")
        live_cols = [c[1] for c in cur.fetchall()]
    with sqlite3.connect(BAK) as bc:
        cur = bc.execute(f"PRAGMA table_info({table})")
        bak_cols = [c[1] for c in cur.fetchall()]
    return live_cols, bak_cols

for t in ("kb_projects", "kb_sources"):
    lc, bc = diff_cols(t)
    extra = [c for c in lc if c not in bc]
    missing = [c for c in bc if c not in lc]
    print(f"--- {t} ---")
    print(f"  live-only cols: {extra}")
    print(f"  bak-only cols:  {missing}")

# Strategy: copy bak row by row, NULL-fill live-only cols.
print()
print("=== kb_projects ===")
with sqlite3.connect(BAK) as bc:
    bcp = bc.cursor()
    bcp.execute("SELECT * FROM kb_projects")
    proj_cols = [d[0] for d in bcp.description]
    proj_rows = bcp.fetchall()

with sqlite3.connect(LIVE) as lc:
    lcp = lc.cursor()
    lcp.execute("PRAGMA table_info(kb_projects)")
    live_proj_cols = [c[1] for c in lcp.fetchall()]
    live_proj_extras = [c for c in live_proj_cols if c not in proj_cols]
    print("bak kb_projects:", len(proj_rows))
    placeholders = ",".join(["?"] * len(live_proj_cols))
    sql = f"INSERT INTO kb_projects ({','.join(live_proj_cols)}) VALUES ({placeholders})"
    inserted = 0
    for r in proj_rows:
        rec = dict(zip(proj_cols, r))
        for col in live_proj_extras:
            rec[col] = None
        row = [rec[c] for c in live_proj_cols]
        try:
            lcp.execute(sql, row)
            inserted += 1
        except sqlite3.IntegrityError as e:
            print("  skip (already exists):", rec['id'], e)
    lc.commit()
    print(f"inserted {inserted} kb_projects rows")

print()
print("=== kb_sources ===")
with sqlite3.connect(BAK) as bc:
    bcs = bc.cursor()
    bcs.execute("SELECT * FROM kb_sources")
    src_cols = [d[0] for d in bcs.description]
    src_rows = bcs.fetchall()

with sqlite3.connect(LIVE) as lc:
    lcs = lc.cursor()
    lcs.execute("PRAGMA table_info(kb_sources)")
    live_src_cols = [c[1] for c in lcs.fetchall()]
    live_src_extras = [c for c in live_src_cols if c not in src_cols]
    print("bak kb_sources:", len(src_rows))
    placeholders = ",".join(["?"] * len(live_src_cols))
    sql = f"INSERT INTO kb_sources ({','.join(live_src_cols)}) VALUES ({placeholders})"
    inserted = 0
    for r in src_rows:
        rec = dict(zip(src_cols, r))
        for col in live_src_extras:
            rec[col] = None
        row = [rec[c] for c in live_src_cols]
        try:
            lcs.execute(sql, row)
            inserted += 1
        except sqlite3.IntegrityError as e:
            print("  skip:", rec.get('id'), e)
    lc.commit()
    print(f"inserted {inserted} kb_sources rows")

print()
print("=== final state ===")
with sqlite3.connect(LIVE) as lc:
    for r in lc.execute("SELECT id, name, description FROM kb_projects").fetchall():
        print("  kb_project:", r)
    for r in lc.execute("""SELECT ks.kb_project_id, kp.name, ks.name, ks.watched_folder_id
                            FROM kb_sources ks LEFT JOIN kb_projects kp ON kp.id=ks.kb_project_id""").fetchall():
        print("  kb_source:", r)
