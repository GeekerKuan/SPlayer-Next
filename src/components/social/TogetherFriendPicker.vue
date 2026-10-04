<script setup lang="ts">
import type { TogetherFriendPage } from "@shared/types/together";
import { useUserStore } from "@/stores/user";
import { useSocialStore } from "@/stores/social";

defineProps<{ disabled?: boolean }>();
const model = defineModel<string>({ default: "" });
const user = useUserStore();
const social = useSocialStore();
const { t } = useI18n();
type Friend = TogetherFriendPage["items"][number];
type Kind = "following" | "followers";
const following = shallowRef<Friend[]>([]);
const followers = shallowRef<Friend[]>([]);
const more = reactive({ following: false, followers: false });
const offsets = { following: 0, followers: 0 };
const loading = ref(false);
const failed = ref(false);
let failedKinds: Kind[] = [];
let generation = 0;
let disposed = false;
const options = computed(() => {
  const followerIds = new Set(followers.value.map((friend) => friend.id));
  const seen = new Set([String(user.profile?.userId)]);
  const rows: { value: string; label: string; group: string }[] = [];
  const add = (friends: Friend[], group: string): void => {
    for (const friend of friends) {
      if (seen.has(friend.id)) continue;
      seen.add(friend.id);
      rows.push({ value: friend.id, label: friend.name, group: t(`social.together.${group}`) });
    }
  };
  add(
    following.value.filter((friend) => friend.mutual || followerIds.has(friend.id)),
    "mutualFriends",
  );
  add(
    followers.value.filter((friend) => friend.mutual),
    "mutualFriends",
  );
  add(following.value, "followingFriends");
  add(followers.value, "followersFriends");
  add(
    social.snapshot.conversations
      .slice(0, 30)
      .map((peer) => ({ id: peer.peerId, name: peer.name || peer.peerId, mutual: false })),
    "recentPeers",
  );
  return rows;
});

/** 只读取可见邀请界面；账号切换或关闭时忽略旧响应，更多页由用户主动加载。 */
async function load(kinds: Kind[], current: number): Promise<void> {
  if (disposed || current !== generation) return;
  loading.value = true;
  const results = await Promise.allSettled(
    kinds.map(async (kind) => {
      const response = await window.api.together.friends(kind, offsets[kind]);
      if (disposed || current !== generation) return;
      if (!response.ok) throw new Error(response.error);
      const list = kind === "following" ? following : followers;
      list.value = [...list.value, ...response.data.items];
      more[kind] = response.data.more;
      offsets[kind] += 100;
    }),
  );
  if (disposed || current !== generation) return;
  failedKinds = kinds.filter((_, index) => results[index].status === "rejected");
  failed.value = failedKinds.length > 0;
  loading.value = false;
}
watch(
  () => user.profile?.userId,
  (accountId) => {
    const current = ++generation;
    following.value = [];
    followers.value = [];
    more.following = more.followers = false;
    offsets.following = offsets.followers = 0;
    failed.value = false;
    failedKinds = [];
    loading.value = false;
    if (accountId) void load(["following", "followers"], current);
  },
  { immediate: true },
);
function loadMore(): void {
  if (loading.value) return;
  const kinds = (["following", "followers"] as const).filter((kind) => more[kind]);
  void load([...kinds], generation);
}
onBeforeUnmount(() => {
  disposed = true;
  generation++;
});
</script>

<template>
  <div class="flex flex-col gap-1 min-w-0">
    <SSelect
      v-model="model"
      :options="options"
      :disabled="disabled"
      :placeholder="t(loading ? 'social.together.loadingFriends' : 'social.together.chooseFriend')"
    />
    <p v-if="failed" class="text-xs text-on-surface-variant" role="status">
      {{ t("social.together.friendsUnavailable") }}
    </p>
    <SButton
      v-if="failed"
      size="small"
      variant="ghost"
      :loading="loading"
      :disabled="disabled"
      @click="load([...failedKinds], generation)"
    >
      {{ t("social.together.retry") }}
    </SButton>
    <SButton
      v-if="more.following || more.followers"
      size="small"
      variant="ghost"
      :loading="loading"
      :disabled="disabled"
      @click="loadMore"
    >
      {{ t("social.together.moreFriends") }}
    </SButton>
  </div>
</template>
