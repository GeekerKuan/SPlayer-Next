const open = ref(false);
const peerId = ref<string>();
const debug = ref(false);
const fallbackLink = ref("");

/** 与设置弹窗共用原生 SDialog 方式；播放栏和全屏播放器共用唯一实例。 */
export const useTogetherDialog = () => ({
  open,
  peerId,
  debug,
  fallbackLink,
  show: (peer?: string): void => {
    debug.value = false;
    fallbackLink.value = "";
    peerId.value = peer;
    open.value = true;
  },
  showDebug: (): void => {
    debug.value = true;
    fallbackLink.value = "";
    open.value = true;
  },
  showLink: (link: string): void => {
    debug.value = false;
    fallbackLink.value = link;
    open.value = true;
  },
});
