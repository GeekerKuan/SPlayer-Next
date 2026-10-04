<script setup lang="ts">
import { useTogetherPresence } from "@/composables/useTogetherPresence";
defineProps<{ visible: boolean }>();
const { joined, participants, caption } = useTogetherPresence();
</script>
<template>
  <div class="together-audience" :aria-hidden="!visible">
    <TogetherAvatars
      :participants="participants"
      :joined="joined"
      layout="full"
      :visible="visible"
    />
    <p class="mt-3 text-center text-sm text-cover/60">{{ caption }}</p>
  </div>
</template>
<style scoped>
.together-audience {
  --together-avatar-size: clamp(48px, 9vh, 80px);
}
</style>
