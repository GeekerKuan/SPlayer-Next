<script setup lang="ts">
import { useTogetherStore } from "@/stores/together";
import { useSettingsStore } from "@/stores/settings";
import { useUserStore } from "@/stores/user";
import { useTogetherDialog } from "@/composables/useTogetherDialog";
import { useCopyText } from "@/composables/useCopyText";
import { dialog } from "@/composables/useDialog";
import { TOGETHER_SHARE_MARKER } from "@shared/utils/togetherLink";
import { useHistoryStore } from "@/stores/history";

const props = defineProps<{ peerId?: string }>();
const together = useTogetherStore();
const user = useUserStore();
const settings = useSettingsStore();
const history = useHistoryStore();
const roomDialog = useTogetherDialog();
const { copy } = useCopyText();
const { t } = useI18n();
const recipient = ref(props.peerId || "");
const pushMode = ref("recommended");
const state = computed(() => together.snapshot);
const isHost = computed(
  () =>
    state.value.mode === "native" &&
    state.value.creatorId === String(user.profile?.userId) &&
    state.value.playbackOwned,
);
const isMember = computed(
  () =>
    state.value.mode === "native" &&
    state.value.playbackOwned &&
    !!state.value.creatorId &&
    !isHost.value,
);
const sourceMode = computed({
  get: () =>
    state.value.recommendationMode === "heart"
      ? "heart"
      : isHost.value
        ? !settings.system.player.togetherAutoRecommend
          ? "playlistOnly"
          : settings.system.player.togetherSongSource === "history"
            ? "queue"
            : settings.system.player.togetherSongSource || "recommended"
        : pushMode.value,
  set: (value: string) => {
    if (value === "heart" || state.value.recommendationMode === "heart") {
      void changeSource(value);
      return;
    }
    if (value !== "playlistOnly") pushMode.value = value;
    if (isHost.value) {
      void settings.setSystem("player.togetherAutoRecommend", value !== "playlistOnly");
      if (value !== "playlistOnly")
        void settings.setSystem("player.togetherSongSource", value === "queue" ? "history" : value);
    }
  },
});
const sourceOptions = computed(() => [
  { value: "recommended", label: t("social.together.recommendedMode") },
  { value: "room", label: t("social.together.roomRecommendedMode") },
  { value: "queue", label: t("social.together.queueMode") },
  ...(state.value.mode === "native" && state.value.playbackOwned && state.value.members.length >= 2
    ? [{ value: "heart", label: t("social.together.heartMode") }]
    : []),
  ...(isHost.value ? [{ value: "playlistOnly", label: t("social.together.playlistOnly") }] : []),
]);
const external = computed(
  () => !!state.value.roomId && state.value.mode === "native" && !state.value.playbackOwned,
);
const canInvite = computed(
  () =>
    !!state.value.roomId &&
    !external.value &&
    state.value.members.length < 2 &&
    ["waiting", "togetherOwner"].includes(state.value.status),
);
const currentSong = computed(() =>
  state.value.songs.find((song) => song.id === state.value.songId),
);
const validRecipient = computed(
  () => /^[1-9]\d{0,19}$/.test(recipient.value) && recipient.value !== String(user.profile?.userId),
);
const candidates = computed(() =>
  sourceMode.value === "playlistOnly" || sourceMode.value === "heart"
    ? []
    : sourceMode.value === "recommended"
      ? together.recommendations.filter(
          (song) => !state.value.songs.some((queued) => queued.id === song.id),
        )
      : sourceMode.value === "room"
        ? (state.value.recommendations || []).filter(
            (song) => !state.value.songs.some((queued) => queued.id === song.id),
          )
        : history.tracks
            .filter(
              (track) =>
                track.source === "netease" &&
                !track.cloud &&
                !state.value.songs.some((song) => song.id === track.id),
            )
            .slice(0, 100)
            .map((track) => ({
              id: track.id,
              name: track.title,
              artists: track.artists.map((artist) => artist.name).join(" / "),
            })),
);
const errorText = computed(() =>
  together.error ? t(`social.errors.${together.error}`, t("social.errors.offline")) : "",
);
let mounted = true;
let recommendedRoom = "";
watchEffect(() => {
  if (!state.value.roomId) recommendedRoom = "";
  if (
    mounted &&
    state.value.connected &&
    state.value.roomId &&
    !external.value &&
    sourceMode.value === "recommended" &&
    !together.busy &&
    !together.recommendationsLoading &&
    !together.recommendations.length &&
    recommendedRoom !== state.value.roomId
  ) {
    recommendedRoom = state.value.roomId;
    void together.loadRecommendations();
  }
});
onMounted(() => {
  void history.load();
});
onBeforeUnmount(() => {
  mounted = false;
});
watch(
  () => props.peerId,
  (peer) => {
    recipient.value = peer || "";
  },
);

async function invite(): Promise<void> {
  if (!validRecipient.value) return;
  if (!state.value.roomId) await together.create(recipient.value);
  else await together.invite(recipient.value);
}
/** 服务器确认模式后才更新来源；关闭心动不在本机重建旧房间列表。 */
async function changeSource(value: string): Promise<void> {
  if (together.busy) return;
  const roomId = state.value.roomId;
  const success = await together.setHeartRecommendation(value === "heart");
  if (!success || !mounted || state.value.roomId !== roomId || value === "heart") return;
  sourceMode.value = value;
}
async function copyInvite(): Promise<void> {
  if (!state.value.roomId && !(await together.create())) return;
  if (!mounted || !roomDialog.open.value) return;
  const link = await together.invitationLink();
  if (mounted && roomDialog.open.value && link)
    await copy(`${t("social.together.shareText")} ${link} ${TOGETHER_SHARE_MARKER}`);
}
/** 等待确认期间房间可能变化，提交时仍由主进程核对原房间标识。 */
async function externalAction(action: "takeOver" | "closeExternal"): Promise<void> {
  const roomId = state.value.roomId;
  const confirmed = await dialog.confirm({
    title: t(`social.together.${action}`),
    content: t(`social.together.${action}Hint`),
    type: "warning",
  });
  if (!confirmed || !mounted || !roomDialog.open.value) return;
  await together[action](roomId);
}
async function openFallback(): Promise<void> {
  const link = roomDialog.fallbackLink.value;
  const result = await window.api.together.openInviteLink(link);
  if (!mounted) return;
  if (result.ok) roomDialog.open.value = false;
  else together.error = result.error;
}
</script>

<template>
  <div class="flex flex-1 min-h-0 flex-col gap-4">
    <p v-if="errorText" class="text-xs text-error shrink-0" role="status">{{ errorText }}</p>
    <template v-if="roomDialog.fallbackLink.value">
      <div class="flex-1 flex flex-col justify-center items-center gap-4 text-center">
        <IconLucideLink class="size-10 text-primary" />
        <p class="text-sm text-on-surface-variant">{{ t("social.together.linkFallback") }}</p>
      </div>
      <SButton type="primary" @click="openFallback">{{ t("social.together.openBrowser") }}</SButton>
    </template>
    <template v-else-if="!state.roomId">
      <div class="text-center pt-3 pb-2">
        <IconLucideHeadphones class="size-12 mx-auto mb-3 text-primary" />
        <h2 class="text-lg font-semibold">{{ t("social.together.inviteFriend") }}</h2>
        <p class="text-sm text-on-surface-variant mt-2">
          {{ t("social.together.inviteDescription") }}
        </p>
      </div>
      <TogetherFriendPicker v-model="recipient" :disabled="together.busy" />
      <SInput
        v-model="recipient"
        :placeholder="t('social.together.friendId')"
        :disabled="together.busy"
      />
      <SButton
        type="primary"
        :disabled="!validRecipient || !state.connected"
        :loading="together.busy"
        @click="invite"
      >
        {{ t("social.together.invite") }}
      </SButton>
      <SButton
        variant="secondary"
        :disabled="!state.connected"
        :loading="together.busy"
        @click="copyInvite"
      >
        {{ t("social.together.createAndCopy") }}
      </SButton>
      <p class="text-xs text-on-surface-variant mt-auto">{{ t("social.together.neteaseOnly") }}</p>
      <SButton
        v-if="!state.connected"
        variant="secondary"
        :loading="together.busy"
        @click="together.connect()"
      >
        {{ t("social.together.retry") }}
      </SButton>
    </template>
    <template v-else-if="external">
      <div class="flex-1 flex flex-col items-center justify-center gap-4 text-center">
        <IconLucideHeadphones class="size-10 text-primary" />
        <p class="text-sm">{{ t("social.together.externalRoom") }}</p>
        <p class="text-xs text-on-surface-variant">{{ t("social.together.externalRoomHint") }}</p>
      </div>
      <SButton type="primary" :loading="together.busy" @click="externalAction('takeOver')">
        {{ t("social.together.takeOver") }}
      </SButton>
      <SButton
        variant="secondary"
        :disabled="together.busy"
        @click="externalAction('closeExternal')"
      >
        {{ t("social.together.closeExternal") }}
      </SButton>
    </template>
    <template v-else>
      <div class="shrink-0">
        <div class="flex items-center gap-2 text-sm">
          <span class="size-2 rounded-full" :class="state.connected ? 'bg-primary' : 'bg-error'" />
          {{ t(`social.together.status.${state.status}`) }}
          <span v-if="isMember" class="text-xs text-on-surface-variant">
            · {{ t("social.together.memberRole") }}
          </span>
        </div>
        <div class="flex gap-3 mt-3 flex-wrap">
          <div
            v-for="member in state.members"
            :key="member.id"
            class="flex items-center gap-2 max-w-full min-w-0"
          >
            <SocialAvatar :src="member.avatar" :name="member.name" class="size-8" />
            <span class="text-sm truncate">{{ member.name || member.id }}</span>
          </div>
        </div>
        <p v-if="currentSong" class="text-xs text-on-surface-variant truncate mt-3">
          {{ t("social.together.nowPlaying") }} · {{ currentSong.name }}
        </p>
        <p v-if="state.recommendationMode === 'heart'" class="text-xs text-primary mt-2">
          {{ t("social.together.heartModeActive") }}
        </p>
      </div>
      <div v-if="canInvite" class="flex flex-col gap-2 shrink-0">
        <div class="grid grid-cols-2 gap-2 min-w-0">
          <TogetherFriendPicker v-model="recipient" :disabled="together.busy" class="min-w-0" />
          <SInput
            v-model="recipient"
            :placeholder="t('social.together.friendId')"
            class="min-w-0"
            :disabled="together.busy"
          />
        </div>
        <div class="grid grid-cols-2 gap-2">
          <SButton
            size="small"
            class="whitespace-nowrap"
            :disabled="!validRecipient || together.busy"
            @click="invite"
          >
            {{ t("social.together.invite") }}
          </SButton>
          <SButton
            size="small"
            variant="secondary"
            class="whitespace-nowrap"
            :disabled="together.busy"
            @click="copyInvite"
          >
            {{ t("social.together.copyLink") }}
          </SButton>
        </div>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <span class="text-xs text-on-surface-variant shrink-0">
          {{ t("social.together.pushMode") }}
        </span>
        <SSelect
          v-model="sourceMode"
          :options="sourceOptions"
          :disabled="together.busy"
          class="flex-1 min-w-0"
        />
        <SButton
          v-if="sourceMode === 'recommended'"
          size="small"
          variant="ghost"
          class="shrink-0 whitespace-nowrap"
          :loading="together.recommendationsLoading"
          :disabled="together.busy"
          @click="together.loadRecommendations()"
        >
          {{ t("social.together.recommend") }}
        </SButton>
      </div>
      <p v-if="isMember" class="text-xs text-on-surface-variant shrink-0" role="status">
        {{
          t(
            state.awaitingNext
              ? "social.together.memberWaiting"
              : "social.together.memberAddingHint",
          )
        }}
      </p>
      <div class="grid grid-cols-2 gap-3 flex-1 min-h-0">
        <section class="flex flex-col min-h-0 min-w-0" :aria-label="t('social.together.queue')">
          <h3 class="text-xs font-medium py-2 shrink-0 text-on-surface-variant">
            {{ t("social.together.queue") }} · {{ state.songs.length }}
          </h3>
          <SVirtualList
            :items="state.songs"
            :item-height="52"
            item-fixed
            :get-item-key="(song) => song.id"
            class="flex-1 min-h-20"
          >
            <template #default="{ item }">
              <div
                class="h-13 px-2 rounded-lg flex flex-col justify-center min-w-0"
                :class="item.id === state.songId ? 'bg-primary/8' : ''"
                :title="item.name"
              >
                <span
                  class="text-sm truncate"
                  :class="item.id === state.songId ? 'text-primary font-medium' : ''"
                >
                  {{ item.name }}
                </span>
                <span class="text-xs text-on-surface-variant truncate">{{ item.artists }}</span>
              </div>
            </template>
          </SVirtualList>
        </section>
        <section
          class="flex flex-col min-h-0 min-w-0"
          :aria-label="t('social.together.availableSongs')"
        >
          <h3 class="text-xs font-medium py-2 shrink-0 text-on-surface-variant">
            {{ t("social.together.availableSongs") }} · {{ candidates.length }}
          </h3>
          <SVirtualList
            :key="sourceMode"
            :items="candidates"
            :item-height="52"
            item-fixed
            :get-item-key="(song) => song.id"
            class="flex-1 min-h-20"
          >
            <template #default="{ item }">
              <button
                class="h-13 w-full flex items-center gap-2 px-2 rounded-lg border-none bg-transparent text-on-surface text-left hover:bg-on-surface/5 disabled:opacity-50 cursor-pointer"
                :title="item.name"
                :aria-label="t('social.together.add') + ' ' + item.name"
                :disabled="together.busy"
                @click="together.add(item.id)"
              >
                <span class="flex-1 min-w-0 flex flex-col">
                  <span class="text-sm truncate">{{ item.name }}</span>
                  <span class="text-xs text-on-surface-variant truncate">{{ item.artists }}</span>
                </span>
                <IconLucidePlus class="size-4 text-primary shrink-0" />
              </button>
            </template>
            <template #empty>
              <p class="text-xs text-on-surface-variant px-2 py-3">
                {{
                  t(
                    sourceMode === "playlistOnly"
                      ? "social.together.playlistOnlyHint"
                      : sourceMode === "heart"
                        ? "social.together.heartModeHint"
                        : sourceMode === "room"
                          ? "social.together.noRoomRecommendations"
                          : "social.together.noAvailableSongs",
                  )
                }}
              </p>
            </template>
          </SVirtualList>
        </section>
      </div>
      <SButton variant="secondary" :loading="together.busy" @click="together.leave()">
        {{ t("social.together.leave") }}
      </SButton>
    </template>
  </div>
</template>
