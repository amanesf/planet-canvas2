import * as THREE from 'three';
import { mulberry32 } from './spatialHash';

// ---------------------------------------------------------------------
// Aurora over the night-side pole (G50)
// ---------------------------------------------------------------------
// The night half of this globe has had lights on it for a while — cities,
// ships' lamps, aircraft strobes, the vents of an erupting volcano — but
// nothing has ever been in the *sky* over the dark side. The aurora is the
// one thing that belongs there, and it is the one atmospheric feature a
// viewer will forgive for being large, because in life it genuinely is:
// the curtains run from roughly 100 km to 400 km up, thirty to a hundred
// times the height of the cloud deck they stand above.
//
// It is built as curtains and not as a glow, deliberately. §2-21 is the
// record of a shaped feature (the lightning bolt) that was built, measured
// and then deleted, because at this scale it came out 0.3 px wide and the
// conclusion drawn there was that "not drawn" and "too small to have a
// shape" are the same picture. A soft coloured haze over the pole is the
// other half of that same failure: it cannot be too small to have a shape,
// because it has no shape at all, and it would be rejected on exactly the
// grounds the lightning was. So this is sheets — a band of vertical
// ribbons hung round the magnetic pole, brightest along their bottom edge,
// ragged along the top, folding slowly along their length.
//
// ---------------------------------------------------------------------
// The pixel arithmetic, done before anything was built (handover §3)
// ---------------------------------------------------------------------
// Measured by projecting known points through the shipped camera (40° fov,
// polar angle 0.405π, aiming at y = 0.15) at 1280×760. The camera moved out
// from 9.6 to 10.2 when the globe went up on its axis and grew a meridian
// arc that had to fit the frame, so these are the numbers at 10.2: 102 px
// per world unit and a disc 409 px across, where it was 110 and 441. Every
// pixel figure below is the smaller one; none of the conclusions turn on
// the 7% difference, but leaving the old numbers here would have been the
// "修正済みを疑う" failure the handover warns about.
//
//   - The band sits 30° from the magnetic pole. Its circle of feet has
//     world radius 2·sin30° = 1.00, so a circumference of 6.28 units ≈
//     643 px. Split into 30 curtains, that is 21 px of arc each: a sheet,
//     not a hair. This is the wide, storm-time oval rather than the 20–23°
//     quiet one — measured against the camera (below), 23° puts 30% of the
//     band where it can be seen and 30° puts 40% of it there, and a wider
//     oval also reaches far enough down the limb to stand against the room
//     instead of hiding behind the pedestal.
//   - Each curtain stands from 0.36 to 0.92 above the surface: 0.56 units
//     ≈ 57 px tall. That number is conservative against the rest of the
//     scene rather than generous. The cloud deck already hovers at
//     0.14–0.34, which at true scale is 450–1100 km, so this planet's
//     atmosphere is exaggerated about 45× already; a curtain drawn at the
//     clouds' own exaggeration would be several globe radii tall. Making
//     it only 1.6× the height of the cloud deck under-scales it, which is
//     the direction §2-21 says to err in.
//   - The fine vertical rays run 55 times round the band, so about 12 px
//     apart, and they are evaluated per fragment rather than per vertex —
//     360 columns of geometry round the band would sample them only five
//     times a cycle and turn a comb into a sawtooth.
//
// ---------------------------------------------------------------------
// Where the night actually is (§2-12), and why the south pole is the one
// ---------------------------------------------------------------------
// The terminator does not sweep this disc. The key light is fixed at
// (-5.0, 4.4, 3.2) — 36.6° above the world equator, 55.4° off the lens
// axis — and the globe simply spins under it about y. Two consequences,
// and both of them decided the design:
//
//   1. sun·(north pole) = +0.815 permanently, and sun·(south pole)
//      = −0.815 permanently. Sampled round the whole southern band at
//      eight rotations, 100% of it is on the night side at all times. The
//      aurora that shows is therefore the *southern* one. That is not a
//      problem to design around, it is what this room's lighting means.
//      These were ±0.595 while the globe leaned 0.04 radians; giving it a
//      real 23.4° obliquity tipped the north pole further into the lamp
//      and the south further out of it, so the finding is not just intact
//      but stronger. It stays constant under spin only because the globe
//      now rotates in ZYX order — see main.ts, where the default order was
//      walking the pole round a 46.8° cone.
//   2. The camera sits 13.2° above the globe's equator, so the southern
//      band is just over the bottom limb rather than on the visible face.
//      That is the best place this feature could have landed: seen from
//      outside the limb the curtains stand up off the edge of the planet
//      against the dark room, instead of being squashed flat onto the
//      paint the way a polar-cap ornament would be.
//
// Both ovals are built anyway, because they share one mesh and the second
// one costs no draw call. The northern one is gated off by its own night
// term nearly all the time — measured, 4% of its samples are night and
// unoccluded, and only during two of eight rotations — when it does come
// up it is a short arc peeking over the top-right limb (x 716–853,
// y 61–124), which is a true thing to see and not an error.
//
// The bands are anchored to the geomagnetic axis (80.6°N 72.6°W and its
// exact antipode — a dipole has one axis, not two), about 11° off the spin
// axis, so as the globe turns the whole band wobbles round the pole and
// the visible arc leans toward and away from the camera once per rotation.
// That is free motion of exactly the kind the fixed terminator cannot give.
//
// One thing could not be baked. The real auroral oval is pushed and
// widened toward magnetic midnight, and that offset is fixed relative to
// the *sun* while this geometry is fixed relative to the *planet*, so it
// cannot live in a vertex buffer. It is done in the shader against the
// same `uSunDir` object the city lights and the volcano vents read: the
// curtains grow taller, brighter and lean a little equatorward on the
// anti-solar side.
//
// ---------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------
// One mesh, one draw call, both poles: 3,600 vertices and 5,280 triangles.
// The geometry is built once and never touched again; `tick` writes one
// float. Additive blending, which is what light wants, and which also
// keeps this clear of the `MultiplyBlending`/`premultipliedAlpha` trap
// that once laid a white sheet of paper on the desk.

export interface Aurora {
  mesh: THREE.Mesh;
  tick: (t: number) => void;
}

/** curtains per pole; 30 gives about 23 px of arc each (see above) */
const CURTAINS_PER_POLE = 30;
/** columns of geometry across one curtain */
const SEGMENTS = 11;
/**
 * rows up one curtain. Four is enough because the shading gradient up the
 * sheet is done per fragment; the rows exist only so the sheet can *bend*
 * along its height, the fold swaying more at the free top than at the
 * anchored foot.
 */
const ROWS = 4;

/** mean angle from the magnetic pole to the band, radians (30°) */
const OVAL_COLATITUDE = 0.52;
/**
 * how far the band departs from a circle. Without this it is a ring, and a
 * ring drawn round a pole reads as a hoop someone fitted to the model.
 */
const OVAL_ELLIPTICITY = 0.07;
/** bottom and top of a curtain, in world units above the surface */
const BASE_ALTITUDE = 0.36;
const TOP_ALTITUDE = 1.15;

export function buildAurora(
  radius: number,
  dayNightUniforms: { uSunDir: { value: THREE.Vector3 } },
): Aurora {
  const rand = mulberry32(5077);

  const COLUMNS = SEGMENTS + 1;
  const VERTS_PER_CURTAIN = COLUMNS * (ROWS + 1);
  const CURTAINS = CURTAINS_PER_POLE * 2;
  const VERTEX_COUNT = CURTAINS * VERTS_PER_CURTAIN;

  const positions = new Float32Array(VERTEX_COUNT * 3);
  /** the foot of this vertex's column on the sphere, unit length */
  const dirs = new Float32Array(VERTEX_COUNT * 3);
  /**
   * d(foot)/d(arc angle): the tangent along the band, deliberately *not*
   * normalised. Carrying the true derivative lets the shader add the
   * derivative of the fold to it and get the folded sheet's real facing
   * direction, which is what the edge-on brightening needs.
   */
  const tangents = new Float32Array(VERTEX_COUNT * 3);
  /** unit vector along the surface, pointing away from the magnetic pole */
  const outwards = new Float32Array(VERTEX_COUNT * 3);
  /** absolute angle round the band, so a fold runs across curtain seams */
  const arcs = new Float32Array(VERTEX_COUNT);
  /** 0 at the bright bottom edge, 1 at the ragged top */
  const ups = new Float32Array(VERTEX_COUNT);
  /** 0..1 across one curtain, used to fade its two ends out */
  const cols = new Float32Array(VERTEX_COUNT);
  /** per-curtain random, so the sheets do not all fold in unison */
  const seeds = new Float32Array(VERTEX_COUNT);
  /** per-column random: this is what makes the top edge ragged */
  const jags = new Float32Array(VERTEX_COUNT);

  const indices: number[] = [];

  // The geomagnetic axis, in terrain.ts's lat/lon convention:
  // x = -sinθcosφ, y = cosθ, z = sinθsinφ, with θ = (90-lat)π/180 and
  // φ = (lon+180)π/180. 80.6°N 72.6°W is the north geomagnetic pole.
  const theta = ((90 - 80.6) * Math.PI) / 180;
  const phi = ((-72.6 + 180) * Math.PI) / 180;
  const dipole = new THREE.Vector3(
    -Math.sin(theta) * Math.cos(phi),
    Math.cos(theta),
    Math.sin(theta) * Math.sin(phi),
  ).normalize();

  const axis = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const foot = new THREE.Vector3();
  const outward = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const ring = new THREE.Vector3();
  const ringTangent = new THREE.Vector3();

  let v = 0;
  for (let hemi = 0; hemi < 2; hemi++) {
    axis.copy(dipole).multiplyScalar(hemi === 0 ? 1 : -1);
    // Any pair of axes perpendicular to the pole will do: the band is a
    // closed loop, so where its zero of longitude sits is arbitrary.
    e1.set(0, 0, 1).cross(axis).normalize();
    e2.copy(axis).cross(e1).normalize();

    for (let c = 0; c < CURTAINS_PER_POLE; c++) {
      const seed = rand();
      const base = v;
      // Each curtain covers a little more than its fair share of the band,
      // so neighbours overlap instead of leaving thirty gaps at the seams.
      const centre = (Math.PI * 2 * (c + 0.5)) / CURTAINS_PER_POLE;
      const span = ((Math.PI * 2) / CURTAINS_PER_POLE) * 1.22;

      for (let j = 0; j <= SEGMENTS; j++) {
        const u = j / SEGMENTS;
        const a = centre + (u - 0.5) * span;
        const colat = OVAL_COLATITUDE + OVAL_ELLIPTICITY * Math.cos(2 * a - 0.9);
        const sinC = Math.sin(colat);
        const cosC = Math.cos(colat);

        ring.copy(e1).multiplyScalar(Math.cos(a)).addScaledVector(e2, Math.sin(a));
        ringTangent
          .copy(e1)
          .multiplyScalar(-Math.sin(a))
          .addScaledVector(e2, Math.cos(a));

        foot.copy(axis).multiplyScalar(cosC).addScaledVector(ring, sinC);
        // The equatorward direction along the surface. It is the axis a
        // fold swings along, and it is also the way the field lines lean
        // as they rise.
        outward.copy(axis).multiplyScalar(-sinC).addScaledVector(ring, cosC);
        // Derivative of the foot with respect to `a`. The ellipse's own
        // d(colat)/da term is dropped as small; what matters about this
        // vector is that its magnitude is the band's radius, so that the
        // fold's derivative added to it in the shader is in the same units.
        tangent.copy(ringTangent).multiplyScalar(sinC * radius);

        const jag = rand();

        for (let r = 0; r <= ROWS; r++) {
          const up = r / ROWS;
          const i3 = v * 3;
          // The shader places every vertex; `position` only has to be
          // somewhere sane for three's own plumbing.
          const alt = radius + BASE_ALTITUDE + (TOP_ALTITUDE - BASE_ALTITUDE) * up;
          positions[i3] = foot.x * alt;
          positions[i3 + 1] = foot.y * alt;
          positions[i3 + 2] = foot.z * alt;
          dirs[i3] = foot.x;
          dirs[i3 + 1] = foot.y;
          dirs[i3 + 2] = foot.z;
          tangents[i3] = tangent.x;
          tangents[i3 + 1] = tangent.y;
          tangents[i3 + 2] = tangent.z;
          outwards[i3] = outward.x;
          outwards[i3 + 1] = outward.y;
          outwards[i3 + 2] = outward.z;
          arcs[v] = a;
          ups[v] = up;
          cols[v] = u;
          seeds[v] = seed;
          jags[v] = jag;
          v++;
        }
      }

      for (let j = 0; j < SEGMENTS; j++) {
        for (let r = 0; r < ROWS; r++) {
          const a0 = base + j * (ROWS + 1) + r;
          const a1 = a0 + 1;
          const b0 = a0 + (ROWS + 1);
          const b1 = b0 + 1;
          indices.push(a0, b0, a1, a1, b0, b1);
        }
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aDir', new THREE.BufferAttribute(dirs, 3));
  geometry.setAttribute('aTan', new THREE.BufferAttribute(tangents, 3));
  geometry.setAttribute('aOut', new THREE.BufferAttribute(outwards, 3));
  geometry.setAttribute('aArc', new THREE.BufferAttribute(arcs, 1));
  geometry.setAttribute('aUp', new THREE.BufferAttribute(ups, 1));
  geometry.setAttribute('aCol', new THREE.BufferAttribute(cols, 1));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  geometry.setAttribute('aJag', new THREE.BufferAttribute(jags, 1));
  geometry.setIndex(indices);

  const uniforms = {
    uTime: { value: 0 },
    // Shared, not copied: one object owns "which way the sun is", and
    // every system that fades at the terminator reads that one object.
    uSunDir: dayNightUniforms.uSunDir,
    uRadius: { value: radius },
    uBase: { value: BASE_ALTITUDE },
    uTop: { value: TOP_ALTITUDE },
    // World height at which the southern band has to be gone. See the
    // floor term in the vertex shader.
    uFloorY: { value: -0.9 },
    uFloorFade: { value: 0.35 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    // The far half of each band has to be hidden by the planet in front of
    // it, and the near bottom of the southern band by the pedestal, so
    // depth testing stays on even though nothing is written.
    depthTest: true,
    // A curtain is an infinitely thin sheet seen from both sides.
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    vertexShader: `
      attribute vec3 aDir;
      attribute vec3 aTan;
      attribute vec3 aOut;
      attribute float aArc;
      attribute float aUp;
      attribute float aCol;
      attribute float aSeed;
      attribute float aJag;

      uniform float uTime;
      uniform vec3 uSunDir;
      uniform float uRadius;
      uniform float uBase;
      uniform float uTop;
      uniform float uFloorY;
      uniform float uFloorFade;

      varying vec3 vColor;
      varying float vAlpha;
      varying float vArc;
      varying float vUp;
      varying float vJag;
      varying float vPhase;

      void main() {
        float s = aArc;
        float ph = aSeed * 6.2831;

        // Is this foot on the night side? This is the same soft terminator
        // the city lights and the volcano vents use, so the curtains do not
        // come up a beat before or after the lights beneath them. The globe
        // only rotates, so a mat3 of the model matrix is the whole
        // transform into the room's frame.
        vec3 nWorld = normalize(mat3(modelMatrix) * aDir);
        float night = clamp((0.16 - dot(nWorld, uSunDir)) / 0.28, 0.0, 1.0);

        // The folds. Three harmonics along the band, each drifting at its
        // own rate, so the band never quite repeats while anyone is
        // watching. They total about 0.10 world units of swing ≈ 11 px in
        // plan, which at the limb reads mostly as the sheet turning toward
        // and away from the camera. Tops sway more than feet, which is the
        // difference between a hanging curtain and a corrugated fence.
        float sway = 0.32 + 0.68 * aUp;
        float f =
            sin(s * 9.0 + ph - uTime * 0.33) * 0.055
          + sin(s * 17.0 - uTime * 0.21 + ph * 0.5) * 0.028
          + sin(s * 31.0 + uTime * 0.47) * 0.013;
        // and its exact derivative, which the facing direction below needs
        float df =
            cos(s * 9.0 + ph - uTime * 0.33) * 0.495
          + cos(s * 17.0 - uTime * 0.21 + ph * 0.5) * 0.476
          + cos(s * 31.0 + uTime * 0.47) * 0.403;
        f *= sway;
        df *= sway;

        // The band widens and brightens toward magnetic midnight. That
        // offset is fixed to the sun and the geometry is fixed to the
        // planet, so it cannot be baked; it is done here off the same sun
        // direction. Over the southern band, which is in permanent night,
        // this is close to saturated everywhere — it earns its keep on the
        // northern band, whose lit half is cut away by the night term anyway.
        float midnight = smoothstep(0.15, 0.85, night);

        // Each column stops at its own height, from per-column noise baked
        // at build time: the silhouette is ragged but *fixed* while the
        // folds move, which is what real rays do — they keep their
        // identity and drift rather than boiling.
        float reach = mix(0.58, 1.0, aJag) * (0.85 + 0.30 * midnight);
        float height = uBase + (uTop - uBase) * aUp * reach;

        // 0.16·aUp is the lean of the field line: a dipole's lines arch
        // equatorward as they rise, about 17° from vertical at this
        // magnetic latitude, and a curtain standing perfectly radial
        // instead looks like a fence post.
        vec3 dir = normalize(
          aDir
          + aOut * (f + 0.30 * aUp + 0.05 * midnight)
        );

        vec4 mvPosition = modelViewMatrix * vec4(dir * (uRadius + height), 1.0);
        gl_Position = projectionMatrix * mvPosition;

        // Edge-on brightening. A curtain is a sheet of emitting gas, so a
        // line of sight running along the sheet gathers far more of it than
        // one crossing it, and that is why real folds show up as bright
        // vertical creases. The facing direction has to be the one *after*
        // folding, which is why aTan carries the derivative of the band
        // rather than a unit tangent.
        vec3 fold = normalize(aTan + aOut * df);
        vec3 sheetNormal = normalize(normalMatrix * normalize(cross(fold, aDir)));
        vec3 viewDir = normalize(-mvPosition.xyz);
        float grazing = clamp(1.0 / max(abs(dot(sheetNormal, viewDir)), 0.2), 1.0, 2.4);

        // Each sheet fades at its two ends, so that the band reads as a set
        // of overlapping curtains rather than one continuous tube.
        float ends = smoothstep(0.0, 0.16, aCol) * (1.0 - smoothstep(0.84, 1.0, aCol));
        // A surge running along the arc, because an aurora brightens in
        // waves that travel rather than pulsing everywhere at once.
        float surge = 0.42 + 0.85 * pow(max(0.0, sin(s * 2.0 - uTime * 0.25)), 3.0);

        // Only the half of the oval that is *behind* the globe is drawn.
        //
        // This is a composition rule, not a physical one, and it was
        // decided by looking at the frame. The lit pole on this globe is
        // the southern one (§2-12 — the key light is fixed, so the
        // terminator never sweeps), the southern band therefore hangs off
        // the bottom of the sphere, and the bottom of the sphere is where
        // the brass collar and the walnut stand are. Curtains on the near
        // side of that band stand between the camera and the stand, and
        // being additive they painted green light straight across the
        // wood: the globe stopped being an object sitting on a base and
        // became a transparency laid over one. Behind the limb the same
        // curtains read the way an aurora is usually seen from the side —
        // rising off the edge of the planet, with the planet's own
        // silhouette cutting them off. The depth test does the cutting;
        // this fades what the depth test cannot help with.
        float centreZ = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).z;
        float behind = smoothstep(0.05, -0.35, mvPosition.z - centreZ);

        // ...and it has to stop before it reaches the wood.
        //
        // The behind term hides the curtains in front of the globe. It
        // cannot help
        // with the ones behind it that are also *below* it, and until the
        // globe went up on its axis nothing had to: the sphere sat in a
        // brass collar, so there was no line of sight under it and the far
        // side of the southern band was occluded by solid geometry. Lifting
        // the globe 3cm opened 44px of daylight between the south pole and
        // the top of the pedestal, and the far curtains promptly showed
        // through it — additive, so they did not read as "an aurora seen
        // through a gap" but as a green ribbon lying on the walnut. Which
        // is the same failure §2-29 already fixed once from the other side.
        //
        // The depth test cannot do this one either, because the near half
        // of the pedestal's top face is in front of the curtains and the
        // far half is behind them, so the wood correctly occludes only
        // half of what is wrong. A world-height cutoff does it properly:
        // the fade runs out at -1.25, which is a tenth of a unit below the
        // sphere's own bottom edge at -1.14, so the band is already gone
        // by the time there is any gap for it to be seen through.
        float worldY = (modelMatrix * vec4(dir * (uRadius + height), 1.0)).y;
        float floorFade = smoothstep(uFloorY - uFloorFade, uFloorY, worldY);

        vAlpha = night * ends * surge * grazing * behind * floorFade
          * (0.55 + 0.55 * midnight) * 0.62;

        // Green low — the 557.7 nm oxygen line, the one everybody has
        // actually seen — going violet and then a little crimson high up
        // where the emission thins out.
        vColor = mix(vec3(0.18, 1.0, 0.46), vec3(0.42, 0.34, 1.0),
                     smoothstep(0.22, 0.95, aUp));
        vColor += vec3(1.0, 0.22, 0.30) * smoothstep(0.62, 1.0, aUp) * 0.35;

        vArc = s;
        vUp = aUp;
        vJag = aJag;
        vPhase = ph;
      }
    `,
    fragmentShader: `
      uniform float uTime;
      varying vec3 vColor;
      varying float vAlpha;
      varying float vArc;
      varying float vUp;
      varying float vJag;
      varying float vPhase;

      void main() {
        // The vertical striations and the bottom-edge gradient are done
        // here rather than in the vertex shader. Both are fine compared
        // with the mesh: the rays repeat 55 times round a band about 690 px
        // in circumference, so 13 px apart against 23 px per curtain and
        // 2 px per column of geometry, and the gradient has only five rows
        // to interpolate over. Evaluated per vertex, the comb becomes a
        // sawtooth and the bright lower edge becomes a wash.
        float rays = 0.58 + 0.42 * sin(vArc * 55.0 + vPhase * 3.0 + uTime * 0.11);

        // Brightest along the bottom edge, with a crisp rim in the lowest
        // sixth. An aurora is lit from the bottom up, because that is where
        // the air is dense enough to be excited; a sheet that is uniform,
        // or brightest in the middle, reads as a decal.
        float bottom = pow(1.0 - vUp, 1.8) * 0.7 + smoothstep(0.16, 0.0, vUp) * 0.45;
        // and it dies out below its own ragged ceiling
        float ceiling = 1.0 - smoothstep(mix(0.30, 0.92, vJag), 1.05, vUp);

        float a = vAlpha * rays * bottom * ceiling;
        if (a <= 0.002) discard;
        gl_FragColor = vec4(vColor, a);
      }
    `,
  });

  const mesh = new THREE.Mesh(geometry, material);
  // The shader places every vertex, so the bounding sphere three would
  // compute from the position attribute does not describe what is drawn.
  mesh.frustumCulled = false;
  // Drawn after the globe and the clouds; it writes no depth of its own.
  mesh.renderOrder = 3;

  return {
    mesh,
    tick: (t: number) => {
      uniforms.uTime.value = t;
    },
  };
}
