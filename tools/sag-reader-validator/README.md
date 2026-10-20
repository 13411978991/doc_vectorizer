# sag-reader-validator

A standalone validator for `sag-readers/*` scripts. Produces
`.sag-validator-cert.json` next to each accepted reader.

## Why a separate validator

`sag-readers/` lets other computers' agents add their own file
readers (Python / PowerShell / anything). That script runs as a
child process of `黑洞.exe` with full user privileges. We need a gate
that checks "does this reader actually follow the SAG reader protocol
and produce sane output" before the main exe trusts it.

This validator is that gate. It runs each reader through 12
behavioral checks (see [POLICY.md](./POLICY.md)) and emits a
signed certificate on success.

## Two ways to run it

### From source (during development)

```bash
node src/main.mjs --validate ../../sag-readers/sag-read-docx.py \
                  --probe-file ../../fixtures/LongPaths/.../some.docx \
                  --probe-reject-file ../../fixtures/Chinese/.../some.txt
```

Certs produced from source runs are marked `dev-mode-no-self-hash`
and will be REJECTED by `黑洞.exe` (which expects the packaged
binary's SHA). This is intentional — dev certs let you iterate
without rebuilding the exe.

### Packaged as a single exe (production)

```bash
node build.mjs --sea
# produces dist/sag-reader-validator.exe and dist/validator-sha256.txt
```

The packaged exe sets `SAG_READER_VALIDATOR_PACKAGED=1` internally,
so it uses its own bytes as the HMAC signing-key seed. `黑洞.exe`
hardcodes the resulting SHA-256 and refuses any cert signed by a
different binary.

## What "tamper-resistant" means here

The expected SHA-256 of the packaged binary is checked into
`黑洞.exe` at compile time. If anyone — including another AI — edits
`src/main.mjs` and rebuilds, the new binary won't match. The new
binary can still issue certs (HMAC is local), but `黑洞.exe` rejects
them on the trust check.

So to actually weaken the validation rules, an attacker would need
to:
1. Edit `src/main.mjs`
2. Edit `黑洞.exe`'s expected SHA
3. Rebuild both
4. Ship both as a "release"

That's a deliberate code review step, not a one-shot prompt.
The README + POLICY.md + SHA256.txt are all there to make such a
change obvious in PR review.

## Files

| File | Purpose |
|------|---------|
| `src/main.mjs` | The 12 checks + cert signing (the actual logic) |
| `build.mjs` | esbuild bundle → SEA exe |
| `package.json` | npm metadata, bins |
| `POLICY.md` | What each check does and what it does NOT check |
| `SHA256.txt` | Source-content fingerprint (review-audit trail) |
| `dist/sag-reader-validator.exe` | The packaged binary |
| `dist/validator-sha256.txt` | SHA-256 of the packaged binary (paste into `黑洞.exe`) |

## Build prerequisites

- Node 20+ (for SEA support)
- `signtool` on Windows (optional, only for re-signing the exe)

That's it. No native deps — the validator is pure Node stdlib.
