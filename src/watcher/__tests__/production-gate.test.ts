import { afterEach, beforeEach, describe, expect, it } from "vitest";

// We test the production gate by re-importing the env module with different
// process.env values. Because `config` is a module-level singleton, we use
// vi.resetModules to get a fresh evaluation each test.

const originalEnv = { ...process.env };

function setEnv(patch: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(originalEnv)) {
    process.env[key] = value;
  }
}

async function importWatcher(): Promise<{ WatcherManager: typeof import("../index.js").WatcherManager; config: typeof import("../../config/env.js").config }> {
  vi.resetModules();
  // Force the env module to re-evaluate with the current process.env.
  const envModule = await import("../../config/env.js");
  const watcherModule = await import("../index.js");
  return { WatcherManager: watcherModule.WatcherManager, config: envModule.config };
}

// Vitest's vi API — keep the imports minimal.
import { vi } from "vitest";

describe("WatcherManager — production gate", () => {
  beforeEach(() => {
    restoreEnv();
  });
  afterEach(() => {
    restoreEnv();
  });

  it("throws when NODE_ENV=production and ALLOW_PROD_WATCHER is unset/false", async () => {
    setEnv({ NODE_ENV: "production" });
    delete process.env.ALLOW_PROD_WATCHER;
    const { WatcherManager } = await importWatcher();
    const mgr = new WatcherManager();
    expect(() => mgr.assertEnvironment()).toThrow(/production/i);
    // startAll also enforces the gate.
    await expect(mgr.startAll([])).rejects.toThrow(/production/i);
  });

  it("throws when NODE_ENV=production and ALLOW_PROD_WATCHER=false", async () => {
    setEnv({ NODE_ENV: "production", ALLOW_PROD_WATCHER: "false" });
    const { WatcherManager } = await importWatcher();
    const mgr = new WatcherManager();
    expect(() => mgr.assertEnvironment()).toThrow(/production/i);
  });

  it("allows startup when NODE_ENV=production and ALLOW_PROD_WATCHER=true", async () => {
    setEnv({ NODE_ENV: "production", ALLOW_PROD_WATCHER: "true" });
    const { WatcherManager } = await importWatcher();
    const mgr = new WatcherManager();
    expect(() => mgr.assertEnvironment()).not.toThrow();
    // startAll with empty folder list is a no-op and should not throw.
    await expect(mgr.startAll([])).resolves.toBeUndefined();
  });

  it("allows startup when NODE_ENV=development (default)", async () => {
    setEnv({ NODE_ENV: "development" });
    delete process.env.ALLOW_PROD_WATCHER;
    const { WatcherManager } = await importWatcher();
    const mgr = new WatcherManager();
    expect(() => mgr.assertEnvironment()).not.toThrow();
    await expect(mgr.startAll([])).resolves.toBeUndefined();
  });

  it("allows startup when NODE_ENV=test", async () => {
    setEnv({ NODE_ENV: "test" });
    delete process.env.ALLOW_PROD_WATCHER;
    const { WatcherManager } = await importWatcher();
    const mgr = new WatcherManager();
    expect(() => mgr.assertEnvironment()).not.toThrow();
  });
});