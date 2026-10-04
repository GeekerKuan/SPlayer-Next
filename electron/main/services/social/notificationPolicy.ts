import type { SocialConversation, SocialSnapshot } from "@shared/types/social";

/** 首次在线快照只建立基线；缓存、已读、本机忽略及自己的邀请均不弹通知。 */
export class SocialNotificationPolicy {
  private accountId = "";
  private times = new Map<string, number>();
  private watermark = 0;
  reset(): void {
    this.accountId = "";
    this.times.clear();
    this.watermark = 0;
  }
  consume(snapshot: SocialSnapshot): SocialConversation[] {
    if (snapshot.status === "auth-required") {
      this.reset();
      return [];
    }
    if (snapshot.status !== "online") return [];
    const baseline = this.accountId !== snapshot.accountId;
    if (baseline) {
      this.accountId = snapshot.accountId;
      this.times.clear();
    }
    const result: SocialConversation[] = [];
    for (const item of snapshot.conversations) {
      const time = this.times.get(item.peerId) ?? this.watermark;
      this.times.delete(item.peerId);
      this.times.set(item.peerId, item.updatedAt);
      if (
        !baseline &&
        item.unread > 0 &&
        item.updatedAt > time &&
        item.updatedAt >= snapshot.updatedAt - 60000 &&
        !(item.content?.kind === "invite" && item.content.invite?.inviterId === snapshot.accountId)
      )
        result.push(item);
    }
    while (this.times.size > 500) this.times.delete(this.times.keys().next().value!);
    this.watermark = Math.max(this.watermark, snapshot.updatedAt);
    return result.slice(0, 3);
  }
}
