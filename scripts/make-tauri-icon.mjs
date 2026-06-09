import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const PNG_SIZES = [32, 128, 256, 512, 1024];
const SUPERSAMPLE = 4;

const colors = {
  primary: [37, 99, 235, 255],
  medium: [55, 138, 221, 255],
  side: [91, 157, 226, 255],
  light: [133, 183, 235, 255],
  highlight: [181, 212, 244, 255],
  pale: [230, 241, 251, 255],
  appBg: [248, 249, 252, 255],
  appStroke: [216, 233, 250, 255],
  white: [255, 255, 255, 255],
};

function createCanvas(size) {
  return {
    size,
    data: new Uint8ClampedArray(size * size * 4),
  };
}

function setPixel(canvas, x, y, rgba) {
  if (x < 0 || y < 0 || x >= canvas.size || y >= canvas.size) return;
  const index = (y * canvas.size + x) * 4;
  const sourceAlpha = rgba[3] / 255;
  if (sourceAlpha >= 1) {
    canvas.data[index] = rgba[0];
    canvas.data[index + 1] = rgba[1];
    canvas.data[index + 2] = rgba[2];
    canvas.data[index + 3] = rgba[3];
    return;
  }

  const destAlpha = canvas.data[index + 3] / 255;
  const outAlpha = sourceAlpha + destAlpha * (1 - sourceAlpha);
  if (outAlpha <= 0) return;

  canvas.data[index] = Math.round((rgba[0] * sourceAlpha + canvas.data[index] * destAlpha * (1 - sourceAlpha)) / outAlpha);
  canvas.data[index + 1] = Math.round((rgba[1] * sourceAlpha + canvas.data[index + 1] * destAlpha * (1 - sourceAlpha)) / outAlpha);
  canvas.data[index + 2] = Math.round((rgba[2] * sourceAlpha + canvas.data[index + 2] * destAlpha * (1 - sourceAlpha)) / outAlpha);
  canvas.data[index + 3] = Math.round(outAlpha * 255);
}

function parseHex(hex) {
  const value = hex.replace("#", "");
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
    255,
  ];
}

function pointInPolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i][0];
    const yi = points[i][1];
    const xj = points[j][0];
    const yj = points[j][1];
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function fillPolygon(canvas, points, rgba) {
  const minX = Math.max(0, Math.floor(Math.min(...points.map((point) => point[0]))));
  const maxX = Math.min(canvas.size - 1, Math.ceil(Math.max(...points.map((point) => point[0]))));
  const minY = Math.max(0, Math.floor(Math.min(...points.map((point) => point[1]))));
  const maxY = Math.min(canvas.size - 1, Math.ceil(Math.max(...points.map((point) => point[1]))));

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (pointInPolygon(x + 0.5, y + 0.5, points)) setPixel(canvas, x, y, rgba);
    }
  }
}

function fillRoundedRect(canvas, x, y, width, height, radius, rgba) {
  const x2 = x + width;
  const y2 = y + height;
  const minX = Math.max(0, Math.floor(x));
  const maxX = Math.min(canvas.size - 1, Math.ceil(x2));
  const minY = Math.max(0, Math.floor(y));
  const maxY = Math.min(canvas.size - 1, Math.ceil(y2));

  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      const cx = px + 0.5;
      const cy = py + 0.5;
      const qx = Math.max(x + radius, Math.min(cx, x2 - radius));
      const qy = Math.max(y + radius, Math.min(cy, y2 - radius));
      const dx = cx - qx;
      const dy = cy - qy;
      if (dx * dx + dy * dy <= radius * radius) setPixel(canvas, px, py, rgba);
    }
  }
}

function strokeRoundedRect(canvas, x, y, width, height, radius, strokeWidth, rgba) {
  const x2 = x + width;
  const y2 = y + height;
  const minX = Math.max(0, Math.floor(x));
  const maxX = Math.min(canvas.size - 1, Math.ceil(x2));
  const minY = Math.max(0, Math.floor(y));
  const maxY = Math.min(canvas.size - 1, Math.ceil(y2));

  const insideRoundedRect = (px, py, rx, ry, rw, rh, rr) => {
    const rx2 = rx + rw;
    const ry2 = ry + rh;
    const qx = Math.max(rx + rr, Math.min(px, rx2 - rr));
    const qy = Math.max(ry + rr, Math.min(py, ry2 - rr));
    const dx = px - qx;
    const dy = py - qy;
    return dx * dx + dy * dy <= rr * rr;
  };

  const innerX = x + strokeWidth;
  const innerY = y + strokeWidth;
  const innerWidth = width - strokeWidth * 2;
  const innerHeight = height - strokeWidth * 2;
  const innerRadius = Math.max(0, radius - strokeWidth);

  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      const cx = px + 0.5;
      const cy = py + 0.5;
      const inOuter = insideRoundedRect(cx, cy, x, y, width, height, radius);
      const inInner = innerWidth > 0 && innerHeight > 0 && insideRoundedRect(cx, cy, innerX, innerY, innerWidth, innerHeight, innerRadius);
      if (inOuter && !inInner) setPixel(canvas, px, py, rgba);
    }
  }
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  if (dx === 0 && dy === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function strokePolyline(canvas, points, strokeWidth, rgba) {
  const radius = strokeWidth / 2;
  const minX = Math.max(0, Math.floor(Math.min(...points.map((point) => point[0])) - radius - 1));
  const maxX = Math.min(canvas.size - 1, Math.ceil(Math.max(...points.map((point) => point[0])) + radius + 1));
  const minY = Math.max(0, Math.floor(Math.min(...points.map((point) => point[1])) - radius - 1));
  const maxY = Math.min(canvas.size - 1, Math.ceil(Math.max(...points.map((point) => point[1])) + radius + 1));

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let minDistance = Number.POSITIVE_INFINITY;
      for (let i = 0; i < points.length - 1; i++) {
        minDistance = Math.min(minDistance, distanceToSegment(px, py, points[i][0], points[i][1], points[i + 1][0], points[i + 1][1]));
      }
      if (minDistance <= radius) setPixel(canvas, x, y, rgba);
    }
  }
}

function scalePoints(points, transform) {
  return points.map(([x, y]) => [transform.x + x * transform.scale, transform.y + y * transform.scale]);
}

function drawMainLogo(canvas, transform) {
  const polygon = (points, rgba) => fillPolygon(canvas, scalePoints(points, transform), rgba);
  const line = (points, width, rgba) => strokePolyline(canvas, scalePoints(points, transform), width * transform.scale, rgba);

  polygon([[50, 4], [80, 22], [50, 40], [20, 22]], colors.light);
  polygon([[50, 4], [80, 22], [80, 34], [50, 16]], colors.highlight);
  polygon([[50, 4], [20, 22], [20, 34], [50, 16]], colors.pale);
  line([[38, 20], [46, 28], [62, 12]], 3, colors.white);

  polygon([[50, 36], [90, 60], [50, 84], [10, 60]], colors.medium);
  polygon([[50, 36], [90, 60], [90, 76], [50, 52]], colors.side);
  polygon([[50, 36], [10, 60], [10, 76], [50, 52]], colors.light);

  polygon([[50, 72], [100, 102], [50, 128], [0, 102]], colors.primary);
  polygon([[50, 72], [100, 102], [100, 118], [50, 86]], colors.medium);
  polygon([[50, 72], [0, 102], [0, 118], [50, 86]], colors.side);
}

function drawFavicon(canvas) {
  const s = canvas.size / 24;
  fillRoundedRect(canvas, 0, 0, canvas.size, canvas.size, 4 * s, colors.primary);
  fillRoundedRect(canvas, 2 * s, 2 * s, 20 * s, 6 * s, 1 * s, colors.light);
  fillRoundedRect(canvas, 4 * s, 10 * s, 16 * s, 6 * s, 1 * s, colors.medium);
  fillRoundedRect(canvas, 6 * s, 18 * s, 12 * s, 4 * s, 1 * s, colors.pale);
}

function drawAppIcon(canvas) {
  const scale = canvas.size / 256;
  fillRoundedRect(canvas, 8 * scale, 8 * scale, 240 * scale, 240 * scale, 54 * scale, colors.appBg);
  strokeRoundedRect(canvas, 8 * scale, 8 * scale, 240 * scale, 240 * scale, 54 * scale, 6 * scale, colors.appStroke);
  drawMainLogo(canvas, {
    x: 58 * scale,
    y: 32 * scale,
    scale: 1.4 * scale,
  });
}

function renderIcon(size) {
  const highSize = size * SUPERSAMPLE;
  const high = createCanvas(highSize);
  if (size < 32) {
    drawFavicon(high);
  } else {
    drawAppIcon(high);
  }
  return downsample(high, size, SUPERSAMPLE);
}

function downsample(source, size, factor) {
  const target = createCanvas(size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < factor; sy++) {
        for (let sx = 0; sx < factor; sx++) {
          const sourceIndex = ((y * factor + sy) * source.size + (x * factor + sx)) * 4;
          r += source.data[sourceIndex];
          g += source.data[sourceIndex + 1];
          b += source.data[sourceIndex + 2];
          a += source.data[sourceIndex + 3];
        }
      }
      const count = factor * factor;
      const targetIndex = (y * size + x) * 4;
      target.data[targetIndex] = Math.round(r / count);
      target.data[targetIndex + 1] = Math.round(g / count);
      target.data[targetIndex + 2] = Math.round(b / count);
      target.data[targetIndex + 3] = Math.round(a / count);
    }
  }
  return target.data;
}

function createDib(size, rgba) {
  const bytesPerPixel = 4;
  const xorBytes = size * size * bytesPerPixel;
  const maskStride = Math.ceil(size / 32) * 4;
  const andBytes = size * maskStride;
  const dibSize = 40 + xorBytes + andBytes;
  const buffer = Buffer.alloc(dibSize);

  let offset = 0;
  buffer.writeUInt32LE(40, offset);
  offset += 4;
  buffer.writeInt32LE(size, offset);
  offset += 4;
  buffer.writeInt32LE(size * 2, offset);
  offset += 4;
  buffer.writeUInt16LE(1, offset);
  offset += 2;
  buffer.writeUInt16LE(32, offset);
  offset += 2;
  buffer.writeUInt32LE(0, offset);
  offset += 4;
  buffer.writeUInt32LE(xorBytes, offset);
  offset += 4;
  buffer.writeInt32LE(0, offset);
  offset += 4;
  buffer.writeInt32LE(0, offset);
  offset += 4;
  buffer.writeUInt32LE(0, offset);
  offset += 4;
  buffer.writeUInt32LE(0, offset);
  offset += 4;

  for (let y = size - 1; y >= 0; y--) {
    for (let x = 0; x < size; x++) {
      const index = (y * size + x) * 4;
      buffer.writeUInt8(rgba[index + 2], offset++);
      buffer.writeUInt8(rgba[index + 1], offset++);
      buffer.writeUInt8(rgba[index], offset++);
      buffer.writeUInt8(rgba[index + 3], offset++);
    }
  }

  const maskStart = offset;
  for (let y = size - 1; y >= 0; y--) {
    for (let x = 0; x < size; x++) {
      const index = (y * size + x) * 4;
      if (rgba[index + 3] < 128) {
        const row = size - 1 - y;
        const byteIndex = maskStart + row * maskStride + Math.floor(x / 8);
        buffer[byteIndex] |= 0x80 >> (x % 8);
      }
    }
  }

  return buffer;
}

function createIco(entries) {
  const headerSize = 6 + entries.length * 16;
  const fileSize = headerSize + entries.reduce((sum, entry) => sum + entry.dib.length, 0);
  const buffer = Buffer.alloc(fileSize);
  let offset = 0;

  buffer.writeUInt16LE(0, offset);
  offset += 2;
  buffer.writeUInt16LE(1, offset);
  offset += 2;
  buffer.writeUInt16LE(entries.length, offset);
  offset += 2;

  let imageOffset = headerSize;
  for (const entry of entries) {
    buffer.writeUInt8(entry.size === 256 ? 0 : entry.size, offset++);
    buffer.writeUInt8(entry.size === 256 ? 0 : entry.size, offset++);
    buffer.writeUInt8(0, offset++);
    buffer.writeUInt8(0, offset++);
    buffer.writeUInt16LE(1, offset);
    offset += 2;
    buffer.writeUInt16LE(32, offset);
    offset += 2;
    buffer.writeUInt32LE(entry.dib.length, offset);
    offset += 4;
    buffer.writeUInt32LE(imageOffset, offset);
    offset += 4;
    entry.dib.copy(buffer, imageOffset);
    imageOffset += entry.dib.length;
  }

  return buffer;
}

const crcTable = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  crcTable[index] = crc >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBuffer = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return chunk;
}

function createPng(size, rgba) {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(6, 9);
  ihdr.writeUInt8(0, 10);
  ihdr.writeUInt8(0, 11);
  ihdr.writeUInt8(0, 12);

  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < size; x += 1) {
      const source = (y * size + x) * 4;
      const target = rowStart + 1 + x * 4;
      raw[target] = rgba[source];
      raw[target + 1] = rgba[source + 1];
      raw[target + 2] = rgba[source + 2];
      raw[target + 3] = rgba[source + 3];
    }
  }

  return Buffer.concat([
    header,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND"),
  ]);
}

const entries = ICO_SIZES.map((size) => ({
  size,
  dib: createDib(size, renderIcon(size)),
}));
const buffer = createIco(entries);
const iconDir = resolve(import.meta.dirname, "..", "src-tauri", "icons");

mkdirSync(iconDir, { recursive: true });
writeFileSync(resolve(iconDir, "icon.ico"), buffer);
for (const size of PNG_SIZES) {
  const png = createPng(size, renderIcon(size));
  const fileName = size === 256 ? "128x128@2x.png" : size === 1024 ? "icon.png" : `${size}x${size}.png`;
  writeFileSync(resolve(iconDir, fileName), png);
}
console.log(`WROTE src-tauri/icons/icon.ico (${ICO_SIZES.join(", ")} px)`);
console.log(`WROTE src-tauri/icons PNG assets (${PNG_SIZES.join(", ")} px)`);
