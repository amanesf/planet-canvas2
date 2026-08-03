import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32 } from './spatialHash';

// The reference image is not a globe photographed against nothing. It is a
// finished model sitting on a scratched wooden bench, with paint bottles
// and tools behind it and loose cotton and a spare tree in front of the
// lens, all thrown well out of focus. Every one of those elements is doing
// the same job: establishing that the subject is a physical object of a
// particular *size*, sitting in a place where such objects get made.
//
// A CSS gradient behind the canvas cannot participate in that, because it
// is not in the scene — it takes no light, sits at no depth, and so the
// depth-of-field pass has nothing to do with it. Building the surroundings
// as real geometry costs a handful of draw calls and gives the whole frame
// something the globe can be *in*.

function buildDeskTexture(): THREE.CanvasTexture {
  const w = 512;
  const h = 512;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const rand = mulberry32(90210);

  const base = ctx.createLinearGradient(0, 0, 0, h);
  base.addColorStop(0, '#6b4a30');
  base.addColorStop(0.55, '#53341f');
  base.addColorStop(1, '#3a2216');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);

  // plank seams and long grain — barely resolvable once defocused, but
  // they keep the surface from reading as a flat brown card in the
  // narrow strip that stays near enough to focus
  for (let i = 0; i < 5; i++) {
    const y = (i + 0.5) * (h / 5) + (rand() - 0.5) * 30;
    ctx.strokeStyle = 'rgba(20, 11, 7, 0.55)';
    ctx.lineWidth = 3 + rand() * 3;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  for (let i = 0; i < 70; i++) {
    const y = rand() * h;
    ctx.strokeStyle = `rgba(${rand() < 0.5 ? '18, 10, 6' : '92, 66, 44'}, ${0.05 + rand() * 0.12})`;
    ctx.lineWidth = 1 + rand() * 3;
    ctx.beginPath();
    let x = 0;
    let yy = y;
    ctx.moveTo(x, yy);
    while (x < w) {
      x += 60 + rand() * 120;
      yy += (rand() - 0.5) * 10;
      ctx.lineTo(x, yy);
    }
    ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(2, 2);
  return texture;
}

// ---------------------------------------------------------------------
// One batch per material, not one mesh per part
// ---------------------------------------------------------------------
// Every prop here used to be a small Group of meshes, and every mesh is a
// draw call: six paint bottles at three parts each, four brush jars at
// eight, a conifer at five. Measured, the clutter behind and in front of
// the subject accounted for most of the frame's hundred-odd draw calls —
// spent on objects that are never in focus. None of them move, so they can
// all be baked into one merged geometry per material and drawn a handful
// of times in total.
//
// Materials are shared rather than constructed per object for the same
// reason: each distinct material compiles its own shader program, and
// those compile in a block before the first frame can be presented.

const props = {
  glass: [] as THREE.BufferGeometry[],
  plastic: [] as THREE.BufferGeometry[],
  paper: [] as THREE.BufferGeometry[],
  wood: [] as THREE.BufferGeometry[],
  foliage: [] as THREE.BufferGeometry[],
  cotton: [] as THREE.BufferGeometry[],
};
type PropMaterial = keyof typeof props;

function emit(
  material: PropMaterial,
  geometry: THREE.BufferGeometry,
  place: (g: THREE.BufferGeometry) => void,
): void {
  place(geometry);
  props[material].push(geometry);
}

/** A paint bottle: squat body, screw cap, paper label. */
function buildPaintBottle(rand: () => number, at: THREE.Matrix4): void {
  const bodyHeight = 0.5 + rand() * 0.22;
  const radius = 0.17 + rand() * 0.05;

  emit('glass', new THREE.CylinderGeometry(radius, radius * 0.96, bodyHeight, 14), (g) => {
    g.translate(0, bodyHeight / 2, 0);
    g.applyMatrix4(at);
  });
  emit('plastic', new THREE.CylinderGeometry(radius * 0.72, radius * 0.78, 0.16, 14), (g) => {
    g.translate(0, bodyHeight + 0.08, 0);
    g.applyMatrix4(at);
  });
  emit(
    'paper',
    new THREE.CylinderGeometry(radius * 1.015, radius * 1.015, bodyHeight * 0.45, 14, 1, true),
    (g) => {
      g.translate(0, bodyHeight * 0.45, 0);
      g.applyMatrix4(at);
    },
  );
}

/** A loose ball of the same cotton the clouds are made of. */
function buildCottonWad(rand: () => number, at: THREE.Matrix4): void {
  for (let i = 0; i < 10; i++) {
    const r = 0.12 + rand() * 0.2;
    emit('cotton', new THREE.SphereGeometry(r, 7, 5), (g) => {
      g.translate((rand() - 0.5) * 0.5, (rand() - 0.5) * 0.35, (rand() - 0.5) * 0.5);
      g.applyMatrix4(at);
    });
  }
}

/** A jar of brushes — tall enough to reach into the frame from the bench. */
function buildBrushJar(rand: () => number, at: THREE.Matrix4): void {
  emit('glass', new THREE.CylinderGeometry(0.34, 0.3, 0.95, 16), (g) => {
    g.translate(0, 0.475, 0);
    g.applyMatrix4(at);
  });
  for (let i = 0; i < 6; i++) {
    const len = 1.5 + rand() * 0.9;
    emit('wood', new THREE.CylinderGeometry(0.025, 0.035, len, 5), (g) => {
      g.rotateZ((rand() - 0.5) * 0.5);
      g.rotateX((rand() - 0.5) * 0.5);
      g.translate((rand() - 0.5) * 0.34, 0.6 + len / 2, (rand() - 0.5) * 0.34);
      g.applyMatrix4(at);
    });
  }
}

/** A spare model conifer, the kind that gets glued onto layouts. */
function buildSpareTree(at: THREE.Matrix4): void {
  emit('wood', new THREE.CylinderGeometry(0.03, 0.05, 0.35, 6), (g) => {
    g.translate(0, 0.175, 0);
    g.applyMatrix4(at);
  });
  for (let i = 0; i < 4; i++) {
    const t = i / 4;
    emit('foliage', new THREE.ConeGeometry(0.34 * (1 - t * 0.62), 0.42, 8), (g) => {
      g.translate(0, 0.35 + t * 0.68, 0);
      g.applyMatrix4(at);
    });
  }
}

/**
 * Bench surface, backdrop, and the clutter around the subject. Everything
 * here sits well outside the focal plane on purpose — it is context, and
 * context that competes for attention with the subject is set dressing
 * that has stopped doing its job.
 */
export function buildWorkshop(): THREE.Group {
  const group = new THREE.Group();
  const rand = mulberry32(777);

  const deskMaterial = new THREE.MeshStandardMaterial({
    map: buildDeskTexture(),
    roughness: 0.62,
    metalness: 0,
  });

  const desk = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), deskMaterial);
  desk.rotation.x = -Math.PI / 2;
  desk.position.y = -2.08;
  desk.receiveShadow = true;
  group.add(desk);

  // the dim far wall of the room, so the frame doesn't open onto void
  // above the bench
  const wall = new THREE.Mesh(
    new THREE.PlaneGeometry(80, 40),
    new THREE.MeshStandardMaterial({ color: '#57422f', roughness: 1 }),
  );
  wall.position.set(0, 6, -13);
  group.add(wall);

  const at = (x: number, y: number, z: number, s: number | [number, number, number], spin = 0) => {
    const scale = typeof s === 'number' ? new THREE.Vector3(s, s, s) : new THREE.Vector3(...s);
    return new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), spin),
      scale,
    );
  };

  // paint bottles in a loose row behind the subject
  (
    [
      [-5.2, -6.2],
      [-3.6, -7.1],
      [-2.0, -6.4],
      [2.8, -6.8],
      [4.3, -6.0],
      [5.7, -7.2],
    ] as [number, number][]
  ).forEach(([x, z]) => {
    buildPaintBottle(rand, at(x, -2.08, z, 1.7, rand() * Math.PI * 2));
  });

  // A couple of taller items further back. The upper part of a portrait
  // frame was opening onto flat black; the reference fills the same space
  // with defocused shelf clutter.
  (
    [
      [-2.9, -5.0, 3.4],
      [3.4, -5.4, 3.0],
    ] as [number, number, number][]
  ).forEach(([x, z, h]) => {
    buildBrushJar(rand, at(x, -2.08, z, [1.4, h, 1.4]));
  });

  // Foreground clutter, close enough to the lens to be pure soft shape —
  // the strongest single cue that this is a photograph of something small.
  //
  // These have to be *tall*. The lens sits about six units above the bench
  // and looks slightly down, so anything standing on the bench between it
  // and the subject projects well below the bottom of the frame — measured
  // at roughly y = -2.4 in clip space, where the frame ends at -1. Only
  // objects that reach up toward the globe's own height get into shot at a
  // distance short enough to be properly out of focus.
  buildSpareTree(at(-1.95, -2.08, 6.3, 3.1));
  buildBrushJar(rand, at(2.35, -2.08, 5.6, 1.7));
  buildCottonWad(rand, at(2.9, -1.85, 2.4, 1.6));

  // One mesh per material for the whole of the above.
  const propMaterials: Record<PropMaterial, THREE.Material> = {
    glass: new THREE.MeshStandardMaterial({
      color: '#9fb0ad',
      roughness: 0.18,
      metalness: 0,
      transparent: true,
      opacity: 0.55,
    }),
    plastic: new THREE.MeshStandardMaterial({ color: '#26262a', roughness: 0.55 }),
    paper: new THREE.MeshStandardMaterial({
      color: '#d8d2c6',
      roughness: 0.9,
      side: THREE.DoubleSide,
    }),
    wood: new THREE.MeshStandardMaterial({ color: '#6b4a33', roughness: 0.8 }),
    foliage: new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHSL(0.27, 0.38, 0.26, THREE.SRGBColorSpace),
      roughness: 0.95,
      flatShading: true,
    }),
    cotton: new THREE.MeshStandardMaterial({ color: '#e8e6e4', roughness: 0.95 }),
  };

  (Object.keys(props) as PropMaterial[]).forEach((key) => {
    const parts = props[key];
    if (parts.length === 0) return;
    const merged = mergeGeometries(parts, false);
    parts.forEach((g) => g.dispose());
    parts.length = 0;
    const mesh = new THREE.Mesh(merged, propMaterials[key]);
    mesh.castShadow = true;
    group.add(mesh);
  });

  return group;
}
