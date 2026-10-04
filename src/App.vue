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
  },
);
let focusEpoch = 0;
let checkingClipboard = false;
/** 主窗口每次获得焦点读一次，失焦、销毁及账号变化后丢弃迟到结果。 */
async function checkInvitationClipboard(): Promise<void> {
  if (checkingClipboard || !document.hasFocus()) return;
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
    const together = useTogetherStore();
    dialog.show();
    if (!(await together.connect()) || epoch !== focusEpoch) return;
    if (!together.snapshot.roomId) await together.joinLink(invite.invitation);
    else if (together.snapshot.roomId !== invite.invitation.roomId)
      together.error = "already-in-room";
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
