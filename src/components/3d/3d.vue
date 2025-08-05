<template>
  <div ref="threeCanvasRef" style="width: 100%; height: 100%; overflow: hidden; position: relative">
    <TresCanvas
      shadows
      :use-device-pixel-ratio="true"
      :disable-render="false"
      :antialias="true"
      :alpha="false"
      :power-preference="'high-performance'"
      :depth="true"
      :stencil="false"
      :preserve-drawing-buffer="false"
      :fail-if-major-performance-caveat="false"
      clear-color="#555555"
      @ready="onReady"
    >
      <TresPerspectiveCamera ref="cameraRef" :position="[0, 0, 1000]" :look-at="[0, 0, 0]" :near="cameraNear" :far="cameraFar" :fov="50" :aspect="1" />
      <OrbitControls
        ref="controlsRef"
        :enable-zoom="true"
        :enable-rotate="enableCameraControls"
        :enable-pan="enableCameraControls"
        :auto-rotate="false"
        :enable-damping="true"
        :damping-factor="0.05"
        :rotate-speed="1.0"
      />

      <TresMesh
        ref="tresMeshRef"
        v-if="mesh"
        cast-shadow
        :geometry="geometry"
        @context-menu="(event) => onMenuClickMesh(event)"
        @click="(event) => onClickMesh(event)"
        @pointer-move="(event) => onPointerMoveMesh(event)"
      >
        <TresAmbientLight :intensity="ambientLightIntensity" color="#ffffff" />

        <TresHemisphereLight :intensity="hemisphereIntensity" color="#ffffff" ground-color="#444444" />

        <TresDirectionalLight
          ref="mainLightRef"
          :position="mainLightPosition"
          :intensity="mainLightIntensity"
          color="#ffffff"
          cast-shadow
          :shadow-camera-near="0.1"
          :shadow-camera-far="3000"
          :shadow-camera-left="-1500"
          :shadow-camera-right="1500"
          :shadow-camera-top="1500"
          :shadow-camera-bottom="-1500"
        />

        <TresSpotLight
          ref="sideLight1Ref"
          :position="sideLight1Position"
          :angle="Math.PI / 6"
          :penumbra="0.1"
          :decay="2"
          :distance="3000"
          :intensity="sideLightIntensity"
          color="#fff8e1"
        />

        <TresDirectionalLight ref="contourLightRef" :position="contourLightPosition" :intensity="contourLightIntensity" color="#e3f2fd" />

        <TresPointLight ref="topLightRef" :position="topLightPosition" :decay="2" :distance="1500" :intensity="topLightIntensity" color="#ffffff" />

        <TresMeshLambertMaterial
          :vertex-colors="true"
          :wireframe="false"
          :flat-shading="false"
          :side="DoubleSide"
          :dithering="true"
          :alpha-to-coverage="true"
          :transparent="true"
          :depth-write="true"
          :depth-test="true"
          :normal-scale="normalScale"
          :bump-scale="bumpScale"
          :normal-map="normalMap"
          :bump-map="bumpMap"
          :fog="true"
          :emissive-map="surfaceTexture"
          :emissive="surfaceTexture ? 0x888888 : 0x000000"
          :emissive-intensity="1"
        />
      </TresMesh>
    </TresCanvas>
    <a-slider
      v-model:value="sliderHeightScale"
      :default-value="1000"
      :min="1"
      :max="2400"
      :step="100"
      style="position: absolute; top: 6px; left: 10px; z-index: 999; width: 160px"
    />
  </div>
</template>

<script setup lang="ts">
import { defineProps, onMounted, onUnmounted, ref, watch, nextTick } from 'vue';
import { debounce } from 'lodash';
import { OrbitControls } from '@tresjs/cientos';
import {
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  FloatType,
  UnsignedByteType,
  Mesh,
  RedFormat,
  Scene,
  SRGBColorSpace,
  ACESFilmicToneMapping,
  WebGLRenderer,
  Vector2,
  // RGBFormat,
  RGBAFormat,
  DoubleSide,
  LinearFilter,
  ClampToEdgeWrapping,
  CanvasTexture,
} from 'three';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree, MeshBVH } from 'three-mesh-bvh';
import type { SerializedBVH } from 'three-mesh-bvh';
import { TresCanvas, TresContext } from '@tresjs/core';
import { TwoFiveDImageType, type ImageData } from '@/api/train/train.api.ts';
import { V3dApi } from '@/api/v3d/v3d.api.ts';
import { useMeshWorker } from './hook/useMeshWorker';
import { useRenderTargets } from './hook/useRenderTargets';
import { useResourceCleanup } from './hook/useResourceCleanup';

BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
Mesh.prototype.raycast = acceleratedRaycast;

// define mouse event interface
interface MouseEvent3D {
  mouseX: number;
  mouseY: number;
  button?: 'left' | 'right';
}

// Utility: extract mouse or touch coordinates consistently
const getPointerCoords = (evt: MouseEvent | TouchEvent): { mouseX: number; mouseY: number } => {
  if ('touches' in evt && evt.touches.length > 0) {
    return { mouseX: evt.touches[0].clientX, mouseY: evt.touches[0].clientY };
  }
  const mouseEvt = evt as MouseEvent;
  return { mouseX: mouseEvt.clientX, mouseY: mouseEvt.clientY };
};

const props = defineProps<{
  image: ImageData;
  clickMesh?: (event: MouseEvent3D) => void;
  clickMenuMesh?: (event: MouseEvent3D) => void;
  pointerMoveMesh?: (event: { mouseX: number; mouseY: number }) => void;
  onLoadMesh?: (
    scene: Scene,
    mesh: Mesh,
    heightMap: Float32Array,
    heightScale: Ref<number>,
    surfaceTexture?: Ref<CanvasTexture | null>,
    meshArea?: {
      width: number;
      height: number;
    },
  ) => void;
  simulateClickAtMouse?: () => void;
  onHeightScale?: (height: number) => void;
  isDrawing?: boolean;
}>();

const emit = defineEmits(['mode:change']);
const threeCanvasRef = ref<HTMLDivElement | null>(null);
let renderer: WebGLRenderer;
const heightScale = ref<number>(600);
const sliderHeightScale = ref<number>(600);
const renderLevel = ref<number>(0);
const geometry = ref<BufferGeometry | null>(null);
const mesh = ref(false);
const meshRef = ref<Mesh | null>(null);
const canvasRef = ref<HTMLCanvasElement | null>(null);
// texture ref
const displacementMap = ref<DataTexture | null>(null);
const roughnessMap = ref<DataTexture | null>(null);
const normalMap = ref<DataTexture | null>(null);
const bumpMap = ref<DataTexture | null>(null);
// surface texture ref
const surfaceTexture = ref<CanvasTexture | null>(null);

// lodash debounce function
let debouncedImageChange: ReturnType<typeof debounce> | null = null;

// material properties ref
const displacementScale = ref<number>(500);
const normalScale = ref<Vector2>(new Vector2(100, 100));
const bumpScale = ref<number>(80);
const displacementBias = ref<number>(25);

const loading = ref<boolean>(false);
const loadingTip = ref<string>('Loading...');

// control camera controler enable state
const enableCameraControls = ref(true);

// camera moving state tracking
const isCameraMoving = ref(false);
const cameraMovementTimer = ref<ReturnType<typeof setTimeout> | null>(null);

// shift key state tracking
const isShiftPressed = ref(false);

// listen isDrawing state change - modify to only allow camera movement when shift is pressed
watch(
  () => props.isDrawing,
  (newValue, oldValue) => {
    if (newValue) {
      // when start drawing, disable camera control, only allow camera movement when shift is pressed
      enableCameraControls.value = isShiftPressed.value;
      console.log('开始绘制，相机控制状态:', enableCameraControls.value ? '启用(shift按下)' : '禁用');
    } else {
      // when drawing end, enable camera control
      enableCameraControls.value = true;
      console.log('结束绘制，启用相机控制');

      // when drawing end, delay check if need to update camera frustum
      if (oldValue === true && canvasRef.value) {
        setTimeout(() => {
          // ensure drawing is fully ended and camera is not moving
          if (!props.isDrawing && !isCameraMoving.value) {
            console.log('绘制结束，检查是否需要更新相机设置');
            updateCameraAspect(canvasRef.value, false);
          }
        }, 300); // give enough time to ensure drawing state is stable
      }
    }
  },
  { immediate: true },
);

// listen shift key state change, dynamically control camera when drawing
watch(isShiftPressed, (newValue) => {
  if (props.isDrawing) {
    // when drawing, shift state change directly affects camera control
    enableCameraControls.value = newValue;
    console.log('绘制中shift状态变化:', newValue ? '启用相机控制' : '禁用相机控制');
  }
});

// camera and controler ref
const cameraRef = ref();
const controlsRef = ref();
const tresMeshRef = ref(); // TresMesh ref

// simplified camera movement detection - remove drawing state limit
const setupCameraMovementDetection = () => {
  if (!controlsRef.value) return;

  const controls = controlsRef.value;

  // listen controler start moving event
  if (controls && controls?.addEventListener) {
    controls.addEventListener('start', () => {
      isCameraMoving.value = true;
      console.log('相机开始移动');

      // clear previous timer
      if (cameraMovementTimer.value) {
        clearTimeout(cameraMovementTimer.value);
      }
    });
    // listen controler change event
    controls.addEventListener('change', () => {
      isCameraMoving.value = true;

      // clear previous timer
      if (cameraMovementTimer.value) {
        clearTimeout(cameraMovementTimer.value);
      }

      // set new timer, 500ms later consider camera stop moving
      cameraMovementTimer.value = setTimeout(() => {
        isCameraMoving.value = false;
        console.log('相机停止移动');
      }, 50);
    });

    // listen controler end moving event
    controls.addEventListener('end', () => {
      // set to stop moving after a short delay
      setTimeout(() => {
        isCameraMoving.value = false;
        console.log('相机移动结束');
      }, 50);
    });
  }
};

// light position and intensity - optimized for grainy effect
const mainLightPosition = ref<[number, number, number]>([1500, 2000, 1200]);
const sideLight1Position = ref<[number, number, number]>([-1000, 800, 800]);
const topLightPosition = ref<[number, number, number]>([0, 1200, 0]);
// contour light - low angle side light, enhance grainy edge
const contourLightIntensity = ref<number>(0.4);
const contourLightPosition = ref<[number, number, number]>([-1800, 300, -600]);

// balance light intensity - keep detail but avoid too dark
const mainLightIntensity = ref<number>(1.8);
const sideLightIntensity = ref<number>(0.6);
const topLightIntensity = ref<number>(0.4);
const ambientLightIntensity = ref<number>(0.8);
const hemisphereIntensity = ref<number>(0.5);

// camera frustum boundary - dynamically calculate to match canvas ratio
const cameraLeft = ref<number>(-2000);
const cameraRight = ref<number>(2000);
const cameraTop = ref<number>(2000);
const cameraBottom = ref<number>(-2000);
const cameraNear = ref<number>(5);
const cameraFar = ref<number>(5000);

// mode control
const holding = ref(false);
const currentImageMode = ref(TwoFiveDImageType.MEAN);

// cache original data, avoid duplicate request
const baseGridSize = ref<number | null>(null);

const cachedMeshData = ref<{
  width: number;
  height: number;
  heightMap: Float32Array;
  mean: Int8Array;
  normal: Int8Array;
  level: number;
} | null>(null);

let scene: Scene;
let resizeObserver: ResizeObserver | null = null;

// mouse position tracking
const currentMousePosition = ref<{ x: number; y: number } | null>(null);

// Web Worker related
const meshWorker = useMeshWorker();
const { isWorkerReady, isProcessing, initWorker, terminateWorker, processMeshData, processTextureData, updateColors, getProgressText } = meshWorker;

// offscreen rendering optimization
const renderTargetsHook = useRenderTargets();
const { renderTargets, performanceStats, lodSettings, dynamicResolution, initRenderTargets, startPerformanceMonitoring, cleanupRenderTargets } =
  renderTargetsHook;

// resource cleanup related
const resourceCleanup = useResourceCleanup();
const { cleanupAllResources, cleanupAndReinitRenderer } = resourceCleanup;

// create Three.js texture object from Worker data (optimized version)
const createTexturesFromWorkerData = (
  textureData: {
    displacementData: Float32Array;
    roughnessData: Float32Array;
    normalData: Float32Array;
  },
  width: number,
  height: number,
) => {
  console.log(`开始创建纹理对象 (${width}x${height})...`);
  const startTime = performance.now();

  // common texture config
  const commonConfig = {
    generateMipmaps: false,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    wrapS: ClampToEdgeWrapping,
    wrapT: ClampToEdgeWrapping,
    needsUpdate: true,
  };

  // check support of float texture, use high precision to reduce lighting stripes
  const tempCanvas = document.createElement('canvas');
  const gl = (tempCanvas.getContext('webgl2') as WebGL2RenderingContext) || tempCanvas.getContext('webgl');
  const isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
  const hasFloatTexExt = !!gl && (!!gl.getExtension('OES_texture_float') || isWebGL2);

  let normalTexture: DataTexture;

  if (hasFloatTexExt && isWebGL2) {
    // WebGL2 directly support RGB + FloatType (best quality)
    const rgbaFloat = new Float32Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      rgbaFloat[i * 4] = textureData.normalData[i * 3];
      rgbaFloat[i * 4 + 1] = textureData.normalData[i * 3 + 1];
      rgbaFloat[i * 4 + 2] = textureData.normalData[i * 3 + 2];
      rgbaFloat[i * 4 + 3] = 1.0;
    }
    normalTexture = new DataTexture(textureData.normalData, width, height, RGBAFormat, FloatType);
  } else if (hasFloatTexExt) {
    // WebGL1 + extension: use RGBA + FloatType
    const rgbaFloat = new Float32Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      rgbaFloat[i * 4] = textureData.normalData[i * 3];
      rgbaFloat[i * 4 + 1] = textureData.normalData[i * 3 + 1];
      rgbaFloat[i * 4 + 2] = textureData.normalData[i * 3 + 2];
      rgbaFloat[i * 4 + 3] = 1.0;
    }
    normalTexture = new DataTexture(rgbaFloat, width, height, RGBAFormat, FloatType);
  } else {
    // fallback: 8-bit + dithering, reduce quantization stripes
    const normalUint8 = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const r = textureData.normalData[i * 3];
      const g = textureData.normalData[i * 3 + 1];
      const b = textureData.normalData[i * 3 + 2];

      const noise = () => (Math.random() - 0.5) * (1 / 255);
      normalUint8[i * 4] = Math.round(Math.max(0, Math.min(1, r + noise())) * 255);
      normalUint8[i * 4 + 1] = Math.round(Math.max(0, Math.min(1, g + noise())) * 255);
      normalUint8[i * 4 + 2] = Math.round(Math.max(0, Math.min(1, b + noise())) * 255);
      normalUint8[i * 4 + 3] = 255;
    }
    normalTexture = new DataTexture(normalUint8, width, height, RGBAFormat, UnsignedByteType);
  }

  const textures = {
    displacement: new DataTexture(textureData.displacementData, width, height, RedFormat, FloatType),
    roughness: new DataTexture(textureData.roughnessData, width, height, RedFormat, FloatType),
    normal: normalTexture,
  };

  // apply common config
  Object.values(textures).forEach((texture) => {
    Object.assign(texture, commonConfig);
  });

  // set to ref
  displacementMap.value = textures.displacement;
  roughnessMap.value = textures.roughness;
  normalMap.value = textures.normal;
  bumpMap.value = textures.displacement;

  const endTime = performance.now();
  const dataSize = (textureData.displacementData.length + textureData.roughnessData.length + textureData.normalData.length) * 4;
  console.log(`📝 纹理创建完成: ${(endTime - startTime).toFixed(2)}ms, 数据量: ${(dataSize / 1024 / 1024).toFixed(2)}MB`);
};

const onReady = (ctx: TresContext) => {
  try {
    scene = ctx.scene.value;
    canvasRef.value = ctx.renderer.value.domElement;
    onCanvasCreated(ctx.renderer.value);
    updateCameraAspect(canvasRef.value, true); // set camera position when first initialized

    // ensure canvas element is passed to labeling system for raycasting to work
    console.log('Canvas元素已创建，将传递给标注系统以支持光线投射');

    // delay setup camera movement detection, ensure controller is initialized
    setTimeout(() => {
      setupCameraMovementDetection();
    }, 100);

    // listen window size change
    resizeObserver = new ResizeObserver(
      debounce((entries) => {
        if (props.isDrawing) {
          return;
        }

        // if camera is moving, delay processing
        if (isCameraMoving.value) {
          console.log('camera is moving, delay processing');
          setTimeout(() => {
            if (!props.isDrawing && !isCameraMoving.value) {
              resizeObserver?.disconnect();
              if (canvasRef.value) {
                resizeObserver?.observe(canvasRef.value);
              }
            }
          }, 100);
          return;
        }

        // check if canvas size really changed
        const entry = entries[0];
        if (entry && canvasRef.value) {
          const newWidth = entry.contentRect.width;
          const newHeight = entry.contentRect.height;
          const currentWidth = canvasRef.value.clientWidth;
          const currentHeight = canvasRef.value.clientHeight;

          // only adjust camera when canvas size really changed (tolerance 1px)
          if (Math.abs(newWidth - currentWidth) > 1 || Math.abs(newHeight - currentHeight) > 1) {
            console.log(`canvas size changed: ${currentWidth}x${currentHeight} -> ${newWidth}x${newHeight}`);

            // only adjust camera when not drawing
            if (!props.isDrawing) {
              updateCameraAspect(canvasRef.value, false); // do not reset camera position when window resized

              // trigger coordinate recalibration (delay execution, ensure canvas size is updated)
              setTimeout(() => {
                if (!props.isDrawing) {
                  window.dispatchEvent(
                    new CustomEvent('canvasResized', {
                      detail: { width: newWidth, height: newHeight },
                    }),
                  );
                }
              }, 100);
            } else {
              console.log('drawing, delay camera adjustment to drawing end');
            }
          }
        }
      }, 100),
    ); // 100ms debounce, avoid frequent triggering

    if (canvasRef.value) {
      resizeObserver.observe(canvasRef.value);
    }
  } catch (error) {
    console.error('onReady error:', error);
  }
};

// initialize camera and controler (only used when first initialized)
const initializeCameraAndControls = (forceReset: boolean = false) => {
  setTimeout(() => {
    if (cameraRef.value && controlsRef.value) {
      // only set camera position when force reset or first initialized
      if (forceReset) {
        const camera = cameraRef.value;

        // after geometry rotation + π/2, the terrain faces -Z direction, and the front is observed from the positive Z axis
        camera.position.set(0, 0, 1000); // observe from the positive Z axis
        camera.lookAt(0, 0, 0); // look at the center of the terrain
        camera.up.set(0, 1, 0); // set the camera's up direction to the positive Y axis (standard setting)

        // update controler
        if (controlsRef.value && controlsRef.value?.target && controlsRef.value?.update) {
          controlsRef.value.target.set(0, 0, 0);
          controlsRef.value.update();
        }

        console.log('camera position reset');
        console.log('camera position:', camera.position);
        console.log('camera up vector:', camera.up);
      } else {
        // only update controler, do not change camera position
        if (controlsRef.value) {
          controlsRef.value.update();
        }
        console.log('camera controller updated, position kept');
      }
    }
  }, 100);
};

// extract height scale setting application logic to independent function
const applyHeightScaleSettings = (newValue: number) => {
  const minScale = 0.001;
  const rawScaleZ = newValue / 120;
  const scaleZ = Math.max(minScale, rawScaleZ);

  if (meshRef.value) {
    meshRef.value.scale.z = scaleZ;
    meshRef.value.updateMatrixWorld(true);
  }

  displacementScale.value = 0;
  displacementBias.value = 0;

  const normalIntensity = Math.max(50, newValue / 8);
  normalScale.value = new Vector2(normalIntensity, normalIntensity);

  const bumpIntensity = Math.max(30, newValue / 10);
  bumpScale.value = bumpIntensity;

  const heightFactor = Math.max(1, Math.min(2.0, newValue / 1000));

  mainLightIntensity.value = 1.8 * Math.min(1.5, heightFactor);
  sideLightIntensity.value = 0.6 * Math.min(1.4, heightFactor);
  topLightIntensity.value = 0.8 * Math.min(1.3, heightFactor);
  ambientLightIntensity.value = 0.8 * Math.min(1.2, heightFactor);

  contourLightIntensity.value = 0.6 * Math.max(0.8, Math.min(1.6, newValue / 1000));

  const positionScale = Math.max(0.8, Math.min(2.2, newValue / 800));
  mainLightPosition.value = [1500 * positionScale, 2000 * positionScale, 1200 * positionScale];
  sideLight1Position.value = [-1000 * positionScale, 800 * positionScale, 800 * positionScale];
  topLightPosition.value = [0, 1200 * positionScale, 0];

  contourLightPosition.value = [-1800 * positionScale, 300 + newValue * 0.15, -600 * positionScale];

  if (props.onHeightScale) {
    props.onHeightScale(newValue);
  }
  console.log(`高度: ${newValue}, 几何体Z缩放: ${scaleZ.toFixed(3)}, 光照缩放: ${positionScale.toFixed(2)}`);
};

watch(heightScale, applyHeightScaleSettings);
const onCanvasCreated = (renderers: WebGLRenderer) => {
  renderer = renderers;
  // shadow map config
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = 2;
  renderer.shadowMap.autoUpdate = true;

  // tone mapping config
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.25;
  // physically correct lights
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  renderer.physicallyCorrectLights = true;
  renderer.outputColorSpace = SRGBColorSpace;

  const pixelRatio = Math.min(window.devicePixelRatio, 2);
  renderer.setPixelRatio(pixelRatio);
  renderer.sortObjects = false;

  console.log(`renderer config: device pixel ratio=${window.devicePixelRatio}, pixel ratio=${pixelRatio}`);

  const canvas = renderer.domElement;
  // init render targets
  initRenderTargets({
    width: canvas.clientWidth,
    height: canvas.clientHeight,
    pixelRatio: renderer.getPixelRatio(),
  });

  // start performance monitoring
  startPerformanceMonitoring();
};
const onClickMesh = (event: MouseEvent | TouchEvent) => {
  if (!meshRef.value) {
    console.warn('3D click event: mesh reference is null');
    return;
  }

  // get mouse position on canvas
  const rect = canvasRef.value?.getBoundingClientRect();
  if (!rect) {
    console.warn('3D click event: canvas bounding box get failed');
    return;
  }

  const { mouseX, mouseY } = getPointerCoords(event);

  if (props.clickMesh) {
    props.clickMesh({ mouseX, mouseY, button: 'left' });
  }
};

const onMenuClickMesh = (event: MouseEvent | TouchEvent) => {
  if (!meshRef.value) return;

  // get mouse position on canvas
  const rect = canvasRef.value?.getBoundingClientRect();
  if (!rect) return;

  const { mouseX, mouseY } = getPointerCoords(event);

  if (props.clickMenuMesh) {
    props.clickMenuMesh({ mouseX, mouseY, button: 'right' });
  }
};

const onPointerMoveMesh = (event: MouseEvent | TouchEvent) => {
  // get mouse position on canvas
  const rect = canvasRef.value?.getBoundingClientRect();
  if (!rect) {
    console.warn('3D pointer move event: canvas bounding box get failed');
    return;
  }

  const { mouseX, mouseY } = getPointerCoords(event);

  currentMousePosition.value = { x: mouseX, y: mouseY };

  if (props.pointerMoveMesh) {
    props.pointerMoveMesh({ mouseX, mouseY });
  }
};

const handleKeyDown = (event: KeyboardEvent) => {
  const isShiftKey = event.key === 'Shift' || event.key === 'ShiftLeft' || event.key === 'ShiftRight';
  // R key reset camera view
  if (event.key === 'r' || event.key === 'R') {
    resetCameraView();
    return;
  }

  // allow Ctrl+Z to be passed to parent component for undo operation
  if (event.ctrlKey && event.key === 'z') {
    // do not block event, let it be passed to parent component (xLabel.vue)
    return;
  }

  // block other Ctrl combinations
  if (event.ctrlKey || event.metaKey) {
    return; // if control or mac key pressed, ignore event
  }

  // handle Shift key down - new logic: allow camera movement when drawing
  if (isShiftKey) {
    isShiftPressed.value = true;
    if (controlsRef.value && !holding.value) {
      holding.value = true;
      // when drawing, enable camera control when shift key is pressed
      if (props.isDrawing) {
        controlsRef.value.enabled = true;
        console.log('drawing, enable camera control when shift key is pressed');
      } else {
        controlsRef.value.enabled = true;
      }
    }
    return;
  }

  if (event.shiftKey && event.code === 'Digit1') {
    handleModeChange(TwoFiveDImageType.MEAN);
    return;
  } else if (event.shiftKey && event.code === 'Digit2') {
    handleModeChange(TwoFiveDImageType.NORMAL);
    return;
  } else if (event.shiftKey && event.code === 'Digit3') {
    handleModeChange(TwoFiveDImageType.HEIGHT);
    return;
  }

  if (event.key === 'D' || event.key === 'd') {
    simulateClickAtMousePosition();
    return;
  }
};

const handleModeChange = (mode: TwoFiveDImageType) => {
  currentImageMode.value = mode;
  heightScale.value = 600;
  sliderHeightScale.value = 600;

  console.log(`mode changed to: ${mode}, drawing status: ${props.isDrawing}`);

  // if geometry exists and has cached data, only update color
  if (geometry.value && cachedMeshData.value && mesh.value) {
    console.log(`fast switch to mode: ${mode}, only update color, do not reset camera`);
    updateGeometryColors(cachedMeshData.value, mode);
    return;
  }

  // if there is cached data but geometry does not exist, directly use cached data to reprocess, do not re-request
  if (cachedMeshData.value && canvasRef.value) {
    console.log(`switch to mode: ${mode}, use cached data, do not reset camera`);
    processCachedMeshData(cachedMeshData.value, mode);
  } else if (canvasRef.value) {
    // if there is no cached data, then load initial data
    console.log(`load initial data for mode: ${mode}`);
    initTwoFiveDImage();
  }
  emit('mode:change', mode);
};

// 快速更新几何体颜色的函数
const updateGeometryColors = async (meshData: NonNullable<typeof cachedMeshData.value>, mode: TwoFiveDImageType) => {
  if (!geometry.value) return;

  const { width, height, mean, normal } = meshData;

  console.log(`start fast color update, mode: ${mode}`);
  const startTime = performance.now();

  try {
    // 使用Worker处理颜色更新
    const result = await updateColors({
      width,
      height,
      mean,
      normal,
      imageMode: mode,
    });

    // 更新几何体颜色属性
    geometry.value.setAttribute('color', new BufferAttribute(result.colors, 3));
    geometry.value.attributes.color.needsUpdate = true;

    const endTime = performance.now();
    console.log(`✅ fast color update done, time: ${(endTime - startTime).toFixed(2)}ms`);

    // reset height scale settings
    setTimeout(() => {
      applyHeightScaleSettings(heightScale.value);
    }, 50);
  } catch (error) {
    console.error('fast color update failed:', error);
    // if worker update failed, downgrade to full reprocess
    console.log('downgrade to full reprocess...');
    await processCachedMeshData(meshData, mode);
  }
};

const handleKeyUp = (event: KeyboardEvent) => {
  if (event.key === 'Shift') {
    isShiftPressed.value = false;
    holding.value = false;
    if (controlsRef.value) {
      if (props.isDrawing) {
        controlsRef.value.enabled = false;
        console.log('drawing, disable camera control when shift key is released');
      }
      // when not drawing, keep camera control enabled
    }
  }
};

// simulate click at mouse position
const simulateClickAtMousePosition = () => {
  if (currentMousePosition.value) {
    if (props.simulateClickAtMouse) {
      props.simulateClickAtMouse();
    } else if (props.clickMesh) {
      props.clickMesh({
        mouseX: currentMousePosition.value.x,
        mouseY: currentMousePosition.value.y,
        button: 'left',
      });
    }
    console.log('3D simulate click, mouse position:', currentMousePosition.value);
  } else {
    console.warn('no available mouse position, please move mouse to 3D surface');
  }
};

// add mouse event listener to track mouse position
const addMouseTracking = () => {
  if (canvasRef.value) {
    useEventListener(canvasRef.value, 'mousemove', (event) => {
      currentMousePosition.value = {
        x: event.clientX,
        y: event.clientY,
      };
    });
  }
};

// reset camera view (for R key or manual reset)
const resetCameraView = () => {
  // if drawing, do not reset camera view
  if (props.isDrawing) {
    console.log('drawing, skip camera reset');
    return;
  }

  if (cameraRef.value && controlsRef.value) {
    const camera = cameraRef.value;

    // reset camera to view from positive Z axis
    camera.position.set(0, 0, 1000);
    camera.lookAt(0, 0, 0);
    camera.up.set(0, 1, 0); // set Y axis as up vector

    // update controls
    controlsRef.value.target.set(0, 0, 0);
    controlsRef.value.update();

    console.log('camera view reset to front view');
  }
};

watch(sliderHeightScale, (newValue) => {
  heightScale.value = newValue;
});

const init = () => {
  // init Web Worker
  initWorker();

  // init 3D scene
  initTwoFiveDImage();
};

// update camera aspect to match canvas ratio
const updateCameraAspect = (canvas: HTMLCanvasElement, isInitializing: boolean = false) => {
  if (!canvas) return;

  if (props.isDrawing && !isInitializing) {
    console.log('drawing, skip camera aspect adjustment (protect drawing process)');
    return;
  }

  if (isCameraMoving.value && !isInitializing) {
    console.log('camera is moving, skip camera aspect adjustment');
    return;
  }

  const canvasWidth = canvas.clientWidth;
  const canvasHeight = canvas.clientHeight;
  const aspectRatio = canvasWidth / canvasHeight;

  if (canvasWidth <= 0 || canvasHeight <= 0) {
    console.warn('canvas size is invalid, skip camera adjustment');
    return;
  }

  // base camera aspect ratio
  const baseSize = 1500;

  // calculate new camera aspect ratio
  let newCameraLeft, newCameraRight, newCameraTop, newCameraBottom;

  if (aspectRatio > 1) {
    // wide screen: expand left and right boundaries
    newCameraLeft = -baseSize * aspectRatio;
    newCameraRight = baseSize * aspectRatio;
    newCameraTop = baseSize;
    newCameraBottom = -baseSize;
  } else {
    // tall screen: expand top and bottom boundaries
    newCameraLeft = -baseSize;
    newCameraRight = baseSize;
    newCameraTop = baseSize / aspectRatio;
    newCameraBottom = -baseSize / aspectRatio;
  }

  // check if there is actual change (avoid unnecessary updates)
  const hasChange =
    Math.abs(cameraLeft.value - newCameraLeft) > 1 ||
    Math.abs(cameraRight.value - newCameraRight) > 1 ||
    Math.abs(cameraTop.value - newCameraTop) > 1 ||
    Math.abs(cameraBottom.value - newCameraBottom) > 1;

  if (!hasChange && !isInitializing) {
    console.log('camera aspect ratio no change, skip update');
    return;
  }

  // update camera aspect ratio
  cameraLeft.value = newCameraLeft;
  cameraRight.value = newCameraRight;
  cameraTop.value = newCameraTop;
  cameraBottom.value = newCameraBottom;

  // ensure near and far clipping planes are set properly
  cameraNear.value = 5;
  cameraFar.value = 3000;

  console.log(`canvas size: ${canvasWidth}x${canvasHeight}, aspect ratio: ${aspectRatio.toFixed(2)}`);
  console.log(`camera aspect ratio: left=${cameraLeft.value}, right=${cameraRight.value}, top=${cameraTop.value}, bottom=${cameraBottom.value}`);

  // only set camera position on initialization, avoid resetting camera position on window resize
  if (isInitializing) {
    // force reset camera position on first initialization
    initializeCameraAndControls(true);
  }

  // if camera is initialized, update its projection matrix (but not during drawing or camera movement)
  if (cameraRef.value && !props.isDrawing && !isCameraMoving.value) {
    cameraRef.value.updateProjectionMatrix();
    console.log('camera projection matrix updated');
  }

  // update offscreen render target size (but not during drawing or camera movement)
  if (renderer && !props.isDrawing && !isCameraMoving.value) {
    renderTargetsHook.updateRenderTargetSizes(renderer);
    console.log('offscreen render target size updated');
  }
};

// use cached data to process mesh, avoid duplicate requests
const processCachedMeshData = async (meshData: NonNullable<typeof cachedMeshData.value>, mode: TwoFiveDImageType) => {
  await processMeshDataCore(meshData, mode, true);
};

const meshBinaryCache: Map<string, ArrayBuffer> = new Map();

const fetchMeshLevel = async (
  level: number,
): Promise<{
  width: number;
  height: number;
  heightMap: Float32Array;
  mean: Int8Array;
  normal: Int8Array;
  level: number;
} | null> => {
  try {
    const cacheKey = `${props.image.id}_${level}`;
    let buf: ArrayBuffer;

    if (meshBinaryCache.has(cacheKey)) {
      console.log(`🔄 Mesh binary cache hit for key = ${cacheKey}`);
      buf = meshBinaryCache.get(cacheKey) as ArrayBuffer;
    } else {
      console.log(`⬇️  Fetch mesh binary from server for key = ${cacheKey}`);
      const res = await V3dApi.mesh(props.image.id, level);
      buf = await res.arrayBuffer();
      meshBinaryCache.set(cacheKey, buf);
    }
    const dv = new DataView(buf);
    const width = dv.getInt32(0, true);
    const height = dv.getInt32(4, true);
    const count = width * height;
    const heightMap = new Float32Array(buf.slice(8, 8 + count * 4));
    const colorOffset = 8 + count * 4;
    const mean = new Int8Array(buf.slice(colorOffset, colorOffset + count * 3));
    const normal = new Int8Array(buf.slice(colorOffset + count * 3, colorOffset + count * 6));
    return { width, height, heightMap, mean, normal, level };
  } catch (e) {
    console.error('load level=', level, 'failed', e);
    return null;
  }
};

const initTwoFiveDImage = async () => {
  const previewLevel = 5;
  const highLevel = 2;

  const previewData = await fetchMeshLevel(previewLevel);
  if (previewData) {
    renderLevel.value = previewLevel;
    await processMeshDataCore(previewData, currentImageMode.value, false);
  }

  fetchMeshLevel(highLevel).then(async (hd) => {
    if (!hd) return;

    cachedMeshData.value = hd;

    await processMeshDataCore(hd, currentImageMode.value, false);
    renderLevel.value = highLevel;
  });
};

onMounted(() => {
  useEventListener(document.body as HTMLElement, 'keydown', handleKeyDown);
  useEventListener(document.body as HTMLElement, 'keyup', handleKeyUp);

  init();
  // add mouse tracking on next tick, ensure canvas is created
  setTimeout(() => {
    addMouseTracking();
  }, 50);
});

const handleImageChange = () => {
  cachedMeshData.value = null;
};

// create lodash debounce function
debouncedImageChange = debounce(handleImageChange, 10);

watch(
  () => props.image.id,
  (val) => {
    heightScale.value = 500;
    sliderHeightScale.value = 500;
    // cleanupAndReinitRenderer(renderer);  // renderer reuse
    if (debouncedImageChange) {
      debouncedImageChange();
    }
  },
  { deep: true },
);

// core 3D mesh processing logic, handle both cached and new loaded data
const processMeshDataCore = async (
  meshData: {
    width: number;
    height: number;
    heightMap: Float32Array;
    mean: Int8Array;
    normal: Int8Array;
    level: number;
  },
  mode: TwoFiveDImageType,
  isFromCache = false,
) => {
  try {
    loading.value = true;
    const logPrefix = isFromCache ? '（缓存模式）' : '';
    console.log(`开始处理3D网格数据${logPrefix}...`);

    if (!isWorkerReady.value) {
      initWorker();
      await new Promise((resolve) => {
        const checkWorker = () => {
          if (isWorkerReady.value) {
            resolve(true);
          } else {
            setTimeout(checkWorker, 50);
          }
        };
        checkWorker();
      });
    }

    const { width, height, heightMap, mean, normal, level } = meshData;
    const count = width * height;
    const totalStartTime = performance.now();

    console.log(`开始Worker处理${logPrefix}，总顶点数:`, count);

    const updateProgress = () => {
      if (isProcessing.value) {
        loadingTip.value = getProgressText();
        requestAnimationFrame(updateProgress);
      }
    };
    updateProgress();

    try {
      const meshResult = await processMeshData({
        width,
        height,
        heightMap,
        mean,
        normal,
        heightScale: heightScale.value,
        baseGridSize: baseGridSize.value,
        level,
        imageMode: mode,
      });

      console.log(`Worker网格数据处理完成${logPrefix}`);

      const textureResult = await processTextureData({
        vertexColors: meshResult.colors,
        heightMap,
        width,
        height,
      });

      console.log(`Worker纹理数据处理完成${logPrefix}`);

      const newGeometry = new BufferGeometry();

      newGeometry.setAttribute('position', new BufferAttribute(meshResult.positions, 3));
      newGeometry.setAttribute('color', new BufferAttribute(meshResult.colors, 3));
      newGeometry.setAttribute('uv', new BufferAttribute(meshResult.uvs, 2));
      newGeometry.setIndex(new BufferAttribute(meshResult.indices, 1));

      if (baseGridSize.value === null) {
        baseGridSize.value = width;
      }

      const computeStartTime = performance.now();

      // parallel execution of geometry calculation and texture creation
      await Promise.all([
        // use Worker generated vertex normals, skip computeVertexNormals()
        new Promise((resolve) => {
          const start = performance.now();
          newGeometry.setAttribute('normal', new BufferAttribute(meshResult.normals, 3));
          console.log(`normal attribute applied ${logPrefix}, time: ${(performance.now() - start).toFixed(2)}ms`);
          resolve(true);
        }),
        new Promise((resolve) => {
          const start = performance.now();
          newGeometry.computeBoundingBox();
          newGeometry.computeBoundingSphere();
          console.log(`bounding box computed ${logPrefix}, time: ${(performance.now() - start).toFixed(2)}ms`);
          resolve(true);
        }),
        new Promise((resolve) => {
          const start = performance.now();
          createTexturesFromWorkerData(textureResult, width, height);
          console.log(`texture created ${logPrefix}, time: ${(performance.now() - start).toFixed(2)}ms`);
          resolve(true);
        }),
      ]);

      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      const meshWithBvh = meshResult as { bvh?: SerializedBVH };
      if (meshWithBvh.bvh) {
        try {
          const startBvh = performance.now();
          const bvhInstance = MeshBVH.deserialize(meshWithBvh.bvh as SerializedBVH, newGeometry);
          (newGeometry as BufferGeometry & { boundsTree?: unknown }).boundsTree = bvhInstance;
          console.log(`BVH deserialized ${logPrefix}, time: ${(performance.now() - startBvh).toFixed(2)}ms`);
        } catch (err) {
          console.error('BVH deserialization failed', err);
        }
      }

      console.log(`critical geometry operations completed ${logPrefix}, total time: ${(performance.now() - computeStartTime).toFixed(2)}ms`);

      // set geometry
      geometry.value = newGeometry;
      mesh.value = true;

      // wait for Vue to update DOM, then get the actual mesh object created by TresJS
      await nextTick();

      // delay getting mesh object, ensure TresJS is fully initialized
      setTimeout(() => {
        if (renderLevel.value === 5) {
          return;
        }
        if (tresMeshRef.value) {
          meshRef.value = tresMeshRef.value;

          meshRef.value.updateMatrixWorld(true);

          const initialScaleZ = heightScale.value / 120;
          meshRef.value.scale.z = initialScaleZ;
          meshRef.value.updateMatrixWorld(true);

          meshRef.value.userData.isTerrainMesh = true;
          meshRef.value.userData.meshId = `terrain_${Date.now()}`;

          if (props.onLoadMesh) {
            const geo = meshRef.value.geometry;
            if (geo && geo.boundingBox && geo.boundsTree) {
              console.log(`mesh object validated ${logPrefix}, passed to labeling system`);
              props.onLoadMesh(scene, meshRef.value, heightMap, heightScale, surfaceTexture, {
                width: width * renderLevel.value,
                height: height * renderLevel.value,
              });
            } else {
              console.error(`mesh object validation failed ${logPrefix}:`, {
                hasGeometry: !!geo,
                hasBoundingBox: !!geo?.boundingBox,
                hasBVH: !!geo?.boundsTree,
              });
            }
          }
        } else {
          console.error(`cannot get TresMesh reference ${logPrefix}`);
        }
      }, 10);

      const totalTime = performance.now() - totalStartTime;

      if (!isFromCache) {
        console.log(`performance statistics:`);
        console.log(`   - total initialization time: ${totalTime.toFixed(2)}ms`);
      }

      loading.value = false;

      // delay apply height scale settings
      setTimeout(() => {
        applyHeightScaleSettings(heightScale.value);
      }, 10);
    } catch (workerError) {
      console.error(`Worker processing failed ${logPrefix}:`, workerError);
      loading.value = false;
    }
  } catch (err) {
    console.error(`3D mesh processing failed ${isFromCache ? '(cached mode)' : ''}:`, err);
    loading.value = false;
  }
};

// expose performance control interface
defineExpose({
  meshRef,
  heightScale,
  cameraRef,
  // offscreen rendering performance statistics
  performanceStats,
  lodSettings,
  dynamicResolution,
  renderTargets,
  // camera movement state
  isCameraMoving,
});

onUnmounted(() => {
  console.log('onUnmounted');

  window.removeEventListener('keydown', handleKeyDown);
  window.removeEventListener('keyup', handleKeyUp);

  if (debouncedImageChange) {
    debouncedImageChange.cancel();
    debouncedImageChange = null;
  }

  if (cameraMovementTimer.value) {
    clearTimeout(cameraMovementTimer.value);
    cameraMovementTimer.value = null;
  }
  if (resizeObserver) {
    resizeObserver.disconnect();
  }

  cleanupAllResources({
    geometry,
    meshRef,
    displacementMap,
    roughnessMap,
    normalMap,
    bumpMap,
    cachedMeshData,
    mesh,
    loading,
    terminateWorker,
    cleanupRenderTargets,
  });
  cleanupAndReinitRenderer(renderer);
});
</script>

<style scoped></style>
