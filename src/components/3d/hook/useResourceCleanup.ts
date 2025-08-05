import { ref } from 'vue'
import { WebGLRenderer, Material, BufferGeometry, Mesh, DataTexture } from 'three'

export function useResourceCleanup() {
  const isCleaningUp = ref<boolean>(false)
  const lastRendererContext = ref<WebGLRenderingContext | null>(null)

  // 完整的资源清理函数
  const cleanupAllResources = (params: {
    geometry: { value: BufferGeometry | null },
    meshRef: { value: Mesh | null },
    displacementMap: { value: DataTexture | null },
    roughnessMap: { value: DataTexture | null },
    normalMap: { value: DataTexture | null },
    bumpMap: { value: DataTexture | null },
    cachedMeshData: { value: { width: number; height: number; heightMap: Float32Array; mean: Int8Array; normal: Int8Array; level: number; } | null },
    mesh: { value: boolean },
    loading: { value: boolean },
    terminateWorker: () => void,
    cleanupRenderTargets: () => void
  }) => {
    if (isCleaningUp.value) return
    isCleaningUp.value = true

    console.log('🧹 开始清理所有3D资源...')

    try {

      if (params.geometry.value) {
        console.log('清理几何体资源')

        params.geometry.value.dispose()
        params.geometry.value = null
      }

      const textures = [params.displacementMap, params.roughnessMap, params.normalMap, params.bumpMap]
      textures.forEach((textureRef, index) => {
        if (textureRef.value) {
          textureRef.value.dispose()
          textureRef.value = null
          console.log(`清理纹理 ${index + 1}`)
        }
      })

      if (params.meshRef.value) {
        params.meshRef.value.geometry?.dispose()
        const material = params.meshRef.value.material
        if (material) {
          (material as unknown as Material).dispose?.()
        }
        params.meshRef.value = null
      }

      
      if (params.displacementMap.value) {
        params.displacementMap.value.dispose()
      }
      if (params.roughnessMap.value) {
        params.roughnessMap.value.dispose()
      }
      if (params.normalMap.value) {
        params.normalMap.value.dispose()
      }
      if (params.bumpMap.value) {
        params.bumpMap.value.dispose()
      }
      
      params.terminateWorker()

      params.cleanupRenderTargets()

      params.cachedMeshData.value = null

      params.mesh.value = false
      params.loading.value = false

      console.log('✅all resources cleaned up')

    } catch (error) {
      console.error('❌ error during resource cleanup:', error)
    } finally {
      isCleaningUp.value = false
    }
  }


  const cleanupAndReinitRenderer = (renderer: WebGLRenderer | null) => {
    if (renderer) {

      const currentContext = renderer.getContext()

      renderer.dispose()


      lastRendererContext.value = currentContext
    }
  }


  return {
    isCleaningUp,
    lastRendererContext,
    cleanupAllResources,
    cleanupAndReinitRenderer,
  }
} 