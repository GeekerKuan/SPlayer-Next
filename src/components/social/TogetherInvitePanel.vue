<script setup lang="ts">
import type { TogetherClipboardInvite, TogetherInvitePreview } from "@shared/types/together";
import { useTogetherDialog } from "@/composables/useTogetherDialog";
import { useTogetherStore } from "@/stores/together";
import { useUserStore } from "@/stores/user";
import { withPicSize } from "@/utils/format/netease";

const props = defineProps<{ invite: TogetherClipboardInvite }>();
const { t } = useI18n();
const dialog = useTogetherDialog();
const together = useTogetherStore();
const user = useUserStore();
const preview = shallowRef<TogetherInvitePreview>();
const loading = ref(false);
const error = ref("");
let generation = 0;
let mounted = true;
const blur = (): void => {
  generation++;
  loading.value = false;
  void window.api.together.cancelPreview();
};
const inviter = computed(
  () =>
    preview.value?.inviter || {
      id: props.invite.invitation?.inviterId || "",
      name: props.invite.invitation?.inviterId || "?",
    },
);
const otherRoom = computed(
  () => !!together.snapshot.roomId && together.snapshot.roomId !== props.invite.invitation?.roomId,
);
const errorText = computed(() =>
  error.value ? t(`social.errors.${error.value}`, t("social.errors.offline")) : "",
);

/** 失焦、关窗、换邀请后不保留元数据请求；重新聚焦可重试，不建立轮询。 */
async function load(): Promise<void> {
  if (!mounted || loading.value || preview.value || !document.hasFocus() || !user.profile) return;
  const current = ++generation;
  loading.value = true;
  error.value = "";
  try {
    const result = await window.api.together.previewInvite(props.invite);
    if (!mounted || current !== generation) return;
    if (result.ok) preview.value = result.data;
    else error.value = result.error === "cancelled" ? "" : result.error;
  } catch {
    if (mounted && current === generation) error.value = "offline";
  } finally {
    if (mounted && current === generation) loading.value = false;
  }
}
async function accept(): Promise<void> {
  if (
    !props.invite.invitation ||
    together.busy ||
    !user.profile ||
    preview.value?.joinable === false
  )
    return;
  const current = generation;
  error.value = "";
  if (!(await together.connect()) || !mounted || current !== generation) {
    if (mounted && current === generation) error.value = together.error;
    return;
  }
  if (otherRoom.value) {
    error.value = "already-in-room";
    return;
  }
  if (together.snapshot.roomId === props.invite.invitation.roomId) {
    dialog.show();
    return;
  }
  const joined = await together.joinLink(props.invite.invitation);
  if (!mounted || current !== generation) return;
  if (joined) dialog.show();
  else error.value = together.error;
}
watch(
  () => props.invite,
  () => {
    generation++;
    loading.value = false;
    preview.value = undefined;
    void window.api.together.cancelPreview().then(load);
  },
);
onMounted(() => {
  window.addEventListener("focus", load);
  window.addEventListener("blur", blur);
  void load();
});
onBeforeUnmount(() => {
  mounted = false;
  generation++;
  window.removeEventListener("focus", load);
  window.removeEventListener("blur", blur);
  void window.api.together.cancelPreview();
});
</script>

<template>
  <div class="flex flex-1 min-h-0 flex-col gap-5 pt-4">
    <div class="flex flex-col items-center text-center gap-4">
      <div class="flex items-center gap-5">
        <SocialAvatar
          :src="user.profile?.avatarUrl"
          :name="user.profile?.nickname || '?'"
          class="size-16!"
          :image-size="160"
        />
        <IconLucideHeadphones class="size-6 text-on-surface-variant" />
        <SocialAvatar
          :src="inviter.avatar"
          :name="inviter.name"
          class="size-16!"
          :image-size="160"
        />
      </div>
      <h2 class="text-base font-medium break-words">
        {{ t("social.together.previewFrom", { name: inviter.name }) }}
      </h2>
      <p class="text-sm text-on-surface-variant">{{ t("social.together.shareText") }}</p>
    </div>
    <SCard class="p-4">
      <p class="text-xs text-on-surface-variant mb-3">{{ t("social.together.invitationSong") }}</p>
      <div v-if="preview?.song" class="flex items-center gap-3 min-w-0">
        <img
          v-if="preview.song.cover"
          :src="withPicSize(preview.song.cover, 120)"
          class="size-12 rounded-lg object-cover shrink-0"
          alt=""
          decoding="async"
          referrerpolicy="no-referrer"
        />
        <div class="min-w-0">
          <p class="truncate text-sm">{{ preview.song.name }}</p>
          <p class="truncate text-xs text-on-surface-variant mt-1">{{ preview.song.artists }}</p>
        </div>
      </div>
      <p v-else class="text-sm text-on-surface-variant" role="status">
        {{ t(loading ? "social.together.previewLoading" : "social.together.noInvitationSong") }}
      </p>
    </SCard>
    <p v-if="preview?.joinable === false" class="text-sm text-on-surface-variant" role="status">
      {{ preview.hint || t("social.together.inviteExpired") }}
    </p>
    <p v-else-if="!user.profile" class="text-sm text-on-surface-variant" role="status">
      {{ t("social.login") }}
    </p>
    <p v-else-if="otherRoom" class="text-sm text-on-surface-variant" role="status">
      {{ t("social.errors.already-in-room") }}
    </p>
    <p v-if="errorText" class="text-xs text-error" role="status">{{ errorText }}</p>
    <div class="mt-auto flex flex-col gap-2">
      <SButton v-if="otherRoom" type="primary" :disabled="together.busy" @click="dialog.show()">
        {{ t("social.together.viewCurrentRoom") }}
      </SButton>
      <SButton
        v-else
        type="primary"
        :loading="together.busy"
        :disabled="!user.profile || preview?.joinable === false"
        @click="accept"
      >
        {{ t("social.accept") }}
      </SButton>
      <SButton v-if="errorText && user.profile" variant="text" :loading="loading" @click="load">
        {{ t("social.together.retry") }}
      </SButton>
      <SButton variant="secondary" :disabled="together.busy" @click="dialog.open.value = false">
        {{ t("common.cancel") }}
      </SButton>
    </div>
  </div>
</template>
