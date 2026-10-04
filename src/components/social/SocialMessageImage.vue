<script setup lang="ts">
import { openExternal } from "@/utils/url";

const props = defineProps<{ src: string; width?: number; height?: number }>();
const { t } = useI18n();
const ready = ref(false);
const failed = ref(false);
const attempt = ref(0);
const measured = shallowRef<{ width: number; height: number }>();
let generation = 0;
let disposed = false;
const frame = computed(() => {
  const width = measured.value?.width || props.width || 240;
  const height = measured.value?.height || props.height || 180;
  const scale = Math.min(1, 240 / width, 280 / height);
  return {
    width: `${Math.max(1, Math.round(width * scale))}px`,
    maxWidth: "100%",
    aspectRatio: `${width} / ${height}`,
  };
});
watch(
  () => props.src,
  () => {
    generation++;
    ready.value = failed.value = false;
    measured.value = undefined;
  },
);
/** 使用浏览器已有图片解码，不额外预加载原图；变高由聊天虚拟列表维持锚点。 */
async function loaded(event: Event): Promise<void> {
  const current = generation;
  const image = event.target as HTMLImageElement;
  await image.decode().catch(() => {});
  if (disposed || current !== generation) return;
  if (image.naturalWidth && image.naturalHeight)
    measured.value = { width: image.naturalWidth, height: image.naturalHeight };
  ready.value = true;
}
function retry(): void {
  generation++;
  failed.value = ready.value = false;
  attempt.value++;
}
onBeforeUnmount(() => {
  disposed = true;
  generation++;
});
</script>

<template>
  <div class="message-image relative rounded-lg overflow-hidden bg-on-surface/4" :style="frame">
    <button
      v-if="failed"
      class="absolute inset-0 flex flex-col items-center justify-center gap-2 border-none bg-transparent text-on-surface-variant cursor-pointer text-xs"
      @click="retry"
    >
      <IconLucideImageOff class="size-5" />
      {{ t("social.image.retry") }}
    </button>
    <button
      v-else
      class="absolute inset-0 block w-full h-full border-none p-0 bg-transparent cursor-pointer focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
      :aria-label="t('social.image.open')"
      @click="openExternal(src)"
    >
      <span
        v-if="!ready"
        class="absolute inset-0 flex items-center justify-center text-on-surface-variant"
        aria-hidden="true"
      >
        <IconLucideImage class="size-6" />
      </span>
      <img
        :key="`${src}:${attempt}`"
        :src="src"
        :alt="t('social.cards.image')"
        class="w-full h-full object-contain transition-opacity duration-150"
        :class="ready ? 'opacity-100' : 'opacity-0'"
        decoding="async"
        loading="lazy"
        referrerpolicy="no-referrer"
        @load="loaded"
        @error="failed = true"
      />
    </button>
  </div>
</template>
