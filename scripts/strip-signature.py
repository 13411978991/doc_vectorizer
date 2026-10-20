"""
scripts/strip-signature.py — Remove the Authenticode signature from a
Windows .exe that was just blob-injected by postject.

Why: postject splices a SEA blob at NODE_SEA_BLOB. If the original
node.exe was signed by Node.js Foundation, the appended blob
invalidates the signature hash, so Windows logs:

    warning: The signature seems corrupted!

This doesn't actually break the .exe (Windows still loads it), but it
makes the file look tampered to SmartScreen and any AV that inspects
Authenticode metadata. Stripping the now-invalid signature is cleaner
than leaving a broken one: PE remains well-formed, just unsigned. The
end user can later sign with their own Authenticode certificate via
`signtool sign /a SAG.exe`.

Mechanism: PE files have an IMAGE_DIRECTORY_ENTRY_SECURITY at index 4
in the data directories array. Each entry is (RVA, size). Setting both
to 0 makes the loader ignore the certificate table. We also rewrite
the optional header CheckSum to a real one (PE spec requires it for
loaded images; Windows is lenient but signature checkers are not).

Run: python strip-signature.py <path-to-exe>

Cross-platform: the script uses only Python stdlib and struct; it does
NOT need to run on Windows specifically (PE layout is platform-
independent). Run from any host after build-windows-exe.mjs.
"""

import struct
import sys
from pathlib import Path

# PE signature constant
PE_SIGNATURE = b"PE\0\0"
# Data directory indices
IMAGE_DIRECTORY_ENTRY_SECURITY = 4

def parse_pe(exe_path: Path):
    """Parse a PE file's data directory table in-place.

    Returns (security_dir_offset_in_file, security_dir_size) tuple so
    the caller can decide whether to strip. Raises if the file is not
    a PE.
    """
    with exe_path.open("rb") as f:
        dos = f.read(64)
        if dos[:2] != b"MZ":
            raise SystemExit(f"{exe_path} is not an MZ/PE file (no MZ header)")
        # e_lfanew is at offset 0x3C (4 bytes LE)
        pe_offset = struct.unpack_from("<I", dos, 0x3C)[0]
        f.seek(pe_offset)
        sig = f.read(4)
        if sig != PE_SIGNATURE:
            raise SystemExit(f"{exe_path} is not a PE (expected PE\\0\\0 at 0x{pe_offset:X})")
        # COFF header (20 bytes): machine(2) + num_sections(2) + ...
        coff = f.read(20)
        machine, num_sections, _, _, _, opt_header_size, _ = struct.unpack_from(
            "<HHIIIHH", coff, 0
        )
        # Optional header follows immediately. For PE32 / PE32+ the
        # magic at offset 0 is 0x10B (PE32) or 0x20B (PE32+).
        opt_header_start = f.tell()
        opt_magic = f.read(2)
        f.seek(opt_header_start)
        opt_header = f.read(opt_header_size)
        # data directories start at offset 96 (PE32) or 112 (PE32+) in
        # the optional header.
        if opt_magic == b"\x0b\x01":
            dd_offset_in_opt = 96
            is_pe32_plus = False
        elif opt_magic == b"\x0b\x02":
            dd_offset_in_opt = 112
            is_pe32_plus = True
        else:
            raise SystemExit(
                f"unknown PE optional-header magic: {opt_magic.hex()} (not PE32/PE32+)"
            )
        dd_offset_in_file = opt_header_start + dd_offset_in_opt
        # Each directory entry is 8 bytes: RVA(4) + size(4).
        sec_entry_offset_in_file = dd_offset_in_file + IMAGE_DIRECTORY_ENTRY_SECURITY * 8
        f.seek(sec_entry_offset_in_file)
        sec_rva, sec_size = struct.unpack("<II", f.read(8))
        # Also grab the optional-header checksum offset so we can
        # recompute it (Windows is lenient but not always).
        if is_pe32_plus:
            checksum_offset_in_file = opt_header_start + 64  # PE32+: CheckSum at +64
        else:
            checksum_offset_in_file = opt_header_start + 64  # PE32: same offset
        return {
            "sec_rva": sec_rva,
            "sec_size": sec_size,
            "sec_entry_offset": sec_entry_offset_in_file,
            "checksum_offset": checksum_offset_in_file,
            "opt_header_start": opt_header_start,
            "opt_header_size": opt_header_size,
        }


def compute_pe_checksum(exe_path: Path) -> int:
    """Compute the CheckSum field per PE spec.

    Algorithm: sum the whole file as 16-bit LE words, treating the
    CheckSum field itself as zero, then add the file length.
    """
    total = 0
    with exe_path.open("rb") as f:
        # Determine CheckSum offset up front so we can zero it.
        info = parse_pe(exe_path)
        cs_offset = info["checksum_offset"]
        data = f.read()
    # Truncate to whole-word length
    length = (len(data) // 2) * 2
    for i in range(0, length, 2):
        if i == cs_offset or i == cs_offset + 1:
            # Skip the 2 bytes of the checksum itself.
            continue
        word = data[i] | (data[i + 1] << 8)
        # 32-bit add with wrap.
        total = (total + word) & 0xFFFFFFFF
    # Fold the high half into the low half (PE CheckSum is 16-bit).
    total = (total & 0xFFFF) + ((total >> 16) & 0xFFFF)
    total = (total + (total >> 16)) & 0xFFFF
    total = (total + len(data)) & 0xFFFF
    return total


def strip(exe_path: Path, *, keep: bool = False) -> dict:
    """Strip the Authenticode signature. Returns a result dict.

    When keep=False (default): clears the security data directory
    (RVA=0, size=0) and the certificate table itself is left in the
    file (it's just unreferenced). This is the lightest possible
    change — no other directories shift.

    When keep=True: same as keep=False plus preserves a small
    `.stripped-sig.marker` file next to the .exe so downstream code
    can detect "this exe was built without signature intentionally".
    """
    info = parse_pe(exe_path)
    sec_rva, sec_size = info["sec_rva"], info["sec_size"]
    if sec_rva == 0 and sec_size == 0:
        return {
            "stripped": False,
            "reason": "already unsigned",
            "rva": 0,
            "size": 0,
        }
    # Read existing entry, zero it, write back.
    with exe_path.open("rb+") as f:
        f.seek(info["sec_entry_offset"])
        f.write(struct.pack("<II", 0, 0))
    # Recompute CheckSum so PE checkers don't complain. We do this
    # even though Windows loads unchecked binaries, because
    # Authenticode validators *do* check CheckSum.
    new_cs = compute_pe_checksum(exe_path)
    with exe_path.open("rb+") as f:
        f.seek(info["checksum_offset"])
        f.write(struct.pack("<I", new_cs))
    result = {
        "stripped": True,
        "rva": sec_rva,
        "size": sec_size,
        "new_checksum": new_cs,
    }
    if keep:
        marker = exe_path.with_suffix(exe_path.suffix + ".stripped-sig.marker")
        marker.write_text(
            f"Authenticode signature stripped from {exe_path.name}\n"
            f"  old RVA  = 0x{sec_rva:08X}\n"
            f"  old size = {sec_size} bytes\n"
            f"  new CheckSum = 0x{new_cs:08X}\n"
            "\n"
            "This exe is unsigned. Sign before distribution with:\n"
            "  signtool sign /fd SHA256 /a SAG.exe\n"
        )
        result["marker"] = str(marker)
    return result


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: strip-signature.py <exe-path> [--keep-marker]", file=sys.stderr)
        sys.exit(2)
    exe = Path(sys.argv[1])
    if not exe.exists():
        print(f"not found: {exe}", file=sys.stderr)
        sys.exit(1)
    keep = "--keep-marker" in sys.argv
    try:
        result = strip(exe, keep=keep)
    except SystemExit as e:
        raise
    if result["stripped"]:
        print(
            f"[strip-signature] stripped {result['size']}-byte Authenticode "
            f"sig (RVA 0x{result['rva']:08X}) from {exe.name}, "
            f"new CheckSum=0x{result['new_checksum']:08X}"
        )
    else:
        print(f"[strip-signature] {exe.name}: {result['reason']}, no action taken")