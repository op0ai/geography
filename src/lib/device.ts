/**
 * device.ts — deciding how much work this machine can actually take.
 *
 * The app shipped loading three 4096×2048 JPEGs. On disk that's 2.2 MB, which
 * looks harmless. Decoded on the GPU it is not:
 *
 *   4096 × 2048 × 4 bytes         = 33.5 MB per texture
 *   × 1.33 for the mipmap chain   = 44.6 MB
 *   × 3 textures                  = 134 MB
 *
 * iOS Safari kills a tab that leans on the GPU that hard, and it does it
 * without an error you can catch — the WebGL context is simply taken away and
 * the canvas goes blank. That was the "crashes on iPad" report. There was
 * nothing wrong with the rendering; there was too much of it.
 *
 * So: measure the device, pick a texture tier, and cap the pixel ratio. The
 * 2048 tier costs 33 MB, the 1024 tier 8 MB, and on a phone-sized screen you
 * genuinely cannot see the difference — the globe is 400px across.
 *
 * Everything here is a *hint*, deliberately. Nothing throws, nothing blocks
 * first paint, and if detection fails entirely we fall back to the middle tier
 * rather than assuming the best case. Guessing high crashes; guessing low
 * costs a little sharpness on a desktop that could have handled more.
 */

export type TextureTier = 4096 | 2048 | 1024

export interface DeviceProfile {
  tier: TextureTier
  /** Cap for react-three-fiber's `dpr`. */
  maxDpr: number
  /** Whether MSAA is affordable here. */
  antialias: boolean
  /** Anisotropic filtering samples — expensive on tile-based mobile GPUs. */
  anisotropy: number
  /** True for iOS/iPadOS, including iPads that now report as desktop Safari. */
  isAppleMobile: boolean
  /** Rough VRAM budget in MB we're willing to spend on globe textures. */
  budgetMb: number
  /** Human-readable reason, surfaced in the debug overlay. */
  reason: string
}

/**
 * iPadOS 13+ reports itself as "Macintosh" with no iPad token in the UA — a
 * deliberate Apple change so sites stop serving mobile layouts to tablets. The
 * only reliable tell left is a Mac that reports touch points, because no real
 * Mac does.
 */
export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  if (/iPad|iPhone|iPod/.test(ua)) return true
  return /Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1
}

/** Safari specifically, including iOS Chrome/Firefox which are Safari inside. */
export function isSafari(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  return /^((?!chrome|android|crios|fxios).)*safari/i.test(ua) || isIOS()
}

let cached: DeviceProfile | null = null

export function deviceProfile(): DeviceProfile {
  if (cached) return cached
  cached = detect()
  return cached
}

function detect(): DeviceProfile {
  const appleMobile = isIOS()

  // Server render / no DOM: assume the middle tier.
  if (typeof document === 'undefined' || typeof navigator === 'undefined') {
    return {
      tier: 2048,
      maxDpr: 1.5,
      antialias: true,
      anisotropy: 4,
      isAppleMobile: false,
      budgetMb: 40,
      reason: 'no DOM — assuming mid tier',
    }
  }

  // Probe the real GL limits rather than pattern-matching user agents. A
  // throwaway context: created, read, and immediately released so it doesn't
  // count against the (small) number of live contexts Safari allows.
  let maxTexture = 4096
  let rendererName = ''
  try {
    const c = document.createElement('canvas')
    const gl = (c.getContext('webgl2') ||
      c.getContext('webgl')) as WebGLRenderingContext | null
    if (gl) {
      maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number
      const dbg = gl.getExtension('WEBGL_debug_renderer_info')
      if (dbg) {
        rendererName = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) ?? '')
      }
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
  } catch {
    // Probing failed — stay conservative.
    maxTexture = 2048
  }

  const mem = (navigator as { deviceMemory?: number }).deviceMemory ?? 0
  const cores = navigator.hardwareConcurrency ?? 0
  const screenPx =
    window.screen.width * window.screen.height * (window.devicePixelRatio || 1) ** 2
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false
  const smallViewport = Math.min(window.innerWidth, window.innerHeight) < 700

  // Software rendering (SwiftShader, llvmpipe) — a GPU in name only.
  const software = /swiftshader|llvmpipe|software|basic render/i.test(rendererName)

  if (software) {
    return profile(1024, 1, false, 1, appleMobile, 'software renderer')
  }

  if (maxTexture < 4096) {
    return profile(1024, 1.5, false, 2, appleMobile, `MAX_TEXTURE_SIZE ${maxTexture}`)
  }

  if (appleMobile) {
    // The drawing buffer and every render target scale with dpr², so 2 → 1.5
    // removes ~44% of the framebuffer cost. Combined with the 2048 tier this
    // takes the total from ~200-260 MB to roughly 90 MB — comfortably under
    // the ~256 MB canvas ceiling iOS Safari enforces before it kills the tab.
    if (coarse && smallViewport) {
      // iPhone. The globe is never more than ~390 CSS px wide here.
      return profile(1024, 1.5, false, 4, true, 'iOS phone — 8 MB of texture')
    }
    return profile(2048, 1.5, false, 4, true, 'iPadOS — 33 MB of texture, MSAA off')
  }

  // Non-Apple mobile / low-memory laptops.
  if ((mem && mem <= 4) || (cores && cores <= 4 && coarse)) {
    return profile(1024, 1.5, false, 4, false, `deviceMemory ${mem || '?'} GB`)
  }

  if (coarse || smallViewport) {
    return profile(2048, 2, true, 8, false, 'touch device — mid tier')
  }

  return profile(4096, 2, true, 8, false, 'desktop GPU — full tier')
}

function profile(
  tier: TextureTier,
  maxDpr: number,
  antialias: boolean,
  anisotropy: number,
  isAppleMobile: boolean,
  reason: string,
): DeviceProfile {
  return {
    tier,
    maxDpr,
    antialias,
    anisotropy,
    isAppleMobile,
    budgetMb: Math.round(((tier * (tier / 2) * 4 * 1.33) / 1e6) * 3),
    reason,
  }
}

/** Texture URL for the current tier. */
export function textureUrl(base: string, tier: TextureTier): string {
  return `/textures/${base}_${tier}.jpg`
}

/**
 * Estimated GPU cost of the globe's texture set, in megabytes. Shown in the
 * debug overlay so a regression here is visible rather than theoretical.
 */
export function textureCostMb(tier: TextureTier, count = 3): number {
  return Math.round(((tier * (tier / 2) * 4 * 1.33 * count) / 1e6) * 10) / 10
}
