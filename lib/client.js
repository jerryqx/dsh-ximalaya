/**
 * dsh-ximalaya client half: the browser player, loaded by the web
 * ModuleLoader as a plain React plugin. It injects a now-playing bar into the
 * composer dock and a floating panel (search / album detail / login+favs)
 * that talks to the Host half over plain HTTP (/dsh-ximalaya/* routes).
 *
 * Audio is a native <audio> element whose src points at the Host's stream
 * relay (/dsh-ximalaya/stream?trackId=...) — no CORS concerns, Range/seek
 * supported, login state stays Host-side. Play prefs (volume / rate /
 * last-playback / panel geometry) persist on the Host, so a refresh (or a
 * dsh-desktop restart with a random port) restores the session.
 *
 * The agent's ximalaya_play tool lands as an "intent" polled every 2s.
 */
window.__ModuleLoader__.load({
  id: 'dsh-ximalaya',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const useState = React.useState;
    const useEffect = React.useEffect;
    const useRef = React.useRef;
    const useCallback = React.useCallback;

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------
    const fmtTime = (sec) => {
      const s = Math.max(0, Math.floor(sec || 0));
      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
      const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
      const ss = String(r).padStart(2, '0');
      return h > 0 ? h + ':' + mm + ':' + ss : mm + ':' + ss;
    };
    const fmtCount = (n) => {
      const v = Number(n) || 0;
      if (v >= 100000000) return (v / 100000000).toFixed(1) + '亿';
      if (v >= 10000) return (v / 10000).toFixed(1) + '万';
      return String(v);
    };
    const jsonGet = (url) => fetch(url, { cache: 'no-store' }).then((r) => r.json());
    const jsonPost = (url, body) => fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
    }).then((r) => r.json());

    // ------------------------------------------------------------------
    // store（React 靠 set() 触发重渲染）
    // ------------------------------------------------------------------
    const store = {
      manifestReady: false, loggedIn: false, user: null, favs: [], history: [],
      panelOpen: false, panelPos: null, tab: 'search',
      // 搜索页
      searchKw: '', searching: false, searchError: '',
      searchResults: [], searchTotal: 0, searchPage: 1, searchTotalPages: 1, searchDone: false,
      // 专辑页
      album: null, albumTracks: [], albumPageId: 1, albumMaxPageId: 1,
      albumTotal: 0, albumLoading: false, albumMore: false, albumFav: false, albumError: '',
      // 登录弹层
      qr: null, qrStatus: '', // '' | 'waiting' | 'expired' | 'loading'
      // 「我的」分段：likes 收藏的声音 / subs 订阅的专辑 / anchors 关注的主播 / albums 本地收藏专辑
      mineSeg: 'likes',
      likes: { list: [], total: 0, pageNum: 1, hasMore: false, loading: false, error: '' },
      likesLoaded: false,
      subs: { list: [], total: 0, page: 1, hasMore: false, loading: false, error: '' },
      subsLoaded: false,
      following: { list: [], total: 0, page: 1, hasMore: false, loading: false, error: '' },
      followingLoaded: false,
      // 主播浏览（从关注列表点进某位主播）
      anchorView: null, anchorAlbums: [], anchorTotal: 0, anchorLoading: false, anchorError: '',
      // 播放态
      current: null, // { trackId, trackTitle, albumId, albumTitle, cover, duration, quality }
      playing: false, buffering: false, position: 0, duration: 0,
      volume: 0.9, rate: 1, error: '', pendingTrack: null, restored: false,
      // 提示条
      toast: null, // { text, ok }
    };
    const listeners = new Set();
    function set(patch) {
      Object.assign(store, patch);
      for (const fn of [...listeners]) fn();
    }
    function useStore() {
      const [snap, setSnap] = useState(store);
      useEffect(() => {
        const update = () => setSnap({ ...store });
        listeners.add(update);
        update();
        return () => { listeners.delete(update); };
      }, []);
      return snap;
    }
    function showToast(text, ok = true) {
      set({ toast: { text, ok } });
      clearTimeout(showToast._t);
      showToast._t = setTimeout(() => set({ toast: null }), 2200);
    }

    // ------------------------------------------------------------------
    // audio engine
    // ------------------------------------------------------------------
    const audio = new Audio();
    audio.preload = 'auto';
    let audioAttached = false;

    // 解锁自动播放：用户手势里同步 resume AudioContext，之后的异步 play() 才被放行。
    let unlockCtx = null;
    function unlockAutoplay() {
      try {
        if (unlockCtx === null) {
          const Ctor = window.AudioContext || window.webkitAudioContext;
          if (Ctor === undefined) return;
          unlockCtx = new Ctor();
        }
        if (unlockCtx.state === 'suspended') {
          const p = unlockCtx.resume();
          if (p && p.catch) p.catch(() => {});
        }
      } catch { /* best-effort */ }
    }

    const streamUrl = (trackId) => '/dsh-ximalaya/stream?trackId=' + encodeURIComponent(trackId);

    // 播放地址预检：确认可播（登录/权限）并拿到质量标签，再真正起播。
    async function resolvePlay(trackId) {
      const res = await jsonGet('/dsh-ximalaya/play?trackId=' + encodeURIComponent(trackId));
      if (!res || res.ok !== true) {
        const err = new Error((res && res.error) || '播放地址获取失败');
        err.needAuth = !!(res && res.needAuth);
        throw err;
      }
      return res;
    }

    let saveTimer = null;
    function persistPlayback() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        const cur = store.current;
        jsonPost('/dsh-ximalaya/prefs', {
          prefs: { volume: store.volume, rate: store.rate },
          playback: cur ? {
            albumId: cur.albumId || 0,
            albumTitle: cur.albumTitle || '',
            trackId: cur.trackId,
            trackTitle: cur.trackTitle || '',
            position: audio.currentTime || 0,
            duration: audio.duration || store.duration || 0,
          } : null,
        }).catch(() => {});
      }, 600);
    }
    function persistPanel() {
      jsonPost('/dsh-ximalaya/prefs', { prefs: { panelOpen: store.panelOpen, panelPos: store.panelPos } })
        .catch(() => {});
    }

    async function playTrack(track, albumCtx, opts = {}) {
      // albumCtx: { id, title } —— 用于连续播放（上/下一集）与面板定位。
      unlockAutoplay();
      const target = {
        trackId: track.id,
        trackTitle: track.title,
        albumId: (albumCtx && albumCtx.id) || (track.albumId || 0),
        albumTitle: (albumCtx && albumCtx.title) || track.albumTitle || '',
        cover: track.cover || '',
        quality: '',
      };
      try {
        set({ current: target, error: '', pendingTrack: null, playing: false, buffering: true });
        const info = await resolvePlay(track.id);
        target.quality = info.quality || '';
        set({ current: { ...target } });
        audio.src = streamUrl(track.id);
        audio.playbackRate = store.rate;
        if (opts.position && opts.position > 5) {
          const pos = opts.position;
          const onReady = () => { try { audio.currentTime = Math.min(pos, (audio.duration || pos) - 2) } catch (e) {} };
          audio.addEventListener('loadedmetadata', onReady, { once: true });
        }
        const promise = audio.play();
        set({ playing: true, buffering: false });
        if (promise !== undefined && typeof promise.catch === 'function') {
          promise.catch((err) => {
            if (err && err.name === 'AbortError') return;
            set({ playing: false, error: '浏览器拦截了自动播放，点击▶即可播放' });
          });
        }
        persistPlayback();
      } catch (err) {
        set({
          playing: false, buffering: false,
          error: (err && err.needAuth) ? '该曲目需要登录或已购/VIP 权限（面板「我的」扫码登录）' : '播放失败：' + String((err && err.message) || err),
        });
        if (err && err.needAuth) set({ tab: 'mine', panelOpen: true });
      }
    }

    function step(dir) {
      const cur = store.current;
      if (cur === null) return;
      const list = store.albumTracks.filter((t) => t.id !== undefined);
      const idx = list.findIndex((t) => t.id === cur.trackId);
      if (idx < 0) {
        // 列表里没有当前曲目（恢复播放/直跳场景）：拉取专辑第一页后再试。
        if (cur.albumId) void openAlbum(cur.albumId, { autoAdvanceTo: cur.trackId, dir });
        return;
      }
      const nextIdx = idx + dir;
      if (nextIdx < 0) { void playTrack(list[0], albumCtxOf()); return; }
      if (nextIdx < list.length) { void playTrack(list[nextIdx], albumCtxOf()); return; }
      if (store.albumPageId < store.albumMaxPageId) {
        loadMoreTracks().then((added) => {
          if (added > 0) {
            const fresh = store.albumTracks;
            const i2 = fresh.findIndex((t) => t.id === cur.trackId);
            const n2 = i2 + dir;
            if (n2 >= 0 && n2 < fresh.length) void playTrack(fresh[n2], albumCtxOf());
          }
        });
      }
    }
    const albumCtxOf = () => store.album ? { id: store.album.id, title: store.album.title } : null;

    // ------------------------------------------------------------------
    // network: manifest / search / album / fav / prefs / qr
    // ------------------------------------------------------------------
    async function loadManifest() {
      try {
        const res = await jsonGet('/dsh-ximalaya/manifest');
        if (!res || res.ok !== true) return;
        set({
          manifestReady: true,
          loggedIn: !!res.loggedIn, user: res.user || null,
          favs: res.favs || [], history: res.history || [],
        });
        const prefs = res.prefs || {};
        if (typeof prefs.volume === 'number') { store.volume = prefs.volume; audio.volume = prefs.volume; }
        if (typeof prefs.rate === 'number') { store.rate = prefs.rate; audio.playbackRate = prefs.rate; }
        if (prefs.panelPos && typeof prefs.panelPos.x === 'number') store.panelPos = prefs.panelPos;
        // 恢复上次播放（不自动播，点 ▶ 续听）。
        const pb = res.playback;
        if (pb && pb.trackId && !store.current) {
          set({
            current: {
              trackId: pb.trackId, trackTitle: pb.trackTitle || '',
              albumId: pb.albumId || 0, albumTitle: pb.albumTitle || '',
              cover: '', quality: '',
            },
            restored: true, position: pb.position || 0, duration: pb.duration || 0,
          });
          audio.src = streamUrl(pb.trackId);
          const pos = pb.position || 0;
          audio.addEventListener('loadedmetadata', () => {
            try { if (pos > 5) audio.currentTime = Math.min(pos, (audio.duration || pos) - 2); } catch (e) {}
          }, { once: true });
        }
        set({ manifestReady: true });
      } catch { /* 后端未就绪时静默 */ }
    }

    async function doSearch(kw, page = 1) {
      const q = (kw || '').trim();
      if (q === '') return;
      set({ searching: true, searchError: '', searchKw: q });
      try {
        const res = await jsonGet('/dsh-ximalaya/search?kw=' + encodeURIComponent(q) + '&page=' + page);
        if (!res || res.ok !== true) throw new Error((res && res.error) || '搜索失败');
        const merged = page > 1 ? store.searchResults.concat(res.albums || []) : (res.albums || []);
        set({
          searching: false,
          searchResults: merged,
          searchTotal: res.total || 0,
          searchPage: res.page || page,
          searchTotalPages: res.totalPages || 1,
          searchDone: (res.page || page) >= (res.totalPages || 1) || (res.albums || []).length === 0,
        });
      } catch (err) {
        set({ searching: false, searchError: String((err && err.message) || err) });
      }
    }

    async function openAlbum(albumId, opts = {}) {
      set({ tab: 'album', albumLoading: true, albumError: '', album: null, albumTracks: [], albumTotal: 0, albumPageId: 1, albumMaxPageId: 1, albumFav: false });
      try {
        const [info, list] = await Promise.all([
          jsonGet('/dsh-ximalaya/album?id=' + encodeURIComponent(albumId)),
          jsonGet('/dsh-ximalaya/tracks?albumId=' + encodeURIComponent(albumId) + '&pageId=1&pageSize=30'),
        ]);
        if (!info || info.ok !== true) throw new Error((info && info.error) || '专辑获取失败');
        if (!list || list.ok !== true) throw new Error((list && list.error) || '曲目列表获取失败');
        set({
          albumLoading: false,
          album: info.album,
          albumTracks: list.tracks || [],
          albumPageId: list.pageId || 1,
          albumMaxPageId: list.maxPageId || 1,
          albumTotal: list.totalCount || 0,
          albumFav: store.favs.some((f) => f.id === albumId),
        });
        if (opts.autoAdvanceTo) {
          const cur = store.current;
          const idx = (list.tracks || []).findIndex((t) => t.id === opts.autoAdvanceTo);
          if (idx >= 0) {
            const nextIdx = idx + (opts.dir || 1);
            if (nextIdx >= 0 && nextIdx < list.tracks.length) {
              void playTrack(list.tracks[nextIdx], { id: albumId, title: info.album.title });
            }
          }
        }
      } catch (err) {
        set({ albumLoading: false, albumError: String((err && err.message) || err) });
      }
    }

    async function loadMoreTracks() {
      if (store.album === null || store.albumPageId >= store.albumMaxPageId) return 0;
      const nextPage = store.albumPageId + 1;
      set({ albumMore: true });
      try {
        const list = await jsonGet('/dsh-ximalaya/tracks?albumId=' + encodeURIComponent(store.album.id) + '&pageId=' + nextPage + '&pageSize=30');
        if (!list || list.ok !== true) return 0;
        set({
          albumMore: false,
          albumTracks: store.albumTracks.concat(list.tracks || []),
          albumPageId: list.pageId || nextPage,
          albumMaxPageId: list.maxPageId || 1,
        });
        return (list.tracks || []).length;
      } catch {
        set({ albumMore: false });
        return 0;
      }
    }

    async function toggleFav(album) {
      const active = store.favs.some((f) => f.id === album.id);
      const res = await jsonPost('/dsh-ximalaya/fav', { album, remove: active });
      if (res && res.ok === true) {
        set({ favs: res.favs || [], albumFav: !active });
        showToast(active ? '已取消收藏' : '已收藏「' + (album.title || '').slice(0, 20) + '」');
      } else {
        showToast('收藏操作失败', false);
      }
    }

    // ---- 收藏的声音 / 已关注的主播 / 主播浏览 ----
    async function loadLikes(pageNum = 1) {
      if (!store.loggedIn || store.likes.loading) return;
      set({ likes: { ...store.likes, loading: true, error: '' } });
      try {
        const res = await jsonGet('/dsh-ximalaya/likes?pageNum=' + pageNum + '&pageSize=30');
        if (!res || res.ok !== true) {
          throw new Error((res && res.error) || '获取收藏的声音失败');
        }
        const merged = pageNum > 1 ? store.likes.list.concat(res.tracks || []) : (res.tracks || []);
        set({
          likes: {
            list: merged, total: res.total || 0, pageNum: res.pageNum || pageNum,
            hasMore: !!res.hasMore, loading: false, error: '',
          },
          likesLoaded: true,
        });
      } catch (err) {
        set({ likes: { ...store.likes, loading: false, error: String((err && err.message) || err) } });
      }
    }

    async function loadFollowing(page = 1) {
      if (!store.loggedIn || store.following.loading) return;
      set({ following: { ...store.following, loading: true, error: '' } });
      try {
        const res = await jsonGet('/dsh-ximalaya/following?page=' + page + '&pageSize=20');
        if (!res || res.ok !== true) {
          throw new Error((res && res.error) || '获取关注列表失败');
        }
        const merged = page > 1 ? store.following.list.concat(res.anchors || []) : (res.anchors || []);
        const total = res.total || 0;
        set({
          following: {
            list: merged, total, page: res.page || page,
            hasMore: merged.length < total, loading: false, error: '',
          },
          followingLoaded: true,
        });
      } catch (err) {
        set({ following: { ...store.following, loading: false, error: String((err && err.message) || err) } });
      }
    }

    async function loadSubs(page = 1) {
      if (!store.loggedIn || store.subs.loading) return;
      set({ subs: { ...store.subs, loading: true, error: '' } });
      try {
        const res = await jsonGet('/dsh-ximalaya/subscriptions?page=' + page + '&pageSize=30');
        if (!res || res.ok !== true) {
          throw new Error((res && res.error) || '获取订阅列表失败');
        }
        const merged = page > 1 ? store.subs.list.concat(res.albums || []) : (res.albums || []);
        const total = res.total || 0;
        set({
          subs: {
            list: merged, total, page: res.page || page,
            hasMore: merged.length < total, loading: false, error: '',
          },
          subsLoaded: true,
        });
      } catch (err) {
        set({ subs: { ...store.subs, loading: false, error: String((err && err.message) || err) } });
      }
    }

    async function openAnchor(anchor) {
      set({
        anchorView: anchor, anchorAlbums: [], anchorTotal: 0,
        anchorLoading: true, anchorError: '', tab: 'anchor', panelOpen: true,
      });
      try {
        const res = await jsonGet('/dsh-ximalaya/anchor?uid=' + encodeURIComponent(anchor.uid));
        if (!res || res.ok !== true) throw new Error((res && res.error) || '获取主播专辑失败');
        set({ anchorAlbums: res.albums || [], anchorTotal: res.total || 0, anchorLoading: false });
      } catch (err) {
        set({ anchorLoading: false, anchorError: String((err && err.message) || err) });
      }
    }

    async function startQrLogin() {
      set({ qrStatus: 'loading', qr: null });
      try {
        const res = await jsonPost('/dsh-ximalaya/qr/create', {});
        if (!res || res.ok !== true) throw new Error((res && res.error) || '二维码获取失败');
        set({ qr: res, qrStatus: 'waiting' });
      } catch (err) {
        set({ qrStatus: '', qr: null });
        showToast('二维码获取失败：' + String((err && err.message) || err), false);
      }
    }
    async function pollQr() {
      if (store.qr === null || store.qrStatus !== 'waiting') return;
      try {
        const res = await jsonGet('/dsh-ximalaya/qr/check?qrId=' + encodeURIComponent(store.qr.qrId));
        if (!res || res.ok !== true) return;
        if (res.status === 'success') {
          set({ qr: null, qrStatus: '', loggedIn: true, user: res.user || null });
          showToast('登录成功' + (res.user && res.user.nickname ? '，欢迎 ' + res.user.nickname : ''));
          void loadManifest();
        } else if (res.status === 'expired') {
          set({ qr: null, qrStatus: 'expired' });
        }
      } catch { /* 轮询失败忽略，下次再试 */ }
    }

    // ------------------------------------------------------------------
    // intent 轮询（agent 工具触发的播放/控制）
    // ------------------------------------------------------------------
    async function handleIntent(intent) {
      if (intent === null || typeof intent !== 'object') return;
      const action = intent.action || 'play';
      if (action === 'pause') { audio.pause(); set({ playing: false }); return; }
      if (action === 'resume') {
        unlockAutoplay();
        const p = audio.play();
        if (p && p.catch) p.catch(() => { set({ error: '浏览器拦截了自动播放，点击▶即可播放' }); });
        return;
      }
      if (action === 'stop') {
        try { audio.pause(); } catch (e) {}
        audio.removeAttribute('src'); try { audio.load(); } catch (e) {}
        set({ playing: false, current: null, position: 0, duration: 0 });
        return;
      }
      if (action === 'next') { step(1); return; }
      if (action === 'prev') { step(-1); return; }
      // play：优先 trackId；带 albumId 时顺便把专辑载进面板（保证连续播放上下文）。
      if (typeof intent.trackId === 'number' && intent.trackId > 0) {
        const track = {
          id: intent.trackId,
          title: intent.trackTitle || ('曲目 #' + intent.trackId),
          albumId: intent.albumId || 0,
          albumTitle: intent.albumTitle || '',
          cover: '',
        };
        if (intent.albumId) {
          void openAlbum(intent.albumId, {});
        }
        void playTrack(track, intent.albumId ? { id: intent.albumId, title: intent.albumTitle || '' } : null);
        if (store.restored) set({ restored: false });
      }
    }

    // ------------------------------------------------------------------
    // UI: 播放条
    // ------------------------------------------------------------------
    function ProgressBar({ compact }) {
      const s = useStore();
      const dur = s.duration || (s.current && s.current.duration) || 0;
      const pct = dur > 0 ? Math.min(1, s.position / dur) : 0;
      const seek = (ev) => {
        const el = ev.currentTarget;
        const r = el.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
        if (dur > 0) { try { audio.currentTime = ratio * dur; } catch (e) {} }
      };
      return React.createElement('div', {
        className: 'xmly-progress' + (compact ? ' xmly-progress-compact' : ''),
        onClick: seek,
        title: dur > 0 ? fmtTime(s.position) + ' / ' + fmtTime(dur) : '',
      }, [
        React.createElement('div', { key: 'fill', className: 'xmly-progress-fill', style: { width: (pct * 100).toFixed(2) + '%' } }),
      ]);
    }

    function VolumePopup({ anchorRef }) {
      const s = useStore();
      return React.createElement('div', { className: 'xmly-pop xmly-vol-pop' }, [
        React.createElement('div', { key: 'row', className: 'xmly-vol-row' }, [
          React.createElement('span', { key: 'i', className: 'xmly-ico', onClick: () => { const v = audio.volume > 0 ? 0 : 0.9; audio.volume = v; set({ volume: v }); persistPlayback(); } }, audio.volume > 0 ? '🔊' : '🔇'),
          React.createElement('input', {
            key: 'r', type: 'range', min: 0, max: 1, step: 0.01, value: s.volume,
            onChange: (ev) => { const v = Number(ev.target.value); audio.volume = v; set({ volume: v }); },
            onMouseUp: () => persistPlayback(), onTouchEnd: () => persistPlayback(),
          }),
        ]),
      ]);
    }

    const RATES = [1, 1.25, 1.5, 2, 0.75];
    function NowPlayingBar() {
      const s = useStore();
      const [pop, setPop] = useState(''); // '' | 'vol' | 'rate'
      const barRef = useRef(null);
      const cur = s.current;
      const dur = s.duration || (cur && cur.duration) || 0;

      const togglePlay = () => {
        unlockAutoplay();
        if (cur === null) {
          // 没有当前曲目：打开面板搜索。
          set({ panelOpen: true, tab: 'search' });
          return;
        }
        if (audio.paused) {
          const p = audio.play();
          if (p && p.catch) p.catch(() => {});
        } else {
          audio.pause();
        }
      };

      return React.createElement('div', { className: 'xmly-bar-wrap' },
        React.createElement('div', { className: 'xmly-bar' + (cur ? '' : ' xmly-bar-idle'), ref: barRef }, [
          cur
            ? React.createElement('span', { key: 'note', className: 'xmly-note' }, '🎧')
            : React.createElement('span', { key: 'note', className: 'xmly-note' }, '📻'),
          React.createElement('div', { key: 'title', className: 'xmly-bar-title', onClick: () => { set({ panelOpen: true, tab: cur && cur.albumId ? 'album' : 'search' }); } }, [
            cur
              ? React.createElement('span', { key: 't', className: 'xmly-bar-track', title: cur.trackTitle }, cur.trackTitle)
              : React.createElement('span', { key: 't', className: 'xmly-bar-track xmly-bar-hint' }, '喜马拉雅 · 点右侧「搜索」找节目'),
            cur && cur.albumTitle
              ? React.createElement('span', { key: 'a', className: 'xmly-bar-album', title: cur.albumTitle }, cur.albumTitle + (cur.quality ? ' · ' + cur.quality.replace(/ ?kbps ?/, 'k ') : ''))
              : null,
          ]),
          s.error
            ? React.createElement('span', { key: 'err', className: 'xmly-bar-warn', onClick: () => set({ error: '', tab: 'mine', panelOpen: true }) }, s.error.slice(0, 30))
            : null,
          React.createElement('span', { key: 'time', className: 'xmly-bar-time' }, fmtTime(s.position) + (dur > 0 ? ' / ' + fmtTime(dur) : '')),
          React.createElement('div', { key: 'ctrl', className: 'xmly-bar-ctrl' }, [
            React.createElement('button', { key: 'prev', className: 'xmly-bar-btn', title: '上一集', onClick: () => { unlockAutoplay(); step(-1); } }, '⏮'),
            React.createElement('button', { key: 'play', className: 'xmly-bar-btn xmly-bar-play', title: s.playing ? '暂停' : '播放', onClick: togglePlay },
              s.buffering ? '⋯' : (s.playing ? '⏸' : '▶')),
            React.createElement('button', { key: 'next', className: 'xmly-bar-btn', title: '下一集', onClick: () => { unlockAutoplay(); step(1); } }, '⏭'),
            React.createElement('button', { key: 'vol', className: 'xmly-bar-btn', title: '音量', onClick: () => setPop(pop === 'vol' ? '' : 'vol') }, '🔊'),
            React.createElement('button', {
              key: 'rate', className: 'xmly-bar-btn' + (s.rate !== 1 ? ' active' : ''), title: '倍速',
              onClick: () => { const i = RATES.indexOf(s.rate); const r = RATES[(i + 1) % RATES.length] || 1; audio.playbackRate = r; set({ rate: r }); persistPlayback(); },
            }, s.rate + 'x'),
            React.createElement('button', {
              key: 'panel', className: 'xmly-bar-btn', title: '搜索/列表',
              onClick: () => { const open = !s.panelOpen; set({ panelOpen: open }); persistPanel(); },
            }, '🔎'),
          ]),
          pop === 'vol' ? React.createElement(VolumePopup, { key: 'volpop' }) : null,
          React.createElement(ProgressBar, { key: 'pb', compact: true }),
        ]),
        s.toast ? React.createElement('div', { key: 'toast', className: 'xmly-toast' + (s.toast.ok ? '' : ' xmly-toast-bad') }, s.toast.text) : null,
      );
    }

    // ------------------------------------------------------------------
    // UI: 面板
    // ------------------------------------------------------------------
    const PANEL_W = 460;
    function useDragPanel(headerRef) {
      const dragging = useRef(null);
      useEffect(() => {
        const onMove = (ev) => {
          if (dragging.current === null) return;
          const d = dragging.current;
          const x = Math.max(8, Math.min(window.innerWidth - 80, ev.clientX - d.dx));
          const y = Math.max(8, Math.min(window.innerHeight - 60, ev.clientY - d.dy));
          set({ panelPos: { x, y } });
        };
        const onUp = () => {
          if (dragging.current !== null) {
            dragging.current = null;
            persistPanel();
          }
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
      }, []);
      const onDown = (ev) => {
        if (!headerRef.current) return;
        const pos = store.panelPos || { x: Math.max(16, (window.innerWidth - PANEL_W) / 2), y: 80 };
        dragging.current = { dx: ev.clientX - pos.x, dy: ev.clientY - pos.y };
        set({ panelPos: pos });
      };
      return onDown;
    }

    function SearchTab() {
      const s = useStore();
      const [kw, setKw] = useState(s.searchKw || '');
      const inputRef = useRef(null);
      useEffect(() => { if (inputRef.current) inputRef.current.focus(); }, []);
      return React.createElement('div', { className: 'xmly-tab-body xmly-search-body' }, [
        React.createElement('div', { key: 'input', className: 'xmly-search-row' }, [
          React.createElement('input', {
            key: 'i', ref: inputRef, className: 'xmly-input', placeholder: '搜专辑 / 播客 / 有声书（如：三体、郭德纲、晓说）',
            value: kw, onChange: (ev) => setKw(ev.target.value),
            onKeyDown: (ev) => { if (ev.key === 'Enter') { void doSearch(kw, 1); set({ panelOpen: true }); } },
          }),
          React.createElement('button', {
            key: 'b', className: 'xmly-btn xmly-btn-primary', disabled: s.searching,
            onClick: () => void doSearch(kw, 1),
          }, s.searching ? '搜索中…' : '搜索'),
        ]),
        s.history.length > 0 && s.searchResults.length === 0 && !s.searching
          ? React.createElement('div', { key: 'hist', className: 'xmly-history' }, [
              React.createElement('span', { key: 'label', className: 'xmly-muted' }, '最近搜索：'),
              ...s.history.slice(0, 8).map((h) =>
                React.createElement('button', {
                  key: 'h-' + h, className: 'xmly-chip', onClick: () => { setKw(h); void doSearch(h, 1); },
                }, h)),
            ])
          : null,
        s.searchError ? React.createElement('div', { key: 'err', className: 'xmly-error-text' }, s.searchError) : null,
        React.createElement('div', { key: 'list', className: 'xmly-album-list' },
          s.searchResults.length === 0 && !s.searching && !s.searchError
            ? React.createElement('div', { key: 'empty', className: 'xmly-empty' }, '输入关键词开始搜索喜马拉雅内容')
            : s.searchResults.map((a) => React.createElement('div', {
                key: a.id, className: 'xmly-album-card', onClick: () => void openAlbum(a.id),
              }, [
                a.cover ? React.createElement('img', { key: 'c', className: 'xmly-album-cover', src: a.cover, loading: 'lazy', alt: '' }) : React.createElement('div', { key: 'c', className: 'xmly-album-cover xmly-album-cover-ph' }, '🎧'),
                React.createElement('div', { key: 'm', className: 'xmly-album-meta' }, [
                  React.createElement('div', { key: 't', className: 'xmly-album-title', title: a.title },
                    a.title,
                    a.isPaid ? React.createElement('span', { key: 'p', className: 'xmly-badge xmly-badge-paid' }, '付费') : null,
                  ),
                  React.createElement('div', { key: 'a', className: 'xmly-muted' }, (a.anchorName || '') + ' · ' + (a.category || '')),
                  React.createElement('div', { key: 'i', className: 'xmly-album-intro xmly-muted', title: a.intro }, a.intro || ''),
                  React.createElement('div', { key: 's', className: 'xmly-muted xmly-album-stat' }, [
                    React.createElement('span', { key: 'n' }, a.trackCount + ' 集'),
                    React.createElement('span', { key: 'f' }, a.isFinished ? '完结' : '连载'),
                    React.createElement('span', { key: 'p' }, fmtCount(a.playCount) + ' 次播放'),
                  ]),
                ]),
              ])),
        ),
        !s.searchDone && s.searchResults.length > 0
          ? React.createElement('button', {
              key: 'more', className: 'xmly-btn xmly-btn-block', disabled: s.searching,
              onClick: () => void doSearch(s.searchKw, s.searchPage + 1),
            }, s.searching ? '加载中…' : '加载更多（' + fmtCount(s.searchTotal) + ' 个结果）')
          : (s.searchDone && s.searchResults.length > 0
              ? React.createElement('div', { key: 'done', className: 'xmly-empty xmly-empty-thin' }, '共 ' + fmtCount(s.searchTotal) + ' 个结果，已全部加载')
              : null),
      ]);
    }

    function AlbumTab() {
      const s = useStore();
      if (s.albumLoading) return React.createElement('div', { className: 'xmly-tab-body' }, React.createElement('div', { className: 'xmly-empty' }, '专辑加载中…'));
      if (s.albumError) return React.createElement('div', { className: 'xmly-tab-body' }, [
        React.createElement('div', { key: 'e', className: 'xmly-error-text' }, s.albumError),
        React.createElement('button', { key: 'b', className: 'xmly-btn', onClick: () => set({ tab: 'search' }) }, '返回搜索'),
      ]);
      if (s.album === null) return React.createElement('div', { className: 'xmly-tab-body' }, React.createElement('div', { className: 'xmly-empty' }, '还没有选择专辑，去「搜索」找一个吧'));
      const a = s.album;
      const favActive = s.favs.some((f) => f.id === a.id);
      return React.createElement('div', { className: 'xmly-tab-body xmly-album-body' }, [
        React.createElement('div', { key: 'head', className: 'xmly-album-head' }, [
          a.cover ? React.createElement('img', { key: 'c', className: 'xmly-album-cover-lg', src: a.cover, alt: '' }) : React.createElement('div', { key: 'c', className: 'xmly-album-cover-lg xmly-album-cover-ph' }, '🎧'),
          React.createElement('div', { key: 'm', className: 'xmly-album-head-meta' }, [
            React.createElement('div', { key: 't', className: 'xmly-album-title-lg', title: a.title }, a.title),
            React.createElement('div', { key: 'a', className: 'xmly-muted' }, (a.anchorName || '') + (a.category ? ' · ' + a.category : '')),
            React.createElement('div', { key: 's', className: 'xmly-muted' }, (a.isFinished ? '完结' : '连载') + ' · ' + s.albumTotal + ' 集' + (a.isPaid ? ' · 含付费内容' : '')),
            React.createElement('div', { key: 'ops', className: 'xmly-album-ops' }, [
              s.albumTracks.length > 0
                ? React.createElement('button', {
                    key: 'play', className: 'xmly-btn xmly-btn-primary',
                    onClick: () => void playTrack(s.albumTracks[0], { id: a.id, title: a.title }),
                  }, '▶ 播放')
                : null,
              React.createElement('button', {
                key: 'fav', className: 'xmly-btn' + (favActive ? ' xmly-btn-fav' : ''),
                onClick: () => void toggleFav({ id: a.id, title: a.title, cover: a.cover, anchorName: a.anchorName, trackCount: s.albumTotal, category: a.category, isPaid: a.isPaid }),
              }, favActive ? '♥ 已收藏' : '♡ 收藏'),
            ]),
          ]),
        ]),
        a.intro ? React.createElement('div', { key: 'intro', className: 'xmly-album-intro-full xmly-muted', title: a.intro }, a.intro) : null,
        React.createElement('div', { key: 'list', className: 'xmly-track-list' },
          s.albumTracks.map((t, i) => {
            const active = s.current && s.current.trackId === t.id;
            return React.createElement('div', {
              key: t.id, className: 'xmly-track-row' + (active ? ' active' : ''), onClick: () => void playTrack(t, { id: a.id, title: a.title }),
            }, [
              React.createElement('span', { key: 'i', className: 'xmly-track-idx' }, active && s.playing ? '♪' : (i + 1)),
              React.createElement('span', { key: 't', className: 'xmly-track-title', title: t.title }, t.title),
              t.isPaid && !t.isFree ? React.createElement('span', { key: 'v', className: 'xmly-badge xmly-badge-vip' }, t.isAuthorized ? '可播' : 'VIP') : null,
              React.createElement('span', { key: 'd', className: 'xmly-track-dur xmly-muted' }, fmtTime(t.duration)),
            ]);
          })),
        s.albumTracks.length === 0 ? React.createElement('div', { key: 'empty', className: 'xmly-empty' }, '该专辑暂无曲目') : null,
        s.albumPageId < s.albumMaxPageId
          ? React.createElement('button', {
              key: 'more', className: 'xmly-btn xmly-btn-block', disabled: s.albumMore,
              onClick: () => void loadMoreTracks(),
            }, s.albumMore ? '加载中…' : '加载更多（第 ' + s.albumPageId + '/' + s.albumMaxPageId + ' 页）')
          : (s.albumTotal > 0 && s.albumTracks.length >= s.albumTotal
              ? React.createElement('div', { key: 'done', className: 'xmly-empty xmly-empty-thin' }, '已加载全部 ' + s.albumTotal + ' 集')
              : null),
      ]);
    }

    function MineTab() {
      const s = useStore();
      useEffect(() => {
        if (!s.loggedIn && s.qr === null && s.qrStatus !== 'loading' && s.qrStatus !== 'expired') {
          void startQrLogin();
        }
      }, [s.loggedIn]);
      useEffect(() => {
        if (!s.loggedIn && s.qr !== null) {
          const t = setInterval(() => { void pollQr(); }, 2500);
          return () => clearInterval(t);
        }
      }, [s.loggedIn, s.qr && s.qr.qrId]);
      // 登录后按当前分段懒加载（翻段/登录成功都会触发）。
      useEffect(() => {
        if (!s.loggedIn) return;
        if (s.mineSeg === 'likes' && !s.likesLoaded && !s.likes.loading) void loadLikes(1);
        if (s.mineSeg === 'subs' && !s.subsLoaded && !s.subs.loading) void loadSubs(1);
        if (s.mineSeg === 'anchors' && !s.followingLoaded && !s.following.loading) void loadFollowing(1);
      }, [s.loggedIn, s.mineSeg]);

      const loginHint = (what) => React.createElement('div', { className: 'xmly-empty xmly-empty-thin' },
        '扫码登录后即可查看' + what);

      // 分段内容
      let segBody = null;
      if (s.mineSeg === 'likes') {
        segBody = !s.loggedIn
          ? loginHint('收藏的声音')
          : React.createElement('div', { key: 'likes' }, [
              s.likes.error ? React.createElement('div', { key: 'err', className: 'xmly-error-text' }, s.likes.error) : null,
              s.likes.loading && s.likes.list.length === 0
                ? React.createElement('div', { key: 'ld', className: 'xmly-empty xmly-empty-thin' }, '加载中…')
                : null,
              !s.likes.loading && s.likes.list.length === 0 && !s.likes.error
                ? React.createElement('div', { key: 'e', className: 'xmly-empty xmly-empty-thin' }, '还没有收藏的声音：在播放页/声音页点 ♥ 即可收藏')
                : React.createElement('div', { key: 'list', className: 'xmly-like-list' },
                    s.likes.list.map((t) => {
                      const active = s.current && s.current.trackId === t.id;
                      return React.createElement('div', {
                        key: t.id, className: 'xmly-like-row' + (active ? ' active' : ''),
                        onClick: () => void playTrack(t, t.albumId ? { id: t.albumId, title: t.albumTitle } : null),
                        title: '点击播放：' + t.title,
                      }, [
                        t.cover
                          ? React.createElement('img', { key: 'c', className: 'xmly-like-cover', src: t.cover, loading: 'lazy', alt: '' })
                          : React.createElement('div', { key: 'c', className: 'xmly-like-cover xmly-album-cover-ph' }, '🎵'),
                        React.createElement('div', { key: 'm', className: 'xmly-like-meta' }, [
                          React.createElement('div', { key: 't', className: 'xmly-like-title' }, [
                            React.createElement('span', { key: 'n', className: 'xmly-like-title-text' }, t.title),
                            t.isPaid ? React.createElement('span', { key: 'p', className: 'xmly-badge xmly-badge-paid' }, '付费') : null,
                            t.isVideo ? React.createElement('span', { key: 'v', className: 'xmly-badge' }, '视频') : null,
                          ]),
                          React.createElement('div', { key: 'a', className: 'xmly-muted xmly-like-sub' },
                            (t.albumTitle || '未知专辑') + ' · ' + (t.anchorName || '')),
                          React.createElement('div', { key: 's', className: 'xmly-muted xmly-like-sub' },
                            (t.durationText || fmtTime(t.duration)) + (t.playCount ? ' · ' + fmtCount(t.playCount) + ' 次播放' : '') + (t.createdAtText ? ' · ' + t.createdAtText : '')),
                        ]),
                        React.createElement('span', { key: 'p', className: 'xmly-like-play' }, active && s.playing ? '♪' : '▶'),
                      ]);
                    })),
              s.likes.hasMore
                ? React.createElement('button', {
                    key: 'more', className: 'xmly-btn xmly-btn-block', disabled: s.likes.loading,
                    onClick: () => void loadLikes(s.likes.pageNum + 1),
                  }, s.likes.loading ? '加载中…' : '加载更多（共 ' + s.likes.total + ' 条）')
                : (s.likes.list.length > 0
                    ? React.createElement('div', { key: 'done', className: 'xmly-empty xmly-empty-thin' }, '共收藏 ' + s.likes.total + ' 条声音')
                    : null),
            ]);
      } else if (s.mineSeg === 'subs') {
        segBody = !s.loggedIn
          ? loginHint('订阅的专辑')
          : React.createElement('div', { key: 'subs' }, [
              s.subs.error ? React.createElement('div', { key: 'err', className: 'xmly-error-text' }, s.subs.error) : null,
              s.subs.loading && s.subs.list.length === 0
                ? React.createElement('div', { key: 'ld', className: 'xmly-empty xmly-empty-thin' }, '加载中…')
                : null,
              !s.subs.loading && s.subs.list.length === 0 && !s.subs.error
                ? React.createElement('div', { key: 'e', className: 'xmly-empty xmly-empty-thin' }, '还没有订阅专辑：在专辑页点「订阅」即可')
                : React.createElement('div', { key: 'list', className: 'xmly-album-list' },
                    s.subs.list.map((a) => React.createElement('div', {
                      key: a.id, className: 'xmly-album-card', onClick: () => void openAlbum(a.id),
                      title: '打开专辑：' + a.title,
                    }, [
                      a.cover
                        ? React.createElement('img', { key: 'c', className: 'xmly-album-cover', src: a.cover, loading: 'lazy', alt: '' })
                        : React.createElement('div', { key: 'c', className: 'xmly-album-cover xmly-album-cover-ph' }, '🎧'),
                      React.createElement('div', { key: 'm', className: 'xmly-album-meta' }, [
                        React.createElement('div', { key: 't', className: 'xmly-album-title' },
                          a.title,
                          a.isPaid ? React.createElement('span', { key: 'p', className: 'xmly-badge xmly-badge-paid' }, '付费') : null),
                        React.createElement('div', { key: 'a', className: 'xmly-muted' },
                          (a.anchorName || '') + (a.category ? ' · ' + a.category : '') + ' · ' + a.trackCount + ' 集' + (a.isFinished ? ' · 完结' : '')),
                        a.lastTrackTitle
                          ? React.createElement('div', { key: 'u', className: 'xmly-muted xmly-like-sub', title: a.lastTrackTitle },
                              '最新：' + (a.lastUpdateText ? a.lastUpdateText + ' · ' : '') + a.lastTrackTitle)
                          : null,
                      ]),
                    ]))),
              s.subs.hasMore
                ? React.createElement('button', {
                    key: 'more', className: 'xmly-btn xmly-btn-block', disabled: s.subs.loading,
                    onClick: () => void loadSubs(s.subs.page + 1),
                  }, s.subs.loading ? '加载中…' : '加载更多（共 ' + s.subs.total + ' 张）')
                : (s.subs.list.length > 0
                    ? React.createElement('div', { key: 'done', className: 'xmly-empty xmly-empty-thin' }, '共订阅 ' + s.subs.total + ' 张专辑')
                    : null),
            ]);
      } else if (s.mineSeg === 'anchors') {
        segBody = !s.loggedIn
          ? loginHint('已关注的主播')
          : React.createElement('div', { key: 'anchors' }, [
              s.following.error ? React.createElement('div', { key: 'err', className: 'xmly-error-text' }, s.following.error) : null,
              s.following.loading && s.following.list.length === 0
                ? React.createElement('div', { key: 'ld', className: 'xmly-empty xmly-empty-thin' }, '加载中…')
                : null,
              !s.following.loading && s.following.list.length === 0 && !s.following.error
                ? React.createElement('div', { key: 'e', className: 'xmly-empty xmly-empty-thin' }, '还没有关注任何主播：去主播页点「+ 关注」')
                : React.createElement('div', { key: 'list', className: 'xmly-anchor-list' },
                    s.following.list.map((a) => React.createElement('div', {
                      key: a.uid, className: 'xmly-anchor-card', onClick: () => void openAnchor(a),
                      title: '查看「' + a.nickname + '」的专辑',
                    }, [
                      a.cover
                        ? React.createElement('img', { key: 'c', className: 'xmly-anchor-avatar', src: a.cover, loading: 'lazy', alt: '' })
                        : React.createElement('div', { key: 'c', className: 'xmly-anchor-avatar xmly-album-cover-ph' }, (a.nickname || '主').slice(0, 1)),
                      React.createElement('div', { key: 'm', className: 'xmly-anchor-meta' }, [
                        React.createElement('div', { key: 'n', className: 'xmly-anchor-name' }, a.nickname || ('主播 #' + a.uid)),
                        React.createElement('div', { key: 'd', className: 'xmly-muted xmly-like-sub', title: a.description || a.ptitle }, a.description || a.ptitle || ''),
                        React.createElement('div', { key: 's', className: 'xmly-muted xmly-like-sub' },
                          fmtCount(a.fansCount) + ' 粉丝 · ' + a.albumCount + ' 专辑 · ' + fmtCount(a.trackCount) + ' 声音'),
                      ]),
                      React.createElement('span', { key: 'go', className: 'xmly-anchor-go' }, '›'),
                    ]))),
              s.following.hasMore
                ? React.createElement('button', {
                    key: 'more', className: 'xmly-btn xmly-btn-block', disabled: s.following.loading,
                    onClick: () => void loadFollowing(s.following.page + 1),
                  }, s.following.loading ? '加载中…' : '加载更多（共 ' + s.following.total + ' 位）')
                : (s.following.list.length > 0
                    ? React.createElement('div', { key: 'done', className: 'xmly-empty xmly-empty-thin' }, '共关注 ' + s.following.total + ' 位主播')
                    : null),
            ]);
      } else {
        segBody = React.createElement('div', { key: 'albums' }, [
          s.favs.length === 0
            ? React.createElement('div', { key: 'e', className: 'xmly-empty xmly-empty-thin' }, '在专辑详情里点「♡ 收藏」添加')
            : React.createElement('div', { key: 'list', className: 'xmly-album-list' },
                s.favs.map((f) => React.createElement('div', { key: f.id, className: 'xmly-album-card', onClick: () => void openAlbum(f.id) }, [
                  f.cover ? React.createElement('img', { key: 'c', className: 'xmly-album-cover', src: f.cover, loading: 'lazy', alt: '' }) : React.createElement('div', { key: 'c', className: 'xmly-album-cover xmly-album-cover-ph' }, '🎧'),
                  React.createElement('div', { key: 'm', className: 'xmly-album-meta' }, [
                    React.createElement('div', { key: 't', className: 'xmly-album-title' }, f.title),
                    React.createElement('div', { key: 'a', className: 'xmly-muted' }, (f.anchorName || '') + ' · ' + (f.trackCount || 0) + ' 集'),
                  ]),
                  React.createElement('button', {
                    key: 'x', className: 'xmly-bar-btn', title: '取消收藏',
                    onClick: (ev) => { ev.stopPropagation(); void toggleFav(f); },
                  }, '✕'),
                ]))),
        ]);
      }

      return React.createElement('div', { className: 'xmly-tab-body xmly-mine-body' }, [
        React.createElement('div', { key: 'login', className: 'xmly-login-box' },
          s.loggedIn
            ? React.createElement('div', { key: 'u', className: 'xmly-user-row' }, [
                React.createElement('span', { key: 'a', className: 'xmly-avatar' }, (s.user && s.user.nickname ? s.user.nickname.slice(0, 1) : '喜')),
                React.createElement('div', { key: 'm', className: 'xmly-user-meta' }, [
                  React.createElement('div', { key: 'n', className: 'xmly-user-name' }, (s.user && s.user.nickname) || '已登录',
                    s.user && s.user.isVip ? React.createElement('span', { key: 'v', className: 'xmly-badge xmly-badge-vip' }, 'VIP') : null),
                  React.createElement('div', { key: 'd', className: 'xmly-muted' }, s.user && s.user.isVip ? '会员生效中，可播会员免费内容' : '普通账号（VIP/已购内容可播）'),
                ]),
                React.createElement('button', {
                  key: 'out', className: 'xmly-btn xmly-btn-ghost',
                  onClick: async () => {
                    await jsonPost('/dsh-ximalaya/logout', {});
                    set({
                      loggedIn: false, user: null,
                      likes: { list: [], total: 0, pageNum: 1, hasMore: false, loading: false, error: '' }, likesLoaded: false,
                      subs: { list: [], total: 0, page: 1, hasMore: false, loading: false, error: '' }, subsLoaded: false,
                      following: { list: [], total: 0, page: 1, hasMore: false, loading: false, error: '' }, followingLoaded: false,
                    });
                    showToast('已退出登录');
                  },
                }, '退出'),
              ])
            : React.createElement('div', { key: 'q', className: 'xmly-qr-box' }, [
                s.qr !== null
                  ? React.createElement('img', { key: 'img', className: 'xmly-qr-img', src: s.qr.imageDataUrl, alt: '登录二维码' })
                  : React.createElement('div', { key: 'ph', className: 'xmly-qr-img xmly-qr-ph' }, s.qrStatus === 'loading' ? '生成中…' : '已过期'),
                React.createElement('div', { key: 'hint', className: 'xmly-muted' }, [
                  '打开喜马拉雅 App 扫码登录，解锁 VIP / 已购内容',
                  React.createElement('div', { key: 'st', className: 'xmly-qr-status' },
                    s.qrStatus === 'expired' ? '二维码已过期，' : (s.qrStatus === 'waiting' ? '等待扫码… ' : '')),
                  s.qrStatus === 'expired'
                    ? React.createElement('button', { key: 'r', className: 'xmly-btn xmly-btn-sm', onClick: () => void startQrLogin() }, '刷新二维码')
                    : null,
                ]),
              ]),
        ),
        React.createElement('div', { key: 'seg', className: 'xmly-seg-row' }, [
          React.createElement('button', {
            key: 'l', className: 'xmly-seg-btn' + (s.mineSeg === 'likes' ? ' active' : ''),
            onClick: () => set({ mineSeg: 'likes' }),
          }, '♥ 声音'),
          React.createElement('button', {
            key: 'sub', className: 'xmly-seg-btn' + (s.mineSeg === 'subs' ? ' active' : ''),
            onClick: () => set({ mineSeg: 'subs' }),
          }, '📻 订阅'),
          React.createElement('button', {
            key: 'a', className: 'xmly-seg-btn' + (s.mineSeg === 'anchors' ? ' active' : ''),
            onClick: () => set({ mineSeg: 'anchors' }),
          }, '👤 主播'),
          React.createElement('button', {
            key: 'b', className: 'xmly-seg-btn' + (s.mineSeg === 'albums' ? ' active' : ''),
            onClick: () => set({ mineSeg: 'albums' }),
          }, '★ 专辑'),
        ]),
        segBody,
      ]);
    }

    function AnchorTab() {
      const s = useStore();
      const a = s.anchorView;
      if (a === null) return React.createElement('div', { className: 'xmly-tab-body' },
        React.createElement('div', { className: 'xmly-empty' }, '还没有选择主播，去「我的 → 关注的主播」看看'));
      return React.createElement('div', { className: 'xmly-tab-body xmly-anchor-body' }, [
        React.createElement('div', { key: 'head', className: 'xmly-anchor-head' }, [
          a.cover
            ? React.createElement('img', { key: 'c', className: 'xmly-anchor-avatar-lg', src: a.cover, alt: '' })
            : React.createElement('div', { key: 'c', className: 'xmly-anchor-avatar-lg xmly-album-cover-ph' }, (a.nickname || '主').slice(0, 1)),
          React.createElement('div', { key: 'm', className: 'xmly-album-head-meta' }, [
            React.createElement('div', { key: 'n', className: 'xmly-anchor-name-lg' }, a.nickname || ('主播 #' + a.uid)),
            React.createElement('div', { key: 's', className: 'xmly-muted' },
              fmtCount(a.fansCount) + ' 粉丝 · ' + a.albumCount + ' 专辑 · ' + fmtCount(a.trackCount) + ' 声音'),
            React.createElement('button', {
              key: 'back', className: 'xmly-btn xmly-btn-sm xmly-btn-ghost',
              onClick: () => set({ tab: 'mine', mineSeg: 'anchors' }),
            }, '‹ 返回关注列表'),
          ]),
        ]),
        a.description ? React.createElement('div', { key: 'd', className: 'xmly-muted xmly-anchor-desc' }, a.description) : null,
        s.anchorError ? React.createElement('div', { key: 'err', className: 'xmly-error-text' }, s.anchorError) : null,
        s.anchorLoading
          ? React.createElement('div', { key: 'ld', className: 'xmly-empty' }, '主播专辑加载中…')
          : (s.anchorAlbums.length === 0
              ? React.createElement('div', { key: 'e', className: 'xmly-empty' }, '该主播暂无公开专辑')
              : React.createElement('div', { key: 'list', className: 'xmly-album-list' },
                  s.anchorAlbums.map((al) => React.createElement('div', {
                    key: al.id, className: 'xmly-album-card', onClick: () => void openAlbum(al.id),
                  }, [
                    al.cover ? React.createElement('img', { key: 'c', className: 'xmly-album-cover', src: al.cover, loading: 'lazy', alt: '' }) : React.createElement('div', { key: 'c', className: 'xmly-album-cover xmly-album-cover-ph' }, '🎧'),
                    React.createElement('div', { key: 'm', className: 'xmly-album-meta' }, [
                      React.createElement('div', { key: 't', className: 'xmly-album-title' },
                        al.title,
                        al.isPaid ? React.createElement('span', { key: 'p', className: 'xmly-badge xmly-badge-paid' }, '付费') : null),
                      React.createElement('div', { key: 'a', className: 'xmly-muted' },
                        (al.isFinished ? '完结' : '连载') + ' · ' + al.trackCount + ' 集' + (al.playCount ? ' · ' + fmtCount(al.playCount) + ' 次播放' : '')),
                    ]),
                  ])))),
        !s.anchorLoading && s.anchorTotal > s.anchorAlbums.length && s.anchorAlbums.length > 0
          ? React.createElement('div', { key: 'more', className: 'xmly-empty xmly-empty-thin' },
              '已显示 ' + s.anchorAlbums.length + ' / ' + s.anchorTotal + ' 个专辑（网页端查看更多）')
          : null,
      ]);
    }

    function PlayerPanel() {
      const s = useStore();
      const headerRef = useRef(null);
      const onDragStart = useDragPanel(headerRef);
      if (!s.panelOpen) return null;
      const pos = s.panelPos || { x: Math.max(16, Math.round((window.innerWidth - PANEL_W) / 2)), y: 80 };
      const style = { left: pos.x, top: pos.y, width: PANEL_W };
      return React.createElement('div', { className: 'xmly-panel', style },
        React.createElement('div', { className: 'xmly-panel-head', ref: headerRef, onMouseDown: onDragStart }, [
          React.createElement('span', { key: 't', className: 'xmly-panel-title' }, '📻 喜马拉雅'),
          React.createElement('div', { key: 'tabs', className: 'xmly-panel-tabs' }, [
            React.createElement('button', { key: 's', className: 'xmly-tab-btn' + (s.tab === 'search' ? ' active' : ''), onClick: () => set({ tab: 'search' }) }, '搜索'),
            s.album !== null
              ? React.createElement('button', { key: 'a', className: 'xmly-tab-btn' + (s.tab === 'album' ? ' active' : ''), onClick: () => set({ tab: 'album' }) }, '专辑')
              : null,
            s.anchorView !== null
              ? React.createElement('button', { key: 'an', className: 'xmly-tab-btn' + (s.tab === 'anchor' ? ' active' : ''), onClick: () => set({ tab: 'anchor' }) }, '主播')
              : null,
            React.createElement('button', { key: 'm', className: 'xmly-tab-btn' + (s.tab === 'mine' ? ' active' : ''), onClick: () => set({ tab: 'mine' }) }, '我的'),
          ]),
          React.createElement('button', {
            key: 'x', className: 'xmly-bar-btn', title: '收起面板',
            onClick: () => { set({ panelOpen: false }); persistPanel(); },
          }, '✕'),
        ]),
        React.createElement('div', { className: 'xmly-panel-body' },
          s.tab === 'search' ? React.createElement(SearchTab, { key: 'search' }) : null,
          s.tab === 'album' ? React.createElement(AlbumTab, { key: 'album' }) : null,
          s.tab === 'anchor' ? React.createElement(AnchorTab, { key: 'anchor' }) : null,
          s.tab === 'mine' ? React.createElement(MineTab, { key: 'mine' }) : null,
        ),
      );
    }

    // ------------------------------------------------------------------
    // audio 事件绑定
    // ------------------------------------------------------------------
    function bindAudio() {
      const onTime = () => {
        if (Math.abs(audio.currentTime - store.position) > 0.25) set({ position: audio.currentTime });
      };
      const onDur = () => set({ duration: Number.isFinite(audio.duration) ? audio.duration : 0 });
      const onPlay = () => set({ playing: true, error: '', restored: false });
      const onPause = () => { if (store.playing) set({ playing: false }); persistPlayback(); };
      const onEnded = () => {
        set({ playing: false, position: 0 });
        step(1);
      };
      const onWaiting = () => set({ buffering: true });
      const onPlaying = () => set({ buffering: false });
      const onErr = () => set({
        playing: false, buffering: false,
        error: '音频加载失败' + (store.current && store.current.quality ? '（' + store.current.quality + '）' : '') + '，可稍后重试',
      });
      audio.addEventListener('timeupdate', onTime);
      audio.addEventListener('durationchange', onDur);
      audio.addEventListener('loadedmetadata', onDur);
      audio.addEventListener('play', onPlay);
      audio.addEventListener('pause', onPause);
      audio.addEventListener('ended', onEnded);
      audio.addEventListener('waiting', onWaiting);
      audio.addEventListener('playing', onPlaying);
      audio.addEventListener('error', onErr);
      return () => {
        audio.removeEventListener('timeupdate', onTime);
        audio.removeEventListener('durationchange', onDur);
        audio.removeEventListener('loadedmetadata', onDur);
        audio.removeEventListener('play', onPlay);
        audio.removeEventListener('pause', onPause);
        audio.removeEventListener('ended', onEnded);
        audio.removeEventListener('waiting', onWaiting);
        audio.removeEventListener('playing', onPlaying);
        audio.removeEventListener('error', onErr);
      };
    }

    // ------------------------------------------------------------------
    // plugin 入口
    // ------------------------------------------------------------------
    const inject = ['slots'];
    function apply(ctx) {
      const slots = ctx.get('slots');
      if (slots === undefined) return;

      ctx.effect(() => {
        const styleEl = document.createElement('style');
        styleEl.setAttribute('data-plugin', 'dsh-ximalaya');
        styleEl.textContent = XMLY_CSS;
        document.head.appendChild(styleEl);
        return () => { if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl); };
      }, 'ximalaya: style');

      ctx.effect(() => {
        if (!audioAttached) {
          audioAttached = true;
          try {
            audio.style.display = 'none';
            audio.volume = store.volume;
            if (audio.parentNode === null) document.body.appendChild(audio);
          } catch (e) {}
        }
        const unbind = bindAudio();
        const onHide = () => { persistPlayback(); };
        window.addEventListener('pagehide', onHide);
        return () => {
          window.removeEventListener('pagehide', onHide);
          try { audio.pause(); } catch (e) {}
          unbind();
        };
      }, 'ximalaya: audio engine');

      void loadManifest();

      const intentTimer = setInterval(() => {
        jsonGet('/dsh-ximalaya/intent').then((res) => {
          if (res && res.ok === true && res.intent) return handleIntent(res.intent);
        }).catch(() => {});
      }, 2000);

      ctx.effect(() => slots.inject('conversation.input.dock', () => slots.register(
        { name: 'conversation.input.dock', id: 'ximalaya-bar', order: 41 },
        () => React.createElement(NowPlayingBar),
      )), 'ximalaya: now playing bar');
      ctx.effect(() => slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'ximalaya-panel', order: 21 },
        () => React.createElement(PlayerPanel),
      )), 'ximalaya: panel');

      ctx.effect(() => () => clearInterval(intentTimer), 'ximalaya: intent poll stop');
    }

    exports.apply = apply;
    exports.inject = inject;

    // ------------------------------------------------------------------
    // CSS
    // ------------------------------------------------------------------
    const XMLY_CSS = '' +
      'body { --xmly-accent: var(--dsw-alias-brand-primary, #2f9e6e); --xmly-accent-fg: var(--dsw-alias-label-primary-foreground, #fff); }\n' +
      '.xmly-bar-wrap { box-sizing: border-box; width: 100%; padding: 0 var(--dsh-composer-side-clearance, 16px); }\n' +
      '.xmly-bar { box-sizing: border-box; display: flex; align-items: center; gap: 8px; width: 100%; max-width: var(--dsh-composer-card-max-width, 780px); margin: 0 auto; padding: 5px 10px 7px; font-size: 12px; color: var(--dsw-alias-label-secondary, #8a8f98); background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.04)); border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.2)); border-radius: 8px; cursor: default; user-select: none; position: relative; }\n' +
      '.xmly-note { color: var(--xmly-accent, #2f9e6e); flex: none; font-size: 14px; }\n' +
      '.xmly-bar-title { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px; cursor: pointer; }\n' +
      '.xmly-bar-track { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-primary, #e6e6e6); font-weight: 500; font-size: 13px; }\n' +
      '.xmly-bar-hint { font-weight: 400; color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.xmly-bar-album { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; opacity: 0.75; }\n' +
      '.xmly-bar-time { flex: none; font-variant-numeric: tabular-nums; font-size: 11px; }\n' +
      '.xmly-bar-warn { background: transparent; border: none; color: var(--dsw-alias-state-warn-primary, #d9a441); font-size: 11px; cursor: pointer; padding: 0; white-space: nowrap; max-width: 200px; overflow: hidden; text-overflow: ellipsis; }\n' +
      '.xmly-bar-ctrl { display: flex; align-items: center; gap: 2px; flex: none; }\n' +
      '.xmly-bar-btn { display: inline-flex; align-items: center; justify-content: center; flex: none; height: 22px; min-width: 24px; background: transparent; border: none; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; font-size: 12px; line-height: 1; padding: 0 4px; border-radius: 4px; }\n' +
      '.xmly-bar-btn:hover { color: var(--xmly-accent, #2f9e6e); background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.12)); }\n' +
      '.xmly-bar-btn.active { color: var(--xmly-accent, #2f9e6e); }\n' +
      '.xmly-bar-play { font-size: 15px; }\n' +
      '.xmly-progress { position: absolute; left: 0; right: 0; bottom: 0; height: 4px; overflow: hidden; border-radius: 0 0 8px 8px; cursor: pointer; background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.15)); }\n' +
      '.xmly-progress-compact { height: 3px; }\n' +
      '.xmly-progress-fill { height: 100%; background: var(--xmly-accent, #2f9e6e); transition: width 0.15s linear; }\n' +
      '.xmly-pop { position: absolute; z-index: 10; background: var(--dsw-alias-bg-layer-2, #2a2a30); border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); border-radius: 8px; box-shadow: 0 6px 24px rgba(0,0,0,0.25); padding: 8px 10px; }\n' +
      '.xmly-vol-pop { right: 84px; bottom: calc(100% + 6px); width: 170px; }\n' +
      '.xmly-vol-row { display: flex; align-items: center; gap: 8px; }\n' +
      '.xmly-vol-row input[type="range"] { flex: 1; accent-color: var(--xmly-accent, #2f9e6e); }\n' +
      '.xmly-ico { cursor: pointer; font-size: 14px; }\n' +
      '.xmly-toast { position: absolute; left: 50%; transform: translateX(-50%); top: -30px; background: var(--dsw-alias-bg-layer-2, #2a2a30); color: var(--dsw-alias-label-primary, #e6e6e6); border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); border-radius: 6px; padding: 4px 12px; font-size: 12px; white-space: nowrap; box-shadow: 0 4px 14px rgba(0,0,0,0.3); }\n' +
      '.xmly-toast-bad { color: var(--dsw-alias-state-warn-primary, #d9a441); }\n' +
      // ---- panel ----
      '.xmly-panel { position: fixed; z-index: 60; display: flex; flex-direction: column; max-height: 78vh; min-height: 320px; background: var(--dsw-alias-bg-layer-2, #232329); border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); border-radius: 12px; box-shadow: 0 12px 48px rgba(0,0,0,0.4); overflow: hidden; user-select: none; }\n' +
      '.xmly-panel-head { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.18)); cursor: move; flex: none; }\n' +
      '.xmly-panel-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary, #e6e6e6); }\n' +
      '.xmly-panel-tabs { display: flex; gap: 4px; margin-left: auto; }\n' +
      '.xmly-tab-btn { background: transparent; border: none; color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 12px; padding: 4px 10px; border-radius: 6px; cursor: pointer; }\n' +
      '.xmly-tab-btn:hover { background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.12)); }\n' +
      '.xmly-tab-btn.active { background: color-mix(in srgb, var(--xmly-accent, #2f9e6e) 22%, transparent); color: var(--dsw-alias-label-primary, #e6e6e6); font-weight: 600; }\n' +
      '.xmly-panel-body { flex: 1 1 auto; overflow-y: auto; padding: 12px; }\n' +
      '.xmly-panel-body::-webkit-scrollbar { width: 8px; }\n' +
      '.xmly-panel-body::-webkit-scrollbar-thumb { background: var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); border-radius: 4px; }\n' +
      '.xmly-tab-body { display: flex; flex-direction: column; gap: 10px; }\n' +
      '.xmly-muted { color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 11px; }\n' +
      '.xmly-empty { text-align: center; color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 12px; padding: 28px 12px; }\n' +
      '.xmly-empty-thin { padding: 10px 12px; }\n' +
      '.xmly-error-text { color: var(--dsw-alias-state-warn-primary, #d9a441); font-size: 12px; padding: 4px 0; }\n' +
      // ---- search ----
      '.xmly-search-row { display: flex; gap: 8px; }\n' +
      '.xmly-input { flex: 1; box-sizing: border-box; background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.2)); border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); border-radius: 8px; color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 12px; padding: 7px 10px; outline: none; }\n' +
      '.xmly-input:focus { border-color: var(--xmly-accent, #2f9e6e); }\n' +
      '.xmly-btn { background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.15)); border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 12px; border-radius: 8px; padding: 6px 12px; cursor: pointer; white-space: nowrap; }\n' +
      '.xmly-btn:hover { border-color: var(--xmly-accent, #2f9e6e); }\n' +
      '.xmly-btn:disabled { opacity: 0.55; cursor: default; }\n' +
      '.xmly-btn-primary { background: var(--xmly-accent, #2f9e6e); border-color: transparent; color: var(--xmly-accent-fg, #fff); font-weight: 600; }\n' +
      '.xmly-btn-primary:hover { filter: brightness(1.08); }\n' +
      '.xmly-btn-fav { color: #ff6b81; border-color: #ff6b81; }\n' +
      '.xmly-btn-ghost { background: transparent; }\n' +
      '.xmly-btn-sm { padding: 3px 8px; font-size: 11px; }\n' +
      '.xmly-btn-block { width: 100%; text-align: center; }\n' +
      '.xmly-history { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }\n' +
      '.xmly-chip { background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.14)); border: none; color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 11px; border-radius: 10px; padding: 3px 10px; cursor: pointer; }\n' +
      '.xmly-chip:hover { color: var(--dsw-alias-label-primary, #e6e6e6); }\n' +
      // ---- album cards ----
      '.xmly-album-list { display: flex; flex-direction: column; gap: 8px; }\n' +
      '.xmly-album-card { display: flex; gap: 10px; align-items: flex-start; padding: 8px; border-radius: 10px; cursor: pointer; }\n' +
      '.xmly-album-card:hover { background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.12)); }\n' +
      '.xmly-album-cover { flex: none; width: 56px; height: 56px; border-radius: 8px; object-fit: cover; background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.15)); }\n' +
      '.xmly-album-cover-ph { display: flex; align-items: center; justify-content: center; font-size: 20px; }\n' +
      '.xmly-album-meta { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 3px; }\n' +
      '.xmly-album-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary, #e6e6e6); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; align-items: center; gap: 6px; }\n' +
      '.xmly-album-intro { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }\n' +
      '.xmly-album-stat { display: flex; gap: 8px; }\n' +
      '.xmly-badge { flex: none; font-size: 10px; border-radius: 4px; padding: 1px 5px; font-weight: 400; }\n' +
      '.xmly-badge-paid { background: rgba(217,164,65,0.18); color: var(--dsw-alias-state-warn-primary, #d9a441); }\n' +
      '.xmly-badge-vip { background: color-mix(in srgb, var(--xmly-accent, #2f9e6e) 22%, transparent); color: var(--xmly-accent, #2f9e6e); }\n' +
      // ---- album detail ----
      '.xmly-album-head { display: flex; gap: 12px; }\n' +
      '.xmly-album-cover-lg { flex: none; width: 84px; height: 84px; border-radius: 10px; object-fit: cover; background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.15)); }\n' +
      '.xmly-album-head-meta { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 4px; }\n' +
      '.xmly-album-title-lg { font-size: 14px; font-weight: 700; color: var(--dsw-alias-label-primary, #e6e6e6); line-height: 1.35; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }\n' +
      '.xmly-album-ops { display: flex; gap: 8px; margin-top: 4px; }\n' +
      '.xmly-album-intro-full { font-size: 11px; line-height: 1.5; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }\n' +
      '.xmly-track-list { display: flex; flex-direction: column; }\n' +
      '.xmly-track-row { display: flex; align-items: center; gap: 8px; padding: 7px 8px; border-radius: 8px; cursor: pointer; }\n' +
      '.xmly-track-row:hover { background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.12)); }\n' +
      '.xmly-track-row.active { background: color-mix(in srgb, var(--xmly-accent, #2f9e6e) 16%, transparent); }\n' +
      '.xmly-track-row.active .xmly-track-title { color: var(--xmly-accent, #2f9e6e); font-weight: 600; }\n' +
      '.xmly-track-idx { flex: none; width: 22px; text-align: right; font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8f98); font-variant-numeric: tabular-nums; }\n' +
      '.xmly-track-title { flex: 1 1 auto; min-width: 0; font-size: 12px; color: var(--dsw-alias-label-primary, #e6e6e6); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      '.xmly-track-dur { flex: none; font-variant-numeric: tabular-nums; }\n' +
      // ---- mine ----
      '.xmly-login-box { border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.2)); border-radius: 10px; padding: 12px; }\n' +
      '.xmly-user-row { display: flex; align-items: center; gap: 10px; }\n' +
      '.xmly-avatar { flex: none; width: 36px; height: 36px; border-radius: 50%; background: var(--xmly-accent, #2f9e6e); color: var(--xmly-accent-fg, #fff); display: flex; align-items: center; justify-content: center; font-size: 15px; font-weight: 600; }\n' +
      '.xmly-user-meta { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }\n' +
      '.xmly-user-name { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary, #e6e6e6); display: flex; align-items: center; gap: 6px; }\n' +
      '.xmly-qr-box { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 6px 0; }\n' +
      '.xmly-qr-img { width: 168px; height: 168px; border-radius: 10px; background: #fff; object-fit: contain; }\n' +
      '.xmly-qr-ph { display: flex; align-items: center; justify-content: center; color: #8a8f98; font-size: 13px; }\n' +
      '.xmly-qr-status { margin-top: 4px; color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 11px; text-align: center; }\n' +
      '.xmly-section-title { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary, #e6e6e6); margin-top: 4px; }\n' +
      // ---- mine: segmented + likes + anchors ----
      '.xmly-seg-row { display: flex; gap: 4px; background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.12)); border-radius: 8px; padding: 3px; }\n' +
      '.xmly-seg-btn { flex: 1 1 0; background: transparent; border: none; color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 12px; padding: 6px 2px; border-radius: 6px; cursor: pointer; white-space: nowrap; }\n' +
      '.xmly-seg-btn.active { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.28)); color: var(--dsw-alias-label-primary, #e6e6e6); font-weight: 600; }\n' +
      '.xmly-like-list { display: flex; flex-direction: column; gap: 2px; }\n' +
      '.xmly-like-row { display: flex; align-items: center; gap: 10px; padding: 7px 8px; border-radius: 10px; cursor: pointer; }\n' +
      '.xmly-like-row:hover { background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.12)); }\n' +
      '.xmly-like-row.active { background: color-mix(in srgb, var(--xmly-accent, #2f9e6e) 16%, transparent); }\n' +
      '.xmly-like-row.active .xmly-like-title-text { color: var(--xmly-accent, #2f9e6e); }\n' +
      '.xmly-like-cover { flex: none; width: 42px; height: 42px; border-radius: 8px; object-fit: cover; background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.15)); font-size: 16px; }\n' +
      '.xmly-like-meta { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }\n' +
      '.xmly-like-title { display: flex; align-items: center; gap: 6px; min-width: 0; }\n' +
      '.xmly-like-title-text { font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-primary, #e6e6e6); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      '.xmly-like-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      '.xmly-like-play { flex: none; width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; background: color-mix(in srgb, var(--xmly-accent, #2f9e6e) 18%, transparent); color: var(--xmly-accent, #2f9e6e); font-size: 11px; }\n' +
      '.xmly-anchor-list { display: flex; flex-direction: column; gap: 2px; }\n' +
      '.xmly-anchor-card { display: flex; align-items: center; gap: 10px; padding: 8px; border-radius: 10px; cursor: pointer; }\n' +
      '.xmly-anchor-card:hover { background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.12)); }\n' +
      '.xmly-anchor-avatar { flex: none; width: 42px; height: 42px; border-radius: 50%; object-fit: cover; background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.15)); font-size: 14px; }\n' +
      '.xmly-anchor-meta { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }\n' +
      '.xmly-anchor-name { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary, #e6e6e6); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      '.xmly-anchor-go { flex: none; color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 16px; }\n' +
      '.xmly-anchor-head { display: flex; gap: 12px; align-items: center; }\n' +
      '.xmly-anchor-avatar-lg { flex: none; width: 64px; height: 64px; border-radius: 50%; object-fit: cover; background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.15)); font-size: 18px; }\n' +
      '.xmly-anchor-name-lg { font-size: 14px; font-weight: 700; color: var(--dsw-alias-label-primary, #e6e6e6); }\n' +
      '.xmly-anchor-desc { font-size: 11px; line-height: 1.5; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }\n' +
      '@media (max-width: 560px) { .xmly-panel { left: 8px !important; right: 8px; width: auto !important; } }\n';

    return module.exports;
  },
});
