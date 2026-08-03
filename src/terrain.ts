import * as THREE from 'three';
import { fbm3 } from './noise';

// Tuned so land covers roughly 30% of the surface, like real Earth's
// land:sea ≈ 3:7 (verified empirically against heightAt's noise distribution).
export const SEA_LEVEL = 0.095;
const COAST_WIDTH = 0.012;

// Toned down across the board — high-saturation primary colors are what
// made this read as "cheap mobile game" regardless of how much detail
// sat on top of them. Real terrain photography has much narrower,
// muddier, more correlated color ranges than a clean color wheel.
const shoreColor = new THREE.Color('#d9c58a');
// muted/soil-toned on purpose — the vivid green now comes from actually
// covering the ground in grass/tree instances, not from painting the
// terrain itself bright green underneath them
const landColor = new THREE.Color('#6d7f4c');
const desertColor = new THREE.Color('#bd9a5f');
const rockColor = new THREE.Color('#7d7264');
const snowColor = new THREE.Color('#e9eef0');
const riverColor = new THREE.Color('#3184a0');
const tundraColor = new THREE.Color('#8b8a6e');
const iceColor = new THREE.Color('#dce8ea');

const deepOceanColor = new THREE.Color('#0c4a5e');
const midOceanColor = new THREE.Color('#1c6f7f');
const shallowOceanColor = new THREE.Color('#4fa8ad');

function smoothstep(x: number, edge0: number, edge1: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

// Big smooth rounded continents and coastal hills as the base shape — kept
// separate from the "rugged" detail below because it also drives river
// flow direction, and rugged high-frequency noise creates countless tiny
// local pits that would trap water before it ever reaches the sea.
function macroHeightAt(dir: THREE.Vector3): number {
  return (
    fbm3(dir.x * 1.6, dir.y * 1.6, dir.z * 1.6, 3) * 0.8 +
    fbm3(dir.x * 3.2 + 9.2, dir.y * 3.2 + 9.2, dir.z * 3.2 + 9.2, 2) * 0.2
  );
}

export function heightAt(dir: THREE.Vector3): number {
  const macro = macroHeightAt(dir);

  // real terrain isn't uniformly smooth either — coasts and lowlands are
  // gentle, but the higher land gets, the more rugged/jagged it should
  // look. Fade in finer, higher-frequency noise only once we're well into
  // "mountain" elevation, so peaks read as genuinely rocky and steep.
  const rugged = fbm3(dir.x * 6.5 + 4.1, dir.y * 6.5 + 4.1, dir.z * 6.5 + 4.1, 4);
  const ruggedAmount = smoothstep(macro, SEA_LEVEL + 0.04, SEA_LEVEL + 0.22);

  const n = macro + rugged * 0.2 * ruggedAmount;
  return Math.max(n, -0.2); // flatten the deep ocean floor a bit
}

// Climate variety, in two layers: a broad, low-frequency "climate belt"
// (so a real Sahara-scale desert can span a huge stretch of a continent,
// not just a patch) blended with finer noise for patchy edges within it —
// the way the reference photo shows a tan Sahara next to green elsewhere
// in the *same* continent, but the Sahara itself is enormous, not a spot.
export function aridityAt(dir: THREE.Vector3): number {
  const belt = fbm3(dir.x * 0.7 + 400, dir.y * 0.7 + 400, dir.z * 0.7 + 400, 2);
  const local = fbm3(dir.x * 2.6 + 51.3, dir.y * 2.6 + 51.3, dir.z * 2.6 + 51.3, 3);
  return belt * 0.65 + local * 0.35;
}

// same threshold biomeColor uses to start blending toward desert — shared
// so vegetation placement (dunes/dry rock vs. grass/trees) agrees with
// what the paint underneath actually looks like
export const DESERT_ARIDITY_THRESHOLD = 0.1;

// Latitude-driven climate (Whittaker's temperature axis), like the design
// memo originally called for: hot at the equator, cold at the poles, and
// colder again with elevation — with a little noise so the ice line isn't
// a perfect circle. dir.y stands in for latitude, matching how the rest
// of the terrain already uses it.
export function temperatureAt(dir: THREE.Vector3, elevation: number): number {
  const latitude = 1 - Math.abs(dir.y);
  const wobble = fbm3(dir.x * 1.3 + 700, dir.y * 1.3 + 700, dir.z * 1.3 + 700, 2) * 0.18;
  const elevationCooling = Math.max(elevation, 0) * 1.6;
  return latitude + wobble - elevationCooling;
}

export const ICE_TEMPERATURE = -0.14;
const TUNDRA_TEMPERATURE = 0.09;

// A rare, huge-scale bump that pushes one or two regions dramatically
// higher than everywhere else — real mountain building isn't evenly
// distributed the way plain elevation noise implies; a couple of specific
// belts (Himalaya, Andes) tower over everything else on the planet.
// Frequency is low enough that only a small fraction of the sphere ever
// sees a high value here at all.
function orogenyAt(dir: THREE.Vector3): number {
  return fbm3(dir.x * 0.6 + 900, dir.y * 0.6 + 900, dir.z * 0.6 + 900, 2);
}
const OROGENY_THRESHOLD = 0.32;

// water is flattened to sea level on the mesh so it doesn't visibly
// inherit the terrain noise as bumpy waves — only land pokes up. Land is
// pushed up well beyond its raw noise height for a toy-globe, exaggerated
// mountain look; since the ocean (~70% of the surface) stays perfectly
// flat regardless, this doesn't reintroduce the "potato" whole-sphere
// distortion from earlier — only the 30% landmass gets dramatic.
const LAND_BOOST = 2.5;
// a bigger drop than a purely cosmetic clamp needs — real relief globes
// have a visible carved "step" right at the coastline instead of land
// gently sloping into the water, and this is what makes that step read
const UNDERWATER_HEIGHT = SEA_LEVEL - 0.045;
// sits between the flattened underwater terrain and true sea level, so the
// glass ocean shell (built from this in main.ts) fully covers the seabed
// without z-fighting the coastline
export const GLASS_SEA_HEIGHT = SEA_LEVEL - 0.015;

// Land elevation is quantized into flat terraces with a small beveled
// transition at each edge — like a laser-cut layered topographic model —
// instead of one continuous smooth slope. This reads as "hand-built model"
// far more strongly than smoothness or color ever could, independent of
// how photoreal anything else is.
export const TERRACE_STEPS = 6;
const TERRACE_MAX = 0.3;
const TERRACE_BEVEL = 0.32;

function terraceCurve(t: number): number {
  const scaled = t * TERRACE_STEPS;
  const i = Math.floor(scaled);
  const f = scaled - i;
  let localT: number;
  if (f < TERRACE_BEVEL) {
    localT = 0.5 * smoothstep(f / TERRACE_BEVEL, 0, 1);
  } else if (f > 1 - TERRACE_BEVEL) {
    localT = 0.5 + 0.5 * smoothstep((f - (1 - TERRACE_BEVEL)) / TERRACE_BEVEL, 0, 1);
  } else {
    localT = 0.5;
  }
  return (Math.min(i, TERRACE_STEPS - 1) + localT) / TERRACE_STEPS;
}

// Raw elevation above sea level (0..TERRACE_MAX), terraced. Shared by both
// the mesh displacement and the color banding so a terrace's edge always
// lines up with a color change, like distinct painted layers.
export function terracedElevation(height: number): number {
  if (height < SEA_LEVEL) return 0;
  const t = Math.min((height - SEA_LEVEL) / TERRACE_MAX, 1);
  return terraceCurve(t) * TERRACE_MAX;
}

// dir is needed to look up whether this point sits in a rare "great
// range" (Himalaya-scale) zone — see orogenyAt above. Paint/coloring
// still uses plain terracedElevation, so a dramatic peak still gets
// colored by its normal elevation percentile (naturally reads as rock/
// snow already); only the geometry shoots up further.
export function displayHeight(height: number, dir: THREE.Vector3): number {
  if (height < SEA_LEVEL) return UNDERWATER_HEIGHT;
  const orogenyBoost = 1 + smoothstep(orogenyAt(dir), OROGENY_THRESHOLD, OROGENY_THRESHOLD + 0.12) * 2.4;
  return SEA_LEVEL + terracedElevation(height) * LAND_BOOST * orogenyBoost;
}

export function seaLevelRadius(radius: number, bumpHeight: number): number {
  return radius + GLASS_SEA_HEIGHT * bumpHeight;
}

const outColor = new THREE.Color();

// Purely cosmetic: perturbs where a pixel's color band boundary falls,
// without touching the height value used for geometry, sea level, or
// vegetation placement. Perfectly smooth, mathematically clean coastlines
// read as vector art; a hand-cut miniature's coastline has a bit of
// irregularity to it.
function coastlineJitter(dir: THREE.Vector3): number {
  return fbm3(dir.x * 55 + 71, dir.y * 55 + 71, dir.z * 55 + 71, 2) * 0.008;
}

// A little per-pixel brightness grain so painted terrain reads as a
// matte, slightly textured surface (like painted resin/flock) instead of
// a flawless digital gradient — real miniatures are never perfectly smooth.
function paintGrain(dir: THREE.Vector3): number {
  return fbm3(dir.x * 180 + 13, dir.y * 180 + 13, dir.z * 180 + 13, 1) * 0.05;
}

// green lowland, with patches nudged toward desert; rock band climbing
// into rugged elevation; snow capping the highest peaks — real elevation
// color grading instead of a single flat "land" band.
// Thresholds were picked by sampling the actual height/aridity noise
// distributions so bands land at sensible percentiles of land area:
// rock starts ~p80, full snow ~p97, desert patches cover ~top 20%.
// Takes the already-terraced elevation (0..TERRACE_MAX) so each color
// band's edge lines up exactly with a geometric terrace edge — the
// "layers are individually painted" read this is going for.
function biomeColor(elevation: number, aridity: number, temperature: number): THREE.Color {
  // polar ice caps: cold enough, and it's ice regardless of elevation or
  // aridity — Antarctica doesn't care if it would otherwise be a beach
  if (temperature < ICE_TEMPERATURE) {
    return outColor.copy(iceColor);
  }

  const desertAmount = smoothstep(aridity, 0.12, 0.26);

  if (elevation < 0.15) {
    // cold + dry lowland reads as bare tundra instead of green — being
    // *cold* isn't the same as being *dry*, so this stacks with (and can
    // override) the desert blend below rather than replacing it outright
    if (temperature < TUNDRA_TEMPERATURE) {
      const coldness = smoothstep(temperature, TUNDRA_TEMPERATURE, ICE_TEMPERATURE);
      outColor.copy(landColor).lerp(tundraColor, coldness);
      return outColor.lerp(desertColor, desertAmount * (1 - coldness));
    }
    // sand only right at the coast — being *low* elevation isn't the same
    // as being *dry*. A wide shore→green transition was tying the two
    // together, so any low flat continent read as one giant beach
    // regardless of its actual (independent) aridity value.
    const t = elevation / 0.035;
    outColor.copy(shoreColor).lerp(landColor, Math.min(Math.max(t, 0), 1));
    return outColor.lerp(desertColor, desertAmount);
  }
  if (elevation < 0.22) {
    const t = (elevation - 0.15) / 0.07;
    outColor.copy(landColor).lerp(rockColor, t);
    return outColor.lerp(desertColor, desertAmount * (1 - t) * 0.5);
  }
  if (elevation < TERRACE_MAX) {
    const t = (elevation - 0.22) / (TERRACE_MAX - 0.22);
    return outColor.copy(rockColor).lerp(snowColor, t);
  }
  return outColor.copy(snowColor);
}

// Real shadow maps are off (mobile GPU stability), so the coastline's
// geometric "step" never actually casts a shadow onto the beach — without
// this the carved edge just looks like a color boundary, not a relief.
// Baking a fake AO crease directly into the paint fakes the same read.
function coastalAO(height: number): number {
  const t = smoothstep(height, SEA_LEVEL, SEA_LEVEL + 0.05);
  return -0.16 * (1 - t);
}

function terrainColor(dir: THREE.Vector3, height: number, riverStrength: number): THREE.Color {
  const h = height + coastlineJitter(dir);
  const temperature = temperatureAt(dir, terracedElevation(Math.max(h, SEA_LEVEL)));
  const seaIce = smoothstep(temperature, ICE_TEMPERATURE, ICE_TEMPERATURE - 0.08);

  let color: THREE.Color;
  if (h < SEA_LEVEL - COAST_WIDTH) {
    // hidden beneath the glass ocean shell almost all the time, but the
    // shell is very slightly transparent, so keep this in the same family
    color = outColor.copy(midOceanColor).lerp(iceColor, seaIce);
  } else if (h < SEA_LEVEL + COAST_WIDTH) {
    color = outColor.copy(midOceanColor).lerp(shoreColor, (h - (SEA_LEVEL - COAST_WIDTH)) / (COAST_WIDTH * 2));
    color.lerp(iceColor, seaIce);
  } else {
    color = biomeColor(terracedElevation(h), aridityAt(dir), temperature);
    if (riverStrength > 0) color.lerp(riverColor, riverStrength);
    color.offsetHSL(0, 0, coastalAO(h));
  }

  return color.offsetHSL(0, 0, paintGrain(dir));
}

function oceanColor(dir: THREE.Vector3, height: number): THREE.Color {
  const t = smoothstep(height, -0.2, SEA_LEVEL);
  if (t < 0.6) {
    outColor.copy(deepOceanColor).lerp(midOceanColor, t / 0.6);
  } else {
    outColor.copy(midOceanColor).lerp(shallowOceanColor, (t - 0.6) / 0.4);
  }
  // polar pack ice — a real ice cap freezes the sea around it too, not
  // just the land
  const temperature = temperatureAt(dir, 0);
  const seaIce = smoothstep(temperature, ICE_TEMPERATURE, ICE_TEMPERATURE - 0.08);
  outColor.lerp(iceColor, seaIce);
  return outColor.offsetHSL(0, 0, paintGrain(dir) * 0.6);
}

function dirForPixel(px: number, py: number, width: number, height: number, out: THREE.Vector3): THREE.Vector3 {
  const u = px / width;
  const v = py / height;
  const phi = u * Math.PI * 2;
  const theta = v * Math.PI;
  return out.set(-Math.cos(phi) * Math.sin(theta), Math.cos(theta), Math.sin(phi) * Math.sin(theta));
}

// Simple hydrology pass: steepest-descent flow accumulation on a coarse
// grid (matching the design memo's original "flow accumulation derives
// rivers" plan). Every land cell starts with 1 unit of flow and hands it
// downhill to its lowest neighbor; processing cells from highest to
// lowest lets flow accumulate exactly like water actually would, so
// branching river networks fall out for free instead of being hand-drawn.
function computeRiverFlow(width: number, height: number): { flow: Float32Array; width: number; height: number } {
  const size = width * height;
  const heightField = new Float32Array(size);
  const isLand = new Uint8Array(size);
  const dir = new THREE.Vector3();

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const idx = py * width + px;
      // macro-only height: rugged detail noise creates countless tiny
      // local pits that would trap flow before it reaches the ocean
      const h = macroHeightAt(dirForPixel(px, py, width, height, dir));
      heightField[idx] = h;
      isLand[idx] = h >= SEA_LEVEL ? 1 : 0;
    }
  }

  const downhill = new Int32Array(size).fill(-1);
  const dxs = [-1, 0, 1, -1, 1, -1, 0, 1];
  const dys = [-1, -1, -1, 0, 0, 1, 1, 1];

  const landIndices: number[] = [];
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const idx = py * width + px;
      if (!isLand[idx]) continue;
      landIndices.push(idx);

      let lowest = heightField[idx];
      let lowestIdx = -1;
      for (let k = 0; k < 8; k++) {
        const nx = (px + dxs[k] + width) % width;
        const ny = py + dys[k];
        if (ny < 0 || ny >= height) continue;
        const nIdx = ny * width + nx;
        if (heightField[nIdx] < lowest) {
          lowest = heightField[nIdx];
          lowestIdx = nIdx;
        }
      }
      downhill[idx] = lowestIdx;
    }
  }

  landIndices.sort((a, b) => heightField[b] - heightField[a]);

  const flow = new Float32Array(size).fill(1);
  for (const idx of landIndices) {
    const d = downhill[idx];
    if (d >= 0) flow[d] += flow[idx];
  }

  return { flow, width, height };
}

function sampleRiverFlow(river: { flow: Float32Array; width: number; height: number }, dir: THREE.Vector3): number {
  // dir -> (u,v) using the same convention dirForPixel used in reverse
  const theta = Math.acos(THREE.MathUtils.clamp(dir.y, -1, 1));
  let phi = Math.atan2(dir.z, -dir.x);
  if (phi < 0) phi += Math.PI * 2;
  const px = Math.min(river.width - 1, Math.floor((phi / (Math.PI * 2)) * river.width));
  const py = Math.min(river.height - 1, Math.floor((theta / Math.PI) * river.height));
  const flow = river.flow[py * river.width + px];
  // log-compress: a trickle near the source vs. a wide river near the
  // mouth shouldn't be the same line weight. Thresholds picked from the
  // actual flow distribution so only the top ~2% of land (real rivers,
  // not every hillside trickle) shows any blue at all.
  const strength = (Math.log(flow + 1) - 3.4) / (5.9 - 3.4);
  return smoothstep(strength, 0, 1);
}

// Renders terrain color to a canvas once, matching the exact UV formula
// THREE.SphereGeometry uses internally, so the crisp texture lines up with
// the (much lower-poly) displaced mesh without any seams or misalignment.
export function buildTerrainTexture(width = 1536, height = 768): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(width, height);
  const dir = new THREE.Vector3();

  // rivers computed on a coarser grid — plenty for branching river shapes,
  // and much cheaper than running full hydrology at texture resolution
  const river = computeRiverFlow(384, 192);

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      dirForPixel(px, py, width, height, dir);

      const h = heightAt(dir);
      const riverStrength = h >= SEA_LEVEL ? sampleRiverFlow(river, dir) : 0;
      const c = terrainColor(dir, h, riverStrength);

      const idx = (py * width + px) * 4;
      image.data[idx] = Math.round(c.r * 255);
      image.data[idx + 1] = Math.round(c.g * 255);
      image.data[idx + 2] = Math.round(c.b * 255);
      image.data[idx + 3] = 255;
    }
  }

  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

// A depth-graded teal texture for the ocean shell — deep water reads
// darker, shading up to a lighter turquoise near the coast, instead of a
// single flat color.
export function buildOceanTexture(width = 1536, height = 768): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(width, height);
  const dir = new THREE.Vector3();

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      dirForPixel(px, py, width, height, dir);
      const h = heightAt(dir);
      const c = oceanColor(dir, h);

      const idx = (py * width + px) * 4;
      image.data[idx] = Math.round(c.r * 255);
      image.data[idx + 1] = Math.round(c.g * 255);
      image.data[idx + 2] = Math.round(c.b * 255);
      image.data[idx + 3] = 255;
    }
  }

  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

// A directional-ish wave pattern (not just isotropic noise) baked as a
// bumpMap and scrolled slowly in the animation loop — the ocean sphere is
// geometrically almost still (one static ripple pass), but a moving bump
// texture makes its specular highlights shimmer and drift like real
// wind-driven water instead of a fixed pattern on a billiard ball.
export function buildWaveTexture(width = 1024, height = 512): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(width, height);
  const dir = new THREE.Vector3();

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      dirForPixel(px, py, width, height, dir);

      const ridge = Math.sin(dir.x * 42 + dir.z * 17 + dir.y * 9) * 0.5 + 0.5;
      const chop = fbm3(dir.x * 30 + 8, dir.y * 30 + 8, dir.z * 30 + 8, 3);
      const v = 0.5 + (ridge - 0.5) * 0.5 + chop * 0.18;

      const gray = Math.round(Math.min(Math.max(v, 0), 1) * 255);
      const idx = (py * width + px) * 4;
      image.data[idx] = gray;
      image.data[idx + 1] = gray;
      image.data[idx + 2] = gray;
      image.data[idx + 3] = 255;
    }
  }

  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

// Fine-grained surface relief baked into a grayscale map and applied as a
// bumpMap — this is the single biggest lever for "sculpted miniature" vs.
// "smooth painted ball": the mesh itself stays cheap and low-poly, but
// per-pixel lighting reacts to fake micro-terrain, giving the impression
// of actual carved texture (individual clumps of foliage, rock grain,
// sand ripples) at zoom levels the real geometry could never afford.
export function buildBumpTexture(width = 1536, height = 768): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(width, height);
  const dir = new THREE.Vector3();

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      dirForPixel(px, py, width, height, dir);

      const h = heightAt(dir);
      let v: number;
      if (h < SEA_LEVEL) {
        // fine ripple texture on the (mostly hidden) seabed — cheap
        // insurance in case it peeks through the glass shell
        v = 0.5 + fbm3(dir.x * 90, dir.y * 90, dir.z * 90, 2) * 0.08;
      } else {
        // layered detail: coarse clumps (foliage/boulder clusters), fine
        // grain (rock/sand texture), scaled down near the coast so the
        // beach itself still reads smooth
        const shoreFade = smoothstep(h, SEA_LEVEL, SEA_LEVEL + 0.03);
        const clumps = fbm3(dir.x * 45 + 8, dir.y * 45 + 8, dir.z * 45 + 8, 2);
        const grain = fbm3(dir.x * 140 + 22, dir.y * 140 + 22, dir.z * 140 + 22, 2);
        v = 0.5 + (clumps * 0.14 + grain * 0.07) * shoreFade;
      }

      const gray = Math.round(Math.min(Math.max(v, 0), 1) * 255);
      const idx = (py * width + px) * 4;
      image.data[idx] = gray;
      image.data[idx + 1] = gray;
      image.data[idx + 2] = gray;
      image.data[idx + 3] = 255;
    }
  }

  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

// Displaces a SphereGeometry's vertices in place using the same height
// field the texture was painted from.
export function displaceSphere(geometry: THREE.SphereGeometry, radius: number, bumpHeight: number) {
  const positionAttr = geometry.attributes.position;
  const dir = new THREE.Vector3();
  for (let i = 0; i < positionAttr.count; i++) {
    dir.fromBufferAttribute(positionAttr, i).normalize();
    const h = displayHeight(heightAt(dir), dir);
    const displaced = dir.multiplyScalar(radius + h * bumpHeight);
    positionAttr.setXYZ(i, displaced.x, displaced.y, displaced.z);
  }
  geometry.computeVertexNormals();
}

// A perfectly smooth sphere reads as a billiard ball, not water — a tiny
// bit of gentle undulation breaks up specular highlights into something
// closer to real (if idealized/toy-like) water texture.
export function rippleSphere(geometry: THREE.SphereGeometry, radius: number, amplitude: number) {
  const positionAttr = geometry.attributes.position;
  const dir = new THREE.Vector3();
  for (let i = 0; i < positionAttr.count; i++) {
    dir.fromBufferAttribute(positionAttr, i).normalize();
    const ripple = fbm3(dir.x * 26 + 5.5, dir.y * 26 + 5.5, dir.z * 26 + 5.5, 2);
    const displaced = dir.clone().multiplyScalar(radius + ripple * amplitude);
    positionAttr.setXYZ(i, displaced.x, displaced.y, displaced.z);
  }
  geometry.computeVertexNormals();
}
