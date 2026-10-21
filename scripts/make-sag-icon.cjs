/* Generate the SAG app icon: black background + a knowledge-graph mark
 * (one hub node wired to orbiting entity nodes).
 *
 * Emits one PNG per size and packs them into a multi-resolution .ico.
 * Written with a hand-rolled PNG encoder + zlib so the build has no
 * native canvas dependency (the SEA bundle can't load one anyway).
 *
 * Usage: node scripts/make-sag-icon.cjs [outPath]
 */
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const OUT = process.argv[2] || path.join(__dirname, "..", "web", "public", "favicon.ico");
const SIZES = [16, 24, 32, 48, 64, 128, 256];

/* ---- minimal RGBA canvas ------------------------------------------- */
class Canvas {
  constructor(n) {
    this.n = n;
    this.px = new Uint8Array(n * n * 4); // RGBA, transparent
  }
  idx(x, y) {
    return (y * this.n + x) * 4;
  }
  blend(x, y, [r, g, b], a) {
    if (a <= 0 || x < 0 || y < 0 || x >= this.n || y >= this.n) return;
    const i = this.idx(x, y);
    const dst = this.px;
    const da = dst[i + 3] / 255;
    const outA = a + da * (1 - a);
    if (outA <= 0) return;
    dst[i] = (r * a + dst[i] * da * (1 - a)) / outA;
    dst[i + 1] = (g * a + dst[i + 1] * da * (1 - a)) / outA;
    dst[i + 2] = (b * a + dst[i + 2] * da * (1 - a)) / outA;
    dst[i + 3] = outA * 255;
  }
  /* vertical gradient background with rounded-square mask */
  background(r0, g0, b0, r1, g1, b1) {
    const n = this.n;
    const radius = n * 0.22; // squircle-ish, matches Windows icon conventions
    for (let y = 0; y < n; y++) {
      const t = y / (n - 1);
      const r = r0 + (r1 - r0) * t;
      const g = g0 + (g1 - g0) * t;
      const b = b0 + (b1 - b0) * t;
      for (let x = 0; x < n; x++) {
        // rounded-corner coverage via signed distance
        const cx = Math.min(x, n - 1 - x);
        const cy = Math.min(y, n - 1 - y);
        let cov = 1;
        if (cx < radius && cy < radius) {
          const dx = radius - cx;
          const dy = radius - cy;
          const d = Math.hypot(dx, dy) - radius;
          cov = Math.max(0, Math.min(1, 0.5 - d));
        }
        if (cov > 0) this.blend(x, y, [r, g, b], cov);
      }
    }
  }
  disc(cx, cy, rad, color, alpha = 1, softEdge = 1.2) {
    const n = this.n;
    const x0 = Math.max(0, Math.floor(cx - rad - 2));
    const x1 = Math.min(n - 1, Math.ceil(cx + rad + 2));
    const y0 = Math.max(0, Math.floor(cy - rad - 2));
    const y1 = Math.min(n - 1, Math.ceil(cy + rad + 2));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x - cx, y - cy);
        const a = Math.max(0, Math.min(1, (rad - d) / softEdge + 0.5));
        if (a > 0) this.blend(x, y, color, a * alpha);
      }
    }
  }
  /* line segment with antialiased caps */
  line(x0, y0, x1, y1, width, color, alpha = 1) {
    const n = this.n;
    const half = width / 2;
    const minX = Math.max(0, Math.floor(Math.min(x0, x1) - half - 2));
    const maxX = Math.min(n - 1, Math.ceil(Math.max(x0, x1) + half + 2));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1) - half - 2));
    const maxY = Math.min(n - 1, Math.ceil(Math.max(y0, y1) + half + 2));
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len2 = dx * dx + dy * dy || 1;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const px = x - x0;
        const py = y - y0;
        let t = (px * dx + py * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        const cx = x0 + t * dx;
        const cy = y0 + t * dy;
        const d = Math.hypot(x - cx, y - cy);
        const a = Math.max(0, Math.min(1, (half - d) / 1.2 + 0.5));
        if (a > 0) this.blend(x, y, color, a * alpha);
      }
    }
  }
  toPng() {
    const n = this.n;
    // PNG scanlines with filter byte 0
    const raw = Buffer.alloc(n * (n * 4 + 1));
    for (let y = 0; y < n; y++) {
      raw[y * (n * 4 + 1)] = 0;
      Buffer.from(this.px.buffer, y * n * 4, n * 4).copy(raw, y * (n * 4 + 1) + 1);
    }
    const idat = zlib.deflateSync(raw, { level: 9 });
    const chunks = [];
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    function crc32(buf) {
      let c = ~0;
      for (let i = 0; i < buf.length; i++) {
        c ^= buf[i];
        for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
      }
      return ~c >>> 0;
    }
    function chunk(type, data) {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(td));
      return Buffer.concat([len, td, crc]);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(n, 0);
    ihdr.writeUInt32BE(n, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // RGBA
    return Buffer.concat([
      sig,
      chunk("IHDR", ihdr),
      chunk("IDAT", idat),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  }
}

/* ---- the mark ------------------------------------------------------ */
const ACCENT = [88, 166, 255]; // SAG blue
const ACCENT_DIM = [58, 110, 178];
const HUB = [236, 244, 255]; // near-white hub

function draw(size) {
  const c = new Canvas(size);
  // near-black vertical gradient, slight blue lift at the bottom
  c.background(6, 8, 14, 14, 20, 34);

  const cx = size / 2;
  const cy = size / 2;
  // Detail scales with size: at 16px there is no room for strokes, so
  // draw solid pixels instead of sub-pixel lines.
  const tiny = size <= 24;
  const ring = size * 0.29;
  const hubR = tiny ? size * 0.17 : size * 0.115;
  const nodeR = tiny ? size * 0.085 : size * 0.072;
  const stroke = tiny ? Math.max(1, size * 0.075) : size * 0.038;

  // six satellites at varied angles + radii -> reads as a graph, not a wheel
  const nodes = [];
  const angles = [-90, -30, 30, 90, 150, 210];
  const radii = [1, 0.94, 1.02, 0.96, 1, 0.94];
  for (let i = 0; i < angles.length; i++) {
    const a = (angles[i] * Math.PI) / 180;
    const r = ring * radii[i];
    nodes.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }

  // spokes first (behind the nodes)
  for (const [x, y] of nodes) {
    c.line(cx, cy, x, y, stroke, ACCENT_DIM, tiny ? 0.9 : 0.75);
  }
  // ring chord between adjacent satellites -> the "knowledge graph" weave
  for (let i = 0; i < nodes.length; i++) {
    const [x0, y0] = nodes[i];
    const [x1, y1] = nodes[(i + 1) % nodes.length];
    c.line(x0, y0, x1, y1, stroke * 0.62, ACCENT_DIM, tiny ? 0.45 : 0.34);
  }
  // satellites
  for (const [x, y] of nodes) c.disc(x, y, nodeR, ACCENT, 1, tiny ? 0.9 : 1.1);
  // hub last, brightest, with a soft halo so it reads as the focal point
  if (!tiny) {
    c.disc(cx, cy, hubR * 2.1, ACCENT, 0.1, hubR * 1.6);
    c.disc(cx, cy, hubR * 1.35, ACCENT, 0.28, hubR * 0.5);
  }
  c.disc(cx, cy, hubR, HUB, 1, tiny ? 0.9 : 1.1);
  return c;
}

/* ---- .ico container ------------------------------------------------ */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + 16 * entries.length;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir[o] = e.size >= 256 ? 0 : e.size;
    dir[o + 1] = e.size >= 256 ? 0 : e.size;
    dir[o + 2] = 0; // palette
    dir[o + 3] = 0; // reserved
    dir.writeUInt16LE(1, o + 4); // color planes
    dir.writeUInt16LE(32, o + 6); // bits per pixel
    dir.writeUInt32LE(e.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

const entries = SIZES.map((size) => ({ size, png: draw(size).toPng() }));
fs.writeFileSync(OUT, buildIco(entries));
console.log(`✓ ${OUT} (${fs.statSync(OUT).size} bytes, sizes: ${SIZES.join(", ")})`);
// also drop a 256px PNG next to it for high-dpi use
const pngOut = path.join(path.dirname(OUT), "sag-icon-256.png");
fs.writeFileSync(pngOut, entries[entries.length - 1].png);
console.log(`✓ ${pngOut}`);