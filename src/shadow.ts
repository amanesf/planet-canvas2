import * as THREE from 'three';

// Matches main.ts's keyLight position — fake contact shadows should fall
// away from the same light direction real shadows would, instead of
// being plain circles centered directly under each object. A raking key
// light with directionless blob shadows was reading as flat/CG; an
// elongated shadow that consistently points one way sells "one light
// source, real geometry" far more than the blob's softness ever could.
const LIGHT_DIR = new THREE.Vector3(4, 5, 3).normalize();

const scratchA = new THREE.Vector3();
const scratchCross = new THREE.Vector3();
const scratchTransformedUp = new THREE.Vector3();
const up = new THREE.Vector3(0, 1, 0);
const planeNormal = new THREE.Vector3(0, 0, 1);

// The light's own direction projected onto the surface's local tangent
// plane at this point — a real shadow falls along this line, away from
// the light. Where the light is nearly straight overhead (tangent
// component ~0, e.g. right at local "noon"), there's no strong direction
// to fall back on, so keep the previous random spin instead of snapping
// to an arbitrary axis.
function tangentShadowDir(normal: THREE.Vector3, fallbackSpin: number): THREE.Vector3 {
  const tangential = scratchA.copy(LIGHT_DIR).addScaledVector(normal, -normal.dot(LIGHT_DIR));
  if (tangential.lengthSq() < 1e-5) {
    return scratchA.set(Math.cos(fallbackSpin), 0, Math.sin(fallbackSpin));
  }
  return tangential.normalize().negate();
}

// Orients + positions a shadow-decal plane instance: aligned flat against
// the surface, stretched into an ellipse, and rotated so its long axis
// points along the tangential shadow direction — then nudged slightly
// off-center in that same direction, like a real cast shadow trailing
// away from its object rather than sitting perfectly underneath it.
export function orientShadowDecal(
  dummy: THREE.Object3D,
  position: THREE.Vector3,
  normal: THREE.Vector3,
  size: number,
  stretch: number,
  fallbackSpin: number,
) {
  const shadowDir = tangentShadowDir(normal, fallbackSpin);

  const align = new THREE.Quaternion().setFromUnitVectors(planeNormal, normal);
  scratchTransformedUp.copy(up).applyQuaternion(align);

  const cosAngle = THREE.MathUtils.clamp(scratchTransformedUp.dot(shadowDir), -1, 1);
  scratchCross.crossVectors(scratchTransformedUp, shadowDir);
  const sign = scratchCross.dot(normal) < 0 ? -1 : 1;
  const spin = Math.acos(cosAngle) * sign;

  const spinQ = new THREE.Quaternion().setFromAxisAngle(normal, spin);
  dummy.quaternion.copy(spinQ).multiply(align);

  dummy.position.copy(position).addScaledVector(shadowDir, size * stretch * 0.35);
  dummy.scale.set(size, size * stretch, 1);
}
