<script setup lang="ts">
import type { SocialMessage } from "@shared/types/social";
import { navigateToResource } from "@/utils/navigate";
import { openExternal } from "@/utils/url";
import { songsByIds } from "@/apis/song/netease";
import * as player from "@/core/player";
const props = defineProps<{
  message: SocialMessage;
  own: boolean;
  canAccept?: boolean;
  avatar?: string;
  name?: string;
}>();
defineEmits<{ accept: [messageId: string] }>();
const { t } = useI18n();
const opening = ref(false);
const failed = ref(false);
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
  <div class="flex items-start gap-3 py-2 px-4" :class="own ? 'flex-row-reverse' : ''">
    <SocialAvatar
      :src="message.senderAvatar || avatar"
      :name="message.senderName || name || message.senderId"
      class="mt-5 size-9"
    />
    <div class="message-content min-w-0 flex flex-col" :class="own ? 'items-end' : 'items-start'">
      <div class="text-xs text-on-surface-variant mb-1" :class="own ? 'text-right' : ''">
        {{ new Date(message.time).toLocaleString() }}
      </div>
      <SCard
        size="small"
        :variant="own ? 'primary' : 'default'"
        class="message-bubble w-fit max-w-full whitespace-pre-wrap break-words select-text"
      >
        <div v-if="message.kind === 'invite'" class="flex flex-col gap-2">
          <div class="font-semibold">{{ t("social.invite") }}</div>
          <div v-if="message.text !== 'invite-message'">{{ message.text }}</div>
          <div class="text-xs text-on-surface-variant">{{ t("social.inviteActionHint") }}</div>
          <SButton
            size="small"
            :disabled="!canAccept || own || !message.invite"
            @click="$emit('accept', message.id)"
          >
            {{ t("social.accept") }}
          </SButton>
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
          <button
            class="message-resource flex gap-3 items-center text-left w-full min-w-0 rounded-xl border border-solid border-primary/12 bg-transparent p-2 cursor-pointer hover:bg-on-surface/4 disabled:cursor-default"
            :disabled="
              opening || (!message.card.id && !message.card.url && message.card.type !== 'image')
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
              class="rounded-lg object-cover shrink-0"
              :class="message.card.type === 'image' ? 'max-w-60 max-h-60' : 'size-14'"
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
      <div v-if="own" class="text-xs text-right text-on-surface-variant mt-1">
        {{ t(`social.delivery.${message.delivery}`) }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.message-content {
  max-width: calc(100% - 48px);
}
.message-bubble {
  overflow-wrap: anywhere;
}
.message-resource {
  width: min(300px, 100%);
}
</style>
