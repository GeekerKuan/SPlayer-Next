<script setup lang="ts">
import { useTogetherDialog } from "@/composables/useTogetherDialog";
import { useTogetherStore } from "@/stores/together";

const { t } = useI18n();
const dialog = useTogetherDialog();
const together = useTogetherStore();
watch(dialog.open, (open) => {
  if (open && !together.busy) void together.connect();
});
</script>

<template>
  <SDialog
    v-model:open="dialog.open.value"
    :title="t('social.tabs.room')"
    :width="dialog.debug.value ? 'min(960px, 94vw)' : 'min(480px, 94vw)'"
    :height="dialog.debug.value ? 'min(720px, 85vh)' : 'min(620px, 85vh)'"
    destroy-on-close
    :content-style="{ display: 'flex', padding: '0 20px 20px', overflow: 'hidden' }"
  >
    <TogetherPanel v-if="dialog.debug.value" :peer-id="dialog.peerId.value" />
    <TogetherRoomPanel v-else :peer-id="dialog.peerId.value" />
  </SDialog>
</template>
