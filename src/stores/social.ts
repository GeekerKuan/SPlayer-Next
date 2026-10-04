import type { SocialMessage, SocialResult, SocialSnapshot, NoticeKind } from "@shared/types/social";

const emptySnapshot = (): SocialSnapshot => ({
  accountId: "",
  conversations: [],
  messages: {},
  notices: [],
  readTimes: {},
  status: "auth-required",
  updatedAt: 0,
  capabilities: { nativeReadReceipt: false, together: false, transport: "eapi-poll" },
});

export const useSocialStore = defineStore("social", () => {
  const snapshot = shallowRef<SocialSnapshot>(emptySnapshot());
  const selected = ref("");
  const activeTab = ref("chat");
  const error = ref("");
  const busy = ref(false);
  const sending = ref(false);
  const drafts = reactive<Record<string, string>>({});
  const historyMore = reactive<Record<string, boolean>>({});
  const noticeMore = reactive<Record<string, boolean>>({});
  const noticeCursors = reactive<Record<string, number>>({});
  const conversationsMore = ref(true);
  const conversationCursor = ref(0);
  let unsubscribe: (() => void) | null = null;
  let epoch = 0;
  let readJob: Promise<void> | null = null;
  const messages = computed<SocialMessage[]>(() => snapshot.value.messages[selected.value] ?? []);
  const unread = computed(() =>
    snapshot.value.conversations.reduce((total, item) => total + item.unread, 0),
  );
  const draft = computed({
    get: () => drafts[selected.value] ?? "",
    set: (value: string) => {
      drafts[selected.value] = value.slice(0, 4000);
      for (const key of Object.keys(drafts).slice(0, Math.max(0, Object.keys(drafts).length - 20)))
        delete drafts[key];
    },
  });

  const apply = (next: SocialSnapshot): void => {
    if (next.accountId !== snapshot.value.accountId) {
      readJob = null;
      selected.value = "";
      for (const map of [drafts, historyMore, noticeMore, noticeCursors])
        for (const key of Object.keys(map)) delete map[key];
      conversationsMore.value = true;
      conversationCursor.value = 0;
    }
    snapshot.value = next;
  };
  const unwrap = <T>(result: SocialResult<T>): T => {
    if (!result.ok) {
      if (result.error !== "busy") error.value = result.error;
      throw new Error(result.error);
    }
    return result.data;
  };
  async function start(): Promise<void> {
    const current = ++epoch;
    unsubscribe?.();
    unsubscribe = window.api.social.onUpdate(apply);
    const result = await window.api.social.start();
    if (current === epoch) apply(unwrap(result));
  }
  function stop(): void {
    epoch++;
    readJob = null;
    busy.value = false;
    sending.value = false;
    unsubscribe?.();
    unsubscribe = null;
    void window.api.social.stop();
  }
  async function refresh(): Promise<void> {
    if (busy.value) return;
    busy.value = true;
    error.value = "";
    const current = epoch;
    try {
      const result = await window.api.social.refresh();
      if (current === epoch) apply(unwrap(result));
    } catch {
      /* 页面使用统一错误区。 */
    } finally {
      if (current === epoch) busy.value = false;
    }
  }
  async function select(peerId: string): Promise<void> {
    selected.value = peerId;
    error.value = "";
    const current = epoch;
    try {
      const result = await window.api.social.open(peerId);
      if (current === epoch && selected.value === peerId) historyMore[peerId] = unwrap(result).more;
    } catch {
      /* 缓存仍可阅读。 */
    }
  }
  async function older(): Promise<void> {
    if (busy.value || !selected.value) return;
    const peerId = selected.value;
    const before = messages.value.find((item) => !item.clientId)?.time ?? 0;
    if (!before) return;
    busy.value = true;
    const current = epoch;
    try {
      const result = await window.api.social.history(peerId, before);
      if (current !== epoch) return;
      const page = unwrap(result);
      historyMore[peerId] = page.more && page.cursor < before;
    } catch {
      /* 统一错误区。 */
    } finally {
      if (current === epoch) busy.value = false;
    }
  }
  async function moreConversations(): Promise<void> {
    if (busy.value || !conversationsMore.value) return;
    busy.value = true;
    const current = epoch;
    try {
      const result = await window.api.social.conversations(conversationCursor.value);
      if (current !== epoch) return;
      const page = unwrap(result);
      conversationsMore.value = page.more;
      conversationCursor.value = page.cursor;
    } catch {
      /* 统一错误区。 */
    } finally {
      if (current === epoch) busy.value = false;
    }
  }
  async function loadNotices(kind: NoticeKind, more = false): Promise<void> {
    if (busy.value) return;
    busy.value = true;
    error.value = "";
    const current = epoch;
    try {
      const result = await window.api.social.notifications(
        kind,
        more ? (noticeCursors[kind] ?? -1) : -1,
      );
      if (current !== epoch) return;
      const page = unwrap(result);
      noticeMore[kind] = page.more;
      noticeCursors[kind] = page.cursor;
    } catch {
      /* 统一错误区。 */
    } finally {
      if (current === epoch) busy.value = false;
    }
  }
  async function send(): Promise<void> {
    if (sending.value || !selected.value) return;
    const text = draft.value.trim();
    if (!/[^\s\u200B-\u200D\uFEFF]/u.test(text)) {
      error.value = "empty-message";
      return;
    }
    if (Array.from(text).length > 500) {
      error.value = "message-too-long";
      return;
    }
    const peerId = selected.value;
    const current = epoch;
    sending.value = true;
    error.value = "";
    try {
      const response = await window.api.social.send({
        peerId,
        text,
        clientId: crypto.randomUUID(),
      });
      if (current !== epoch) return;
      const result = unwrap(response);
      if (result.delivery === "sent" && drafts[peerId]?.trim() === text) drafts[peerId] = "";
      if (result.delivery === "unknown") error.value = "send-unknown";
      if (result.delivery === "failed") error.value = "send-failed";
    } catch {
      /* 失败保留草稿，不自动重发。 */
    } finally {
      if (current === epoch) sending.value = false;
    }
  }
  async function read(time: number): Promise<void> {
    if (!selected.value || time === 0 || (snapshot.value.readTimes[selected.value] ?? 0) >= time)
      return;
    if (readJob) return readJob;
    const current = epoch;
    const peerId = selected.value;
    const job = (async () => {
      try {
        const result = await window.api.social.localRead(peerId, time);
        if (!result.ok && current === epoch && !["busy", "rate-limited"].includes(result.error))
          error.value = result.error;
      } catch {
        /* 保留未读，不覆盖正在发送的结果。 */
      }
    })();
    readJob = job;
    try {
      await job;
    } finally {
      if (readJob === job) readJob = null;
    }
  }
  async function dismissInvite(messageId: string): Promise<void> {
    if (!selected.value) return;
    try {
      unwrap(await window.api.social.dismissInvite(selected.value, messageId));
    } catch {
      /* 统一错误区。 */
    }
  }
  return {
    snapshot,
    selected,
    activeTab,
    error,
    busy,
    sending,
    drafts,
    draft,
    messages,
    unread,
    historyMore,
    conversationsMore,
    noticeMore,
    start,
    stop,
    refresh,
    select,
    older,
    moreConversations,
    loadNotices,
    send,
    read,
    dismissInvite,
  };
});
