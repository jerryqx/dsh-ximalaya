/**
 * lib/xmly.js — 喜马拉雅「搜索 / 专辑 / 曲目 / 播放地址解析 / 扫码登录」底层模块。
 *
 * 纯 Node（Node ≥ 20，用全局 fetch），无第三方依赖，无编译步骤。
 * 端点均来自网页端/移动端公开接口（参考 RSSHub ximalaya 路由与社区下载器的实现）：
 *   - 搜索：www.ximalaya.com/revision/search（core=album|track，匿名可用）
 *   - 专辑信息：www.ximalaya.com/revision/album/v1/simple（匿名可用）
 *   - 曲目列表：mobile.ximalaya.com/mobile/v1/album/track（匿名可用）
 *   - 免费播放地址：m.ximalaya.com/tracks/{id}.json（play_path_64/32，匿名可用）
 *   - 登录态播放地址：www.ximalaya.com/mobile-playpage/track/v3/baseInfo（xm-sign + 1&_token，
 *     可解锁已购/VIP 曲目的加密地址，本地解密）
 *   - 扫码登录：passport.ximalaya.com/web/qrCode/gen + /web/qrCode/check/{qrId}/{ts}
 *
 * ⚠️ 合规：均为非官方接口，播放内容版权归喜马拉雅及权利方所有。仅限个人试听/学习使用，
 * 严禁商业用途、公开传播或二次分发，风险自担。
 */

import { createCipheriv, randomBytes } from 'node:crypto'
import { crc32 } from 'node:zlib'

export const UA_WEB =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
export const UA_TING = 'ting_6.7.9(GM1900,Android29)'
const BASE = 'https://www.ximalaya.com'
const BASE_MOBILE = 'https://mobile.ximalaya.com'
const BASE_M = 'https://m.ximalaya.com'
const BASE_PASSPORT = 'https://passport.ximalaya.com'

export class XmlyError extends Error {
  constructor(message, code = 'ERROR', status = 500) {
    super(message)
    this.name = 'XmlyError'
    this.code = code
    this.status = status
  }
}

// 统一超时（Node fetch 默认无超时，端点偶发挂起会让请求永久卡住）。
async function fetchWithTimeout(url, opts = {}, timeoutMs = 15000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function getJson(url, { headers = {}, timeoutMs = 15000 } = {}) {
  let res
  try {
    res = await fetchWithTimeout(url, {
      headers: { 'user-agent': UA_WEB, accept: 'application/json, text/plain, */*', ...headers },
      redirect: 'follow',
    }, timeoutMs)
  } catch (err) {
    throw new XmlyError('网络请求失败：' + String((err && err.message) || err), 'NETWORK', 502)
  }
  if (!res.ok) throw new XmlyError('接口 HTTP ' + res.status, 'HTTP_' + res.status, 502)
  let body
  try {
    body = await res.json()
  } catch {
    throw new XmlyError('接口返回非 JSON（可能被风控拦截）', 'BAD_JSON', 502)
  }
  return { res, body }
}

// =====================================================================
// xm-sign 生成（RSSHub lib/routes/ximalaya/utils.ts 的算法）。
// head = 8位随机hex + 4位随机hex + base62(当前时间戳) + '0202'，
// sid = AES-128-CBC(head + crc32hex(head), key=iv='y3hbnr8d4s2ztjbc'截16字节)，
// xm-sign = '&&' + base64url(sid) + '_2'。
// =====================================================================
const getRandom16 = (len) =>
  randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len)

const base62 = (num) => {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
  let out = ''
  do {
    out = chars[num % 62] + out
    num = Math.floor(num / 62)
  } while (num > 0)
  return out.padStart(8, '0')
}

export function getXmSign(now = Date.now()) {
  const head = `${getRandom16(8)}${getRandom16(4)}${base62(now)}0202`
  const key = Buffer.from('y3hbnr8d4s2ztjbca1wgxk6mqktf9pxr').subarray(0, 16)
  const cipher = createCipheriv('aes-128-cbc', key, key)
  const sid = Buffer.concat([
    cipher.update(head + crc32(head).toString(16).padStart(8, '0'), 'utf8'),
    cipher.final(),
  ]).toString('base64url')
  return `&&${sid}_2`
}

// =====================================================================
// 播放地址解密（www2 设备的 o/a 两张表；与 RSSHub decryptUrl / 社区下载器
// www2-decrypt.js 一致）：URL-safe base64 → 去 IV(末16字节) → S盒替换 →
// 每 16 字节与 IV 异或 → 每 32 字节与密钥表异或 → UTF-8 字符串。
// =====================================================================
const SBOX_O = [
  183, 174, 108, 16, 131, 159, 250, 5, 239, 110, 193, 202, 153, 137, 251, 176, 119, 150, 47, 204, 97, 237, 1, 71, 177, 42, 88, 218, 166, 82, 87, 94, 14, 195, 69, 127, 215, 240, 225, 197, 238, 142, 123, 44, 219, 50, 190, 29,
  181, 186, 169, 98, 139, 185, 152, 13, 141, 76, 6, 157, 200, 132, 182, 49, 20, 116, 136, 43, 155, 194, 101, 231, 162, 242, 151, 213, 53, 60, 26, 134, 211, 56, 28, 223, 107, 161, 199, 15, 229, 61, 96, 41, 66, 158, 254, 21, 165,
  253, 103, 89, 3, 168, 40, 246, 81, 95, 58, 31, 172, 78, 99, 45, 148, 187, 222, 124, 55, 203, 235, 64, 68, 149, 180, 35, 113, 207, 118, 111, 91, 38, 247, 214, 7, 212, 209, 189, 241, 18, 115, 173, 25, 236, 121, 249, 75, 57,
  216, 10, 175, 112, 234, 164, 70, 206, 198, 255, 140, 230, 12, 32, 83, 46, 245, 0, 62, 227, 72, 191, 156, 138, 248, 114, 220, 90, 84, 170, 128, 19, 24, 122, 146, 80, 39, 37, 8, 34, 22, 11, 93, 130, 63, 154, 244, 160, 144, 79,
  23, 133, 92, 54, 102, 210, 65, 67, 27, 196, 201, 106, 143, 52, 74, 100, 217, 179, 48, 233, 126, 117, 184, 226, 85, 171, 167, 86, 2, 147, 17, 135, 228, 252, 105, 30, 192, 129, 178, 120, 36, 145, 51, 163, 77, 205, 73, 4, 188,
  125, 232, 33, 243, 109, 224, 104, 208, 221, 59, 9,
]
const KEY_A = [
  204, 53, 135, 197, 39, 73, 58, 160, 79, 24, 12, 83, 180, 250, 101, 60, 206, 30, 10, 227, 36, 95, 161, 16, 135, 150, 235, 116, 242, 116, 165, 171,
]

export function normalizeEncBase64(s) {
  const core = String(s || '').replace(/_/g, '/').replace(/-/g, '+')
  const padding = '='.repeat((4 - (core.length % 4)) % 4)
  return core + padding
}

export function decryptUrl(encryptedUrl) {
  const text = String(encryptedUrl || '')
  if (text === '') return ''
  let encryptedData
  try {
    encryptedData = Buffer.from(normalizeEncBase64(text), 'base64')
  } catch {
    return ''
  }
  if (encryptedData.length < 16) return text
  const data = encryptedData.subarray(0, -16)
  const iv = encryptedData.subarray(-16)
  const out = new Uint8Array(data)
  for (let i = 0; i < out.length; i++) out[i] = SBOX_O[out[i]]
  for (let i = 0; i < out.length; i += 16) {
    const block = out.subarray(i, i + 16)
    for (let j = 0; j < block.length; j++) out[i + j] = block[j] ^ iv[j]
  }
  for (let i = 0; i < out.length; i += 32) {
    const block = out.subarray(i, i + 32)
    for (let j = 0; j < block.length; j++) out[i + j] = block[j] ^ KEY_A[j]
  }
  try {
    return Buffer.from(out).toString('utf8')
  } catch {
    return ''
  }
}

// 从 playUrlList 里挑最优音质：M4A_128 > MP3_64 > MP3_32 > 其它（AI 音频等取第一个）。
const QUALITY_ORDER = ['M4A_128', 'MP3_64', 'MP3_32']
export function selectBestPlay(playUrlList) {
  if (!Array.isArray(playUrlList) || playUrlList.length === 0) return null
  for (const want of QUALITY_ORDER) {
    const hit = playUrlList.find((p) => p && p.type === want && p.url)
    if (hit) return hit
  }
  const first = playUrlList.find((p) => p && p.url)
  return first || null
}

// =====================================================================
// Cookie 工具：QR 登录返回 set-cookie 列表 → 状态文件存键值对 → 请求时拼回 header。
// =====================================================================
export function responseCookies(res) {
  const out = {}
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  for (const c of list) {
    const p = c.split(';')[0]
    const i = p.indexOf('=')
    if (i < 0) continue
    out[p.slice(0, i).trim()] = p.slice(i + 1).trim()
  }
  return out
}
export function joinCookieMap(cookies) {
  return Object.keys(cookies)
    .filter((k) => k.trim() && cookies[k].trim())
    .sort()
    .map((k) => `${k}=${cookies[k]}`)
    .join('; ')
}

// =====================================================================
// 搜索（匿名可用）。
// =====================================================================
function normalizeCover(path) {
  if (typeof path !== 'string' || path === '') return ''
  const withScheme = path.startsWith('http') ? path : 'https:' + path
  return withScheme.split('!')[0]
}
function normalizeAlbumDoc(doc) {
  return {
    id: doc.id,
    title: String(doc.title || ''),
    intro: String(doc.intro || '').slice(0, 300),
    cover: normalizeCover(doc.cover_path),
    trackCount: doc.tracks || 0,
    anchorName: doc.nickname || '',
    anchorUrl: doc.anchorUrl || '',
    category: doc.category_title || '',
    isPaid: !!doc.is_paid,
    isFinished: doc.is_finished === 1 || doc.serialState === 1,
    playCount: doc.play || 0,
    createdAt: doc.created_at || 0,
    updatedAt: doc.updated_at || 0,
    tags: typeof doc.tags === 'string' ? doc.tags.split(',').filter(Boolean).slice(0, 6) : [],
  }
}
function normalizeTrackDoc(doc) {
  return {
    id: doc.id,
    title: String(doc.title || ''),
    intro: String(doc.intro || '').slice(0, 200),
    albumId: doc.album_id || 0,
    albumTitle: doc.album_title || '',
    cover: normalizeCover(doc.cover_path),
    duration: doc.duration || 0,
    playCount: doc.play || 0,
    isPaid: !!doc.is_paid,
    anchorName: doc.nickname || '',
    createdAt: doc.created_at || 0,
  }
}

export async function searchAlbums(kw, page = 1, rows = 20) {
  const q = String(kw || '').trim()
  if (q === '') throw new XmlyError('缺少搜索关键词', 'BAD_REQUEST', 400)
  const url = `${BASE}/revision/search?core=album&kw=${encodeURIComponent(q)}&page=${page}&rows=${rows}&spellchecker=true&condition=relation&device=web`
  const { body } = await getJson(url)
  if (body.ret !== 200) throw new XmlyError('喜马拉雅搜索失败：' + String(body.msg || body.ret), 'API_RET', 502)
  const resp = ((body.data || {}).result || {}).response || {}
  const docs = resp.docs || []
  return {
    albums: docs.map(normalizeAlbumDoc),
    total: resp.numFound || docs.length,
    page: resp.currentPage || page,
    totalPages: resp.totalPage || 1,
  }
}

export async function searchTracks(kw, page = 1, rows = 20) {
  const q = String(kw || '').trim()
  if (q === '') throw new XmlyError('缺少搜索关键词', 'BAD_REQUEST', 400)
  const url = `${BASE}/revision/search?core=track&kw=${encodeURIComponent(q)}&page=${page}&rows=${rows}&spellchecker=true&condition=relation&device=web`
  const { body } = await getJson(url)
  if (body.ret !== 200) throw new XmlyError('喜马拉雅搜索失败：' + String(body.msg || body.ret), 'API_RET', 502)
  const resp = ((body.data || {}).result || {}).response || {}
  const docs = resp.docs || []
  return {
    tracks: docs.map(normalizeTrackDoc),
    total: resp.numFound || docs.length,
    page: resp.currentPage || page,
    totalPages: resp.totalPage || 1,
  }
}

// =====================================================================
// 专辑信息与曲目列表（匿名可用）。
// =====================================================================
export async function albumSimple(albumId) {
  const id = Number(albumId)
  if (!Number.isInteger(id) || id <= 0) throw new XmlyError('无效的专辑 ID', 'BAD_REQUEST', 400)
  const { body } = await getJson(`${BASE}/revision/album/v1/simple?albumId=${id}`)
  if (body.ret !== 200) throw new XmlyError('获取专辑信息失败：' + String(body.msg || body.ret), 'API_RET', 502)
  const m = ((body.data || {}).albumPageMainInfo) || {}
  return {
    id,
    title: m.albumTitle || '',
    anchorName: m.anchorName || '',
    anchorUrl: m.anchorUrl || '',
    cover: normalizeCover(m.cover),
    category: m.categoryTitle || '',
    isPaid: !!m.isPaid,
    isFinished: m.isFinished === 1,
    intro: String(m.intro || m.richIntro || '').replace(/<[^>]+>/g, '').slice(0, 500),
    lastTrackTitle: m.lastTrackTitle || '',
    lastUptrackAt: m.lastUptrackAt || 0,
  }
}

function normalizeMobileTrack(t) {
  return {
    id: t.trackId,
    title: String(t.title || ''),
    duration: t.duration || 0,
    createdAt: t.createdAt || 0,
    isPaid: !!t.isPaid,
    isFree: !!t.isFree,
    isAuthorized: !!t.isAuthorized,
    playCount: t.playtimes || 0,
    comments: t.comments || 0,
    likes: t.likes || 0,
    orderNo: t.orderNo || 0,
    cover: normalizeCover(t.coverMiddle || t.coverLarge || t.coverSmall),
    anchorName: t.nickname || '',
    albumTitle: t.albumTitle || '',
    intro: String(t.intro || '').slice(0, 200),
  }
}

export async function albumTracks(albumId, pageId = 1, pageSize = 30) {
  const id = Number(albumId)
  if (!Number.isInteger(id) || id <= 0) throw new XmlyError('无效的专辑 ID', 'BAD_REQUEST', 400)
  const url = `${BASE_MOBILE}/mobile/v1/album/track/?albumId=${id}&pageSize=${pageSize}&pageId=${pageId}`
  const { body } = await getJson(url, { headers: { referer: `${BASE}/album/${id}` } })
  if (body.ret !== 0) throw new XmlyError('获取曲目列表失败：' + String(body.msg || body.ret), 'API_RET', 502)
  const data = body.data || {}
  const list = Array.isArray(data.list) ? data.list : []
  return {
    tracks: list.map(normalizeMobileTrack),
    maxPageId: data.maxPageId || 1,
    totalCount: data.totalCount || list.length,
    pageId: data.pageId || pageId,
  }
}

// =====================================================================
// 播放地址解析。
//   1) trackJson（匿名，免费曲直链，play_path_64/32 为 M4A/MP3 CDN 地址）
//   2) baseInfo（登录态 + xm-sign，可解锁已购/VIP 曲目，返回加密地址需本地解密）
// =====================================================================
export async function trackJson(trackId) {
  const id = Number(trackId)
  if (!Number.isInteger(id) || id <= 0) throw new XmlyError('无效的曲目 ID', 'BAD_REQUEST', 400)
  const { body } = await getJson(`${BASE_M}/tracks/${id}.json`, {
    headers: { referer: `${BASE_M}/sound/${id}` },
  })
  if (body.ret !== undefined && body.ret !== 0 && body.ret !== 200) {
    throw new XmlyError('曲目不存在或已下架（' + String(body.msg || body.ret) + '）', 'NOT_FOUND', 404)
  }
  return body
}

export async function trackBaseInfo(trackId, cookie) {
  const id = Number(trackId)
  if (!Number.isInteger(id) || id <= 0) throw new XmlyError('无效的曲目 ID', 'BAD_REQUEST', 400)
  const url = `${BASE}/mobile-playpage/track/v3/baseInfo/${Date.now()}?device=www2&trackQualityLevel=2&trackId=${id}`
  const headers = {
    'user-agent': UA_TING,
    referer: `${BASE}/sound/${id}`,
    'xm-sign': getXmSign(),
  }
  if (cookie) headers.cookie = cookie
  const { body } = await getJson(url, { headers })
  // ret=50 未登陆 / ret=1001 风控繁忙 / ret=-3 内容不存在
  if (body.ret === 1001) throw new XmlyError('喜马拉雅接口繁忙，请稍后重试', 'BUSY', 503)
  if (body.ret === -3) throw new XmlyError('该内容已不存在', 'NOT_FOUND', 404)
  if (body.ret === 50) throw new XmlyError('需要登录后才能获取该曲目（或登录态已过期）', 'NEED_LOGIN', 401)
  if (body.ret !== 0) throw new XmlyError('取链失败：' + String(body.msg || body.ret), 'API_RET', 502)
  const ti = body.trackInfo || {}
  return {
    title: ti.title || '',
    isAuthorized: !!ti.isAuthorized,
    playUrlList: Array.isArray(ti.playUrlList) ? ti.playUrlList : [],
    duration: ti.duration || 0,
  }
}

const QUALITY_LABEL = {
  M4A_128: '高音质 128kbps M4A',
  MP3_64: '标准 64kbps MP3',
  MP3_32: '流畅 32kbps MP3',
}

/**
 * 统一解析播放地址：优先登录态 baseInfo（已购/VIP 也放行），失败或未登录时
 * 回退匿名 trackJson（仅免费曲可用）。返回 { url, quality, source, title, duration }。
 */
export async function resolvePlay(trackId, cookie) {
  const id = Number(trackId)
  if (!Number.isInteger(id) || id <= 0) throw new XmlyError('无效的曲目 ID', 'BAD_REQUEST', 400)

  if (cookie) {
    try {
      const bi = await trackBaseInfo(id, cookie)
      if (bi.isAuthorized) {
        const pick = selectBestPlay(bi.playUrlList)
        if (pick) {
          const url = decryptUrl(pick.url)
          if (url.startsWith('http')) {
            return {
              url,
              quality: QUALITY_LABEL[pick.type] || pick.type,
              source: 'baseInfo',
              title: bi.title,
              duration: bi.duration,
            }
          }
        }
      }
    } catch (err) {
      if (err instanceof XmlyError && (err.code === 'NOT_FOUND')) throw err
      // 其它错误（未登录/繁忙/网络）→ 回退匿名直链
    }
  }

  const tj = await trackJson(id)
  const url = tj.play_path_64 || tj.play_path_32 || tj.play_path
  if (typeof url === 'string' && url.startsWith('http')) {
    return {
      url,
      quality: tj.play_path_64 ? '标准 64kbps M4A' : '流畅 32kbps MP3',
      source: 'trackJson',
      title: tj.title || '',
      duration: tj.duration || 0,
    }
  }
  throw new XmlyError(
    cookie ? '该曲目需要已购/VIP 权限（或账号未购买），无法免费播放' : '该曲目需要登录（或已购/VIP 权限）才能播放，请在面板扫码登录',
    'NEED_AUTH',
    403,
  )
}

// =====================================================================
// 扫码登录（喜马拉雅 App 扫码）与用户信息。
// =====================================================================
export async function qrCreate() {
  const { body } = await getJson(`${BASE_PASSPORT}/web/qrCode/gen?level=L&source=ximalaya-web`)
  if (body.ret !== 0) throw new XmlyError('生成登录二维码失败：' + String(body.msg || body.ret), 'API_RET', 502)
  if (!body.qrId || !body.img) throw new XmlyError('登录二维码数据异常', 'API_RET', 502)
  return { qrId: body.qrId, imageDataUrl: 'data:image/png;base64,' + body.img, expiresAt: Date.now() + 3 * 60 * 1000 }
}

export async function qrCheck(qrId) {
  const { res, body } = await getJson(`${BASE_PASSPORT}/web/qrCode/check/${encodeURIComponent(qrId)}/${Date.now()}`)
  if (body.ret !== 0) {
    // 常见状态：未扫码/已扫码未确认（继续轮询）；二维码过期重新生成。
    return { status: 'waiting', cookies: null }
  }
  const cookies = responseCookies(res)
  const token = cookies['1&_token'] || ''
  if (token === '') return { status: 'waiting', cookies: null }
  return { status: 'success', cookies, token }
}

export async function getCurrentUser(cookie) {
  if (!cookie) return null
  const { body } = await getJson(`${BASE}/revision/main/getCurrentUser`, {
    headers: { cookie, referer: BASE + '/' },
  })
  if (body.ret === 401) return null
  if (body.ret !== 200) return null
  const d = body.data || {}
  return {
    uid: d.uid || 0,
    nickname: d.nickname || '',
    isVip: !!d.isVip,
    vipExpireTime: d.vipExpireTime || 0,
    isLoginBan: !!d.isLoginBan,
  }
}

// =====================================================================
// 用户中心：已关注的主播 / 收藏（喜欢）的声音 / 主播公开专辑。
//   - 关注列表：/revision/user/following（匿名可用，需 uid；网页端
//     /zhubo/{uid}/follow 页同款接口）
//   - 收藏声音：/revision/my/getLikeTracks（需登录 cookie，网页端
//     /my/like「我喜欢的声音」页同款接口，like 即收藏 ♥）
//   - 主播专辑：/revision/user?uid=（匿名可用，返回该主播公开专辑概要）
// =====================================================================
function normalizeFollowingDoc(doc) {
  return {
    uid: doc.uid,
    nickname: doc.anchorNickName || '',
    cover: normalizeCover(doc.coverPath),
    description: String(doc.description || '').slice(0, 200),
    ptitle: doc.ptitle || '',
    albumCount: doc.albumCount || 0,
    trackCount: doc.trackCount || 0,
    fansCount: doc.followerCount || 0,
    followingCount: doc.followingCount || 0,
    isFollow: !!doc.isFollow,
    url: doc.url || '',
  }
}

export async function userFollowing(uid, page = 1, pageSize = 20) {
  const id = Number(uid)
  if (!Number.isInteger(id) || id <= 0) throw new XmlyError('无效的用户 ID', 'BAD_REQUEST', 400)
  const url = `${BASE}/revision/user/following?uid=${id}&page=${Math.max(1, page)}&pageSize=${Math.min(50, Math.max(1, pageSize))}`
  const { body } = await getJson(url)
  if (body.ret !== 200) throw new XmlyError('获取关注列表失败：' + String(body.msg || body.ret), 'API_RET', 502)
  const data = body.data || {}
  const list = Array.isArray(data.followingsPageInfo) ? data.followingsPageInfo : []
  return {
    anchors: list.map(normalizeFollowingDoc),
    total: data.totalCount || list.length,
    page: data.page || page,
    pageSize: data.pageSize || pageSize,
  }
}

function normalizeLikeDoc(doc) {
  // albumId 可能缺省：从 albumUrl（如 /album/12345）兜底解析。
  const albumIdFromUrl = Number((String(doc.albumUrl || '').match(/\/album\/(\d+)/) || [])[1] || 0)
  return {
    id: doc.trackId,
    title: doc.trackTitle || '',
    cover: normalizeCover(doc.trackCoverPath),
    duration: doc.length || doc.trackLength || 0, // 秒（可能缺省）
    durationText: doc.trackDuration || '', // 展示用字符串（如 "04:18"）
    albumId: doc.albumId || albumIdFromUrl,
    albumTitle: doc.albumName || '',
    anchorName: doc.anchorName || '',
    anchorId: doc.anchorId || 0,
    playCount: doc.trackPlayCount || 0,
    createdAtText: doc.trackCreateAtStr || '',
    isVideo: !!doc.isVideo,
    isPaid: !!doc.isPaid,
  }
}

export async function likeTracks(pageNum = 1, pageSize = 30, cookie) {
  if (!cookie) throw new XmlyError('需要登录后才能查看收藏的声音', 'NEED_LOGIN', 401)
  const url = `${BASE}/revision/my/getLikeTracks?pageNum=${Math.max(1, pageNum)}&pageSize=${Math.min(50, Math.max(1, pageSize))}`
  const { body } = await getJson(url, { headers: { cookie, referer: `${BASE}/my/like` } })
  if (body.ret === 401) throw new XmlyError('需要登录后才能查看收藏的声音（或登录态已过期）', 'NEED_LOGIN', 401)
  if (body.ret !== 200) throw new XmlyError('获取收藏的声音失败：' + String(body.msg || body.ret), 'API_RET', 502)
  const data = body.data || {}
  const list = Array.isArray(data.tracksList) ? data.tracksList : []
  const page = data.pageNum || pageNum
  const total = data.totalCount || list.length
  return {
    tracks: list.map(normalizeLikeDoc),
    total,
    pageNum: page,
    hasMore: typeof data.hasMore === 'boolean'
      ? data.hasMore
      : list.length > 0 && page * pageSize < total,
  }
}

function normalizePubAlbumDoc(doc) {
  return {
    id: doc.id,
    title: String(doc.title || ''),
    intro: String(doc.description || doc.subTitle || '').slice(0, 200),
    cover: normalizeCover(doc.coverPath),
    trackCount: doc.trackCount || 0,
    playCount: doc.playCount || 0,
    isPaid: !!doc.isPaid,
    isFinished: doc.isFinished === 1 || doc.isFinished === true,
    anchorName: doc.anchorNickName || '',
  }
}

export async function anchorProfile(uid) {
  const id = Number(uid)
  if (!Number.isInteger(id) || id <= 0) throw new XmlyError('无效的主播 ID', 'BAD_REQUEST', 400)
  const { body } = await getJson(`${BASE}/revision/user?uid=${id}`)
  if (body.ret !== 200) throw new XmlyError('获取主播信息失败：' + String(body.msg || body.ret), 'API_RET', 502)
  const data = body.data || {}
  const pub = data.pubPageInfo || {}
  const list = Array.isArray(pub.pubInfoList) ? pub.pubInfoList : []
  return {
    albums: list.slice(0, 60).map(normalizePubAlbumDoc),
    total: pub.totalCount || list.length,
  }
}
