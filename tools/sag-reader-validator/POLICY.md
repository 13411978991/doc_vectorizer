# Validator Policy — what gets checked, why

> This document is **part of the validator itself**. It is reviewed
> alongside `src/main.mjs` and must be kept in lockstep. If you change
> the rules, update both. The build pipeline copies this file next to
> the validator binary so operators can read what their certs claim.

## What "validation" means

A reader script is a small program that, when given a file path,
returns the file's text content on stdout. It runs in a child process
of SAG.exe. Anything in that child process — file system access,
network calls, COM automation, PowerShell scripts — runs with the
**same privileges** as SAG.exe. So a malicious reader can:

- Read any file the user can read (audit PDFs, financial data, etc.)
- Make outbound network calls (exfiltrate)
- Spawn Office COM and read other documents
- Replace legitimate binary parsing with arbitrary code

The validator's job is to detect reader scripts that are **clearly
broken or suspicious** before SAG.exe uses them in production. It
is not, and cannot be, a full security sandbox — that would require
isolating every reader in a container or VM. It's a **behavioral
correctness gate**: a reader that fails these checks will produce
garbage text that pollutes the vector store, which is bad enough on
its own.

## The 12 checks

| # | Check | What it catches |
|---|-------|----------------|
| 1 | Filename matches `sag-read-<ext>[.<variant>].<lang>` | Misnamed scripts that wouldn't dispatch anyway |
| 2 | `--meta` exits 0 | Reader crashes before it can describe itself |
| 3 | `--meta` output is valid JSON with `name`/`extensions`/`languages` | Reader that lies about its capabilities |
| 4 | `--meta.extensions` includes the filename's extension | Reader that declares ".pdf" but is named "sag-read-docx.py" — would break dispatch |
| 5 | `--probe <known-good file>` exits 0 | Reader that can't actually read the files it claims to support |
| 6 | `--probe <unrelated file>` exits non-zero (when supplied) | Reader that accepts everything — would intercept files meant for other readers |
| 7 | Main extract exits 0 | Reader that crashes during the actual work |
| 8 | stdout is UTF-8, no BOM, no `\r` | Garbled output that breaks downstream chunkers (BOM trips mammoth, CR trips our line-counter logic) |
| 9 | stderr last line is JSON (or empty) | Reader that uses stderr for ad-hoc progress noise — UI hides stderr behind a fold, and we want predictable metadata |
| 10 | Control-char ratio < 5% | Binary garbage from half-decrypted DLP files, wrong codec |
| 11 | Validator process RSS < 500 MB during run | Reader that loads a 2 GB PDF into memory and OOMs the host |
| 12 | Wall-clock < timeoutMs | Reader that hangs on a locked Office process — leaves orphan EXCEL.EXE behind |

## What is NOT checked (and why)

- **No static analysis of the reader source.** A reader can do anything
  in its child process — that's the whole point of the design.
  Trying to statically gate this would force us to reimplement the
  sandboxing we've explicitly delegated to the OS process boundary.
  A malicious reader WILL be able to exfiltrate data; the validator
  only ensures it produces correctly-formatted text.
- **No content correctness check.** We don't diff the reader's
  output against a known-good reference, because there is no
  known-good reference for arbitrary user files. The "this isn't
  binary garbage" check is the strongest claim we can make.
- **No signature of the reader script itself.** A reader's source can
  change between validations and SAG.exe does not enforce that the
  current bytes match the cert. If you want that property, hash the
  reader into the cert yourself and check it in SAG.exe's
  cert-verify path (the `readerSha256` field is already there for
  this).

## Threat model

The validator defends against:
- **Accidental broken readers** — most common case. A reader that
  doesn't follow SPEC.md and crashes or produces garbage on real files.
  These would silently corrupt the vector store.
- **Incompetent AI agents** — a different computer's agent writes a
  reader that "works" on a test file but actually emits empty strings
  on real ones, or writes the wrong exit code, or hard-codes the
  wrong extension.
- **Tampering with the validator itself** — see §6 of README.md.

The validator does NOT defend against:
- **A determined human attacker** who has shell access on the user's
  machine. They can disable SAG.exe's cert check, replace the
  validator binary, etc. This is out of scope.
- **A reader that reads and exfiltrates data via its main call.**
  SAG.exe explicitly accepts this risk — the reader is a privileged
  helper, not an untrusted sandbox.
