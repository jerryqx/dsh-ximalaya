/**
 * xmly.js 纯函数单元测试（不触网）：签名格式、解密算法、音质选择、cookie 工具。
 */
import { describe, it, expect } from 'vitest'
import {
  getXmSign,
  decryptUrl,
  normalizeEncBase64,
  selectBestPlay,
  responseCookies,
  joinCookieMap,
  userFollowing,
  likeTracks,
  mySubscriptions,
  anchorProfile,
  albumTracks,
  setSubscriptionAlbum,
  setLikeTrack,
  setFollow,
  XmlyError,
} from '../lib/xmly.js'

describe('getXmSign', () => {
  it('生成 "&&<base64url>_2" 格式的签名', () => {
    const sign = getXmSign()
    expect(sign.startsWith('&&')).toBe(true)
    expect(sign.endsWith('_2')).toBe(true)
    expect(sign.length).toBeGreaterThan(20)
  })
  it('每次生成都不同（随机 head）', () => {
    expect(getXmSign()).not.toBe(getXmSign())
  })
  it('签名主体是 base64url（无 +/= 字符）', () => {
    const sid = getXmSign().slice(2).slice(0, -2)
    expect(sid).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

describe('normalizeEncBase64', () => {
  it('URL-safe 字符替换为标准 base64 并补 padding', () => {
    expect(normalizeEncBase64('a-b_c')).toBe('a+b/c===')
    expect(normalizeEncBase64('abcd')).toBe('abcd')
    expect(normalizeEncBase64('abcdef')).toBe('abcdef==')
    expect(normalizeEncBase64('abcdefg')).toBe('abcdefg=')
    expect(normalizeEncBase64('abcdefgh')).toBe('abcdefgh')
  })
})

describe('decryptUrl', () => {
  it('空输入返回空串', () => {
    expect(decryptUrl('')).toBe('')
    expect(decryptUrl(null)).toBe('')
  })
  it('短输入（<16 字节）原样返回', () => {
    expect(decryptUrl('abcd')).toBe('abcd')
  })
  it('非 base64 输入不抛错', () => {
    expect(() => decryptUrl('!!!!不是base64!!!!')).not.toThrow()
  })
})

describe('selectBestPlay', () => {
  const mk = (type, url) => ({ type, url, qualityLevel: 1 })
  it('优先 M4A_128', () => {
    const list = [mk('MP3_32', 'u32'), mk('M4A_128', 'u128'), mk('MP3_64', 'u64')]
    expect(selectBestPlay(list).type).toBe('M4A_128')
  })
  it('其次 MP3_64，再次 MP3_32', () => {
    expect(selectBestPlay([mk('MP3_32', 'a'), mk('MP3_64', 'b')]).type).toBe('MP3_64')
    expect(selectBestPlay([mk('MP3_32', 'a')]).type).toBe('MP3_32')
  })
  it('未知类型取第一个有 url 的', () => {
    const list = [mk('AI_XXX', 'ai'), mk('M4A_128', '')]
    expect(selectBestPlay(list).type).toBe('AI_XXX')
  })
  it('空列表返回 null', () => {
    expect(selectBestPlay([])).toBeNull()
    expect(selectBestPlay(null)).toBeNull()
  })
})

describe('cookie 工具', () => {
  it('responseCookies 解析 set-cookie 列表', () => {
    const res = {
      headers: {
        getSetCookie: () => ['1&_token=abc123; Path=/; Domain=ximalaya.com', 'uid=42; Path=/', 'empty=; Path=/'],
      },
    }
    const cookies = responseCookies(res)
    expect(cookies['1&_token']).toBe('abc123')
    expect(cookies.uid).toBe('42')
  })
  it('joinCookieMap 拼接并过滤空值', () => {
    expect(joinCookieMap({ b: '2', a: '1', empty: '' })).toBe('a=1; b=2')
  })
})

describe('XmlyError', () => {
  it('携带 code 与 status', () => {
    const e = new XmlyError('需要登录', 'NEED_AUTH', 403)
    expect(e.message).toBe('需要登录')
    expect(e.code).toBe('NEED_AUTH')
    expect(e.status).toBe(403)
  })
})

describe('用户中心 API（参数校验，不触网）', () => {
  it('userFollowing 拒绝无效 uid', async () => {
    await expect(userFollowing(0)).rejects.toMatchObject({ code: 'BAD_REQUEST', status: 400 })
    await expect(userFollowing('abc')).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
  it('likeTracks 无 cookie 时直接 NEED_LOGIN（不触网）', async () => {
    await expect(likeTracks(1, 30, '')).rejects.toMatchObject({ code: 'NEED_LOGIN', status: 401 })
    await expect(likeTracks()).rejects.toMatchObject({ code: 'NEED_LOGIN' })
  })
  it('mySubscriptions 无 cookie 时直接 NEED_LOGIN（不触网）', async () => {
    await expect(mySubscriptions(1, 30, '')).rejects.toMatchObject({ code: 'NEED_LOGIN', status: 401 })
    await expect(mySubscriptions()).rejects.toMatchObject({ code: 'NEED_LOGIN' })
  })
  it('anchorProfile 拒绝无效 uid', async () => {
    await expect(anchorProfile(-1)).rejects.toMatchObject({ code: 'BAD_REQUEST', status: 400 })
    await expect(anchorProfile('x')).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
  it('albumTracks 拒绝无效 albumId（不触网）', async () => {
    await expect(albumTracks(0)).rejects.toMatchObject({ code: 'BAD_REQUEST', status: 400 })
    await expect(albumTracks('abc')).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})

describe('云端写 API（参数校验，不触网）', () => {
  it('setSubscriptionAlbum 无 cookie → NEED_LOGIN，无效 id → BAD_REQUEST', async () => {
    await expect(setSubscriptionAlbum(123, true, '')).rejects.toMatchObject({ code: 'NEED_LOGIN', status: 401 })
    await expect(setSubscriptionAlbum(0, true, 'a=b')).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(setSubscriptionAlbum('x', false, 'a=b')).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
  it('setLikeTrack 无 cookie → NEED_LOGIN，无效 id → BAD_REQUEST', async () => {
    await expect(setLikeTrack(1001, false)).rejects.toMatchObject({ code: 'NEED_LOGIN', status: 401 })
    await expect(setLikeTrack(-5, true, 'a=b')).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
  it('setFollow 无 cookie → NEED_LOGIN，无效 uid → BAD_REQUEST', async () => {
    await expect(setFollow(170217760, false, '')).rejects.toMatchObject({ code: 'NEED_LOGIN', status: 401 })
    await expect(setFollow('abc', true, 'a=b')).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})
