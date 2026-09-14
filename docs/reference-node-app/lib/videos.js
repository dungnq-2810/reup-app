import fs from 'fs-extra'
import path from 'path'
import axios from 'axios'
import { extractVideo } from './extractor.js'
import { run, get } from './db.js'

const DOWNLOAD_DIR = path.resolve('./download')

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// CDN của Douyin/TikTok thường chặn hotlink nếu thiếu User-Agent/Referer hợp lệ — nhiều video
// tải lỗi (dù link lấy được vẫn đúng) là do thiếu 2 header này khi tải file thật.
const REFERER_BY_PLATFORM = {
  douyin: 'https://www.douyin.com/',
  tiktok: 'https://www.tiktok.com/',
  facebook: 'https://www.facebook.com/'
}

export function findVideo(id) {
  return get('SELECT * FROM videos WHERE id = ?', [id])
}

/**
 * Link CDN dán trực tiếp (platform 'direct' — xem extractDirectMedia) không có Referer sẵn theo
 * platform như các nguồn khác — đoán theo tên miền của chính URL đó (CDN Douyin/TikTok/Facebook
 * đều lộ tên nền tảng trong hostname, vd zjcdn.com của Douyin, tiktokcdn.com của TikTok).
 */
function guessRefererFromUrl(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase()
    if (hostname.includes('douyin') || hostname.includes('zjcdn') || hostname.includes('bytegos')) return REFERER_BY_PLATFORM.douyin
    if (hostname.includes('tiktok') || hostname.includes('tokcdn') || hostname.includes('snapcdn')) return REFERER_BY_PLATFORM.tiktok
    if (hostname.includes('fbcdn') || hostname.includes('facebook')) return REFERER_BY_PLATFORM.facebook
  } catch (err) {
    // URL không parse được thì thôi, không đoán được referer
  }
  return undefined
}

async function requestStream(url, meta) {
  return axios({
    url,
    method: 'GET',
    responseType: 'stream',
    headers: {
      'User-Agent': USER_AGENT,
      Referer: REFERER_BY_PLATFORM[meta.platform] || guessRefererFromUrl(url) || undefined,
      // Link CDN gốc TikTok đòi cookie phiên Puppeteer vừa lấy link (xem extractTikTokDirect) —
      // không có cookie này bị Akamai trả 403 dù URL vẫn còn hạn (chưa expire).
      Cookie: meta.cookie_header || undefined
    }
  })
}

async function pipeToFile(stream, filePath) {
  const writer = fs.createWriteStream(filePath)
  stream.pipe(writer)
  await new Promise((resolve, reject) => {
    writer.on('finish', resolve)
    writer.on('error', reject)
  })
}

async function downloadToFile(url, filePath, meta) {
  const res = await requestStream(url, meta)
  await pipeToFile(res.data, filePath)
}

const IMAGE_EXT_BY_CONTENT_TYPE = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic'
}

/**
 * Ảnh Douyin/TikTok không chắc luôn là .jpg (Douyin hay trả webp) — đoán đuôi file thật theo
 * Content-Type của response thay vì cứng ".jpg", tránh lệch đuôi/định dạng thật khi TikTok Studio
 * đọc lại file lúc đăng.
 */
function guessImageExtension(contentType) {
  const key = (contentType || '').split(';')[0].trim().toLowerCase()
  return IMAGE_EXT_BY_CONTENT_TYPE[key] || 'jpg'
}

/**
 * Lấy dữ liệu + file video (hoặc bộ ảnh) cho 1 link TikTok/Facebook/Douyin, chống tải trùng
 * dựa vào ID gốc (namespace theo platform vì mỗi nền tảng đánh số ID độc lập, có thể trùng
 * nhau giữa các nguồn). Cache dùng chung cho mọi user — nếu ID đã có trong DB và file vẫn còn
 * trên đĩa thì dùng lại.
 * Trả về { id, caption, filePath, filePaths, isImages, reused }. Với bài dạng ảnh, filePath là
 * ảnh đầu tiên (đại diện) và filePaths là mảng đủ mọi ảnh — chỉ TikTok hỗ trợ đăng lại kiểu này.
 */
/**
 * Link CDN dán trực tiếp (platform 'direct') không tự biết trước là video hay ảnh qua URL —
 * phải tải thật rồi đọc Content-Type của response để quyết định lưu như video hay như 1 bài
 * ảnh (album 1 ảnh duy nhất, vẫn đi qua đúng luồng TiktokUploadImages).
 */
async function handleDirectMedia(meta, videoUrl) {
  const id = `direct-${meta.id}`
  const caption = meta.title || ''

  const existing = findVideo(id)
  if (existing) {
    if (existing.is_images && existing.file_paths_json) {
      const savedPaths = JSON.parse(existing.file_paths_json)
      if ((await Promise.all(savedPaths.map((p) => fs.pathExists(p)))).every(Boolean)) {
        return { id, caption, filePath: savedPaths[0], filePaths: savedPaths, isImages: true, reused: true }
      }
    } else if (existing.file_path && (await fs.pathExists(existing.file_path))) {
      return { id, caption, filePath: existing.file_path, isImages: false, reused: true }
    }
  }

  await fs.ensureDir(DOWNLOAD_DIR)
  const res = await requestStream(meta.video_url, meta)
  const contentType = (res.headers['content-type'] || '').split(';')[0].trim().toLowerCase()

  if (contentType.startsWith('image/')) {
    const ext = guessImageExtension(contentType)
    const filePath = path.join(DOWNLOAD_DIR, `${id}-img-1.${ext}`)
    await pipeToFile(res.data, filePath)
    const filePaths = [filePath]
    if (existing) {
      run('UPDATE videos SET file_path = ?, file_paths_json = ?, downloaded_at = ?, is_images = 1 WHERE id = ?', [
        filePath,
        JSON.stringify(filePaths),
        Date.now(),
        id
      ])
    } else {
      run(
        'INSERT INTO videos (id, url, caption, file_path, downloaded_at, is_images, file_paths_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, videoUrl, caption, filePath, Date.now(), 1, JSON.stringify(filePaths)]
      )
    }
    return { id, caption, filePath, filePaths, isImages: true, reused: false }
  }

  // Không phải image/* thì coi là video (kể cả Content-Type không rõ ràng, vd
  // application/octet-stream — link do người dùng tự lấy nên tin theo đúng ý định của họ).
  const filePath = path.join(DOWNLOAD_DIR, `${id}.mp4`)
  await pipeToFile(res.data, filePath)
  if (existing) {
    run('UPDATE videos SET file_path = ?, downloaded_at = ?, is_images = 0, file_paths_json = NULL WHERE id = ?', [
      filePath,
      Date.now(),
      id
    ])
  } else {
    run('INSERT INTO videos (id, url, caption, file_path, downloaded_at) VALUES (?, ?, ?, ?, ?)', [
      id,
      videoUrl,
      caption,
      filePath,
      Date.now()
    ])
  }
  return { id, caption, filePath, isImages: false, reused: false }
}

export async function getOrDownloadVideo(videoUrl, sourceCookies = null) {
  const meta = await extractVideo(videoUrl, sourceCookies)
  if (meta.platform === 'direct') {
    return handleDirectMedia(meta, videoUrl)
  }
  if (meta.is_images) {
    if (!meta.images || meta.images.length === 0) {
      throw new Error('Không lấy được ảnh nào từ bài đăng dạng album này.')
    }
    const id = `${meta.platform}-${meta.id}`
    const caption = meta.title || ''

    // Đuôi file ảnh có thể khác nhau giữa các lần tải (đoán theo Content-Type thật — xem
    // guessImageExtension), nên KHÔNG suy luận lại đường dẫn cũ mà đọc thẳng từ DB nếu có.
    const existing = findVideo(id)
    if (existing && existing.file_paths_json) {
      const savedPaths = JSON.parse(existing.file_paths_json)
      const allExist = (await Promise.all(savedPaths.map((p) => fs.pathExists(p)))).every(Boolean)
      if (allExist) {
        return { id, caption, filePath: savedPaths[0], filePaths: savedPaths, isImages: true, reused: true }
      }
    }

    await fs.ensureDir(DOWNLOAD_DIR)
    const filePaths = []
    for (let i = 0; i < meta.images.length; i++) {
      const res = await requestStream(meta.images[i], meta)
      const ext = guessImageExtension(res.headers['content-type'])
      const filePath = path.join(DOWNLOAD_DIR, `${id}-img-${i + 1}.${ext}`)
      await pipeToFile(res.data, filePath)
      filePaths.push(filePath)
    }

    if (existing) {
      run('UPDATE videos SET file_path = ?, file_paths_json = ?, downloaded_at = ? WHERE id = ?', [
        filePaths[0],
        JSON.stringify(filePaths),
        Date.now(),
        id
      ])
    } else {
      run(
        'INSERT INTO videos (id, url, caption, file_path, downloaded_at, is_images, file_paths_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, videoUrl, caption, filePaths[0], Date.now(), 1, JSON.stringify(filePaths)]
      )
    }

    return { id, caption, filePath: filePaths[0], filePaths, isImages: true, reused: false }
  }

  if (!meta.video_url) {
    throw new Error('Không lấy được link tải video từ nguồn này.')
  }

  const id = `${meta.platform}-${meta.id}`
  const caption = meta.title || ''
  const filePath = path.join(DOWNLOAD_DIR, `${id}.mp4`)

  const existing = findVideo(id)
  if (existing && (await fs.pathExists(filePath))) {
    return { id, caption, filePath, isImages: false, reused: true }
  }

  await fs.ensureDir(DOWNLOAD_DIR)
  await downloadToFile(meta.video_url, filePath, meta)

  if (!existing) {
    run('INSERT INTO videos (id, url, caption, file_path, downloaded_at) VALUES (?, ?, ?, ?, ?)', [
      id,
      videoUrl,
      caption,
      filePath,
      Date.now()
    ])
  }

  return { id, caption, filePath, isImages: false, reused: false }
}

/** Xoá file vật lý (video hoặc bộ ảnh) sau khi đã đăng xong (giữ nguyên record trong DB) —
 * tránh làm đầy đĩa VPS. */
export async function deleteVideoFile(filePath, filePaths) {
  for (const p of filePaths && filePaths.length > 0 ? filePaths : [filePath]) {
    try {
      await fs.remove(p)
    } catch (err) {
      console.error('Không xoá được file (bỏ qua):', err.message)
    }
  }
}
