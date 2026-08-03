import * as THREE from 'three';
import { fbm3 } from './noise';

// Tuned so land covers roughly 30% of the surface, like real Earth's
// land:sea ≈ 3:7 (verified empirically against heightAt's noise distribution).
export const SEA_LEVEL = 0.05;
const COAST_WIDTH = 0.012;

const deepColor = new THREE.Color('#3fb6e0');
const shoreColor = new THREE.Color('#ffe58a');
const landColor = new THREE.Color('#6bcf5a');
const peakColor = new THREE.Color('#ff8fc2');

export function heightAt(dir: THREE.Vector3): number {
  const n =
    fbm3(dir.x * 2.4, dir.y * 2.4, dir.z * 2.4, 4) * 0.65 +
    fbm3(dir.x * 5 + 9.2, dir.y * 5 + 9.2, dir.z * 5 + 9.2, 3) * 0.25 +
    fbm3(dir.x * 1.1 + 3.7, dir.y * 1.1 + 3.7, dir.z * 1.1 + 3.7, 2) * 0.1;
  return Math.max(n, -0.2); // flatten the deep ocean floor a bit
}

// water is flattened to sea level on the mesh so it doesn't visibly
// inherit the terrain noise as bumpy waves — only land pokes up
export function displayHeight(height: number): number {
  return height < SEA_LEVEL ? SEA_LEVEL - 0.02 : height;
}

const outColor = new THREE.Color();
function terrainColor(height: number): THREE.Color {
  if (height < SEA_LEVEL - COAST_WIDTH) {
    return outColor.copy(deepColor);
  }
  if (height < SEA_LEVEL + COAST_WIDTH) {
    return outColor
      .copy(deepColor)
      .lerp(shoreColor, (height - (SEA_LEVEL - COAST_WIDTH)) / (COAST_WIDTH * 2));
  }
  if (height < SEA_LEVEL + 0.08) {
    return outColor.copy(shoreColor).lerp(landColor, (height - SEA_LEVEL) / 0.08);
  }
  return outColor.copy(landColor).lerp(peakColor, Math.min((height - (SEA_LEVEL + 0.08)) / 0.25, 1));
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
      const c = terrainColor(h);

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
