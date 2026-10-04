import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractTogetherShare,
  isTogetherShortLink,
  parseTogetherLink,
  parseTogetherSongId,
  TOGETHER_SHARE_MARKER,
} from "../../shared/utils/togetherLink";

test("clipboard invitations accept platform links and the application marker without treating it as authorization", () => {
  const link =
    "https://st.music.163.com/listen-together/share/?roomId=room-test&inviterId=2&songId=3";
  assert.deepEqual(parseTogetherLink(link), { roomId: "room-test", inviterId: "2" });
  assert.equal(parseTogetherSongId(link), "3");
  assert.equal(parseTogetherSongId(`${link}&songId=4`), undefined);
  assert.equal(parseTogetherSongId(link.replace("songId=3", "songId=bad")), undefined);
  assert.equal(parseTogetherSongId(link.replace("st.music.163.com", "evil.test")), undefined);
  assert.deepEqual(extractTogetherShare(`我的耳机分你一半 ${link} ${TOGETHER_SHARE_MARKER}`), {
    url: link,
    marked: true,
  });
  assert.equal(
    extractTogetherShare(`一起听 https://163cn.tv/example @Splayer-Next`)?.marked,
    false,
  );
  assert.equal(extractTogetherShare(`https://163cn.tv/example https://163cn.tv/another`), null);
  assert.equal(extractTogetherShare("a".repeat(8193)), null);
});

test("invite links reject foreign hosts, credentials, duplicate room identifiers and protocol injection", () => {
  for (const link of [
    "https://st.music.163.com.evil.test/listen-together/share/?roomId=room&inviterId=2",
    "https://user:secret@st.music.163.com/listen-together/share/?roomId=room&inviterId=2",
    "https://st.music.163.com/listen-together/share/?roomId=room&roomId=other&inviterId=2",
    "orpheus://nm/run?roomId=room&inviterId=2",
  ])
    assert.equal(parseTogetherLink(link), null);
  for (const link of [
    "https://163cn.tv.evil.test/example",
    "http://163cn.tv/example",
    "https://163cn.tv/example?next=evil",
    "https://163cn.tv:8443/example",
  ])
    assert.equal(isTogetherShortLink(link), false);
});
