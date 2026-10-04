<script setup lang="ts">
import { useTogetherStore } from "@/stores/together";
import { useSettingsStore } from "@/stores/settings";
import { useSocialStore } from "@/stores/social";
import { useCopyText } from "@/composables/useCopyText";
import { useTogetherDialog } from "@/composables/useTogetherDialog";
import { dialog } from "@/composables/useDialog";
import { isWin } from "@/utils/config";
import type { SettingItem } from "@/types/settings-schema";
const props = defineProps<{ peerId?: string }>();
const together = useTogetherStore();
const settings = useSettingsStore();
const social = useSocialStore();
const roomDialog = useTogetherDialog();
const { copy } = useCopyText();
const invitePeer = ref(props.peerId || "");
const validPeer = computed(
  () => /^[1-9]\d{0,19}$/.test(invitePeer.value) && invitePeer.value !== social.snapshot.accountId,
);
watch(
  () => props.peerId,
  (value) => {
    invitePeer.value = value || "";
  },
);
let mounted = true;
onBeforeUnmount(() => {
  mounted = false;
});
const desktop = computed(
  () => isWin && settings.system.system.socialTogetherMode === "desktop-cdp",
);
// 复用原设置控件与持久化绑定；调试选项不进入普通设置搜索，房间存续时不能切换。
const implementationSetting: SettingItem = {
  key: "socialTogetherMode",
  type: "select",
  binding: { store: "settings", path: "system.system.socialTogetherMode" },
  options: [
    { value: "native", labelKey: "settings.socialTogetherMode.native" },
    { value: "desktop-cdp", labelKey: "settings.socialTogetherMode.desktop" },
  ],
  visible: () => isWin,
  disabled: () => together.busy || !!together.snapshot.roomId,
};
const { t } = useI18n();
const diagnosticsEnabled = ref(false);
const diagnosticsBusy = ref(false);
const diagnosticsError = ref(false);
onMounted(async () => {
  try {
    const result = await window.api.together.diagnostics();
    if (!mounted) return;
    if (result.ok) {
      diagnosticsEnabled.value = result.data.enabled;
      diagnosticsError.value = !!result.data.error;
    } else diagnosticsError.value = true;
  } catch {
    if (mounted) diagnosticsError.value = true;
  }
});
async function changeDiagnostics(value: boolean): Promise<void> {
  if (diagnosticsBusy.value) return;
  diagnosticsBusy.value = true;
  diagnosticsError.value = false;
  try {
    const result = await window.api.together.setDiagnostics(value);
    if (!mounted) return;
    if (result.ok) diagnosticsEnabled.value = result.data.enabled;
    diagnosticsError.value = !result.ok || !!result.data.error;
  } catch {
    if (mounted) diagnosticsError.value = true;
  } finally {
    if (mounted) diagnosticsBusy.value = false;
  }
}
async function openDiagnostics(): Promise<void> {
  try {
    const result = await window.api.together.openDiagnostics();
    if (mounted) diagnosticsError.value = !result.ok;
  } catch {
    if (mounted) diagnosticsError.value = true;
  }
}
const position = ref(0);
const dragging = ref(false);
const song = computed(() =>
  together.snapshot.songs.find((item) => item.id === together.snapshot.songId),
);
const inRoom = computed(
  () =>
    !!together.snapshot.roomId &&
    ["waiting", "together", "togetherOwner"].includes(together.snapshot.status),
);
const canInvite = computed(
  () =>
    inRoom.value &&
    (desktop.value || together.snapshot.playbackOwned) &&
    ["waiting", "togetherOwner"].includes(together.snapshot.status),
);
watch(
  () => together.snapshot.progressMs,
  (value) => {
    if (!dragging.value) position.value = value;
  },
  { immediate: true },
);
const time = (ms: number): string =>
  `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
async function seek(value: number): Promise<void> {
  dragging.value = false;
  await together.control({ action: "seek", positionMs: value });
}
async function copyLink(): Promise<void> {
  const link = await together.invitationLink();
  if (mounted && roomDialog.open.value && link) await copy(link);
}
async function replaceRoom(): Promise<void> {
  const roomId = together.snapshot.roomId;
  const confirmed = await dialog.confirm({
    title: t("social.together.replace"),
    content: t("social.together.replaceHint"),
    type: "warning",
    confirmText: t("social.together.replace"),
  });
  if (confirmed && mounted && roomDialog.open.value) await together.replace(roomId);
}
</script>

<template>
  <div class="flex-1 min-h-0 flex flex-col gap-3">
    <div class="rounded-3 bg-on-surface/4 p-4 flex flex-col gap-3 shrink-0 max-h-3/5 overflow-auto">
      <SettingsItem :item="implementationSetting" />
      <div class="flex items-center gap-3">
        <div class="min-w-0 flex-1">
          <div class="text-sm">{{ t("social.together.diagnostics") }}</div>
          <div class="text-xs text-on-surface-variant mt-1">
            {{ t("social.together.diagnosticsHint") }}
          </div>
        </div>
        <SSwitch
          :model-value="diagnosticsEnabled"
          :disabled="diagnosticsBusy"
          :aria-label="t('social.together.diagnostics')"
          @update:model-value="changeDiagnostics"
        />
        <SButton size="small" variant="secondary" @click="openDiagnostics">
          {{ t("social.together.openDiagnostics") }}
        </SButton>
      </div>
      <p v-if="diagnosticsError" class="text-xs text-error" role="status">
        {{ t("social.together.diagnosticsError") }}
      </p>
      <TogetherClientSetting v-if="desktop && !inRoom" :disabled="together.busy" />
      <p class="text-sm text-on-surface-variant">
        {{ t(desktop ? "social.together.playbackOwner" : "social.together.nativePlayback") }}
      </p>
      <div class="flex gap-2 items-center flex-wrap">
        <SButton size="small" :loading="together.busy" @click="together.connect()">
          {{ t("social.together.connect") }}
        </SButton>
        <template v-if="together.snapshot.connected">
          <span class="text-sm">{{ t(`social.together.status.${together.snapshot.status}`) }}</span>
          <SButton
            v-if="!inRoom"
            size="small"
            :disabled="together.busy"
            @click="together.create(validPeer ? invitePeer : undefined)"
          >
            {{
              t(
                desktop
                  ? "social.together.desktopCreateInvite"
                  : validPeer
                    ? "social.together.createInvite"
                    : "social.together.create",
              )
            }}
          </SButton>
          <SButton
            v-if="canInvite"
            size="small"
            :disabled="together.busy || !validPeer"
            @click="together.invite(invitePeer)"
          >
            {{ t("social.together.invite") }}
          </SButton>
          <SButton v-if="canInvite" size="small" :disabled="together.busy" @click="copyLink">
            {{ t("social.together.copyLink") }}
          </SButton>
          <SButton
            v-if="inRoom && !desktop && !together.snapshot.playbackOwned"
            size="small"
            :disabled="together.busy"
            @click="replaceRoom"
          >
            {{ t("social.together.replace") }}
          </SButton>
          <SButton
            v-if="inRoom && (desktop || together.snapshot.playbackOwned)"
            size="small"
            variant="text"
            :disabled="together.busy"
            @click="together.leave"
          >
            {{ t("social.together.leave") }}
          </SButton>
        </template>
      </div>
      <div v-if="canInvite || !inRoom" class="flex items-center gap-2 flex-wrap">
        <TogetherFriendPicker v-model="invitePeer" :disabled="together.busy" />
        <SInput v-model="invitePeer" :placeholder="t('social.together.invitePeer')" class="w-52" />
        <span class="text-xs text-on-surface-variant">{{ t("social.together.inviteHint") }}</span>
      </div>
      <p v-if="canInvite" class="text-xs text-on-surface-variant">
        {{ t("social.together.linkHint") }}
      </p>
      <p v-if="together.error" role="alert" class="text-error text-sm">
        {{ t(`social.errors.${together.error}`, together.error) }}
      </p>
      <template v-if="inRoom">
        <p class="text-sm">
          {{ together.snapshot.members.map((member) => member.name).join(" · ") }}
        </p>
        <p class="font-medium truncate">
          {{ song?.name || t("social.together.noSong") }}
          <span class="text-on-surface-variant text-sm">{{ song?.artists }}</span>
        </p>
        <div class="flex gap-2 items-center">
          <SButton
            size="small"
            :disabled="
              !together.snapshot.connected ||
              (!desktop && !together.snapshot.playbackOwned) ||
              together.busy
            "
            @click="together.control({ action: 'previous' })"
          >
            {{ t("social.together.previous") }}
          </SButton>
          <SButton
            size="small"
            :disabled="
              !together.snapshot.connected ||
              (!desktop && !together.snapshot.playbackOwned) ||
              together.busy
            "
            @click="together.control({ action: together.snapshot.playing ? 'pause' : 'resume' })"
          >
            {{ t(together.snapshot.playing ? "social.together.pause" : "social.together.resume") }}
          </SButton>
          <SButton
            size="small"
            :disabled="
              !together.snapshot.connected ||
              (!desktop && !together.snapshot.playbackOwned) ||
              together.busy
            "
            @click="together.control({ action: 'next' })"
          >
            {{ t("social.together.next") }}
          </SButton>
          <span class="text-xs">{{ time(position) }} / {{ time(song?.durationMs || 0) }}</span>
        </div>
        <SSlider
          v-model="position"
          :max="song?.durationMs || 1"
          :step="1000"
          :disabled="
            !together.snapshot.connected ||
            (!desktop && !together.snapshot.playbackOwned) ||
            together.busy ||
            !song?.durationMs
          "
          @drag-start="dragging = true"
          @drag-end="seek"
        />
      </template>
    </div>
    <div class="flex-1 min-h-0 flex gap-3">
      <div
        class="flex-1 min-w-0 min-h-0 flex flex-col border border-outline-variant rounded-3 overflow-hidden"
      >
        <h2 class="p-3 font-medium shrink-0">
          {{ t("social.together.queue") }} · {{ together.snapshot.songs.length }}
        </h2>
        <SVirtualList
          class="flex-1 min-h-0"
          :items="together.snapshot.songs"
          :item-height="64"
          item-fixed
          :get-item-key="(item) => item.id"
        >
          <template #default="{ item }">
            <div
              class="px-3 h-16 flex flex-col justify-center"
              :class="item.id === together.snapshot.songId ? 'bg-primary/10' : ''"
            >
              <div class="truncate">{{ item.name }}</div>
              <div class="text-xs text-on-surface-variant truncate">{{ item.artists }}</div>
            </div>
          </template>
        </SVirtualList>
      </div>
      <div
        class="flex-1 min-w-0 min-h-0 flex flex-col border border-outline-variant rounded-3 overflow-hidden"
      >
        <div class="p-3 shrink-0">
          <h2 class="font-medium">{{ t("social.together.recommendations") }}</h2>
          <p class="text-xs text-on-surface-variant my-2">
            {{ t("social.together.recommendationHint") }}
          </p>
          <SButton
            size="small"
            :loading="together.recommendationsLoading"
            :disabled="!together.snapshot.connected || together.busy"
            @click="together.loadRecommendations"
          >
            {{ t("social.refresh") }}
          </SButton>
        </div>
        <SVirtualList
          class="flex-1 min-h-0"
          :items="together.recommendations"
          :item-height="64"
          item-fixed
          :get-item-key="(item) => item.id"
        >
          <template #default="{ item }">
            <div class="px-3 h-16 flex items-center gap-2">
              <div class="min-w-0 flex-1">
                <div class="truncate">{{ item.name }}</div>
                <div class="text-xs text-on-surface-variant truncate">{{ item.artists }}</div>
              </div>
              <SButton
                size="small"
                :disabled="
                  !inRoom ||
                  !together.snapshot.connected ||
                  (!desktop && !together.snapshot.playbackOwned) ||
                  together.busy
                "
                @click="together.add(item.id)"
              >
                {{ t("social.together.add") }}
              </SButton>
            </div>
          </template>
        </SVirtualList>
      </div>
    </div>
  </div>
</template>
