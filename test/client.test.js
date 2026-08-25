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
// fetch stub：全部返回 ok 的空响应，避免测试触网。
global.fetch = vi.fn(async (url) => ({
  ok: true,
  json: async () => {
    if (String(url).includes('/manifest')) return { ok: true, loggedIn: false, user: null, favs: [], history: [], prefs: {}, playback: null }
    if (String(url).includes('/intent')) return { ok: true, intent: null }
    if (String(url).includes('/search')) return { ok: true, albums: [], total: 0, page: 1, totalPages: 1 }
    if (String(url).includes('/play')) return { ok: true, quality: '标准 64kbps M4A', streamUrl: '/dsh-ximalaya/stream?trackId=1' }
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
})
