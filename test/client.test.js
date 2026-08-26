/**
 * Web 半边冒烟测试：在 jsdom 里加载 client.js 的 ModuleLoader 工厂，
 * 验证 apply() 能注册 style/slot，并渲染播放条与面板的基础 DOM。
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' })
global.window = dom.window
global.document = dom.window.document
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true, writable: true })
Object.defineProperty(global, 'HTMLElement', { value: dom.window.HTMLElement, configurable: true, writable: true })
// Audio 桩：记录监听器；play() 异步加载出 300 秒时长并派发媒体事件
// （loadedmetadata/durationchange/play/playing），pause() 派发 pause，
// 供快进/快退、时间显示与进度条断言使用。
global.Audio = class {
  constructor() {
    this.volume = 1
    this.playbackRate = 1
    this.currentTime = 0
    this.duration = 0
    this.paused = true
    this.readyState = 0
    this.listeners = {}
    this.style = {}
  }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn) }
  removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter((f) => f !== fn) }
  _fire(t) { for (const fn of [...(this.listeners[t] || [])]) fn({ target: this }) }
  play() {
    this.paused = false
    setTimeout(() => {
      this.readyState = 1
      this.duration = 300
      this._fire('loadedmetadata')
      this._fire('durationchange')
      this._fire('play')
      this._fire('playing')
    }, 0)
    return Promise.resolve()
  }
  pause() { this.paused = true; this._fire('pause') }
  load() {}
  setAttribute() {}
  removeAttribute() {}
}
// manifest 响应数据（可变，便于测试步长配置下发）。
const manifestData = { prefs: {} }
// fetch stub：全部返回 ok 的响应，避免测试触网。
global.fetch = vi.fn(async (url) => ({
  ok: true,
  json: async () => {
    const u = String(url)
    if (u.includes('/manifest')) return {
      ok: true, loggedIn: true,
      user: { uid: 42, nickname: '测试用户', isVip: false, vipExpireTime: 0, isLoginBan: false },
      favs: [], history: [], prefs: manifestData.prefs, playback: null,
    }
    if (u.includes('/intent')) return { ok: true, intent: null }
    if (u.includes('/search')) return { ok: true, albums: [], total: 0, page: 1, totalPages: 1 }
    if (u.includes('/play')) return { ok: true, quality: '标准 64kbps M4A', streamUrl: '/dsh-ximalaya/stream?trackId=1' }
    if (u.includes('/likes')) return {
      ok: true, total: 1, pageNum: 1, hasMore: false,
      tracks: [{ id: 9001, title: '收藏的测试声音', cover: '', duration: 258, durationText: '04:18', albumId: 123, albumTitle: '测试专辑', anchorName: '主播', anchorId: 1, playCount: 3, createdAtText: '3天前', isVideo: false, isPaid: false }],
    }
    if (u.includes('/subscriptions')) return {
      ok: true, total: 1, page: 1, hasMore: false,
      albums: [{ id: 323366, title: '订阅的测试专辑', intro: '', cover: '', trackCount: 2300, playCount: 100, isPaid: false, isFinished: false, anchorName: '詩展', anchorUid: 1, category: '历史', score: '9.6', lastTrackTitle: '订阅专辑最新一集', lastUpdateText: '1天前' }],
    }
    if (u.includes('/following')) return {
      ok: true, total: 1, page: 1, pageSize: 20,
      anchors: [{ uid: 170217760, nickname: '三体宇宙', cover: '', description: '', ptitle: '', albumCount: 11, trackCount: 488, fansCount: 4725762, followingCount: 22, isFollow: true, url: '/zhubo/170217760' }],
    }
    if (u.includes('/anchor')) return {
      ok: true, uid: 170217760, total: 1,
      albums: [{ id: 111, title: '主播的专辑', cover: '', intro: '', trackCount: 10, playCount: 100, isPaid: false, isFinished: true, anchorName: '三体宇宙' }],
    }
    if (u.includes('/album')) return { ok: true, album: { id: 123, title: '测试专辑' } }
    if (u.includes('/tracks')) return { ok: true, tracks: [], maxPageId: 1, totalCount: 0, pageId: 1 }
    if (u.includes('/write')) return { ok: true, op: 'sub', id: 0, on: true, msg: '操作成功' }
    return { ok: true }
  },
}))

let loaded = null
global.window.__ModuleLoader__ = {
  load(def) { loaded = def },
}

const slotsRegistered = []
const fakeSlots = {
  inject(slotName, register) {
    const entry = register()
    slotsRegistered.push({ slotName, entry })
    return () => {}
  },
  register: (meta, render) => ({ meta, render }),
}

let clientMod = null
beforeAll(async () => {
  await import('../lib/client.js')
  clientMod = loaded.factory((id) => {
    if (id === 'react') return React
    throw new Error('unexpected require: ' + id)
  })
})

describe('client half', () => {
  it('exposes apply/inject', () => {
    expect(typeof clientMod.apply).toBe('function')
    expect(clientMod.inject).toEqual(['slots'])
  })

  it('apply() injects style and registers dock + overlay slots', () => {
    const effects = []
    const ctx = {
      get: (name) => (name === 'slots' ? fakeSlots : undefined),
      effect: (fn, label) => { const cleanup = fn(); effects.push({ cleanup, label }) },
    }
    clientMod.apply(ctx)

    // style 注入
    const styleEl = document.querySelector('style[data-plugin="dsh-ximalaya"]')
    expect(styleEl).not.toBeNull()
    expect(styleEl.textContent).toContain('.xmly-bar')

    // slot 注册：dock 播放条 + overlay 面板
    expect(slotsRegistered.length).toBe(2)
    const dock = slotsRegistered.find((x) => x.slotName === 'conversation.input.dock')
    const overlay = slotsRegistered.find((x) => x.slotName === 'shell.overlay')
    expect(dock).toBeTruthy()
    expect(overlay).toBeTruthy()

    // 渲染播放条
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    root.render(dock.entry.render())
    // 异步渲染 flush
    return new Promise((resolve) => {
      setTimeout(() => {
        expect(host.textContent).toContain('喜马拉雅')
        for (const e of effects) { try { e.cleanup() } catch {} }
        root.unmount()
        resolve()
      }, 50)
    })
  })

  it('面板「我的」页展示收藏的声音与关注的主播，收藏声音可点击播放', async () => {
    const effects = []
    const ctx = {
      get: (name) => (name === 'slots' ? fakeSlots : undefined),
      effect: (fn) => { const cleanup = fn(); if (typeof cleanup === 'function') effects.push(cleanup) },
    }
    clientMod.apply(ctx)
    const dock = slotsRegistered.find((x) => x.slotName === 'conversation.input.dock')
    const overlay = slotsRegistered.find((x) => x.slotName === 'shell.overlay')

    const barHost = document.createElement('div')
    const panelHost = document.createElement('div')
    document.body.appendChild(barHost)
    document.body.appendChild(panelHost)
    const barRoot = createRoot(barHost)
    const panelRoot = createRoot(panelHost)
    barRoot.render(dock.entry.render())
    panelRoot.render(overlay.entry.render())

    const flush = (ms = 80) => new Promise((r) => setTimeout(r, ms))
    const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    const findBtnByTitle = (rootEl, title) => [...rootEl.querySelectorAll('button')].find((b) => b.getAttribute('title') === title)
    const findBtnContains = (rootEl, text) => [...rootEl.querySelectorAll('button')].find((b) => (b.textContent || '').includes(text))

    await flush()
    // 打开面板
    click(findBtnByTitle(barHost, '搜索/列表'))
    await flush()
    expect(panelHost.querySelector('.xmly-panel')).not.toBeNull()
    // 切到「我的」
    click(findBtnContains(panelHost, '我的'))
    await flush(150)
    const panelText = panelHost.textContent
    // 四个分段都在
    expect(panelText).toContain('声音')
    expect(panelText).toContain('订阅')
    expect(panelText).toContain('主播')
    expect(panelText).toContain('专辑')
    // 默认分段（likes）懒加载出收藏的声音
    expect(panelText).toContain('收藏的测试声音')
    expect(panelText).toContain('测试专辑')

    // 切到「订阅」分段：订阅专辑卡片 + 最新更新提示
    click(findBtnContains(panelHost, '订阅'))
    await flush(150)
    expect(panelHost.textContent).toContain('订阅的测试专辑')
    expect(panelHost.textContent).toContain('最新：1天前 · 订阅专辑最新一集')

    // 切到「主播」分段
    click(findBtnContains(panelHost, '主播'))
    await flush(150)
    expect(panelHost.textContent).toContain('三体宇宙')
    expect(panelHost.textContent).toContain('粉丝')

    // 切回「声音」分段并点击一条 → 播放条出现该曲目
    click(findBtnContains(panelHost, '声音'))
    await flush(100)
    const likeRow = panelHost.querySelector('.xmly-like-row')
    expect(likeRow).not.toBeNull()
    click(likeRow)
    await flush(150)
    expect(barHost.textContent).toContain('收藏的测试声音')

    for (const c of effects) { try { c() } catch {} }
    barRoot.unmount()
    panelRoot.unmount()
  })

  it('快进/快退：常规跳转、暂停态可用、起点/终点边界钳制', async () => {
    const effects = []
    const ctx = {
      get: (name) => (name === 'slots' ? fakeSlots : undefined),
      effect: (fn) => { const cleanup = fn(); if (typeof cleanup === 'function') effects.push(cleanup) },
    }
    clientMod.apply(ctx)
    const dock = slotsRegistered.find((x) => x.slotName === 'conversation.input.dock')
    const overlay = slotsRegistered.find((x) => x.slotName === 'shell.overlay')

    const barHost = document.createElement('div')
    const panelHost = document.createElement('div')
    document.body.appendChild(barHost)
    document.body.appendChild(panelHost)
    const barRoot = createRoot(barHost)
    const panelRoot = createRoot(panelHost)
    barRoot.render(dock.entry.render())
    panelRoot.render(overlay.entry.render())

    const flush = (ms = 60) => new Promise((r) => setTimeout(r, ms))
    const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    const btnByTitlePrefix = (prefix) => [...barHost.querySelectorAll('button')]
      .find((b) => (b.getAttribute('title') || '').startsWith(prefix))
    const timeText = () => (barHost.querySelector('.xmly-bar-time').textContent || '').trim()
    const fillPct = () => Number(parseFloat(barHost.querySelector('.xmly-progress-fill').style.width))

    await flush()
    // 起一首曲子（收藏的声音），等桩里的元数据（300 秒时长）就绪。
    click(btnByTitlePrefix('搜索/列表'))
    await flush()
    if (panelHost.querySelector('.xmly-panel') === null) {
      // 上个用例可能留下「面板已打开」状态（按钮是切换语义）：再点一次打开。
      click(btnByTitlePrefix('搜索/列表'))
      await flush()
    }
    expect(panelHost.querySelector('.xmly-panel')).not.toBeNull()
    click([...panelHost.querySelectorAll('button')].find((b) => (b.textContent || '').includes('我的')))
    await flush(150)
    click(panelHost.querySelector('.xmly-like-row'))
    await flush(150)
    expect(barHost.textContent).toContain('收藏的测试声音')
    expect(timeText()).toBe('0:00 / 5:00')

    const ff = btnByTitlePrefix('快进')
    const rew = btnByTitlePrefix('快退')
    expect(ff).toBeTruthy()
    expect(rew).toBeTruthy()
    expect(ff.getAttribute('title')).toContain('15 秒') // 默认步长 15 秒

    // 常规快进：0 → 15s，时间显示与进度条同步更新。
    click(ff); await flush(20)
    expect(timeText()).toBe('0:15 / 5:00')
    expect(fillPct()).toBe(5)

    // 暂停状态下同样可跳转：15 → 30s。
    click(btnByTitlePrefix('暂停')); await flush(20)
    click(ff); await flush(20)
    expect(timeText()).toBe('0:30 / 5:00')

    // 终点边界：连点到头，钳制在总时长 300s，不越界。
    for (let i = 0; i < 25; i++) { click(ff); await flush(10) }
    expect(timeText()).toBe('5:00 / 5:00')
    expect(fillPct()).toBe(100)
    click(ff); await flush(20)
    expect(timeText()).toBe('5:00 / 5:00')

    // 起点边界：往回连点，钳制在 0，不越界。
    for (let i = 0; i < 30; i++) { click(rew); await flush(10) }
    expect(timeText()).toBe('0:00 / 5:00')
    expect(fillPct()).toBe(0)
    click(rew); await flush(20)
    expect(timeText()).toBe('0:00 / 5:00')

    for (const c of effects) { try { c() } catch {} }
    barRoot.unmount()
    panelRoot.unmount()
  })

  it('快进/快退步长可配置：右键弹层选择 30 秒并持久化，manifest 下发 60 秒生效', async () => {
    const effects = []
    const ctx = {
      get: (name) => (name === 'slots' ? fakeSlots : undefined),
      effect: (fn) => { const cleanup = fn(); if (typeof cleanup === 'function') effects.push(cleanup) },
    }
    clientMod.apply(ctx)
    const dock = slotsRegistered.find((x) => x.slotName === 'conversation.input.dock')

    const barHost = document.createElement('div')
    document.body.appendChild(barHost)
    const barRoot = createRoot(barHost)
    barRoot.render(dock.entry.render())

    const flush = (ms = 60) => new Promise((r) => setTimeout(r, ms))
    const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    const ctxMenu = (el) => el.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    const btnByTitlePrefix = (prefix) => [...barHost.querySelectorAll('button')]
      .find((b) => (b.getAttribute('title') || '').startsWith(prefix))
    const timeText = () => (barHost.querySelector('.xmly-bar-time').textContent || '').trim()

    await flush()
    // 右键 ⏩ 打开步长弹层，默认选中 15 秒。
    ctxMenu(btnByTitlePrefix('快进'))
    await flush()
    const pop = barHost.querySelector('.xmly-step-pop')
    expect(pop).not.toBeNull()
    expect(pop.querySelector('.xmly-chip.active').textContent).toBe('15 秒')

    // 选择 30 秒：立即生效，并通过 /prefs 持久化到宿主。
    click([...pop.querySelectorAll('button')].find((b) => b.textContent === '30 秒'))
    await flush()
    expect(btnByTitlePrefix('快进').getAttribute('title')).toContain('30 秒')
    expect(btnByTitlePrefix('快退').getAttribute('title')).toContain('30 秒')
    const posted = global.fetch.mock.calls
      .filter(([u]) => String(u).includes('/prefs'))
      .some(([, opts]) => opts && opts.body && opts.body.includes('"seekStep":30'))
    expect(posted).toBe(true)

    // 新步长生效：0 → 30s。
    click(btnByTitlePrefix('快进')); await flush(20)
    expect(timeText()).toBe('0:30 / 5:00')

    // manifest 下发 seekStep=60：重新 apply 加载后生效。
    manifestData.prefs = { seekStep: 60 }
    clientMod.apply(ctx)
    await flush(150)
    expect(btnByTitlePrefix('快退').getAttribute('title')).toContain('60 秒')

    for (const c of effects) { try { c() } catch {} }
    barRoot.unmount()
  })

  it('云端同步操作：取消收藏声音 / 退订专辑 / 专辑页订阅', async () => {
    const effects = []
    const ctx = {
      get: (name) => (name === 'slots' ? fakeSlots : undefined),
      effect: (fn) => { const cleanup = fn(); if (typeof cleanup === 'function') effects.push(cleanup) },
    }
    clientMod.apply(ctx)
    const dock = slotsRegistered.find((x) => x.slotName === 'conversation.input.dock')
    const overlay = slotsRegistered.find((x) => x.slotName === 'shell.overlay')

    const barHost = document.createElement('div')
    const panelHost = document.createElement('div')
    document.body.appendChild(barHost)
    document.body.appendChild(panelHost)
    const barRoot = createRoot(barHost)
    const panelRoot = createRoot(panelHost)
    barRoot.render(dock.entry.render())
    panelRoot.render(overlay.entry.render())

    const flush = (ms = 80) => new Promise((r) => setTimeout(r, ms))
    const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    const findBtnByTitle = (rootEl, title) => [...rootEl.querySelectorAll('button')].find((b) => b.getAttribute('title') === title)
    const writeCalls = () => global.fetch.mock.calls
      .filter(([u]) => String(u).includes('/write'))
      .map(([, opts]) => JSON.parse(opts.body))

    await flush()
    // 打开面板 → 我的
    click(findBtnByTitle(barHost, '搜索/列表'))
    await flush()
    if (panelHost.querySelector('.xmly-panel') === null) { click(findBtnByTitle(barHost, '搜索/列表')); await flush() }
    click([...panelHost.querySelectorAll('button')].find((b) => (b.textContent || '').includes('我的')))
    await flush(150)

    // 1) 收藏声音行 → ✕ 取消收藏：POST /write {op:'like', on:false}，行消失
    const likeRow = panelHost.querySelector('.xmly-like-row')
    expect(likeRow).not.toBeNull()
    const unlikeBtn = likeRow.querySelector('button[title^="取消收藏"]')
    expect(unlikeBtn).not.toBeNull()
    click(unlikeBtn)
    await flush(150)
    const unlikeCall = writeCalls().find((c) => c.op === 'like')
    expect(unlikeCall).toMatchObject({ op: 'like', id: 9001, on: false })
    expect(panelHost.querySelector('.xmly-like-row')).toBeNull()

    // 2) 订阅分段 → 点卡片进专辑页 → 「📻 订阅」→ POST {op:'sub', on:true}，变「已订阅」
    click([...panelHost.querySelectorAll('button')].find((b) => (b.textContent || '').includes('订阅')))
    await flush(150)
    const subCard = panelHost.querySelector('.xmly-album-card')
    expect(subCard).not.toBeNull()
    click(subCard) // 打开专辑
    await flush(200)
    const subBtn = [...panelHost.querySelectorAll('.xmly-album-ops button')].find((b) => (b.textContent || '').includes('订阅'))
    expect(subBtn).not.toBeNull()
    expect(subBtn.textContent).not.toContain('已订阅')
    click(subBtn)
    await flush(150)
    const subCall = writeCalls().find((c) => c.op === 'sub' && c.on === true)
    expect(subCall).toMatchObject({ op: 'sub', id: 123, on: true })
    const subBtnAfter = [...panelHost.querySelectorAll('.xmly-album-ops button')].find((b) => (b.textContent || '').includes('订阅'))
    expect(subBtnAfter.textContent).toContain('已订阅')

    // 3) 回订阅分段 → 退订：POST {op:'sub', on:false}，原卡片消失
    click([...panelHost.querySelectorAll('button')].find((b) => (b.textContent || '') === '我的'))
    await flush(100)
    click([...panelHost.querySelectorAll('button')].find((b) => (b.textContent || '').includes('订阅')))
    await flush(150)
    const targetCard = [...panelHost.querySelectorAll('.xmly-album-card')].find((c) => (c.textContent || '').includes('订阅的测试专辑'))
    expect(targetCard).not.toBeNull()
    const unsubBtn = targetCard.querySelector('button[title^="退订"]')
    expect(unsubBtn).not.toBeNull()
    click(unsubBtn)
    await flush(150)
    const unsubCall = writeCalls().find((c) => c.op === 'sub' && c.on === false)
    expect(unsubCall).toMatchObject({ op: 'sub', id: 323366, on: false })
    expect([...panelHost.querySelectorAll('.xmly-album-card')].some((c) => (c.textContent || '').includes('订阅的测试专辑'))).toBe(false)

    // 4) 主播分段 → 取关：POST /write {op:'follow', on:false}，卡片消失
    click([...panelHost.querySelectorAll('button')].find((b) => (b.textContent || '').includes('主播')))
    await flush(150)
    const anchorCard = panelHost.querySelector('.xmly-anchor-card')
    expect(anchorCard).not.toBeNull()
    const unfollowBtn = anchorCard.querySelector('button[title^="取消关注"]')
    expect(unfollowBtn).not.toBeNull()
    click(unfollowBtn)
    await flush(150)
    const unfollowCall = writeCalls().find((c) => c.op === 'follow')
    expect(unfollowCall).toMatchObject({ op: 'follow', id: 170217760, on: false })
    expect(panelHost.querySelector('.xmly-anchor-card')).toBeNull()

    for (const c of effects) { try { c() } catch {} }
    barRoot.unmount()
    panelRoot.unmount()
  })
})
