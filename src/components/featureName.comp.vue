<script setup lang="ts">
import { Feature } from '@/api/train/project.api.ts';
import { DependencyType } from '@/type/feature.type.ts';
import { I18N } from '@/utils/i18n.util.ts';
import backgroundDepend from '@/assets/icon/backgroundDepend.svg';
import surfaceIndependent from '@/assets/icon/surfaceIndependent.svg';
import incrementalIcon from '@/assets/icon/incremental.svg';

defineProps<{
  feature: Feature;
  color?: string;
  bgColor?: string;
  isIncremental?: boolean;
}>();
</script>

<template>
  <span v-if="feature.dependencyType == DependencyType.BACKGROUND_DEPENDENT" style="display: inline-flex; align-items: center; vertical-align: -0.2em">
    <a-tooltip :title="I18N.$t('feature.background_dependent')">
      <img :src="backgroundDepend" alt="backgroundDepend" />
    </a-tooltip>
  </span>
  <span v-if="feature.dependencyType == DependencyType.SURFACE_INDEPENDENT">
    <a-tooltip :title="I18N.$t('feature.surface_independent')">
      <img :src="surfaceIndependent" alt="surfaceIndependent" />
    </a-tooltip>
  </span>
  <span style="padding-left: 6px; color: #333333">{{ feature.name }}</span>
  <a-tooltip placement="top" v-if="isIncremental">
    <template #title>
      {{ I18N.$t('network.advanced_training') }}
    </template>
    <img :src="incrementalIcon" style="width: 16px; height: 16px" />
  </a-tooltip>
</template>

<style scoped lang="less"></style>
