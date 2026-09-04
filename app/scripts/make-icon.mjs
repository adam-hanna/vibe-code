// Draw the app icon, so it is a file the repo can regenerate rather than a
// binary somebody once exported.
//
// `tauri icon` derives every size and format from one square PNG, but it does
// not draw one - and a bundle will not build without icons at all. So this
// writes the source: the mark from the design system, in its own tokens.
//
// Deliberately zero dependencies, like `contrast.mjs` beside it. `zlib` is in
// Node and a PNG is four chunks; a raster library for one 1024px square would be
// the largest dependency in the app.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 1024;

// Straight out of tokens.css. The icon is the one piece of the design that is
// rendered by something other than the browser, so the values are repeated here
// rather than imported - and named, so the next person can see they match.
const SURFACE_APP = [0x0e, 0x10, 0x12]; // --surface-app
const ACCENT_SOLID = [0x94, 0xbc, 0xe3]; // --accent-solid
const ACCENT_BASE = [0x59, 0x80, 0xa6]; // --accent-base

/** The loop, as three bars of decreasing length: plan, implement, review. */
const BARS = [
  { top: 0.3, height: 0.075, left: 0.22, width: 0.56, colour: ACCENT_SOLID },
  { top: 0.4625, height: 0.075, left: 0.22, width: 0.4, colour: ACCENT_BASE },
  { top: 0.625, height: 0.075, left: 0.22, width: 0.24, colour: ACCENT_BASE },
];

const px = (v) => Math.round(v * SIZE);

function raster() {
  // One filter byte per row (0 = none), then RGBA.
  const stride = 1 + SIZE * 4;
  const buf = Buffer.alloc(stride * SIZE);
  for (let y = 0; y < SIZE; y++) {
    const row = y * stride;
    for (let x = 0; x < SIZE; x++) {
      let colour = SURFACE_APP;
      for (const bar of BARS) {
        if (
          y >= px(bar.top) &&
          y < px(bar.top + bar.height) &&
          x >= px(bar.left) &&
          x < px(bar.left + bar.width)
        ) {
          colour = bar.colour;
          break;
        }
      }
      const at = row + 1 + x * 4;
      buf[at] = colour[0];
      buf[at + 1] = colour[1];
      buf[at + 2] = colour[2];
      buf[at + 3] = 0xff;
    }
  }
  return buf;
}

const CRC = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return (buf) => {
    let c = -1;
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // truecolour with alpha
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raster(), { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '..', 'src-tauri', 'icon-source.png');
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`${path.relative(path.resolve(here, '..'), out)}  ${SIZE}x${SIZE}  ${png.length} bytes`);
console.log('now: npm run tauri -- icon src-tauri/icon-source.png');
