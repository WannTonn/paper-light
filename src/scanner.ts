import cvImport from "@techstark/opencv-js";

export type Point = { x: number; y: number };
export type ScanMode = "color" | "gray" | "bw" | "original";

export interface EnhanceOptions {
  mode: ScanMode;
  flatten: number;
  whiten: number;
  contrast: number;
  sharpness: number;
}

let cvPromise: Promise<any> | null = null;

export function getCv(): Promise<any> {
  if (!cvPromise) {
    cvPromise = Promise.resolve(cvImport).then((cv: any) => {
      if (cv?.Mat) return cv;
      return new Promise((resolve) => {
        cv.onRuntimeInitialized = () => resolve(cv);
      });
    });
  }
  return cvPromise;
}

export function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("无法读取图片"));
    image.src = source;
  });
}

export function imageToCanvas(image: HTMLImageElement, maxSide = 0): HTMLCanvasElement {
  const scale = maxSide > 0 ? Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight)) : 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  canvas.getContext("2d", { alpha: false })!.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export async function detectDocument(image: HTMLImageElement): Promise<Point[]> {
  const cv = await getCv();
  const preview = imageToCanvas(image, 1400);
  const scaleX = image.naturalWidth / preview.width;
  const scaleY = image.naturalHeight / preview.height;
  const src = cv.imread(preview);
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const edges = new cv.Mat();
  const closed = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7));

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    cv.Canny(blurred, edges, 45, 135);
    cv.morphologyEx(edges, closed, cv.MORPH_CLOSE, kernel);
    cv.findContours(closed, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    let best: Point[] | null = null;
    let bestArea = 0;
    const minArea = preview.width * preview.height * 0.16;

    for (let i = 0; i < contours.size(); i += 1) {
      const contour = contours.get(i);
      const area = Math.abs(cv.contourArea(contour));
      if (area < minArea || area <= bestArea) {
        contour.delete();
        continue;
      }
      const perimeter = cv.arcLength(contour, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(contour, approx, perimeter * 0.025, true);
      if (approx.rows === 4 && cv.isContourConvex(approx)) {
        const points: Point[] = [];
        for (let j = 0; j < 4; j += 1) {
          points.push({
            x: approx.data32S[j * 2] * scaleX,
            y: approx.data32S[j * 2 + 1] * scaleY,
          });
        }
        best = orderPoints(points);
        bestArea = area;
      }
      approx.delete();
      contour.delete();
    }

    return best ?? insetCorners(image.naturalWidth, image.naturalHeight);
  } finally {
    src.delete();
    gray.delete();
    blurred.delete();
    edges.delete();
    closed.delete();
    contours.delete();
    hierarchy.delete();
    kernel.delete();
  }
}

export function insetCorners(width: number, height: number): Point[] {
  const insetX = width * 0.025;
  const insetY = height * 0.02;
  return [
    { x: insetX, y: insetY },
    { x: width - insetX, y: insetY },
    { x: width - insetX, y: height - insetY },
    { x: insetX, y: height - insetY },
  ];
}

export function orderPoints(points: Point[]): Point[] {
  const bySum = [...points].sort((a, b) => a.x + a.y - (b.x + b.y));
  const topLeft = bySum[0];
  const bottomRight = bySum[3];
  const rest = bySum.slice(1, 3).sort((a, b) => a.y - a.x - (b.y - b.x));
  return [topLeft, rest[0], bottomRight, rest[1]];
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export async function renderScan(
  image: HTMLImageElement,
  corners: Point[],
  options: EnhanceOptions,
): Promise<HTMLCanvasElement> {
  const cv = await getCv();
  const sourceCanvas = imageToCanvas(image);
  const ordered = orderPoints(corners);
  const width = Math.max(distance(ordered[0], ordered[1]), distance(ordered[3], ordered[2]));
  const height = Math.max(distance(ordered[0], ordered[3]), distance(ordered[1], ordered[2]));
  const outputWidth = Math.max(64, Math.round(width));
  const outputHeight = Math.max(64, Math.round(height));

  const src = cv.imread(sourceCanvas);
  const warped = new cv.Mat();
  const srcPoints = cv.matFromArray(4, 1, cv.CV_32FC2, ordered.flatMap((point) => [point.x, point.y]));
  const dstPoints = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0,
    outputWidth - 1, 0,
    outputWidth - 1, outputHeight - 1,
    0, outputHeight - 1,
  ]);
  const transform = cv.getPerspectiveTransform(srcPoints, dstPoints);

  try {
    cv.warpPerspective(
      src,
      warped,
      transform,
      new cv.Size(outputWidth, outputHeight),
      cv.INTER_CUBIC,
      cv.BORDER_REPLICATE,
    );
    const flattened = flattenPage(cv, warped, options.flatten);
    const result = options.mode === "original" ? flattened.clone() : enhance(cv, flattened, options);
    const canvas = document.createElement("canvas");
    canvas.width = outputWidth;
    canvas.height = outputHeight;
    cv.imshow(canvas, result);
    result.delete();
    flattened.delete();
    return canvas;
  } finally {
    src.delete();
    warped.delete();
    srcPoints.delete();
    dstPoints.delete();
    transform.delete();
  }
}

/**
 * Straighten the gentle vertical bow commonly seen when photographing a book.
 * We estimate how horizontal ink rows drift across narrow vertical bands, fit a
 * smooth quadratic surface to those offsets, then remap the page column by
 * column. A confidence gate keeps ordinary flat documents unchanged.
 */
function flattenPage(cv: any, rgba: any, amount: number): any {
  if (amount <= 0 || rgba.cols < 240 || rgba.rows < 240) return rgba.clone();

  const scale = Math.min(1, 720 / Math.max(rgba.cols, rgba.rows));
  const sampleWidth = Math.max(160, Math.round(rgba.cols * scale));
  const sampleHeight = Math.max(160, Math.round(rgba.rows * scale));
  const small = new cv.Mat();
  const gray = new cv.Mat();
  cv.resize(rgba, small, new cv.Size(sampleWidth, sampleHeight), 0, 0, cv.INTER_AREA);
  cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);

  try {
    const bandCount = 19;
    const zoneCount = 9;
    const cellCount = bandCount * zoneCount;
    const slopes = new Array<number>(cellCount).fill(0);
    const weights = new Array<number>(cellCount).fill(0);
    const marginY = Math.max(2, Math.round(sampleHeight * 0.04));
    for (let y = marginY; y < sampleHeight - marginY; y += 1) {
      for (let x = 2; x < sampleWidth - 2; x += 1) {
        const gx = gray.data[y * sampleWidth + x + 1] - gray.data[y * sampleWidth + x - 1];
        const gy = gray.data[(y + 1) * sampleWidth + x] - gray.data[(y - 1) * sampleWidth + x];
        const verticalStrength = Math.abs(gy);
        if (verticalStrength < 14 || Math.abs(gx) > verticalStrength * 0.48) continue;
        const band = Math.min(bandCount - 1, Math.floor(x / sampleWidth * bandCount));
        const zone = Math.min(zoneCount - 1, Math.floor(y / sampleHeight * zoneCount));
        const cell = zone * bandCount + band;
        const weight = verticalStrength * verticalStrength;
        slopes[cell] += (-gx / gy) * weight;
        weights[cell] += weight;
      }
    }
    for (let cell = 0; cell < cellCount; cell += 1) {
      if (weights[cell] > 0) slopes[cell] /= weights[cell];
    }

    // Fit a smooth slope field over both page axes. Integrating that field
    // horizontally produces a mesh that can correct curl whose strength varies
    // from the top of a page to the bottom (typical near a book spine).
    const normal = Array.from({ length: 4 }, () => new Array<number>(4).fill(0));
    const target = new Array<number>(4).fill(0);
    const totalWeight = weights.reduce((sum, value) => sum + value, 0);
    let usefulCells = 0;
    for (let zone = 0; zone < zoneCount; zone += 1) {
      for (let band = 0; band < bandCount; band += 1) {
        const cell = zone * bandCount + band;
        if (weights[cell] <= 0) continue;
        usefulCells += 1;
        const nx = bandCount <= 1 ? 0 : band / (bandCount - 1) * 2 - 1;
        const ny = zoneCount <= 1 ? 0 : zone / (zoneCount - 1) * 2 - 1;
        const features = [1, nx, ny, nx * ny];
        const weight = Math.min(weights[cell], totalWeight / cellCount * 3.5);
        for (let row = 0; row < 4; row += 1) {
          target[row] += weight * features[row] * slopes[cell];
          for (let column = 0; column < 4; column += 1) {
            normal[row][column] += weight * features[row] * features[column];
          }
        }
      }
    }
    if (usefulCells < cellCount * 0.22) return rgba.clone();
    const coefficients = solveLinearSystem(normal, target);
    if (!coefficients) return rgba.clone();

    const strength = amount / 100;
    const sampleToFullY = rgba.rows / sampleHeight;
    const [c0, c1, c2, c3] = coefficients;
    const rowX = new cv.Mat(1, rgba.cols, cv.CV_32FC1);
    const rowBase = new cv.Mat(1, rgba.cols, cv.CV_32FC1);
    const rowVertical = new cv.Mat(1, rgba.cols, cv.CV_32FC1);
    let maxCurve = 1;
    for (let x = 0; x < rgba.cols; x += 1) {
      const nx = rgba.cols <= 1 ? 0 : x / (rgba.cols - 1) * 2 - 1;
      const base = sampleWidth / 2 * (c0 * nx + c1 * 0.5 * (nx * nx - 1));
      const vertical = sampleWidth / 2 * (c2 * nx + c3 * 0.5 * (nx * nx - 1));
      rowX.data32F[x] = x;
      rowBase.data32F[x] = base;
      rowVertical.data32F[x] = vertical;
      maxCurve = Math.max(maxCurve, Math.abs(base - vertical), Math.abs(base + vertical));
    }
    const curveLimit = sampleHeight * 0.06;
    const curveScale = strength * sampleToFullY * Math.min(1, curveLimit / maxCurve);
    rowBase.convertTo(rowBase, cv.CV_32FC1, curveScale);
    rowVertical.convertTo(rowVertical, cv.CV_32FC1, curveScale);

    const columnY = new cv.Mat(rgba.rows, 1, cv.CV_32FC1);
    const columnNormalizedY = new cv.Mat(rgba.rows, 1, cv.CV_32FC1);
    for (let y = 0; y < rgba.rows; y += 1) {
      columnY.data32F[y] = y;
      columnNormalizedY.data32F[y] = rgba.rows <= 1 ? 0 : y / (rgba.rows - 1) * 2 - 1;
    }

    const mapX = new cv.Mat();
    const mapY = new cv.Mat();
    const baseCurve = new cv.Mat();
    const verticalCurve = new cv.Mat();
    const normalizedY = new cv.Mat();
    cv.repeat(rowX, rgba.rows, 1, mapX);
    cv.repeat(columnY, 1, rgba.cols, mapY);
    cv.repeat(rowBase, rgba.rows, 1, baseCurve);
    cv.repeat(rowVertical, rgba.rows, 1, verticalCurve);
    cv.repeat(columnNormalizedY, 1, rgba.cols, normalizedY);
    cv.multiply(verticalCurve, normalizedY, verticalCurve);
    cv.add(mapY, baseCurve, mapY);
    cv.add(mapY, verticalCurve, mapY);

    const result = new cv.Mat();
    cv.remap(rgba, result, mapX, mapY, cv.INTER_CUBIC, cv.BORDER_REPLICATE);
    rowX.delete();
    rowBase.delete();
    rowVertical.delete();
    columnY.delete();
    columnNormalizedY.delete();
    mapX.delete();
    mapY.delete();
    baseCurve.delete();
    verticalCurve.delete();
    normalizedY.delete();
    return result;
  } finally {
    small.delete();
    gray.delete();
  }
}

function solveLinearSystem(matrix: number[][], vector: number[]): number[] | null {
  const size = vector.length;
  const rows = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
    }
    if (Math.abs(rows[pivot][column]) < 1e-8) return null;
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
    const divisor = rows[column][column];
    for (let cell = column; cell <= size; cell += 1) rows[column][cell] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = rows[row][column];
      for (let cell = column; cell <= size; cell += 1) rows[row][cell] -= factor * rows[column][cell];
    }
  }
  return rows.map((row) => row[size]);
}

function enhance(cv: any, rgba: any, options: EnhanceOptions): any {
  const rgb = new cv.Mat();
  cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);

  if (options.mode === "bw") {
    const gray = new cv.Mat();
    const binary = new cv.Mat();
    const result = new cv.Mat();
    cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
    const blockSize = Math.max(25, Math.floor(Math.min(gray.cols, gray.rows) / 30) | 1);
    cv.adaptiveThreshold(gray, binary, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, blockSize, 13);
    cv.cvtColor(binary, result, cv.COLOR_GRAY2RGBA);
    rgb.delete();
    gray.delete();
    binary.delete();
    return result;
  }

  const lab = new cv.Mat();
  const channels = new cv.MatVector();
  cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
  cv.split(lab, channels);
  const luminance = channels.get(0);
  const background = new cv.Mat();
  const normalized = new cv.Mat();
  const boosted = new cv.Mat();
  const kernelBase = Math.max(31, Math.min(121, Math.floor(Math.min(rgb.cols, rgb.rows) / 18)));
  const kernelSize = kernelBase % 2 === 0 ? kernelBase + 1 : kernelBase;
  cv.GaussianBlur(luminance, background, new cv.Size(kernelSize, kernelSize), 0);
  const targetWhite = 215 + options.whiten * 0.4;
  cv.divide(luminance, background, normalized, targetWhite);

  // A soft levels curve makes pale show-through disappear while retaining ink.
  const lookup = new cv.Mat(1, 256, cv.CV_8U);
  const midpoint = 174 + options.whiten * 0.09;
  const spread = Math.max(8, 22 - options.contrast * 0.18);
  for (let value = 0; value < 256; value += 1) {
    const level = 1 / (1 + Math.exp(-(value - midpoint) / spread));
    lookup.data[value] = Math.round(255 * level);
  }
  cv.LUT(normalized, lookup, boosted);

  // Neutralize faint chroma in bright paper areas. Saturated illustrations are
  // darker and therefore keep their original blue/red colour.
  const chromaA = channels.get(1);
  const chromaB = channels.get(2);
  for (let index = 0; index < boosted.data.length; index += 1) {
    const light = boosted.data[index];
    if (light <= 168) continue;
    const keep = Math.max(0.08, Math.min(1, (255 - light) / 87));
    chromaA.data[index] = Math.round(128 + (chromaA.data[index] - 128) * keep);
    chromaB.data[index] = Math.round(128 + (chromaB.data[index] - 128) * keep);
  }
  channels.set(0, boosted);
  cv.merge(channels, lab);

  const enhancedRgb = new cv.Mat();
  cv.cvtColor(lab, enhancedRgb, cv.COLOR_Lab2RGB);
  const softened = new cv.Mat();
  const sharpened = new cv.Mat();
  cv.GaussianBlur(enhancedRgb, softened, new cv.Size(0, 0), 1.1);
  const sharpAmount = options.sharpness / 100 * 1.25;
  cv.addWeighted(enhancedRgb, 1 + sharpAmount, softened, -sharpAmount, 0, sharpened);

  let finalRgb = sharpened;
  if (options.mode === "gray") {
    const gray = new cv.Mat();
    cv.cvtColor(sharpened, gray, cv.COLOR_RGB2GRAY);
    finalRgb = new cv.Mat();
    cv.cvtColor(gray, finalRgb, cv.COLOR_GRAY2RGB);
    gray.delete();
  }

  const result = new cv.Mat();
  cv.cvtColor(finalRgb, result, cv.COLOR_RGB2RGBA);

  if (finalRgb !== sharpened) finalRgb.delete();
  rgb.delete();
  lab.delete();
  channels.delete();
  luminance.delete();
  background.delete();
  normalized.delete();
  boosted.delete();
  lookup.delete();
  chromaA.delete();
  chromaB.delete();
  enhancedRgb.delete();
  softened.delete();
  sharpened.delete();
  return result;
}

export function canvasToBlob(canvas: HTMLCanvasElement, format: "jpeg" | "png", quality = 0.94): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("图片导出失败")),
      format === "png" ? "image/png" : "image/jpeg",
      quality,
    );
  });
}
