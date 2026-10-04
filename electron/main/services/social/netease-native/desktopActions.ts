import { z } from "zod";
import type { TogetherSong } from "@shared/types/together";

const id = z.string().regex(/^[1-9]\d{0,19}$/);
export const togetherSongSchema = z.object({
  id,
  name: z.string().max(500),
  artists: z.string().max(1000),
  durationMs: z.number().finite().min(0).max(86400000),
});
export const togetherSnapshotSchema = z.object({
  connected: z.boolean(),
  status: z.enum(["alone", "waiting", "togetherOwner", "together", "timeout"]),
  roomId: z.string().regex(/^[A-Za-z0-9_-]{0,128}$/),
  members: z.array(z.object({ id, name: z.string().max(500) })).max(10),
  songs: z.array(togetherSongSchema).max(500),
  songId: z.string().regex(/^\d{0,20}$/),
  playing: z.boolean(),
  progressMs: z.number().finite().min(0).max(86400000),
  updatedAt: z.number(),
  error: z.string().optional(),
});

/** 推荐结果仅保留候选所需轻量字段，禁止把完整歌曲响应通过 IPC 广播。 */
export const decodeRecommendations = (body: Record<string, unknown>): TogetherSong[] => {
  const source = z
    .object({ data: z.object({ dailySongs: z.array(z.unknown()).max(1000) }) })
    .parse(body);
  const result = new Map<string, TogetherSong>();
  for (const value of source.data.dailySongs.slice(0, 100)) {
    const parsed = z
      .object({
        id: z.union([id, z.number().int().positive()]).transform(String),
        name: z.string().max(500),
        dt: z.number().finite().min(0).max(86400000),
        ar: z.array(z.object({ name: z.string().max(100) })).max(20),
      })
      .safeParse(value);
    if (!parsed.success) continue;
    const song = parsed.data;
    result.set(song.id, {
      id: song.id,
      name: song.name,
      artists: song.ar.map((a) => a.name).join(" / "),
      durationMs: song.dt,
    });
  }
  return [...result.values()];
};

/** 固定构建的操作白名单；表达式不能来自渲染进程或网络响应。 */
export const desktopActionExpression = (input: Record<string, unknown>): string =>
  `(${String.raw`function(args) {
    if (![...document.scripts].some(s => /\/app\.chunk\.d4d4312\.js(?:$|\?)/.test(s.src))) return {error:'unsupported-build'};
    const node = document.querySelector('[data-testid="tid_createplaylist_section"]');
    let fiber = node?.[Object.keys(node).find(k => /^__react(?:InternalInstance|Fiber)/.test(k)) || ''];
    let store;
    for (let depth=0; fiber && depth<100; depth++, fiber=fiber.return) {
      const candidate = fiber.memoizedProps?.value?.store;
      if (typeof candidate?.getState === 'function' && typeof candidate.dispatch === 'function') {store=candidate;break;}
    }
    if (!store) return {error:'store-missing'};
    const state=store.getState(), room=state['async:listenTogether'];
    if (String(state.host?.uid)!==args.accountId || state.host?.isAnonymous!==false) return {error:'account-mismatch'};
    if (!room || !state['async:listenTogetherPlayList'] || !state['async:listenTogetherPlayStatus']) return {error:'model-missing'};
    if (args.expectedRoom !== undefined && room.roomInfo?.roomId !== args.expectedRoom) return {error:'room-changed'};
    const dispatch=(type,payload={})=>store.dispatch({type,payload});
    if (args.action==='create') {
      if (!['alone','timeout','waiting'].includes(room.status)) return {error:'already-in-room'};
      dispatch('async:listenTogether/startListenTogether',{refer:'splayer_social',...(args.peerId ? {target: {userId:Number(args.peerId)}} : {})});
    } else if (args.action==='accept') {
      if (!['alone','timeout'].includes(room.status)) return {error:'already-in-room'};
      dispatch('async:listenTogether/acceptListenTogether',{refer:'inbox_invite',roomId:args.roomId,inviterId:args.inviterId});
    } else if (args.action!=='state') {
      if (!room.roomInfo?.roomId || !['waiting','together','togetherOwner'].includes(room.status)) return {error:'room-unavailable'};
      switch(args.action) {
        case 'leave': dispatch('async:listenTogether/leaveListenTogether',{silent:true}); break;
        case 'pause': dispatch('playing/pause'); break;
        case 'resume': dispatch('playing/resume'); break;
        case 'next': case 'previous': dispatch('async:listenTogetherPlayer/jump2Track',{flag:args.action==='next'?1:-1}); break;
        case 'seek': dispatch('playing/setPlayingPosition',{duration:args.positionMs/1000});
          dispatch('async:listenTogetherPlayStatus/reportRequest',{command:'PROGRESS',position:args.positionMs/1000,reason:'splayer_seek'}); break;
        case 'add': {
          const ids=state['async:listenTogetherPlayList'].displayTrackIds || [];
          if (ids.length>=500) return {error:'queue-full'};
          if (ids.some(id=>String(id)===args.songId)) return {error:'already-in-queue'};
          dispatch('async:listenTogetherPlayList/handlePlayingListChange',{commandType:'ADD',addTrackIds:[args.songId]}); break;
        }
        default:return {error:'invalid-action'};
      }
    }
    const latest=store.getState(), current=latest['async:listenTogether'], playing=latest.playing;
    const status=latest['async:listenTogetherPlayStatus'].lastestStatus;
    const entries=latest.playingList?.curPlayingList || [];
    const songs=(latest['async:listenTogetherPlayList'].displayTrackIds || []).slice(0,500).map(id=>{
      const track=entries.find(e=>String(e.resourceId || e.id || e.track?.id)===String(id))?.track;
      return {id:String(id),name:String(track?.name || id).slice(0,500),artists:(track?.artists || []).slice(0,20).map(a=>String(a.name).slice(0,100)).join(' / ').slice(0,1000),durationMs:Number(track?.duration || 0)};
    });
    const isPlaying=playing.playingState===2;
    let progress=Number(status?.progress || 0);
    if (isPlaying && status?.localTime && status?.playStatus==='PLAY') progress+=Math.max(0,Date.now()-Number(status.localTime));
    const songId=String(playing.curPlaying?.resourceId || '');
    const duration=songs.find(s=>s.id===songId)?.durationMs;
    return {connected:true,status:current.status,roomId:current.roomInfo?.roomId || '',
      members:(current.roomMembers || []).slice(0,10).map(m=>({id:String(m.userId),name:String(m.nickname || '').slice(0,500)})),
      songs,songId,playing:isPlaying,progressMs:Math.min(duration || 86400000,Math.max(0,progress)),updatedAt:Date.now()};
  }`})(${JSON.stringify(input)})`;
