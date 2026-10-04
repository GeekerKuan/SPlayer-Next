<script setup lang="ts">
import type { TogetherParticipant } from "@/composables/useTogetherPresence";
const props = withDefaults(
  defineProps<{
    participants: TogetherParticipant[];
    joined: boolean;
    layout?: "bar" | "full";
    visible: boolean;
  }>(),
  { layout: "bar" },
);
const visibility = useDocumentVisibility();
const visibleParticipants = computed(() => props.participants.slice(0, 3));
</script>

<template>
  <div
    class="together-avatars"
    :style="{ '--member-center': (visibleParticipants.length - 1) / 2 }"
    :class="[
      `together-avatars--${layout}`,
      { 'is-joined': joined, 'is-visible': visible && visibility === 'visible' },
    ]"
    :aria-hidden="!visible"
  >
    <div
      v-for="(member, index) in visibleParticipants"
      :key="index === 0 ? 'self' : index"
      class="together-avatar"
      :class="{ 'is-waiting': member.waiting }"
      :style="{ '--member-index': index }"
      :title="member.name"
    >
      <SocialAvatar
        :src="member.avatar"
        :name="member.name"
        :image-size="layout === 'full' ? 160 : 112"
        class="together-avatar-image"
      />
      <span v-if="member.waiting" class="together-waiting-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </div>
    <span v-if="participants.length > 3" class="together-extra-count">
      +{{ participants.length - 3 }}
    </span>
  </div>
</template>

<style scoped>
.together-avatars {
  position: relative;
  height: var(--together-avatar-size, 56px);
  width: 100%;
}
.together-avatar {
  position: absolute;
  width: var(--together-avatar-size, 56px);
  height: var(--together-avatar-size, 56px);
  border-radius: 50%;
  transform: translateX(calc(var(--member-index) * (var(--together-avatar-size, 56px) + 6px)));
  transition:
    transform var(--together-duration) var(--together-easing),
    filter var(--together-duration) var(--together-easing);
}
.together-avatar-image {
  width: 100%;
  height: 100%;
  box-shadow: 0 0 0 2px rgb(var(--s-on-surface) / 0.12);
}
.together-avatar::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: rgb(0 0 0 / 0);
  transition: background 200ms;
}
.together-avatar.is-waiting {
  filter: grayscale(0.55) brightness(0.8);
}
.together-avatars--bar.is-joined .together-avatar {
  transform: translateX(calc(var(--member-index) * var(--together-avatar-size, 56px) * 0.72));
}
.together-avatars--full .together-avatar {
  left: calc(50% - var(--together-avatar-size, 80px) / 2);
  transform: translateX(
    calc((var(--member-index) - var(--member-center)) * (var(--together-avatar-size, 80px) + 24px))
  );
}
.together-avatars--full.is-joined .together-avatar {
  transform: translateX(
    calc((var(--member-index) - var(--member-center)) * var(--together-avatar-size, 80px) * 0.9)
  );
}
.together-waiting-dots {
  position: absolute;
  inset: 0;
  display: flex;
  gap: 4px;
  align-items: center;
  justify-content: center;
}
.together-waiting-dots i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: white;
  animation: together-dot 1.2s ease-in-out infinite paused;
}
.is-visible .together-waiting-dots i {
  animation-play-state: running;
}
.together-waiting-dots i:nth-child(2) {
  animation-delay: 150ms;
}
.together-waiting-dots i:nth-child(3) {
  animation-delay: 300ms;
}
.together-extra-count {
  position: absolute;
  right: 0;
  bottom: 0;
  font-size: 12px;
}
@keyframes together-dot {
  0%,
  80%,
  100% {
    opacity: 0.35;
  }
  40% {
    opacity: 1;
  }
}
@media (prefers-reduced-motion: reduce) {
  .together-avatar {
    transition: none;
  }
  .together-waiting-dots i {
    animation: none;
  }
}
</style>
