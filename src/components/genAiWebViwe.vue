<template>
  <div>
    <div style="display: flex; justify-content: space-between; align-items: center">
      <a-button type="primary" @click="goBack">Back</a-button>
    </div>
    <iframe :src="iframeSrc" width="100%" height="100%"></iframe>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRoute } from 'vue-router';

const getLang = () => {
  const url = new URL(location.href);
  const params = new URLSearchParams(url.search);
  if (params.get('lang') == 'zh-CN') {
    return 'zh-hans';
  } else {
    return 'en';
  }
};

const route = useRoute();
const { projectId } = route.params as { projectId: string };
const locationIp = window.location.hostname;
const lang = getLang();

const iframeSrc = ref(`http://${locationIp}:8080/gen.html/#/featureCentral/featureGeneration?projectId=${projectId}&type=segmentation&lang=${lang}`);

const goBack = () => {
  window.history.back();
};
</script>

<style scoped lang="less">
iframe {
  border: none;
  width: calc(100vw - 100px);
  height: calc(100vh - 100px);
}

.back-button {
  position: absolute;
  left: 30px;
  top: 12px;
}
</style>
