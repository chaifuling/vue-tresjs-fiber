// Web Worker for 3D mesh data processing
import { TwoFiveDImageType } from "@/api/train/train.api.ts";
import { BufferGeometry, BufferAttribute } from 'three';
import { MeshBVH, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';

// Patch three prototypes inside worker
(BufferGeometry.prototype as unknown as { computeBoundsTree: typeof computeBoundsTree }).computeBoundsTree = computeBoundsTree;
(BufferGeometry.prototype as unknown as { disposeBoundsTree: typeof disposeBoundsTree }).disposeBoundsTree = disposeBoundsTree;

// Worker message type (with reqId)
interface WorkerMessage {
  reqId: number
  type: 'PROCESS_MESH_DATA' | 'CREATE_TEXTURES' | 'UPDATE_COLORS';
  data: ProcessMeshDataParams | CreateTexturesParams | UpdateColorsParams;
}

interface ProcessMeshDataParams {
  width: number;
  height: number;
  heightMap: Float32Array;
  mean: Int8Array;
  normal: Int8Array;
  heightScale: number;
  level: number;
  imageMode: TwoFiveDImageType;
  baseGridSize: number | null;
}

interface CreateTexturesParams {
  vertexColors: Float32Array;
  heightMap: Float32Array;
  width: number;
  height: number;
}

interface UpdateColorsParams {
  width: number;
  height: number;
  mean: Int8Array;
  normal: Int8Array;
  imageMode: TwoFiveDImageType;
}

// Batch vertex processing
const processVerticesInBatches = async (
  params: ProcessMeshDataParams,
  onProgress?: (progress: number) => void
): Promise<{
  positions: Float32Array;
  colors: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  normals: Float32Array;
}> => {
  const { width, height, heightMap, mean, normal, heightScale, level, imageMode } = params;
  const count = width * height;
  
  // Pre-allocate buffers
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const normals = new Float32Array(count * 3);
  const indices = new Uint32Array((width - 1) * (height - 1) * 6);

  // Choose color mode
  let mode: Int8Array;
  if (imageMode === TwoFiveDImageType.MEAN) {
    mode = mean;
  } else if (imageMode === TwoFiveDImageType.NORMAL) {
    mode = normal;
  } else {
    mode = mean; // default to mean
  }

  console.log('Worker: 开始处理顶点数据，总顶点数:', count);

  // Process vertices in chunks
  const batchSize = Math.min(5000, Math.ceil(count / 20));
  let processedVertices = 0;

  while (processedVertices < count) {
    const startTime = performance.now();
    const endIndex = Math.min(processedVertices + batchSize, count);

    // Batch process vertices
    for (let i = processedVertices; i < endIndex; i++) {
      const row = Math.floor(i / width);
      const col = i % width;
      const dataIndex = row * width + col;

      // Set position (x, y, z) relative to mesh center
    
      positions[i * 3] = col - width / 2;
      positions[i * 3 + 1] = heightMap[dataIndex] * heightScale * (0.4 / level);
      positions[i * 3 + 2] = row - height / 2;
      
      // Set UVs
      uvs[i * 2] = col / (width - 1);
      uvs[i * 2 + 1] = row / (height - 1);
      
      // Set vertex color
      if (imageMode === TwoFiveDImageType.HEIGHT) {
        colors[i * 3] = 0.8;
        colors[i * 3 + 1] = 0.8;
        colors[i * 3 + 2] = 0.8;
      } else {
        const rSrgb = (mode[dataIndex * 3] & 0xFF) / 255;
        const gSrgb = (mode[dataIndex * 3 + 1] & 0xFF) / 255;
        const bSrgb = (mode[dataIndex * 3 + 2] & 0xFF) / 255;

        const sRGBtoLinear = (c: number) => (c <= 0.04045) ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 1.7);

        colors[i * 3] = sRGBtoLinear(rSrgb);
        colors[i * 3 + 1] = sRGBtoLinear(gSrgb);
        colors[i * 3 + 2] = sRGBtoLinear(bSrgb);
      }

      // Compute vertex normal
      const hScaleFactor = heightScale * (0.4 / level);
      const idxLeft = col > 0 ? dataIndex - 1 : dataIndex;
      const idxRight = col < width - 1 ? dataIndex + 1 : dataIndex;
      const idxDown = row > 0 ? dataIndex - width : dataIndex;
      const idxUp = row < height - 1 ? dataIndex + width : dataIndex;

      const hL = heightMap[idxLeft] * hScaleFactor;
      const hR = heightMap[idxRight] * hScaleFactor;
      const hD = heightMap[idxDown] * hScaleFactor;
      const hU = heightMap[idxUp] * hScaleFactor;

      const dx = (hR - hL);
      const dy = (hU - hD);
      const nx = -dx;
      const ny = -dy;
      const nz = 2.0;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      normals[i * 3] = nx / len;
      normals[i * 3 + 1] = ny / len;
      normals[i * 3 + 2] = nz / len;
    }

    processedVertices = endIndex;

    // Report progress
    const progress = Math.round((processedVertices / count) * 50); // Vertex processing accounts for 50%
    if (onProgress) {
      onProgress(progress);
    }

    // Yield control to main thread
    const elapsed = performance.now() - startTime;
    if (elapsed > 16) { // If processing takes >16ms, yield control
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  console.log('Worker: 顶点处理完成，开始创建索引');

  // Build index buffer
  let indexPtr = 0;
  const indexBatchSize = Math.min(1000, Math.ceil((height - 1) / 10));
  let processedRows = 0;

  while (processedRows < height - 1) {
    const startTime = performance.now();
    const endRow = Math.min(processedRows + indexBatchSize, height - 1);

    for (let row = processedRows; row < endRow; row++) {
      for (let col = 0; col < width - 1; col++) {
        const topLeft = row * width + col;
        const topRight = topLeft + 1;
        const bottomLeft = (row + 1) * width + col;
        const bottomRight = bottomLeft + 1;
        
        // First triangle (CCW order)
        indices[indexPtr++] = topLeft;
        indices[indexPtr++] = topRight;
        indices[indexPtr++] = bottomLeft;
        
        // Second triangle (CCW order)
        indices[indexPtr++] = topRight;
        indices[indexPtr++] = bottomRight;
        indices[indexPtr++] = bottomLeft;
      }
    }

    processedRows = endRow;

    // Report progress
    const progress = 50 + Math.round((processedRows / (height - 1)) * 25); // Index processing accounts for 25%
    if (onProgress) {
      onProgress(progress);
    }

    // Yield control
    const elapsed = performance.now() - startTime;
    if (elapsed > 16) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  console.log('Worker: 数据处理完成');
  return { positions, colors, uvs, indices, normals };
};

// Generate texture data
const createTextureData = async (
  params: CreateTexturesParams,
  onProgress?: (progress: number) => void
): Promise<{
  displacementData: Float32Array;
  roughnessData: Float32Array;
  normalData: Float32Array;
}> => {
  const { heightMap, width, height } = params;
  
  console.log('Worker: 开始创建纹理数据...');
  const startTime = performance.now();

  // Create inverted height map for displacement
  const displacementData = new Float32Array(heightMap.length);
  for (let i = 0; i < heightMap.length; i++) {
    displacementData[i] = -heightMap[i];
  }

  if (onProgress) onProgress(80);

  // Generate roughness map
  const roughnessData = new Float32Array(width * height);
  const batchSize = Math.min(2000, Math.ceil((width * height) / 20));
  let processed = 0;

  while (processed < width * height) {
    const startTime = performance.now();
    const endIndex = Math.min(processed + batchSize, width * height);

    for (let i = processed; i < endIndex; i++) {
      const height = heightMap[i];
      const normalizedHeight = Math.max(0, Math.min(1, height / 800));
      
      const row = Math.floor(i / width);
      const col = i % width;
      
      // Simple noise pattern
      const noiseX = (col * 0.1) % 1;
      const noiseY = (row * 0.1) % 1;
      const noisePattern = Math.sin(noiseX * Math.PI * 8) * Math.cos(noiseY * Math.PI * 6) * 0.1;
      
      roughnessData[i] = 0.3 + normalizedHeight * 0.4 + Math.abs(noisePattern);
    }

    processed = endIndex;

    // Yield control
    const elapsed = performance.now() - startTime;
    if (elapsed > 16) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  if (onProgress) onProgress(90);

  // Generate normal map
  const normalData = new Float32Array(width * height * 3);
  processed = 0;

  while (processed < height) {
    const startTime = performance.now();
    const endRow = Math.min(processed + Math.ceil(height / 20), height);

    for (let y = processed; y < endRow; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;

        // Gradient calculation
        const heightL = x > 0 ? heightMap[y * width + (x - 1)] : heightMap[i];
        const heightR = x < width - 1 ? heightMap[y * width + (x + 1)] : heightMap[i];
        const heightD = y > 0 ? heightMap[(y - 1) * width + x] : heightMap[i];
        const heightU = y < height - 1 ? heightMap[(y + 1) * width + x] : heightMap[i];

        const scale = 2.0;
        const dx = (heightR - heightL) * scale;
        const dy = (heightU - heightD) * scale;

        // Compute normal vector
        const length = Math.sqrt(dx * dx + dy * dy + 1);
        normalData[i * 3] = (dx / length + 1) * 0.5;
        normalData[i * 3 + 1] = (dy / length + 1) * 0.5;
        normalData[i * 3 + 2] = (1 / length + 1) * 0.5;
      }
    }

    processed = endRow;

    // Yield control
    const elapsed = performance.now() - startTime;
    if (elapsed > 16) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  const endTime = performance.now();
  console.log(`Worker: 纹理数据创建完成，耗时: ${(endTime - startTime).toFixed(2)}ms`);
  
  if (onProgress) onProgress(100);

  return { displacementData, roughnessData, normalData };
};

// Fast color update
const updateColorsOnly = async (
  params: UpdateColorsParams,
  onProgress?: (progress: number) => void
): Promise<{ colors: Float32Array }> => {
  const { width, height, mean, normal, imageMode } = params;
  const count = width * height;
  
  console.log('Worker: 开始快速颜色更新...');
  const startTime = performance.now();
  
  const colors = new Float32Array(count * 3);
  const modeData = imageMode === TwoFiveDImageType.MEAN ? mean : normal;
  
  // Process colors in batches
  const batchSize = Math.min(5000, Math.ceil(count / 10));
  let processed = 0;
  
  while (processed < count) {
    const startTime = performance.now();
    const endIndex = Math.min(processed + batchSize, count);
    
    for (let i = processed; i < endIndex; i++) {
      const dataIndex = i;
      
      // Set color
      if (imageMode === TwoFiveDImageType.HEIGHT) {
        colors[i * 3] = 0.8;
        colors[i * 3 + 1] = 0.8;
        colors[i * 3 + 2] = 0.8;
      } else {
        const rSrgb = (modeData[dataIndex * 3] & 0xFF) / 255;
        const gSrgb = (modeData[dataIndex * 3 + 1] & 0xFF) / 255;
        const bSrgb = (modeData[dataIndex * 3 + 2] & 0xFF) / 255;

        const sRGBtoLinear = (c: number) => (c <= 0.04045) ? 
        c / 12.92 : Math.pow((c + 0.055) / 1.055, 1.7);

        colors[i * 3] = sRGBtoLinear(rSrgb);
        colors[i * 3 + 1] = sRGBtoLinear(gSrgb);
        colors[i * 3 + 2] = sRGBtoLinear(bSrgb);
      }
    }
    
    processed = endIndex;
    
    // Report progress
    const progress = Math.round((processed / count) * 100);
    if (onProgress) {
      onProgress(progress);
    }
    
    // Yield to main thread
    const elapsed = performance.now() - startTime;
    if (elapsed > 8) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  
  const endTime = performance.now();
  console.log(`Worker: 快速颜色更新完成，耗时: ${(endTime - startTime).toFixed(2)}ms`);
  
  return { colors };
};

// Listen for messages from main thread
self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  const { type, data, reqId } = event.data;

  // Helper to post back with reqId
  const send = (msg: Record<string, unknown>) => {
    (self as unknown as Worker).postMessage({ ...msg, reqId });
  };

  try {
    switch (type) {
      case 'PROCESS_MESH_DATA':
        const meshResult = await processVerticesInBatches(
          data as ProcessMeshDataParams,
          (progress) => {
            send({ type: 'PROGRESS', progress, stage: 'vertices' });
          }
        );

        // Build BVH inside worker to keep main thread responsive
        try {
          const geo = new BufferGeometry();
          geo.setAttribute('position', new BufferAttribute(meshResult.positions, 3));
          geo.setIndex(new BufferAttribute(meshResult.indices, 1));

          // Apply transforms (rotateX and uniform scale) to match main thread but prevent extra mutation later
          const { width: gridW, baseGridSize: baseGS } = data as ProcessMeshDataParams;
          let uScale = 1;
          if (baseGS !== null) {
            uScale = baseGS / gridW;
          }
          if (uScale !== 1) geo.scale(uScale, uScale, uScale);
          geo.rotateX(Math.PI / 2);

          geo.computeBoundsTree();
          // Serialize BVH for transfer
          const serialized = MeshBVH.serialize(geo.boundsTree);
          (meshResult as unknown as { bvh: unknown }).bvh = serialized;
        } catch (bvhErr) {
          console.error('Worker: BVH build failed', bvhErr);
          (meshResult as unknown as { bvh: unknown }).bvh = null;
        }

        send({ type: 'MESH_DATA_COMPLETE', data: meshResult });
        break;

      case 'CREATE_TEXTURES':
        const textureResult = await createTextureData(
          data as CreateTexturesParams,
          (progress) => {
            send({ type: 'PROGRESS', progress, stage: 'textures' });
          }
        );
        send({ type: 'TEXTURES_COMPLETE', data: textureResult });
        break;

      case 'UPDATE_COLORS':
        const colorsResult = await updateColorsOnly(
          data as UpdateColorsParams,
          (progress) => {
            send({ type: 'PROGRESS', progress, stage: 'colors' });
          }
        );
        send({ type: 'COLORS_COMPLETE', data: colorsResult });
        break;

      default:
        console.warn('Worker: 未知的消息类型:', type);
    }
  } catch (error) {
    send({ type: 'ERROR', error: error instanceof Error ? error.message : String(error) });
  }
};

// Export type definitions
export type {
  WorkerMessage,
  ProcessMeshDataParams,
  CreateTexturesParams,
  UpdateColorsParams
}; 