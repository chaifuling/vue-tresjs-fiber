// useMeshWorker.ts - Web Worker管理Hook
import { onUnmounted } from 'vue'
import { ref } from 'vue'
import type { ProcessMeshDataParams, CreateTexturesParams, UpdateColorsParams } from '../workers/meshWorker'

interface WorkerProgress {
  progress: number
  stage: 'vertices' | 'textures' | 'colors'
}

interface MeshWorkerResult {
  positions: Float32Array
  colors: Float32Array
  uvs: Float32Array
  indices: Uint32Array
  normals: Float32Array
  bvh: ArrayBuffer
}

interface TextureWorkerResult {
  displacementData: Float32Array
  roughnessData: Float32Array
  normalData: Float32Array
}

interface ColorsWorkerResult {
  colors: Float32Array
}

export const useMeshWorker = () => {
  const worker = ref<Worker | null>(null)
  const isWorkerReady = ref(false)
  const isProcessing = ref(false)
  const currentProgress = ref<WorkerProgress>({ progress: 0, stage: 'vertices' })

  // Auto-incrementing requestId to discard stale results
  let globalReqId = 0
  const latestReqId = ref(0)
  
  // Initialize worker
  const initWorker = () => {
    try {
      // Create worker
      worker.value = new Worker(
        new URL('../workers/meshWorker.ts', import.meta.url),
        { type: 'module' }
      )
      
      // Message handler
      worker.value.onmessage = (event) => {
        const { type, data, progress, stage, error, reqId } = event.data as {
          type: string;
          data?: unknown;
          progress?: number;
          stage?: 'vertices' | 'textures' | 'colors';
          error?: string;
          reqId?: number;
        };

        // Ignore outdated results
        if (reqId !== latestReqId.value) {
          return
        }
        
        switch (type) {
          case 'PROGRESS':
            currentProgress.value = { progress, stage }
            break
            
          case 'MESH_DATA_COMPLETE':
            isProcessing.value = false
            if (meshDataResolve) {
              meshDataResolve(data as MeshWorkerResult)
              meshDataResolve = null
            }
            break
            
          case 'TEXTURES_COMPLETE':
            isProcessing.value = false
            if (textureDataResolve) {
              textureDataResolve(data as TextureWorkerResult)
              textureDataResolve = null
            }
            break
            
          case 'COLORS_COMPLETE':
            isProcessing.value = false
            if (colorsDataResolve) {
              colorsDataResolve(data as ColorsWorkerResult)
              colorsDataResolve = null
            }
            break
            
          case 'ERROR':
            isProcessing.value = false
            console.error('Worker错误:', error)
            if (meshDataReject) {
              meshDataReject(new Error(error))
              meshDataReject = null
            }
            if (textureDataReject) {
              textureDataReject(new Error(error))
              textureDataReject = null
            }
            if (colorsDataReject) {
              colorsDataReject(new Error(error))
              colorsDataReject = null
            }
            break
        }
      }
      
      worker.value.onerror = (error) => {
        console.error('Worker加载错误:', error)
        isWorkerReady.value = false
        isProcessing.value = false
      }
      
      isWorkerReady.value = true
      console.log('Web Worker初始化成功')
      
    } catch (error) {
      console.error('Worker初始化失败:', error)
      isWorkerReady.value = false
    }
  }
  
  // Promise handlers
  let meshDataResolve: ((value: MeshWorkerResult) => void) | null = null
  let meshDataReject: ((reason: Error) => void) | null = null
  let textureDataResolve: ((value: TextureWorkerResult) => void) | null = null
  let textureDataReject: ((reason: Error) => void) | null = null
  let colorsDataResolve: ((value: ColorsWorkerResult) => void) | null = null
  let colorsDataReject: ((reason: Error) => void) | null = null
  
  // Helper functions
  const ensureWorkerReady = () => {
    // Restart worker if busy (drops previous tasks)
    if (isProcessing.value) {
      terminateWorker()
      initWorker()
    }
    if (!isWorkerReady.value) {
      initWorker()
    }
  }

  // Process mesh data
  const processMeshData = (params: ProcessMeshDataParams): Promise<MeshWorkerResult> => {
    return new Promise((resolve, reject) => {
      ensureWorkerReady()

      if (!worker.value) {
        reject(new Error('Worker初始化失败'))
        return
      }

      isProcessing.value = true
      const reqId = ++globalReqId
      latestReqId.value = reqId
      currentProgress.value = { progress: 0, stage: 'vertices' }
      meshDataResolve = resolve
      meshDataReject = reject
      
      // Post message to worker
      worker.value.postMessage({
        type: 'PROCESS_MESH_DATA',
        data: params,
        reqId
      })
    })
  }
  
  // Process texture data
  const processTextureData = (params: CreateTexturesParams): Promise<TextureWorkerResult> => {
    return new Promise((resolve, reject) => {
      ensureWorkerReady()

      if (!worker.value) {
        reject(new Error('Worker初始化失败'))
        return
      }

      isProcessing.value = true
      const reqId = ++globalReqId
      latestReqId.value = reqId
      currentProgress.value = { progress: 0, stage: 'textures' }
      textureDataResolve = resolve
      textureDataReject = reject
      
      // Post message to worker
      worker.value.postMessage({
        type: 'CREATE_TEXTURES',
        data: params,
        reqId
      })
    })
  }
  
  // Quick color update
  const updateColors = (params: UpdateColorsParams): Promise<ColorsWorkerResult> => {
    return new Promise((resolve, reject) => {
      ensureWorkerReady()

      if (!worker.value) {
        reject(new Error('Worker初始化失败'))
        return
      }

      isProcessing.value = true
      const reqId = ++globalReqId
      latestReqId.value = reqId
      currentProgress.value = { progress: 0, stage: 'colors' }
      colorsDataResolve = resolve
      colorsDataReject = reject
      
      // Post message to worker
      worker.value.postMessage({
        type: 'UPDATE_COLORS',
        data: params,
        reqId
      })
    })
  }
  
  // Terminate worker
  const terminateWorker = () => {
    if (worker.value) {
      worker.value.terminate()
      worker.value = null
      isWorkerReady.value = false
      isProcessing.value = false
      
      // Reject pending promises
      if (meshDataReject) {
        meshDataReject(new Error('Worker已终止'))
        meshDataReject = null
        meshDataResolve = null
      }
      if (textureDataReject) {
        textureDataReject(new Error('Worker已终止'))
        textureDataReject = null
        textureDataResolve = null
      }
      if (colorsDataReject) {
        colorsDataReject(new Error('Worker已终止'))
        colorsDataReject = null
        colorsDataResolve = null
      }
      
      console.log('Web Worker已终止')
    }
  }
  
  // Reset worker
  const resetWorker = () => {
    terminateWorker()
    initWorker()
  }
  
  // Format progress text
  const getProgressText = () => {
    const { progress, stage } = currentProgress.value
    const stageText = stage === 'vertices' ? '顶点处理' : stage === 'textures' ? '纹理创建' : '颜色更新'
    return `${stageText}: ${progress}%`
  }
  
  // Cleanup on component unmount
  onUnmounted(() => {
    terminateWorker()
  })
  
  return {
    // State refs
    isWorkerReady,
    isProcessing,
    currentProgress,
    latestReqId,
    
    // API
    initWorker,
    terminateWorker,
    resetWorker,
    processMeshData,
    processTextureData,
    updateColors,
    getProgressText,
  }
} 