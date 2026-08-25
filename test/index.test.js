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
  }
})

import { apply } from '../lib/index.js'

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
