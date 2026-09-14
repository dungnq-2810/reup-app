// Bộ tải đa nguồn (TikTok / Facebook / Douyin), port từ src/app/api/extract/route.ts
// của app VidScribe AI ở thư mục gốc — dùng chung cho web UI + bot Telegram.

import puppeteer, { executablePath } from 'puppeteer'
import crypto from 'crypto'
import path from 'path'
import { sanitizeCookiesForPuppeteer, saveErrorScreenshot } from './browserHandler.js'
import { ABogus } from './abogus.js'

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const MOBILE_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'

function extractFacebookVideoId(url) {
  try {
    const urlObj = new URL(url)
    const v = urlObj.searchParams.get('v')
    if (v) return v

    const pathParts = urlObj.pathname.split('/')
    for (let i = 0; i < pathParts.length; i++) {
      if (['videos', 'reel', 'watch', 'show'].includes(pathParts[i]) && pathParts[i + 1]) {
        const cleanId = pathParts[i + 1].replace(/[^0-9]/g, '')
        if (cleanId.match(/^\d+$/)) return cleanId
      }
    }
    const numericMatch = urlObj.pathname.match(/\/(\d{10,25})/)
    if (numericMatch) return numericMatch[1]
  } catch (e) {
    const numericMatch = url.match(/\/(\d{10,25})/)
    if (numericMatch) return numericMatch[1]
  }
  return null
}

async function resolveUrl(url) {
  let currentUrl = url
  const maxRedirects = 5

  for (let i = 0; i < maxRedirects; i++) {
    const isShort = currentUrl.includes('v.douyin.com') ||
      currentUrl.includes('vt.tiktok.com') ||
      currentUrl.includes('fb.watch') ||
      currentUrl.includes('fb.gg') ||
      currentUrl.includes('fb.me') ||
      currentUrl.includes('facebook.com/share') ||
      currentUrl.includes('t.co') ||
      currentUrl.includes('bit.ly')
    if (!isShort) break

    try {
      const res = await fetch(currentUrl, {
        method: 'GET',
        headers: { 'User-Agent': USER_AGENT },
        redirect: 'manual'
      })
      const location = res.headers.get('location')
      if (location) {
        if (location.startsWith('/')) {
          const parsed = new URL(currentUrl)
          currentUrl = `${parsed.protocol}//${parsed.host}${location}`
        } else {
          currentUrl = location
        }
      } else {
        break
      }
    } catch (err) {
      break
    }
  }
  return currentUrl
}

function cleanUrl(escapedUrl) {
  if (!escapedUrl) return ''
  return escapedUrl.replace(/\\\/|\\/g, '/')
}

async function extractFacebook(targetUrl) {
  let videoId = extractFacebookVideoId(targetUrl)
  let fbTargetUrl = targetUrl

  if (!videoId || targetUrl.includes('/share/')) {
    const res = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'User-Agent': MOBILE_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    })
    if (res.ok) {
      const html1 = await res.text()
      const ogUrl = html1.match(/<meta\s+property=["']og:url["']\s+content=["'](https?:.*?)["']/i)
      if (ogUrl) {
        fbTargetUrl = ogUrl[1]
        videoId = extractFacebookVideoId(fbTargetUrl)
      }
    }
  }

  if (!videoId) {
    throw new Error('Không thể tìm thấy ID video từ đường dẫn Facebook này.')
  }

  const watchUrl = `https://www.facebook.com/watch/?v=${videoId}`
  const fbResponse = await fetch(watchUrl, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'en-US,en;q=0.9',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
    }
  })
  if (!fbResponse.ok) {
    throw new Error(`Lỗi kết nối Facebook: Status ${fbResponse.status}`)
  }

  const html = await fbResponse.text()

  const hdMatch = html.match(/browser_native_hd_url["']:\s*["'](https?:.*?)(["'])/)
  const sdMatch = html.match(/browser_native_sd_url["']:\s*["'](https?:.*?)(["'])/)
  const playableHd = html.match(/"playable_url_quality_hd"["']:\s*["'](https?:.*?)(["'])/)
  const playableSd = html.match(/"playable_url"["']:\s*["'](https?:.*?)(["'])/)

  const rawHdUrl = hdMatch ? hdMatch[1] : playableHd ? playableHd[1] : null
  const rawSdUrl = sdMatch ? sdMatch[1] : playableSd ? playableSd[1] : null

  const hdUrl = rawHdUrl ? cleanUrl(rawHdUrl) : null
  const sdUrl = rawSdUrl ? cleanUrl(rawSdUrl) : null
  const video_url = hdUrl || sdUrl
  if (!video_url) {
    throw new Error('Không thể tìm thấy liên kết tải video Facebook. Hãy chắc chắn đó là video công khai.')
  }

  const ogTitle = html.match(/<meta\s+property=["']og:title["']\s+content=["'](.*?)["']/i) || html.match(/<title>(.*?)<\/title>/i)
  let title = ogTitle ? ogTitle[1] : 'Facebook Video'
  title = title
    .replace(/&#xb7;/g, '·')
    .replace(/&#064;/g, '@')
    .replace(/&#039;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')

  const ogImage = html.match(/<meta\s+property=["']og:image["']\s+content=["'](.*?)["']/i)
  const cover = ogImage ? cleanUrl(ogImage[1]).replace(/&amp;/g, '&') : null

  const qualities = []
  if (hdUrl) {
    qualities.push({
      id: 'hd',
      label: 'Bản HD (Chất lượng xịn nhất)',
      resolution: 'HD 720p/1080p',
      url: hdUrl,
      isBest: true
    })
  }
  if (sdUrl && sdUrl !== hdUrl) {
    qualities.push({
      id: 'sd',
      label: 'Bản SD (Tiêu chuẩn)',
      resolution: 'SD',
      url: sdUrl,
      isBest: !hdUrl
    })
  }

  return {
    platform: 'facebook',
    id: videoId,
    title,
    video_url,
    cover,
    duration: null,
    author: { nickname: 'Facebook Video', unique_id: videoId, avatar: null },
    music: null,
    qualities,
    is_images: false,
    images: []
  }
}

export function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return ''
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

// Bóc tách chất lượng gốc siêu nét qua SnapTikTok engine — lấy bản _original.mp4 không nén
// dung lượng cao gấp nhiều lần bản thường (lên tới 200MB+ Full HD), không watermark cho cả Douyin & TikTok.
async function extractViaSnapTikTok(targetUrl, platform) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 12000)

  try {
    const res = await fetch('https://snaptiktok.to/api/ajaxSearch', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'User-Agent': USER_AGENT,
        'Referer': 'https://snaptiktok.to/vi/douyin-downloader'
      },
      body: `q=${encodeURIComponent(targetUrl)}&lang=vi`,
      signal: controller.signal
    })

    if (!res.ok) return null
    const json = await res.json()
    if (json.status !== 'ok' || !json.data) return null

    const html = json.data

    // Extract Title
    const titleMatch = html.match(/<h3>(.*?)<\/h3>/s)
    let title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : ''
    title = title
      .replace(/&#x1F\w+;/g, '')
      .replace(/&#xb7;/g, '·')
      .replace(/&#064;/g, '@')
      .replace(/&#039;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')

    // Extract Duration
    const durMatch = html.match(/<p>(\d+:\d+)<\/p>/)
    let duration = null
    if (durMatch) {
      const parts = durMatch[1].split(':')
      duration = parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10)
    }

    // Extract Thumbnail / Cover
    const thumbMatch = html.match(/<div class="image-tik">\s*<img src="([^"]+)"/)
    const cover = thumbMatch ? thumbMatch[1].replace(/&amp;/g, '&') : null

    // Extract TikTokId or video ID
    const idMatch = html.match(/id="TikTokId"\s+value="([^"]+)"/)
    const id = idMatch ? idMatch[1] : (targetUrl.match(/\d{15,22}/)?.[0] || 'video')

    // Parse links
    const linkMatches = [...html.matchAll(/<a[^>]*class="[^"]*button[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gs)]

    let bestVideoUrl = null
    let musicUrl = null
    const qualities = []

    for (const m of linkMatches) {
      const rawHref = m[1]
      const labelText = m[2].replace(/<[^>]+>/g, '').trim()

      let directUrl = rawHref
      let filename = ''
      if (rawHref.includes('token=')) {
        try {
          const token = new URL(rawHref).searchParams.get('token')
          const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString())
          directUrl = payload.url || directUrl
          filename = payload.filename || ''
        } catch (_) {}
      }

      if (!directUrl || directUrl === '/' || directUrl.startsWith('#')) continue

      if (labelText.toLowerCase().includes('mp3')) {
        musicUrl = directUrl
      } else {
        const isHd = labelText.toLowerCase().includes('hd') || directUrl.includes('_original.mp4')

        qualities.push({
          id: isHd ? 'hd' : `sd_${qualities.length + 1}`,
          label: isHd ? 'Bản Gốc HD (Chất lượng xịn nhất)' : labelText,
          resolution: isHd ? '1080p / Gốc Master' : 'Tiêu chuẩn',
          url: directUrl,
          isBest: false
        })

        if (isHd) {
          bestVideoUrl = directUrl
        } else if (!bestVideoUrl) {
          bestVideoUrl = directUrl
        }
      }
    }

    for (const q of qualities) {
      if (q.url === bestVideoUrl) {
        q.isBest = true
        break
      }
    }

    if (!bestVideoUrl && qualities.length > 0) {
      bestVideoUrl = qualities[0].url
      qualities[0].isBest = true
    }

    if (!bestVideoUrl) return null

    return {
      platform: platform || (targetUrl.includes('douyin') ? 'douyin' : 'tiktok'),
      id,
      title: title || 'Video tải về',
      video_url: bestVideoUrl,
      cover,
      duration,
      author: { nickname: 'Tác giả', unique_id: id, avatar: cover },
      music: musicUrl ? { title: 'Nhạc nền gốc', author: '', play_url: musicUrl } : null,
      qualities,
      is_images: false,
      images: []
    }
  } catch (err) {
    console.warn(`[extractor] SnapTikTok engine warning: ${err.message}`)
    return null
  } finally {
    clearTimeout(timeoutId)
  }
}

// tikwm.com re-encode lại video qua server của họ nên luôn nén hơn bản gốc TikTok — và field
// "hdplay" của tikwm nhiều khi còn là 1 luồng adaptive-bitrate bị nén NHIỀU HƠN "play" dù tên
// nghe như tốt hơn (đã kiểm chứng: hdplay có bitrate/dung lượng thấp hơn play). Dùng làm phương
// án dự phòng cuối cùng khi lấy trực tiếp từ TikTok (extractTikTokDirect) thất bại.
async function extractTikTokViaTikwm(targetUrl) {
  const tikwmApiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(targetUrl)}&hd=1`
  const tikwmResponse = await fetch(tikwmApiUrl, {
    method: 'GET',
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }
  })
  if (!tikwmResponse.ok) {
    throw new Error(`Lỗi kết nối API TikTok: Status ${tikwmResponse.status}`)
  }

  const data = await tikwmResponse.json()
  if (data.code !== 0) {
    throw new Error(data.msg || 'Không thể tải thông tin video TikTok này.')
  }

  const videoData = data.data || {}
  const isImages = !!(videoData.images && videoData.images.length > 0)
  const images = isImages ? videoData.images : []

  const hasHd = !!videoData.hdplay
  const sizeHd = videoData.hd_size || 0
  const sizeNormal = videoData.size || 0

  // Ưu tiên bản có dung lượng lớn hơn giữa hdplay và play
  const bestVideoUrl = (hasHd && sizeHd >= sizeNormal) ? videoData.hdplay : (videoData.play || videoData.hdplay)

  const qualities = []
  if (videoData.hdplay) {
    qualities.push({
      id: 'hd',
      label: 'HD Không logo (Chất lượng xịn nhất)',
      resolution: 'HD',
      size: sizeHd || null,
      sizeFormatted: formatBytes(sizeHd),
      url: videoData.hdplay,
      isBest: bestVideoUrl === videoData.hdplay
    })
  }
  if (videoData.play) {
    qualities.push({
      id: 'play',
      label: 'Bản gốc Không logo',
      resolution: 'SD / Original',
      size: sizeNormal || null,
      sizeFormatted: formatBytes(sizeNormal),
      url: videoData.play,
      isBest: bestVideoUrl === videoData.play
    })
  }
  if (videoData.wmplay) {
    qualities.push({
      id: 'wmplay',
      label: 'Bản có Watermark gốc',
      resolution: 'Watermarked',
      url: videoData.wmplay,
      isBest: false
    })
  }

  const author = videoData.author ? {
    nickname: videoData.author.nickname || '',
    unique_id: videoData.author.unique_id || '',
    avatar: videoData.author.avatar || ''
  } : null

  const music = videoData.music_info ? {
    title: videoData.music_info.title || videoData.music || '',
    author: videoData.music_info.author || '',
    play_url: videoData.music_info.play || ''
  } : null

  return {
    platform: 'tiktok',
    id: String(videoData.id),
    title: videoData.title || 'Untitled TikTok Video',
    video_url: bestVideoUrl,
    cover: videoData.cover || videoData.origin_cover || null,
    duration: videoData.duration || null,
    author,
    music,
    qualities,
    is_images: isImages,
    images
  }
}

// TikTok chặn fetch thường bằng trang thử thách WAF ("Please wait...") nên phải mở Chrome thật
// (giống hệt cách extractDouyin xử lý Douyin) để trang tự vượt qua thử thách rồi đọc dữ liệu
// nhúng sẵn trong HTML đã render — script #__UNIVERSAL_DATA_FOR_REHYDRATION__ chứa
// itemStruct.video.bitrateInfo: danh sách MỌI mức chất lượng kèm link CDN gốc của TikTok, không
// qua re-encode trung gian nào. Chọn đúng phần tử có Bitrate (bit/s) cao nhất — KHÔNG dựa vào
// tên gear (vd "adapt_lowest_1080_1" có thể có bitrate thấp hơn "normal_540_0").
async function fetchTikTokItemStruct(targetUrl, cookies) {
  const browser = await puppeteer.launch({
    executablePath: executablePath('chrome'),
    headless: 'new',
    args: ['--no-sandbox', '--mute-audio']
  })

  try {
    const page = await browser.newPage()
    await page.setUserAgent(USER_AGENT)

    // Inject cookie nguồn TikTok nếu có — tránh WAF challenge hoặc trang yêu cầu đăng nhập.
    if (Array.isArray(cookies) && cookies.length > 0) {
      const tiktokCookies = cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain || '.tiktok.com',
        path: c.path || '/',
        httpOnly: c.httpOnly || false,
        secure: c.secure || true,
        sameSite: c.sameSite === 'no_restriction' ? 'None' : (c.sameSite || 'Lax')
      }))
      await page.setCookie(...tiktokCookies)
    }

    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {})

    await page
      .waitForSelector('#__UNIVERSAL_DATA_FOR_REHYDRATION__', { timeout: 20000 })
      .catch(() => {})

    const rehydration = await page.evaluate(() => {
      const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__')
      return el ? el.textContent : null
    })
    if (!rehydration) return null

    const data = JSON.parse(rehydration)
    const detail = data?.__DEFAULT_SCOPE__?.['webapp.video-detail']
    const itemStruct = detail?.itemInfo?.itemStruct
    if (!itemStruct) return null

    // Link CDN gốc (v16-webapp-prime.tiktok.com) bị Akamai chặn 403 nếu tải mà không kèm cookie
    // phiên vừa mở trang này — kể cả fetch ngay trong chính trang TikTok cũng bị chặn (khác
    // origin với domain CDN), nên phải lấy cookie ra để dùng lại khi tải file thật ở nơi khác
    // (xem lib/videos.js).
    const cookies = await page.cookies()
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ')

    return { itemStruct, cookieHeader }
  } finally {
    await browser.close()
  }
}

async function extractTikTokDirect(targetUrl, cookies) {
  let result = await fetchTikTokItemStruct(targetUrl, cookies)
  if (!result) {
    // Thử lại 1 lần với phiên trình duyệt mới — hay gặp trang thử thách WAF lần đầu rồi qua
    // được ngay lần sau, giống hệt Douyin.
    result = await fetchTikTokItemStruct(targetUrl, cookies)
  }
  if (!result) return null
  const { itemStruct, cookieHeader } = result

  const video = itemStruct.video || {}
  const bitrateInfo = video.bitrateInfo || []
  const sortedBitrates = [...bitrateInfo].sort((a, b) => (b.Bitrate || 0) - (a.Bitrate || 0))
  const bestBitrate = sortedBitrates[0] || null
  const video_url = bestBitrate?.PlayAddr?.UrlList?.[0] || video.playAddr || video.downloadAddr || null
  if (!video_url) return null

  const qualities = []
  for (const br of sortedBitrates) {
    const playUrl = br.PlayAddr?.UrlList?.[0]
    if (!playUrl) continue
    const height = br.PlayAddr?.Height || br.QualityType || ''
    const width = br.PlayAddr?.Width || ''
    const res = height ? `${width ? width + 'x' : ''}${height}p` : (br.GearName || 'HD')
    const size = br.PlayAddr?.DataSize || null
    qualities.push({
      id: br.GearName || String(br.Bitrate),
      label: `${res} ${br.CodecType ? `(${br.CodecType})` : ''}`,
      resolution: res,
      bitrate: br.Bitrate,
      size,
      sizeFormatted: formatBytes(size),
      url: cleanUrl(playUrl),
      isBest: qualities.length === 0
    })
  }

  const author = itemStruct.author ? {
    nickname: itemStruct.author.nickname || itemStruct.author.uniqueId || '',
    unique_id: itemStruct.author.uniqueId || '',
    avatar: itemStruct.author.avatarThumb || itemStruct.author.avatarMedium || ''
  } : null

  const music = itemStruct.music ? {
    title: itemStruct.music.title || '',
    author: itemStruct.music.authorName || '',
    play_url: itemStruct.music.playUrl || ''
  } : null

  return {
    platform: 'tiktok',
    id: String(itemStruct.id || video.id || ''),
    title: itemStruct.desc || 'Untitled TikTok Video',
    video_url: cleanUrl(video_url),
    cover: video.cover || video.originCover || null,
    duration: video.duration || null,
    author,
    music,
    qualities,
    cookie_header: cookieHeader || undefined,
    is_images: false,
    images: []
  }
}

async function extractTikTok(targetUrl, cookies) {
  // 1. Ưu tiên SnapTikTok engine để lấy bản gốc master không nén (_original.mp4 lên tới 200MB+ 1080p)
  try {
    const snap = await extractViaSnapTikTok(targetUrl, 'tiktok')
    if (snap && snap.video_url) return snap
  } catch (err) {
    // fallback tiếp
  }

  // 2. Thử bóc tách trực tiếp bằng Puppeteer
  try {
    const direct = await extractTikTokDirect(targetUrl, cookies)
    if (direct) return direct
  } catch (err) {
    // trang đổi cấu trúc / video ảnh (slideshow) / lỗi parse — rơi xuống tikwm bên dưới
  }

  // 3. Dự phòng qua TikWM
  return extractTikTokViaTikwm(targetUrl)
}

// Douyin đã siết chống scraping: trang share (iesdouyin.com/share/video) không còn nhúng sẵn
// dữ liệu trong HTML, còn trang chính (douyin.com/video) chỉ trả dữ liệu qua API
// /aweme/v1/web/aweme/detail/ có ký tên a_bogus sinh từ JS làm rối của họ — fetch thường không
// tạo được chữ ký này. Phải mở Chrome thật (Puppeteer, đã là dependency sẵn có của project) để
// trang tự gọi API đó rồi bắt lấy response.
// Douyin thỉnh thoảng trả 403 ngay ở lần gọi /aweme/v1/web/aweme/detail/ đầu tiên (chặn tạm do
// gọi liên tục) rồi tự thử lại và thành công ngay sau đó — nên phải đợi response nào thực sự
async function fetchDouyinDetail(awemeId, urlKind, cookies) {
  const browser = await puppeteer.launch({
    executablePath: executablePath('chrome'),
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--mute-audio',
      '--window-size=1920,1080'
    ]
  })

  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1920, height: 1080 })
    await page.setUserAgent(USER_AGENT)
    await page.setExtraHTTPHeaders({
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8'
    })

    // Xoá dấu vết automation để tránh bị Douyin chặn/yêu cầu giải captcha
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
      Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en-US', 'en'] })
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] })
      window.chrome = { runtime: {} }
    })

    // Inject cookie nguồn trước khi mở trang — Douyin không serve dữ liệu video nếu chưa đăng nhập
    // (hay trả trang login/captcha thay vì gọi API /aweme/v1/web/aweme/detail/). Cookie phải inject
    // TRƯỚC goto() vì Douyin kiểm tra ngay khi load, không kịp set sau.
    if (Array.isArray(cookies) && cookies.length > 0) {
      try {
        const sanitized = sanitizeCookiesForPuppeteer(cookies).map((c) => ({
          ...c,
          domain: c.domain?.includes('douyin.com') ? c.domain : '.douyin.com'
        }))
        if (sanitized.length > 0) {
          await page.setCookie(...sanitized)
        }
      } catch (err) {
        console.warn(`[extractor] Không inject được cookie Douyin: ${err.message}`)
      }
    }

    const detailPromise = new Promise((resolve) => {
      const onResponse = async (res) => {
        const url = res.url()
        if (!url.includes('/aweme/v1/web/aweme/detail/')) return
        try {
          const json = await res.json()
          if (json && json.aweme_detail) {
            page.off('response', onResponse)
            resolve(json.aweme_detail)
          } else {
            console.warn(
              `[extractor] Douyin API trả về (status ${res.status()}) nhưng không có aweme_detail. code: ${json?.status_code}`
            )
          }
        } catch (e) {
          // response lỗi/không parse được (vd. 403 chặn tạm) — bỏ qua, chờ lần gọi lại tiếp theo
        }
      }
      page.on('response', onResponse)
    })

    // Bài dạng ảnh (album) dùng route /note/<id> thay vì /video/<id> — vào đúng route gốc,
    // không cứng /video/ cho mọi loại, để Douyin render đúng component (và vẫn gọi cùng 1 API
    // /aweme/v1/web/aweme/detail/ để lấy chi tiết) thay vì trả trang lỗi/redirect lạ.
    await page
      .goto(`https://www.douyin.com/${urlKind}/${awemeId}`, { waitUntil: 'domcontentloaded', timeout: 35000 })
      .catch((err) => {
        console.warn(`[extractor] Douyin goto (${urlKind}/${awemeId}): ${err.message}`)
      })

    const detail = await Promise.race([
      detailPromise,
      new Promise((resolve) => setTimeout(() => resolve(null), 30000))
    ])

    let screenshotPath = null
    if (!detail) {
      try {
        screenshotPath = await saveErrorScreenshot(page, `douyin-${awemeId}`)
      } catch (err) {
        // ignore error saving screenshot
      }
    }

    return { detail, screenshotPath }
  } finally {
    await browser.close()
  }
}

function genFalseMsToken() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let token = ''
  for (let i = 0; i < 182; i++) {
    token += chars[Math.floor(Math.random() * chars.length)]
  }
  return token + '=='
}

// Bóc tách nhanh dữ liệu video Douyin bằng cách gọi trực tiếp API /aweme/v1/web/aweme/detail/
// kèm chữ ký a_bogus (100% JS thuần), không cần mở trình duyệt Chrome tốn tài nguyên.
async function fetchDouyinDetailDirect(awemeId, cookies) {
  let cookieHeader = ''
  let msToken = ''

  if (Array.isArray(cookies) && cookies.length > 0) {
    cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ')
    const ms = cookies.find((c) => c.name === 'msToken')
    if (ms) msToken = ms.value
  } else if (typeof cookies === 'string' && cookies.trim()) {
    cookieHeader = cookies
    const m = cookies.match(/msToken=([^;]+)/)
    if (m) msToken = m[1]
  }

  if (!msToken) {
    msToken = genFalseMsToken()
  }

  // aid=6383 ưu tiên cho cả video & album ảnh (/note); aid=1128 dự phòng cho một số video
  const aidCandidates = ['6383', '1128']

  for (const aid of aidCandidates) {
    const paramsObj = {
      device_platform: 'webapp',
      aid,
      channel: 'channel_pc_web',
      aweme_id: awemeId,
      update_version_code: '170400',
      pc_client_type: '1',
      pc_libra_divert: 'Windows',
      version_code: '290100',
      version_name: '29.1.0',
      cookie_enabled: 'true',
      screen_width: '1920',
      screen_height: '1080',
      browser_language: 'zh-CN',
      browser_platform: 'Win32',
      browser_name: 'Edge',
      browser_version: '131.0.0.0',
      browser_online: 'true',
      engine_name: 'Blink',
      engine_version: '131.0.0.0',
      os_name: 'Windows',
      os_version: '10',
      cpu_core_num: '16',
      device_memory: '8',
      platform: 'PC',
      downlink: '10',
      effective_type: '4g',
      round_trip_time: '50',
      support_h265: '1',
      support_dash: '1',
      msToken
    }

    const query = new URLSearchParams(paramsObj).toString()
    const ab = new ABogus({ userAgent: USER_AGENT })
    const [signedQuery] = ab.generateABogus(query)

    const url = `https://www.douyin.com/aweme/v1/web/aweme/detail/?${signedQuery}`

    try {
      const headers = {
        'User-Agent': USER_AGENT,
        Referer: 'https://www.douyin.com/',
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
      }
      if (cookieHeader) {
        headers.Cookie = cookieHeader
      }

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 8000)

      const res = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal
      })
      clearTimeout(timeoutId)

      if (!res.ok) {
        continue
      }

      const data = await res.json()
      if (data && data.aweme_detail) {
        return data.aweme_detail
      }

      // Nếu bị lọc theo aid (vd images_base), thử tiếp với aid khác
      if (data?.filter_detail?.filter_reason) {
        console.log(`[extractor] Aweme ${awemeId} bị lọc với aid=${aid} (${data.filter_detail.filter_reason}), thử aid tiếp theo...`)
        continue
      }
    } catch (err) {
      console.warn(`[extractor] Lỗi gọi API trực tiếp Douyin (aid=${aid}): ${err.message}`)
    }
  }

  return null
}

async function extractDouyin(targetUrl, cookies) {
  // 1. Ưu tiên SnapTikTok engine để lấy bản Douyin Full HD không watermark siêu tốc
  try {
    const snap = await extractViaSnapTikTok(targetUrl, 'douyin')
    if (snap && snap.video_url) return snap
  } catch (err) {
    // fallback tiếp
  }

  let awemeId = ''
  let urlKind = 'video'
  const pureIdMatch = targetUrl.match(/^\d{15,20}$/)
  if (pureIdMatch) {
    awemeId = targetUrl
  } else {
    // /note/<id> = bài dạng ảnh (album/slideshow), /video/<id> = bài dạng video — cả 2 đều có
    // thể tới qua link chia sẻ rút gọn /share/<kind>/<id>.
    const match =
      targetUrl.match(/\/(video|note)\/(\d+)/) || targetUrl.match(/\/share\/(video|note)\/(\d+)/)
    if (match) {
      urlKind = match[1]
      awemeId = match[2]
    }
  }
  if (!awemeId) {
    throw new Error('Không thể trích xuất ID video/ảnh Douyin.')
  }

  // BƯỚC 1: Ưu tiên bóc tách trực tiếp bằng HTTP API + chữ ký a_bogus (chỉ mất ~0.3s, không tốn RAM)
  let detail = null
  try {
    detail = await fetchDouyinDetailDirect(awemeId, cookies)
    if (detail) {
      console.log(`[extractor] Đã lấy video Douyin (${awemeId}) siêu tốc qua HTTP API`)
    }
  } catch (err) {
    console.warn(`[extractor] Lỗi gọi nhanh Douyin direct API: ${err.message}`)
  }

  // BƯỚC 2: Nếu trực tiếp không lấy được (dính WAF, thiếu cookie hoặc yêu cầu captcha), fallback sang Puppeteer
  if (!detail) {
    console.log(`[extractor] Direct API chưa lấy được, chuyển sang mở Chrome Puppeteer cho Douyin (${awemeId})...`)
    let { detail: pupDetail, screenshotPath } = await fetchDouyinDetail(awemeId, urlKind, cookies)
    detail = pupDetail
    let lastShot = screenshotPath

    if (!detail && Array.isArray(cookies) && cookies.length > 0) {
      // Nếu lượt đầu có cookie bị chặn/hết hạn/bắt captcha -> thử lại 1 lần với session sạch không cookie
      console.log('[extractor] Thử lại tải Douyin với session mới (không cookie)...')
      const res = await fetchDouyinDetail(awemeId, urlKind, null)
      detail = res.detail
      if (res.screenshotPath) lastShot = res.screenshotPath
    } else if (!detail) {
      // Thử lại 1 lần với phiên trình duyệt mới — hay gặp chặn tạm thời do anti-bot của Douyin.
      console.log('[extractor] Thử lại tải Douyin lượt 2...')
      const res = await fetchDouyinDetail(awemeId, urlKind, cookies)
      detail = res.detail
      if (res.screenshotPath) lastShot = res.screenshotPath
    }

    if (!detail) {
      const shotMsg = lastShot ? ` — xem ảnh lỗi: ${path.basename(lastShot)}` : ''
      const err = new Error(`Không lấy được dữ liệu video Douyin (có thể bị chặn tạm thời hoặc video đã bị xóa).${shotMsg}`)
      err.screenshotPath = lastShot
      throw err
    }
  }

  const videoData = detail.video || {}
  // bit_rate liệt kê nhiều mức chất lượng — sắp xếp giảm dần theo data_size và bit_rate để lấy bản xịn nhất
  const bitRateList = videoData.bit_rate || []
  const sortedBitrates = [...bitRateList].sort((a, b) => {
    const sizeB = b.play_addr?.data_size || 0
    const sizeA = a.play_addr?.data_size || 0
    const rateB = b.bit_rate || 0
    const rateA = a.bit_rate || 0
    return (sizeB - sizeA) || (rateB - rateA)
  })
  const bestBitRate = sortedBitrates[0] || null
  const bestUrlList = (bestBitRate && bestBitRate.play_addr && bestBitRate.play_addr.url_list) || []
  const fallbackUrlList = (videoData.play_addr && videoData.play_addr.url_list) || []
  const rawVideoUrl = bestUrlList[0] || fallbackUrlList[0] || null
  const video_url = rawVideoUrl ? cleanUrl(rawVideoUrl).replace('/playwm/', '/play/') : null

  const qualities = []
  for (const br of sortedBitrates) {
    const rawUrl = br.play_addr?.url_list?.[0]
    if (!rawUrl) continue
    const qUrl = cleanUrl(rawUrl).replace('/playwm/', '/play/')
    const height = br.play_addr?.height
    const width = br.play_addr?.width
    const resLabel = height ? `${height}p` : br.gear_name ? br.gear_name.replace(/_/g, ' ') : 'HD'
    const codecLabel = br.is_h265 ? 'H.265' : 'H.264'
    const size = br.play_addr?.data_size || null
    qualities.push({
      id: br.gear_name || String(br.bit_rate),
      label: `${resLabel} (${codecLabel})`,
      resolution: height ? `${width ? width + 'x' : ''}${height}p` : resLabel,
      bitrate: br.bit_rate,
      size,
      sizeFormatted: formatBytes(size),
      url: qUrl,
      is_h265: !!br.is_h265,
      isBest: qualities.length === 0
    })
  }

  const images = []
  const imgList = detail.images || []
  for (const img of imgList) {
    const imgUrl = (img.download_url_list && img.download_url_list[0]) || (img.url_list && img.url_list[0])
    if (imgUrl) images.push(cleanUrl(imgUrl))
  }

  const author = detail.author ? {
    nickname: detail.author.nickname || '',
    unique_id: detail.author.unique_id || detail.author.short_id || '',
    avatar: detail.author.avatar_thumb?.url_list?.[0] || detail.author.avatar_medium?.url_list?.[0] || ''
  } : null

  const music = detail.music ? {
    title: detail.music.title || '',
    author: detail.music.author || '',
    play_url: detail.music.play_url?.url_list?.[0] || ''
  } : null

  return {
    platform: 'douyin',
    id: awemeId,
    title: detail.desc || 'Video Douyin',
    video_url,
    cover: videoData.cover?.url_list?.[0] || videoData.origin_cover?.url_list?.[0] || null,
    duration: detail.duration ? Math.round(detail.duration / 1000) : null,
    author,
    music,
    qualities,
    is_images: images.length > 0,
    images
  }
}

// Khi trang gốc (Douyin/TikTok/Facebook) chặn scrape (vd tường đăng nhập của Douyin cho bài
// dạng ảnh) thì người dùng có thể tự lấy link CDN gốc (vd bằng devtools/console) rồi dán thẳng
// vào đây — link này không thuộc domain trang nào cả (là domain CDN riêng, vd zjcdn.com của
// Douyin) nên không tự nhận diện được platform/is_images qua URL. Không tải trước để soi —
// videos.js sẽ tự nhận diện video hay ảnh qua Content-Type thật lúc tải file (xem
// getOrDownloadVideo/handleDirectMedia). id lấy từ hash của URL (bỏ query string vì các link CDN
// dạng này thường kèm token ký hết hạn, đổi mỗi lần lấy lại dù cùng 1 nội dung gốc).
function extractDirectMedia(targetUrl) {
  let stableKey = targetUrl
  try {
    const u = new URL(targetUrl)
    stableKey = `${u.hostname}${u.pathname}`
  } catch (err) {
    // URL không parse được thì thôi, dùng nguyên chuỗi làm key
  }
  const id = crypto.createHash('sha1').update(stableKey).digest('hex').slice(0, 16)

  return {
    platform: 'direct',
    id,
    title: 'Video tải trực tiếp',
    video_url: targetUrl,
    cover: null,
    duration: null,
    author: { nickname: 'Link trực tiếp', unique_id: id, avatar: null },
    music: null,
    qualities: [
      {
        id: 'direct',
        label: 'File nguồn trực tiếp',
        resolution: 'Original',
        url: targetUrl,
        isBest: true
      }
    ],
    is_images: false,
    images: []
  }
}

/**
 * Tải dữ liệu video từ link TikTok / Facebook / Douyin, tự nhận diện nền tảng. Link không thuộc
 * platform nào ở trên được coi là link CDN gốc dán trực tiếp (xem extractDirectMedia).
 * @param {string} rawUrl - URL video nguồn
 * @param {object} [sourceCookies] - Cookie nguồn per-platform { douyin: [...], tiktok: [...] }
 *   Có thì inject vào Puppeteer khi scrape nền tảng tương ứng, không có thì bỏ qua.
 * Trả về { id, title, video_url, is_images, images }.
 */
export async function extractVideo(rawUrl, sourceCookies = null) {
  const urlRegex = /(https?:\/\/[^\s]+)/g
  const match = rawUrl.match(urlRegex)
  if (!match || match.length === 0) {
    throw new Error('Không tìm thấy link liên kết hợp lệ.')
  }

  const targetUrl = await resolveUrl(match[0])

  const isFacebook = targetUrl.includes('facebook.com') || targetUrl.includes('fb.watch') || targetUrl.includes('fb.gg') || targetUrl.includes('fb.me')
  const isTikTok = targetUrl.includes('tiktok.com')
  const isDouyin = targetUrl.includes('douyin.com') || targetUrl.includes('iesdouyin.com')

  if (isFacebook) return extractFacebook(targetUrl)
  if (isTikTok) return extractTikTok(targetUrl, sourceCookies?.tiktok || null)
  if (isDouyin) return extractDouyin(targetUrl, sourceCookies?.douyin || null)
  return extractDirectMedia(targetUrl)
}

export const VIDEO_URL_REGEX = /https?:\/\/(?:www\.|m\.|vm\.|vt\.|v\.)?(?:tiktok\.com|facebook\.com|fb\.watch|fb\.gg|fb\.me|douyin\.com|iesdouyin\.com)\/\S+/i
