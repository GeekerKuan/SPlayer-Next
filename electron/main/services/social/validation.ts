import { z } from "zod";

export const socialPeer = z.string().regex(/^[1-9]\d{0,19}$/);
export const socialTime = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const socialOffset = z.number().int().min(0).max(100000);
export const socialNoticeKind = z.enum(["notice", "mention", "comment"]);
export const socialSend = z
  .object({
    peerId: socialPeer,
    text: z
      .string()
      .trim()
      .refine((text) => /[^\s\u200B-\u200D\uFEFF]/u.test(text), "empty-message")
      .refine((text) => Array.from(text).length <= 500, "message-too-long"),
    clientId: z.string().uuid(),
  })
  .strict();
