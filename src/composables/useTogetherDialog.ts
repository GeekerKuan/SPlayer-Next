import { useUserStore } from "@/stores/user";
import type { TogetherClipboardInvite } from "@shared/types/together";

const open = ref(false);
const peerId = ref<string>();
const debug = ref(false);
const fallbackLink = ref("");
const clipboardInvite = shallowRef<TogetherClipboardInvite | null>(null);

/** 与设置弹窗共用原生 SDialog 方式；播放栏和全屏播放器共用唯一实例。 */
export const useTogetherDialog = () => ({
  open,
  peerId,
  debug,
  fallbackLink,
  clipboardInvite,
  show: (peer?: string): void => {
    debug.value = false;
    clipboardInvite.value = null;
    fallbackLink.value = "";
    peerId.value = peer;
    open.value = true;
  },
  showDebug: (): void => {
    debug.value = true;
    clipboardInvite.value = null;
    fallbackLink.value = "";
    open.value = true;
  },
  showLink: (link: string): void => {
    debug.value = false;
    clipboardInvite.value = null;
    fallbackLink.value = link;
    open.value = true;
  },
  showInvitation: (invite: TogetherClipboardInvite): void => {
    if (invite.invitation?.inviterId === String(useUserStore().profile?.userId)) return;
    debug.value = false;
    fallbackLink.value = "";
    peerId.value = undefined;
    clipboardInvite.value = invite;
    open.value = true;
  },
});
