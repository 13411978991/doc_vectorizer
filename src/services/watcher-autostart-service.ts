/**
 * src/services/watcher-autostart-service.ts — Per-process toggle for the
 * watcher's boot-time autostart. The env triple-gate (ALLOW_PROD_WATCHER
 * / WATCHER_AUTOSTART / STARTUP_SYNC) remains the hard production
 * guard; this service exposes a *soft* UI-driven override that lets a
 * developer / power user flip the toggle without restarting the exe,
 * while still respecting the production hard-gate at boot time.
 *
 * Persistence: `ai_provider_settings.metadata.watcherAutostart` (bool).
 * Process state: in-memory `enabled` flag defaulting to false. Both
 * index.ts (boot) and the settings API read this; updates from the API
 * mutate the flag immediately and the DB asynchronously.
 */

import { pool } from "../db/pool.js";
import { getAiProviderSettings } from "../db/repositories.js";
import { parseJsonObject } from "../db/row-helpers.js";

class WatcherAutostartService {
  /** Resolved at boot. `null` means "not yet determined" — caller
   *  should fall through to the env triple-gate until we have a
   *  real value. */
  private enabled: boolean | null = null;
  private dbLoaded = false;

  /**
   * Read the boot-time value, falling through to env when the DB has
   * no preference. Called once during `bootWatchedFolders`. After
   * this resolves, the value is cached.
   */
  async resolveAtBoot(envAutostart: boolean): Promise<boolean> {
    if (this.dbLoaded) {
      return this.enabled ?? envAutostart;
    }
    try {
      const row = await getAiProviderSettings();
      if (row) {
        const meta = parseJsonObject(row.metadata);
        const dbValue = meta.watcherAutostart;
        if (typeof dbValue === "boolean") {
          this.enabled = dbValue;
          this.dbLoaded = true;
          return dbValue;
        }
      }
    } catch {
      // Fall through to env default
    }
    // No DB override present — cache the env value but DON'T mark the
    // DB as having an explicit preference, so the UI's "from
    // environment" badge stays honest. `setEnabled` flips dbLoaded
    // when the user makes an explicit choice.
    this.enabled = envAutostart;
    return envAutostart;
  }

  /**
   * Set the current process's autostart flag and persist to DB.
   * The flag takes effect on the next `bootWatchedFolders` invocation
   * (i.e. on next service restart) — runtime autostart is intentionally
   * not flipped mid-run, because that would require tearing down
   * active watchers which is its own can of worms.
   */
  async setEnabled(value: boolean): Promise<void> {
    this.enabled = value;
    this.dbLoaded = true;
    // jsonb_set with create_missing=true writes the key into the
    // existing metadata JSON without touching the rest of it. Same
    // pattern as performance-settings-service reset: avoid
    // upsertAiProviderSettings' json_patch (additive) and use a
    // targeted SQL update.
    await pool.query(
      `update ai_provider_settings
         set metadata = json_set(coalesce(metadata, '{}'), '$.watcherAutostart', ?::jsonb),
             updated_at = current_timestamp
       where id = 'global'`,
      [JSON.stringify(value)]
    );
  }

  /**
   * Read the current process's autostart value (sync, from cache).
   * Returns null if `resolveAtBoot` has not been called yet.
   */
  current(): boolean | null {
    return this.enabled;
  }

  /** True if the DB has an explicit preference (setEnabled was called
   *  OR the DB row was populated). Lets the UI distinguish "user
   *  explicitly set it" from "defaulting to env". */
  hasDbOverride(): boolean {
    return this.dbLoaded;
  }
}

export const watcherAutostartService = new WatcherAutostartService();
