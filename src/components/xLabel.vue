<script setup lang="ts">
import { AutoLabelPos, Contour, InferApi } from '@/api/train/InferApi.ts';
import { onMounted, onUnmounted, ref, watch, computed, nextTick } from 'vue';
import Konva from 'konva';
import { LabelShapeType, Point } from '@/type/label.type.ts';
import { Vector2d } from 'konva/lib/types';
import { Feature } from '@/api/train/project.api.ts';
import { rgbToRgba } from '@/utils/color.util.ts';
import { convertToCoordinates, convertToPixelCoordinates } from '@/utils/location.util.ts';
import { DrawSegment, FeatureImage, FeatureImageLabelShape, LabelPoints, TwoFiveDImageType } from '@/api/train/train.api.ts';
import { DeleteOutlined, EyeInvisibleOutlined, EyeOutlined, EditOutlined } from '@ant-design/icons-vue';
import { I18N } from '@/utils/i18n.util.ts';
import { Shape, ShapeConfig } from 'konva/lib/Shape';
import v3d from '@/components/3d/3d.vue';
import { Scene, Mesh ,CanvasTexture } from 'three';
import { cloneDeep } from 'lodash';
import Layer = Konva.Layer;
import Stage = Konva.Stage;
import Line = Konva.Line;
import { useLabelingTwoFiveD, PolygonType3D, LabelPoint3D } from './3d/hook/useLabelingTwoFiveD';
import { PolygonType } from '@/api/trainDataset/trainDataset.api';
import { useThrottleFn } from '@vueuse/core';
import { QuestionCircleOutlined } from '@ant-design/icons-vue';
import { FeatureType } from '@/api/train/train.api';
import { getAttachmentPath } from '@/utils/path.util';

const props = withDefaults(
  defineProps<{
    imageId: number;
    featureImage: FeatureImage;
    feature: Feature;
    showLabel: boolean;
    opacity: number;
    labelPoints: LabelPoints[];
    savedLabelPoints: FeatureImageLabelShape[];
    isSubtract: boolean;
    inferenceResultContours: Contour[];
    isLabelMode?: boolean;
    showMask?: boolean;
    src?: string;
    isTwoFiveD?: boolean;
    decisionResult?: string | null;
    defaultPolygonType?: PolygonType | PolygonType3D;
  }>(),
  {
    src: '',
    opacity: 100,
    decisionResult: null,
    isLabelMode: true,
    defaultPolygonType: PolygonType.NONE,
  },
);

onMounted(() => {
  useEventListener(document.body as HTMLElement, 'keydown', handleKeydown);
  useEventListener(window, 'resize', onImageLoad);
  if (props.defaultPolygonType) {
    polygonType.value = props.defaultPolygonType as PolygonType;
  }
});

enum LayerName {
  MASK = 'mask',
  BASE = 'base',
  AUTO_LABEL = 'autoLabel',
  IMAGE = 'image', // New layer for the image
}

const containerRef = ref<HTMLElement>();
const imageCanvasRef = ref<HTMLCanvasElement>();
const imageRef = ref<HTMLImageElement | null>(null);
const v3dContainerRef = ref<HTMLElement>();
const drawSegmentRef = ref<DrawSegment>({
  points: [],
  lines: [],
  localPoints: [],
  circle: [],
});
const originalConfig = ref({
  containerWidth: 0,
  containerHeight: 0,
  scaleX: 0,
  scaleY: 0,
});
const SUBTRACT_RGB: string = `rgba(${[255, 255, 0, 1].join(', ')})`;
const v3dRef = ref<typeof v3d | null>(null);
const polygonType = ref<PolygonType>(PolygonType.NONE);
const scale = ref<number>(1);
const v3dMode = ref<TwoFiveDImageType>(TwoFiveDImageType.MEAN);
const stagePosition = ref({ x: 0, y: 0 });
const imagePath = ref<string>('');
const heightScale = ref(120);
const is2DAutoLabeling = ref(false);
const emit = defineEmits<{
  (e: 'onSaveLabel', labelPoints: LabelPoints[]): void;
  (e: 'onSaveLabel3D', labelPoints: LabelPoints[]): void;
  (e: 'onFinishLabel', labelPoints: LabelPoints[]): void;
  (e: 'onDeleteAllShape'): void;
  (e: 'onDeleteShape', shape: FeatureImageLabelShape): void;
  (e: 'onEditLabel', id: number): void;
  (e: 'onChangePolygonType', changePolygonType: (val: PolygonType) => void, polygonType: PolygonType): void;
}>();
const {
  onLoadMesh: originalOnLoadMesh,
  // 3D drawing related
  polygonType3D,
  isDrawing,
  finishPolygonDrawing,
  deleteLabel3D,
  clearAllLabels3D,
  setCamera,
  clearPreviewLine,
  // Right-click related methods
  handleRightClick,
  cancelCurrentDrawing,
  undoLatestShape3D,
  // 'd' key simulated click related methods
  updateLastMouseIntersection,
  simulateClickAtLastMousePosition,
  // Performance optimization: resource cleanup
  dispose,
  // Auto-labeling optimization status
  isAutoLabeling,
  // Camera movement detection
  isCameraMoving,
  // Raycast-based interaction methods (主要使用这些)
  handleClickWithRaycast,
  handleMouseEventWithRaycast,
  updatePreviewLineWithRaycast,
  // Canvas element setup
  setCanvasElement,
  updateRefInParent,
  setLabelVisibility,
  redrawAllLabelsOnSurface,
  updateInferenceResultContours,
  refreshOriginalColors,
} = useLabelingTwoFiveD({
  labelPoints3D: props.labelPoints as LabelPoint3D[],
  imageId: props.imageId,
  featureInfo: props.feature,
  SUBTRACT_RGB: SUBTRACT_RGB,
  emit: emit as unknown as (event: string, args: unknown) => void,
});

// Wrap onLoadMesh callback and add camera setup

const onLoadMesh = (
  _scene: Scene,
  _mesh: Mesh,
  _heightMap: Float32Array,
  _heightScale: Ref<number>,
  _surfaceTexture?: Ref<CanvasTexture | null>,
    meshArea?: {
    width: number;
    height: number;
  },
) => {
  originalOnLoadMesh(_scene, _mesh, _heightMap, _heightScale, _surfaceTexture, meshArea);
  setTimeout(() => {
    if (v3dRef.value && v3dRef.value.cameraRef) {
      setCamera(v3dRef.value.cameraRef);
    }

    let canvas: HTMLCanvasElement | null = null;

    if (v3dRef.value && v3dRef.value.$el) {
      canvas = v3dRef.value.$el.querySelector('canvas') as HTMLCanvasElement;
    }
    if (!canvas) {
      canvas = document.querySelector('canvas[data-engine="three.js r170"]') as HTMLCanvasElement;
    }

    if (!canvas) {
      const canvases = document.querySelectorAll('canvas');
      if (canvases.length > 0) {
        canvas = canvases[0] as HTMLCanvasElement;
      }
    }

    if (canvas) {
      setCanvasElement(canvas);
      setLabelVisibility([props.isLabelMode, props.showLabel, props.showMask]);
    }
  }, 200);
};

let stage: Stage;
const onHeightScale = (height: number) => {
  heightScale.value = height;
};

// Create a throttled function for 'd' key mouse event
const handleDKeyMouseEvent = useThrottleFn((stage: Konva.Stage) => {
  const pointerPosition = stage.getPointerPosition();
  if (!pointerPosition) return;

  // Build a generic simulated mouse event based on current pointer position
  const simulatedEvent = {
    currentTarget: stage,
    evt: {
      clientX: pointerPosition.x,
      clientY: pointerPosition.y,
      button: 0, // left click
    },
  };

  switch (props.feature.shape) {
    case LabelShapeType.POLYGON:
      // Polygon drawing relies on the "mousedown" event
      stage.fire('mousedown', simulatedEvent);
      break;
    case LabelShapeType.CIRCLE:
      stage.fire('mousedown', simulatedEvent);
      break;
    case LabelShapeType.LINE:
    case LabelShapeType.POINT:
      // Other shapes use the standard "click" listener defined in initStage
      stage.fire('click', simulatedEvent);
      break;
    default:
      // No-op for unsupported shapes
      break;
  }
}, 10);

const handleKeydown = (event: KeyboardEvent) => {
  event.preventDefault();
  const triggerKeys = ['@', '!', '#'];
  const keyToPolygonMap2D: Record<string, PolygonType> = {
    '1': PolygonType.NONE,
    '2': PolygonType.AUTO_LABEL,
  };
  const keyToPolygonMap3D: Record<string, PolygonType3D> = {
    '1': PolygonType3D.NONE,
    '2': PolygonType3D.AUTO_LABEL,
  };
  if (props.feature.shape == LabelShapeType.POLYGON && props.isLabelMode) {
    if (event.key in keyToPolygonMap2D) {
      if (props.isTwoFiveD) {
        const target3D = keyToPolygonMap3D[event.key];
        if (polygonType3D.value !== target3D) {
          polygonType3D.value = target3D;
        }
      } else {
        const target2D = keyToPolygonMap2D[event.key];
        if (polygonType.value !== target2D) {
          handleChangePolygonType(target2D);
        }
      }
      return;
    }
  }

  if (event.shiftKey && triggerKeys.includes(event.key) && props.isTwoFiveD) {
    setTimeout(() => {
      refreshOriginalColors();
      redrawAllLabelsOnSurface();
    }, 200);
  }

  // Handle Z for undoing the latest shape operation (supports all shape types: POLYGON, POINT, LINE, CIRCLE)
  if (event.key === 'z' || event.key === 'Z') {
    if (!props.isLabelMode || (!props.showLabel && !props.showMask)) return; // Cannot undo in non-labeling mode
    if (props.isTwoFiveD) {
      // Undo in 3D mode
      undoLatestShape3D();
    } else {
      // Undo in 2D mode (supports all shape types)
      undoLatestShape();
    }
    return;
  }

  // Handle Escape key for canceling current drawing in 3D mode
  if (event.key === 'Escape' && props.isTwoFiveD && isDrawing.value) {
    if (event.target instanceof HTMLInputElement) return;
    if (event.target instanceof HTMLTextAreaElement) return;
    if (!props.isLabelMode || (!props.showLabel && !props.showMask)) return; // Cannot cancel drawing in non-labeling mode
    cancelCurrentDrawing();
    return;
  }

  // Handle 'd' key to simulate a left-click for drawing (all supported 2D shapes)
  if (event.key === 'd' || event.key === 'D') {
    if (!props.isLabelMode || (!props.showLabel && !props.showMask)) return; // Cannot draw in non-labeling mode

    if (props.isTwoFiveD) {
      // In 3D mode we only support polygon drawing with the external simulate click logic
      if (props.feature.shape == LabelShapeType.POLYGON) {
        console.log('Pressed d key in 3D mode, handled by 3D component');
      }
    } else {
      // 2D mode – trigger the simulated mouse event
      handleDKeyMouseEvent(stage);
    }
    return;
  }
};

// 3D mode 'd' key simulated click handling - this function is called by 3D component
const handle3DSimulateClick = () => {
  if (!props.isLabelMode || (!props.showLabel && !props.showMask)) return; // Cannot simulate click in non-labeling mode

  if (isCameraMoving.value) {
    console.log('Camera is moving, skipping 3D simulated click');
    return;
  }
  simulateClickAtLastMousePosition(props.feature, props.imageId, props.isSubtract);
};

// Expose methods for parent component use
const isCurrentlyDrawing = () => {
  if (props.isTwoFiveD) {
    if (polygonType3D.value === PolygonType3D.AUTO_LABEL) {
      return isAutoLabeling.value || isDrawing.value;
    }
    return isDrawing.value;
  } else {
    // Check if there's an ongoing polygon drawing (both manual and auto label mode)
    if (drawSegmentRef.value.points.length > 0) {
      return true;
    }
    // Only check auto labeling state if no polygon drawing is in progress
    if (is2DAutoLabeling.value) {
      return is2DAutoLabeling.value;
    }
    return false;
  }
};

const clearCurrentDrawing = () => {
  if (stage) {
    // Only clear auto label if there's no ongoing drawing
    if ((polygonType.value === PolygonType.AUTO_LABEL || is2DAutoLabeling.value) && drawSegmentRef.value.points.length === 0) {
      const autoLabelLayer = stage.findOne(`.${LayerName.AUTO_LABEL}`) as Konva.Layer;
      if (autoLabelLayer) {
        autoLabelLayer.removeChildren();
        autoLabelLayer.draw();
        is2DAutoLabeling.value = false;
        InferApi.autoLabelReset(props.imageId);
        InferApi.finishAutoLabel();
      }
      return;
    }

    // Clear polygon drawing
    drawSegmentRef.value.lines.forEach((it) => it.remove());
    drawSegmentRef.value.points = [];
    drawSegmentRef.value.lines = [];
    drawSegmentRef.value.circle = [];
    drawSegmentRef.value.localPoints = [];
    drawSegmentRef.value.line = null;

    const baseLayer = stage.findOne(`.${LayerName.BASE}`) as Konva.Layer;
    if (baseLayer) {
      baseLayer.batchDraw();
    }
  } else {
    console.error('stage is not ready');
  }
};

const finishCurrentDrawing = () => {
  if (props.isTwoFiveD) {
    finishPolygonDrawing(props.feature, props.isSubtract, polygonType3D.value as unknown as PolygonType3D);
    return true;
  }
  const drawSegment = drawSegmentRef.value;
  const _image = imageRef.value;
  if (!stage || !_image) return false;

  // Handle auto label case - only if there's no ongoing drawing
  if ((polygonType.value === PolygonType.AUTO_LABEL || is2DAutoLabeling.value) && drawSegment.points.length === 0) {
    const autoLabelLayer = stage.findOne(`.${LayerName.AUTO_LABEL}`) as Konva.Layer;
    if (autoLabelLayer) {
      // Save all auto label shapes
      const shapes = autoLabelLayer.children;
      shapes.forEach((shape) => {
        if (shape instanceof Konva.Line) {
          const points = shape.points();

          // Create a drawSegment for auto label shapes to enable undo functionality
          const autoLabelDrawSegment: DrawSegment = {
            points: [...points],
            lines: [] as Konva.Line[],
            line: null as Konva.Line | null,
          };

          const cacheLabel: LabelPoints = {
            points: convertToCoordinates(points, _image.width, _image.height),
            shape: shape,
            labelShapeType: props.feature.shape,
            isSubtract: props.isSubtract,
            isCache: true,
            drawSegment: cloneDeep(autoLabelDrawSegment) as unknown as DrawSegment, // Add drawSegment for auto label
          };
          // Notify parent component via emit to add this label point to cache
          emit('onFinishLabel', [cacheLabel]);
        }
      });
      // Clear auto label layer after saving
      autoLabelLayer.removeChildren();
      autoLabelLayer.draw();
      is2DAutoLabeling.value = false;
    }

    clearCurrentDrawing();
    InferApi.finishAutoLabel();
    return true;
  }

  if (drawSegment.points.length > 0 && drawSegment.line) {
    const baseLayer = stage.findOne(`.${LayerName.BASE}`) as Konva.Layer;

    if (drawSegment.points.length > 4) {
      const polygon = new Konva.Line({
        points: drawSegment.points,
        closed: true,
        fill: props.isSubtract ? SUBTRACT_RGB : rgbToRgba(props.feature.color, 1),
        stroke: props.isSubtract ? SUBTRACT_RGB : props.feature.color,
        strokeWidth: 1 / stage.scaleX(), // Adjust stroke width for scaling
        globalCompositeOperation: props.isSubtract ? 'destination-out' : 'source-over',
      });

      polygon.on('mouseout', function () {
        this.opacity(props.opacity / 100);
      });
      if (!props.isSubtract) {
        polygon.on('mouseover', function () {
          this.opacity(props.opacity / 100 - 0.2);
        });
        polygon.on('contextmenu', function (event) {
          event.evt.preventDefault();
          deleteShape(polygon);
        });
      }

      baseLayer.add(polygon);

      // Create cached label point data
      const cacheLabel: LabelPoints = {
        points: convertToCoordinates(polygon.points(), _image.width, _image.height),
        shape: polygon,
        drawSegment: cloneDeep(drawSegment) as unknown as DrawSegment,
        labelShapeType: props.feature.shape,
        isSubtract: props.isSubtract,
        isCache: true,
      };
      clearCurrentDrawing();
      // Notify parent component via emit to add this label point to cache
      emit('onFinishLabel', [cacheLabel]);
      return true;
    } else {
      clearCurrentDrawing();
      return true;
    }
  }
  return true;
};

// Handle 3D interactions using raycast
const handle3DInteraction = (mouseX: number, mouseY: number, button: 'left' | 'right') => {
  if (!props.isTwoFiveD) return;
  if (!props.isLabelMode || (!props.showLabel && !props.showMask)) return; // No interaction allowed in non-labeling mode

  // Skip 3D interaction during camera movement
  if (isCameraMoving.value) {
    console.log('Camera is moving, skipping 3D interaction');
    v3dContainerRef.value.style.cursor = 'default';
    return;
  }

  v3dContainerRef.value.style.cursor = 'crosshair';
  const finishDrawing = () => {
    const surfacePoint = handleMouseEventWithRaycast(mouseX, mouseY);
    if (surfacePoint) {
      const handled = handleRightClick(surfacePoint);
      if (!handled) {
        // If not handled by handleRightClick, it means drawing needs to be completed
        finishPolygonDrawing(props.feature, props.isSubtract, polygonType3D.value as unknown as PolygonType3D);
      }
    }
  };

  if (polygonType3D.value === PolygonType3D.AUTO_LABEL) {
    // Auto-labeling - using ray casting
    if (isDrawing.value && button === 'right') {
      finishDrawing();
      return;
    }
    handleClickWithRaycast(mouseX, mouseY, props.feature, props.imageId, props.isSubtract, button);
  } else if (polygonType3D.value === PolygonType3D.NONE) {
    // Manual polygon drawing - using ray casting
    if (button === 'left') {
      handleClickWithRaycast(mouseX, mouseY, props.feature, undefined, props.isSubtract, button);
    } else if (button === 'right') {
      // Right-click handling - get world coordinates using ray casting
      finishDrawing();
    }
  }
};

const undoLineShape = (drawSegment: DrawSegment) => {
  // Remove the last two coordinate values (x, y)
  drawSegment.points.splice(-2, 2);

  // Remove the last added line segment
  if (drawSegment.lines.length > 0) {
    const lastLine = drawSegment.lines.pop();
    if (lastLine) {
      lastLine.remove();
    }
  }

  // Reset the current drawing line
  if (drawSegment.points.length > 0) {
    // If there are still points, set drawSegment.line to the last line segment
    if (drawSegment.lines.length > 0) {
      drawSegment.line = drawSegment.lines[drawSegment.lines.length - 1];
    } else {
      // If no line segments left, create a new line segment as current drawing line
      const baseLayer = stage.findOne(`.${LayerName.BASE}`) as Konva.Layer;
      const newLine = new Konva.Line({
        points: [...drawSegment.points],
        stroke: props.isSubtract ? SUBTRACT_RGB : props.feature.color,
        strokeWidth: 2 / stage.scaleX(),
      });
      baseLayer.add(newLine);
      drawSegment.line = newLine;
      drawSegment.lines.push(newLine);
    }
  } else {
    // If no points left, clear the current line
    if (drawSegment.line) {
      drawSegment.line.remove();
      drawSegment.line = null;
    }
  }

  // Redraw the layer
  const baseLayer = stage.findOne(`.${LayerName.BASE}`) as Konva.Layer;
  if (baseLayer) {
    baseLayer.batchDraw();
  }
  return;
};

const undoLatestShape = useThrottleFn(() => {
  const drawSegment = drawSegmentRef.value;

  // Handle auto label undo - only if no polygon drawing is in progress
  if (polygonType.value === PolygonType.AUTO_LABEL && is2DAutoLabeling.value && drawSegment.points.length === 0) {
    // Remove the last marker (cross or negative line) that was drawn during auto-labeling
    const baseLayer = stage.findOne(`.${LayerName.BASE}`) as Konva.Layer;
    if (baseLayer) {
      // Find the last child tagged as auto-label-marker
      const children = baseLayer.children;
      for (let i = children.length - 1; i >= 0; i--) {
        const node = children[i];
        if (node.name() === 'auto-label-marker') {
          node.remove();
          baseLayer.batchDraw();
          break;
        }
      }
    }

    InferApi.undoAutoLabel().then((res) => {
      const autoLabelLayer = stage.findOne(`.${LayerName.AUTO_LABEL}`) as Konva.Layer;
      if (!res.data.contours || res.data.contours.length === 0) {
        // All auto-label strokes have been undone – reset status completely
        is2DAutoLabeling.value = false;
        if (autoLabelLayer) {
          autoLabelLayer.removeChildren();
          autoLabelLayer.draw();
        }
        clearCurrentDrawing();
        InferApi.autoLabelReset(props.imageId);
        InferApi.cleanupAutoLabeller()
          .then(() => {
            console.info('cleanup auto labeller success');
          })
          .catch((e) => {
            console.error(e);
          });
      } else {
        drewAutoLabel(res.data.contours);
      }
    });
    return;
  }

  // 1.  If there is a drawing in progress (for polygon), undo that first
  if (props.feature.shape === LabelShapeType.POLYGON && drawSegment.points.length > 0) {
    undoLineShape(drawSegment as unknown as DrawSegment);
    return;
  }

  // 2.  No drawing in progress – handle completed / cached shapes
  if (props.labelPoints.length === 0) {
    return; // nothing to undo
  }

  const lastShape = props.labelPoints.pop();
  const baseLayer = stage.findOne(`.${LayerName.BASE}`) as Konva.Layer;

  // Polygon needs to be reverted back to editable line state
  if (props.feature.shape === LabelShapeType.POLYGON && lastShape.drawSegment) {
    // Remove the closed polygon from canvas
    lastShape.shape?.remove();

    // Clear any existing drawing remnants
    if (drawSegmentRef.value.line) {
      drawSegmentRef.value.line.remove();
    }
    drawSegmentRef.value.lines.forEach((l) => l.remove());

    // Store the points we will restore
    const restoredPoints = [...lastShape.drawSegment.points];

    // Reset the reactive drawing reference – keep empty for now, we will populate in nextTick
    drawSegmentRef.value = {
      points: restoredPoints,
      lines: [],
      line: null,
    } as unknown as DrawSegment;

    // Defer line creation until Vue has finished propagating the reactive change to parent
    nextTick(() => {
      const newLine = new Konva.Line({
        points: restoredPoints,
        stroke: props.isSubtract ? SUBTRACT_RGB : props.feature.color,
        strokeWidth: 2 / stage.scaleX(),
      });

      baseLayer.add(newLine);
      drawSegmentRef.value.line = newLine;
      drawSegmentRef.value.lines = [newLine];

      baseLayer.batchDraw();
    });
  } else {
    // Non-polygon shapes – simple removal
    lastShape.shape?.remove();
    stage.getLayers().forEach((layer) => layer.draw());
  }

  // Notify parent so that external state stays in sync
  emit('onDeleteShape', lastShape as unknown as FeatureImageLabelShape);
}, 100);

const onImageLoad = () => {
  destroyStage();
  init();
  if (stage && containerRef.value) {
    const image = imageRef.value;
    resetView();
    // Add the image to the image layer
    const imageLayer = stage.findOne(`.${LayerName.IMAGE}`) as Konva.Layer;
    if (imageLayer) {
      imageLayer.destroyChildren();

      const konvaImage = new Konva.Image({
        image: image,
        width: image.width,
        height: image.height,
        x: 0,
        y: 0,
      });

      imageLayer.add(konvaImage);
      imageLayer.draw();
    }

    stage.getLayers().forEach((layer) => {
      if (layer.name() === LayerName.MASK) {
        layer.visible(props.showMask);
        drawMask(layer);
      } else if (layer.name() === LayerName.BASE) {
        layer.visible(props.showLabel);
        drawExistShape(layer, props.savedLabelPoints);
      } else if (layer.name() === LayerName.AUTO_LABEL) {
        layer.visible(props.showLabel);
      }
    });

    stage.draw();
  }
};

const onEditLabel = (labelPoint: FeatureImageLabelShape | LabelPoint3D) => {
  if (isCurrentlyDrawing()) {
    return;
  }
  emit('onEditLabel', labelPoint.id);
};

const init = () => {
  if (imageRef.value && containerRef.value && imageCanvasRef.value) {
    const image = imageRef.value;
    originalConfig.value = {
      containerWidth: containerRef.value.clientWidth,
      containerHeight: containerRef.value.clientHeight,
      scaleX: containerRef.value.clientWidth / image.width,
      scaleY: containerRef.value.clientHeight / image.height,
    };
    stage = new Konva.Stage({
      container: imageCanvasRef.value as unknown as HTMLDivElement,
      width: image.width * originalConfig.value.scaleX,
      height: image.height * originalConfig.value.scaleY,
      draggable: false, // Disable default dragging
    });

    // Custom drag functionality with middle mouse button
    let isDragging = false;
    let lastPos = { x: 0, y: 0 };

    stage.on('mousedown', (e) => {
      // Middle mouse button (button 1)
      if (e.evt.button === 1) {
        isDragging = true;
        lastPos = stage.getPointerPosition();
        containerRef.value.style.cursor = 'grabbing';
        e.evt.preventDefault(); // Prevent default behaviors
      }
    });

    stage.on('mousemove', (e) => {
      if (isDragging && lastPos) {
        const pos = stage.getPointerPosition();
        if (pos) {
          const dx = pos.x - lastPos.x;
          const dy = pos.y - lastPos.y;

          stage.move({ x: dx, y: dy });
          lastPos = pos;
          stage.batchDraw();
          stagePosition.value = stage.position();
        }
      }
    });

    stage.on('mouseup mouseleave', (e) => {
      // Release on either mouseup or when mouse leaves the stage
      if (isDragging) {
        isDragging = false;
        containerRef.value.style.cursor = !props.isLabelMode || (!props.showLabel && !props.showMask) ? 'default' : 'crosshair';
      }
    });

    // Setup zoom/pan functionality
    stage.on('wheel', (e) => {
      e.evt.preventDefault();

      const oldScale = stage.scaleX();

      const pointer = stage.getPointerPosition();
      if (!pointer) return;

      const mousePointTo = {
        x: (pointer.x - stage.x()) / oldScale,
        y: (pointer.y - stage.y()) / oldScale,
      };

      // Linear scaling with smaller increments for smoother zoom
      const scaleBy = 0.1; // Linear scale increment
      const newScale = e.evt.deltaY < 0 ? oldScale + scaleBy : oldScale - scaleBy;

      const fitToScreenScale = Math.min(originalConfig.value.scaleX, originalConfig.value.scaleY);

      const limitedScale = Math.max(fitToScreenScale, Math.min(10, newScale));

      const roundedScale = Math.round(limitedScale * 20) / 20;

      stage.scale({ x: roundedScale, y: roundedScale });

      let newPos;
      if (roundedScale - fitToScreenScale < 0.1 && imageRef.value) {
        const image = imageRef.value;
        const xCenter = (originalConfig.value.containerWidth - image.width * roundedScale) / 2;
        const yCenter = (originalConfig.value.containerHeight - image.height * roundedScale) / 2;
        newPos = { x: xCenter, y: yCenter };
      } else {
        newPos = {
          x: pointer.x - mousePointTo.x * roundedScale,
          y: pointer.y - mousePointTo.y * roundedScale,
        };
      }

      stage.position(newPos);

      // Update stroke width for currently drawing lines
      if (drawSegmentRef.value.lines && drawSegmentRef.value.lines.length > 0) {
        drawSegmentRef.value.lines.forEach((line) => {
          if (line && line.strokeWidth) {
            line.strokeWidth(2 / roundedScale);
          }
        });
      }

      stage.batchDraw();

      scale.value = roundedScale;
      stagePosition.value = newPos;
    });
    stage.on('dragmove', () => {
      stagePosition.value = stage.position();
    });

    initStage(image);
  }
};
const labelCount3D = computed(() => {
  return props.savedLabelPoints.filter((labelPoint) => {
    const hasIsSubtract = 'isSubtract' in labelPoint && labelPoint.isSubtract;

    return !hasIsSubtract;
  });
});

const filteredSavedLabelPoints = computed(() => {
  return [...props.savedLabelPoints].filter((labelPoint) => {
    const hasIsSubtract = 'isSubtract' in labelPoint && labelPoint.isSubtract;

    return !hasIsSubtract;
  });
});

const handleModeChange = (mode: TwoFiveDImageType) => {
  v3dMode.value = mode;
};

const handleChangePolygonType = (val: PolygonType) => {
  emit('onChangePolygonType', (val: PolygonType) => (polygonType.value = val), val);
  polygonType.value = val;
};

onUnmounted(() => {
  // Performance optimization: cleanup 3D labeling system resources
  if (props.isTwoFiveD) {
    dispose();
  } else {
    destroyStage();
  }
});

const destroyStage = () => {
  if (stage) {
    stage.destroy();
    stage = null;
    if (imageCanvasRef.value) {
      imageCanvasRef.value.innerHTML = '';
    }
  }
};

// Helper function to clamp coordinates within image bounds
const clampToImageBounds = (pos: { x: number; y: number }) => {
  const image = imageRef.value;
  if (!image) return pos;

  return {
    x: Math.max(0, Math.min(image.width, pos.x)),
    y: Math.max(0, Math.min(image.height, pos.y)),
  };
};

const initStage = (_image: HTMLImageElement) => {
  // Create image layer first (bottom layer)
  const imageLayer: Layer = new Konva.Layer({ name: LayerName.IMAGE });
  const baseLayer: Layer = new Konva.Layer({ name: LayerName.BASE });
  const autoLabelLayer: Layer = new Konva.Layer({ name: LayerName.AUTO_LABEL });
  const maskLayer: Layer = new Konva.Layer({ name: LayerName.MASK });

  // Add the image to the image layer
  const konvaImage = new Konva.Image({
    image: _image,
    width: _image.width,
    height: _image.height,
    x: 0,
    y: 0,
  });

  imageLayer.add(konvaImage);
  stage.add(imageLayer);
  stage.add(baseLayer);
  stage.add(autoLabelLayer);
  stage.add(maskLayer);

  drawMask(maskLayer);
  drawExistShape(baseLayer, props.savedLabelPoints);

  if (props.showMask && !props.showLabel) {
    maskLayer.visible(true);
    baseLayer.visible(false);
    autoLabelLayer.visible(false);
  } else if (!props.showMask && props.showLabel) {
    maskLayer.visible(false);
    baseLayer.visible(true);
    autoLabelLayer.visible(true);
  } else {
    maskLayer.visible(true);
    baseLayer.visible(true);
    autoLabelLayer.visible(true);
  }

  if (props.feature.shape == LabelShapeType.POLYGON) {
    stage.on('mousedown', (event) => {
      if (event.evt.button === 0) {
        if (!props.isLabelMode || (!props.showLabel && !props.showMask)) return;

        // Check if we're in auto label mode and there's no ongoing drawing
        if (polygonType.value === PolygonType.AUTO_LABEL && drawSegmentRef.value.points.length === 0) {
          autoLabel(AutoLabelPos.Positive);
        } else {
          // Handle polygon drawing (both manual mode and auto label mode with ongoing drawing)
          const pos = stage.getPointerPosition();
          if (pos) {
            let scaledPos = {
              x: (pos.x - stage.x()) / stage.scaleX(),
              y: (pos.y - stage.y()) / stage.scaleY(),
            };
            scaledPos = clampToImageBounds(scaledPos);

            // If there's an existing line, update its points
            if (drawSegmentRef.value.line) {
              const currentPoints = [...drawSegmentRef.value.points];
              currentPoints.push(scaledPos.x, scaledPos.y);
              drawSegmentRef.value.points = currentPoints;
              drawSegmentRef.value.line.points(currentPoints);
            } else {
              // Create new line if none exists
              const line = new Konva.Line({
                points: [scaledPos.x, scaledPos.y],
                stroke: props.isSubtract ? SUBTRACT_RGB : props.feature.color,
                strokeWidth: 2 / stage.scaleX(),
              });
              baseLayer.add(line);
              drawSegmentRef.value.line = line;
              drawSegmentRef.value.lines = [line];
              drawSegmentRef.value.points = [scaledPos.x, scaledPos.y];
            }
            baseLayer.batchDraw();
          }
        }
      }
    });
    stage.on('mousemove', () => {
      if (!props.isLabelMode || (!props.showLabel && !props.showMask)) return;
      if (drawSegmentRef.value.points.length > 0 && drawSegmentRef.value.line) {
        const pos = stage.getPointerPosition();
        if (pos) {
          let scaledPos = {
            x: (pos.x - stage.x()) / stage.scaleX(),
            y: (pos.y - stage.y()) / stage.scaleY(),
          };
          scaledPos = clampToImageBounds(scaledPos);
          const currentPoints = [...drawSegmentRef.value.points];
          drawSegmentRef.value.line.points([...currentPoints, scaledPos.x, scaledPos.y]);
          baseLayer.batchDraw();
        }
      }
    });
    stage.on('contextmenu', (event) => {
      event.evt.preventDefault();
      if (!props.isLabelMode || (!props.showLabel && !props.showMask)) return; // Cannot draw in non-labeling mode

      // Check if we're in auto label mode and there's no ongoing drawing
      if (polygonType.value === PolygonType.AUTO_LABEL && drawSegmentRef.value.points.length === 0) {
        autoLabel(AutoLabelPos.Negative);
      } else {
        // Handle polygon completion (both manual mode and auto label mode with ongoing drawing)
        finishCurrentDrawing();
      }
    });
  } else if (props.feature.shape == LabelShapeType.CIRCLE) {
    const drawLocation: {
      circle?: Konva.Circle | null;
      startPos?: Vector2d | null;
    } = {};
    stage.on('mousedown', (e) => {
      if (e.evt.button === 0) {
        // Left click
        if (!props.isLabelMode || (!props.showLabel && !props.showMask)) return; // Cannot draw in non-labeling mode
        const pos = stage.getPointerPosition();
        if (pos) {
          // Convert position to account for stage scaling and position
          let scaledPos = {
            x: (pos.x - stage.x()) / stage.scaleX(),
            y: (pos.y - stage.y()) / stage.scaleY(),
          };
          // Clamp position to image bounds
          scaledPos = clampToImageBounds(scaledPos);

          if (!drawLocation.startPos) {
            const point = new Konva.Circle({
              x: scaledPos.x,
              y: scaledPos.y,
              radius: 2, // Adjust radius for scaling
              fill: props.feature.color,
              strokeWidth: 2, // Adjust stroke width for scaling
            });
            baseLayer.add(point);
            drawLocation.startPos = scaledPos;
            const circle = new Konva.Circle({
              x: scaledPos.x,
              y: scaledPos.y,
              radius: 1, // Adjust radius for scaling
              stroke: props.feature.color,
              strokeWidth: 1, // Adjust stroke width for scaling
            });
            circle.on('mouseover', function () {
              if (!props.isSubtract) {
                this.opacity(props.opacity / 100 - 0.2);
              }
              autoLabelLayer.draw();
            });
            circle.on('mouseout', function () {
              this.opacity(props.opacity / 100);
              autoLabelLayer.draw();
            });
            drawLocation.circle = circle;
            baseLayer.add(drawLocation.circle);
          } else {
            const endPoint = new Konva.Circle({
              x: scaledPos.x,
              y: scaledPos.y,
              radius: 2, // Adjust radius for scaling
              fill: props.feature.color,
              strokeWidth: 2, // Adjust stroke width for scaling
            });

            // Create a group to hold all circle elements
            const circleGroup = new Konva.Group();

            // Find and move the start point to the group
            const children = baseLayer.children.slice(); // Make a copy to avoid modifying array during iteration
            children.forEach((child) => {
              if (child instanceof Konva.Circle && Math.abs(child.x() - drawLocation.startPos.x) < 0.1 && Math.abs(child.y() - drawLocation.startPos.y) < 0.1) {
                child.moveTo(circleGroup);
              }
            });

            // Add current elements to group
            if (drawLocation.circle) {
              drawLocation.circle.moveTo(circleGroup);
            }
            circleGroup.add(endPoint);
            baseLayer.add(circleGroup);

            const circleLabel = {
              points: convertToCoordinates([drawLocation.startPos.x, drawLocation.startPos.y, scaledPos.x, scaledPos.y], _image.width, _image.height),
              shape: circleGroup as unknown as Shape<ShapeConfig>, // Store the group for complete deletion
              labelShapeType: props.feature.shape,
              isCache: true,
              isSubtract: props.isSubtract,
            };
            emit('onFinishLabel', [circleLabel]);
            drawLocation.startPos = null;
            drawLocation.circle = null;
          }
          baseLayer.draw();
        }
      }
    });
    stage.on('mousemove', () => {
      if (!props.isLabelMode || (!props.showLabel && !props.showMask)) return; // Cannot draw in non-labeling mode
      if (drawLocation.circle) {
        const pos = stage.getPointerPosition();
        if (pos && drawLocation.startPos) {
          // Convert position to account for stage scaling and position
          let scaledPos = {
            x: (pos.x - stage.x()) / stage.scaleX(),
            y: (pos.y - stage.y()) / stage.scaleY(),
          };
          // Clamp position to image bounds
          scaledPos = clampToImageBounds(scaledPos);

          const radius = Math.sqrt((drawLocation.startPos.x - scaledPos.x) ** 2 + (drawLocation.startPos.y - scaledPos.y) ** 2);
          drawLocation.circle.radius(radius);
          baseLayer.batchDraw();
        }
      }
    });
  } else if (props.feature.shape == LabelShapeType.POINT) {
    stage.on('click', (event) => {
      if (event.evt.button === 0) {
        if (!props.isLabelMode || (!props.showLabel && !props.showMask)) return; // Cannot draw in non-labeling mode
        const pos = stage.getPointerPosition();
        if (pos) {
          // Convert position to account for stage scaling and position

          let scaledPos = {
            x: (pos.x - stage.x()) / stage.scaleX(),
            y: (pos.y - stage.y()) / stage.scaleY(),
          };

          // Clamp position to image bounds
          scaledPos = clampToImageBounds(scaledPos);
          const crossShape = drawCross(baseLayer, scaledPos, props.feature.color);
          const pointLabel = {
            isCache: true,
            points: convertToCoordinates([scaledPos.x, scaledPos.y], _image.width, _image.height),
            shape: crossShape as unknown as Shape<ShapeConfig>, // Store the cross group for deletion - Group has remove() method
            labelShapeType: props.feature.shape,
            isSubtract: props.isSubtract,
          };
          drawSegmentRef.value.localPoints.push(crossShape as unknown as Konva.Line);
          emit('onFinishLabel', [pointLabel]);
        }
      }
    });
  } else if (props.feature.shape == LabelShapeType.LINE) {
    let line: Line = null;
    stage.on('click', (event) => {
      if (event.evt.button === 0) {
        if (!props.isLabelMode || (!props.showLabel && !props.showMask)) return; // Cannot draw in non-labeling mode
        const pos = stage.getPointerPosition();
        if (pos) {
          // Convert position to account for stage scaling and position
          let scaledPos = {
            x: (pos.x - stage.x()) / stage.scaleX(),
            y: (pos.y - stage.y()) / stage.scaleY(),
          };
          // Clamp position to image bounds
          scaledPos = clampToImageBounds(scaledPos);

          if (line) {
            const endPoint = new Konva.Circle({
              x: scaledPos.x,
              y: scaledPos.y,
              radius: 2, // Adjust radius for scaling
              fill: props.feature.color,
              strokeWidth: 2, // Adjust stroke width for scaling
            });

            // Create a group to hold all line elements (start point, line, end point)
            const lineGroup = new Konva.Group();

            // Find and move the start point to the group
            const children = baseLayer.children.slice(); // Make a copy to avoid modifying array during iteration
            const linePoints = line.points();
            children.forEach((child) => {
              if (child instanceof Konva.Circle && Math.abs(child.x() - linePoints[0]) < 0.1 && Math.abs(child.y() - linePoints[1]) < 0.1) {
                child.moveTo(lineGroup);
              }
            });

            // Move line and add end point to group
            line.moveTo(lineGroup);
            lineGroup.add(endPoint);
            baseLayer.add(lineGroup);
            // Only keep start and end points (first 2 and last 2 values)
            const points = [linePoints[0], linePoints[1], scaledPos.x, scaledPos.y];
            const convertedPoints = convertToCoordinates(points, _image.width, _image.height);
            const lineLabel = {
              isCache: true,
              points: convertedPoints,
              shape: lineGroup as unknown as Shape<ShapeConfig>, // Store the group for complete deletion
              labelShapeType: props.feature.shape,
              isSubtract: props.isSubtract,
            };
            emit('onFinishLabel', [lineLabel]);
            line = null;
          } else {
            const point = new Konva.Circle({
              x: scaledPos.x,
              y: scaledPos.y,
              radius: 2, // Adjust radius for scaling
              fill: props.feature.color,
              strokeWidth: 2, // Adjust stroke width for scaling
            });
            line = new Konva.Line({
              points: [scaledPos.x, scaledPos.y],
              stroke: props.feature.color,
              strokeWidth: 1, // Adjust stroke width for scaling
            });
            baseLayer.add(point);
            baseLayer.add(line);
          }
          baseLayer.batchDraw();
        }
      }
    });
    stage.on('mousemove', () => {
      if (!props.isLabelMode || (!props.showLabel && !props.showMask)) return; // Cannot draw in non-labeling mode
      if (line) {
        const pos = stage.getPointerPosition();
        if (pos) {
          // Convert position to account for stage scaling and position
          let scaledPos = {
            x: (pos.x - stage.x()) / stage.scaleX(),
            y: (pos.y - stage.y()) / stage.scaleY(),
          };
          // Clamp position to image bounds
          scaledPos = clampToImageBounds(scaledPos);

          line.points([line.points()[0], line.points()[1], scaledPos.x, scaledPos.y]);
          baseLayer.batchDraw();
        }
      }
    });
  }
};

const drewAutoLabel = (contours: [number, number][][]) => {
  const autoLabelLayer = stage.findOne(`.${LayerName.AUTO_LABEL}`) as Konva.Layer;
  const image = imageRef.value;
  autoLabelLayer.removeChildren();
  if (contours) {
    contours.forEach((contour: [number, number][]) => {
      const absoluteContour = contour.map((point: [number, number]) => [point[0] * image.width, point[1] * image.height]);
      const polygon = new Konva.Line({
        points: absoluteContour.flat(),
        fill: rgbToRgba(props.feature.color, 0.35),
        stroke: props.feature.color,
        closed: true,
        strokeWidth: 1 / stage.scaleX(), // Adjust stroke width for scaling
      });
      polygon.on('mouseover', function () {
        if (!props.isSubtract) {
          this.opacity(props.opacity / 100 - 0.2);
        }
        autoLabelLayer.draw();
      });
      polygon.on('mouseout', function () {
        this.opacity(props.opacity / 100);
        autoLabelLayer.draw();
      });

      const coordinates: Point[] = [];
      contour.forEach((it: number[]) => {
        coordinates.push({
          x: it[0],
          y: it[1],
        });
      });
      autoLabelLayer.add(polygon);
    });
  }
  autoLabelLayer.draw();
  is2DAutoLabeling.value = true;
};

const autoLabel = useThrottleFn((pos: AutoLabelPos) => {
  const baseLayer = stage.findOne(`.${LayerName.BASE}`) as Konva.Layer;
  const position = stage.getPointerPosition();
  const image = imageRef.value;
  if (!position) return;
  // Convert position to account for stage scaling and position
  let scaledPos = {
    x: (position.x - stage.x()) / stage.scaleX(),
    y: (position.y - stage.y()) / stage.scaleY(),
  };
  // Clamp position to image bounds
  scaledPos = clampToImageBounds(scaledPos);
  if (pos === AutoLabelPos.Positive) {
    drawCross(baseLayer, scaledPos, '#0f0');
  } else {
    const size = 5 / stage.scaleX(); // Adjust size for scaling
    baseLayer.add(
      new Konva.Line({
        points: [scaledPos.x - size, scaledPos.y, scaledPos.x + size, scaledPos.y],
        stroke: '#f00',
        strokeWidth: 1 / stage.scaleX(), // Adjust stroke width for scaling
        name: 'auto-label-marker',
      }),
    );
  }
  if (props.imageId) {
    stage.container().style.cursor = 'wait';
    // Use original image dimensions to calculate coordinates
    const x = scaledPos.x / image.width;
    const y = scaledPos.y / image.height;
    InferApi.autoLabel(props.imageId, x, y, pos)
      .then((res) => {
        drewAutoLabel(res.data.contours);
        stage.container().style.cursor = !props.isLabelMode || (!props.showLabel && !props.showMask) ? 'default' : 'crosshair';
      })
      .catch(() => {
        // Restore cursor state
        stage.container().style.cursor = !props.isLabelMode || (!props.showLabel && !props.showMask) ? 'default' : 'crosshair';
      });
  }
}, 500);

const drawCross = (layer: Layer, pos: Vector2d, color: string) => {
  const size = 5; // Adjust size for scaling
  const line1 = new Konva.Line({
    points: [pos.x - size, pos.y, pos.x + size, pos.y],
    stroke: color,
    strokeWidth: 1, // Adjust stroke width for scaling
    name: 'auto-label-marker',
  });
  const line2 = new Konva.Line({
    points: [pos.x, pos.y - size, pos.x, pos.y + size],
    stroke: color,
    strokeWidth: 1, // Adjust stroke width for scaling
    name: 'auto-label-marker',
  });

  // Create a group to hold both lines for easier management
  const crossGroup = new Konva.Group({
    name: 'auto-label-group',
    stroke: color,
    opacity: props.opacity / 100,
  });
  crossGroup.add(line1);
  crossGroup.add(line2);
  crossGroup.on('contextmenu', (event) => {
    event.evt.preventDefault();
    if (!props.isLabelMode || (!props.showLabel && !props.showMask)) return; // Cannot draw in non-labeling mode
    deleteShape(crossGroup as unknown as Shape);
  });
  layer.add(crossGroup);
  layer.batchDraw();

  return crossGroup; // Return the group for deletion reference
};

const handleLabelOn = (shape: FeatureImageLabelShape) => {
  shape.shape.opacity(props.opacity / 100 - 0.2);
};

const handleLabelOut = (shape: FeatureImageLabelShape) => {
  shape.shape.opacity(props.opacity / 100);
};

const deleteShape = (shape: Shape) => {
  if (isCurrentlyDrawing()) {
    return;
  }
  let cacheLabel: FeatureImageLabelShape;
  for (const label of props.savedLabelPoints) {
    if ((label as FeatureImageLabelShape).isCache === true && label.shape && label.shape.index == shape.index) {
      cacheLabel = label;
      break;
    }
  }
  if (cacheLabel) {
    shape.remove();
    props.savedLabelPoints.forEach((item, index) => {
      if (item.id === cacheLabel.id) {
        props.savedLabelPoints.splice(index, 1);
      }
    });
    props.labelPoints.forEach((item, index) => {
      if (item.shape?.index === shape.index) {
        props.labelPoints.splice(index, 1);
      }
    });
    emit('onDeleteShape', cacheLabel);
    return;
  }

  let existLabel: FeatureImageLabelShape;
  for (const label of props.savedLabelPoints) {
    if (label.isCache !== true && label.shape && label.shape.index == shape.index) {
      existLabel = label;
      break;
    }
  }

  if (existLabel) {
    shape.remove();
    props.savedLabelPoints.forEach((item, index) => {
      if (item.id === existLabel.id) {
        props.savedLabelPoints.splice(index, 1);
      }
    });
    props.featureImage.labelCount--;
    const baseLayer = stage.findOne(`.${LayerName.BASE}`) as Konva.Layer;
    if (baseLayer) {
      baseLayer.batchDraw();
    }
    emit('onDeleteShape', existLabel);
  } else {
    props.labelPoints.forEach((item, index) => {
      if (item.shape?.index === shape.index) {
        props.labelPoints.splice(index, 1);
        shape.remove();
        const baseLayer = stage.findOne(`.${LayerName.BASE}`) as Konva.Layer;
        if (baseLayer) {
          baseLayer.batchDraw();
        }
      }
    });
  }
};

const deleteAllShape = () => {
  if (isCurrentlyDrawing()) {
    return;
  }
  props.savedLabelPoints.forEach((shape) => {
    shape.shape?.remove();
  });
  props.savedLabelPoints.length = 0;
  props.featureImage.labelCount = 0;
  emit('onDeleteAllShape');
};

const visibleShape = (shape: FeatureImageLabelShape) => {
  if (isCurrentlyDrawing()) {
    return;
  }
  shape.visible = !shape.visible;
  shape.shape.visible(shape.visible);
};

// Reset to fit container (fit to screen)
const resetView = () => {
  if (imageRef.value && containerRef.value && imageRef.value) {
    const image = imageRef.value;
    // Use the smaller scale factor to ensure the entire image fits
    const newScale = Math.min(originalConfig.value.scaleX, originalConfig.value.scaleY);
    // Apply the new scale
    stage.scale({ x: newScale, y: newScale });

    // Center the image in the container
    const xPos = (originalConfig.value.containerWidth - image.width * newScale) / 2;
    const yPos = (originalConfig.value.containerHeight - image.height * newScale) / 2;
    stage.position({ x: xPos, y: yPos });

    stage.batchDraw();
    scale.value = newScale;
    stagePosition.value = { x: xPos, y: yPos };
  }
};

// Reset to 100% scale (1:1 pixel ratio)
const resetToActualSize = () => {
  if (imageRef.value && containerRef.value) {
    const image = imageRef.value;
    const newScale = 1.0; // 100% scale

    stage.scale({ x: newScale, y: newScale });

    // Center the image in the container
    const xPos = (originalConfig.value.containerWidth - image.width * newScale) / 2;
    const yPos = (originalConfig.value.containerHeight - image.height * newScale) / 2;
    stage.position({ x: xPos, y: yPos });

    // Update stroke width for currently drawing lines
    if (drawSegmentRef.value.lines && drawSegmentRef.value.lines.length > 0) {
      drawSegmentRef.value.lines.forEach((line) => {
        if (line && line.strokeWidth) {
          line.strokeWidth(2 / newScale);
        }
      });
    }

    stage.batchDraw();
    scale.value = newScale;
    stagePosition.value = { x: xPos, y: yPos };
  }
};

// draw db exist shape
const drawExistShape = (layer: Layer, shapes: FeatureImageLabelShape[]) => {
  layer.removeChildren();
  const image = imageRef.value;
  if (!image) return;

  shapes.forEach((shape, index) => {
    const points = convertToPixelCoordinates(shape.points, image.width, image.height);
    switch (shape.labelShapeType) {
      case LabelShapeType.POLYGON:
        const line = new Konva.Line({
          points: points,
          closed: true,
          opacity: shape.isSubtract ? 1 : props.opacity / 100,
          subtract: shape.isSubtract,
          fill: shape.isSubtract ? SUBTRACT_RGB : rgbToRgba(props.feature.color, 1),
          stroke: shape.isSubtract ? SUBTRACT_RGB : props.feature.color,
          strokeWidth: 1 / stage.scaleX(), // Adjust stroke width for scaling
          globalCompositeOperation: shape.isSubtract ? 'destination-out' : 'source-over',
        });
        shape.shape = line;
        line.on('mouseover', function () {
          if (!shape.isSubtract) {
            this.opacity(props.opacity / 100 - 0.2);
          }
        });
        line.on('mouseout', function () {
          this.opacity(props.opacity / 100);
        });
        line.on('contextmenu', function (event) {
          event.evt.preventDefault();
          if (!props.isLabelMode || (!props.showLabel && !props.showMask)) return;
          deleteShape(line);
        });
        layer.add(line);
        break;
      case LabelShapeType.POINT:
        const crossShape = drawCross(
          layer,
          {
            x: points[0],
            y: points[1],
          },
          props.feature.color,
        );
        shape.shape = crossShape as unknown as Shape<ShapeConfig>; // Group can be treated as Shape for removal
        break;
      case LabelShapeType.LINE:
        const lineGroup = new Konva.Group({
          name: 'line-group',
          stroke: props.feature.color,
          strokeWidth: 5,
          opacity: props.opacity / 100,
        });
        const startPoint = new Konva.Circle({
          x: points[0],
          y: points[1],
          radius: 2, // Adjust radius for scaling
          opacity: props.opacity / 100,
          fill: props.feature.color,
          strokeWidth: 2, // Adjust stroke width for scaling
        });

        const endPoint = new Konva.Circle({
          x: points[2],
          y: points[3],
          radius: 2, // Adjust radius for scaling
          fill: props.feature.color,
          opacity: props.opacity / 100,
          strokeWidth: 2, // Adjust stroke width for scaling
        });

        const lineShape = new Konva.Line({
          points: points,
          stroke: props.feature.color,
          opacity: props.opacity / 100,
          strokeWidth: 1, // Adjust stroke width for scaling
          fill: props.feature.color,
        });

        lineGroup.add(startPoint);
        lineGroup.add(endPoint);
        lineGroup.add(lineShape);
        lineGroup.on('contextmenu', (event) => {
          event.evt.preventDefault();
          console.log('lineGroup', lineGroup);
          if (!props.isLabelMode || (!props.showLabel && !props.showMask)) return; // Cannot draw in non-labeling mode
          deleteShape(lineGroup as unknown as Shape);
        });
        layer.add(lineGroup);
        shape.shape = lineGroup as unknown as Shape<ShapeConfig>;
        break;
      case LabelShapeType.CIRCLE:
        const circleGroup = new Konva.Group();

        const startCircle = new Konva.Circle({
          x: points[0],
          y: points[1],
          radius: 2, // Adjust radius for scaling
          opacity: props.opacity / 100,
          fill: props.feature.color,
          strokeWidth: 2, // Adjust stroke width for scaling
        });

        const endCircle = new Konva.Circle({
          x: points[2],
          y: points[3],
          radius: 2, // Adjust radius for scaling
          opacity: props.opacity / 100,
          fill: props.feature.color,
          strokeWidth: 2, // Adjust stroke width for scaling
        });

        const mainCircle = new Konva.Circle({
          x: points[0],
          y: points[1],
          opacity: props.opacity / 100,
          radius: Math.sqrt((points[0] - points[2]) ** 2 + (points[1] - points[3]) ** 2),
          stroke: props.feature.color,
          strokeWidth: 1, // Adjust stroke width for scaling
        });

        circleGroup.add(startCircle);
        circleGroup.add(endCircle);
        circleGroup.add(mainCircle);

        shape.shape = circleGroup as unknown as Shape<ShapeConfig>;
        circleGroup.on('contextmenu', (event) => {
          event.evt.preventDefault();
          if (!props.isLabelMode || (!props.showLabel && !props.showMask)) return; // Cannot draw in non-labeling mode
          deleteShape(circleGroup as unknown as Shape);
        });
        layer.add(circleGroup);

        mainCircle.on('mouseover', function () {
          if (!shape.isSubtract) {
            circleGroup.opacity(props.opacity / 100 - 0.2);
          }
        });
        mainCircle.on('mouseout', function () {
          circleGroup.opacity(props.opacity / 100);
        });
        break;
    }
  });
  layer.batchDraw();
};

// draw mask
const drawMask = (layer: Layer) => {
  layer.removeChildren();
  if (props.inferenceResultContours) {
    props.inferenceResultContours.forEach((item) => {
      item.contours.forEach((contour) => {
        const polygon = new Konva.Line({
          points: contour.flat(),
          strokeWidth: 2, // Adjust stroke width for scaling
          stroke: props.feature.color,
          closed: true,
          draggable: false,
          globalCompositeOperation: props.isSubtract ? 'destination-out' : 'source-over',
        });
        layer.add(polygon);
      });

      item.circles?.forEach((circle) => {
        const circleShape = new Konva.Circle({
          x: Number(circle.center.originalX),
          y: Number(circle.center.originalY),
          opacity: props.opacity / 100,
          radius: circle.originalRadius,
          stroke: props.feature.color,
          strokeWidth: 1,
        });
        layer.add(circleShape);
      });

      item.lines?.forEach((line) => {
        const startPoint = new Konva.Circle({
          x: Number(line.endPoint1.originalX),
          y: Number(line.endPoint1.originalY),
          radius: 2,
          fill: props.feature.color,
          stroke: props.feature.color,
          strokeWidth: 2,
        });
        layer.add(startPoint);

        const endPoint = new Konva.Circle({
          x: Number(line.endPoint2.originalX),
          y: Number(line.endPoint2.originalY),
          radius: 2,
          fill: props.feature.color,
          stroke: props.feature.color,
          strokeWidth: 2,
        });
        layer.add(endPoint);

        const lineShape = new Konva.Line({
          points: [Number(line.endPoint1.originalX), Number(line.endPoint1.originalY), Number(line.endPoint2.originalX), Number(line.endPoint2.originalY)],
          stroke: props.feature.color,
          strokeWidth: 1,
        });
        layer.add(lineShape);
      });

      item.points?.forEach((point) => {
        drawCross(
          layer,
          {
            x: Number(point.originalX),
            y: Number(point.originalY),
          },
          props.feature.color,
        );
      });
    });
  }
  layer.batchDraw();
};

const handle3DMeshClick = (event: { mouseX: number; mouseY: number; button?: string }) => {
  if (!props.isTwoFiveD) return;

  handle3DInteraction(event.mouseX, event.mouseY, 'left');
};

const handle3DMeshRightClick = (event: { mouseX: number; mouseY: number; button?: string }) => {
  if (!props.isTwoFiveD) return;

  handle3DInteraction(event.mouseX, event.mouseY, 'right');
};

const handle3DMeshPointerMove = (event: { mouseX: number; mouseY: number }) => {
  if (!props.isTwoFiveD) return;

  // 使用光线投射更新鼠标位置
  const surfacePoint = handleMouseEventWithRaycast(event.mouseX, event.mouseY);
  if (surfacePoint) {
    updateLastMouseIntersection(surfacePoint);
  }
  // Use ray casting to update preview line
  if (isDrawing.value && !isAutoLabeling.value) {
    updatePreviewLineWithRaycast(event.mouseX, event.mouseY, props.feature);
  } else if (!isDrawing.value) {
    clearPreviewLine();
  }
};

watch(polygonType, (val) => {
  // Cancel current drawing line operations
  if (val === PolygonType.AUTO_LABEL) {
    InferApi.autoLabelReset(props.imageId).catch(() => {
      polygonType.value = PolygonType.NONE;
    });
  }
});

// Watch for image ID changes
watch(
  () => props.imageId,
  (newValue, oldValue) => {
    if (newValue !== oldValue) {
      // Reset auto-labeling when switching images
      if (props.feature.shape == LabelShapeType.POLYGON && polygonType.value === PolygonType.AUTO_LABEL) {
        InferApi.autoLabelReset(oldValue);
        InferApi.autoLabelReset(newValue);
      }
      // Clear all layers when switching images
      if (stage) {
        stage.getLayers().forEach((layer) => {
          layer.removeChildren();
          layer.draw();
        });
      }
    }
  },
);

watch(
  () => props.savedLabelPoints,
  (val) => {
    if (props.isTwoFiveD) {
      updateRefInParent({
        savedLabelPointsNewVal: val,
      });
      return;
    }

    if (stage) {
      const baseLayer = stage.findOne(`.${LayerName.BASE}`) as Konva.Layer;
      if (baseLayer) {
        baseLayer.destroyChildren();
        baseLayer.draw(); // Redraw layer to apply changes
        drawExistShape(baseLayer, val);
      }
    }
  },
);

// Watch for mask visibility changes
watch(
  () => props.showMask,
  (val) => {
    if (stage) {
      stage.getLayers().forEach((layer) => {
        if (layer.name() === LayerName.MASK) {
          layer.visible(val);
        } else if (layer.name() !== LayerName.IMAGE) {
          layer.visible(props.showLabel);
        }
      });
    }
  },
);

// Watch for label visibility changes
watch(
  () => props.showLabel,
  (val) => {
    if (stage) {
      stage.getLayers().forEach((layer) => {
        if (layer.name() === LayerName.MASK) {
          layer.visible(props.showMask);
        } else if (layer.name() !== LayerName.IMAGE) {
          layer.visible(val);
        }
      });
    }
  },
);

// Watch for label mode and visibility changes
watch(
  () => [props.isLabelMode, props.showLabel, props.showMask],
  (val) => {
    if (!props.isLabelMode) {
      if (props.isTwoFiveD) {
        setLabelVisibility(val as [boolean, boolean, boolean]);
        v3dContainerRef.value.style.cursor = 'default';
      } else {
        containerRef.value.style.cursor = 'default';
      }
      return;
    }
    if (props.isTwoFiveD) {
      setLabelVisibility(val as [boolean, boolean, boolean]);
      v3dContainerRef.value.style.cursor = !val || (!props.showLabel && !props.showMask) ? 'default' : 'crosshair';
    } else {
      if (containerRef.value) {
        containerRef.value.style.cursor = !val || (!props.showLabel && !props.showMask) ? 'default' : 'crosshair';
      }
      if (stage && stage.container()) {
        stage.container().style.cursor = !val || (!props.showLabel && !props.showMask) ? 'default' : 'crosshair';
      }
    }
  },
);

watch(
  () => props.featureImage.image.path,
  (val) => {
    if (val) {
      imagePath.value = getAttachmentPath(val);
    }
  },
  { immediate: true, deep: true },
);

// Watch for 2.5D mode changes
watch(
  () => props.isTwoFiveD,
  (val) => {
    if (val) {
      // Initialize 3D mode with default polygon tool
      polygonType3D.value = PolygonType3D.NONE;
    } else {
      // Initialize 2D mode with default polygon tool
      polygonType.value = PolygonType.NONE;
    }
  },
);

// Watch for 3D polygon type changes
watch(polygonType3D, (val) => {
  // Cancel any ongoing drawing when switching tools
  cancelCurrentDrawing();

  if (val === PolygonType3D.AUTO_LABEL) {
    // Reset auto-labeling state when switching to auto-label mode
    InferApi.autoLabelReset(props.imageId).catch(() => {
      polygonType3D.value = PolygonType3D.NONE;
    });
  }
});

// Watch for inference result contours changes
watch(
  () => props.inferenceResultContours,
  (val) => {
    if (props.isTwoFiveD) {
      updateInferenceResultContours(props.inferenceResultContours);
      return;
    }
    if (stage) {
      stage.getLayers().forEach((layer) => {
        if (layer.name() === LayerName.MASK) {
          drawMask(layer as Layer);
        }
      });
    }
  },
);

defineExpose({
  isCurrentlyDrawing,
  clearCurrentDrawing,
  finishCurrentDrawing,
  resetView,
  resetToActualSize,
});

const handleDeleteLabel3D = (index: number) => {
  if (index >= 0 && index < props.savedLabelPoints.length) {
    const label = props.savedLabelPoints[index] as unknown as FeatureImageLabelShape;
    deleteLabel3D(index);
    // 通知父组件同步更新 savedLabelPoints
    emit('onDeleteShape', label);
  }
};

const handleClearAllLabels3D = () => {
  clearAllLabels3D();
  emit('onDeleteAllShape');
};
</script>
<template>
  <div v-if="!props.isTwoFiveD" class="label-container">
    <div
      ref="containerRef"
      class="zoomEle"
      :class="{ 'label-mode': props.isLabelMode, 'view-mode': !props.isLabelMode || (!props.showLabel && !props.showMask) }"
    >
      <div
        :class="{ 'border-ok': props.decisionResult === 'OK', 'border-error': props.decisionResult === 'NG' }"
        ref="imageCanvasRef"
        style="position: absolute; left: 0; right: 0; top: 0; bottom: 0; z-index: 99; display: flex; justify-content: center"
      ></div>
      <img ref="imageRef" :src="imagePath" alt="label image" @load="onImageLoad" style="display: none" />
    </div>

    <div class="mask-layer"></div>
  </div>
  <div ref="v3dContainerRef" v-if="props.isTwoFiveD" style="width: 100%; height: 100%">
    <v3d
      :image="featureImage.image"
      ref="v3dRef"
      :on-load-mesh="onLoadMesh"
      :on-height-scale="onHeightScale"
      :click-mesh="handle3DMeshClick"
      :click-menu-mesh="handle3DMeshRightClick"
      :pointer-move-mesh="handle3DMeshPointerMove"
      :simulate-click-at-mouse="handle3DSimulateClick"
      :is-drawing="isDrawing"
      @mode-change="handleModeChange"
    >
    </v3d>
  </div>

  <Teleport to="#mask-layer">
    <div>
      <div v-if="props.isLabelMode" style="display: flex">
        <a-tooltip  :overlayInnerStyle="{ minWidth: '325px' }">
          <template #title>
            <!-- polygon tooltip -->
            <div v-if="polygonType == PolygonType.NONE && feature.type != FeatureType.LOCATION">
              <span>1. {{ I18N.$t('label.tooltip.switch_tool') }} </span><br />
              <span>2. {{ I18N.$t('label.tooltip.add_node') }} </span><br />
              <span>3. {{ I18N.$t('label.tooltip.complete_shape') }} </span><br />
              <span>4. {{ I18N.$t('label.tooltip.delete_shape') }} </span><br />
              <span>5. {{ I18N.$t('label.tooltip.toggle_suggestion') }} </span><br />
              <span>6. {{ I18N.$t('label.tooltip.toggle_add_subtract') }} </span><br />
              <span>7. {{ I18N.$t('label.tooltip.undo') }} </span><br />
              <span>8. {{ I18N.$t('label.tooltip.zoom') }}</span><br />
              <span>9. {{ I18N.$t('label.tooltip.pan') }}</span>
            </div>
            <!-- auto label tooltip -->
            <div v-if="polygonType === PolygonType.AUTO_LABEL && feature.type != FeatureType.LOCATION">
              <span>1. {{ I18N.$t('label.tooltip.add_additive_point') }} </span><br />
              <span>2. {{ I18N.$t('label.tooltip.add_subtractive_point') }} </span><br />
              <span>3. {{ I18N.$t('label.tooltip.end_shape') }} </span><br />
              <span>4. {{ I18N.$t('label.tooltip.undo') }} </span><br />
              <span>5. {{ I18N.$t('label.tooltip.pan') }}</span>
            </div>

            <!-- location tooltip -->
            <div v-if="feature.type == FeatureType.LOCATION">
              <span>1. {{ I18N.$t('label.tooltip.add_node_location') }} </span><br />
              <span>2. {{ I18N.$t('label.tooltip.remove_location') }} </span><br />
              <span>3. {{ I18N.$t('label.tooltip.undo_location') }} </span><br />
              <span>4. {{ I18N.$t('label.tooltip.pan') }}</span>
            </div>
          </template>
          <a-button style="margin-right: 4px; padding: 3px 10px" type="default">
            <QuestionCircleOutlined />
          </a-button>
        </a-tooltip>

        <!-- 2D模式的工具选择 -->
        <a-segmented
          v-if="feature.shape == LabelShapeType.POLYGON && !props.isTwoFiveD && props.isLabelMode"
          style="width: 100%"
          :value="polygonType"
          @change="handleChangePolygonType"
          block
          :options="[
            { label: I18N.$t('label.polygon'), value: PolygonType.NONE },
            { label: I18N.$t('label.auto_label'), value: PolygonType.AUTO_LABEL },
          ]"
        />
        <!-- 3D模式的工具选择 -->
        <a-segmented
          v-if="feature.shape == LabelShapeType.POLYGON && props.isTwoFiveD && props.isLabelMode"
          style="width: 100%"
          v-model:value="polygonType3D"
          block
          :options="[
            { label: I18N.$t('label.polygon'), value: PolygonType3D.NONE },
            { label: I18N.$t('label.auto_label'), value: PolygonType3D.AUTO_LABEL },
          ]"
        />
      </div>
      <div style="max-height: 300px; overflow: auto">
        <!-- 2D模式的标注点显示 -->
        <template v-if="!props.isTwoFiveD && isLabelMode">
          <div
            class="mask-item"
            v-for="labelPoint in filteredSavedLabelPoints"
            :key="labelPoint.id"
            :style="{ borderLeftColor: `${feature.color}` }"
            @mouseover="handleLabelOn(labelPoint)"
            @mouseout="handleLabelOut(labelPoint)"
          >
            <span>{{ feature.name }}</span>
            <div style="margin-left: auto; position: relative; z-index: 1" ref="editLabelWrapper">
              <EditOutlined
                v-if="props.isLabelMode && !(labelPoint as any).isCache"
                style="cursor: pointer; margin-right: 8px"
                @click="onEditLabel(labelPoint)"
              />
              <template v-if="!labelPoint.visible">
                <EyeInvisibleOutlined style="cursor: pointer; margin-right: 8px" @click="visibleShape(labelPoint)" />
              </template>
              <template v-else>
                <EyeOutlined style="cursor: pointer; margin-right: 8px" @click="visibleShape(labelPoint)" />
              </template>
              <DeleteOutlined v-if="props.isLabelMode" style="cursor: pointer" @click="deleteShape(labelPoint.shape)" />
            </div>
          </div>
        </template>

        <!-- 3D模式的标注点显示 -->
        <template v-if="props.isTwoFiveD && isLabelMode">
          <div class="mask-item" v-for="(labelPoint, index) in labelCount3D" :key="index" :style="{ borderLeftColor: `${feature.color}` }">
            <span>{{ feature.name }}</span>
            <div style="margin-left: auto">
              <EditOutlined
                v-if="props.isLabelMode && !(labelPoint as any)?.isCache"
                style="cursor: pointer; margin-right: 8px"
                @click="onEditLabel(labelPoint)"
              />
              <DeleteOutlined v-if="props.isLabelMode" style="color: #f00; cursor: pointer" @click="handleDeleteLabel3D(index)" />
            </div>
          </div>
        </template>
      </div>

      <!-- 2D模式的删除所有按钮 -->
      <a-button
        type="dashed"
        block
        @click="deleteAllShape()"
        v-if="!props.isTwoFiveD && filteredSavedLabelPoints.length && props.isLabelMode && featureImage.hasFeature"
        style="width: 100%; margin-bottom: 16px; height: 36px; margin-top: 16px"
      >
        {{ I18N.$t('featureLabel.remove_label') }}
      </a-button>
      <a-button
        type="dashed"
        block
        @click="deleteAllShape()"
        v-if="!props.isTwoFiveD && !featureImage.hasFeature"
        style="width: 100%; margin-bottom: 16px; height: 36px; margin-top: 16px"
      >
        {{ I18N.$t('featureLabel.remove_label') }}
      </a-button>

      <!-- 3D模式的操作按钮 -->
      <div v-if="props.isTwoFiveD && isLabelMode">
        <!-- 删除所有按钮 -->
        <a-button
          type="dashed"
          block
          @click="handleClearAllLabels3D()"
          v-if="props.isTwoFiveD && isLabelMode && labelCount3D.length"
          :disabled="isAutoLabeling"
        >
          {{ I18N.$t('xLabel.delete_all_labels_3d') }}
        </a-button>
      </div>
    </div>
  </Teleport>
</template>
<style scoped lang="less">
.mask-item {
  display: flex;
  padding: 4px 8px;
  box-shadow: 0 0 1px 1px rgba(0, 0, 0, 0.18);
  margin-right: 4px;
  margin-top: 8px;
  margin-bottom: 8px;
  cursor: pointer;
  border-left: 5px solid;

  &:hover {
    background: rgba(204, 204, 204, 0.8);
  }
}

.label-container {
  width: 100%;
  height: 100%;
  position: relative;
  overflow: hidden;
  padding: 10px;
  /* Hide scrollbars */
}

.zoomEle {
  width: 100%;
  height: 100%;
  text-align: center;
  position: relative;
  display: flex;
  justify-content: center;
  align-items: center;

  &.label-mode {
    cursor: crosshair;

    &:active {
      cursor: crosshair;
    }
  }

  &.view-mode {
    cursor: default;

    &:active {
      cursor: default;
    }
  }
}

.border-ok {
  border: 1px solid #4caf50;
}

.border-error {
  border: 1px solid #f00;
}

.status-indicator-3d {
  position: absolute;
  top: 10px;
  left: 10px;
  background: rgba(255, 255, 255, 0.8);
  padding: 5px 10px;
  border-radius: 4px;
  z-index: 100;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);

  .shortcuts {
    margin-top: 5px;
    font-size: 12px;
    color: #333;
  }
}

.info-panel {
  position: absolute;
  bottom: 10px;
  left: 10px;
  background: rgba(255, 255, 255, 0.8);
  padding: 5px 10px;
  border-radius: 4px;
  z-index: 100;

  .drawing-info,
  .labels-info {
    margin-bottom: 5px;
    font-size: 12px;
    color: #333;
  }
}

.auto-label-status {
  display: flex;
  align-items: center;
  padding: 8px;
  background: rgba(24, 144, 255, 0.1);
  border: 1px solid rgba(24, 144, 255, 0.3);
  border-radius: 4px;
  margin-bottom: 8px;
  font-size: 12px;
  color: #1890ff;
}

.camera-moving-status {
  display: flex;
  align-items: center;
  padding: 8px;
  background: rgba(255, 165, 0, 0.1);
  border: 1px solid rgba(255, 165, 0, 0.3);
  border-radius: 4px;
  margin-bottom: 8px;
  font-size: 12px;
  color: #ff8c00;
}
</style>
