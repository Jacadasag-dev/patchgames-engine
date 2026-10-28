/** Image comparisons cannot prove feature support. This gate is an additional
 * loading-time check after feature, resolution and identical 4x-MSAA checks.
 * It allows bounded raster coverage differences, never a lower quality mode. */
export interface RendererParitySnapshot {
  width: number;
  height: number;
  pixels: Uint8Array | Uint8ClampedArray;
}

export interface RendererParityLimits {
  channelTolerance: number;
  maximumChangedPixelRatio: number;
  maximumMeanChannelDifference: number;
}

export interface RendererParityMetrics {
  changedPixelRatio: number;
  meanChannelDifference: number;
  unexcusedChangedPixelRatio: number;
  unexcusedMeanChannelDifference: number;
  interiorChangedPixelRatio: number;
  interiorMeanChannelDifference: number;
  edgePixelRatio: number;
  edgeExceptionPixelRatio: number;
  maximumTileColorDrift: number;
  gradientEnergyRatio: number;
  minimumTileGradientRatio: number;
  maximumTileGradientRatio: number;
}

export interface RendererParityResult {
  passed: boolean;
  reason: string;
  metrics: RendererParityMetrics;
}

const defaults: RendererParityLimits = {
  channelTolerance: 2,
  maximumChangedPixelRatio: 0.001,
  maximumMeanChannelDifference: 0.1,
};

// These are deliberately independent of the caller's strict difference budget.
// Captures with too many edges or ambiguous changes keep the baseline renderer.
const EDGE_CONTRAST = 8;
const TILE_SIZE = 16;
const MAX_EDGE_AREA = 0.25;
const MAX_EDGE_EXCEPTIONS = 0.02;
const MAX_TOTAL_MEAN = 0.25; // RGBA bytes; includes every edge, not just interiors.
const MAX_TILE_COLOR_DRIFT = 3;
const MIN_GRADIENT_RATIO = 0.97;
const MAX_GRADIENT_RATIO = 1.03;
const MIN_TILE_GRADIENT_RATIO = 0.7;
const MAX_TILE_GRADIENT_RATIO = 1.6;

function emptyMetrics(): RendererParityMetrics {
  return {
    changedPixelRatio: 0, meanChannelDifference: 0,
    unexcusedChangedPixelRatio: 0, unexcusedMeanChannelDifference: 0,
    interiorChangedPixelRatio: 0, interiorMeanChannelDifference: 0,
    edgePixelRatio: 0, edgeExceptionPixelRatio: 0, maximumTileColorDrift: 0,
    gradientEnergyRatio: 1, minimumTileGradientRatio: 1, maximumTileGradientRatio: 1,
  };
}

function edgeMask(pixels: RendererParitySnapshot['pixels'], width: number, height: number): Uint8Array {
  const edges = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const offset = index * 4;
      for (let direction = 0; direction < 2; direction++) {
        if ((direction === 0 && x + 1 === width) || (direction === 1 && y + 1 === height)) continue;
        const step = direction === 0 ? 1 : width;
        const next = offset + step * 4;
        if (Math.abs(pixels[offset] - pixels[next]) > EDGE_CONTRAST
          || Math.abs(pixels[offset + 1] - pixels[next + 1]) > EDGE_CONTRAST
          || Math.abs(pixels[offset + 2] - pixels[next + 2]) > EDGE_CONTRAST) {
          edges[index] = edges[index + step] = 1;
        }
      }
    }
  }
  return edges;
}

function dilate(edges: Uint8Array, width: number, height: number): Uint8Array {
  const result = new Uint8Array(edges.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!edges[y * width + x]) continue;
      for (let ny = Math.max(0, y - 1); ny <= Math.min(height - 1, y + 1); ny++) {
        for (let nx = Math.max(0, x - 1); nx <= Math.min(width - 1, x + 1); nx++) result[ny * width + nx] = 1;
      }
    }
  }
  return result;
}

/** Both colors must remain within the other's 3x3 coverage envelope. Limiting
 * the change to half the local contrast rules out a whole-pixel edge relocation
 * or loss of a solid one-pixel feature. Alpha never receives this exception. */
function coverageMatches(a: RendererParitySnapshot['pixels'], b: RendererParitySnapshot['pixels'],
  x: number, y: number, width: number, height: number, tolerance: number): boolean {
  const offset = (y * width + x) * 4;
  if (Math.abs(a[offset + 3] - b[offset + 3]) > tolerance) return false;
  for (let channel = 0; channel < 3; channel++) {
    let minA = 255, maxA = 0, minB = 255, maxB = 0;
    for (let ny = Math.max(0, y - 1); ny <= Math.min(height - 1, y + 1); ny++) {
      for (let nx = Math.max(0, x - 1); nx <= Math.min(width - 1, x + 1); nx++) {
        const neighbor = (ny * width + nx) * 4 + channel;
        minA = Math.min(minA, a[neighbor]); maxA = Math.max(maxA, a[neighbor]);
        minB = Math.min(minB, b[neighbor]); maxB = Math.max(maxB, b[neighbor]);
      }
    }
    if (a[offset + channel] < minB - tolerance || a[offset + channel] > maxB + tolerance
      || b[offset + channel] < minA - tolerance || b[offset + channel] > maxA + tolerance
      || Math.abs(a[offset + channel] - b[offset + channel])
        > (Math.max(maxA, maxB) - Math.min(minA, minB)) * 0.5 + tolerance) return false;
  }
  return true;
}

/** Compare the whole frame without resizing, registration, blur or ignoring
 * HUD/shadow regions. The same strict budget applies to interiors and to every
 * difference not explained by corresponding local raster coverage. */
export function compareRendererVisualParity(baseline: RendererParitySnapshot, candidate: RendererParitySnapshot,
  options: Partial<RendererParityLimits> = {}): RendererParityResult {
  const limits = { ...defaults, ...options };
  const metrics = emptyMetrics();
  const result = (passed: boolean, reason: string): RendererParityResult => ({ passed, reason, metrics });
  const { width, height, pixels: a } = baseline;
  const b = candidate.pixels;
  const count = width * height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0
    || count > 16_777_216 || width !== candidate.width || height !== candidate.height
    || a.length !== count * 4 || b.length !== count * 4) return result(false, 'Snapshot dimensions differ or are invalid.');
  if (Object.values(limits).some(value => !Number.isFinite(value) || value < 0)
    || limits.channelTolerance > 255 || limits.maximumChangedPixelRatio > 1) return result(false, 'Invalid parity limits.');

  let changed = 0, difference = 0;
  for (let offset = 0; offset < a.length; offset += 4) {
    let pixelChanged = false;
    for (let channel = 0; channel < 4; channel++) {
      const delta = Math.abs(a[offset + channel] - b[offset + channel]);
      difference += delta;
      pixelChanged ||= delta > limits.channelTolerance;
    }
    if (pixelChanged) changed++;
  }
  metrics.changedPixelRatio = metrics.unexcusedChangedPixelRatio = changed / count;
  metrics.meanChannelDifference = metrics.unexcusedMeanChannelDifference = difference / a.length;
  if (metrics.changedPixelRatio <= limits.maximumChangedPixelRatio
    && metrics.meanChannelDifference <= limits.maximumMeanChannelDifference) return result(true, 'Within strict full-frame limits.');
  if (metrics.meanChannelDifference > MAX_TOTAL_MEAN) return result(false, 'Whole-frame color difference exceeds the raster coverage bound.');

  const edgeA = edgeMask(a, width, height), edgeB = edgeMask(b, width, height);
  const nearA = dilate(edgeA, width, height), nearB = dilate(edgeB, width, height);
  // First match actual edges within one pixel; only then extend their coverage
  // neighborhoods. Unmatched edges can never explain a newly missing feature.
  for (let i = 0; i < count; i++) { edgeA[i] &= nearB[i]; edgeB[i] &= nearA[i]; }
  const matchedA = dilate(edgeA, width, height), matchedB = dilate(edgeB, width, height);
  const columns = Math.ceil(width / TILE_SIZE), rows = Math.ceil(height / TILE_SIZE);
  const tileCount = columns * rows;
  const tileDrift = new Float64Array(tileCount * 3);
  const tileDifference = new Float64Array(tileCount);
  const tileEnergyA = new Float64Array(tileCount), tileEnergyB = new Float64Array(tileCount);
  const tileCoreEnergyA = new Float64Array(tileCount), tileCoreEnergyB = new Float64Array(tileCount);
  const tilePixels = new Uint16Array(tileCount);
  let edgePixels = 0, exceptions = 0, unexcusedChanged = 0, unexcusedDifference = 0;
  let interiorPixels = 0, interiorChanged = 0, interiorDifference = 0;
  let totalEnergyA = 0, totalEnergyB = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x, offset = index * 4;
      const tile = Math.floor(y / TILE_SIZE) * columns + Math.floor(x / TILE_SIZE);
      tilePixels[tile]++;
      let deltaSum = 0, maxDelta = 0, energyA = 0, energyB = 0;
      for (let channel = 0; channel < 4; channel++) {
        const signedDelta = a[offset + channel] - b[offset + channel];
        const delta = Math.abs(signedDelta);
        deltaSum += delta; maxDelta = Math.max(maxDelta, delta);
        if (channel === 3) continue;
        tileDrift[tile * 3 + channel] += signedDelta;
        tileDifference[tile] += delta;
        if (x + 1 < width) {
          energyA += (a[offset + channel] - a[offset + channel + 4]) ** 2;
          energyB += (b[offset + channel] - b[offset + channel + 4]) ** 2;
        }
        if (y + 1 < height) {
          energyA += (a[offset + channel] - a[offset + channel + width * 4]) ** 2;
          energyB += (b[offset + channel] - b[offset + channel + width * 4]) ** 2;
        }
      }
      tileCoreEnergyA[tile] += energyA; tileCoreEnergyB[tile] += energyB;
      // A tile can split the gradients surrounding one antialiased edge. Keep
      // both its core and its one-pixel footprint: the other renderer must
      // preserve the core's energy somewhere within that permitted footprint.
      // Comparing two equally expanded boxes would merely move the boundary.
      if (energyA || energyB) {
        const firstColumn = Math.max(0, Math.floor((x - 1) / TILE_SIZE));
        const lastColumn = Math.min(columns - 1, Math.floor((x + 1) / TILE_SIZE));
        const firstRow = Math.max(0, Math.floor((y - 1) / TILE_SIZE));
        const lastRow = Math.min(rows - 1, Math.floor((y + 1) / TILE_SIZE));
        for (let row = firstRow; row <= lastRow; row++) for (let column = firstColumn; column <= lastColumn; column++) {
          const energyTile = row * columns + column;
          tileEnergyA[energyTile] += energyA; tileEnergyB[energyTile] += energyB;
        }
      }
      totalEnergyA += energyA; totalEnergyB += energyB;
      const pixelChanged = maxDelta > limits.channelTolerance;
      const nearEdge = !!(nearA[index] || nearB[index]);
      if (nearEdge) edgePixels++;
      else {
        interiorPixels++; interiorDifference += deltaSum;
        if (pixelChanged) interiorChanged++;
      }
      const exception = pixelChanged && matchedA[index] && matchedB[index]
        && coverageMatches(a, b, x, y, width, height, Math.min(2, limits.channelTolerance));
      if (exception) {
        exceptions++;
        // Alpha remains subject to the original strict channel mean.
        unexcusedDifference += Math.abs(a[offset + 3] - b[offset + 3]);
      } else {
        unexcusedDifference += deltaSum;
        if (pixelChanged) unexcusedChanged++;
      }
    }
  }
  metrics.edgePixelRatio = edgePixels / count;
  metrics.edgeExceptionPixelRatio = exceptions / count;
  metrics.unexcusedChangedPixelRatio = unexcusedChanged / count;
  metrics.unexcusedMeanChannelDifference = unexcusedDifference / a.length;
  metrics.interiorChangedPixelRatio = interiorChanged / Math.max(1, interiorPixels);
  metrics.interiorMeanChannelDifference = interiorDifference / Math.max(1, interiorPixels * 4);
  metrics.gradientEnergyRatio = totalEnergyA ? totalEnergyB / totalEnergyA : (totalEnergyB ? Infinity : 1);
  for (let tile = 0; tile < tileCount; tile++) {
    for (let channel = 0; channel < 3; channel++) metrics.maximumTileColorDrift = Math.max(
      metrics.maximumTileColorDrift, Math.abs(tileDrift[tile * 3 + channel]) / tilePixels[tile]);
    // Tiny gradients are numerically unstable; unchanged tiles need no exception.
    if (Math.max(tileCoreEnergyA[tile], tileCoreEnergyB[tile]) <= 10000
      || tileDifference[tile] / (tilePixels[tile] * 3) <= 0.5) continue;
    metrics.minimumTileGradientRatio = Math.min(metrics.minimumTileGradientRatio,
      tileEnergyB[tile] / Math.max(1, tileCoreEnergyA[tile]));
    metrics.maximumTileGradientRatio = Math.max(metrics.maximumTileGradientRatio,
      tileCoreEnergyB[tile] / Math.max(1, tileEnergyA[tile]));
  }
  if (metrics.interiorChangedPixelRatio > limits.maximumChangedPixelRatio
    || metrics.interiorMeanChannelDifference > limits.maximumMeanChannelDifference
    || metrics.unexcusedChangedPixelRatio > limits.maximumChangedPixelRatio
    || metrics.unexcusedMeanChannelDifference > limits.maximumMeanChannelDifference) {
    return result(false, 'Interior or unexplained differences exceed the original strict image limits.');
  }
  if (metrics.edgePixelRatio > MAX_EDGE_AREA || metrics.edgeExceptionPixelRatio > MAX_EDGE_EXCEPTIONS) {
    return result(false, 'Too much of the frame requires a raster coverage exception.');
  }
  if (metrics.maximumTileColorDrift > MAX_TILE_COLOR_DRIFT) return result(false, 'Local colors or feature coverage changed.');
  if (metrics.gradientEnergyRatio < MIN_GRADIENT_RATIO || metrics.gradientEnergyRatio > MAX_GRADIENT_RATIO
    || metrics.minimumTileGradientRatio < MIN_TILE_GRADIENT_RATIO
    || metrics.maximumTileGradientRatio > MAX_TILE_GRADIENT_RATIO) return result(false, 'Image edge sharpness or feature detail changed.');
  return result(true, 'Strict interiors and bounded, corresponding raster coverage differences.');
}
