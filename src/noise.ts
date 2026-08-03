// Compact 3D gradient noise (Perlin-style), seam-free because it is sampled
// directly in 3D world space on the sphere surface. Good enough for a
// placeholder "bumpy terrain" look before the real GPGPU simulation lands.

const PERM_SIZE = 256;
const permutation: number[] = [];
for (let i = 0; i < PERM_SIZE; i++) permutation.push(i);

// deterministic shuffle so the terrain looks the same every reload
function seededRandom(seed: number) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

const rand = seededRandom(1337);
for (let i = PERM_SIZE - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [permutation[i], permutation[j]] = [permutation[j], permutation[i]];
}
const perm = new Uint8Array(PERM_SIZE * 2);
for (let i = 0; i < PERM_SIZE * 2; i++) perm[i] = permutation[i % PERM_SIZE];

function fade(t: number) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(t: number, a: number, b: number) {
  return a + t * (b - a);
}

function grad(hash: number, x: number, y: number, z: number) {
  const h = hash & 15;
  const u = h < 8 ? x : y;
  const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
  return (h & 1 ? -u : u) + (h & 2 ? -v : v);
}

export function noise3(x: number, y: number, z: number): number {
  const X = Math.floor(x) & 255;
  const Y = Math.floor(y) & 255;
  const Z = Math.floor(z) & 255;
  x -= Math.floor(x);
  y -= Math.floor(y);
  z -= Math.floor(z);
  const u = fade(x);
  const v = fade(y);
  const w = fade(z);

  const A = perm[X] + Y;
  const AA = perm[A] + Z;
  const AB = perm[A + 1] + Z;
  const B = perm[X + 1] + Y;
  const BA = perm[B] + Z;
  const BB = perm[B + 1] + Z;

  return lerp(
    w,
    lerp(
      v,
      lerp(u, grad(perm[AA], x, y, z), grad(perm[BA], x - 1, y, z)),
      lerp(u, grad(perm[AB], x, y - 1, z), grad(perm[BB], x - 1, y - 1, z)),
    ),
    lerp(
      v,
      lerp(u, grad(perm[AA + 1], x, y, z - 1), grad(perm[BA + 1], x - 1, y, z - 1)),
      lerp(u, grad(perm[AB + 1], x, y - 1, z - 1), grad(perm[BB + 1], x - 1, y - 1, z - 1)),
    ),
  );
}

// fractal brownian motion: layered noise for more organic-looking bumps
export function fbm3(x: number, y: number, z: number, octaves = 4): number {
  let amplitude = 1;
  let frequency = 1;
  let sum = 0;
  let max = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise3(x * frequency, y * frequency, z * frequency) * amplitude;
    max += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return sum / max;
}
