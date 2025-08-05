import { Mesh, Scene, Vector3, BufferGeometry, Line, Group, Camera, CanvasTexture, Box3, Raycaster, Vector2, Face } from 'three';
import { ref, markRaw, shallowRef, Ref, reactive } from 'vue';
import { LabelShapeType, Point } from '@/type/label.type.ts';
import { Feature } from '@/api/train/project.api.ts';
import { FeatureImageLabelShape, LabelPoints, TwoFiveDImageType } from '@/api/train/train.api.ts';
import { AutoLabelPos, Contour, InferApi } from '@/api/train/InferApi.ts';
import { useThreeCanvas } from './useThreeCanvas'; // Extracted canvas utility hook

export enum PolygonType3D {
  NONE,
  AUTO_LABEL,
}

interface CanvasWithResize extends HTMLCanvasElement {
  _resizeHandler?: EventListener;
}

interface LabelWorkerMessage {
  reqId: number;
  type: 'VERTICES_READY' | 'ERROR';
  indices?: Uint32Array;
  error?: unknown;
}

export interface LabelPoint3D extends LabelPoints {
  id: number;
  points: Point[];
  mesh?: Mesh | Line;
  labelShapeType: LabelShapeType;
  isSubtract: boolean;
  worldPositions?: Vector3[];
  feature?: Feature;
  isAutoLabel?: boolean;
  vertexCache?: Uint32Array;
}

export const useLabelingTwoFiveD = ({
  labelPoints3D,
  imageId,
  featureInfo,
  SUBTRACT_RGB,
  emit,
}: {
  labelPoints3D: LabelPoint3D[];
  imageId: number;
  featureInfo: Feature;
  SUBTRACT_RGB: string;
  emit: (event: string, args: unknown) => void;
}) => {
  // 3D scene ref
  const scene = shallowRef<Scene | null>(null);
  const heightMap = shallowRef<Float32Array | null>(null);
  const mesh = shallowRef<Mesh | null>(null);
  const camera = shallowRef<Camera | null>(null);
  const cacheAutoLabel = ref<LabelPoint3D[]>([]);
  const inferenceResultContours = ref<LabelPoint3D[]>([]);
  const showMask = ref(false);
  const showLabel = ref(false);
  // labeling config
  const labelingImageType = ref<TwoFiveDImageType>(TwoFiveDImageType.MEAN);
  const savedLabelPoints = ref<LabelPoint3D[]>([]);
  const labelConfig = reactive({
    isTwoFiveD: false,
    isSubtract: false,
  });

  // height scale (used in canvas hook)
  let heightScale: Ref<number>;

  // save original color and affected vertices
  const originalColors = shallowRef<Float32Array | null>(null);
  const affectedVertices = ref<Set<number>>(new Set());

  let labelWorker: Worker | null = null;
  let workerReqId = 0;
  const pendingWorkerPromises = new Map<number, (indices: Uint32Array) => void>();

  const getLabelWorker = () => {
    if (!labelWorker) {
      labelWorker = markRaw(new Worker(new URL('../workers/labelColorWorker.ts', import.meta.url), { type: 'module' }));

      labelWorker.onmessage = (e: MessageEvent) => {
        const { reqId, type, indices, error } = e.data as LabelWorkerMessage;
        if (type === 'VERTICES_READY') {
          pendingWorkerPromises.get(reqId)?.(indices as Uint32Array);
          pendingWorkerPromises.delete(reqId);
        } else if (type === 'ERROR') {
          console.error('labelWorker error:', error);
          pendingWorkerPromises.get(reqId)?.(new Uint32Array());
          pendingWorkerPromises.delete(reqId);
        }
      };
    }
    return labelWorker;
  };

  let positionsXY: Float32Array | null = null;
  let meshWidthCached = 0;

  const computeVerticesViaWorker = (worldPositions: Vector3[]): Promise<Uint32Array> => {
    if (!positionsXY) {
      return Promise.resolve(new Uint32Array());
    }
    const worker = getLabelWorker();
    const reqId = ++workerReqId;
    return new Promise<Uint32Array>((resolve) => {
      pendingWorkerPromises.set(reqId, resolve);
      const poly = new Float32Array(worldPositions.length * 2);
      for (let i = 0; i < worldPositions.length; i++) {
        poly[i * 2] = worldPositions[i].x;
        poly[i * 2 + 1] = worldPositions[i].y;
      }
      worker.postMessage(
        {
          reqId,
          type: 'GET_VERTICES',
          width: meshWidthCached,
          positionsXY,
          polygon: poly,
        },
        [poly.buffer],
      );
    });
  };

  // use separated canvas hook, keep API consistent
  const {
    surfaceCanvas,
    surfaceContext,
    surfaceTexture,
    surfaceCanvasSize,
    getScalingFactors,
    setupCanvasContext,
    createSurfaceCanvas,
    addRenderTask,
    updateSurfaceTexture,
    adjustHexBrightness,
    setLabelVisibility: canvasSetLabelVisibility,
  } = useThreeCanvas({ heightScaleRef: heightScale });

  // label visibility wrapper: redraw when visible
  const setLabelVisibility = ([_isLabelMode, isShowLabel, isShowMask]: [boolean, boolean, boolean]) => {
    showLabel.value = isShowLabel;
    showMask.value = isShowMask;
    canvasSetLabelVisibility(isShowLabel);
    redrawAllLabelsOnSurface();
  };

  // coordinate calibration system
  const coordinateCalibration = ref({
    offsetX: 0,
    offsetY: 0,
    scaleX: 1,
    scaleY: 1,
    enabled: true,
  });

  // 3D drawing state
  const polygonType3D = ref<PolygonType3D>(PolygonType3D.NONE);
  const isDrawing = ref(false);
  const currentPoints = ref<Vector3[]>([]);
  const drawingGroup = shallowRef<Group | null>(null);
  const meshArea = ref<{ width: number; height: number } | null>(null);
  // preview state
  const previewPoints = ref<Vector3[]>([]);
  const previewWorldPoint = ref<Vector3 | null>(null);

  // Hover state management
  const hoveredLabelIndex = ref<number>(-1);
  const isHovering = ref<boolean>(false);
  const hoverDisabled = ref<boolean>(false);
  const lastMouseIntersection = ref<Vector3 | null>(null);

  // auto labeling state
  const isAutoLabeling = ref(false);
  const autoLabelController = ref<AbortController | null>(null);
  let autoLabelDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  // store auto labeling marks (only record coordinates and type) for batch clearing or undo
  interface AutoLabelMark {
    worldPoint: Vector3;
    pos: AutoLabelPos;
  }
  const autoLabelMarkLines = ref<AutoLabelMark[]>([]);

  // cache and camera state
  const boundingBox = shallowRef<Box3 | null>(null);
  const canvasElement = shallowRef<HTMLCanvasElement | null>(null);
  const isCameraMoving = shallowRef<boolean>(false);
  // use RAF loop instead of timer, reduce wake-up overhead
  const cameraMovementFrameId = ref<number | null>(null);
  const lastCameraPosition = ref<Vector3 | null>(null);
  const lastCameraRotation = ref<{ x: number; y: number; z: number } | null>(null);
  const lastCameraDistance = ref<number>(0);

  // shared Raycaster / Mouse vector
  const sharedRaycaster = markRaw(new Raycaster());
  const sharedMouse = markRaw(new Vector2());

  // refresh original colors when mesh colors updated
  const refreshOriginalColors = () => {
    if (mesh.value) {
      const geometry = mesh.value.geometry as BufferGeometry;
      const colorsAttr = geometry.attributes.color;
      if (colorsAttr) {
        originalColors.value = new Float32Array(colorsAttr.array as Float32Array);
      }
    }
  };

  // load mesh data and initialize
  const onLoadMesh = (
    _scene: Scene,
    _mesh: Mesh,
    _heightMap: Float32Array,
    _heightScale: Ref<number>,
    _surfaceTextureRef?: Ref<CanvasTexture | null>,
    _meshArea?: {
      width: number;
      height: number;
    },
  ) => {
    scene.value = markRaw(_scene);
    heightMap.value = _heightMap;
    mesh.value = markRaw(_mesh);
    meshArea.value = _meshArea;
    heightScale = _heightScale;
    const geometry = _mesh.geometry as BufferGeometry;
    const colors = geometry.attributes.color;
    if (colors) {
      originalColors.value = new Float32Array(colors.array as Float32Array);
    }

    // -------------- 预计算顶点 (x,y) 并缓存到 Worker ----------------
    const positionAttr = geometry.attributes.position;
    const vertexCount = positionAttr.count;
    meshWidthCached = Math.sqrt(vertexCount);
    const rawPosArray = positionAttr.array as Float32Array;
    positionsXY = new Float32Array(vertexCount * 2);
    for (let i = 0; i < vertexCount; i++) {
      positionsXY[i * 2] = rawPosArray[i * 3]; // x
      positionsXY[i * 2 + 1] = rawPosArray[i * 3 + 1]; // y
    }
    // 可提前 warm-up Worker（可选）
    getLabelWorker();

    boundingBox.value = geometry.boundingBox;
    // create drawing group
    const group = markRaw(new Group());
    group.name = 'labelingGroup';
    drawingGroup.value = group;
    _scene.add(group);

    // create surface rendering canvas
    const devicePixelRatio = window.devicePixelRatio || 1;
    const antiAliasScale = 2.0;
    const baseCanvasSize = Math.min(1024, Math.max(512, Math.sqrt(geometry.attributes.position.count / 4)));
    const canvasSize = Math.min(2048, baseCanvasSize * Math.sqrt(devicePixelRatio * antiAliasScale));

    const texture = createSurfaceCanvas(canvasSize, canvasSize);

    if (texture && _surfaceTextureRef) {
      _surfaceTextureRef.value = texture;
      addRenderTask(() => {
        redrawAllLabelsOnSurface(-1);
      });
    }
  };

  // raycasting function - support precise raycasting for scaled geometry
  const performEnhancedRaycast = (mouseX: number, mouseY: number, targetMesh?: Mesh): { point: Vector3; normal: Vector3; face: Face | null } | null => {
    if (!camera.value || !canvasElement.value) {
      return null;
    }

    if (isCameraMoving.value) {
      return null;
    }

    const targetObject = targetMesh || mesh.value;
    if (!targetObject) {
      return null;
    }

    targetObject.updateMatrixWorld(true);

    const zScale = targetObject.scale.z;
    if (zScale < 0.01) {
      console.warn(`Tiny Z-axis scale detected: ${zScale.toFixed(6)}`);
    }

    // Use shared instance and tweak parameters as needed
    const raycaster = sharedRaycaster;

    if (zScale < 0.1) {
      raycaster.near = 0.01;
      raycaster.far = 10000;
    } else {
      raycaster.near = 0;
      raycaster.far = Infinity;
    }

    const rect = canvasElement.value.getBoundingClientRect();
    const canvas = canvasElement.value;
    const canvasWidth = canvas.clientWidth || rect.width;
    const canvasHeight = canvas.clientHeight || rect.height;

    const canvasX = mouseX - rect.left;
    const canvasY = mouseY - rect.top;

    if (canvasX < 0 || canvasX > canvasWidth || canvasY < 0 || canvasY > canvasHeight) {
      return null;
    }

    const mouse = sharedMouse;
    mouse.x = (canvasX / canvasWidth) * 2 - 1;
    mouse.y = -(canvasY / canvasHeight) * 2 + 1;

    raycaster.setFromCamera(mouse, camera.value);
    const intersects = raycaster.intersectObject(targetObject);

    if (intersects.length > 0) {
      const intersection = intersects[0];
      return {
        point: intersection.point.clone(),
        normal: intersection.face?.normal.clone() || new Vector3(0, 0, 1),
        face: intersection.face,
      };
    }

    return null;
  };

  // world to canvas coords
  const worldToCanvasCoords = (worldPoint: Vector3, returnType: 'canvas' | 'normalized' | 'imageCoords' = 'canvas'): { x: number; y: number } | null => {
    if (!mesh.value || !boundingBox.value) return null;

    const bb = boundingBox.value;
    const meshScale = mesh.value.scale;

    const objSizeX = (bb.max.x - bb.min.x) * meshScale.x;
    const objSizeY = (bb.max.y - bb.min.y) * meshScale.y;

    const normalizedX = (worldPoint.x + objSizeX / 2) / objSizeX;
    const normalizedY = 1 - (worldPoint.y + objSizeY / 2) / objSizeY;

    const clampedNormalizedX = Math.max(0, Math.min(1, normalizedX));
    const clampedNormalizedY = Math.max(0, Math.min(1, normalizedY));

    if (returnType === 'normalized') {
      return { x: clampedNormalizedX, y: clampedNormalizedY };
    }

    if (returnType === 'imageCoords') {
      if (!heightMap.value) return null;
      const objSizeX = bb.max.x - bb.min.x;
      const objSizeY = bb.max.y - bb.min.y;
      const intersection = worldPoint;
      const xCoord = (intersection.x + objSizeX / 2) / objSizeX;
      const yCoord = 1 - (intersection.y + objSizeY / 2) / objSizeY;
      return { x: xCoord, y: yCoord };
    }

    if (!surfaceCanvas.value || !camera.value || !canvasElement.value) return null;

    const totalScale = getScalingFactors().totalScale;
    const surfaceDisplayWidth = surfaceCanvasSize.value.width / totalScale;
    const surfaceDisplayHeight = surfaceCanvasSize.value.height / totalScale;

    const canvasX = clampedNormalizedX * (surfaceDisplayWidth - 1);
    const canvasY = clampedNormalizedY * (surfaceDisplayHeight - 1);

    let calibratedX = canvasX;
    let calibratedY = canvasY;

    if (coordinateCalibration.value.enabled) {
      calibratedX = (canvasX + coordinateCalibration.value.offsetX) * coordinateCalibration.value.scaleX;
      calibratedY = (canvasY + coordinateCalibration.value.offsetY) * coordinateCalibration.value.scaleY;
    }

    const resultX = Math.max(0, Math.min(surfaceDisplayWidth - 1, calibratedX));
    const resultY = Math.max(0, Math.min(surfaceDisplayHeight - 1, calibratedY));

    return { x: resultX, y: resultY };
  };

  // 在Canvas上绘制多边形
  const drawPolygonOnSurface = (
    points: Vector3[],
    color: string,
    opacity: number,
    shouldClose: boolean = true,
    updateTexture: boolean = true,
    isSubtract: boolean = false,
  ) => {
    if (!surfaceContext.value || !surfaceCanvas.value || points.length < 2) {
      return;
    }
    const canvasPoints = points.map((point) => worldToCanvasCoords(point)).filter((p) => p !== null);
    if (canvasPoints.length < 2) {
      return;
    }
    const ctx = surfaceContext.value;
    ctx.save();
    const finalColor = isSubtract ? SUBTRACT_RGB : color;
    setupCanvasContext(ctx, {
      strokeStyle: finalColor,
      fillStyle: finalColor,
      globalAlpha: opacity,
    });
    // Subtract only when closed; keep preview/open lines visible
    ctx.globalCompositeOperation = isSubtract && shouldClose ? 'destination-out' : 'source-over';

    ctx.beginPath();
    const startPoint = canvasPoints[0];
    ctx.moveTo(startPoint.x, startPoint.y);

    for (let i = 1; i < canvasPoints.length; i++) {
      const point = canvasPoints[i];
      ctx.lineTo(point.x, point.y);
    }

    if (shouldClose && canvasPoints.length >= 3) {
      ctx.closePath();
      ctx.fill();
    }

    ctx.stroke();
    ctx.restore();

    updateSurfaceTexture(updateTexture);
  };

  const canvasCoordsToWorld = (canvasX: number, canvasY: number): Vector3 | null => {
    if (!mesh.value || !boundingBox.value || !surfaceCanvas.value) return null;

    const totalScale = getScalingFactors().totalScale;
    const surfaceDisplayWidth = surfaceCanvasSize.value.width / totalScale;
    const surfaceDisplayHeight = surfaceCanvasSize.value.height / totalScale;

    let decalibratedX = canvasX;
    let decalibratedY = canvasY;

    if (coordinateCalibration.value.enabled) {
      decalibratedX = canvasX / coordinateCalibration.value.scaleX - coordinateCalibration.value.offsetX;
      decalibratedY = canvasY / coordinateCalibration.value.scaleY - coordinateCalibration.value.offsetY;
    }

    // range from 0 to 1
    const normalizedX = decalibratedX / (surfaceDisplayWidth - 1);
    const normalizedY = decalibratedY / (surfaceDisplayHeight - 1);

    const clampedNormalizedX = Math.max(0, Math.min(1, normalizedX));
    const clampedNormalizedY = Math.max(0, Math.min(1, normalizedY));

    // range from world coordinates to canvas coordinates
    const bb = boundingBox.value;
    const meshScale = mesh.value.scale;

    const objSizeX = (bb.max.x - bb.min.x) * meshScale.x;
    const objSizeY = (bb.max.y - bb.min.y) * meshScale.y;

    const worldX = clampedNormalizedX * objSizeX - objSizeX / 2;
    const worldY = (1 - clampedNormalizedY) * objSizeY - objSizeY / 2;

    let worldZ = 0;
    if (heightMap.value) {
      const geometry = mesh.value.geometry as BufferGeometry;
      const positions = geometry.attributes.position;
      const totalVertices = positions.count;
      const width = Math.sqrt(totalVertices);

      const col = clampedNormalizedX * (width - 1);
      const row = clampedNormalizedY * (width - 1);

      worldZ = getBilinearInterpolatedHeight(col, row, width);
    }

    return new Vector3(worldX, worldY, worldZ);
  };

  // preview line on the surface canvas
  const drawPreviewLineOnSurface = (startPoint: Vector3, endPoint: Vector3, color: string, isSubtract: boolean = false) => {
    if (!surfaceContext.value || !surfaceCanvas.value) return;

    const startCanvas = worldToCanvasCoords(startPoint);
    const endCanvas = worldToCanvasCoords(endPoint);

    if (!startCanvas || !endCanvas) return;

    const ctx = surfaceContext.value;
    ctx.save();
    const finalColor = isSubtract ? SUBTRACT_RGB : color;
    setupCanvasContext(ctx, {
      strokeStyle: finalColor,
      globalAlpha: 1,
    });

    ctx.beginPath();
    ctx.moveTo(startCanvas.x, startCanvas.y);
    ctx.lineTo(endCanvas.x, endCanvas.y);
    ctx.stroke();

    ctx.restore();
    updateSurfaceTexture();
  };

  // draw single mark on the surface canvas
  const drawSingleMark = (canvasX: number, canvasY: number, pos: AutoLabelPos) => {
    if (!surfaceContext.value) return;

    const ctx = surfaceContext.value;
    ctx.save();

    const markSize = 2;
    ctx.lineWidth = 1;
    ctx.strokeStyle = pos === AutoLabelPos.Positive ? '#00ff00' : '#ff0000';

    ctx.beginPath();
    ctx.moveTo(canvasX - markSize, canvasY);
    ctx.lineTo(canvasX + markSize, canvasY);

    if (pos === AutoLabelPos.Positive) {
      ctx.moveTo(canvasX, canvasY - markSize);
      ctx.lineTo(canvasX, canvasY + markSize);
    }

    ctx.stroke();
    ctx.restore();
  };

  // redraw all marks on the surface canvas
  const redrawAllMarks = () => {
    autoLabelMarkLines.value.forEach((mark) => {
      const canvasCoords = worldToCanvasCoords(mark.worldPoint, 'canvas');
      if (canvasCoords) {
        drawSingleMark(canvasCoords.x, canvasCoords.y, mark.pos);
      }
    });
  };

  // draw auto label mark on the surface canvas
  const drawMarkOnSurface = (worldPoint: Vector3, pos: AutoLabelPos) => {
    if (!surfaceContext.value) return;

    const canvasCoords = worldToCanvasCoords(worldPoint, 'canvas');
    if (!canvasCoords) return;

    addRenderTask(() => {
      drawSingleMark(canvasCoords.x, canvasCoords.y, pos);
      autoLabelMarkLines.value.push({ worldPoint: worldPoint.clone(), pos });
      updateSurfaceTexture(true);
    });
  };

  // clear the surface canvas
  const clearSurfaceCanvas = () => {
    if (!surfaceContext.value || !surfaceCanvas.value) return;

    const ctx = surfaceContext.value;
    const totalScale = getScalingFactors().totalScale;
    const displayWidth = surfaceCanvasSize.value.width / totalScale;
    const displayHeight = surfaceCanvasSize.value.height / totalScale;

    ctx.clearRect(0, 0, displayWidth, displayHeight);
    updateSurfaceTexture();
  };

  let _hasRedrawnThisRAF = false;

  // redraw all labels on the surface canvas
  const redrawAllLabelsOnSurface = (highlightIndex: number = -1, currentFeatureParam?: Feature) => {
    if (_hasRedrawnThisRAF) return;
    _hasRedrawnThisRAF = true;

    requestAnimationFrame(() => {
      _hasRedrawnThisRAF = false;
    });
    if (!surfaceContext.value) return;
    if (!showLabel.value && !showMask.value) {
      resetAllVertexColors();
      return;
    }
    const ctx = surfaceContext.value;
    const totalScale = getScalingFactors().totalScale;
    let renderLabelPoints = savedLabelPoints.value;
    const displayWidth = surfaceCanvasSize.value.width / totalScale;
    const displayHeight = surfaceCanvasSize.value.height / totalScale;
    ctx.clearRect(0, 0, displayWidth, displayHeight);

    if (isAutoLabeling.value) {
      renderLabelPoints = [...savedLabelPoints.value, ...cacheAutoLabel.value];
    }
    if (showMask.value) {
      renderLabelPoints = inferenceResultContours.value.map((item) => ({
        ...item,
        points: normalizeContours(item.points),
      })) as unknown as LabelPoint3D[];
      console.info('renderLabelPoints', renderLabelPoints, inferenceResultContours.value);
    }

    resetAllVertexColors();

    renderLabelPoints.forEach((label, index) => {
      if (label.feature) {
        const colorToUse = getColorToUse(label as LabelPoint3D, index, highlightIndex);
        if (label.points) {
          const worldPositions = label.points
            .map((point) => imageCoordinatesToCanvasCoords(point.x, point.y))
            .filter((p) => p !== null)
            .map((p) => canvasCoordsToWorld(p.x, p.y));
          // draw the polygon on the surface canvas, use the optimized vertex coloring
          applyVertexColoringOptimized({
            worldPositions,
            feature: label.feature,
            isSubtract: label.isSubtract,
            index,
            highlightIndex,
            colorToUse,
            label: label as LabelPoint3D,
          });
        }
        // draw the polygon on the surface canvas, use the canvas coords to world coords
        // if (label.worldPositions) {
        //     drawPolygonOnSurface(label.worldPositions, colorToUse, 1, true, false, label.isSubtract)
        // } else if (label.points) {
        //     drawImagePolygonOnSurface(label.points, colorToUse, 1, true, false, label.isSubtract)
        // }
      }
    });

    // redraw the current drawing state
    if (isDrawing.value && currentPoints.value && currentPoints.value.length > 0) {
      const featureToUse = currentFeatureParam || (savedLabelPoints.value.length > 0 ? savedLabelPoints.value[0].feature : null);
      if (featureToUse) {
        drawPolygonOnSurface(currentPoints.value, featureToUse.color, 1, false, false, labelConfig.isSubtract);
      }
    }

    // redraw the preview line
    if (previewPoints.value.length === 2 && (currentFeatureParam || (savedLabelPoints.value.length > 0 && savedLabelPoints.value[0].feature))) {
      const featureToUse = currentFeatureParam || savedLabelPoints.value[0].feature;
      if (featureToUse) {
        drawPreviewLineOnSurface(previewPoints.value[0], previewPoints.value[1], featureToUse.color, labelConfig.isSubtract);
      }
    }

    // draw auto label mark on the surface canvas
    redrawAllMarks();

    updateSurfaceTexture(true);
  };
  const getColorToUse = (label: LabelPoint3D, index: number, highlightIndex: number) => {
    const baseColor = label.feature.color;
    let colorToUse = baseColor;
    if (highlightIndex >= 0) {
      // when hover, adjust the brightness of the label
      colorToUse = index === highlightIndex ? adjustHexBrightness(baseColor, -10) : adjustHexBrightness(baseColor, -30);
    }
    return colorToUse;
  };

  // handle mouse event with raycast
  const handleMouseEventWithRaycast = (mouseX: number, mouseY: number) => {
    if (isCameraMoving.value) {
      return null;
    }

    const raycastResult = performEnhancedRaycast(mouseX, mouseY);
    if (raycastResult) {
      updateLastMouseIntersection(raycastResult.point);
      return raycastResult.point;
    }

    return null;
  };

  // update the last mouse intersection
  const updateLastMouseIntersection = (worldPoint: Vector3) => {
    lastMouseIntersection.value = worldPoint.clone();

    if (!isDrawing.value && !hoverDisabled.value) {
      checkHoverOnLabels(worldPoint);
    } else {
      clearHover();
    }
  };

  // check if the mouse is hovering on the label
  const checkHoverOnLabels = (worldPoint: Vector3) => {
    if (!mesh.value || savedLabelPoints.value.length === 0) {
      clearHover();
      return;
    }

    const labelIndex = getLabelAtPosition(worldPoint);

    if (labelIndex >= 0) {
      if (hoveredLabelIndex.value !== labelIndex) {
        if (_pendingHoverRender) return;
        _pendingHoverRender = true;
        hoveredLabelIndex.value = labelIndex;
        isHovering.value = true;
        requestAnimationFrame(() => {
          _pendingHoverRender = false;
          redrawAllLabelsOnSurface(labelIndex);
          updateSurfaceTexture(true);
        });
      }
    } else {
      clearHover();
    }
  };

  // one frame only
  let _pendingHoverRender = false;

  // clear hover effect
  const clearHover = () => {
    if (!isHovering.value) {
      hoveredLabelIndex.value = -1;
      return;
    }

    hoveredLabelIndex.value = -1;
    isHovering.value = false;

    addRenderTask(() => {
      redrawAllLabelsOnSurface();
    });
  };

  // handle click event with raycast
  const handleClickWithRaycast = (mouseX: number, mouseY: number, feature: Feature, imageId?: number, isSubtract: boolean = false, button?: string) => {
    if (isCameraMoving.value) {
      return false;
    }

    labelConfig.isSubtract = isSubtract;
    labelConfig.isTwoFiveD = true;
    const surfacePoint = handleMouseEventWithRaycast(mouseX, mouseY);
    if (!surfacePoint) {
      return false;
    }

    if (polygonType3D.value === PolygonType3D.AUTO_LABEL && imageId) {
      if (isDrawing.value) {
        addPointToPolygon(surfacePoint, feature);
      } else {
        const positive = button === 'left' ? AutoLabelPos.Positive : AutoLabelPos.Negative;
        autoLabel3D(surfacePoint, positive, imageId, feature, labelingImageType.value);
      }
    } else if (polygonType3D.value === PolygonType3D.NONE) {
      if (!isDrawing.value) {
        startPolygonDrawing();
      }
      addPointToPolygon(surfacePoint, feature);
    }

    return true;
  };

  // simulate click at the last mouse position
  const simulateClickAtLastMousePosition = (feature: Feature, imageId: number, _isSubtract: boolean = false) => {
    if (!lastMouseIntersection.value) {
      return false;
    }

    if (polygonType3D.value === PolygonType3D.AUTO_LABEL && imageId) {
      if (isDrawing.value) {
        addPointToPolygon(lastMouseIntersection.value, feature);
      } else {
        const positive = AutoLabelPos.Positive;
        autoLabel3D(lastMouseIntersection.value, positive, imageId, feature, labelingImageType.value);
      }
    } else if (polygonType3D.value === PolygonType3D.NONE) {
      if (!isDrawing.value) {
        startPolygonDrawing();
      }
      addPointToPolygon(lastMouseIntersection.value, feature);
    }

    return true;
  };

  // start polygon drawing
  const startPolygonDrawing = () => {
    if (!drawingGroup.value) return;

    isDrawing.value = true;
    currentPoints.value = [];
    previewPoints.value = [];

    if (!surfaceContext.value || !surfaceCanvas.value) {
      console.error('Canvas rendering system not ready');
      return;
    }
  };

  // add point to the current polygon
  const addPointToPolygon = (worldPoint: Vector3, feature: Feature) => {
    if (!isDrawing.value) return;

    currentPoints.value.push(worldPoint.clone());

    addRenderTask(() => {
      if (!surfaceContext.value || !surfaceCanvas.value) {
        return;
      }

      redrawAllLabelsOnSurface(-1, feature);
    });
  };

  // update the preview line with raycast
  const updatePreviewLineWithRaycast = (mouseX: number, mouseY: number, feature?: Feature) => {
    if (isCameraMoving.value) {
      return;
    }

    const surfacePoint = handleMouseEventWithRaycast(mouseX, mouseY);
    if (surfacePoint) {
      updatePreviewLine(surfacePoint, feature);
    }
  };

  // preview line drawing throttle: only redraw once per frame
  let _pendingPreviewRender = false;

  const updatePreviewLine = (worldPoint: Vector3, feature?: Feature) => {
    updateLastMouseIntersection(worldPoint);

    if (!isDrawing.value || currentPoints.value.length === 0) return;

    previewWorldPoint.value = worldPoint.clone();
    previewPoints.value = [currentPoints.value[currentPoints.value.length - 1], worldPoint];

    if (_pendingPreviewRender) return;
    _pendingPreviewRender = true;

    requestAnimationFrame(() => {
      _pendingPreviewRender = false;
      redrawAllLabelsOnSurface(-1, feature);
    });
  };

  // clear the preview line
  const clearPreviewLine = () => {
    previewPoints.value = [];
    previewWorldPoint.value = null;
    isDrawing.value = false;
  };

  // finish polygon drawing
  const finishPolygonDrawing = (feature: Feature, isSubtract: boolean = false, polygonType: PolygonType3D) => {
    if (isAutoLabeling.value && polygonType === PolygonType3D.AUTO_LABEL) {
      labelPoints3D.push(...(cacheAutoLabel.value as LabelPoint3D[]));
      cleanupMarkLines();
      isAutoLabeling.value = false;
      isDrawing.value = false;
      InferApi.finishAutoLabel();
      cacheAutoLabel.value = [];
      return;
    }
    if (!isDrawing.value || currentPoints.value.length < 3) return;

    const points2D = worldPointToImageCoords(currentPoints.value);

    const newLabel: LabelPoint3D = {
      id: new Date().getTime(),
      points: points2D,
      mesh: null,
      labelShapeType: LabelShapeType.POLYGON,
      isSubtract: isSubtract,
      isCache: true,
      worldPositions: currentPoints.value,
      feature: feature,
      isAutoLabel: false,
    };
    labelPoints3D.push(newLabel);

    addRenderTask(() => {
      redrawAllLabelsOnSurface(-1, feature);
    });

    currentPoints.value = [];
    previewPoints.value = [];
    isDrawing.value = false;

    hoverDisabled.value = true;
    clearHover();

    setTimeout(() => {
      hoverDisabled.value = false;
    }, 100);
  };

  // optimized point in polygon detection
  // Helper used by winding-number algorithm
  const _isLeft = (xi: number, yi: number, xj: number, yj: number, xk: number, yk: number) => {
    return (xj - xi) * (yk - yi) - (xk - xi) * (yj - yi);
  };

  // Winding-number algorithm: robust for self-intersecting polygons (spirals etc.)
  const isPointInPolygonOptimized = (point: { x: number; y: number }, polygon: { x: number; y: number }[]): boolean => {
    let wn = 0;
    const x = point.x;
    const y = point.y;

    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i].x;
      const yi = polygon[i].y;
      const xj = polygon[j].x;
      const yj = polygon[j].y;

      if (yi <= y) {
        // upward crossing
        if (yj > y && _isLeft(xi, yi, xj, yj, x, y) > 0) {
          wn++;
        }
      } else {
        // downward crossing
        if (yj <= y && _isLeft(xi, yi, xj, yj, x, y) < 0) {
          wn--;
        }
      }
    }
    return wn !== 0;
  };

  // auto labeling function
  const autoLabel3D = async (worldPoint: Vector3, pos: AutoLabelPos, imageId: number, feature: Feature, ImageType: TwoFiveDImageType) => {
    labelingImageType.value = ImageType;
    if (!mesh.value || !drawingGroup.value || !imageId) return;
    if (isDrawing.value) {
      return;
    }

    if (isAutoLabeling.value) {
      cancelAutoLabel();
    }

    if (autoLabelDebounceTimer) {
      clearTimeout(autoLabelDebounceTimer);
    }

    return new Promise<void>((resolve) => {
      autoLabelDebounceTimer = setTimeout(async () => {
        await performAutoLabel(worldPoint, pos, imageId, feature, ImageType);
        resolve();
      }, 150);
    });
  };

  // bilinear interpolation height calculation
  const getBilinearInterpolatedHeight = (col: number, row: number, width: number): number => {
    if (!heightMap.value) return 0;

    const col0 = Math.floor(col);
    const col1 = Math.min(col0 + 1, width - 1);
    const row0 = Math.floor(row);
    const row1 = Math.min(row0 + 1, width - 1);

    if (col0 < 0 || col1 >= width || row0 < 0 || row1 >= width) {
      const safeCol = Math.max(0, Math.min(width - 1, Math.floor(col)));
      const safeRow = Math.max(0, Math.min(width - 1, Math.floor(row)));
      return heightMap.value[safeRow * width + safeCol] || 0;
    }

    const h00 = heightMap.value[row0 * width + col0] || 0;
    const h10 = heightMap.value[row0 * width + col1] || 0;
    const h01 = heightMap.value[row1 * width + col0] || 0;
    const h11 = heightMap.value[row1 * width + col1] || 0;

    const fx = col - col0;
    const fy = row - row0;

    const h0 = h00 * (1 - fx) + h10 * fx;
    const h1 = h01 * (1 - fx) + h11 * fx;
    const height = h0 * (1 - fy) + h1 * fy;

    return height;
  };

  // perform auto labeling core logic
  const performAutoLabel = async (worldPoint: Vector3, pos: AutoLabelPos, imageId: number, feature: Feature, ImageType: TwoFiveDImageType) => {
    isAutoLabeling.value = true;
    autoLabelController.value = new AbortController();

    try {
      const imageCoords = worldToCanvasCoords(worldPoint, 'imageCoords');

      if (!imageCoords) {
        return;
      }

      // draw mark point
      drawMarkOnSurface(worldPoint, pos);

      // clearPreviousAutoLabels()

      const res = await InferApi.autoLabel(imageId, imageCoords.x, imageCoords.y, pos, ImageType);

      if (autoLabelController.value?.signal.aborted) {
        return;
      }

      // handle returned contour data
      if (res.data.contours && res.data.contours.length > 0) {
        handleAutoLabelResult(res.data.contours as number[][][], feature);
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        console.log('auto labeling request cancelled');
      } else {
        console.error('3D auto labeling failed:', error);
      }
    } finally {
      autoLabelController.value = null;
    }
  };

  const handleAutoLabelResult = (contours: number[][][], feature: Feature) => {
    const allImagePoints: Point[][] = [];

    const mergeAdjacentPoints = (points: Point[], threshold = 0.001): Point[] => {
      if (points.length < 2) return points;
      const merged: Point[] = [points[0]];
      for (let i = 1; i < points.length; i++) {
        const prev = merged[merged.length - 1];
        const curr = points[i];
        const dx = curr.x - prev.x;
        const dy = curr.y - prev.y;
        if (dx * dx + dy * dy >= threshold * threshold) {
          merged.push(curr);
        }
      }

      if (merged.length >= 3) {
        const first = merged[0];
        const last = merged[merged.length - 1];
        const dx = first.x - last.x;
        const dy = first.y - last.y;
        if (dx * dx + dy * dy < threshold * threshold) {
          merged.pop();
        }
      }
      return merged;
    };

    for (const contour of contours) {
      const originalPoints = contour.map((point) => ({ x: point[0], y: point[1] }));
      let imagePoints = mergeAdjacentPoints(originalPoints);
      if (imagePoints.length < 3) {
        imagePoints = originalPoints;
      }
      if (imagePoints.length > 2) {
        allImagePoints.push(imagePoints);
      }
    }

    if (autoLabelController.value?.signal.aborted) {
      return;
    }
    const newLabels: LabelPoint3D[] = [];

    for (let i = 0; i < allImagePoints.length; i++) {
      const newLabel: LabelPoint3D = {
        id: Date.now() + i,
        points: allImagePoints[i],
        mesh: null,
        labelShapeType: LabelShapeType.POLYGON,
        isSubtract: labelConfig.isSubtract,
        isCache: true,
        worldPositions: allImagePoints[i]
          .map((point) => imageCoordinatesToCanvasCoords(point.x, point.y))
          .filter((p) => p !== null)
          .map((p) => canvasCoordsToWorld(p.x, p.y)),
        feature: feature,
        isAutoLabel: true,
      };

      newLabels.push(newLabel);
    }
    cacheAutoLabel.value = newLabels;

    addRenderTask(() => {
      redrawAllLabelsOnSurface(-1, feature);
    });
  };

  // clear previous auto labels
  const clearPreviousAutoLabels = () => {
    const autoLabelIndices: number[] = [];
    savedLabelPoints.value.forEach((label, index) => {
      if (label.isAutoLabel) {
        autoLabelIndices.push(index);
      }
    });

    for (let i = autoLabelIndices.length - 1; i >= 0; i--) {
      savedLabelPoints.value.splice(autoLabelIndices[i], 1);
    }

    for (let i = labelPoints3D.length - 1; i >= 0; i--) {
      if (labelPoints3D[i].isAutoLabel) {
        labelPoints3D.splice(i, 1);
      }
    }

    if (autoLabelIndices.length > 0) {
      renderAllLabels();
    }
  };

  // cleanup all marks
  const cleanupMarkLines = () => {
    autoLabelMarkLines.value = [];
    addRenderTask(() => {
      redrawAllLabelsOnSurface(-1);
    });
  };

  // undo last mark
  const undoLastAutoLabelMark = () => {
    if (autoLabelMarkLines.value.length === 0) return;
    autoLabelMarkLines.value.pop();
    addRenderTask(() => {
      redrawAllLabelsOnSurface(-1);
      redrawAllMarks();
      updateSurfaceTexture(true);
    });
  };

  // world coordinates to image coordinates
  const worldPointToImageCoords = (worldPoint: Vector3[]): Point[] => {
    return worldPoint.map((point) => {
      const canvasCoords = worldToCanvasCoords(point, 'normalized');
      return canvasCoords ? { x: canvasCoords.x, y: canvasCoords.y } : { x: 0, y: 0 };
    });
  };

  // 3D world coordinates to 2D points
  const worldPointsTo2D = (worldPoints: Vector3[]): Point[] => {
    return worldPoints.map((point) => {
      const canvasCoords = worldToCanvasCoords(point, 'canvas');
      return canvasCoords ? { x: canvasCoords.x, y: canvasCoords.y } : { x: 0, y: 0 };
    });
  };

  // re-render all labels
  const renderAllLabels = () => {
    clearHover();

    addRenderTask(() => {
      redrawAllLabelsOnSurface(-1);
    });
  };

  // update parent component reference
  const updateRefInParent = ({ savedLabelPointsNewVal }: { savedLabelPointsNewVal: LabelPoint3D[] | FeatureImageLabelShape[] }) => {
    savedLabelPoints.value = savedLabelPointsNewVal.map((label) => {
      label.feature = label.feature || (label as FeatureImageLabelShape).imageFeature?.feature;

      const labelPoint3D = label as LabelPoint3D;

      labelPoint3D.worldPositions = labelPoint3D.worldPositions || null;

      return label;
    });
  };

  // delete label
  const deleteLabel3D = (labelIndex: number) => {
    if (labelIndex >= 0 && labelIndex < savedLabelPoints.value.length) {
      savedLabelPoints.value.splice(labelIndex, 1);
    }
  };

  // reset all vertex colors to original colors
  const resetAllVertexColors = () => {
    if (!mesh.value || !originalColors.value) return;
    const geometry = mesh.value.geometry as BufferGeometry;
    const colorsAttr = geometry.attributes.color;
    if (!colorsAttr) return;

    // 如果本次绘制没有修改过任何顶点，则无需执行 GPU 更新
    if (affectedVertices.value.size === 0) return;

    const colorArray = colorsAttr.array as Float32Array;
    affectedVertices.value.forEach((idx) => {
      const i = idx * 3;
      colorArray[i] = originalColors.value[i];
      colorArray[i + 1] = originalColors.value[i + 1];
      colorArray[i + 2] = originalColors.value[i + 2];
    });

    colorsAttr.needsUpdate = true;
    affectedVertices.value.clear();
  };

  // clear all labels
  const clearAllLabels3D = () => {
    clearHover();
    savedLabelPoints.value = [];

    resetAllVertexColors();

    addRenderTask(() => {
      clearSurfaceCanvas();
    });
  };

  // set camera reference
  const setCamera = (_camera: Camera) => {
    camera.value = markRaw(_camera);
    setupCameraMovementDetection();
  };

  // set canvas element reference
  const setCanvasElement = (canvas: HTMLCanvasElement | null) => {
    if (canvasElement.value && (canvasElement.value as CanvasWithResize)._resizeHandler) {
      window.removeEventListener('canvasResized', (canvasElement.value as CanvasWithResize)._resizeHandler!);
      delete (canvasElement.value as CanvasWithResize)._resizeHandler;
    }

    canvasElement.value = canvas;
    if (canvas) {
      const handleCanvasResize: EventListener = () => {
        if (isDrawing.value) return;

        if (!isDrawing.value) {
          setTimeout(() => {
            if (!isDrawing.value) {
              // recalculate or calibrate coordinates
            }
          }, 100);
        }
      };

      window.addEventListener('canvasResized', handleCanvasResize as EventListener);
      (canvas as CanvasWithResize)._resizeHandler = handleCanvasResize;
    }
  };

  // set camera movement detection
  const setupCameraMovementDetection = () => {
    if (!camera.value) return;

    // cancel old RAF loop
    if (cameraMovementFrameId.value !== null) {
      cancelAnimationFrame(cameraMovementFrameId.value);
      cameraMovementFrameId.value = null;
    }

    lastCameraPosition.value = camera.value.position.clone();
    lastCameraRotation.value = {
      x: camera.value.rotation.x,
      y: camera.value.rotation.y,
      z: camera.value.rotation.z,
    };
    lastCameraDistance.value = camera.value.position.distanceTo(new Vector3(0, 0, 0));

    const monitor = () => {
      if (!camera.value || !lastCameraPosition.value || !lastCameraRotation.value) {
        cameraMovementFrameId.value = requestAnimationFrame(monitor);
        return;
      }

      const currentPosition = camera.value.position;
      const currentRotation = camera.value.rotation;
      const currentDistance = camera.value.position.distanceTo(new Vector3(0, 0, 0));

      const positionChanged =
        Math.abs(currentPosition.x - lastCameraPosition.value.x) > 0.01 ||
        Math.abs(currentPosition.y - lastCameraPosition.value.y) > 0.01 ||
        Math.abs(currentPosition.z - lastCameraPosition.value.z) > 0.01;

      const rotationChanged =
        Math.abs(currentRotation.x - lastCameraRotation.value.x) > 0.01 ||
        Math.abs(currentRotation.y - lastCameraRotation.value.y) > 0.01 ||
        Math.abs(currentRotation.z - lastCameraRotation.value.z) > 0.01;

      const distanceChanged = Math.abs(currentDistance - lastCameraDistance.value) > 5.0;

      isCameraMoving.value = positionChanged || rotationChanged || distanceChanged;

      lastCameraPosition.value.copy(currentPosition);
      lastCameraRotation.value = {
        x: currentRotation.x,
        y: currentRotation.y,
        z: currentRotation.z,
      };
      lastCameraDistance.value = currentDistance;

      cameraMovementFrameId.value = requestAnimationFrame(monitor);
    };

    monitor();
  };

  // exit current drawing and clear lines
  const cancelCurrentDrawing = () => {
    if (!isDrawing.value) return;

    isDrawing.value = false;
    currentPoints.value = [];
    previewPoints.value = [];

    hoverDisabled.value = true;
    clearHover();

    addRenderTask(() => {
      redrawAllLabelsOnSurface(-1);
    });

    setTimeout(() => {
      hoverDisabled.value = false;
    }, 100);
  };

  // check if click position is in existing labels
  const getLabelAtPosition = (worldPoint: Vector3): number => {
    for (let i = 0; i < savedLabelPoints.value.length; i++) {
      const label = savedLabelPoints.value[i];

      if (label.worldPositions && label.worldPositions.length > 2) {
        const polygon2D = label.worldPositions.map((p) => ({ x: p.x, y: p.y }));
        const testPoint = { x: worldPoint.x, y: worldPoint.y };

        if (isPointInPolygonOptimized(testPoint, polygon2D)) {
          return i;
        }
      } else if (label.points && label.points.length > 2) {
        const worldImageCoords = worldToCanvasCoords(worldPoint, 'imageCoords');
        if (worldImageCoords) {
          const polygon2D = label.points.map((p) => ({ x: p.x, y: p.y }));
          const testPoint = { x: worldImageCoords.x, y: worldImageCoords.y };

          if (isPointInPolygonOptimized(testPoint, polygon2D)) {
            return i;
          }
        }
      }
    }
    return -1;
  };

  // cancel rendering of specified label
  const cancelLabelRendering = async (labelIndex: number) => {
    if (labelIndex < 0 || labelIndex >= savedLabelPoints.value.length) return;
    const label = savedLabelPoints.value[labelIndex];
    emit('onDeleteShape', label);
  };

  // handle right click
  const handleRightClick = (worldPoint: Vector3): boolean => {
    clearHover();

    if (isDrawing.value) {
      if (currentPoints.value.length >= 3) {
        return false;
      } else {
        cancelCurrentDrawing();
        return true;
      }
    }

    // check if click is on existing labels
    const labelIndex = getLabelAtPosition(worldPoint);
    if (labelIndex >= 0) {
      cancelLabelRendering(labelIndex);
      return true;
    }

    return false;
  };

  // undo function in 3D mode
  const undoLatestShape3D = () => {
    if (isDrawing.value) {
      if (currentPoints.value && currentPoints.value.length > 0) {
        currentPoints.value.pop();
        if (currentPoints.value.length === 0) cancelCurrentDrawing();
      }
      return;
    }

    if (isAutoLabeling.value && autoLabelMarkLines.value.length >= 0) {
      InferApi.undoAutoLabel().then((res) => {
        autoLabelMarkLines.value.pop();
        addRenderTask(() => {
          redrawAllMarks();
        });
        if (autoLabelMarkLines.value.length === 0) {
          cleanupMarkLines();
        }
        handleAutoLabelResult(res.data.contours as number[][][], featureInfo);

        if (!res.data.contours || res.data.contours.length === 0) {
          // All auto-label strokes have been undone – reset status completely

          isAutoLabeling.value = false;
          InferApi.autoLabelReset(imageId);
          InferApi.cleanupAutoLabeller()
            .then(() => {
              console.info('cleanup auto labeller success');
            })
            .catch((e) => {
              console.error(e);
            });
        }
      });
      return;
    }

    // undo last completed label
    if (savedLabelPoints.value.length > 0 && !isAutoLabeling.value && !isDrawing.value) {
      console.log('undoLatestShape3D1', savedLabelPoints.value);
      const lastShape = savedLabelPoints.value.pop();
      emit('onDeleteShape', lastShape as unknown as FeatureImageLabelShape);
      if (lastShape) {
        currentPoints.value = lastShape.worldPositions || null;
        isDrawing.value = true;
      }
      return;
    }
  };

  // dispose resources
  const dispose = () => {
    clearHover();
    hoveredLabelIndex.value = -1;
    isHovering.value = false;
    hoverDisabled.value = false;

    if (surfaceCanvas.value) {
      const ctx = surfaceCanvas.value.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, surfaceCanvas.value.width, surfaceCanvas.value.height);
      }
    }

    if (surfaceTexture.value) {
      surfaceTexture.value.dispose();
    }

    savedLabelPoints.value = [];
    currentPoints.value = [];
    previewPoints.value = [];
    isDrawing.value = false;

    surfaceCanvas.value = null;
    surfaceTexture.value = null;
    surfaceContext.value = null;
    boundingBox.value = null;

    if (canvasElement.value && (canvasElement.value as CanvasWithResize)._resizeHandler) {
      window.removeEventListener('canvasResized', (canvasElement.value as CanvasWithResize)._resizeHandler!);
      delete (canvasElement.value as CanvasWithResize)._resizeHandler;
    }
    canvasElement.value = null;

    if (cameraMovementFrameId.value !== null) {
      cancelAnimationFrame(cameraMovementFrameId.value);
      cameraMovementFrameId.value = null;
    }
    isCameraMoving.value = false;
    lastCameraPosition.value = null;
    lastCameraRotation.value = null;
    lastCameraDistance.value = 0;
  };

  const cancelAutoLabel = () => {
    if (autoLabelController.value) {
      autoLabelController.value.abort();
      autoLabelController.value = null;
    }

    if (autoLabelDebounceTimer) {
      clearTimeout(autoLabelDebounceTimer);
      autoLabelDebounceTimer = null;
    }

    isAutoLabeling.value = false;
  };

  const calibrateCoordinates = (offsetX: number = 0, offsetY: number = 0, scaleX: number = 1, scaleY: number = 1) => {
    coordinateCalibration.value.offsetX = offsetX;
    coordinateCalibration.value.offsetY = offsetY;
    coordinateCalibration.value.scaleX = scaleX;
    coordinateCalibration.value.scaleY = scaleY;
  };

  // reset coordinate calibration
  const resetCalibration = () => {
    calibrateCoordinates(0, 0, 1, 1);
  };

  // image coordinates directly converted to canvas coordinates
  const imageCoordinatesToCanvasCoords = (x: number, y: number): { x: number; y: number } | null => {
    if (!surfaceCanvas.value) return null;

    const totalScale = getScalingFactors().totalScale;
    const surfaceDisplayWidth = surfaceCanvasSize.value.width / totalScale;
    const surfaceDisplayHeight = surfaceCanvasSize.value.height / totalScale;

    const canvasX = x * (surfaceDisplayWidth - 1);
    const canvasY = y * (surfaceDisplayHeight - 1);

    let calibratedX = canvasX;
    let calibratedY = canvasY;

    if (coordinateCalibration.value.enabled) {
      calibratedX = (canvasX + coordinateCalibration.value.offsetX) * coordinateCalibration.value.scaleX;
      calibratedY = (canvasY + coordinateCalibration.value.offsetY) * coordinateCalibration.value.scaleY;
    }

    const resultX = Math.max(0, Math.min(surfaceDisplayWidth - 1, calibratedX));
    const resultY = Math.max(0, Math.min(surfaceDisplayHeight - 1, calibratedY));

    return { x: resultX, y: resultY };
  };

  // draw image coordinates polygon directly on canvas
  const drawImagePolygonOnSurface = (
    imagePoints: Point[],
    color: string,
    opacity: number = 1,
    shouldClose: boolean = true,
    updateTexture: boolean = true,
    isSubtract: boolean = false,
  ) => {
    if (!surfaceContext.value || !surfaceCanvas.value || imagePoints.length < 2) {
      return;
    }

    const canvasPoints = imagePoints.map((point) => imageCoordinatesToCanvasCoords(point.x, point.y)).filter((p) => p !== null);
    if (canvasPoints.length < 2) {
      return;
    }

    const ctx = surfaceContext.value;
    ctx.save();
    const finalColor = isSubtract ? SUBTRACT_RGB : color;
    setupCanvasContext(ctx, {
      strokeStyle: finalColor,
      fillStyle: finalColor,
      globalAlpha: opacity,
    });

    ctx.globalCompositeOperation = isSubtract && shouldClose ? 'destination-out' : 'source-over';

    ctx.beginPath();
    const startPoint = canvasPoints[0];
    ctx.moveTo(startPoint.x, startPoint.y);

    for (let i = 1; i < canvasPoints.length; i++) {
      const point = canvasPoints[i];
      ctx.lineTo(point.x, point.y);
    }

    if (shouldClose && canvasPoints.length >= 3) {
      ctx.closePath();
      ctx.fill();
    }

    ctx.stroke();
    ctx.restore();

    if (updateTexture) {
      updateSurfaceTexture(true);
    }
  };

  // optimized point in polygon detection - use bounding box pre-filtering and spatial partitioning
  const getVerticesInPolygonOptimized = (worldPoints: Vector3[], geometry: BufferGeometry, _width: number, _height: number): number[] => {
    const startTime = performance.now();
    const positions = geometry.attributes.position;
    const affectedVertices: number[] = [];

    const polygon2D = worldPoints.map((p) => ({ x: p.x, y: p.y }));

    // calculate polygon bounding box for fast pre-filtering
    let minX = Infinity,
      maxX = -Infinity;
    let minY = Infinity,
      maxY = -Infinity;

    polygon2D.forEach((p) => {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    });

    const positionArray = positions.array as Float32Array;
    const vertexCount = positions.count;

    // use chunk processing to improve performance, but ensure all vertices are processed
    const chunkSize = Math.min(10000, Math.max(2000, Math.floor(vertexCount / 50)));
    let processedVertices = 0;
    let totalInBounds = 0;

    while (processedVertices < vertexCount) {
      const endVertex = Math.min(processedVertices + chunkSize, vertexCount);

      for (let i = processedVertices; i < endVertex; i++) {
        const x = positionArray[i * 3];
        const y = positionArray[i * 3 + 1];

        // bounding box pre-filtering
        if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
          totalInBounds++;
          // check if vertex is in polygon
          if (isPointInPolygonOptimized({ x, y }, polygon2D)) {
            affectedVertices.push(i);
          }
        }
      }

      processedVertices = endVertex;
    }

    const endTime = performance.now();
    console.log(
      `Vertex filtering done: total ${vertexCount}, in bbox ${totalInBounds}, in polygon ${affectedVertices.length}, ${(endTime - startTime).toFixed(2)}ms`,
    );

    return affectedVertices;
  };

  // helper function: hex color to RGB
  const hexToRgb = (hex: string): { r: number; g: number; b: number } => {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result
      ? {
          r: parseInt(result[1], 16) / 255,
          g: parseInt(result[2], 16) / 255,
          b: parseInt(result[3], 16) / 255,
        }
      : { r: 1, g: 1, b: 1 };
  };

  const applyVertexColoringOptimized = ({
    worldPositions,
    feature,
    isSubtract,
    index,
    highlightIndex,
    colorToUse,
    label,
  }: {
    worldPositions: Vector3[];
    feature: Feature;
    isSubtract: boolean;
    index: number;
    highlightIndex: number;
    colorToUse: string;
    label?: LabelPoint3D;
  }): Promise<void> => {
    return new Promise((resolve) => {
      (async () => {
      if (!mesh.value || !heightMap.value) {
        resolve();
        return;
      }

      const startTime = performance.now();
      const geometry = mesh.value.geometry as BufferGeometry;
      const positions = geometry.attributes.position;
      const colors = geometry.attributes.color;

      if (!colors) {
        resolve();
        return;
      }

      const totalVertices = positions.count;
      const width = Math.sqrt(totalVertices);

      let affectedVerticesInPolygon: Uint32Array | number[];
      if (label && label.vertexCache) {
        affectedVerticesInPolygon = label.vertexCache;
      } else {
        try {
          affectedVerticesInPolygon = await computeVerticesViaWorker(worldPositions);
        } catch (_e) {
          affectedVerticesInPolygon = getVerticesInPolygonOptimized(worldPositions, geometry, width, width);
          console.error(_e);
        }
        if (label) {
          label.vertexCache = new Uint32Array(affectedVerticesInPolygon);
        }
      }

      if (affectedVerticesInPolygon.length === 0) {
        resolve();
        return;
      }

      const targetColor = hexToRgb(colorToUse ?? feature.color);
      const colorArray = colors.array as Float32Array;
      const opacity = index === highlightIndex ? 0.5 : 1;

      for (const vertexIndex of affectedVerticesInPolygon) {
        affectedVertices.value.add(vertexIndex);
        const i = vertexIndex * 3;

        if (isSubtract) {
          if (originalColors.value) {
            colorArray[i] = originalColors.value[i];
            colorArray[i + 1] = originalColors.value[i + 1];
            colorArray[i + 2] = originalColors.value[i + 2];
          }
        } else {
          if (originalColors.value) {
            const originalR = originalColors.value[i];
            const originalG = originalColors.value[i + 1];
            const originalB = originalColors.value[i + 2];

            // use alpha blending formula: targetColor * opacity + originalColor * (1 - opacity)
            colorArray[i] = targetColor.r * opacity + originalR * (1 - opacity);
            colorArray[i + 1] = targetColor.g * opacity + originalG * (1 - opacity);
            colorArray[i + 2] = targetColor.b * opacity + originalB * (1 - opacity);
          } else {
            // if no original color, apply target color directly
            colorArray[i] = targetColor.r;
            colorArray[i + 1] = targetColor.g;
            colorArray[i + 2] = targetColor.b;
          }
        }
      }

      colors.needsUpdate = true;

      const endTime = performance.now();
      console.log(`Vertex coloring optimized: ${affectedVerticesInPolygon.length} vertices processed in ${(endTime - startTime).toFixed(2)}ms`);

      resolve();
    })();
  });
  };

  const updateInferenceResultContours = (contours: Contour[]) => {
    if (!contours || contours.length === 0) {
      inferenceResultContours.value = [];
      return;
    }

    const inferenceResultLabelPoint3D: LabelPoint3D = {
      id: 0,
      points: contours[0]?.contours.flat().map((item) => ({ x: item[0], y: item[1] })) as unknown as Point[],
      labelShapeType: LabelShapeType.POLYGON,
      feature: featureInfo,
      isSubtract: false,
    };
 
    inferenceResultContours.value = [inferenceResultLabelPoint3D];
    redrawAllLabelsOnSurface();
  };

  const normalizeContours = (points: Point[]) => {
    const { width: meshWidth, height: meshHeight } = meshArea.value || {
      width: 1,
      height: 1,
    };
    // Guard against division by zero
    const safeWidth = meshWidth === 0 ? 1 : meshWidth;
    const safeHeight = meshHeight === 0 ? 1 : meshHeight;

    const normalizedPoints = (points.map((item) => {
      const xNorm = item.x / safeWidth;
      const yNorm = item.y / safeHeight;
      return {
        x: Math.max(0, Math.min(1, xNorm)),
        y: Math.max(0, Math.min(1, yNorm)),
      } as Point;
    }) as unknown as Point[]) || [];

    return normalizedPoints;
  };

  return {
    // core initialization
    onLoadMesh,
    polygonType3D,
    labelPoints3D,

    // drawing state
    isDrawing,
    startPolygonDrawing,
    addPointToPolygon,
    finishPolygonDrawing,

    // auto labeling
    autoLabel3D,
    isAutoLabeling,
    cancelAutoLabel,

    // label management
    deleteLabel3D,
    clearAllLabels3D,
    updateRefInParent,

    // camera and canvas settings
    setCamera,
    setCanvasElement,

    // preview function
    updatePreviewLine,
    clearPreviewLine,

    // interaction events
    handleRightClick,
    cancelCurrentDrawing,
    undoLatestShape3D,
    updateLastMouseIntersection,
    simulateClickAtLastMousePosition,

    // raycasting function
    performEnhancedRaycast,
    performRaycast: performEnhancedRaycast,
    handleMouseEventWithRaycast,
    handleClickWithRaycast,
    updatePreviewLineWithRaycast,

    // surface rendering function
    createSurfaceCanvas,
    drawPolygonOnSurface,
    drawImagePolygonOnSurface,
    drawPreviewLineOnSurface,
    clearSurfaceCanvas,
    redrawAllLabelsOnSurface,
    applyVertexColoringOptimized,

    // surface rendering state
    surfaceCanvas,
    surfaceTexture,
    surfaceContext,

    // coordinate calibration
    calibrateCoordinates,
    resetCalibration,

    // camera movement detection
    isCameraMoving,
    setupCameraMovementDetection,

    // coordinate conversion
    worldPointsTo2D,
    canvasCoordsToWorld,
    imageCoordinatesToCanvasCoords,
    setLabelVisibility,
    updateInferenceResultContours,
    // resource cleanup
    dispose,

    // color synchronization
    refreshOriginalColors,

    // auto labeling mark operation
    undoLastAutoLabelMark,
    cleanupMarkLines,
    clearPreviousAutoLabels,
  };
};
