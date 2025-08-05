import { ref, reactive, onUnmounted } from 'vue'
import {
  WebGLRenderer,
  WebGLRenderTarget,
  RGBAFormat,
  UnsignedByteType,
  LinearFilter,
  NearestFilter,
  DepthFormat,
  UnsignedShortType,
  HalfFloatType,
  Scene,
  PerspectiveCamera,
} from 'three'

interface RenderTargetConfig {
  width: number
  height: number
  pixelRatio: number
}

interface PerformanceStats {
  frameTime: number
  renderTime: number
  shadowTime: number
  lodLevel: number
  fps: number
  averageFrameTime: number
}

interface LODSettings {
  maxLOD: number
  currentLOD: number
  autoLOD: boolean
  distanceThresholds: number[]
}

interface DynamicResolution {
  enabled: boolean
  minScale: number
  maxScale: number
  currentScale: number
  targetFPS: number
  adaptationSpeed: number
}

export const useRenderTargets = () => {
  const renderTargets = ref<Map<string, WebGLRenderTarget>>(new Map())
  const shadowRenderTarget = ref<WebGLRenderTarget | null>(null)
  const depthRenderTarget = ref<WebGLRenderTarget | null>(null)
  const normalRenderTarget = ref<WebGLRenderTarget | null>(null)

  const performanceStats = reactive<PerformanceStats>({
    frameTime: 0,
    renderTime: 0,
    shadowTime: 0,
    lodLevel: 0,
    fps: 0,
    averageFrameTime: 0
  })


  const lodSettings = reactive<LODSettings>({
    maxLOD: 4,
    currentLOD: 0,
    autoLOD: true,
    distanceThresholds: [500, 1000, 2000, 4000]
  })

  const dynamicResolution = reactive<DynamicResolution>({
    enabled: true,
    minScale: 0.5,
    maxScale: 2.0,
    currentScale: 1.0,
    targetFPS: 60,
    adaptationSpeed: 0.1
  })


  let frameCount = 0
  let totalFrameTime = 0
  let lastFrameTime = performance.now()
  let monitoringActive = false


  const initRenderTargets = (config: RenderTargetConfig) => {
    const { width, height, pixelRatio } = config
    console.log('初始化离屏渲染目标...', { width, height, pixelRatio })

    cleanupRenderTargets()

    const mainRenderTarget = new WebGLRenderTarget(
      width * pixelRatio,
      height * pixelRatio,
      {
        format: RGBAFormat,
        type: UnsignedByteType,
        minFilter: LinearFilter,
        magFilter: LinearFilter,
        generateMipmaps: false,
        samples: 4, 
      }
    )
    renderTargets.value.set('main', mainRenderTarget)


    const shadowSize = Math.min(1024, Math.max(512, width / 2))
    shadowRenderTarget.value = new WebGLRenderTarget(shadowSize, shadowSize, {
      format: RGBAFormat,
      type: UnsignedByteType,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      generateMipmaps: false,
    })


    depthRenderTarget.value = new WebGLRenderTarget(
      width * pixelRatio * 0.5,
      height * pixelRatio * 0.5,
      {
        format: DepthFormat,
        type: UnsignedShortType,
        minFilter: NearestFilter,
        magFilter: NearestFilter,
        generateMipmaps: false,
      }
    )


    normalRenderTarget.value = new WebGLRenderTarget(
      width * pixelRatio * 0.75,
      height * pixelRatio * 0.75,
      {
        format: RGBAFormat,
        type: HalfFloatType,
        minFilter: LinearFilter,
        magFilter: LinearFilter,
        generateMipmaps: false,
      }
    )


    for (let i = 1; i <= lodSettings.maxLOD; i++) {
      const scale = Math.pow(0.5, i)
      const lodTarget = new WebGLRenderTarget(
        Math.max(256, width * scale),
        Math.max(256, height * scale),
        {
          format: RGBAFormat,
          type: UnsignedByteType,
          minFilter: LinearFilter,
          magFilter: LinearFilter,
          generateMipmaps: false,
        }
      )
      renderTargets.value.set(`lod_${i}`, lodTarget)
    }

    console.log('离屏渲染目标初始化完成，创建了', renderTargets.value.size, '个目标')
  }


  const updateDynamicResolution = (deltaTime: number) => {
    if (!dynamicResolution.enabled) return false

    const currentFPS = 1000 / deltaTime
    const targetFPS = dynamicResolution.targetFPS
    const fpsRatio = currentFPS / targetFPS

    let scaleChanged = false

    if (fpsRatio < 0.8) {
      const newScale = Math.max(
        dynamicResolution.minScale,
        dynamicResolution.currentScale - dynamicResolution.adaptationSpeed
      )
      if (newScale !== dynamicResolution.currentScale) {
        dynamicResolution.currentScale = newScale
        scaleChanged = true
      }
    } else if (fpsRatio > 1.2) {
      const newScale = Math.min(
        dynamicResolution.maxScale,
        dynamicResolution.currentScale + dynamicResolution.adaptationSpeed * 0.5
      )
      if (newScale !== dynamicResolution.currentScale) {
        dynamicResolution.currentScale = newScale
        scaleChanged = true
      }
    }

    performanceStats.fps = Math.round(currentFPS)
    performanceStats.frameTime = deltaTime

    return scaleChanged
  }


  const updateLODLevel = (cameraDistance: number) => {
    if (!lodSettings.autoLOD) return false

    let newLOD = 0
    for (let i = 0; i < lodSettings.distanceThresholds.length; i++) {
      if (cameraDistance > lodSettings.distanceThresholds[i]) {
        newLOD = i + 1
      }
    }

    newLOD = Math.min(newLOD, lodSettings.maxLOD)
    
    if (newLOD !== lodSettings.currentLOD) {
      lodSettings.currentLOD = newLOD
      performanceStats.lodLevel = newLOD
      console.log(`LOD级别更新到: ${newLOD}, 距离: ${cameraDistance.toFixed(0)}`)
      return true
    }

    return false
  }


  const renderWithOptimization = (
    renderer: WebGLRenderer,
    scene: Scene,
    camera: PerspectiveCamera,
  ) => {
    const startTime = performance.now()
    
    const currentTime = performance.now()
    const deltaTime = currentTime - lastFrameTime
    lastFrameTime = currentTime

    const resolutionChanged = updateDynamicResolution(deltaTime)

    if (resolutionChanged) {
      updateRenderTargetSizes(renderer)
    }

    const currentLOD = lodSettings.currentLOD
    const targetKey = currentLOD > 0 ? `lod_${currentLOD}` : 'main'
    const renderTarget = renderTargets.value.get(targetKey)

    if (!renderTarget) {
      renderer.setRenderTarget(null)
      renderer.render(scene, camera)
      performanceStats.renderTime = performance.now() - startTime
      return
    }

    renderer.setRenderTarget(renderTarget)
    renderer.clear()
    
    const originalPixelRatio = renderer.getPixelRatio()
    if (currentLOD > 0) {
      const lodPixelRatio = originalPixelRatio * (1 / Math.pow(2, currentLOD - 1))
      renderer.setPixelRatio(lodPixelRatio)
    }

    renderer.render(scene, camera)

    const shadowStartTime = performance.now()
    if (shadowRenderTarget.value && currentLOD <= 2) {
      renderer.setRenderTarget(shadowRenderTarget.value)
      renderer.clear()
      renderer.render(scene, camera)
    }
    performanceStats.shadowTime = performance.now() - shadowStartTime

    renderer.setRenderTarget(null)
    renderer.setPixelRatio(originalPixelRatio)
    
    copyRenderTargetToCanvas(renderer, renderTarget)

    performanceStats.renderTime = performance.now() - startTime
    
    updatePerformanceStats()
  }


  const copyRenderTargetToCanvas = (renderer: WebGLRenderer, sourceTarget: WebGLRenderTarget) => {

    const canvas = renderer.domElement
    
    console.log('复制渲染目标到画布', { 
      targetSize: `${sourceTarget.width}x${sourceTarget.height}`,
      canvasSize: `${canvas.width}x${canvas.height}`
    })
  }


  const updateRenderTargetSizes = (renderer: WebGLRenderer) => {
    const canvas = renderer.domElement
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    const pixelRatio = renderer.getPixelRatio()
    const scale = dynamicResolution.currentScale

    console.log('更新渲染目标大小', { width, height, pixelRatio, scale })

    renderTargets.value.forEach((target, key) => {
      if (key === 'main') {
        target.setSize(width * pixelRatio * scale, height * pixelRatio * scale)
      } else if (key.startsWith('lod_')) {
        const lodLevel = parseInt(key.split('_')[1])
        const lodScale = Math.pow(0.5, lodLevel) * scale
        target.setSize(
          Math.max(256, width * lodScale),
          Math.max(256, height * lodScale)
        )
      }
    })

    if (shadowRenderTarget.value) {
      const shadowSize = Math.min(1024, Math.max(512, width / 2)) * scale
      shadowRenderTarget.value.setSize(shadowSize, shadowSize)
    }

    if (depthRenderTarget.value) {
      depthRenderTarget.value.setSize(
        width * pixelRatio * 0.5 * scale,
        height * pixelRatio * 0.5 * scale
      )
    }

    if (normalRenderTarget.value) {
      normalRenderTarget.value.setSize(
        width * pixelRatio * 0.75 * scale,
        height * pixelRatio * 0.75 * scale
      )
    }
  }


  const startPerformanceMonitoring = () => {
    if (monitoringActive) return
    
    monitoringActive = true
    frameCount = 0
    totalFrameTime = 0
    
    const monitor = () => {
      if (!monitoringActive) return
      
      frameCount++
      totalFrameTime += performanceStats.renderTime
      
      if (frameCount >= 60) { 
        const avgFrameTime = totalFrameTime / frameCount
        const fps = 1000 / avgFrameTime
        
        performanceStats.averageFrameTime = avgFrameTime
        
        console.log(`性能统计 - FPS: ${fps.toFixed(1)}, 平均帧时间: ${avgFrameTime.toFixed(2)}ms, LOD: ${performanceStats.lodLevel}, 分辨率缩放: ${dynamicResolution.currentScale.toFixed(2)}`)
        
        frameCount = 0
        totalFrameTime = 0
      }
      
      requestAnimationFrame(monitor)
    }
    
    monitor()
  }


  const stopPerformanceMonitoring = () => {
    monitoringActive = false
  }


  const updatePerformanceStats = () => {
    frameCount++
    totalFrameTime += performanceStats.renderTime
  }


  const cleanupRenderTargets = () => {
    renderTargets.value.forEach(target => target.dispose())
    renderTargets.value.clear()
    
    if (shadowRenderTarget.value) {
      shadowRenderTarget.value.dispose()
      shadowRenderTarget.value = null
    }
    
    if (depthRenderTarget.value) {
      depthRenderTarget.value.dispose()
      depthRenderTarget.value = null
    }
    
    if (normalRenderTarget.value) {
      normalRenderTarget.value.dispose()
      normalRenderTarget.value = null
    }

    stopPerformanceMonitoring()
  }

  onUnmounted(() => {
    cleanupRenderTargets()
  })

  return {
    renderTargets,
    shadowRenderTarget,
    depthRenderTarget,
    normalRenderTarget,
    performanceStats,
    lodSettings,
    dynamicResolution,

    // 方法
    initRenderTargets,
    renderWithOptimization,
    updateRenderTargetSizes,
    updateDynamicResolution,
    updateLODLevel,
    startPerformanceMonitoring,
    stopPerformanceMonitoring,
    cleanupRenderTargets,
  }
}

export type { RenderTargetConfig, PerformanceStats, LODSettings, DynamicResolution } 