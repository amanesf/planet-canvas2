import * as THREE from 'three';
import { fbm3 } from './noise';

// Tuned so land covers roughly 30% of the surface, like real Earth's
// land:sea ≈ 3:7 (verified empirically against heightAt's noise distribution).
export const SEA_LEVEL = 0.095;
const COAST_WIDTH = 0.012;

const deepColor = new THREE.Color('#3fb6e0');
const shoreColor = new THREE.Color('#ffe58a');
const landColor = new THREE.Color('#6bcf5a');
const peakColor = new THREE.Color('#ff8fc2');

function smoothstep(x: number, edge0: number, edge1: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

export function heightAt(dir: THREE.Vector3): number {
  // low frequency, few octaves — big smooth rounded continents and coastal
  // hills as the base shape (uniformly fine noise everywhere is what
  // previously turned exaggerated mountains into a "warty" mess).
  const macro =
    fbm3(dir.x * 1.6, dir.y * 1.6, dir.z * 1.6, 3) * 0.8 +
    fbm3(dir.x * 3.2 + 9.2, dir.y * 3.2 + 9.2, dir.z * 3.2 + 9.2, 2) * 0.2;

  // real terrain isn't uniformly smooth either — coasts and lowlands are
  // gentle, but the higher land gets, the more rugged/jagged it should
  // look. Fade in finer, higher-frequency noise only once we're well into
  // "mountain" elevation, so peaks read as genuinely rocky and steep.
  const rugged = fbm3(dir.x * 6.5 + 4.1, dir.y * 6.5 + 4.1, dir.z * 6.5 + 4.1, 4);
  const ruggedAmount = smoothstep(macro, SEA_LEVEL + 0.04, SEA_LEVEL + 0.22);

  const n = macro + rugged * 0.2 * ruggedAmount;
  return Math.max(n, -0.2); // flatten the deep ocean floor a bit
}

// water is flattened to sea level on the mesh so it doesn't visibly
// inherit the terrain noise as bumpy waves — only land pokes up. Land is
// pushed up well beyond its raw noise height for a toy-globe, exaggerated
// mountain look; since the ocean (~70% of the surface) stays perfectly
// flat regardless, this doesn't reintroduce the "potato" whole-sphere
// distortion from earlier — only the 30% landmass gets dramatic.
const LAND_BOOST = 2.0;
const UNDERWATER_HEIGHT = SEA_LEVEL - 0.02;
// sits between the flattened underwater terrain and true sea level, so the
// glass ocean shell (built from this in main.ts) fully covers the seabed
// without z-fighting the coastline
export const GLASS_SEA_HEIGHT = SEA_LEVEL - 0.008;

export function displayHeight(height: number): number {
  if (height < SEA_LEVEL) return UNDERWATER_HEIGHT;
  return SEA_LEVEL + (height - SEA_LEVEL) * LAND_BOOST;
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

function terrainColor(dir: THREE.Vector3, height: number): THREE.Color {
  const h = height + coastlineJitter(dir);

  if (h < SEA_LEVEL - COAST_WIDTH) {
    outColor.copy(deepColor);
  } else if (h < SEA_LEVEL + COAST_WIDTH) {
    outColor.copy(deepColor).lerp(shoreColor, (h - (SEA_LEVEL - COAST_WIDTH)) / (COAST_WIDTH * 2));
  } else if (h < SEA_LEVEL + 0.08) {
    outColor.copy(shoreColor).lerp(landColor, (h - SEA_LEVEL) / 0.08);
  } else {
    outColor.copy(landColor).lerp(peakColor, Math.min((h - (SEA_LEVEL + 0.08)) / 0.25, 1));
  }

  const grain = paintGrain(dir);
  return outColor.offsetHSL(0, 0, grain);
}

// Renders terrain color to a canvas once, matching the exact UV formula
// THREE.SphereGeometry uses internally, so the crisp texture lines up with
// the (much lower-poly) displaced mesh without any seams or misalignment.
export function buildTerrainTexture(width = 1024, height = 512): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(width, height);
  const dir = new THREE.Vector3();

  for (let py = 0; py < height; py++) {
    const v = py / height;
    const theta = v * Math.PI;
    const sinTheta = Math.sin(theta);
    const cosTheta = Math.cos(theta);
    for (let px = 0; px < width; px++) {
      const u = px / width;
      const phi = u * Math.PI * 2;
      dir.set(-Math.cos(phi) * sinTheta, cosTheta, Math.sin(phi) * sinTheta);

      const h = heightAt(dir);
      const c = terrainColor(dir, h);

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

// Displaces a SphereGeometry's vertices in place using the same height
// field the texture was painted from.
export function displaceSphere(geometry: THREE.SphereGeometry, radius: number, bumpHeight: number) {
  const positionAttr = geometry.attributes.position;
  const dir = new THREE.Vector3();
  for (let i = 0; i < positionAttr.count; i++) {
    dir.fromBufferAttribute(positionAttr, i).normalize();
    const h = displayHeight(heightAt(dir));
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
