// Quality tiers, and recovering from a lost WebGL context without looping.
//
// The page already reloaded itself when the GPU dropped the context, on the
// reasoning that a reload is better than a permanently blank canvas. That is
// true right up until the context loss is caused by the scene itself being
// too expensive for the device — at which point reloading rebuilds the exact
// same scene, loses the context again, and reloads again. The result is a
// page that shows the globe for a second or two and then vanishes, forever.
//
// So a reload after a context loss has to come back as something cheaper.
// The chosen tier is remembered for the tab, and the fallback ladder is
// walked down one rung per loss.

export type QualityTier = 'high' | 'medium' | 'low';

const STORAGE_KEY = 'planet-canvas-quality';
const LADDER: QualityTier[] = ['high', 'medium', 'low'];

function readStoredTier(): QualityTier | null {
  try {
    const stored = window.sessionStorage.getItem(STORAGE_KEY);
    if (stored && (LADDER as string[]).includes(stored)) return stored as QualityTier;
  } catch {
    // sessionStorage can throw in private-mode / sandboxed contexts; the
    // feature is a nicety, not something worth breaking startup over
  }
  return null;
}

function storeTier(tier: QualityTier): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, tier);
  } catch {
    /* see readStoredTier */
  }
}

/**
 * The tier to build this session at: whatever a previous context loss
 * downgraded us to, otherwise a guess from the device.
 */
export function currentTier(): QualityTier {
  const stored = readStoredTier();
  if (stored) return stored;

  // A coarse first guess only — it decides where on the ladder to *start*,
  // and an over-optimistic guess costs one reload rather than a broken page.
  //
  // hardwareConcurrency is a poor proxy on its own: current phones report
  // eight cores and would have been handed the heaviest tier, which is the
  // opposite of what they can take. A touch-primary pointer is a much more
  // honest signal for "this is a phone or tablet". deviceMemory is absent on
  // Safari and desktop Firefox, so a missing value is not treated as bad news.
  const memory = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
  if (memory !== undefined && memory <= 4) return 'low';

  const touchPrimary =
    typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  if (touchPrimary || (navigator.hardwareConcurrency ?? 8) <= 4) return 'medium';
  return 'high';
}

/** The next rung down, or null if we are already at the bottom. */
function downgrade(tier: QualityTier): QualityTier | null {
  const next = LADDER[LADDER.indexOf(tier) + 1];
  return next ?? null;
}

/**
 * Handle a lost context by coming back cheaper. At the bottom of the ladder
 * there is nothing left to give up, so stop reloading and leave the canvas
 * as it is rather than trapping the page in a loop.
 */
export function installContextLossRecovery(
  canvas: HTMLCanvasElement,
  tier: QualityTier,
  onGaveUp?: () => void,
): void {
  canvas.addEventListener(
    'webglcontextlost',
    (event) => {
      event.preventDefault();
      const next = downgrade(tier);
      if (!next) {
        console.warn('WebGL context lost at the lowest quality tier — not reloading again');
        onGaveUp?.();
        return;
      }
      console.warn(`WebGL context lost — reloading at "${next}" quality`);
      storeTier(next);
      window.setTimeout(() => window.location.reload(), 300);
    },
    false,
  );
}

export interface QualitySettings {
  /** longitudinal / latitudinal segments for the displaced globe */
  globeSegments: [number, number];
  oceanSegments: [number, number];
  /** 0 disables shadow mapping entirely */
  shadowMapSize: number;
  /** whether the depth-of-field pass runs at all */
  depthOfField: boolean;
  /** rings of blur taps; each ring is 8 taps plus a depth sample apiece */
  dofRings: number;
  maxPixelRatio: number;
  /** subdivision level for the foliage clump lobes */
  canopyDetail: number;
  /** width of the baked terrain/ocean/bump textures; height is half */
  textureWidth: number;
  /**
   * Multiplier on how many scatter candidates the vegetation passes try.
   * Candidate count drives startup cost almost linearly, because each one
   * evaluates the terrain height before the spacing test can reject it.
   */
  scatterBudget: number;
}

export function settingsFor(tier: QualityTier): QualitySettings {
  switch (tier) {
    case 'low':
      return {
        globeSegments: [180, 100],
        oceanSegments: [64, 40],
        shadowMapSize: 0,
        depthOfField: false,
        dofRings: 0,
        maxPixelRatio: 1,
        canopyDetail: 0,
        textureWidth: 512,
        scatterBudget: 0.4,
      };
    case 'medium':
      return {
        globeSegments: [256, 144],
        oceanSegments: [80, 48],
        shadowMapSize: 1024,
        depthOfField: true,
        dofRings: 1,
        maxPixelRatio: 1.25,
        canopyDetail: 1,
        textureWidth: 768,
        scatterBudget: 0.6,
      };
    default:
      return {
        globeSegments: [340, 190],
        oceanSegments: [96, 56],
        shadowMapSize: 1536,
        depthOfField: true,
        dofRings: 2,
        maxPixelRatio: 1.5,
        canopyDetail: 1,
        textureWidth: 1024,
        scatterBudget: 1,
      };
  }
}
