import { z } from "zod";
import type { SocialSnapshot } from "@shared/types/social";
import type { TogetherClipboardInvite, TogetherInvitePreview } from "@shared/types/together";
import type { NativeTransport } from "./netease-native/transport";
import { decodeRoomSongs } from "./netease-native/roomCodec";

/** 预览只读，不连接、接管房间或建立心跳；部分元数据不可用不影响用户确认入房。 */
export const loadInvitePreview = async (
  invite: TogetherClipboardInvite,
  account: SocialSnapshot,
  transport: NativeTransport,
  signal: AbortSignal,
): Promise<TogetherInvitePreview> => {
  if (!invite.invitation) throw new Error("invalid-input");
  if (!account.accountId || account.status === "auth-required") throw new Error("auth-required");
  const { inviterId, roomId } = invite.invitation;
  const cached = account.conversations.find((peer) => peer.peerId === inviterId);
  const preview: TogetherInvitePreview = {
    inviter: { id: inviterId, name: cached?.name || inviterId, avatar: cached?.avatar },
  };
  const results = await Promise.allSettled([
    cached?.avatar
      ? Promise.resolve(null)
      : transport.call("userDetail", { all: "true", userId: inviterId }, signal),
    invite.songId
      ? transport.call(
          "roomSongs",
          { c: JSON.stringify([{ id: invite.songId }]), ids: JSON.stringify([invite.songId]) },
          signal,
        )
      : Promise.resolve(null),
    transport.call("roomCheck", { roomId }, signal),
  ]);
  signal.throwIfAborted();
  for (const result of results) {
    if (
      result.status === "rejected" &&
      result.reason instanceof Error &&
      ["auth-required", "account-changed"].includes(result.reason.message)
    )
      throw result.reason;
  }
  const [profile, song, check] = results;
  if (profile.status === "fulfilled" && profile.value) {
    const parsed = z
      .object({
        profile: z.object({
          userId: z.union([z.string(), z.number()]).transform(String),
          nickname: z.string().max(500),
          avatarUrl: z.string().url().max(2048).optional(),
        }),
      })
      .safeParse(profile.value);
    if (parsed.success && parsed.data.profile.userId === inviterId) {
      preview.inviter = {
        id: inviterId,
        name: parsed.data.profile.nickname,
        avatar: parsed.data.profile.avatarUrl,
      };
    }
  }
  if (song.status === "fulfilled" && song.value) {
    const parsed = z.object({ songs: z.array(z.unknown()).max(600) }).safeParse(song.value);
    if (parsed.success)
      preview.song = decodeRoomSongs(song.value).find((s) => s.id === invite.songId);
  }
  if (check.status === "fulfilled") {
    const parsed = z
      .object({
        data: z.object({
          joinable: z.boolean(),
          copywriting: z.string().max(500).optional(),
        }),
      })
      .safeParse(check.value);
    if (parsed.success) {
      preview.joinable = parsed.data.data.joinable;
      preview.hint = parsed.data.data.copywriting;
    }
  }
  return preview;
};
