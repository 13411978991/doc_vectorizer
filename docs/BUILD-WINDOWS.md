# Building SAG as a single-file Windows .exe

> Last verified: 2026-07-10 · Node v22.23.1 · SAG v0.1.x

This document explains how to package SAG as **one** `sag.exe` that
runs on Windows 10 / 11 with no installer, no Node.js, and no
dependencies. Double-click it, point your browser at
`http://localhost:4173`, and you're in.

The build pipeline is fully cross-platform: it runs on Linux, macOS,
Windows, and GitHub Actions. The Windows-specific bits are isolated in
two Node scripts under `scripts/`.

---

## TL;DR (no source checkout needed)

Download a prebuilt `sag.exe` from the
[GitHub Actions artifacts](../../actions/workflows/release-windows.yml)
of the latest `main` push, or from any
[GitHub Release](../../releases) tag. No install, no setup. Move on to
[Running](#running-on-windows).

---

## Build from source

You need **Node.js v22.23.1** on whatever machine you build from (Linux
builds are tested in CI; macOS also works locally; Windows works
locally but takes longer because of native-module compilation).

```bash
git clone https://github.com/<your-org>/sag.git
cd sag
npm ci
npm run build          # tsc + vite build
npm run build:sea-bundle   # esbuild + base64-pack native modules + write entry
npm run build:windows-exe  # download Windows Node 22.23.1 + postject inject
```

The final `sag.exe` lands at the repo root, ~170 MB.

### What `build:sea-bundle` does

`scripts/build-sea-bundle.mjs` is a Node.js builder that produces a
self-contained CommonJS blob Node.js's SEA can execute directly:

1. `esbuild` bundles `dist/src/index.js` into `dist/sag.bundle.cjs`
   (~5 MB). The native modules `better-sqlite3`, `sqlite-vec`,
   `onnxruntime-node`, and `bindings` are marked `external` so they
   resolve at runtime rather than being inlined.
2. Each native module dir under `node_modules/` is walked. Every
   `.node`, `.dll`, `.so`, `.dylib`, `.json`, and JS source is
   base64-encoded into `dist/sag.native-map.json` (~66 MB unpacked).
3. A tiny bootstrap, `dist/sag.entry.cjs`, is written. On first
   launch it:
   - decodes the native-map into `%TEMP%/sag-sea-native-<hash>/`,
   - patches `Module._resolveFilename` so `require("better-sqlite3")`
     resolves to the unpacked dir,
   - loads `dist/sag.bundle.cjs`.
4. `dist/sea-config.json` is written and `node --experimental-sea-config
   sea-config.json` is invoked, producing `dist/sag.blob` (~88 MB).

### What `build:windows-exe` does

`scripts/build-windows-exe.mjs` takes the blob and turns it into a real
`.exe`:

1. Pulls `node-v22.23.1-win-x64.zip` from
   `npmmirror.com / nodejs.org / registry.npmmirror.com` to a cache
   (`$SAG_WIN_NODE_CACHE`, default `/tmp/sag-win-node`).
2. Confirms the SEA sentinel
   `NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2` is embedded in the
   Windows binary. If it's missing, abort and try a different mirror.
3. Copies the Windows `node.exe` to `./sag.exe`.
4. Invokes `postject` (already in `node_modules/.bin/` via
   `@yao-pkg/pkg`) to splice `dist/sag.blob` into `NODE_SEA_BLOB`
   slot, using the fixed sentinel.
5. Writes `dist/build-info.json` with version + blob SHA-256 for
   provenance.

The result is a 170 MB PE32+ console executable that runs Node v22's
runtime + your code + native deps with zero external assets.

---

## Running on Windows

1. Copy `sag.exe` to any folder (it doesn't need to live next to
   anything else).
2. Double-click `sag.exe`. **First run only**, Windows SmartScreen may
   show **"Windows protected your PC"** because the binary is unsigned.
   Click **More info → Run anyway**. (Signing is left as a follow-up;
   see [Known limitations](#known-limitations).)
3. A console window opens. Wait for log lines like:
   ```
   {"level":"info","time":...,"msg":"server: listening on http://0.0.0.0:4173"}
   ```
4. Open a browser to <http://localhost:4173>. You're in.
5. Stop with Ctrl+C in the console window.

### First-time data directory

The server creates `./data/` next to `sag.exe` on first run.
SQLite files (`sag.db`, `sag.db-wal`, `sag.db-shm`) and the
uploaded-files archive live there. Back up this folder to retain
everything.

### Environment variables

Set in the same shell that launches `sag.exe`, or in a `.env` file
**next to** `sag.exe`. Defaults:

| Var | Default | Notes |
|---|---|---|
| `HTTP_PORT` | 4173 | Set to `0` for a random port. |
| `LOG_LEVEL` | info | debug / info / warn / error |
| `EMBEDDING_MODEL` | text-embedding-3-large | Swap to `local-bge` for offline. |
| `EMBEDDING_API_KEY` | _empty_ | Required when not using `local-bge`. |
| `EMBEDDING_BASE_URL` | https://api.302ai.cn/v1 | Any OpenAI-compatible endpoint. |

If you want zero external dependencies, set
`EMBEDDING_MODEL=local-bge` and drop a BGE ONNX model into
`models/bge-large-zh-v1.5/` next to `sag.exe`. See
`scripts/download-bge-model.sh` for the helper.

---

## Cross-platform matrix

| Host OS | Build target | Works? | How |
|---|---|---|---|
| Linux (CI / dev) | Windows .exe | ✅ | `npm run build:sea-bundle && npm run build:windows-exe` |
| macOS | Windows .exe | ✅ | Same commands |
| Windows | Windows .exe | ✅ | Same commands (slower — npm rebuilds better-sqlite3 for Win32) |
| Any host | Linux .sea | ✅ | `node --experimental-sea-config sea-config.json` then copy Linux node binary + postject locally |

The single-host path on Windows is the slowest because
`better-sqlite3` and `sqlite-vec` have to compile their native
gyp bindings against MSVC; npm does this transparently. Use
GitHub Actions when possible.

---

## Troubleshooting

### `SAG SEA bundle load failed: ...`
The runtime failed to load `dist/sag.bundle.cjs` inside `sag.exe`.
Most often this is a missing native module. Re-run `npm install` on a
matching Node version (22.23.1) and `npm run build:sea-bundle` again.
The first launch writes a fresh `%TEMP%/sag-sea-native-<hash>/` so a
stale extraction can also be the cause — `del %TEMP%\sag-sea-native-*`
and relaunch.

### Windows SmartScreen blocks the binary
First run on a freshly downloaded unsigned `.exe` is gated. Click
**More info → Run anyway**. We don't ship a code-signing certificate
yet — see [Known limitations](#known-limitations).

### Port 4173 already in use
Set `HTTP_PORT=4174` (or whatever) before launching. On Windows you
can also create a `.env` file next to `sag.exe`:
```
HTTP_PORT=4174
```

### better-sqlite3 throws `SQLITE_CANTOPEN`
The data directory isn't writable. Make sure `sag.exe` lives somewhere
you have write permission; some corporate installs under
`C:\Program Files` are read-only.

### The first launch is slow
The bootstrap decodes ~66 MB of native modules into `%TEMP%`. After
that it's cached. Subsequent boots of the same `sag.exe` are instant.

### VirusTotal false positives
Unsigned Node SEA binaries sometimes trip heuristic scanners because
they bundle so much code. Submit a false-positive report through the
AV vendor's portal. This is solved by code signing (see below).

---

## Known limitations (intentional, follow-ups)

- **No code-signing certificate.** SmartScreen nag on first run. Get a
  cheap OV cert, add a `signtool sign /fd SHA256` step to
  `release-windows.yml`, problem gone.
- **PE64 only.** No ARM64 native, no Windows 7 / 8. Build a second
  variant on `windows-11-arm` runners when demand materializes.
- **No installer.** Single-file `.exe` is the requested deliverable.
  For a Start-menu + uninstaller variant, wrap with NSIS later
  (out of scope; trivial to add once we ship an installer config).
- **Default embedding is an external API.** No API key = no
  ingestion. For fully offline use set `EMBEDDING_MODEL=local-bge`
  and ship the ONNX model with the binary (not done yet; tracked
  separately).
- **Background-services mode not implemented.** Currently foreground
  only — closing the console window stops the server. A NSSM /
  `srvany` wrapper is a future addition.

---

## Implementation reference

| File | Purpose |
|---|---|
| `scripts/build-sea-bundle.mjs` | Bundles src, packs natives, writes entry, builds blob. |
| `scripts/build-windows-exe.mjs` | Pulls Windows Node, postjects blob, writes sag.exe. |
| `.github/workflows/release-windows.yml` | CI build + Release artifact on tag push. |
| `dist/sag.bundle.cjs` | esbuild output (intermediate, 5 MB). |
| `dist/sag.native-map.json` | base64 of every native-module file (intermediate). |
| `dist/sag.entry.cjs` | Runtime bootstrap (extract + require hook + load). |
| `dist/sag.blob` | SEA blob (intermediate, 88 MB) — gets injected into sag.exe. |
| `dist/build-info.json` | Provenance: version, build host, blob sha256. |
| `sag.exe` | Final deliverable, ~170 MB. |

The two new `package.json` scripts:

```jsonc
{
  "build:sea-bundle": "node scripts/build-sea-bundle.mjs",
  "build:windows-exe": "node scripts/build-windows-exe.mjs",
  "build:windows": "npm run build && npm run build:sea-bundle && npm run build:windows-exe"
}
```
