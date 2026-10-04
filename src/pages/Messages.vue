<script setup lang="ts">
import { useSocialStore } from "@/stores/social";
import { useUserStore } from "@/stores/user";
import { useTogetherStore } from "@/stores/together";
import { useTogetherDialog } from "@/composables/useTogetherDialog";
import type { NoticeKind } from "@shared/types/social";
import type { SVirtualListExposed } from "@/components/ui/SVirtualList.vue";

defineOptions({ name: "Messages" });
const { t } = useI18n();
const social = useSocialStore();
const user = useUserStore();
const together = useTogetherStore();
const togetherDialog = useTogetherDialog();
const { activeTab: tab } = storeToRefs(social);
const selectedNotices = reactive<Record<NoticeKind, string>>({
  notice: "",
  mention: "",
  comment: "",
});
const list = ref<SVirtualListExposed | null>(null);
const conversationList = ref<SVirtualListExposed | null>(null);
const listPositions: Record<"chat" | NoticeKind, number> = {
  chat: 0,
  comment: 0,
  mention: 0,
  notice: 0,
};
const atBottom = ref(true);
const hasNew = ref(false);
let mounted = true;
const notices = computed(() => social.snapshot.notices.filter((item) => item.kind === tab.value));
const activeNotice = computed(() =>
  notices.value.find((item) => item.id === selectedNotices[tab.value as NoticeKind]),
);
const rows = computed(() =>
  tab.value === "chat"
    ? social.snapshot.conversations.map((item) => ({
        id: item.peerId,
        name: item.name || item.peerId,
        avatar: item.avatar,
        text: item.preview === "invite-message" ? t("social.invite") : item.preview,
        unread: item.unread,
        time: item.updatedAt,
      }))
    : notices.value.map((item) => ({
        id: item.id,
        name: t(`social.tabs.${item.kind}`),
        avatar: "",
        text: item.text === "unsupported-message" ? t("social.unsupported") : item.text,
        unread: item.locallyRead ? 0 : 1,
        time: item.time,
      })),
);
const peer = computed(() =>
  social.snapshot.conversations.find((item) => item.peerId === social.selected),
);
const tabs = computed(() =>
  ["chat", "comment", "mention", "notice"].map((key) => ({
    key,
    label: t(`social.tabs.${key}`),
  })),
);
const errorText = computed(() => {
  const code = social.error || social.snapshot.error;
  return code ? t(`social.errors.${code}`, t("social.errors.offline")) : "";
});
const draftLength = computed(() => Array.from(social.draft).length);

async function toBottom(): Promise<void> {
  await nextTick();
  if (!mounted || tab.value !== "chat" || !list.value) return;
  list.value?.scrollToBottom();
  atBottom.value = true;
  hasNew.value = false;
  if (document.visibilityState === "visible" && document.hasFocus())
    void social.read(
      Math.max(...social.messages.filter((item) => !item.clientId).map((item) => item.time), 0),
    );
}
function onScroll(event: Event): void {
  const element = event.target as HTMLElement;
  atBottom.value = element.scrollHeight - element.scrollTop - element.clientHeight < 64;
  if (atBottom.value && document.hasFocus()) {
    hasNew.value = false;
    void social.read(
      Math.max(...social.messages.filter((item) => !item.clientId).map((item) => item.time), 0),
    );
  }
}
async function select(peerId: string): Promise<void> {
  if (tab.value !== "chat") {
    selectedNotices[tab.value as NoticeKind] = peerId;
    return;
  }
  await social.select(peerId);
  await toBottom();
}
async function older(): Promise<void> {
  await social.older();
}
function keydown(event: KeyboardEvent): void {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    void social.send();
  }
}
async function refresh(): Promise<void> {
  if (tab.value === "chat") await social.refresh();
  else await social.loadNotices(tab.value as NoticeKind);
}
const more = computed(() =>
  tab.value === "chat" ? social.conversationsMore : social.noticeMore[tab.value],
);
function loadMore(): void {
  if (tab.value === "chat") void social.moreConversations();
  else void social.loadNotices(tab.value as NoticeKind, true);
}
async function accept(messageId: string): Promise<void> {
  togetherDialog.show(social.selected);
  await together.accept(social.selected, messageId);
}
async function visibility(): Promise<void> {
  if (document.visibilityState === "hidden") social.stop();
  else if (user.isLoggedIn) {
    try {
      await social.start();
      if (!mounted) return;
      if (tab.value === "chat" && social.selected) await social.select(social.selected);
      if (mounted) await refresh();
    } catch {
      /* 错误由标题提示，失焦/卸载后不再开始后续请求。 */
    }
  }
}
watch(tab, async (value, previous) => {
  // 仅替换列表实例，切换器和详情布局保持稳定；四个位置缓存有固定上界。
  listPositions[previous] =
    conversationList.value?.scrollRef?.scrollTop ?? conversationList.value?.getScrollTop() ?? 0;
  await nextTick();
  if (!mounted || tab.value !== value) return;
  conversationList.value?.scrollTo(listPositions[value]);
  if (["notice", "mention", "comment"].includes(value))
    await social.loadNotices(value as NoticeKind);
  else if (social.selected) await social.select(social.selected);
});
watch(
  () => social.messages.at(-1)?.id,
  (id, old) => {
    if (!id || id === old) return;
    if (atBottom.value) void toBottom();
    else hasNew.value = true;
  },
);
watch(
  () => user.profile?.userId,
  async () => {
    social.stop();
    for (const key of Object.keys(listPositions) as ("chat" | NoticeKind)[]) listPositions[key] = 0;
    conversationList.value?.scrollTo(0);
    selectedNotices.notice = selectedNotices.mention = selectedNotices.comment = "";
    if (user.isLoggedIn) await social.start();
  },
);
onMounted(async () => {
  document.addEventListener("visibilitychange", visibility);
  if (user.isLoggedIn) {
    try {
      await social.start();
      if (!mounted) return;
      await social.moreConversations();
      if (mounted && social.selected) await select(social.selected);
    } catch {
      /* 显示错误区。 */
    }
  }
});
onBeforeUnmount(() => {
  mounted = false;
  document.removeEventListener("visibilitychange", visibility);
  social.stop();
});
</script>

<template>
  <section class="h-full min-h-0 flex flex-col">
    <header class="shrink-0 px-5 pb-2">
      <div class="flex items-baseline gap-4 mt-2 mb-4">
        <h1 class="text-3xl font-bold text-on-surface text-balance">{{ t("social.title") }}</h1>
        <span
          v-if="errorText"
          role="status"
          class="text-xs text-error min-w-0 truncate"
          :title="errorText"
        >
          {{ errorText }}
        </span>
        <SButton
          class="ml-auto shrink-0"
          variant="ghost"
          size="small"
          @click="togetherDialog.showDebug()"
        >
          <template #icon><IconLucideBug /></template>
          {{ t("social.together.debug") }}
        </SButton>
      </div>
    </header>
    <div
      v-if="!user.isLoggedIn"
      class="flex-1 flex items-center justify-center text-on-surface-variant"
    >
      {{ t("social.login") }}
    </div>
    <template v-else>
      <SCard
        flush
        radius="xl"
        class="message-workspace mx-5 mb-4 flex-1 min-h-0 flex overflow-hidden"
      >
        <aside
          class="conversation-pane relative w-64 max-w-2/5 shrink-0 flex flex-col min-h-0 border-0 border-r border-solid border-primary/12"
        >
          <div class="message-tabs">
            <STabs
              v-model="tab"
              :tabs="tabs"
              type="bar"
              size="medium"
              justify-content="space-between"
            />
          </div>
          <SVirtualList
            :key="tab"
            ref="conversationList"
            class="conversation-list flex-1 min-h-0"
            :items="rows"
            :item-height="76"
            :padding-top="48"
            item-fixed
            :get-item-key="(item) => `${tab}:${item.id}`"
          >
            <template #default="{ item }">
              <div class="h-19 px-2 flex items-center">
                <button
                  class="conversation-row relative w-full h-17 rounded-xl text-left px-3 flex items-center gap-3 border-none cursor-pointer text-on-surface transition-colors duration-150 hover:bg-on-surface/4 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40"
                  :class="
                    (tab === 'chat' ? social.selected : selectedNotices[tab as NoticeKind]) ===
                    item.id
                      ? 'is-selected bg-primary/8'
                      : 'bg-transparent'
                  "
                  :aria-current="
                    (tab === 'chat' ? social.selected : selectedNotices[tab as NoticeKind]) ===
                    item.id
                      ? 'true'
                      : undefined
                  "
                  @click="select(item.id)"
                >
                  <SocialAvatar :src="item.avatar" :name="item.name" />
                  <div class="min-w-0 flex-1">
                    <div class="truncate font-medium text-sm leading-6">{{ item.name }}</div>
                    <div class="truncate text-xs leading-5 text-on-surface-variant">
                      {{ item.text }}
                    </div>
                  </div>
                  <span
                    v-if="item.unread"
                    class="text-xs rounded-full px-1.5 bg-primary text-on-primary"
                  >
                    {{ item.unread > 99 ? "99+" : item.unread }}
                  </span>
                </button>
              </div>
            </template>
          </SVirtualList>
          <p v-if="!rows.length" class="text-sm text-center text-on-surface-variant p-4">
            {{ t("social.empty") }}
          </p>
          <SButton v-if="more" variant="text" size="small" :loading="social.busy" @click="loadMore">
            {{ t("social.more") }}
          </SButton>
        </aside>
        <div class="detail-pane flex-1 min-w-0 min-h-0 flex flex-col">
          <template v-if="tab === 'chat' && social.selected">
            <div
              class="px-4 py-3 shrink-0 border-0 border-b border-solid border-primary/12 font-medium"
            >
              {{ peer?.name || social.selected }}
            </div>
            <SButton
              v-if="social.historyMore[social.selected]"
              variant="text"
              size="small"
              :loading="social.busy"
              @click="older"
            >
              {{ t("social.older") }}
            </SButton>
            <SVirtualList
              ref="list"
              class="flex-1 min-h-0"
              :items="social.messages"
              :item-height="100"
              :get-item-key="(item) => item.id"
              preserve-anchor
              :follow-bottom="atBottom"
              @scroll="onScroll"
            >
              <template #default="{ item }">
                <SocialMessageBubble
                  :message="item"
                  :own="item.senderId === social.snapshot.accountId"
                  :avatar="
                    item.senderId === social.snapshot.accountId
                      ? user.profile?.avatarUrl
                      : peer?.avatar
                  "
                  :name="
                    item.senderId === social.snapshot.accountId
                      ? user.profile?.nickname
                      : peer?.name
                  "
                  :can-accept="!together.busy"
                  @accept="accept"
                />
              </template>
            </SVirtualList>
            <SButton v-if="hasNew" variant="secondary" size="small" @click="toBottom">
              {{ t("social.newMessages") }}
            </SButton>
            <div
              class="shrink-0 mt-auto border-0 border-t border-solid border-primary/12"
              @keydown="keydown"
            >
              <SInput
                v-model="social.draft"
                class="message-composer"
                type="textarea"
                :rows="4"
                :placeholder="t('social.compose')"
              >
                <template #footer>
                  <div class="composer-footer mt-3 flex items-center gap-3">
                    <span class="composer-hint text-xs text-on-surface-variant/70">
                      {{ t("social.sendHint") }}
                    </span>
                    <div class="ml-auto flex shrink-0 items-center gap-3">
                      <span
                        class="text-xs tabular-nums"
                        :class="draftLength > 500 ? 'text-red-500' : 'text-on-surface-variant'"
                      >
                        {{ draftLength }}/500
                      </span>
                      <SButton
                        type="primary"
                        size="small"
                        :loading="social.sending"
                        :disabled="!social.draft.trim() || draftLength > 500"
                        @click="social.send"
                      >
                        {{ t("social.send") }}
                      </SButton>
                    </div>
                  </div>
                </template>
              </SInput>
            </div>
          </template>
          <template v-else-if="tab !== 'chat' && activeNotice">
            <div
              class="px-4 py-3 shrink-0 border-0 border-b border-solid border-primary/12 font-medium"
            >
              {{ t(`social.tabs.${tab}`) }}
            </div>
            <div class="p-4 flex-1 min-h-0 overflow-auto">
              <div class="text-xs text-on-surface-variant mb-2">
                {{ new Date(activeNotice.time).toLocaleString() }}
              </div>
              <div class="whitespace-pre-wrap break-words select-text">
                {{
                  activeNotice.text === "unsupported-message"
                    ? t("social.unsupported")
                    : activeNotice.text
                }}
              </div>
            </div>
          </template>
          <div v-else class="flex-1 flex items-center justify-center text-on-surface-variant">
            {{ t(tab === "chat" ? "social.choose" : "social.chooseDetail") }}
          </div>
        </div>
      </SCard>
    </template>
  </section>
</template>

<style scoped>
.conversation-row.is-selected::before {
  content: "";
  position: absolute;
  left: 0;
  top: 22px;
  bottom: 22px;
  width: 3px;
  border-radius: 2px;
  background: rgb(var(--s-primary));
}
.message-tabs {
  position: absolute;
  inset: 0 0 auto;
  z-index: 2;
  height: 48px;
  padding: 4px 8px 8px;
  pointer-events: none;
}
/* 只模糊有界的列表顶部；顶部留白由虚拟列表负责，滚动时条目经过遮罩下方。 */
.message-tabs::before {
  content: "";
  position: absolute;
  inset: 0 0 -16px;
  background: linear-gradient(
    to bottom,
    rgb(var(--s-surface-panel) / 0.96),
    rgb(var(--s-surface-panel) / 0.8) 55%,
    rgb(var(--s-surface-panel) / 0.45) 80%,
    transparent
  );
  backdrop-filter: blur(10px);
  mask-image: linear-gradient(to bottom, black 55%, transparent);
  pointer-events: none;
}
.message-tabs :deep([role="tablist"]) {
  z-index: 1;
  width: 100%;
  gap: 0;
  pointer-events: auto;
}
.message-tabs :deep([role="tab"]) {
  flex: 1;
  min-width: 0;
  padding-inline: 0;
}
.message-composer {
  border: none;
  border-radius: 0;
  padding: 12px 16px;
}
.message-composer:focus-within {
  box-shadow: inset 0 2px 0 rgb(var(--s-primary) / 0.5);
}
.message-composer :deep(textarea) {
  min-height: 80px;
}
@media (max-width: 1000px) {
  .composer-hint {
    display: none;
  }
}
</style>
