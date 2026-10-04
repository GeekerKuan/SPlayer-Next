<script setup lang="ts">
import { useSettingsStore } from "@/stores/settings";
const settings = useSettingsStore();
const { t } = useI18n();
const error = ref("");
const busy = ref(false);
async function choose(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const result = await window.api.together.chooseClient();
    if (result.ok) settings.system.system.socialDesktopExecutable = result.data;
    else if (result.error !== "cancelled")
      error.value = t(`social.errors.${result.error}`, result.error);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div class="flex flex-col gap-2">
    <div class="flex gap-3 items-center">
      <p class="flex-1 min-w-0 text-sm break-all text-on-surface-variant">
        {{ settings.system.system.socialDesktopExecutable || t("social.together.noClient") }}
      </p>
      <SButton size="small" :loading="busy" @click="choose">
        {{ t("social.together.chooseClient") }}
      </SButton>
    </div>
    <p v-if="error" role="alert" class="text-error text-sm">{{ error }}</p>
  </div>
</template>
