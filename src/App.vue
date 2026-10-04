<script setup lang="ts">
import { useSettingsStore } from "@/stores/settings";
import { useSocialStore } from "@/stores/social";
import { useTogetherStore } from "@/stores/together";
import { useTogetherDialog } from "@/composables/useTogetherDialog";
import { useCrossDevice } from "@/composables/useCrossDevice";
import { useUserStore } from "@/stores/user";
useCrossDevice();
watch(
  () => useUserStore().profile?.userId,
  () => {
    focusEpoch++;
    const dialog = useTogetherDialog();
    if (dialog.clipboardInvite.value) dialog.open.value = false;
    void window.api.together.cancelPreview();
  },
);
let focusEpoch = 0;
let checkingClipboard = false;
/** 主窗口每次获得焦点读一次，失焦、销毁及账号变化后丢弃迟到结果。 */
async function checkInvitationClipboard(): Promise<void> {
  if (checkingClipboard || !document.hasFocus() || useTogetherDialog().open.value) return;
  const epoch = ++focusEpoch;
  checkingClipboard = true;
  try {
    const result = await window.api.together.readClipboardInvite();
    if (epoch !== focusEpoch || !document.hasFocus() || !result.ok || !result.data) return;
    const invite = result.data;
    const dialog = useTogetherDialog();
    if (!invite.invitation) {
      dialog.showLink(invite.url);
      return;
    }
    dialog.showInvitation(invite);
  } catch {
    /* 剪贴板访问失败不影响播放器启动。 */
  } finally {
    checkingClipboard = false;
  }
}
const invalidateFocus = (): void => {
  focusEpoch++;
};
const router = useRouter();
let unsubscribe: (() => void) | null = null;
onMounted(() => {
  useTogetherStore().start();
  window.addEventListener("focus", checkInvitationClipboard);
  window.addEventListener("blur", invalidateFocus);
  void checkInvitationClipboard();
  unsubscribe = window.api.social.onNavigate(async (peerId) => {
    await router.push({ name: "messages" });
    await useSocialStore().select(peerId);
  });
});
onBeforeUnmount(() => {
  unsubscribe?.();
  invalidateFocus();
  window.removeEventListener("focus", checkInvitationClipboard);
  window.removeEventListener("blur", invalidateFocus);
  useTogetherStore().dispose();
  void window.api.together.cancelPreview();
});

watchEffect(() => {
  const v = useSettingsStore().appearance.fontFamily;
  const root = document.documentElement.style;
  if (v) root.setProperty("--user-font", `${v}, var(--app-font)`);
  else root.removeProperty("--user-font");
});
</script>

<template>
  <AppBackground />
  <RouterView />
</template>
