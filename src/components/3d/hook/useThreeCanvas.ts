import { shallowRef, ref, Ref } from "vue"
import { CanvasTexture, RGBAFormat, ClampToEdgeWrapping, LinearFilter, SRGBColorSpace } from "three"


export interface UseThreeCanvasOptions {

  heightScaleRef?: Ref<number>
}

export const useThreeCanvas = (options: UseThreeCanvasOptions = {}) => {

  const surfaceCanvas = shallowRef<HTMLCanvasElement | null>(null)
  const surfaceContext = shallowRef<CanvasRenderingContext2D | null>(null)
  const surfaceTexture = shallowRef<CanvasTexture | null>(null)
  const surfaceCanvasSize = ref({ width: 512, height: 512 })

  const renderQueue = ref<(() => void)[]>([])
  const isRendering = ref(false)
  /* ------------------------------------------------------------
   *  visibility control
   * ------------------------------------------------------------ */
  const labelsVisible = ref(true)

  // visibility control for labels
  const setLabelVisibility = (visible: boolean) => {
    if (labelsVisible.value === visible) return

    labelsVisible.value = visible

    if (!surfaceContext.value || !surfaceCanvas.value) return

    const { totalScale } = getScalingFactors()
    const displayWidth = surfaceCanvasSize.value.width / totalScale
    const displayHeight = surfaceCanvasSize.value.height / totalScale

    if (!visible) {

      surfaceContext.value.clearRect(0, 0, displayWidth, displayHeight)
      updateSurfaceTexture(true)
    } else {

      updateSurfaceTexture(true)
    }
  }

  const _heightScale = ref<number>(1)


  const getScalingFactors = () => {
    const devicePixelRatio = window.devicePixelRatio || 1
    const antiAliasScale = 2.0
    return {
      devicePixelRatio,
      antiAliasScale,
      totalScale: devicePixelRatio * antiAliasScale
    }
  }

  const setupCanvasContext = (
    ctx: CanvasRenderingContext2D,
    drawOptions?: {
      lineWidth?: number
      strokeStyle?: string
      fillStyle?: string
      globalAlpha?: number
    }
  ) => {
    const { devicePixelRatio, antiAliasScale } = getScalingFactors()

    if (drawOptions) {
      const hasAlpha = drawOptions.globalAlpha !== undefined

      
      const maybeConvertColor = (col?: string) => {
        if (!col) return undefined
        if (/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/.test(col)) {
          const alpha = hasAlpha ? (drawOptions.globalAlpha as number) : 1
          return hexToRGBAString(col, alpha)
        }
        return col
      }

      const stroke = maybeConvertColor(drawOptions.strokeStyle)
      const fill = maybeConvertColor(drawOptions.fillStyle)

      if (stroke) ctx.strokeStyle = stroke as string
      if (fill) ctx.fillStyle = fill as string

      // After embedding alpha in color string we reset globalAlpha to 1 to avoid double-multiplication.
      ctx.globalAlpha = 1

      // keep stroke widths readable regardless of height-scale / DPI
      const baseLineWidth = drawOptions.lineWidth || 6
      const heightScale = _heightScale.value
      const heightScaleFactor = heightScale > 1 ? 6 / Math.sqrt(heightScale) : Math.sqrt(6 / heightScale)
      ctx.lineWidth = (baseLineWidth * heightScaleFactor) / (devicePixelRatio * antiAliasScale)
    }

    ctx.lineCap = "round"
    ctx.lineJoin = "round"
    ctx.miterLimit = 10
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = "high"
    ctx.globalCompositeOperation = "source-over"
    ctx.shadowColor = "transparent"
    ctx.shadowBlur = 0
    ctx.shadowOffsetX = 0
    ctx.shadowOffsetY = 0
  }

  const createSurfaceCanvas = (width: number, height: number) => {
    const { totalScale } = getScalingFactors()
    const actualWidth = width * totalScale
    const actualHeight = height * totalScale

    const canvas = document.createElement("canvas")
    canvas.width = actualWidth
    canvas.height = actualHeight
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`

    const context = canvas.getContext("2d", {
      alpha: true,
      antialias: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false
    }) as CanvasRenderingContext2D | null

    if (!context) {
      console.error("[useThreeCanvas] failed to acquire a 2D rendering context")
      return null
    }

    context.scale(totalScale, totalScale)
    setupCanvasContext(context)

    context.fillStyle = "rgba(0, 0, 0, 0)"
    context.fillRect(0, 0, width, height)

    const texture = new CanvasTexture(canvas)
    texture.flipY = false
    texture.needsUpdate = true
    texture.format = RGBAFormat
    texture.generateMipmaps = false
    texture.minFilter = LinearFilter
    texture.magFilter = LinearFilter
    texture.wrapS = texture.wrapT = ClampToEdgeWrapping
    texture.premultiplyAlpha = false
    texture.unpackAlignment = 1
    texture.colorSpace = SRGBColorSpace 
    // expose via refs so external code can react to changes
    surfaceCanvas.value = canvas
    surfaceContext.value = context
    surfaceTexture.value = texture
    surfaceCanvasSize.value = { width: actualWidth, height: actualHeight }

    return texture
  }


  const processRenderQueue = () => {
    if (isRendering.value || renderQueue.value.length === 0) return

    isRendering.value = true
    requestAnimationFrame(() => {
      const tasks = [...renderQueue.value]
      renderQueue.value = []
      if (!labelsVisible.value) {
        // visibility off – skip executing queued tasks to avoid unnecessary work
        isRendering.value = false
        return
      }
      tasks.forEach((fn) => fn())
      isRendering.value = false
    })
  }

  const hexToRGBA = (hex: string, alpha: number) => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
  
    return [r, g, b, alpha];
  }

  // Cache for brightness adjustments to avoid expensive parse/format on every hover re-render
  const __brightnessCache = new Map<string, string>()

  // lighten or darken a hex color by a percentage (positive -> lighter, negative -> darker)
  const adjustHexBrightness = (hex: string, percent: number) => {
    const key = `${hex}_${percent}`
    const cached = __brightnessCache.get(key)
    if (cached) return cached

    const clamp = (val: number) => Math.max(0, Math.min(255, val))
    const r = parseInt(hex.slice(1, 3), 16)
    const g = parseInt(hex.slice(3, 5), 16)
    const b = parseInt(hex.slice(5, 7), 16)

    const factor = (100 + percent) / 100
    const newR = clamp(Math.round(r * factor))
    const newG = clamp(Math.round(g * factor))
    const newB = clamp(Math.round(b * factor))

    const toHex = (v: number) => v.toString(16).padStart(2, '0')
    const result = `#${toHex(newR)}${toHex(newG)}${toHex(newB)}`
    __brightnessCache.set(key, result)
    return result
  }

  // helper: converts "#rrggbb" + alpha (0-1) -> "rgba(r,g,b,alpha)"
  const hexToRGBAString = (hex: string, alpha: number) => {
    const [r, g, b] = hexToRGBA(hex, alpha)
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }

  const addRenderTask = (task: () => void) => {
    renderQueue.value.push(task)
    processRenderQueue()
  }

  const updateSurfaceTexture = (force = false) => {
    if (!surfaceTexture.value) return

    if (isRendering.value && !force) return
    surfaceTexture.value.needsUpdate = true

    if (force) {
    
      setTimeout(() => {
        if (surfaceTexture.value) surfaceTexture.value.needsUpdate = true
      }, 16)
    }
  }

  watch(options.heightScaleRef, (newHeightScale) => {
    _heightScale.value = newHeightScale
  },{
    immediate:true
  })

  return {
    // exposed state
    surfaceCanvas,
    surfaceContext,
    surfaceTexture,
    surfaceCanvasSize,
    labelsVisible,
    // exposed helpers
    getScalingFactors,
    setupCanvasContext,
    createSurfaceCanvas,
    addRenderTask,
    updateSurfaceTexture,
    setLabelVisibility,
    adjustHexBrightness,
    renderQueue,
    isRendering
  }
}
