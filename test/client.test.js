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
global.Audio = class {
  constructor() {
    this.volume = 1
    this.playbackRate = 1
    this.currentTime = 0
    this.duration = 0
    this.paused = true
    this.listeners = {}
    this.style = {}
  }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn) }
  removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter((f) => f !== fn) }
  play() { this.paused = false; return Promise.resolve() }
  pause() { this.paused = true }
  load() {}
  setAttribute() {}
  removeAttribute() {}
}
// fetch stub：全部返回 ok 的响应，避免测试触网。
global.fetch = vi.fn(async (url) => ({
  ok: true,
  json: async () => {
    const u = String(url)
    if (u.includes('/manifest')) return {
      ok: true, loggedIn: true,
      user: { uid: 42, nickname: '测试用户', isVip: false, vipExpireTime: 0, isLoginBan: false },
      favs: [], history: [], prefs: {}, playback: null,
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
})
