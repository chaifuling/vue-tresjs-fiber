<script setup lang="ts">
import { ref, onMounted, watch, nextTick } from 'vue';
import { Tooltip } from 'ant-design-vue';

const props = defineProps<{
  text: string;
  width?: string;
  maxWidth?: string;
  disableTooltip?: boolean;
  placement?: 'top' | 'left' | 'right' | 'bottom' | 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight';
  className?: string;
  break?: boolean;
}>();

const containerRef = ref<HTMLElement | null>(null);
const isOverflow = ref(false);

const checkOverflow = () => {
  if (containerRef.value) {
    isOverflow.value = containerRef.value.scrollWidth > containerRef.value.clientWidth;
  }
};

onMounted(() => {
  nextTick(checkOverflow);
});

watch(
  () => props.text,
  () => nextTick(checkOverflow),
);
</script>

<template>
  <span v-if="props.break" :class="[props.className, 'ellipsis-text-break']" :style="{ width: props.width || '100%', maxWidth: props.maxWidth }">
    {{ text }}
  </span>
  <Tooltip v-else-if="isOverflow && !props.disableTooltip" :title="text" :placement="props.placement || 'top'">
    <span ref="containerRef" :class="['ellipsis-text', props.className]" :style="{ width: 'auto', maxWidth: props.maxWidth }">
      {{ text }}
    </span>
  </Tooltip>
  <span v-else ref="containerRef" :class="['ellipsis-text', props.className]" :style="{ width: 'auto', maxWidth: props.maxWidth }">
    {{ text }}
  </span>
</template>

<style scoped>
.ellipsis-text {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  display: inline-block;
  vertical-align: middle;
}

.ellipsis-text-break {
  word-break: break-word;
  white-space: normal;
  overflow-wrap: break-word;
}
</style>
