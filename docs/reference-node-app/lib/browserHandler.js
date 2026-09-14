import puppeteer from 'puppeteer'
import { executablePath } from 'puppeteer'
import moment from 'moment'
import delay from 'delay'
import fs from 'fs-extra'
import path from 'path'

/**
 * Browser options.
 * HEADLESS=true trong .env để chạy ẩn (cần thiết khi deploy lên VPS/Docker Linux không có màn hình).
 * Mặc định false để giữ đúng hành vi đã test trên máy có GUI (Windows).
 */
// 'new' chứ không phải true: true là chế độ headless ĐỜI CŨ, chạy một binary riêng khác hẳn
// Chrome thật nên Facebook dễ nhận ra và trả giao diện khác/chặn. 'new' là Chrome thật chạy
// không vẽ cửa sổ, hành xử giống hệt lúc HEADLESS=false — điều kiện tiên quyết để tin được
// rằng bật ẩn lên thì đăng bài vẫn chạy y như khi test có cửa sổ.
const HEADLESS = process.env.HEADLESS === 'true' ? 'new' : false
// Không set timeout thì Puppeteer dùng mặc định 30s — quá ngắn cho networkidle0 lúc mạng
// chậm/Facebook nặng tải, gây lỗi "Navigation timeout of 30000 ms exceeded" ngay ở bước mở
// trang tạo Reels dù cookie và mạng vẫn ổn.
const browserPageOpt = { waitUntil: 'networkidle0', timeout: 120000 }
export const browserOptions = {
  executablePath: executablePath("chrome"),
  headless: HEADLESS,
  args: [
    '--user-agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36"',
    '--no-sandbox',
    '--mute-audio'
  ]
}

// Nhãn "Tiếp"/"Đăng" chỉ đúng khi giao diện Facebook đang tiếng Việt — kèm thêm biến thể tiếng Anh
// làm lưới đỡ, vì ngôn ngữ hiển thị theo cấu hình tài khoản, có thể khác nhau giữa các hồ sơ/đổi
// bất kỳ lúc nào ngoài tầm kiểm soát của code.
const NEXT_BUTTON_LABELS = [
  'Tiếp',
  'Tiếp theo',
  'Next',
  'Continue'
]

// CỐ Ý KHÔNG có "Chia sẻ"/"Share" trơ trụi (không kèm chữ gì thêm): đây CHÍNH XÁC là chữ hiện trên
// nút Share của MỌI bài viết trong News Feed (kèm số lượt chia sẻ, vd "149" nằm cạnh) — thực tế
// đã bấm trúng nút Share của 1 bài viết khác nằm ẩn phía sau composer 3 lần liên tiếp khi test,
// làm tưởng đã đăng xong nhưng nút "Đăng" thật chưa hề được bấm. Cùng lý do, không thêm "Tiếp"
// đứng 1 mình vào các biến thể quá chung chung khác nếu sau này phát hiện thêm collision tương tự.
const POST_BUTTON_LABELS = [
  'Đăng thước phim',
  'Đăng',
  'Đăng ngay',
  'Chia sẻ thước phim',
  'Chia sẻ ngay',
  'Chia sẻ lên Trang',
  'Chia sẻ lên trang',
  'Tiếp',
  'Tiếp tục',
  'Xong',
  'Phát hành',
  'Xuất bản',
  'Post reel',
  'Post Reel',
  'Post',
  'Post now',
  'Share reel',
  'Share Reel',
  'Share now',
  'Publish reel',
  'Publish Reel',
  'Publish'
]

// Click theo aria-label hoặc textContent với chuẩn hóa (hỗ trợ cả popup dialog, scrollable modal
// và các biến thể 'Đăng thước phim' / 'Chia sẻ'). Tự cuộn dialog xuống đáy để thấy nút footer.
async function clickFacebookButton(page, { ariaLabels = [], textVariants = [] }) {
  return page.evaluate(
    (ariaLabels, textVariants) => {
      // 1. Tự động cuộn dialog hoặc container xuống đáy nếu modal có thanh cuộn riêng
      const dialog = document.querySelector('[role="dialog"]')
      if (dialog) {
        dialog.scrollTop = dialog.scrollHeight
        const scrollables = dialog.querySelectorAll('div, section')
        for (const s of scrollables) {
          if (s.scrollHeight > s.clientHeight && s.clientHeight > 0) {
            s.scrollTop = s.scrollHeight
          }
        }
      }

      const isUsable = (el) => {
        if (!el) return false
        if (el.getAttribute('aria-disabled') === 'true' || el.disabled) return false
        const style = window.getComputedStyle(el)
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || style.pointerEvents === 'none') return false
        return true
      }

      const cleanText = (str) => (str || '').replace(/\s+/g, ' ').trim().toLowerCase()
      const normalizedAria = ariaLabels.map((l) => cleanText(l))
      const normalizedText = textVariants.map((t) => cleanText(t))

      // CHỈ khớp CHÍNH XÁC — khớp tiền tố (startsWith) từng khiến dòng cài đặt "Chia sẻ lên nhóm"
      // (1 mục trong danh sách cài đặt Reels, không phải nút submit) bị coi là khớp nhãn "Chia sẻ"
      // vì text của nó BẮT ĐẦU BẰNG "Chia sẻ" — code bấm nhầm vào đó, mở popup "Chia sẻ" khác hẳn,
      // trong khi nút "Đăng" thật vẫn còn nguyên chưa được bấm. Hậu quả: báo "đã bấm Đăng" nhưng
      // thực ra bài chưa hề được đăng, và không có lỗi nào lộ ra để biết mà xử lý.
      const matchesTarget = (aria, text) => {
        if (aria && normalizedAria.includes(aria)) return true
        if (text && normalizedText.includes(text)) return true
        return false
      }

      // 2. Tìm kiếm ứng viên: ưu tiên các nút trong [role="dialog"] trước
      const scope = dialog || document
      const candidates = Array.from(scope.querySelectorAll('button, div[role="button"], a[role="button"]'))

      for (const el of candidates) {
        if (!isUsable(el)) continue
        const aria = cleanText(el.getAttribute('aria-label'))
        const text = cleanText(el.textContent)

        if (matchesTarget(aria, text)) {
          el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
          el.focus()
          // Dispatch chuỗi event React SyntheticEvent để đảm bảo ăn click trên Facebook web
          const rect = el.getBoundingClientRect()
          const clientX = rect.left + rect.width / 2
          const clientY = rect.top + rect.height / 2
          const eventOpts = { bubbles: true, cancelable: true, view: window, clientX, clientY }
          el.dispatchEvent(new PointerEvent('pointerdown', eventOpts))
          el.dispatchEvent(new MouseEvent('mousedown', eventOpts))
          el.dispatchEvent(new PointerEvent('pointerup', eventOpts))
          el.dispatchEvent(new MouseEvent('mouseup', eventOpts))
          el.dispatchEvent(new MouseEvent('click', eventOpts))
          if (typeof el.click === 'function') {
            el.click()
          }
          return true
        }
      }

      // 3. Nếu trong dialog không thấy (hoặc không có dialog), tìm trên toàn document
      if (dialog) {
        const globalCandidates = Array.from(document.querySelectorAll('button, div[role="button"], a[role="button"]'))
        for (const el of globalCandidates) {
          if (!isUsable(el)) continue
          const aria = cleanText(el.getAttribute('aria-label'))
          const text = cleanText(el.textContent)
          if (matchesTarget(aria, text)) {
            el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
            el.focus()
            if (typeof el.click === 'function') {
              el.click()
            }
            return true
          }
        }
      }

      return false
    },
    ariaLabels,
    textVariants
  )
}

// Chỉ kiểm tra có mặt (kể cả đang aria-disabled) — dùng để biết Facebook đã render xong bước kế
// tiếp sau khi xử lý video chưa, không quan tâm bấm được ngay hay không.
async function anyFacebookButtonPresent(page, ariaLabels, textVariants) {
  return page.evaluate(
    (ariaLabels, textVariants) => {
      const cleanText = (str) => (str || '').replace(/\s+/g, ' ').trim().toLowerCase()
      const normalizedAria = ariaLabels.map((l) => cleanText(l))
      const normalizedText = textVariants.map((t) => cleanText(t))

      // Khớp CHÍNH XÁC, không khớp tiền tố — xem giải thích ở matchesTarget trong clickFacebookButton.
      const candidates = Array.from(document.querySelectorAll('button, div[role="button"], a[role="button"]'))
      return candidates.some((el) => {
        const aria = cleanText(el.getAttribute('aria-label'))
        const text = cleanText(el.textContent)
        return (aria && normalizedAria.includes(aria)) || (text && normalizedText.includes(text))
      })
    },
    ariaLabels,
    textVariants
  )
}
// Facebook thỉnh thoảng thay cả trang composer bằng trang lỗi kỹ thuật chung ("Trang này hiện
// không hiển thị... Hãy thử tải lại trang này") — gặp lúc phiên/tài khoản bị dùng đồng thời từ
// nơi khác, hoặc backend FB tự trục trặc. Lúc đó KHÔNG có nút "Tiếp"/"Đăng" nào để đợi (đợi hết
// 60-120s rồi báo "không tìm thấy nút" là sai nguyên nhân) — phải nhận diện riêng để báo đúng.
async function facebookErrorPageVisible(page) {
  return page.evaluate(() => {
    const text = document.body ? document.body.innerText : ''
    return /Trang này hiện không hiển thị|isn't available right now|something went wrong/i.test(text)
  })
}

// Đợi 1 trong các nút (theo aria-label hoặc text) xuất hiện, nhưng thoát sớm + ném lỗi rõ ràng
// nếu Facebook lỡ hiện trang lỗi kỹ thuật chung giữa chừng — thay vì cứ đợi hết timeout rồi báo
// nhầm là "thiếu nút".
async function waitForFacebookReady(page, ariaLabels, textVariants, { timeout = 60000, interval = 2000 } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await anyFacebookButtonPresent(page, ariaLabels, textVariants)) return true
    if (await facebookErrorPageVisible(page)) {
      const err = new Error(
        'Facebook trả về trang lỗi kỹ thuật chung ("Trang này hiện không hiển thị") thay vì giao diện đăng bài — không phải do thiếu nút, có thể do phiên đăng nhập bị dùng đồng thời ở nơi khác hoặc Facebook đang trục trặc.'
      )
      err.facebookErrorPage = true
      throw err
    }
    await delay(interval)
  }
  return false
}

// Bấm lặp lại tới khi thành công hoặc hết thời gian chờ — khác waitForFacebookReady() ở chỗ
// hàm đó chỉ xác nhận nút đã XUẤT HIỆN (kể cả đang disabled), không xác nhận đã BẤM ĐƯỢC. Nút
// "Đăng" hay hiện trước ở trạng thái disabled vài giây (Facebook đang validate caption/video)
// rồi mới bật lên — bấm đúng 1 lần ngay sau khi thấy nút xuất hiện dễ trật đúng lúc còn disabled
// và báo nhầm "không tìm thấy nút", trong khi thực ra chỉ cần đợi thêm chút là bấm được.
async function clickFacebookButtonUntilReady(page, { ariaLabels, textVariants }, { timeout = 60000, interval = 1500 } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await clickFacebookButton(page, { ariaLabels, textVariants })) return true
    if (await facebookErrorPageVisible(page)) {
      const err = new Error(
        'Facebook trả về trang lỗi kỹ thuật chung ("Trang này hiện không hiển thị") thay vì giao diện đăng bài — không phải do thiếu nút.'
      )
      err.facebookErrorPage = true
      throw err
    }
    await delay(interval)
  }
  return false
}

// Lấy link Reel mới nhất trên trang cá nhân (best-effort — trả null nếu không lấy được, không
// ném lỗi). Dùng cả để lấy "mốc" trước khi đăng lẫn để xác nhận bài mới sau khi đăng.
async function getLatestFacebookReelUrl(page) {
  try {
    await page.goto('https://www.facebook.com/me', { waitUntil: 'networkidle0', timeout: 20000 })
    const meUrl = page.url()
    const reelsTabUrl = `${meUrl}${meUrl.includes('?') ? '&' : '?'}sk=reels_tab`
    await page.goto(reelsTabUrl, { waitUntil: 'networkidle0', timeout: 20000 })
    await delay(2000)
    return await page.evaluate(() => {
      const link = document.querySelector('a[href*="/reel/"]')
      return link ? new URL(link.getAttribute('href'), 'https://www.facebook.com').href : null
    })
  } catch (err) {
    printLog(`INFO: Không lấy được link trên tab Reels (${err.message})`)
    return null
  }
}

// Video đã tải lên xong hoàn toàn từ trước khi bấm "Đăng" (xem chọn file ở trên) — bấm "Đăng"
// chỉ là chốt lệnh đăng, Facebook xử lý tiếp (transcode/index) ở server, không phụ thuộc trình
// duyệt có đang mở hay không. Nên không cần đợi lâu tới khi bài hiện hẳn lên tab Reels (video
// nặng có thể mất rất lâu) — chỉ cần chờ ngắn cho lệnh đăng chắc chắn đã được gửi đi, rồi thử lấy
// link 1 lần cho có (không thấy cũng không phải lỗi, không chặn/không thử lại).
const FB_POST_CONFIRM_WAIT_MS = Math.max(1, Number(process.env.FB_POST_CONFIRM_WAIT_SECONDS) || 20) * 1000

// Chuẩn hoá cookie về đúng field Puppeteer chấp nhận. Nhiều extension xuất cookie kèm field lạ
// (vd "expirationDate" thay vì "expires", "sameSite": null thay vì bỏ hẳn field) — page.setCookie()
// của Puppeteer từ chối NGUYÊN CẢ MẢNG chỉ vì 1 cookie sai định dạng, dù mọi cookie còn lại vẫn
// hợp lệ, nên phải lọc/đổi tên field trước khi set chứ không dùng thẳng JSON người dùng dán vào.
const VALID_SAME_SITE = new Set(['Strict', 'Lax', 'None'])
export function sanitizeCookiesForPuppeteer(cookies) {
  if (!Array.isArray(cookies)) return cookies
  return cookies
    .map((c) => {
      const out = { name: c.name, value: c.value, domain: c.domain, path: c.path || '/' }
      const expires = c.expires ?? c.expirationDate
      if (typeof expires === 'number') out.expires = expires
      if (typeof c.httpOnly === 'boolean') out.httpOnly = c.httpOnly
      if (typeof c.secure === 'boolean') out.secure = c.secure
      if (typeof c.sameSite === 'string' && VALID_SAME_SITE.has(c.sameSite)) out.sameSite = c.sameSite
      return out
    })
    .filter((c) => c.name && c.value !== undefined && c.domain)
}

// Chuẩn hoá tham số cookies: nhận sẵn mảng cookie, hoặc đường dẫn file (tương thích ngược
// với run-once.mjs/upload-only.mjs), mặc định đọc ./cookies.json nếu không truyền gì.
async function resolveCookies(cookies) {
  try {
    let list
    if (Array.isArray(cookies)) {
      list = cookies
    } else {
      const cookiesPath = typeof cookies === 'string' ? cookies : path.resolve('./cookies.json')
      list = JSON.parse(await fs.readFile(cookiesPath))
    }
    return sanitizeCookiesForPuppeteer(list)
  } catch (err) {
    return null
  }
}

/**
 * Generate console log with timestamp
 */
function printLog(str) {
  const date = moment().format('HH:mm:ss')
  console.log(`[${date}] ${str}`)
}

const DOWNLOAD_DIR = path.resolve('./download')

/**
 * Chụp lại màn hình Chrome đúng lúc lỗi — cách duy nhất để biết Facebook đang hiện cái gì
 * (popup xác minh, video bị từ chối, giao diện đổi...). Best-effort: hỏng thì bỏ qua, không
 * được để việc chụp ảnh làm mất luôn lỗi gốc.
 */
export async function saveErrorScreenshot(page, namafile) {
  try {
    await fs.ensureDir(DOWNLOAD_DIR)
    const file = path.join(DOWNLOAD_DIR, `error-${namafile}-${moment().format('YYYYMMDD-HHmmss')}.png`)
    await page.screenshot({ path: file })
    printLog(`INFO: Đã lưu ảnh màn hình lúc lỗi: ${file}`)
    return file
  } catch (err) {
    return null
  }
}

// Facebook không trả lỗi khi cookie hỏng — nó lặng lẽ chuyển hướng về trang đăng nhập/xác minh.
const LOGGED_OUT_URL_PATTERN = /\/login|\/checkpoint|\/recover/

// TikTok cũng vậy — cookie hỏng thì bị đá về trang đăng nhập chứ không báo lỗi rõ ràng.
const TIKTOK_LOGGED_OUT_URL_PATTERN = /\/login/
const TIKTOK_UPLOAD_URL = 'https://www.tiktok.com/tiktokstudio/upload?from=upload'

async function isUsableHandle(page, handle) {
  if (!handle) return false
  return page.evaluate((el) => {
    if (!el) return false
    const btn = el.tagName === 'BUTTON' ? el : (el.querySelector('button') || el.closest('button') || el)
    if (btn.getAttribute('aria-disabled') === 'true' || btn.disabled) return false
    const style = window.getComputedStyle(btn)
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || style.pointerEvents === 'none') return false
    return true
  }, handle).catch(() => false)
}

/**
 * Bấm 1 nút trên TikTok Studio theo `data-e2e` (ổn định qua nhiều ngôn ngữ tài khoản), nếu
 * không thấy thì fallback dò theo text hiển thị (TikTok có thể đổi data-e2e giữa các lần cập
 * nhật giao diện, còn text thường vẫn còn 1 trong các biến thể quen thuộc).
 * Kết hợp: cuộn vào giữa viewport, focus, CDP page.mouse click tại tọa độ thật, Puppeteer
 * elementHandle.click(), và dispatch toàn bộ Pointer/Mouse events để kích hoạt React.
 */
async function triggerRealClick(frame, handle) {
  if (!handle) return false
  try {
    // 1. Cuộn phần tử vào chính giữa viewport để đảm bảo không bị off-screen hay bị che
    await handle.evaluate((el) => {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    }).catch(() => { })
    await delay(300)

    // 2. Định vị đúng thẻ button nếu handle là wrapper div
    const targetHandle = await frame.evaluateHandle((el) => {
      if (el.tagName === 'BUTTON') return el
      return el.querySelector('button') || el.closest('button') || el
    }, handle).catch(() => handle)

    const elHandle = targetHandle.asElement() || handle

    // 3. Focus vào phần tử
    await elHandle.focus().catch(() => { })

    // 4. Click bằng CDP page.mouse thật tại tọa độ
    const pageObj = typeof frame.mouse === 'object' ? frame : (typeof frame.page === 'function' ? frame.page() : null)
    let cdpClicked = false
    try {
      const box = await elHandle.boundingBox()
      if (box && box.width > 0 && box.height > 0 && pageObj && pageObj.mouse) {
        const cx = box.x + box.width / 2
        const cy = box.y + box.height / 2
        await pageObj.mouse.move(cx, cy)
        await delay(50)
        await pageObj.mouse.down()
        await delay(50)
        await pageObj.mouse.up()
        cdpClicked = true
      }
    } catch (e) { }

    // 5. Puppeteer elementHandle.click fallback
    if (!cdpClicked) {
      await elHandle.click({ delay: 50 }).catch(() => { })
    }

    // 6. Kết hợp dispatch toàn bộ chuỗi PointerEvent, MouseEvent và native .click()
    // để đảm bảo bắt trúng React SyntheticEvent trên mọi phiên bản TikTok Studio
    await frame.evaluate((el) => {
      const btn = el.tagName === 'BUTTON' ? el : (el.querySelector('button') || el.closest('button') || el)
      btn.focus()
      const rect = btn.getBoundingClientRect()
      const clientX = rect.left + rect.width / 2
      const clientY = rect.top + rect.height / 2
      const eventOpts = { bubbles: true, cancelable: true, view: window, clientX, clientY }
      btn.dispatchEvent(new PointerEvent('pointerdown', eventOpts))
      btn.dispatchEvent(new MouseEvent('mousedown', eventOpts))
      btn.dispatchEvent(new PointerEvent('pointerup', eventOpts))
      btn.dispatchEvent(new MouseEvent('mouseup', eventOpts))
      btn.dispatchEvent(new MouseEvent('click', eventOpts))
      if (typeof btn.click === 'function') {
        btn.click()
      }
    }, elHandle).catch(() => { })

    return true
  } catch (err) {
    return false
  }
}

async function clickTiktokButton(frame, { testId, textVariants = [] }) {
  if (testId) {
    const handle = await frame.$(`[data-e2e="${testId}"]`)
    if (await isUsableHandle(frame, handle)) {
      const clicked = await triggerRealClick(frame, handle)
      if (clicked) return true
    }
  }

  const candidates = await frame.$$('button, div[role="button"]')
  for (const handle of candidates) {
    if (!(await isUsableHandle(frame, handle))) continue
    const text = await frame.evaluate((el) => (el.textContent || '').trim(), handle)
    if (textVariants.some((t) => t.toLowerCase() === text.toLowerCase() || (text.toLowerCase().startsWith(t.toLowerCase()) && text.length < 25))) {
      const clicked = await triggerRealClick(frame, handle)
      if (clicked) return true
    }
  }
  return false
}

/**
 * TikTok Studio hay bật popup phụ ngay sau khi video tải lên xong (vd "Turn on automatic
 * content checks?") — popup này đè lên toàn bộ form, kể cả nút "Đăng". Đóng bằng nút X nếu
 * thấy.
 */
async function dismissTiktokDialog(page) {
  try {
    const closeHandle = await page.$(
      '[role="dialog"] .common-modal-close, [role="dialog"] [aria-label="Close"], [role="dialog"] [class*="close"], .TUXModal-close'
    )
    if (closeHandle && (await isUsableHandle(page, closeHandle))) {
      await triggerRealClick(page, closeHandle)
      return true
    }
  } catch (e) { }
  return false
}

async function checkPostButtonUsable(frame) {
  try {
    return await frame.evaluate(() => {
      const isUsable = (el) => {
        if (!el) return false
        const btn = el.tagName === 'BUTTON' ? el : (el.querySelector('button') || el.closest('button') || el)
        if (btn.getAttribute('aria-disabled') === 'true' || btn.disabled) return false
        const style = window.getComputedStyle(btn)
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || style.pointerEvents === 'none') return false
        return true
      }
      const byTestId = document.querySelector('[data-e2e="post_video_button"]')
      if (isUsable(byTestId)) return true
      const candidates = Array.from(document.querySelectorAll('button, div[role="button"]'))
      const variants = ['đăng', 'đăng tải', 'post', 'tải lên', 'publish']
      return candidates.some((el) => isUsable(el) && variants.includes((el.textContent || '').trim().toLowerCase()))
    })
  } catch (err) {
    return false
  }
}

const SECONDARY_CONFIRM_LABELS = [
  'Vẫn đăng',
  'Post anyway',
  'Đăng ngay',
  'Post now',
  'Xác nhận',
  'Confirm',
  'Tiếp tục',
  'Continue'
]

const TIKTOK_SUCCESS_MARKERS = [
  'quản lý bài đăng',
  'manage your posts',
  'tải video khác lên',
  'tải lên video khác',
  'upload another video',
  'tải bài khác lên',
  'upload another post',
  'video của bạn đã được tải lên',
  'your video has been uploaded',
  'bài viết của bạn đã được tải lên',
  'your post has been uploaded',
  'đã tải lên tiktok',
  'uploaded to tiktok'
]

async function checkTiktokPostSuccess(page, frame) {
  if (!/\/upload/.test(page.url())) {
    return true
  }

  const checkContext = async (ctx) => {
    try {
      return await ctx.evaluate((markers) => {
        const bodyText = (document.body ? document.body.innerText || '' : '').toLowerCase()
        if (markers.some((m) => bodyText.includes(m))) {
          return true
        }
        const links = Array.from(document.querySelectorAll('a, button, div[role="button"]'))
        return links.some((el) => {
          const text = (el.textContent || '').trim().toLowerCase()
          const href = el.getAttribute('href') || ''
          return (
            text.includes('manage your posts') ||
            text.includes('quản lý bài đăng') ||
            text.includes('upload another') ||
            text.includes('tải video khác') ||
            text.includes('tải bài khác') ||
            href.includes('/tiktokstudio/content')
          )
        })
      }, TIKTOK_SUCCESS_MARKERS)
    } catch (err) {
      return false
    }
  }

  if (await checkContext(page)) return true
  if (frame && frame !== page && (await checkContext(frame))) return true
  for (const f of page.frames()) {
    if (f !== page && f !== frame && (await checkContext(f))) return true
  }
  return false
}

async function checkTiktokPostError(frame) {
  try {
    return await frame.evaluate(() => {
      const errorEl = document.querySelector('.tiktok-toast, [role="alert"], .error-message')
      if (errorEl) {
        const txt = (errorEl.textContent || '').trim()
        if (txt) return txt
      }
      return null
    })
  } catch (err) {
    return null
  }
}

/**
 * Kiểm tra cookie của 1 hồ sơ còn đăng bài được không, KHÔNG đăng gì cả.
 * Đi đúng đường của lúc đăng thật (mở luôn trang tạo Reels bằng chính bộ cookie đó) để kết quả
 * kiểm tra phản ánh đúng cái sẽ xảy ra lúc tới giờ — kiểm tra bằng HTTP request suông thì nhẹ
 * hơn nhưng Facebook trả nội dung khác cho request không phải trình duyệt, dễ báo nhầm.
 * Luôn trả về { ok, reason }, không bao giờ ném lỗi.
 */
export async function checkCookies(cookies) {
  const resolvedCookies = await resolveCookies(cookies)
  if (!resolvedCookies || resolvedCookies.length === 0) {
    return { ok: false, reason: 'Hồ sơ không có cookie hợp lệ.' }
  }

  let browser
  try {
    browser = await puppeteer.launch(browserOptions)
    const page = await browser.newPage()
    await page.setCookie(...resolvedCookies)
    // domcontentloaded thay vì networkidle0: chỉ cần biết đã bị đá về trang đăng nhập hay chưa,
    // không cần đợi Facebook tải xong toàn bộ trang soạn Reels.
    await page.goto('https://www.facebook.com/reels/create', { waitUntil: 'domcontentloaded', timeout: 45000 })
    if (LOGGED_OUT_URL_PATTERN.test(page.url())) {
      return { ok: false, reason: 'Bị chuyển về trang đăng nhập/xác minh — cookie đã hết hạn hoặc bị Facebook chặn.' }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: `Không mở được Facebook để kiểm tra: ${err.message}` }
  } finally {
    if (browser) await browser.close().catch(() => { })
  }
}

/**
 * Kiểm tra cookie TikTok của 1 hồ sơ còn đăng bài được không, KHÔNG đăng gì cả.
 * Cùng cách tiếp cận với checkCookies(Facebook): mở đúng trang sẽ dùng lúc đăng thật.
 */
export async function checkTiktokCookies(cookies) {
  const resolvedCookies = await resolveCookies(cookies)
  if (!resolvedCookies || resolvedCookies.length === 0) {
    return { ok: false, reason: 'Hồ sơ không có cookie hợp lệ.' }
  }

  let browser
  try {
    browser = await puppeteer.launch(browserOptions)
    const page = await browser.newPage()
    await page.setCookie(...resolvedCookies)
    await page.goto(TIKTOK_UPLOAD_URL, { waitUntil: 'domcontentloaded', timeout: 45000 })
    if (TIKTOK_LOGGED_OUT_URL_PATTERN.test(page.url())) {
      return { ok: false, reason: 'Bị chuyển về trang đăng nhập — cookie TikTok đã hết hạn hoặc bị chặn.' }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: `Không mở được TikTok để kiểm tra: ${err.message}` }
  } finally {
    if (browser) await browser.close().catch(() => { })
  }
}

/**
 * Đăng lần lượt nhiều bình luận (vd link affiliate) lên 1 bài đăng Facebook (Reels) đã có sẵn.
 * commentTexts: mảng string, đăng tuần tự từng dòng, KHÔNG song song — Facebook dễ coi 1 tài
 * khoản gửi nhiều request cùng lúc là bot. 1 dòng lỗi không dừng các dòng còn lại (best-effort,
 * giống cách ReelsUpload không coi việc thiếu bước phụ là lỗi).
 * Luôn trả về { status, message, results: [{ text, ok, message }] }, không bao giờ ném lỗi ra ngoài
 * trừ khi cookie hết hạn hoặc không mở được trang (lỗi permanent, thử lại cũng vô ích).
 */
export async function PostFacebookComments(postUrl, commentTexts, cookies) {
  const resolvedCookies = await resolveCookies(cookies)
  if (!resolvedCookies || resolvedCookies.length === 0) {
    const err = new Error('Hồ sơ không có cookie hợp lệ.')
    err.permanent = true
    throw err
  }

  let browser
  let page
  try {
    browser = await puppeteer.launch(browserOptions)
    page = await browser.newPage()
    await page.setCookie(...resolvedCookies)

    await page.goto(postUrl, { waitUntil: 'networkidle0', timeout: 45000 })
    if (LOGGED_OUT_URL_PATTERN.test(page.url())) {
      const err = new Error(
        'Cookie của hồ sơ đã hết hạn hoặc bị Facebook chặn (bị chuyển về trang đăng nhập/xác minh). ' +
        'Vào trang Hồ sơ đăng để cập nhật lại cookie.'
      )
      err.permanent = true
      throw err
    }
    await delay(3000)

    const results = []
    for (const text of commentTexts) {
      try {
        // Ô nhập bình luận trên Facebook là 1 trong các div[role="textbox"][contenteditable="true"]
        // trên trang (video/ảnh/caption cũng dùng contenteditable, nên phải lọc theo role="textbox"
        // để tránh nhầm ô khác) — lấy ô ĐẦU TIÊN, vì trên trang xem 1 bài đăng đó thường là ô comment.
        const box = await page.waitForSelector('div[role="textbox"][contenteditable="true"]', { timeout: 15000 })
        await box.click()
        // Dán nguyên văn thay vì gõ từng ký tự (box.type()): nhanh hơn nhiều, né được autocomplete/
        // gợi ý tag popup của Facebook can thiệp giữa chừng, và \n bên trong text (1 record vẫn là
        // 1 comment, có thể xuống dòng bên trong nó) chỉ tạo dòng mới trong ô — không bị hiểu nhầm
        // thành phím Enter thật (Enter thật = GỬI luôn trên ô comment Facebook, gõ từng ký tự sẽ vỡ
        // 1 record nhiều dòng thành nhiều comment rác). execCommand('insertText') hành xử đúng như
        // thao tác Paste thật nên Facebook (React) vẫn nhận đúng nội dung.
        await page.evaluate((el, value) => {
          el.focus()
          document.execCommand('insertText', false, value)
        }, box, text)
        await delay(500)
        await page.keyboard.press('Enter')
        await delay(3000)
        results.push({ text, ok: true, message: null })
      } catch (err) {
        results.push({ text, ok: false, message: err.message })
      }
      // Giãn cách giữa các bình luận để né bị Facebook coi là spam.
      await delay(4000 + Math.random() * 2000)
    }

    await browser.close()
    const successCount = results.filter((r) => r.ok).length
    const status = successCount === results.length ? 'success' : successCount > 0 ? 'partial' : 'error'
    return {
      status,
      message: `Đăng được ${successCount}/${results.length} bình luận.`,
      results
    }
  } catch (err) {
    const screenshotPath = browser ? await saveErrorScreenshot(page, `comment-${Date.now()}`) : null
    if (browser) await browser.close().catch(() => { })
    if (err.permanent) throw err
    return {
      status: 'error',
      message: `${err.message}${screenshotPath ? ` — xem ảnh lỗi: ${path.basename(screenshotPath)}` : ''}`,
      results: []
    }
  }
}

/**
 * Upload video to reels via browser.
 * cookies xác định "đăng với tư cách" ai: mảng cookie đã parse (từ DB, xem lib/profiles.js),
 * hoặc đường dẫn file / để trống để đọc ./cookies.json (tương thích ngược cho script CLI).
 */
export const ReelsUpload = (namafile, caption, cookies) => new Promise(async (resolve) => {
  const browser = await puppeteer.launch(browserOptions)
  const page = await browser.newPage()
  await page.setViewport({ width: 1920, height: 1080 })
  const resolvedCookies = await resolveCookies(cookies)

  // Bước cuối cùng đã đi qua — ghép vào message lỗi để biết quy trình chết ở đâu, vì phần lớn
  // lỗi Puppeteer ("Node is detached", "waiting for selector failed") tự nó không nói lên điều gì.
  let lastStep = 'khởi tạo trình duyệt'

  if (resolvedCookies && resolvedCookies.length !== 0) {
    printLog('INFO: Session ditemukan, mencoba akses Facebook...')
    await page.setCookie(...resolvedCookies)
    try {
      // Lấy mốc SO SÁNH trước khi đăng: nếu sau này không có bước này, không cách nào phân biệt
      // được link Reel tìm thấy trên tab Reels là bài VỪA đăng hay bài cũ có sẵn từ trước.
      lastStep = 'lấy mốc Reels trước khi đăng'
      const baselineReelUrl = await getLatestFacebookReelUrl(page)

      lastStep = 'mở trang tạo Reels'
      await page.goto('https://www.facebook.com/reels/create', browserPageOpt)

      // Cookie hết hạn không làm goto() lỗi — Facebook chỉ lặng lẽ đá về trang đăng nhập, rồi
      // mọi bước sau đó fail với lý do khó hiểu. Bắt sớm ở đây để báo đúng nguyên nhân thật.
      if (LOGGED_OUT_URL_PATTERN.test(page.url())) {
        // permanent: thử lại bao nhiêu lần cũng ra đúng kết quả này, chỉ tốn thêm mấy phút
        // và mấy lần mở Chrome. Phải sửa cookie thì mới đăng được.
        const err = new Error(
          'Cookie của hồ sơ đã hết hạn hoặc bị Facebook chặn (bị chuyển về trang đăng nhập/xác minh). ' +
          'Vào trang Hồ sơ đăng để cập nhật lại cookie.'
        )
        err.permanent = true
        throw err
      }
      printLog('Berhasil membuka fb')

      lastStep = 'chọn file video để tải lên'
      const videoPath = path.resolve(`./download/${namafile}.mp4`)
      if (!(await fs.pathExists(videoPath))) {
        throw new Error(`Không tìm thấy file video đã tải về (${videoPath}).`)
      }
      const [fileInput] = await page.$$('input[type="file"]')
      if (!fileInput) {
        throw new Error('Không tìm thấy ô tải video lên trên trang Facebook — giao diện có thể đã thay đổi.')
      }
      await fileInput.uploadFile(videoPath)
      printLog(`sukses Upload video ${namafile}.mp4`)

      // Facebook xử lý (transcode) video xong mới render nút bước kế tiếp — thời gian dao động
      // mạnh theo độ dài/dung lượng video và tải server FB. delay(8000) cứng từng đủ với video
      // nhẹ nhưng video nặng/lúc FB tải cao thì 8s chưa xong, khiến bước sau tìm nút "Tiếp"/"Đăng"
      // không ra gì cả (giống hệt lỗi "Không tìm thấy nút Đăng... Cả 2 nút Tiếp cũng không thấy")
      // — đợi theo điều kiện thay vì delay cứng, giống cách TiktokUpload đã làm ở dưới.
      lastStep = 'đợi Facebook xử lý xong video vừa tải lên'
      const uploadRendered = await waitForFacebookReady(
        page,
        [...NEXT_BUTTON_LABELS, ...POST_BUTTON_LABELS],
        [...NEXT_BUTTON_LABELS, ...POST_BUTTON_LABELS],
        { timeout: 120000, interval: 2000 }
      )
      if (!uploadRendered) {
        printLog('INFO: Facebook chưa hiện nút nào sau khi tải video lên, vẫn thử các bước tiếp theo.')
      }

      // 2 nút "Tiếp" không phải lúc nào cũng có (Facebook thỉnh thoảng gộp/bỏ bước), nên không
      // coi việc thiếu nút là lỗi — chỉ ghi nhận lại để nếu bước "Đăng" chết thì biết đường lần.
      lastStep = 'bấm "Tiếp" (bước 1 - cắt video)'
      const next1 = await clickFacebookButton(page, { ariaLabels: NEXT_BUTTON_LABELS, textVariants: NEXT_BUTTON_LABELS })
      printLog(next1 ? 'Lanjut ke tahap edit...' : 'INFO: Không thấy nút "Tiếp" ở bước 1, bỏ qua.')
      await delay(2500)

      lastStep = 'bấm "Tiếp" (bước 2 - chỉnh sửa)'
      const next2 = await clickFacebookButton(page, { ariaLabels: NEXT_BUTTON_LABELS, textVariants: NEXT_BUTTON_LABELS })
      printLog(next2 ? 'Lanjut ke tahap deskripsi...' : 'INFO: Không thấy nút "Tiếp" ở bước 2, bỏ qua.')
      await delay(2500)

      lastStep = 'nhập caption'
      const [captionBox] = await page.$$('div[contenteditable="true"]')
      if (captionBox && caption) {
        await captionBox.click()
        // Dán nguyên văn (execCommand('insertText')) thay vì gõ từng ký tự (box.type()) — lý do
        // y hệt PostFacebookComments ở trên: caption chứa hashtag (#...) rất hay bật popup gợi ý
        // của Facebook giữa chừng khi gõ từng ký tự, làm mất/vỡ nội dung đang gõ. Hậu quả thấy
        // được không phải lỗi rõ ràng mà là nút "Đăng" cứ ở trạng thái disabled vì caption thật sự
        // nhập vào ô rỗng/thiếu — dù biến `caption` truyền vào hàm vẫn đầy đủ.
        await page.evaluate((el, value) => {
          el.focus()
          document.execCommand('insertText', false, value)
        }, captionBox, caption)
        printLog("Menginput Caption...")
      }
      await delay(1500)

      lastStep = 'chờ nút "Đăng" hết disable rồi bấm'
      const posted = await clickFacebookButtonUntilReady(
        page,
        { ariaLabels: POST_BUTTON_LABELS, textVariants: POST_BUTTON_LABELS },
        { timeout: 240000, interval: 1500 }
      )
      if (!posted) {
        const hint = !next1 && !next2 ? ' Cả 2 nút "Tiếp" cũng không thấy — nhiều khả năng giao diện Facebook đang không phải tiếng Việt hoặc trang chưa tải xong kịp.' : ''
        throw new Error(`Không tìm thấy nút "Đăng" bấm được sau khi đợi tối đa 4 phút (có thể luôn ở trạng thái disabled).${hint}`)
      }

      // Thử bấm popup xác nhận phụ nếu có (vd cảnh báo bản quyền / xác nhận lần 2)
      const secondaryConfirmLabels = ['Đăng ngay', 'Xác nhận', 'Vẫn đăng', 'Confirm', 'Post now', 'Continue', 'Tiếp tục']
      await delay(2000)
      await clickFacebookButton(page, { ariaLabels: secondaryConfirmLabels, textVariants: secondaryConfirmLabels }).catch(() => { })

      printLog("Post ke Reels", 'yellow')

      // Facebook điều hướng thẳng URL sang link permalink của bài Reel VỪA đăng ngay sau khi submit
      // thành công (dạng facebook.com/reel/<id>) — đợi ngắn cho URL kịp cập nhật rồi đọc thẳng từ
      // đó, nhanh và đáng tin hơn nhiều so với quay lại tab Reels dò link (có độ trễ transcode/index).
      lastStep = 'xác nhận bài đăng qua URL'
      await delay(3000)
      const REEL_PERMALINK_PATTERN = /^https:\/\/www\.facebook\.com\/reel\/\d+/
      let postUrl = REEL_PERMALINK_PATTERN.test(page.url()) ? page.url() : null

      if (!postUrl) {
        // URL chưa kịp đổi hoặc Facebook điều hướng đi chỗ khác — thử cách cũ (best-effort, so
        // với mốc lấy trước khi đăng) trước khi đành báo "chưa xác nhận được".
        lastStep = 'chờ xác nhận lệnh đăng đã gửi'
        await delay(FB_POST_CONFIRM_WAIT_MS)
        const latestReelUrl = await getLatestFacebookReelUrl(page)
        postUrl = latestReelUrl && latestReelUrl !== baselineReelUrl ? latestReelUrl : null
      }

      await browser.close()

      if (!postUrl) {
        // Không throw lỗi ở đây: throw sẽ khiến scheduler tự động thử lại (UPLOAD_RETRIES) và có
        // thể đăng trùng video lên Facebook lần nữa, trong khi thực tế bài đã lên (video đã tải
        // lên xong từ trước, bấm "Đăng" chỉ là chốt lệnh) chỉ là chưa kịp hiện lên tab Reels để
        // lấy link trong 20s. An toàn hơn là báo thành công, không có link thì thôi.
        printLog('INFO: Đã bấm Đăng nhưng chưa lấy được link bài mới trên tab Reels.')
        return resolve({
          status: "success",
          message: "Đã đăng lên Facebook nhưng chưa lấy được link bài mới (có thể do đang xử lý) — vào Facebook kiểm tra sau nếu cần link.",
          postUrl: null,
          verified: false
        })
      }

      printLog("Berhasil")
      return resolve({
        status: "success",
        message: "Video Berhasil di publish!",
        postUrl,
        verified: true
      })
    } catch (err) {
      printLog(`ERROR: ${err.stack || err.message}`)
      const screenshotPath = await saveErrorScreenshot(page, namafile)
      await browser.close()
      return resolve({
        status: "error",
        message: `${err.message} [dừng ở bước: ${lastStep}]`,
        permanent: err.permanent === true,
        screenshotPath
      })
    }
  } else {
    await browser.close()
    const message = 'Hồ sơ đăng không có cookie hợp lệ — vào trang Hồ sơ đăng để dán lại cookie JSON.'
    printLog(`ERROR: ${message}`)
    return resolve({
      status: "error",
      message,
      permanent: true
    })
  }
})

/** Đợi tới khi `fn()` trả về truthy, hoặc hết `timeout` thì thôi (trả về false, không ném lỗi). */
async function waitForCondition(fn, { timeout = 60000, interval = 1500 } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await fn()) return true
    await delay(interval)
  }
  return false
}

/**
 * Upload video lên TikTok qua TikTok Studio (trang tiktok.com/tiktokstudio/upload).
 * Đã kiểm thử với tài khoản TikTok thật tới sát bước bấm "Đăng" (không thực sự đăng) — các
 * bước chọn video, chờ xử lý, đóng popup phụ, nhập caption đều chạy đúng. TikTok có thể chặn
 * phiên đăng nhập lạ bằng captcha/xác minh — trường hợp đó sẽ dừng ở bước tương ứng với thông
 * báo lỗi rõ ràng, không đăng được tự động.
 */
export const TiktokUpload = (namafile, caption, cookies) => new Promise(async (resolve) => {
  const browser = await puppeteer.launch(browserOptions)
  const page = await browser.newPage()
  await page.setViewport({ width: 1920, height: 1080 })
  const resolvedCookies = await resolveCookies(cookies)

  let apiPostSuccess = false
  page.on('response', async (res) => {
    try {
      const u = res.url()
      if (u.includes('/project/post/') || u.includes('/content/post/') || u.includes('/aweme/v1/create/')) {
        const json = await res.json().catch(() => null)
        if (json && (json.status_code === 0 || json.status_msg === 'success' || json.status === 'success')) {
          apiPostSuccess = true
        }
      }
    } catch (e) { }
  })

  let lastStep = 'khởi tạo trình duyệt'

  if (!resolvedCookies || resolvedCookies.length === 0) {
    await browser.close()
    const message = 'Hồ sơ đăng không có cookie hợp lệ — vào trang Hồ sơ đăng để dán lại cookie JSON.'
    printLog(`ERROR: ${message}`)
    return resolve({ status: 'error', message, permanent: true })
  }

  printLog('INFO: Session ditemukan, mencoba akses TikTok...')
  await page.setCookie(...resolvedCookies)
  try {
    lastStep = 'mở trang tải video lên TikTok'
    await page.goto(TIKTOK_UPLOAD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })

    if (TIKTOK_LOGGED_OUT_URL_PATTERN.test(page.url())) {
      const err = new Error(
        'Cookie của hồ sơ TikTok đã hết hạn hoặc bị chặn (bị chuyển về trang đăng nhập). ' +
        'Vào trang Hồ sơ đăng để cập nhật lại cookie.'
      )
      err.permanent = true
      throw err
    }

    lastStep = 'chờ trang tải video lên hiện ra'
    const videoPath = path.resolve(`./download/${namafile}.mp4`)
    if (!(await fs.pathExists(videoPath))) {
      throw new Error(`Không tìm thấy file video đã tải về (${videoPath}).`)
    }
    // TikTok Studio là SPA nặng — domcontentloaded xong không có nghĩa là khung tải video đã
    // render (JS còn đang chạy). Đợi hẳn input[type=file] xuất hiện thay vì tìm ngay lập tức.
    lastStep = 'chọn file video để tải lên'
    let fileInput = null
    let uploadFrame = page
    const findFileInputDeadline = Date.now() + 45000
    while (!fileInput && Date.now() < findFileInputDeadline) {
      fileInput = (await page.$$('input[type="file"]'))[0] || null
      if (fileInput) {
        uploadFrame = page
        break
      }
      // input[type=file] của TikTok Studio đôi khi nằm trong iframe upload — dò qua các iframe con.
      for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue
        const found = (await frame.$$('input[type="file"]').catch(() => []))[0]
        if (found) {
          fileInput = found
          uploadFrame = frame
          break
        }
      }
      if (!fileInput) await delay(1000)
    }
    if (!fileInput) {
      throw new Error('Không tìm thấy ô tải video lên trên trang TikTok sau 45s chờ — giao diện có thể đã thay đổi.')
    }
    await fileInput.uploadFile(videoPath)
    printLog(`sukses Upload video ${namafile}.mp4`)

    // TikTok xử lý (transcode + kiểm duyệt sơ bộ) video xong mới cho bấm Đăng — thời gian dao
    // động mạnh theo độ dài/dung lượng video nên đợi theo điều kiện thay vì delay cứng.
    lastStep = 'đợi TikTok xử lý xong video vừa tải lên'
    const ready = await waitForCondition(
      async () => {
        // Popup phụ (vd "Turn on automatic content checks?") có thể bật lên bất cứ lúc nào
        // trong lúc chờ — đóng ngay nếu thấy, không thì nó đè lên nút "Đăng" tới cuối.
        await dismissTiktokDialog(uploadFrame)
        if (uploadFrame !== page) await dismissTiktokDialog(page)
        return (await checkPostButtonUsable(uploadFrame)) || (uploadFrame !== page ? await checkPostButtonUsable(page) : false)
      },
      { timeout: 180000, interval: 2000 }
    )
    if (!ready) {
      printLog('INFO: Nút "Đăng" vẫn chưa sẵn sàng sau thời gian chờ, vẫn thử bấm.')
    }

    lastStep = 'nhập caption'
    const [captionBox] = await uploadFrame.$$('div[contenteditable="true"]')
    if (captionBox && caption) {
      await captionBox.click()
      await captionBox.type(`${caption}`)
      printLog('Menginput Caption...')
    }
    await delay(1500)

    // Popup có thể bật lại/trễ hơn (sau khi nhập caption) — kiểm tra lần cuối trước khi bấm Đăng.
    lastStep = 'đóng popup phụ (nếu có) trước khi đăng'
    await dismissTiktokDialog(uploadFrame)
    if (uploadFrame !== page) await dismissTiktokDialog(page)
    await delay(500)

    lastStep = 'bấm nút "Đăng"'
    let posted = await clickTiktokButton(uploadFrame, {
      testId: 'post_video_button',
      textVariants: ['Đăng', 'Đăng tải', 'Post', 'Tải lên', 'Publish']
    })
    if (!posted && uploadFrame !== page) {
      posted = await clickTiktokButton(page, {
        testId: 'post_video_button',
        textVariants: ['Đăng', 'Đăng tải', 'Post', 'Tải lên', 'Publish']
      })
    }
    if (!posted) {
      for (const frame of page.frames()) {
        posted = await clickTiktokButton(frame, {
          testId: 'post_video_button',
          textVariants: ['Đăng', 'Đăng tải', 'Post', 'Tải lên', 'Publish']
        })
        if (posted) break
      }
    }
    if (!posted) {
      throw new Error('Không tìm thấy/không bấm được nút "Đăng" trên trang TikTok.')
    }
    printLog('Post ke TikTok', 'yellow')

    lastStep = 'chờ TikTok xác nhận đã đăng'
    const confirmDeadline = Date.now() + 120000
    let postConfirmed = false
    let lastReclickTime = Date.now()

    while (Date.now() < confirmDeadline) {
      // 1. Tự động bấm xác nhận lần 2 nếu TikTok hiện popup cảnh báo/kiểm tra bản quyền
      const confirmedSecondary = await clickTiktokButton(uploadFrame, { textVariants: SECONDARY_CONFIRM_LABELS }).catch(() => false)
      if (confirmedSecondary) {
        printLog('INFO: Đã bấm xác nhận phụ (Vẫn đăng / Post anyway / Xác nhận)...')
      } else if (uploadFrame !== page) {
        const confirmedPage = await clickTiktokButton(page, { textVariants: SECONDARY_CONFIRM_LABELS }).catch(() => false)
        if (confirmedPage) {
          printLog('INFO: Đã bấm xác nhận phụ trên page...')
        }
      }

      // 2. Kiểm tra dấu hiệu thành công (API trả về hoặc DOM hiện modal/quản lý bài đăng)
      if (apiPostSuccess || (await checkTiktokPostSuccess(page, uploadFrame))) {
        postConfirmed = true
        printLog('INFO: TikTok đã xác nhận đăng thành công (thấy modal hoặc API hoàn tất)!')
        break
      }

      // 3. Kiểm tra xem có thông báo lỗi từ chối đăng trên trang không
      const pageErr = (await checkTiktokPostError(uploadFrame)) || (uploadFrame !== page ? await checkTiktokPostError(page) : null)
      if (pageErr) {
        throw new Error(`TikTok từ chối đăng: ${pageErr}`)
      }

      // 4. Nếu nút "Post/Đăng" vẫn còn trên màn hình và đang enabled (chưa được gửi đi), kích hoạt bấm lại định kỳ
      if (Date.now() - lastReclickTime > 6000) {
        const postBtnStillUsable = (await checkPostButtonUsable(uploadFrame)) || (uploadFrame !== page ? await checkPostButtonUsable(page) : false)
        if (postBtnStillUsable) {
          printLog('INFO: Nút "Post/Đăng" vẫn còn trên màn hình, đang thử kích hoạt bấm lại...')
          await clickTiktokButton(uploadFrame, {
            testId: 'post_video_button',
            textVariants: ['Đăng', 'Đăng tải', 'Post', 'Tải lên', 'Publish']
          }).catch(() => { })
          if (uploadFrame !== page) {
            await clickTiktokButton(page, {
              testId: 'post_video_button',
              textVariants: ['Đăng', 'Đăng tải', 'Post', 'Tải lên', 'Publish']
            }).catch(() => { })
          }
          lastReclickTime = Date.now()
        }
      }

      await delay(2000)
    }

    if (!postConfirmed) {
      throw new Error('Đã bấm Đăng nhưng không nhận được xác nhận hoàn tất từ TikTok sau 2 phút — có thể mạng chậm hoặc video bị chặn.')
    }

    // Đợi thêm 5 giây để TikTok server đồng bộ xong hoàn toàn trước khi ngắt kết nối trình duyệt
    await delay(5000)

    lastStep = 'lấy link bài đăng'
    let postUrl = null
    try {
      postUrl = await page.evaluate(() => {
        const link = document.querySelector('a[href*="/video/"]')
        return link ? new URL(link.getAttribute('href'), 'https://www.tiktok.com').href : null
      })
    } catch (err) {
      printLog(`INFO: Không lấy được link bài đăng (${err.message})`)
    }

    await browser.close()
    printLog('Berhasil')
    return resolve({ status: 'success', message: 'Video đã đăng lên TikTok!', postUrl })
  } catch (err) {
    printLog(`ERROR: ${err.stack || err.message}`)
    const screenshotPath = await saveErrorScreenshot(page, `tiktok-${namafile}`)
    await browser.close()
    return resolve({
      status: 'error',
      message: `${err.message} [dừng ở bước: ${lastStep}]`,
      permanent: err.permanent === true,
      screenshotPath
    })
  }
})

// Nhãn tab "Photos" chỉ đúng khi giao diện TikTok đang tiếng Anh — kèm biến thể tiếng Việt làm
// lưới đỡ, giống NEXT_BUTTON_LABELS/POST_BUTTON_LABELS ở trên.
const PHOTO_TAB_LABELS = ['Photos', 'Ảnh']
const ADD_SOUND_LABELS = ['Add sound', 'Thêm nhạc']

/**
 * Bài ảnh (slideshow) không tự có nhạc như video — mở popup "Add sound" rồi lấy đúng bài ĐẦU
 * TIÊN trong tab "For You" (tab mặc định khi mở popup, đúng là danh sách nhạc TikTok tự gợi ý
 * theo tài khoản chứ không phải kết quả tìm kiếm) và bấm "Use". Best-effort — không tìm thấy gì
 * thì bỏ qua, không chặn việc đăng bài chỉ vì thiếu nhạc.
 */
async function addTiktokSuggestedSound(page) {
  const openedPicker = await waitForCondition(() => clickTiktokButton(page, { textVariants: ADD_SOUND_LABELS }), {
    timeout: 20000,
    interval: 1000
  })
  if (!openedPicker) {
    printLog('INFO: Không thấy nút "Add sound" — bỏ qua, đăng ảnh không kèm nhạc.')
    return false
  }

  // Panel "For You" load danh sách nhạc gợi ý bất đồng bộ sau khi popup mở — đợi tới khi có ít
  // nhất 1 dòng bài hát thay vì bấm ngay (panel rỗng lúc mới mở popup).
  const panelReady = await waitForCondition(
    () => page.evaluate(() => !!document.querySelector('.MusicPanelContainer__root .MusicPanelMusicItem__content')),
    { timeout: 20000, interval: 1000 }
  )
  if (!panelReady) {
    printLog('INFO: Danh sách nhạc gợi ý không tải được — bỏ qua, đăng ảnh không kèm nhạc.')
    return false
  }

  // Bấm bằng click chuột thật (elementHandle.click()) — lý do xem clickTiktokButton ở trên.
  const useHandle = await page.evaluateHandle(() => {
    const firstRow = document.querySelector('.MusicPanelContainer__root .MusicPanelMusicItem__content')
    return (
      firstRow &&
      Array.from(firstRow.querySelectorAll('button, div[role="button"]')).find(
        (el) => (el.textContent || '').trim() === 'Use'
      )
    )
  })
  const useEl = useHandle.asElement()
  if (!useEl) {
    printLog('INFO: Không tìm thấy nút "Use" ở bài nhạc gợi ý đầu tiên — bỏ qua, đăng ảnh không kèm nhạc.')
    return false
  }
  await triggerRealClick(page, useEl)
  printLog('INFO: Đã ghép nhạc gợi ý (bài đầu tiên, tab "For You").')
  return true
}

/**
 * Upload 1 bộ ảnh (album/slideshow) lên TikTok qua TikTok Studio, dùng tab "Photos" thay vì
 * "Videos" mặc định. Cùng cơ chế với TiktokUpload (đóng popup phụ, click chuột thật thay vì
 * DOM .click()) — chỉ khác bước chọn tab và tải nhiều file ảnh cùng lúc thay vì 1 file video.
 */
export const TiktokUploadImages = (filePaths, caption, cookies) => new Promise(async (resolve) => {
  const browser = await puppeteer.launch(browserOptions)
  const page = await browser.newPage()
  await page.setViewport({ width: 1920, height: 1080 })
  const resolvedCookies = await resolveCookies(cookies)
  const label = `images-${path.basename(filePaths[0] || 'unknown').replace(/\.[^.]+$/, '')}`

  let apiPostSuccess = false
  page.on('response', async (res) => {
    try {
      const u = res.url()
      if (
        u.includes('/project/post/') ||
        u.includes('/content/post/') ||
        u.includes('/aweme/v1/create/') ||
        u.includes('/item/create/') ||
        u.includes('/web/project/post') ||
        u.includes('/tiktokstudio/web/item/create')
      ) {
        const json = await res.json().catch(() => null)
        printLog(`DEBUG: TikTok API response [${res.status()}] ${u.slice(0, 80)} -> ${JSON.stringify(json || {}).slice(0, 100)}`)
        if (json && (json.status_code === 0 || json.status_msg === 'success' || json.status === 'success' || json.data?.item_id || json.item_id)) {
          apiPostSuccess = true
        }
      }
    } catch (e) { }
  })

  let lastStep = 'khởi tạo trình duyệt'

  if (!resolvedCookies || resolvedCookies.length === 0) {
    await browser.close()
    const message = 'Hồ sơ đăng không có cookie hợp lệ — vào trang Hồ sơ đăng để dán lại cookie JSON.'
    printLog(`ERROR: ${message}`)
    return resolve({ status: 'error', message, permanent: true })
  }

  const missing = []
  for (const p of filePaths) {
    if (!(await fs.pathExists(p))) missing.push(p)
  }
  if (missing.length > 0) {
    await browser.close()
    const message = `Không tìm thấy ${missing.length} file ảnh đã tải về (vd ${missing[0]}).`
    printLog(`ERROR: ${message}`)
    return resolve({ status: 'error', message, permanent: false })
  }

  printLog('INFO: Session ditemukan, mencoba akses TikTok (đăng ảnh)...')
  await page.setCookie(...resolvedCookies)
  try {
    lastStep = 'mở trang tải video/ảnh lên TikTok'
    await page.goto(TIKTOK_UPLOAD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })

    if (TIKTOK_LOGGED_OUT_URL_PATTERN.test(page.url())) {
      const err = new Error(
        'Cookie của hồ sơ TikTok đã hết hạn hoặc bị chặn (bị chuyển về trang đăng nhập). ' +
        'Vào trang Hồ sơ đăng để cập nhật lại cookie.'
      )
      err.permanent = true
      throw err
    }

    // Trang mặc định mở ở tab "Videos" — phải bấm sang tab "Photos" rồi khung tải ảnh (input
    // riêng, khác input của tab Videos) mới xuất hiện. TikTok Studio là SPA nặng — domcontentloaded
    // xong chỉ mới thấy màn hình loading trắng, tab còn chưa render kịp nên phải thử theo điều
    // kiện (giống cách chờ input[type=file] ở TiktokUpload) chứ không click 1 lần rồi thôi.
    lastStep = 'bấm tab "Photos"'
    const switchedTab = await waitForCondition(() => clickTiktokButton(page, { textVariants: PHOTO_TAB_LABELS }), {
      timeout: 30000,
      interval: 1000
    })
    if (!switchedTab) {
      printLog('INFO: Không thấy tab "Photos" để bấm — thử tìm ô tải ảnh luôn (có thể trang đã ở đúng tab).')
    }
    await delay(1500)

    lastStep = 'chọn file ảnh để tải lên'
    let fileInput = null
    let uploadFrame = page
    const findFileInputDeadline = Date.now() + 45000
    while (!fileInput && Date.now() < findFileInputDeadline) {
      fileInput = (await page.$$('input[type="file"]'))[0] || null
      if (fileInput) {
        uploadFrame = page
        break
      }
      for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue
        const found = (await frame.$$('input[type="file"]').catch(() => []))[0]
        if (found) {
          fileInput = found
          uploadFrame = frame
          break
        }
      }
      if (!fileInput) await delay(1000)
    }
    if (!fileInput) {
      throw new Error('Không tìm thấy ô tải ảnh lên trên trang TikTok sau 45s chờ — giao diện có thể đã thay đổi.')
    }
    // input[type=file] của tab Photos nhận nhiều file 1 lượt — truyền cả mảng đường dẫn.
    await fileInput.uploadFile(...filePaths)
    printLog(`sukses Upload ${filePaths.length} ảnh`)
    await delay(1500)

    // Bài ảnh không tự có nhạc như video — ghép nhạc gợi ý của TikTok (bài đầu tiên, tab "For
    // You") vào ngay sau khi ảnh đã lên khung, trước khi đợi nút "Đăng" sẵn sàng.
    lastStep = 'ghép nhạc gợi ý của TikTok'
    await addTiktokSuggestedSound(uploadFrame)
    await delay(1000)

    // Khác tab Videos: nút "Đăng" của tab Photos KHÔNG có data-e2e="post_video_button" (đã kiểm
    // chứng thực tế — thuộc tính data-e2e rỗng), chỉ nhận diện được qua text hiển thị.
    lastStep = 'đợi TikTok xử lý xong ảnh vừa tải lên'
    const postButtonTextVariants = ['Đăng', 'Đăng tải', 'Post', 'Tải lên', 'Publish']
    const ready = await waitForCondition(
      async () => {
        await dismissTiktokDialog(uploadFrame)
        if (uploadFrame !== page) await dismissTiktokDialog(page)
        return (await checkPostButtonUsable(uploadFrame)) || (uploadFrame !== page ? await checkPostButtonUsable(page) : false)
      },
      { timeout: 120000, interval: 2000 }
    )
    if (!ready) {
      printLog('INFO: Nút "Đăng" vẫn chưa sẵn sàng sau thời gian chờ, vẫn thử bấm.')
    }

    lastStep = 'nhập caption'
    const [captionBox] = await uploadFrame.$$('div[contenteditable="true"]')
    if (captionBox && caption) {
      await captionBox.click()
      await captionBox.type(`${caption}`)
      printLog('Menginput Caption...')
    }
    await delay(1500)

    lastStep = 'đóng popup phụ (nếu có) trước khi đăng'
    await dismissTiktokDialog(uploadFrame)
    if (uploadFrame !== page) await dismissTiktokDialog(page)
    await delay(500)

    lastStep = 'bấm nút "Đăng"'
    let posted = await clickTiktokButton(uploadFrame, {
      testId: 'post_video_button',
      textVariants: postButtonTextVariants
    })
    if (!posted && uploadFrame !== page) {
      posted = await clickTiktokButton(page, {
        testId: 'post_video_button',
        textVariants: postButtonTextVariants
      })
    }
    if (!posted) {
      for (const frame of page.frames()) {
        posted = await clickTiktokButton(frame, {
          testId: 'post_video_button',
          textVariants: postButtonTextVariants
        })
        if (posted) break
      }
    }
    if (!posted) {
      throw new Error('Không tìm thấy/không bấm được nút "Đăng" trên trang TikTok.')
    }
    printLog('Post ảnh lên TikTok', 'yellow')

    lastStep = 'chờ TikTok xác nhận đã đăng'
    const confirmDeadline = Date.now() + 120000
    let postConfirmed = false
    let lastReclickTime = Date.now()

    while (Date.now() < confirmDeadline) {
      // 1. Tự động bấm xác nhận lần 2 nếu TikTok hiện popup cảnh báo/kiểm tra bản quyền
      const confirmedSecondary = await clickTiktokButton(uploadFrame, { textVariants: SECONDARY_CONFIRM_LABELS }).catch(() => false)
      if (confirmedSecondary) {
        printLog('INFO: Đã bấm xác nhận phụ (Vẫn đăng / Post anyway / Xác nhận)...')
      } else if (uploadFrame !== page) {
        const confirmedPage = await clickTiktokButton(page, { textVariants: SECONDARY_CONFIRM_LABELS }).catch(() => false)
        if (confirmedPage) {
          printLog('INFO: Đã bấm xác nhận phụ trên page...')
        }
      }

      // 2. Kiểm tra dấu hiệu thành công (API trả về hoặc DOM hiện modal/quản lý bài đăng)
      if (apiPostSuccess || (await checkTiktokPostSuccess(page, uploadFrame))) {
        postConfirmed = true
        printLog('INFO: TikTok đã xác nhận đăng ảnh thành công (thấy modal hoặc API hoàn tất)!')
        break
      }

      // 3. Kiểm tra xem có thông báo lỗi từ chối đăng trên trang không
      const pageErr = (await checkTiktokPostError(uploadFrame)) || (uploadFrame !== page ? await checkTiktokPostError(page) : null)
      if (pageErr) {
        throw new Error(`TikTok từ chối đăng: ${pageErr}`)
      }

      // 4. Nếu nút "Post/Đăng" vẫn còn trên màn hình và đang enabled (chưa được gửi đi), kích hoạt bấm lại định kỳ
      if (Date.now() - lastReclickTime > 6000) {
        const postBtnStillUsable = (await checkPostButtonUsable(uploadFrame)) || (uploadFrame !== page ? await checkPostButtonUsable(page) : false)
        if (postBtnStillUsable) {
          printLog('INFO: Nút "Post/Đăng" vẫn còn trên màn hình, đang thử kích hoạt bấm lại...')
          await clickTiktokButton(uploadFrame, {
            testId: 'post_video_button',
            textVariants: postButtonTextVariants
          }).catch(() => { })
          if (uploadFrame !== page) {
            await clickTiktokButton(page, {
              testId: 'post_video_button',
              textVariants: postButtonTextVariants
            }).catch(() => { })
          }
          lastReclickTime = Date.now()
        }
      }

      await delay(2000)
    }

    if (!postConfirmed) {
      throw new Error('Đã bấm Đăng nhưng không nhận được xác nhận hoàn tất từ TikTok sau 2 phút — có thể mạng chậm hoặc bài đăng bị chặn.')
    }

    // Đợi thêm 5 giây để TikTok server đồng bộ xong hoàn toàn trước khi ngắt kết nối trình duyệt
    await delay(5000)

    lastStep = 'lấy link bài đăng'
    let postUrl = null
    try {
      postUrl = await page.evaluate(() => {
        const link = document.querySelector('a[href*="/photo/"], a[href*="/video/"]')
        return link ? new URL(link.getAttribute('href'), 'https://www.tiktok.com').href : null
      })
    } catch (err) {
      printLog(`INFO: Không lấy được link bài đăng (${err.message})`)
    }

    await browser.close()
    printLog('Berhasil')
    return resolve({ status: 'success', message: 'Bài ảnh đã đăng lên TikTok!', postUrl })
  } catch (err) {
    printLog(`ERROR: ${err.stack || err.message}`)
    const screenshotPath = await saveErrorScreenshot(page, `tiktok-${label}`)
    await browser.close()
    return resolve({
      status: 'error',
      message: `${err.message} [dừng ở bước: ${lastStep}]`,
      permanent: err.permanent === true,
      screenshotPath
    })
  }
})
