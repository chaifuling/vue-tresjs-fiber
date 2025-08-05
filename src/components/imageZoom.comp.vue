<script setup lang="ts">
import { onMounted, ref } from 'vue';
import Panzoom from '@panzoom/panzoom';

const zoomableElement = ref<HTMLElement>();
onMounted(() => {
  if (zoomableElement.value) {
    const panzoom = Panzoom(zoomableElement.value, {
      maxScale: 3,
      minScale: 1,
      contain: 'outside',
    });
    zoomableElement.value.addEventListener('wheel', panzoom.zoomWithWheel);
  }
});
</script>

<template>
  <div ref="zoomableElement" class="zoomable">
    <slot></slot>
  </div>
</template>

<style scoped>
.zoomable {
  width: 100%;
  height: 100%;
  overflow: hidden;
}
</style>
