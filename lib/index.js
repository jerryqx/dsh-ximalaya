/**
 * lib/index.js — dsh-ximalaya host 半边。
 *
 * 职责：
 *   - 在 DSH webServer 上挂载 /dsh-ximalaya/* 路由：搜索/专辑/曲目/播放地址/
 *     音频流式代理（Range 续传）/扫码登录/用户信息/已关注主播/收藏的声音/
 *     主播公开专辑/偏好与收藏持久化/播放意图。
 *   - 注册 ximalaya_play 模型工具（agent 可按关键词搜索并播放喜马拉雅内容）。
 *   - 注入一段 system prompt，让 agent 知道本机可听喜马拉雅。
 *
 * 登录态（cookie）、收藏、播放进度、搜索历史都持久化在 Host 端
 * ~/.dsh/ximalaya-state.json，跨重启/刷新不丢（dsh-desktop 按源隔离的浏览器
 * 存储也不影响）。
 *
 * 浏览器半边（lib/client.js）只通过本模块的 HTTP 路由交互，不直接触碰
 * 喜马拉雅接口（避免浏览器 CORS 与登录态暴露）。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import os from 'node:os'
import { Readable } from 'node:stream'
import {
  XmlyError,
  searchAlbums,
  searchTracks,
  albumSimple,
  albumTracks,
  resolvePlay,
  qrCreate,
  qrCheck,
  getCurrentUser,
  userFollowing,
  likeTracks,
  mySubscriptions,
  anchorProfile,
  joinCookieMap,
  UA_WEB,
} from './xmly.js'

export const name = 'dsh-ximalaya'
export const inject = ['webServer', 'fs', 'shell', 'tools', 'systemPrompt']

// 播放地址缓存：trackId → { url, quality, source, title, expiresAt }。
// CDN 直链通常长期有效，但保守 10 分钟过期；账号态解密地址同理。
const PLAY_TTL = 10 * 60 * 1000

// 偏好里允许持久化的键（白名单，防止客户端把任意字段写进状态文件）。
// seekStep：浏览器侧快进/快退按钮的跳转步长（秒），客户端默认 15。
const PREF_ALLOW = new Set([
  'volume', 'rate', 'seekStep', 'playback', 'panelPos', 'panelOpen', 'quality',
])

export function apply(ctx) {
  let home = null
  let state = null // { cookie:{}, user:{}, prefs:{}, favs:[], history:[], playback:{}, revoked:false }
  let stateLoaded = false
  let pendingIntent = null // 播放意图（客户端轮询即取即焚）
  const playCache = new Map()
  let qrSession = null // { qrId, imageDataUrl, expiresAt, createdAt }

  // ---- home / state persistence（直接用 node:fs，绕开 ctx.fs 工作区围栏）----
  const getHome = async () => {
    if (home !== null) return home
    try {
      const osHome = (typeof os !== 'undefined' && os.homedir) ? os.homedir() : ''
      if (osHome !== '') { home = osHome; return home }
    } catch { /* fall through to shell */ }
    try {
      const result = await ctx.shell.run(ctx.shell.resolve({ command: 'printf %s "$HOME"' }))
      const value = String((result.stdout && result.stdout.text) || '').trim()
      home = value || null
    } catch {
      home = null
    }
    return home
  }
  const stateFile = async () => {
    const h = await getHome()
    const base = (typeof process !== 'undefined' && process.env && process.env.DSH_HOME)
      || (h === null ? null : h + '/.dsh')
    return base === null ? null : base + '/ximalaya-state.json'
  }
  const loadState = async () => {
    if (stateLoaded) return state
    stateLoaded = true
    const file = await stateFile()
    let saved = {}
    if (file !== null && existsSync(file)) {
      try {
        const text = readFileSync(file, 'utf8')
        if (text.trim()) saved = JSON.parse(text)
      } catch { saved = {} }
    }
    state = {
      cookie: (saved.cookie && typeof saved.cookie === 'object') ? saved.cookie : {},
      user: (saved.user && typeof saved.user === 'object') ? saved.user : null,
      prefs: (saved.prefs && typeof saved.prefs === 'object') ? saved.prefs : {},
      favs: Array.isArray(saved.favs)
        ? saved.favs.filter((f) => f && typeof f === 'object' && typeof f.id !== 'undefined')
        : [],
      history: Array.isArray(saved.history)
        ? saved.history.filter((x) => typeof x === 'string' && x !== '')
        : [],
      playback: (saved.playback && typeof saved.playback === 'object') ? saved.playback : {},
    }
    // 后台校验登录态：cookie 失效时清掉 user（不阻塞请求）。
    void refreshUser()
    return state
  }
  const saveState = async () => {
    if (state === null) return
    const file = await stateFile()
    if (file === null) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(state, null, 2) + '\n', 'utf8')
    } catch {
      // 持久化尽力而为：写不进只丢记忆，不影响播放。
    }
  }
  const cookieHeader = () => (state && state.cookie ? joinCookieMap(state.cookie) : '')
  let userRefreshing = null
  const refreshUser = async () => {
    if (userRefreshing !== null) return userRefreshing
    userRefreshing = (async () => {
      try {
        await loadState()
        const header = cookieHeader()
        if (header === '') { state.user = null; return null }
        const user = await getCurrentUser(header)
        state.user = user
        if (user === null) {
          // 登录态失效：保留 cookie 记录但标记未登录（用户可重新扫码覆盖）。
        }
        await saveState()
        return user
      } catch {
        return state ? state.user : null
      } finally {
        userRefreshing = null
      }
    })()
    return userRefreshing
  }

  const ensureState = async () => { if (!stateLoaded) await loadState(); return state }

  // ---- play URL 解析（带缓存）----
  async function resolvePlayCached(trackId) {
    await ensureState()
    const key = String(trackId)
    const hit = playCache.get(key)
    if (hit && hit.expiresAt > Date.now()) return hit
    const resolved = await resolvePlay(trackId, cookieHeader())
    const entry = { ...resolved, expiresAt: Date.now() + PLAY_TTL }
    playCache.set(key, entry)
    return entry
  }

  // ---- 播放意图（agent 工具 → 浏览器）----
  const takeIntent = () => {
    const intent = pendingIntent
    pendingIntent = null
    return intent
  }

  // ---- HTTP helpers ----
  const writeJson = (res, value, status) => {
    res.writeHead(status || 200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(value))
  }
  async function readBody(req) {
    let text = ''
    for await (const chunk of req) text += chunk
    if (text === '') return {}
    try { return JSON.parse(text) } catch { return {} }
  }
  const publicState = () => ({
    loggedIn: cookieHeader() !== '' && !!(state.user && state.user.nickname),
    user: state.user,
    prefs: state.prefs,
    favs: state.favs.slice(0, 200),
    history: state.history.slice(0, 20),
    playback: state.playback,
  })

  // ---- 音频流代理：转发 Range，流式 pipe，上游 403/404 时重取一次直链 ----
  async function relayAudio(req, res, trackId) {
    const upstreamHeaders = { 'user-agent': UA_WEB, referer: 'https://www.ximalaya.com/' }
    const forward = (h) => (typeof req.headers[h] === 'string' ? req.headers[h] : undefined)
    if (forward('range')) upstreamHeaders.range = forward('range')

    const fetchUpstream = async (url) => fetch(url, {
      headers: upstreamHeaders,
      redirect: 'follow',
    })

    let resolved = await resolvePlayCached(trackId)
    let upstream = await fetchUpstream(resolved.url)
    // 直链可能刚过期（403/404）：清缓存重取一次再试。
    if (upstream.status === 403 || upstream.status === 404) {
      playCache.delete(String(trackId))
      resolved = await resolvePlayCached(trackId)
      upstream = await fetchUpstream(resolved.url)
    }

    if (!upstream.ok && upstream.status !== 206) {
      try { upstream.body && await upstream.body.cancel() } catch {}
      writeJson(res, { ok: false, error: '音频源返回 HTTP ' + upstream.status }, 502)
      return
    }

    const headers = {
      'content-type': upstream.headers.get('content-type') || 'audio/x-m4a',
      'cache-control': 'no-store',
      'accept-ranges': upstream.headers.get('accept-ranges') || 'bytes',
    }
    for (const h of ['content-length', 'content-range']) {
      const v = upstream.headers.get(h)
      if (v) headers[h] = v
    }
    res.writeHead(upstream.status, headers)
    if (req.method === 'HEAD') {
      try { upstream.body && await upstream.body.cancel() } catch {}
      res.end()
      return
    }
    if (!upstream.body) { res.end(); return }
    await new Promise((resolve) => {
      const nodeStream = Readable.fromWeb(upstream.body)
      nodeStream.pipe(res)
      nodeStream.on('error', () => { try { res.end() } catch {} resolve() })
      res.on('close', () => { try { nodeStream.destroy() } catch {} resolve() })
      nodeStream.on('end', resolve)
    })
  }

  // ---- 路由 ----
  const serve = async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://x')
      const pathname = url.pathname
      await ensureState()

      // 初始清单：登录态/收藏/历史/上次播放。
      if (pathname === '/dsh-ximalaya/manifest' && req.method === 'GET') {
        writeJson(res, { ok: true, ...publicState() })
        return
      }

      // 搜索专辑（顺便记录搜索历史）。
      if (pathname === '/dsh-ximalaya/search' && req.method === 'GET') {
        const kw = (url.searchParams.get('kw') || '').trim()
        const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1)
        if (kw === '') { writeJson(res, { ok: false, error: '缺少关键词' }, 400); return }
        try {
          const result = await searchAlbums(kw, page, 20)
          if (page === 1 && result.albums.length > 0) {
            state.history = [kw, ...state.history.filter((x) => x !== kw)].slice(0, 20)
            void saveState()
          }
          writeJson(res, { ok: true, ...result })
        } catch (err) {
          writeJson(res, { ok: false, error: String((err && err.message) || err) }, err instanceof XmlyError ? err.status : 500)
        }
        return
      }

      // 专辑详情。
      if (pathname === '/dsh-ximalaya/album' && req.method === 'GET') {
        const id = url.searchParams.get('id') || ''
        try {
          const album = await albumSimple(id)
          writeJson(res, { ok: true, album })
        } catch (err) {
          writeJson(res, { ok: false, error: String((err && err.message) || err) }, err instanceof XmlyError ? err.status : 500)
        }
        return
      }

      // 专辑曲目列表（分页）。
      if (pathname === '/dsh-ximalaya/tracks' && req.method === 'GET') {
        const albumId = url.searchParams.get('albumId') || ''
        const pageId = Math.max(1, parseInt(url.searchParams.get('pageId') || '1', 10) || 1)
        const pageSize = Math.min(50, Math.max(10, parseInt(url.searchParams.get('pageSize') || '30', 10) || 30))
        try {
          const result = await albumTracks(albumId, pageId, pageSize)
          writeJson(res, { ok: true, ...result })
        } catch (err) {
          writeJson(res, { ok: false, error: String((err && err.message) || err) }, err instanceof XmlyError ? err.status : 500)
        }
        return
      }

      // 解析播放地址（JSON，调试/预取用；正式播放走 /stream）。
      if (pathname === '/dsh-ximalaya/play' && req.method === 'GET') {
        const trackId = url.searchParams.get('trackId') || ''
        if (trackId === '') { writeJson(res, { ok: false, error: '缺少 trackId' }, 400); return }
        try {
          const resolved = await resolvePlayCached(trackId)
          writeJson(res, {
            ok: true, trackId: Number(trackId), quality: resolved.quality,
            source: resolved.source, title: resolved.title, duration: resolved.duration,
            streamUrl: '/dsh-ximalaya/stream?trackId=' + encodeURIComponent(trackId),
          })
        } catch (err) {
          writeJson(res, { ok: false, error: String((err && err.message) || err), needAuth: err instanceof XmlyError && err.code === 'NEED_AUTH' }, err instanceof XmlyError ? err.status : 500)
        }
        return
      }

      // 音频流代理（<audio> 的 src 指向这里；Range/seek 透传）。
      if (pathname === '/dsh-ximalaya/stream' && (req.method === 'GET' || req.method === 'HEAD')) {
        const trackId = url.searchParams.get('trackId') || ''
        if (trackId === '') { res.writeHead(400); res.end(); return }
        await relayAudio(req, res, trackId)
        return
      }

      // 扫码登录：创建二维码。
      if (pathname === '/dsh-ximalaya/qr/create' && req.method === 'POST') {
        try {
          qrSession = await qrCreate()
          writeJson(res, { ok: true, qrId: qrSession.qrId, imageDataUrl: qrSession.imageDataUrl, expiresAt: qrSession.expiresAt })
        } catch (err) {
          writeJson(res, { ok: false, error: String((err && err.message) || err) }, 502)
        }
        return
      }
      // 扫码登录：轮询结果（成功即落盘 cookie + user）。
      if (pathname === '/dsh-ximalaya/qr/check' && req.method === 'GET') {
        if (qrSession === null || !url.searchParams.get('qrId')) {
          writeJson(res, { ok: false, error: '二维码未创建' }, 400); return
        }
        if (url.searchParams.get('qrId') !== qrSession.qrId) {
          writeJson(res, { ok: false, error: '二维码已刷新，请重新打开' }, 400); return
        }
        try {
          const result = await qrCheck(qrSession.qrId)
          if (result.status === 'success' && result.cookies) {
            state.cookie = result.cookies
            playCache.clear()
            const user = await refreshUser()
            qrSession = null
            await saveState()
            writeJson(res, { ok: true, status: 'success', user: user || { nickname: '' } })
          } else if (qrSession.expiresAt < Date.now()) {
            qrSession = null
            writeJson(res, { ok: true, status: 'expired' })
          } else {
            writeJson(res, { ok: true, status: 'waiting' })
          }
        } catch (err) {
          writeJson(res, { ok: false, error: String((err && err.message) || err) }, 502)
        }
        return
      }

      // 用户信息（强制刷新）。
      if (pathname === '/dsh-ximalaya/user' && req.method === 'GET') {
        const user = await refreshUser()
        writeJson(res, { ok: true, loggedIn: !!user, user })
        return
      }
      // 退出登录。
      if (pathname === '/dsh-ximalaya/logout' && req.method === 'POST') {
        state.cookie = {}
        state.user = null
        playCache.clear()
        await saveState()
        writeJson(res, { ok: true })
        return
      }

      // 偏好读写（音量/倍速/面板位置/上次播放/当前播放快照）。
      if (pathname === '/dsh-ximalaya/prefs' && req.method === 'GET') {
        writeJson(res, { ok: true, prefs: state.prefs, playback: state.playback })
        return
      }
      if (pathname === '/dsh-ximalaya/prefs' && req.method === 'POST') {
        const body = await readBody(req)
        const patch = (body && body.prefs && typeof body.prefs === 'object') ? body.prefs : {}
        for (const [k, v] of Object.entries(patch)) {
          if (PREF_ALLOW.has(k)) state.prefs[k] = v
        }
        if (body && body.playback && typeof body.playback === 'object') {
          const pb = body.playback
          state.playback = {
            albumId: typeof pb.albumId === 'number' ? pb.albumId : state.playback.albumId,
            albumTitle: typeof pb.albumTitle === 'string' ? pb.albumTitle : '',
            trackId: typeof pb.trackId === 'number' ? pb.trackId : null,
            trackTitle: typeof pb.trackTitle === 'string' ? pb.trackTitle : '',
            position: Number.isFinite(pb.position) ? Math.max(0, pb.position) : 0,
            duration: Number.isFinite(pb.duration) ? Math.max(0, pb.duration) : 0,
            updatedAt: Date.now(),
          }
        }
        await saveState()
        writeJson(res, { ok: true, prefs: state.prefs, playback: state.playback })
        return
      }

      // 收藏专辑（增/删）。
      if (pathname === '/dsh-ximalaya/fav' && req.method === 'POST') {
        const body = await readBody(req)
        const album = body && body.album
        if (!album || typeof album.id !== 'number') { writeJson(res, { ok: false, error: '无效的专辑' }, 400); return }
        if (body.remove === true) {
          state.favs = state.favs.filter((f) => f.id !== album.id)
        } else {
          state.favs = [
            { id: album.id, title: album.title || '', cover: album.cover || '', anchorName: album.anchorName || '', trackCount: album.trackCount || 0, category: album.category || '', isPaid: !!album.isPaid, addedAt: Date.now() },
            ...state.favs.filter((f) => f.id !== album.id),
          ].slice(0, 200)
        }
        await saveState()
        writeJson(res, { ok: true, favs: state.favs })
        return
      }

      // 已关注的主播列表（默认取当前登录用户，uid 可显式指定）。
      if (pathname === '/dsh-ximalaya/following' && req.method === 'GET') {
        let uid = Number(url.searchParams.get('uid') || 0)
        const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1)
        const pageSize = Math.min(50, Math.max(1, parseInt(url.searchParams.get('pageSize') || '20', 10) || 20))
        if (!Number.isInteger(uid) || uid <= 0) {
          // 未显式给 uid：用当前登录用户（cookie 在但 user 未就绪时先刷新一次）。
          let user = state.user
          if ((!user || !user.uid) && cookieHeader() !== '') user = await refreshUser()
          uid = (user && user.uid) || 0
        }
        if (uid <= 0) {
          writeJson(res, { ok: false, needLogin: true, error: '请先在面板「我的」页扫码登录，才能查看已关注的主播' }, 401)
          return
        }
        try {
          const result = await userFollowing(uid, page, pageSize)
          writeJson(res, { ok: true, uid, ...result })
        } catch (err) {
          writeJson(res, { ok: false, error: String((err && err.message) || err) }, err instanceof XmlyError ? err.status : 500)
        }
        return
      }

      // 收藏（喜欢）的声音列表（需登录）。
      if (pathname === '/dsh-ximalaya/likes' && req.method === 'GET') {
        if (cookieHeader() === '') {
          writeJson(res, { ok: false, needLogin: true, error: '请先在面板「我的」页扫码登录，才能查看收藏的声音' }, 401)
          return
        }
        const pageNum = Math.max(1, parseInt(url.searchParams.get('pageNum') || '1', 10) || 1)
        const pageSize = Math.min(50, Math.max(1, parseInt(url.searchParams.get('pageSize') || '30', 10) || 30))
        try {
          const result = await likeTracks(pageNum, pageSize, cookieHeader())
          writeJson(res, { ok: true, ...result })
        } catch (err) {
          writeJson(res, {
            ok: false,
            error: String((err && err.message) || err),
            needLogin: err instanceof XmlyError && err.code === 'NEED_LOGIN',
          }, err instanceof XmlyError ? err.status : 500)
        }
        return
      }

      // 我的订阅：订阅的专辑列表（需登录）。
      if (pathname === '/dsh-ximalaya/subscriptions' && req.method === 'GET') {
        if (cookieHeader() === '') {
          writeJson(res, { ok: false, needLogin: true, error: '请先在面板「我的」页扫码登录，才能查看订阅的专辑' }, 401)
          return
        }
        const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1)
        const pageSize = Math.min(50, Math.max(1, parseInt(url.searchParams.get('pageSize') || '30', 10) || 30))
        try {
          const result = await mySubscriptions(page, pageSize, cookieHeader())
          writeJson(res, { ok: true, ...result })
        } catch (err) {
          writeJson(res, {
            ok: false,
            error: String((err && err.message) || err),
            needLogin: err instanceof XmlyError && err.code === 'NEED_LOGIN',
          }, err instanceof XmlyError ? err.status : 500)
        }
        return
      }

      // 主播主页：公开专辑列表（匿名可用，点击关注的主播时浏览其节目）。
      if (pathname === '/dsh-ximalaya/anchor' && req.method === 'GET') {
        const uid = Number(url.searchParams.get('uid') || 0)
        if (!Number.isInteger(uid) || uid <= 0) { writeJson(res, { ok: false, error: '无效的主播 ID' }, 400); return }
        try {
          const result = await anchorProfile(uid)
          writeJson(res, { ok: true, uid, ...result })
        } catch (err) {
          writeJson(res, { ok: false, error: String((err && err.message) || err) }, err instanceof XmlyError ? err.status : 500)
        }
        return
      }

      // 播放意图（工具触发，轮询即取即焚）。
      if (pathname === '/dsh-ximalaya/intent' && req.method === 'GET') {
        writeJson(res, { ok: true, intent: takeIntent() })
        return
      }

      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: 'not found' }))
    } catch (err) {
      try {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
      } catch { /* socket gone */ }
    }
  }
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/dsh-ximalaya', handler: serve }), 'ximalaya: routes')

  // ---- model tool: ximalaya_play ----
  const ACTIONS = ['play', 'pause', 'resume', 'stop', 'next', 'prev']
  const tool = {
    name: 'ximalaya_play',
    description: '收听喜马拉雅播客/有声书/相声。action=play（默认）时按关键词搜索并播放：query 传专辑或声音关键词（如「三体」「郭德纲相声」「晓说」），也可直接传 albumId 或 trackId。其余 action 控制播放：pause 暂停、resume 继续、stop 停止、next 下一集、prev 上一集。播放与控制在浏览器播放条上进行。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '专辑/声音关键词（如「三体」「郭德纲相声」）。仅 action=play 时使用' },
        albumId: { type: 'number', description: '直接指定专辑 ID（喜马拉雅专辑页 URL 里的数字）。仅 action=play 时使用，优先级高于 query' },
        trackId: { type: 'number', description: '直接指定曲目（声音）ID。仅 action=play 时使用，优先级最高' },
        action: { type: 'string', enum: ACTIONS, description: 'play 播放（默认）、pause 暂停、resume 继续、stop 停止、next 下一集、prev 上一集' },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          action: { type: 'string' }, played: { type: 'boolean' },
          album: { type: 'string' }, track: { type: 'string' },
          matches: { type: 'number' }, notice: { type: 'string' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: (value && value.notice) || (value && value.track ? '已请求播放：' + value.track : '操作已提交') }]
      },
    },
    async execute(args) {
      await ensureState()
      const action = args && typeof args.action === 'string' && ACTIONS.includes(args.action) ? args.action : 'play'

      // 非播放动作：直接投递给浏览器播放条。
      if (action !== 'play') {
        pendingIntent = { action }
        const labels = {
          pause: '已请求暂停播放', resume: '已请求继续播放', stop: '已请求停止播放',
          next: '已请求播放下一集', prev: '已请求播放上一集',
        }
        return { action, played: false, album: '', track: '', matches: 0, notice: labels[action] + '。若浏览器拦截自动操作，请在播放条上点击对应按钮。' }
      }

      // 直接指定曲目。
      const trackId = args && Number.isFinite(args.trackId) ? Number(args.trackId) : 0
      if (trackId > 0) {
        pendingIntent = { action: 'play', trackId }
        return { action, played: true, album: '', track: '曲目 #' + trackId, matches: 1, notice: '已请求播放喜马拉雅曲目 #' + trackId + '。浏览器可能拦截自动播放，请在播放条点击一次▶解锁。' }
      }

      // 直接指定专辑：取第一页曲目，从第一集播起。
      const albumId = args && Number.isFinite(args.albumId) ? Number(args.albumId) : 0
      if (albumId > 0) {
        try {
          const album = await albumSimple(albumId)
          const list = await albumTracks(albumId, 1, 30)
          if (list.tracks.length === 0) {
            return { action, played: false, album: album.title, track: '', matches: 0, notice: '专辑「' + album.title + '」没有可播放的曲目。' }
          }
          pendingIntent = { action: 'play', albumId, albumTitle: album.title, trackId: list.tracks[0].id, trackTitle: list.tracks[0].title }
          return { action, played: true, album: album.title, track: list.tracks[0].title, matches: list.tracks.length, notice: '已请求播放专辑「' + album.title + '」第 1 集（共 ' + list.totalCount + ' 集）。若被拦截请点 ▶ 解锁。' }
        } catch (err) {
          return { action, played: false, album: '', track: '', matches: 0, notice: '专辑获取失败：' + String((err && err.message) || err) }
        }
      }

      // 关键词搜索。
      const query = args && typeof args.query === 'string' ? args.query.trim() : ''
      if (query === '') {
        return { action, played: false, album: '', track: '', matches: 0, notice: '请提供 query 关键词（专辑/声音名），或直接传 albumId/trackId。' }
      }
      try {
        const { albums } = await searchAlbums(query, 1, 10)
        if (albums.length === 0) {
          return { action, played: false, album: '', track: '', matches: 0, notice: '喜马拉雅没有找到「' + query + '」相关的专辑。' }
        }
        // 优先标题完全包含关键词的结果，否则取第一个。
        const lower = query.toLowerCase()
        const pick = albums.find((a) => a.title.toLowerCase().includes(lower)) || albums[0]
        const list = await albumTracks(pick.id, 1, 30)
        if (list.tracks.length === 0) {
          return { action, played: false, album: pick.title, track: '', matches: 0, notice: '专辑「' + pick.title + '」没有可播放的曲目。' }
        }
        pendingIntent = { action: 'play', albumId: pick.id, albumTitle: pick.title, trackId: list.tracks[0].id, trackTitle: list.tracks[0].title }
        return {
          action, played: true, album: pick.title, track: list.tracks[0].title, matches: albums.length,
          notice: '已请求播放喜马拉雅「' + pick.title + '」（' + pick.anchorName + '，共 ' + list.totalCount + ' 集）第 1 集：' + list.tracks[0].title + '。若被拦截请点 ▶ 解锁。免费内容可直接播；VIP/已购内容需先在面板扫码登录。',
        }
      } catch (err) {
        return { action, played: false, album: '', track: '', matches: 0, notice: '喜马拉雅搜索失败：' + String((err && err.message) || err) }
      }
    },
  }
  ctx.effect(() => ctx.tools.register(tool), 'ximalaya: ximalaya_play tool')

  // ---- system prompt 提示 ----
  ctx.systemPrompt.section({
    name: 'tool:ximalaya', order: 117,
    text: '本机已挂载喜马拉雅播客播放器：可用 ximalaya_play 工具按关键词（专辑名/声音名，如「三体」「郭德纲相声」）搜索并播放在线喜马拉雅内容，也可传 albumId/trackId 精确播放；并支持 action 暂停/继续/停止/下一集/上一集。免费专辑匿名即可播，VIP/付费内容需用户已在播放面板扫码登录。',
  })

  void loadState()
}
