<script setup lang="ts">
import { withPicSize } from "@/utils/format/netease";

const props = withDefaults(defineProps<{ src?: string; name: string; imageSize?: number }>(), {
  imageSize: 80,
});
const source = computed(() => withPicSize(props.src, props.imageSize));
const displayed = ref<string>();
let pending: HTMLImageElement | undefined;
const initial = computed(() => Array.from(props.name.trim())[0] || "?");

/** 解码后原位替换头像；刷新 URL 时保留已显示图片，迟到结果由 watcher 清理失效。 */
watch(
  source,
  (value, previous, onCleanup) => {
    let cancelled = false;
    if (!value) {
      displayed.value = undefined;
      return;
    }
    const sameAsset = (url: string): string =>
      url.replace(/^http:/, "https:").replace(/\?param=.*$/, "");
    if (previous && sameAsset(value) === sameAsset(previous) && displayed.value) return;
    const candidate = new Image();
    pending = candidate;
    candidate.referrerPolicy = "no-referrer";
    candidate.src = value;
    void candidate
      .decode()
      .then(() => {
        if (!cancelled) displayed.value = value;
      })
      .catch(() => {
        /* 已显示的头像在换源失败时保留。 */
      });
    onCleanup(() => {
      cancelled = true;
      candidate.src = "";
      if (pending === candidate) pending = undefined;
    });
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  if (pending) pending.src = "";
  pending = undefined;
});
</script>

<template>
  <span
    class="relative size-10 shrink-0 overflow-hidden rounded-full bg-primary/12 text-primary flex items-center justify-center"
  >
    <span aria-hidden="true" class="text-sm font-medium">{{ initial }}</span>
    <img
      v-if="displayed"
      :src="displayed"
      alt=""
      class="absolute inset-0 size-full object-cover"
      decoding="async"
      loading="lazy"
      referrerpolicy="no-referrer"
      @error="displayed = undefined"
    />
  </span>
</template>
