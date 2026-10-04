import { useTogetherStore } from "@/stores/together";
import { useSocialStore } from "@/stores/social";
import { useUserStore } from "@/stores/user";

export interface TogetherParticipant {
  id: string;
  name: string;
  avatar?: string;
  waiting?: boolean;
}

/** 展示状态复用现有房间与账号存储，不新增网络订阅或计时器。 */
export const useTogetherPresence = () => {
  const together = useTogetherStore();
  const social = useSocialStore();
  const user = useUserStore();
  const { t } = useI18n();
  const selfId = computed(() => String(user.profile?.userId || ""));
  const active = computed(
    () =>
      !!user.profile &&
      !!together.snapshot.roomId &&
      together.snapshot.members.some((member) => member.id === selfId.value) &&
      (together.snapshot.playbackOwned || together.snapshot.mode === "desktop-cdp") &&
      ["waiting", "together", "togetherOwner"].includes(together.snapshot.status),
  );
  const currentJoined = computed(() =>
    together.snapshot.members.some((member) => member.id !== selfId.value),
  );
  const currentParticipants = computed<TogetherParticipant[]>(() => {
    const self = together.snapshot.members.find((member) => member.id === selfId.value);
    const own = {
      id: selfId.value || "self",
      name: self?.name || user.profile?.nickname || "",
      avatar: self?.avatar || user.profile?.avatarUrl,
    };
    const others = together.snapshot.members
      .filter((member) => member.id !== selfId.value)
      .sort((a, b) => a.id.localeCompare(b.id));
    if (others.length) return [own, ...others].slice(0, 10);
    const peer = social.snapshot.conversations.find(
      (item) => item.peerId === together.invitedPeerId,
    );
    return [
      own,
      {
        id: together.invitedPeerId || "pending",
        name: peer?.name || together.invitedPeerId || t("social.together.inviteFriend"),
        avatar: peer?.avatar,
        waiting: !!together.invitedPeerId,
      },
    ];
  });
  const currentCaption = computed(() => {
    if (!together.snapshot.connected) return t("social.together.reconnecting");
    if (!currentJoined.value)
      return t(
        together.invitedPeerId ? "social.together.waitingFriend" : "social.together.inviteFriend",
      );
    const duration = together.snapshot.effectiveDurationMs;
    if (duration === undefined) return t("social.together.listening");
    const minutes = Math.floor(duration / 60000);
    return t("social.together.duration", {
      hours: Math.floor(minutes / 60),
      minutes: minutes % 60,
    });
  });
  /** 退出淡出期间保留最后一组成员，避免房间清空先把头像替换成占位符。 */
  const presentation = shallowRef({
    participants: currentParticipants.value,
    joined: currentJoined.value,
    caption: currentCaption.value,
  });
  watchEffect(() => {
    if (active.value)
      presentation.value = {
        participants: currentParticipants.value,
        joined: currentJoined.value,
        caption: currentCaption.value,
      };
  });
  return {
    active,
    joined: computed(() => presentation.value.joined),
    participants: computed(() => presentation.value.participants),
    caption: computed(() => presentation.value.caption),
  };
};
