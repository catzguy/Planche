/** Visible part of a page, as fractions of its width and height. */
export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}

const SAMPLE_WIDTH = 240;
/** Summed RGB distance above which a pixel no longer counts as margin. */
const COLOR_TOLERANCE = 60;
/** Share of off-colour pixels a margin line may contain (scan noise, specks). */
const NOISE = 0.02;
/** Never trim more than this from one side. */
const MAX_SIDE = 0.25;
/** Below this, cropping is not worth it. */
const MIN_GAIN = 0.01;

/**
 * Finds uniform margins (white, black or any flat colour) around a page.
 * Each side is trimmed independently, using that side's outer line as the
 * margin colour, so art bleeding off one edge leaves that edge untouched.
 * Returns null when there is nothing worth trimming or the image is unreadable.
 */
export function detectCrop(img: HTMLImageElement): Crop | null {
  const W = Math.min(SAMPLE_WIDTH, img.naturalWidth);
  const H = Math.max(1, Math.round((W * img.naturalHeight) / img.naturalWidth));
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  let data: Uint8ClampedArray;
  try {
    ctx.drawImage(img, 0, 0, W, H);
    data = ctx.getImageData(0, 0, W, H).data;
  } catch {
    return null; // tainted canvas
  }
  const px = (x: number, y: number) => (y * W + x) * 4;

  // A line is "margin" if nearly all its pixels match the reference colour.
  const lineColor = (points: [number, number][]) => {
    const c = [0, 0, 0];
    for (const [x, y] of points) for (let k = 0; k < 3; k++) c[k] += data[px(x, y) + k];
    return c.map((v) => v / points.length);
  };
  const isMargin = (points: [number, number][], ref: number[]) => {
    let off = 0;
    for (const [x, y] of points) {
      const i = px(x, y);
      if (Math.abs(data[i] - ref[0]) + Math.abs(data[i + 1] - ref[1]) + Math.abs(data[i + 2] - ref[2]) > COLOR_TOLERANCE)
        off++;
    }
    return off <= points.length * NOISE;
  };
  const row = (y: number, x0 = 0, x1 = W) => Array.from({ length: x1 - x0 }, (_, i) => [x0 + i, y] as [number, number]);
  const col = (x: number, y0 = 0, y1 = H) => Array.from({ length: y1 - y0 }, (_, i) => [x, y0 + i] as [number, number]);

  const trim = (line: (i: number) => [number, number][], limit: number) => {
    const ref = lineColor(line(0));
    if (!isMargin(line(0), ref)) return 0;
    let n = 0;
    while (n < limit && isMargin(line(n), ref)) n++;
    return n;
  };

  const top = trim((i) => row(i), Math.floor(H * MAX_SIDE));
  const bottom = trim((i) => row(H - 1 - i), Math.floor(H * MAX_SIDE));
  const left = trim((i) => col(i, top, H - bottom), Math.floor(W * MAX_SIDE));
  const right = trim((i) => col(W - 1 - i, top, H - bottom), Math.floor(W * MAX_SIDE));

  // Keep one sample pixel of margin so anti-aliased edges are not clipped.
  const pad = (n: number) => Math.max(0, n - 1);
  const crop = {
    x: pad(left) / W,
    y: pad(top) / H,
    w: (W - pad(left) - pad(right)) / W,
    h: (H - pad(top) - pad(bottom)) / H,
  };
  return 1 - crop.w * crop.h < MIN_GAIN ? null : crop;
}
