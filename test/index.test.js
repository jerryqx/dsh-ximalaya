/**
 * host 半边路由集成测试：起一个真实 http server，挂载 apply() 的 handler，
 * 验证 JSON 路由的鉴权/校验/错误处理（触网的搜索/播放用 stub 替换）。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 测试写到隔离的临时 DSH_HOME，避免污染真实 ~/.dsh/ximalaya-state.json。
// （必须在导入 lib/index.js 之前设置）
const tmpHome = mkdtempSync(join(tmpdir(), 'dsh-ximalaya-test-'))
process.env.DSH_HOME = tmpHome

// stub 掉真实网络模块（避免测试依赖外网）。
vi.mock('../lib/xmly.js', async (importOriginal) => {
  const real = await importOriginal()
  return {
    ...real,
    searchAlbums: vi.fn(async (kw) => ({
      albums: [{
        id: 123, title: '测试专辑', intro: '', cover: '', trackCount: 3,
        anchorName: '主播', category: '测试', isPaid: false, isFinished: true,
        playCount: 10, createdAt: 0, updatedAt: 0, tags: [],
      }],
      total: 1, page: 1, totalPages: 1,
    })),
    albumSimple: vi.fn(async (id) => ({ id: Number(id), title: '测试专辑', anchorName: '主播', cover: '', category: '测试', isPaid: false, isFinished: true, intro: '' })),
    albumTracks: vi.fn(async (id, pageId) => ({
      tracks: [
        { id: 1001, title: '第一集', duration: 60, createdAt: 0, isPaid: false, isFree: true, isAuthorized: true, playCount: 1, comments: 0, likes: 0, orderNo: 1, cover: '', anchorName: '', albumTitle: '测试专辑', intro: '' },
        { id: 1002, title: '第二集', duration: 60, createdAt: 0, isPaid: false, isFree: true, isAuthorized: true, playCount: 1, comments: 0, likes: 0, orderNo: 2, cover: '', anchorName: '', albumTitle: '测试专辑', intro: '' },
      ],
      maxPageId: 1, totalCount: 2, pageId,
    })),
    resolvePlay: vi.fn(async () => ({ url: 'https://example.com/a.m4a', quality: '标准 64kbps M4A', source: 'trackJson', title: '第一集', duration: 60 })),
    qrCreate: vi.fn(async () => ({ qrId: 'QRID', imageDataUrl: 'data:image/png;base64,xxx', expiresAt: Date.now() + 180000 })),
    qrCheck: vi.fn(async () => ({ status: 'waiting', cookies: null })),
    getCurrentUser: vi.fn(async () => null),
    userFollowing: vi.fn(async (uid, page = 1, pageSize = 20) => ({
      anchors: [
        { uid: 170217760, nickname: '三体宇宙', cover: '', description: '三体有声剧官方', ptitle: '', albumCount: 11, trackCount: 488, fansCount: 4725762, followingCount: 22, isFollow: true, url: '/zhubo/170217760' },
        { uid: 2, nickname: '喜马拉雅创作中心', cover: '', description: '', ptitle: '喜马拉雅', albumCount: 776, trackCount: 101161, fansCount: 27105024, followingCount: 152, isFollow: true, url: '/zhubo/2' },
      ],
      total: 2, page, pageSize,
    })),
    likeTracks: vi.fn(async (pageNum = 1, pageSize = 30) => ({
      tracks: [
        { id: 1001, title: '收藏的第一集', cover: '', duration: 258, durationText: '04:18', albumId: 123, albumTitle: '测试专辑', anchorName: '主播', anchorId: 1, playCount: 10, createdAtText: '3天前', isVideo: false, isPaid: false },
        { id: 1002, title: '收藏的第二集', cover: '', duration: 0, durationText: '', albumId: 123, albumTitle: '测试专辑', anchorName: '主播', anchorId: 1, playCount: 5, createdAtText: '', isVideo: false, isPaid: true },
      ],
      total: 2, pageNum, hasMore: true,
    })),
    mySubscriptions: vi.fn(async (page = 1, pageSize = 30) => ({
      albums: [
        { id: 323366, title: '订阅的测试专辑', intro: '', cover: 'https://imagev2.xmcdn.com/storages/x.jpeg', trackCount: 2300, playCount: 175044737, isPaid: false, isFinished: false, anchorName: '詩展', anchorUid: 6042491, category: '历史', score: '9.6', lastTrackTitle: '最新一集', lastUpdateText: '1天前' },
      ],
      total: 1, page, hasMore: false,
    })),
    anchorProfile: vi.fn(async (uid) => ({
      albums: [
        { id: 111, title: '主播专辑一', cover: '', intro: '', trackCount: 10, playCount: 100, isPaid: false, isFinished: true, anchorName: '三体宇宙' },
        { id: 222, title: '主播专辑二（付费）', cover: '', intro: '', trackCount: 20, playCount: 200, isPaid: true, isFinished: false, anchorName: '三体宇宙' },
      ],
      total: 2, uid,
    })),
    setSubscriptionAlbum: vi.fn(async (albumId, on) => ({ msg: on ? '订阅专辑成功' : '取消订阅专辑成功' })),
    setLikeTrack: vi.fn(async (trackId, on) => ({ msg: on ? '点赞成功' : '取消点赞成功' })),
    setFollow: vi.fn(async (uid, on) => ({ msg: on ? 'isFollow' : '成功取消关注' })),
  }
})

import { apply } from '../lib/index.js'
import { qrCheck, getCurrentUser } from '../lib/xmly.js'

let server = null
let registeredTool = null
let promptSection = null
const cleanups = []
const base = 'http://127.0.0.1:18123'

beforeAll(async () => {
  let handler = null
  const ctx = {
    get: () => undefined,
    effect: (fn) => { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup) },
    webServer: { register: (reg) => { handler = reg.handler } },
    tools: { register: (t) => { registeredTool = t } },
    systemPrompt: { section: (s) => { promptSection = s } },
    shell: { run: async () => ({ stdout: { text: '' } }), resolve: (x) => x },
    fs: {},
  }
  apply(ctx)
  server = http.createServer(handler)
  await new Promise((r) => server.listen(18123, '127.0.0.1', r))
})
afterAll(async () => {
  for (const c of cleanups) { try { c() } catch {} }
  await new Promise((r) => server.close(r))
  try { rmSync(tmpHome, { recursive: true, force: true }) } catch {}
})

const get = async (path) => {
  const res = await fetch(base + path)
  return { status: res.status, body: await res.json() }
}
const post = async (path, body) => {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
  return { status: res.status, body: await res.json() }
}

describe('host routes', () => {
  it('manifest 返回初始状态', async () => {
    const { status, body } = await get('/dsh-ximalaya/manifest')
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.loggedIn).toBe(false)
    expect(Array.isArray(body.favs)).toBe(true)
  })

  it('search 缺关键词 400', async () => {
    const { status, body } = await get('/dsh-ximalaya/search')
    expect(status).toBe(400)
    expect(body.ok).toBe(false)
  })

  it('search 命中并记录历史', async () => {
    const { status, body } = await get('/dsh-ximalaya/search?kw=' + encodeURIComponent('测试'))
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.albums[0].title).toBe('测试专辑')
    const m = await get('/dsh-ximalaya/manifest')
    expect(m.body.history).toContain('测试')
  })

  it('album / tracks 路由', async () => {
    const a = await get('/dsh-ximalaya/album?id=123')
    expect(a.body.album.title).toBe('测试专辑')
    const t = await get('/dsh-ximalaya/tracks?albumId=123&pageId=1')
    expect(t.body.tracks.length).toBe(2)
    expect(t.body.totalCount).toBe(2)
  })

  it('play 返回 streamUrl', async () => {
    const p = await get('/dsh-ximalaya/play?trackId=1001')
    expect(p.body.ok).toBe(true)
    expect(p.body.streamUrl).toBe('/dsh-ximalaya/stream?trackId=1001')
    expect(p.body.quality).toContain('M4A')
  })

  it('play 缺 trackId 400', async () => {
    const { status } = await get('/dsh-ximalaya/play')
    expect(status).toBe(400)
  })

  it('prefs 白名单过滤 + playback 快照', async () => {
    const w = await post('/dsh-ximalaya/prefs', {
      prefs: { volume: 0.5, evil: 'hack' },
      playback: { albumId: 123, albumTitle: '测试专辑', trackId: 1001, trackTitle: '第一集', position: 12, duration: 60 },
    })
    expect(w.body.prefs.volume).toBe(0.5)
    expect(w.body.prefs.evil).toBeUndefined()
    expect(w.body.playback.trackId).toBe(1001)
    const r = await get('/dsh-ximalaya/prefs')
    expect(r.body.prefs.volume).toBe(0.5)
    expect(r.body.playback.position).toBe(12)
  })

  it('prefs 持久化 seekStep（快进/快退步长），白名单外键仍被过滤', async () => {
    const w = await post('/dsh-ximalaya/prefs', { prefs: { seekStep: 30, evil: 'hack' } })
    expect(w.body.ok).toBe(true)
    expect(w.body.prefs.seekStep).toBe(30)
    expect(w.body.prefs.evil).toBeUndefined()
    const r = await get('/dsh-ximalaya/prefs')
    expect(r.body.prefs.seekStep).toBe(30)
    // 原有偏好不受影响。
    expect(r.body.prefs.volume).toBe(0.5)
  })

  it('fav 增删', async () => {
    const add = await post('/dsh-ximalaya/fav', { album: { id: 123, title: '测试专辑' } })
    expect(add.body.favs.length).toBe(1)
    const dup = await post('/dsh-ximalaya/fav', { album: { id: 123, title: '测试专辑' } })
    expect(dup.body.favs.length).toBe(1)
    const del = await post('/dsh-ximalaya/fav', { album: { id: 123 }, remove: true })
    expect(del.body.favs.length).toBe(0)
  })

  it('未知路径 404', async () => {
    const { status } = await get('/dsh-ximalaya/nope')
    expect(status).toBe(404)
  })

  it('qr create/check 流程', async () => {
    const c = await post('/dsh-ximalaya/qr/create', {})
    expect(c.body.qrId).toBe('QRID')
    const ck = await get('/dsh-ximalaya/qr/check?qrId=QRID')
    expect(ck.body.status).toBe('waiting')
  })

  it('following / likes / subscriptions / write 未登录返回 401 + needLogin', async () => {
    const f = await get('/dsh-ximalaya/following')
    expect(f.status).toBe(401)
    expect(f.body.ok).toBe(false)
    expect(f.body.needLogin).toBe(true)
    const l = await get('/dsh-ximalaya/likes')
    expect(l.status).toBe(401)
    expect(l.body.needLogin).toBe(true)
    const sub = await get('/dsh-ximalaya/subscriptions')
    expect(sub.status).toBe(401)
    expect(sub.body.needLogin).toBe(true)
    const w = await post('/dsh-ximalaya/write', { op: 'sub', id: 123, on: true })
    expect(w.status).toBe(401)
    expect(w.body.ok).toBe(false)
    expect(w.body.needLogin).toBe(true)
  })

  it('扫码登录后 following / likes / anchor 可用', async () => {
    // 模拟扫码成功 → cookie + user（uid 42）落盘。
    qrCheck.mockResolvedValueOnce({
      status: 'success',
      cookies: { '1&_token': 'tok', uid: '42' },
      token: 'tok',
    })
    getCurrentUser.mockResolvedValueOnce({ uid: 42, nickname: '测试用户', isVip: false, vipExpireTime: 0, isLoginBan: false })
    const c = await post('/dsh-ximalaya/qr/create', {})
    const ck = await get('/dsh-ximalaya/qr/check?qrId=' + encodeURIComponent(c.body.qrId))
    expect(ck.body.status).toBe('success')
    expect(ck.body.user.nickname).toBe('测试用户')

    // 已关注的主播（默认取当前用户 uid）。
    const f = await get('/dsh-ximalaya/following')
    expect(f.status).toBe(200)
    expect(f.body.ok).toBe(true)
    expect(f.body.uid).toBe(42)
    expect(f.body.anchors.length).toBe(2)
    expect(f.body.anchors[0].nickname).toBe('三体宇宙')
    expect(f.body.total).toBe(2)

    // 收藏的声音。
    const l = await get('/dsh-ximalaya/likes?pageNum=1&pageSize=30')
    expect(l.status).toBe(200)
    expect(l.body.ok).toBe(true)
    expect(l.body.tracks.length).toBe(2)
    expect(l.body.tracks[0].title).toBe('收藏的第一集')
    expect(l.body.hasMore).toBe(true)

    // 订阅的专辑。
    const sub = await get('/dsh-ximalaya/subscriptions?page=1&pageSize=30')
    expect(sub.status).toBe(200)
    expect(sub.body.ok).toBe(true)
    expect(sub.body.albums.length).toBe(1)
    expect(sub.body.albums[0].title).toBe('订阅的测试专辑')
    expect(sub.body.albums[0].lastTrackTitle).toBe('最新一集')
    expect(sub.body.hasMore).toBe(false)

    // 主页专辑（匿名可用，显式 uid）。
    const a = await get('/dsh-ximalaya/anchor?uid=170217760')
    expect(a.status).toBe(200)
    expect(a.body.ok).toBe(true)
    expect(a.body.albums.length).toBe(2)
    expect(a.body.albums[1].isPaid).toBe(true)

    // 云端写操作（登录后可用）。
    const subOn = await post('/dsh-ximalaya/write', { op: 'sub', id: 323366, on: true })
    expect(subOn.status).toBe(200)
    expect(subOn.body.ok).toBe(true)
    expect(subOn.body.on).toBe(true)
    expect(subOn.body.msg).toContain('订阅')
    const subOff = await post('/dsh-ximalaya/write', { op: 'sub', id: 323366, on: false })
    expect(subOff.body.on).toBe(false)
    const likeOff = await post('/dsh-ximalaya/write', { op: 'like', id: 1001, on: false })
    expect(likeOff.body.ok).toBe(true)
    const followOff = await post('/dsh-ximalaya/write', { op: 'follow', id: 170217760, on: false })
    expect(followOff.body.ok).toBe(true)
    // on 缺省为 true。
    const likeOn = await post('/dsh-ximalaya/write', { op: 'like', id: 1001 })
    expect(likeOn.body.on).toBe(true)
  })

  it('anchor 无效 uid 400', async () => {
    const { status, body } = await get('/dsh-ximalaya/anchor?uid=abc')
    expect(status).toBe(400)
    expect(body.ok).toBe(false)
  })

  it('write 参数校验：未知 op / 无效 id → 400', async () => {
    const badOp = await post('/dsh-ximalaya/write', { op: 'evil', id: 123 })
    expect(badOp.status).toBe(400)
    const badId = await post('/dsh-ximalaya/write', { op: 'sub', id: 'abc' })
    expect(badId.status).toBe(400)
  })
})

describe('ximalaya_play tool', () => {
  it('注册了工具与 systemPrompt', () => {
    expect(registeredTool.name).toBe('ximalaya_play')
    expect(promptSection.name).toBe('tool:ximalaya')
    expect(promptSection.text).toContain('ximalaya_play')
  })

  it('query 搜索 → 生成 play 意图', async () => {
    const r = await registeredTool.execute({ query: '测试' })
    expect(r.played).toBe(true)
    expect(r.album).toBe('测试专辑')
    const intent = await get('/dsh-ximalaya/intent')
    expect(intent.body.intent.action).toBe('play')
    expect(intent.body.intent.trackId).toBe(1001)
    expect(intent.body.intent.albumId).toBe(123)
  })

  it('意图取走即焚', async () => {
    const intent = await get('/dsh-ximalaya/intent')
    expect(intent.body.intent).toBeNull()
  })

  it('albumId 直播', async () => {
    const r = await registeredTool.execute({ albumId: 123 })
    expect(r.played).toBe(true)
    expect(r.track).toBe('第一集')
  })

  it('trackId 直播', async () => {
    const r = await registeredTool.execute({ trackId: 1002 })
    expect(r.played).toBe(true)
    expect(r.track).toContain('1002')
  })

  it('pause 等动作投递意图', async () => {
    const r = await registeredTool.execute({ action: 'pause' })
    expect(r.played).toBe(false)
    expect(r.notice).toContain('暂停')
    const intent = await get('/dsh-ximalaya/intent')
    expect(intent.body.intent.action).toBe('pause')
  })

  it('空参数提示', async () => {
    const r = await registeredTool.execute({})
    expect(r.played).toBe(false)
    expect(r.notice).toContain('query')
  })

  it('output.render 输出文字', () => {
    const text = registeredTool.output.render({}, { notice: 'hello' })
    expect(text[0].text).toBe('hello')
  })
})
