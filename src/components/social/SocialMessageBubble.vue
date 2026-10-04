<script setup lang="ts">
import type { SocialMessage } from "@shared/types/social";
import { navigateToResource } from "@/utils/navigate";
import { openExternal } from "@/utils/url";
import { songsByIds } from "@/apis/song/netease";
import * as player from "@/core/player";
import { createMessageTimeFormatter } from "@/utils/messageTime";
const props = defineProps<{
  message: SocialMessage;
  own: boolean;
  canAccept?: boolean;
  canRetry?: boolean;
  avatar?: string;
  name?: string;
  timeLabel?: string;
  timeGroup?: boolean;
}>();
defineEmits<{ accept: [messageId: string]; retry: [messageId: string] }>();
const { t, locale } = useI18n();
const formatMessageTime = computed(() => createMessageTimeFormatter(locale.value));
const timeText = computed(() => props.timeLabel ?? formatMessageTime.value(props.message.time));
const dateTime = computed(() => {
  const value = new Date(props.message.time);
  return Number.isFinite(value.getTime()) ? value.toISOString() : undefined;
});
const opening = ref(false);
const failed = ref(false);
const emojiOnly = computed(() => {
  if (props.message.kind !== "text" || props.message.text.length > 128) return false;
  // 仅放大少量完整 Unicode 表情；混合文本和未知平台表情标记继续按原文呈现。
  return /^\s*(?:(?:\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*|\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3)\s*){1,8}$/u.test(
    props.message.text,
  );
});
let disposed = false;
onBeforeUnmount(() => {
  disposed = true;
});
const openCard = async (): Promise<void> => {
  const card = props.message.card;
  if (!card || opening.value) return;
  failed.value = false;
  if (card.id && ["album", "artist", "playlist"].includes(card.type)) {
    navigateToResource({
      type: card.type as "album" | "artist" | "playlist",
      source: "netease",
      id: card.id,
      name: card.title,
    });
  } else if (card.type === "song" && card.id) {
    opening.value = true;
    try {
      const tracks = await songsByIds([card.id]);
      if (!disposed && tracks.length) await player.playFrom(tracks, 0);
      else if (!disposed) failed.value = true;
    } catch {
      if (!disposed) failed.value = true;
    } finally {
      if (!disposed) opening.value = false;
    }
  } else openExternal(card.url || (card.type === "image" ? card.cover : undefined));
};
</script>

<template>
  <div class="message-row relative py-1.5 px-4" :class="{ 'is-own': own }">
    <div
      v-if="timeGroup"
      class="message-time-group text-center text-xs text-on-surface-variant pt-2 pb-3"
    >
      <time :datetime="dateTime">{{ timeText }}</time>
    </div>
    <div class="message-layout grid items-start gap-x-3 relative">
      <time
        :datetime="dateTime"
        class="message-time-detail absolute top-0 left-1/2 -translate-x-1/2 text-xs text-on-surface-variant bg-surface-panel rounded-full px-2 py-0.5 whitespace-nowrap pointer-events-none z-1"
      >
        {{ timeText }}
      </time>
      <SocialAvatar
        :src="message.senderAvatar || avatar"
        :name="message.senderName || name || message.senderId"
        class="message-avatar size-9!"
      />
      <div class="message-content min-w-0 flex flex-col" :class="own ? 'items-end' : 'items-start'">
        <div
          class="message-body flex items-center gap-2 max-w-full min-w-0"
          :class="own ? 'flex-row-reverse' : ''"
        >
          <SCard
            size="small"
            :variant="own ? 'primary' : 'default'"
            class="message-bubble w-fit max-w-full whitespace-pre-wrap break-words select-text"
            :class="{ 'message-emoji': emojiOnly, 'message-invitation': message.kind === 'invite' }"
          >
            <div v-if="message.kind === 'invite'" class="whitespace-normal">
              <div class="flex items-center gap-3">
                <div
                  class="size-11 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0"
                >
                  <IconLucideHeadphones class="size-6" />
                </div>
                <div class="min-w-0 flex-1">
                  <div class="text-xs text-on-surface-variant mb-1">
                    {{ t("social.inviteService") }}
                  </div>
                  <div class="font-semibold text-base leading-6">{{ t("social.invite") }}</div>
                  <div class="text-xs text-on-surface-variant mt-1">
                    {{ t("social.inviteActionHint") }}
                  </div>
                </div>
                <SButton
                  v-if="!own"
                  size="small"
                  type="primary"
                  class="shrink-0"
                  :disabled="!canAccept || !message.invite"
                  @click="$emit('accept', message.id)"
                >
                  {{ t("social.accept") }}
                </SButton>
              </div>
              <div
                v-if="message.text && !['invite-message', '加入一起听'].includes(message.text)"
                class="text-sm mt-3 leading-5"
              >
                {{ message.text }}
              </div>
            </div>
            <div v-else-if="message.kind === 'card' && message.card" class="flex flex-col gap-2">
              <div
                v-if="
                  message.text &&
                  message.text !== message.card.title &&
                  message.text !== 'image-message'
                "
              >
                {{ message.text }}
              </div>
              <SocialMessageImage
                v-if="message.card.type === 'image' && message.card.cover"
                :src="message.card.cover"
                :width="message.card.width"
                :height="message.card.height"
              />
              <button
                v-else
                class="message-resource flex gap-3 items-center text-left w-full min-w-0 rounded-xl border border-solid border-primary/12 bg-transparent p-2 cursor-pointer hover:bg-on-surface/4 disabled:cursor-default"
                :disabled="
                  opening ||
                  (!message.card.id && !message.card.url && message.card.type !== 'image')
                "
                @click="openCard"
              >
                <img
                  v-if="message.card.cover"
                  :src="message.card.cover"
                  alt=""
                  loading="lazy"
                  decoding="async"
                  referrerpolicy="no-referrer"
                  class="size-14 rounded-lg object-cover shrink-0"
                />
                <div v-if="message.card.type !== 'image'" class="min-w-0 flex-1">
                  <div class="text-xs text-on-surface-variant mb-1">
                    {{ t(`social.cards.${message.card.type}`) }}
                  </div>
                  <div class="font-medium line-clamp-2">{{ message.card.title }}</div>
                  <div
                    v-if="message.card.subtitle"
                    class="text-xs text-on-surface-variant line-clamp-2 mt-1"
                  >
                    {{ message.card.subtitle }}
                  </div>
                </div>
                <IconLucideLoaderCircle v-if="opening" class="size-4 animate-spin shrink-0" />
              </button>
              <span v-if="failed" class="text-xs text-error" role="status">
                {{ t("social.errors.offline") }}
              </span>
            </div>
            <template v-else>
              {{
                message.text === "unsupported-message"
                  ? t("social.unsupported")
                  : message.text === "invitation-dismissed"
                    ? t("social.invitationDismissed")
                    : message.text
              }}
            </template>
            <div
              v-if="message.kind === 'unsupported' && message.text !== 'invitation-dismissed'"
              class="text-xs text-on-surface-variant mt-2"
            >
              {{ t("social.unsupportedHint") }}
            </div>
          </SCard>
          <button
            v-if="
              own && message.delivery === 'failed' && message.kind === 'text' && message.clientId
            "
            class="message-retry size-7 shrink-0 rounded-full border border-solid border-primary/30 bg-primary/8 text-primary inline-flex items-center justify-center cursor-pointer hover:bg-primary/15 disabled:opacity-50 disabled:cursor-default focus-visible:ring-2 focus-visible:ring-primary"
            :disabled="!canRetry"
            :aria-label="t('social.retrySend')"
            :title="t('social.retrySend')"
            @click="$emit('retry', message.id)"
          >
            <IconLucideRotateCw class="size-4" />
          </button>
        </div>
        <div
          v-if="own && ['sending', 'unknown'].includes(message.delivery)"
          class="text-xs text-right text-on-surface-variant mt-1"
          role="status"
        >
          {{ t(`social.delivery.${message.delivery}`) }}
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.message-layout {
  grid-template-columns: 36px minmax(0, 1fr) 36px;
}
.message-time-detail {
  opacity: 0;
  transition: opacity 150ms ease;
}
.message-layout:has(.message-bubble:hover) .message-time-detail,
.message-layout:focus-within .message-time-detail {
  opacity: 1;
}
@media (prefers-reduced-motion: reduce) {
  .message-time-detail {
    transition: none;
  }
}
.message-avatar {
  grid-column: 1;
  grid-row: 1;
}
.message-row.is-own .message-avatar {
  grid-column: 3;
}
.message-content {
  grid-column: 2;
  grid-row: 1;
  width: 100%;
}
.message-bubble {
  overflow-wrap: anywhere;
  min-width: 0;
  flex-shrink: 1;
}
.message-emoji {
  font-size: 28px;
  line-height: 1.5;
}
.message-resource {
  width: 300px;
  max-width: 100%;
}
.message-invitation {
  width: 320px;
}
</style>
