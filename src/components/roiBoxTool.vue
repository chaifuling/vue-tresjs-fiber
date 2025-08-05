<template>
  <a-space class="roiBoxTool-container" direction="vertical" :style="{ height: '100%' }">
    <a-row class="imageRoI-config">
      <div class="imageRoI-config-item">
        <a-form-item :label="I18N.$t('production.width')">
          <a-input-number
            :value="truncate(rectWidth / autoScale)"
            @change="handleWidthChange"
            :disabled="!imageUrl"
            :min="MIN_ROI_SIZE"
            :max="imageSize.width"
          />
        </a-form-item>
      </div>
      <div class="imageRoI-config-item">
        <a-form-item :label="I18N.$t('production.height')">
          <a-input-number
            :value="truncate(rectHeight / autoScale)"
            @change="handleHeightChange"
            :disabled="!imageUrl"
            :min="MIN_ROI_SIZE"
            :max="imageSize.height"
          />
        </a-form-item>
      </div>
    </a-row>
    <div v-if="imageInfo" style="display: flex; justify-content: space-between; align-items: center; padding: 0 12px; margin: 8px">
      <div>
        <ellipsis-text :text="imageInfo.ccName" max-width="600px" />
      </div>
      <div>
        <ellipsis-text :text="imageInfo.name" max-width="300px" />
      </div>
    </div>

    <div
      class="roiClippingTool-container"
      :style="{
        display: 'flex',
        justifyContent: 'center',
        height: '100%',
        minWidth: `${imageSize.width * autoScale}px`,
        minHeight: `${imageSize.height * autoScale}px`,
      }"
    >
      <template v-if="imageUrl">
        <div class="roiClippingTool">
          <div ref="stageContainer" id="konva-container"></div>
        </div>
      </template>
      <template v-else>
        <a-empty class="roiClippingTool-empty" description="No image uploaded" />
      </template>
    </div>
  </a-space>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import Konva from 'konva';
import { message } from 'ant-design-vue';
import { I18N } from '@/utils/i18n.util.ts';
import _ from 'lodash';
import EllipsisText from '@/components/ellipsisText.comp.vue';
import { getAttachmentPath } from '@/utils/path.util';
import { V3dApi } from '@/api/v3d/v3d.api';
import { ImageType } from '@/type/image.type';

// Props & Emits
const props = defineProps({
  removeROI: Boolean,
  resetROI: Boolean,
  originalROI: {
    type: Object,
    default: (): {
      startPoint: { x: number | null; y: number | null };
      anchorPoint: { x: number | null; y: number | null };
      width: number;
      height: number;
    } => ({
      startPoint: { x: null, y: null },
      anchorPoint: { x: null, y: null },
      width: 64,
      height: 64,
    }),
  },
  imagePath: {
    type: String,
    default: '',
  },
  imageInfo: {
    type: Object,
    default: () => ({
      name: '',
      ccName: '',
      type: '',
      imageUuid: '',
    }),
  },
  config: {
    type: Object,
    default(): {
      startPoint: { x: number | null; y: number | null };
      anchorPoint: { x: number | null; y: number | null };
      width: number;
      height: number;
    } {
      return {
        startPoint: { x: null, y: null },
        anchorPoint: { x: null, y: null },
        width: 64,
        height: 64,
      };
    },
  },
});
const emit = defineEmits(['change', 'rule']);

// Constants
const MIN_ROI_SIZE = 64;
const ANCHOR_SIZE = 16;

// Computed constants based on window size
const _IMAGE_WIDTH = window.innerWidth * 0.7;
const _IMAGE_HEIGHT = window.innerHeight * 0.7;

// State
const imageUrl = ref<string | null>(null);
const autoScale = ref<number>(1);
// const isDragging = ref<boolean>(false);
const imageSize = reactive<{ width: number; height: number }>({ width: 0, height: 0 });
const stageContainer = ref<HTMLDivElement | null>(null);
const validationError = ref<string>('');

// ROI rectangle coordinates (in scaled units)
const rectX = ref<number>(0);
const rectY = ref<number>(0);
const rectWidth = ref<number>(0);
const rectHeight = ref<number>(0);
const needUpdate = ref<boolean>(true);

// Konva objects
let stage: Konva.Stage | null = null;
let layer: Konva.Layer | null = null;
let backgroundLayer: Konva.Layer | null = null;
let rectShape: Konva.Rect | null = null;
let imageNode: Konva.Image | null = null;
let transformer: Konva.Transformer | null = null;
let imageObj: HTMLImageElement | null = null;
let overlay: Konva.Rect | null = null;
let mask: Konva.Rect | null = null;

// Utils
const truncate = (num: number) => (num !== undefined && num !== null ? Math.round(num) : num);

const originalROIBoxToolConfig = computed<{ anchorPoint: { x: number; y: number }; startPoint: { x: number; y: number }; width: number; height: number }>(
  () => ({
    anchorPoint: { x: props.originalROI?.anchorPoint?.x, y: props.originalROI?.anchorPoint?.y },
    startPoint: { x: props.originalROI?.startPoint?.x, y: props.originalROI?.startPoint?.y },
    width: props.originalROI?.width,
    height: props.originalROI?.height,
  }),
);

// Validation
const validateROI = () => {
  const unscaledWidth: number = rectWidth.value / autoScale.value;
  const unscaledHeight: number = rectHeight.value / autoScale.value;

  if (unscaledWidth < MIN_ROI_SIZE || unscaledHeight < MIN_ROI_SIZE) {
    setRectError(true);
    return false;
  }

  if (unscaledWidth > imageSize.width || unscaledHeight > imageSize.height) {
    rectWidth.value = imageSize.width * autoScale.value;
    rectHeight.value = imageSize.height * autoScale.value;
    rectX.value = 0;
    rectY.value = 0;
    setRectError(true);
    message.info(I18N.$t('network.roi.size.exceed.image.size'));
    return false;
  }

  validationError.value = '';
  setRectError(false);
  return true;
};

const setRectError = (hasError: boolean) => {
  if (rectShape) {
    rectShape.stroke(hasError ? '#FF4D4F' : '#555E97');
    layer?.batchDraw();
  }
};

// Emit ROI changes
const emitROIChange = (needUpdate: boolean = true) => {
  let scaledRect;
  if (!needUpdate) {
    scaledRect = props.config;
  } else {
    scaledRect = {
      startPoint: { x: rectX.value / autoScale.value, y: rectY.value / autoScale.value },
      anchorPoint: {
        x: (rectX.value + rectWidth.value) / autoScale.value,
        y: (rectY.value + rectHeight.value) / autoScale.value,
      },
      width: rectWidth.value / autoScale.value,
      height: rectHeight.value / autoScale.value,
    };
  }
  validateROI();
  emit('change', scaledRect);
};

// Handle dimensions changes
const handleWidthChange = (value: number) => {
  if (value === null || value === undefined) return;

  const scaledValue = value * autoScale.value;
  rectWidth.value = scaledValue;
  if (rectWidth.value + rectX.value > imageSize.width * autoScale.value) {
    rectWidth.value = Math.min(imageSize.width * autoScale.value, rectWidth.value);
    rectX.value = Math.max(0, imageSize.width * autoScale.value - rectWidth.value);
  }
  emitROIChange();
};

const handleHeightChange = (value: number) => {
  if (value === null || value === undefined) return;

  const scaledValue = value * autoScale.value;
  rectHeight.value = scaledValue;
  if (rectHeight.value + rectY.value > imageSize.height * autoScale.value) {
    rectHeight.value = Math.min(imageSize.height * autoScale.value, rectHeight.value);
    rectY.value = Math.max(0, imageSize.height * autoScale.value - rectHeight.value);
  }
  emitROIChange();
};

// Helper for reset/remove ROI
const getROIPoint = (point: { x: number; y: number }, originalPoint: { x: number; y: number }, isRemove: boolean, isReset: boolean) => {
  if (isRemove) return { x: null, y: null };
  if (isReset) return originalPoint;
  return point;
};

// Initialize Konva stage and configure rectangle
const initKonva = () => {
  if (!stageContainer.value || !imageUrl.value) return;

  // Clean up previous stage
  stage?.destroy();

  // Create stage
  stage = new Konva.Stage({
    container: stageContainer.value,
    width: imageSize.width * autoScale.value,
    height: imageSize.height * autoScale.value,
  });

  // Create layers
  backgroundLayer = new Konva.Layer();
  layer = new Konva.Layer();

  // Add image to background layer
  imageNode = new Konva.Image({
    image: imageObj,
    width: imageSize.width * autoScale.value,
    height: imageSize.height * autoScale.value,
  });
  backgroundLayer.add(imageNode);

  // Create overlay
  overlay = new Konva.Rect({
    x: 0,
    y: 0,
    width: stage.width(),
    height: stage.height(),
    fill: 'rgba(255, 255, 255, 0.3)',
  });
  layer.add(overlay);

  // Create ROI rectangle
  rectShape = new Konva.Rect({
    x: rectX.value,
    y: rectY.value,
    width: rectWidth.value,
    height: rectHeight.value,
    stroke: '#795EFF',
    strokeWidth: 0,
    dash: [0],
    draggable: true,
    name: 'roi-rect',
    dragBoundFunc: function (pos) {
      return {
        x: Math.max(0, Math.min(pos.x, stage.width() - this.width())),
        y: Math.max(0, Math.min(pos.y, stage.height() - this.height())),
      };
    },
  });

  // Create mask for cutout effect
  mask = new Konva.Rect({
    x: rectX.value,
    y: rectY.value,
    width: rectWidth.value,
    height: rectHeight.value,
    globalCompositeOperation: 'destination-out',
    fill: 'black',
  });
  layer.add(mask);
  layer.add(rectShape);

  // Create transformer
  transformer = new Konva.Transformer({
    nodes: [rectShape],
    rotateEnabled: false,
    enabledAnchors: ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
    anchorSize: ANCHOR_SIZE,
    anchorStroke: '#795EFF',
    anchorStrokeWidth: 2,
    anchorFill: 'white',
    borderStroke: '#795EFF',
    borderDash: [0],
    boundBoxFunc: (oldBox, newBox) => {
      // Enforce size constraints
      newBox.width = Math.min(Math.max(MIN_ROI_SIZE, newBox.width), stage.width());
      newBox.height = Math.min(Math.max(MIN_ROI_SIZE, newBox.height), stage.height());

      // Keep within stage boundaries
      newBox.x = Math.min(Math.max(0, newBox.x), stage.width() - newBox.width);
      newBox.y = Math.min(Math.max(0, newBox.y), stage.height() - newBox.height);

      if (newBox.x + newBox.width > stage.width() || newBox.y + newBox.height > stage.height()) {
        newBox.width = stage.width();
        newBox.height = stage.height();
        newBox.x = 0;
        newBox.y = 0;
      }
      return newBox;
    },
  });
  layer.add(transformer);

  // Add layers to stage
  stage.add(backgroundLayer);
  stage.add(layer);

  // Handle events
  attachKonvaEvents();

  // Update rectangle and mask when reactive values change
  watch([rectX, rectY, rectWidth, rectHeight], () => {
    if (rectShape) {
      rectShape.setAttrs({
        x: rectX.value,
        y: rectY.value,
        width: rectWidth.value,
        height: rectHeight.value,
      });

      mask.setAttrs({
        x: rectX.value,
        y: rectY.value,
        width: rectWidth.value,
        height: rectHeight.value,
      });

      layer.batchDraw();
    }
  });
};

// Attach events to Konva objects
const attachKonvaEvents = () => {
  // Handle click to create new ROI
  // stage.on('mousedown', (e) => {
  //   if (e.target === stage || e.target === imageNode || e.target === overlay) {
  //     const pos = stage.getRelativePointerPosition();
  //     const boundedX = Math.max(0, Math.min(pos.x, stage.width()));
  //     const boundedY = Math.max(0, Math.min(pos.y, stage.height()));

  //     rectX.value = boundedX;
  //     rectY.value = boundedY;
  //     rectWidth.value = 0;
  //     rectHeight.value = 0;

  //     updateShapePositions();

  //     isDragging.value = true;

  //     // Temporary event handlers for drawing
  //     const moveHandler = () => {
  //       if (!isDragging.value) return;

  //       const newPos = stage.getRelativePointerPosition();
  //       const newWidth = newPos.x - rectX.value;
  //       const newHeight = newPos.y - rectY.value;

  //       // Handle negative dimensions
  //       if (newWidth < 0) {
  //         const newX = Math.max(0, newPos.x);
  //         rectWidth.value = rectX.value - newX;
  //         rectX.value = newX;
  //       } else {
  //         rectWidth.value = Math.min(newWidth, stage.width() - rectX.value);
  //       }

  //       if (newHeight < 0) {
  //         const newY = Math.max(0, newPos.y);
  //         rectHeight.value = rectY.value - newY;
  //         rectY.value = newY;
  //       } else {
  //         rectHeight.value = Math.min(newHeight, stage.height() - rectY.value);
  //       }

  //       updateShapePositions();
  //       emitROIChange();
  //     };

  //     const upHandler = () => {
  //       isDragging.value = false;
  //       stage.off('mousemove', moveHandler);
  //       stage.off('mouseup', upHandler);

  //       // Enforce minimum size
  //       if (rectWidth.value < MIN_ROI_SIZE || rectHeight.value < MIN_ROI_SIZE) {
  //         rectWidth.value = Math.min(MIN_ROI_SIZE, stage.width() - rectX.value);
  //         rectHeight.value = Math.min(MIN_ROI_SIZE, stage.height() - rectY.value);
  //         updateShapePositions();
  //       }

  //       transformer.nodes([rectShape]);
  //       layer.batchDraw();
  //     };

  //     stage.on('mousemove', moveHandler);
  //     stage.on('mouseup', upHandler);

  //     transformer.nodes([]);
  //     layer.batchDraw();
  //     emitROIChange();
  //   }
  // });

  // Handle rectangle drag
  rectShape.on('dragmove', () => {
    rectX.value = rectShape.x();
    rectY.value = rectShape.y();

    mask.setAttrs({
      x: rectShape.x(),
      y: rectShape.y(),
    });

    layer.batchDraw();
    emitROIChange();
  });

  // Handle transform
  rectShape.on('transform', () => {
    const node = transformer.nodes()[0];
    const scaleX = node.scaleX();
    const scaleY = node.scaleY();

    node.scaleX(1);
    node.scaleY(1);

    rectX.value = node.x();
    rectY.value = node.y();

    const newWidth = node.width() * scaleX;
    const newHeight = node.height() * scaleY;

    if (newWidth / autoScale.value < MIN_ROI_SIZE || newHeight / autoScale.value < MIN_ROI_SIZE) {
      rectWidth.value = MIN_ROI_SIZE * autoScale.value;
      rectHeight.value = MIN_ROI_SIZE * autoScale.value;
      validationError.value = `ROI size cannot be smaller than ${MIN_ROI_SIZE}x${MIN_ROI_SIZE} pixels`;
      setRectError(true);
    } else if (newWidth / autoScale.value > imageSize.width || newHeight / autoScale.value > imageSize.height) {
      validationError.value = 'ROI size cannot exceed image dimensions';
      setRectError(true);
      rectWidth.value = Math.min(newWidth, imageSize.width * autoScale.value);
      rectHeight.value = Math.min(newHeight, imageSize.height * autoScale.value);
    } else {
      rectWidth.value = newWidth;
      rectHeight.value = newHeight;
      validationError.value = '';
      setRectError(false);
    }

    node.setAttrs({
      width: rectWidth.value,
      height: rectHeight.value,
    });

    updateShapePositions();
    emitROIChange();
  });
};

// Update shape positions
const updateShapePositions = () => {
  rectShape?.setAttrs({
    x: rectX.value,
    y: rectY.value,
    width: rectWidth.value,
    height: rectHeight.value,
  });

  mask?.setAttrs({
    x: rectX.value,
    y: rectY.value,
    width: rectWidth.value,
    height: rectHeight.value,
  });

  layer?.batchDraw();
};

// Load and initialize image
const loadImage = async (url: string) => {
  imageUrl.value = null;
  if (!url) return;

  let finalUrl = url;

  if (props.imageInfo?.type === ImageType.IMAGE_2_5_d) {
    // get top view of 25d images
    const params = {
      v3dmPath: url,
      factor: 4,
      imageUuId: props.imageInfo?.imageUuid,
    };
    const result = await V3dApi.getAll25DTopViews(params);
    if (result.success && result.data) {
      finalUrl = getAttachmentPath(result.data);
    } else {
      return;
    }
  } else {
    finalUrl = getAttachmentPath(url);
  }

  imageUrl.value = finalUrl;
  imageObj = new Image();
  imageObj.crossOrigin = 'Anonymous';
  imageObj.onload = () => {
    // Calculate scale
    const scale = Math.min(_IMAGE_WIDTH / imageObj.width, _IMAGE_HEIGHT / imageObj.height, 1);

    autoScale.value = scale;
    imageSize.width = imageObj.width;
    imageSize.height = imageObj.height;

    // Setup initial rectangle
    setupInitialRectangle();

    // Initialize Konva
    nextTick(() => {
      initKonva();
      emitROIChange(needUpdate.value);
    });
  };
  imageObj.src = finalUrl;
};

// Setup initial rectangle based on props
const setupInitialRectangle = () => {
  const sp = getROIPoint(props.config?.startPoint, originalROIBoxToolConfig.value.startPoint, props.removeROI, props.resetROI);

  const ap = getROIPoint(props.config?.anchorPoint, originalROIBoxToolConfig.value.anchorPoint, props.removeROI, props.resetROI);

  needUpdate.value = true;
  if (sp?.x !== null && sp?.y !== null) {
    // Calculate dimensions
    let width, height;
    if (ap?.x !== null && ap?.y !== null) {
      width = Math.abs((ap.x || 0) - (sp.x || 0));
      height = Math.abs((ap.y || 0) - (sp.y || 0));
    } else {
      width = props.config?.width || imageSize.width;
      height = props.config?.height || imageSize.height;
    }

    // Adjust position to fit within image
    let startX = Math.max(0, sp.x);
    let startY = Math.max(0, sp.y);
    if (startX + width > imageSize.width || startY + height > imageSize.height) {
      startX = 0;
      startY = 0;
      width = imageSize.width;
      height = imageSize.height;
      message.info(I18N.$t('network.roi.size.exceed.image.size'));
      needUpdate.value = false;
    }

    startX = Math.max(0, startX);
    startY = Math.max(0, startY);

    // Set values
    rectX.value = startX * autoScale.value;
    rectY.value = startY * autoScale.value;
    rectWidth.value = width * autoScale.value;
    rectHeight.value = height * autoScale.value;
  } else {
    // Default values - use config values if available, otherwise 90% of canvas size
    const defaultWidth = props.config?.width || imageSize.width * 0.9;
    const defaultHeight = props.config?.height || imageSize.height * 0.9;

    // Center the rectangle
    rectX.value = ((imageSize.width - defaultWidth) / 2) * autoScale.value;
    rectY.value = ((imageSize.height - defaultHeight) / 2) * autoScale.value;
    rectWidth.value = defaultWidth * autoScale.value;
    rectHeight.value = defaultHeight * autoScale.value;

    needUpdate.value = false;
  }
};

// Handle window resize
const handleResize = () => {
  if (!stage || !imageObj) return;

  const scale = Math.min(_IMAGE_WIDTH / imageObj.width, _IMAGE_HEIGHT / imageObj.height, 1);

  autoScale.value = scale;

  // Resize stage and elements
  stage.width(imageSize.width * scale);
  stage.height(imageSize.height * scale);

  if (imageNode) {
    imageNode.width(imageSize.width * scale);
    imageNode.height(imageSize.height * scale);
  }

  if (overlay) {
    overlay.width(stage.width());
    overlay.height(stage.height());
  }

  stage.batchDraw();
};

// Handle reset and remove of ROI
const handleROIReset = (removeROI: boolean, resetROI: boolean) => {
  if (!imageObj) return;

  if (removeROI) {
    // Reset to zero size
    rectX.value = 0;
    rectY.value = 0;
    rectWidth.value = 0;
    rectHeight.value = 0;
    updateShapePositions();
    emitROIChange();
  } else if (resetROI && props.originalROI) {
    // Reset to original values
    const sp = getROIPoint(originalROIBoxToolConfig.value.startPoint, null, false, false);
    const ap = getROIPoint(originalROIBoxToolConfig.value.anchorPoint, null, false, false);

    if (sp?.x !== null && sp?.y !== null && ap?.x !== null && ap?.y !== null) {
      rectX.value = Math.min(sp.x, ap.x) * autoScale.value;
      rectY.value = Math.min(sp.y, ap.y) * autoScale.value;
      rectWidth.value = Math.abs(ap.x - sp.x) * autoScale.value;
      rectHeight.value = Math.abs(ap.y - sp.y) * autoScale.value;
      updateShapePositions();
      emitROIChange();
    }
  }
};

// Watch for changes
watch(
  () => props.imagePath,
  async (newVal) => {
    if (newVal) {
      await loadImage(newVal);
    }
  },
);
watch([() => props.removeROI, () => props.resetROI], ([removeROI, resetROI]) => {
  handleROIReset(removeROI, resetROI);
});
watch([rectWidth, rectHeight], validateROI);

// Lifecycle hooks
onMounted(async () => {
  await loadImage(props.imagePath);
  window.addEventListener('resize', handleResize);
});

onUnmounted(() => {
  window.removeEventListener('resize', handleResize);
  stage?.destroy();
  stage = null;
});
</script>

<style scoped lang="less">
.imageRoI-config {
  border-bottom: 1px solid #d9d9d9;
  padding: 18px;
  display: flex;
  gap: 16px;
}

.imageRoI-config-item {
  margin-right: 18px;
  display: flex;
  font-size: 16px;
  text-align: center;

  :deep(.ant-form-item) {
    margin-bottom: 0;
  }
}

.roiClippingTool-container {
  display: flex;
  justify-content: center;
  align-items: center;
  margin-top: 12px;
}

.roiClippingTool {
  display: inline-block;
  position: relative;
}

.roiBoxTool-container {
  width: 100%;
  height: 100%;
}

.roiClippingTool-empty {
  margin-top: 100px;
  margin-bottom: 100px;
}

.validation-error {
  color: #ff4d4f;
  margin-bottom: 16px;
  font-weight: bold;
  padding: 8px 12px;
  background-color: rgba(255, 77, 79, 0.1);
  border-radius: 0px;
  text-align: center;
}
</style>
