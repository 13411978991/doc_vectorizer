# Down migration scripts

This directory holds **manual rollback scripts** for the corresponding
up migrations in `../`. They are **not** wired into the migration
runner (`src/db/migrate.ts`); they exist so an operator who needs to
revert a specific migration has a tested starting point instead of
having to write the inverse SQL by hand in production.

## When to use one

Only use a down script when:

1. You have **NOT yet deployed** the corresponding up migration to a
   production database and you need to back it out before it lands.
2. The up migration has been deployed but the change is **trivially
   reversible** (a single `ALTER TABLE ADD COLUMN` with no downstream
   joins / indexes / vec0 virtual tables depending on it) AND you
   have explicit operator approval. **Never** auto-run down scripts
   in a hot environment — they will drop data.

For non-trivial reversals (multi-statement migrations, ones that
created vec0 virtual tables, ones that backfilled existing rows), do
**not** write a down script — write a new up migration that
re-establishes the previous state. The "expanding-only" migration
discipline (never `DROP COLUMN` once data exists) is the only thing
keeping historical customer databases intact.

## Naming convention

`<NNN>_<name>.down.sql` — mirrors the up migration name with a
`.down.sql` suffix so the operator can find them with a single tab
completion. The leading number matches the up migration's number.

## Run order

The script must undo the up migration's effects in the **reverse**
order they were applied:

1. Drop indexes that the up migration created
2. Drop the vec0 virtual tables that the up migration created
3. Drop the columns the up migration added (or recreate the table
   without them, see "destructive reversals" below)
4. Remove the row from `schema_migrations` so a re-apply of the up
   migration will work cleanly

For the schema_migrations row, use:

```sql
delete from schema_migrations where name = '010_manifest_last_error.sql';
```

…with the actual up-migration filename. This is **always** the last
statement in a down script.

## Destructive reversals

If a down script would have to drop a column that real data depends
on, the right move is to:

1. Mark the up migration as **non-reversible** in this README
2. Stop here. The down script should not exist.

Future migrations should follow the same expanding-only discipline:
add columns / tables / indexes, but never `DROP` or `RENAME` of
existing data. Migrations that violate this rule must be reviewed by
two engineers before being merged.

## Example

See `010_manifest_last_error.down.sql` for a one-column-drop
example. It removes the `last_error` column from
`watched_folder_manifests` and the corresponding
`schema_migrations` row in a single transaction. Use it as a
template when authoring new down scripts.

## Refusing to run automatically

`migrate.ts` ignores this directory entirely — it only scans the
parent for `*.sql` files. To run a down script, the operator
must invoke it manually:

```sh
sqlite3 ./data/sag.db < src/db/sqlite/migrations/down/010_manifest_last_error.down.sql
```

…or via the better-sqlite3 CLI wrapper. The migration runner
provides no auto-undo because rolling back a database without
operator awareness is almost always the wrong default.
