import * as THREE from 'three';

// A gentle multi-step gradient for a restrained cel-shaded look — enough
// steps (and linear filtering between them) that it reads as "soft
// contouring" rather than a hard-edged toon/outline style.
export function createToonGradient(steps = 5): THREE.DataTexture {
  const data = new Uint8Array(steps);
  for (let i = 0; i < steps; i++) {
    data[i] = Math.round((i / (steps - 1)) * 255);
  }
  const texture = new THREE.DataTexture(data, steps, 1, THREE.RedFormat);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}
