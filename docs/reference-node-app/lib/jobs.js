import { run, all, get } from './db.js'

function toJob(row) {
  if (!row) return null
  return {
    id: row.id,
    userId: row.user_id,
    videoUrl: row.video_url,
    profileId: row.profile_id,
    profileLabel: row.profile_label,
    platform: row.platform || 'facebook',
    caption: row.caption || '',
    scheduledAt: row.scheduled_at,
    status: row.status,
    message: row.message || '',
    postUrl: row.post_url || null,
    batchId: row.batch_id || null,
    precheckAt: row.precheck_at || null,
    attempts: row.attempts || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/** profileId (tuỳ chọn) lọc thêm theo hồ sơ/Page đang chọn — không truyền thì lấy job của mọi hồ sơ. */
export function listJobs(userId, profileId) {
  if (profileId) {
    return all('SELECT * FROM jobs WHERE user_id = ? AND profile_id = ? ORDER BY created_at DESC', [userId, profileId]).map(
      toJob
    )
  }
  return all('SELECT * FROM jobs WHERE user_id = ? ORDER BY created_at DESC', [userId]).map(toJob)
}

export function addJob(userId, { videoUrl, profileId, profileLabel, platform, caption, scheduledAt, batchId = null, status = 'pending' }) {
  const id = `job-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const now = Date.now()
  run(
    `INSERT INTO jobs (id, user_id, video_url, profile_id, profile_label, platform, caption, scheduled_at, status, message, batch_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)`,
    [id, userId, videoUrl, profileId, profileLabel, platform || 'facebook', caption || '', scheduledAt, status, batchId, now, now]
  )
  return toJob(get('SELECT * FROM jobs WHERE id = ?', [id]))
}

export function newBatchId() {
  return `batch-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

/** Còn bao nhiêu job trong lô chưa chạy xong — bằng 0 nghĩa là cả lô đã kết thúc. */
export function countBatchRemaining(batchId) {
  const row = get("SELECT COUNT(*) as count FROM jobs WHERE batch_id = ? AND status IN ('pending', 'running')", [batchId])
  return row.count
}

/** Tổng kết 1 lô để gửi thông báo: đếm thành công/thất bại + liệt kê chi tiết các job hỏng. */
export function getBatchSummary(batchId) {
  const jobs = all('SELECT * FROM jobs WHERE batch_id = ? ORDER BY scheduled_at ASC', [batchId]).map(toJob)
  const failures = jobs.filter((j) => j.status === 'failed')
  return {
    batchId,
    userId: jobs[0]?.userId,
    profileLabel: jobs[0]?.profileLabel || '',
    total: jobs.length,
    success: jobs.filter((j) => j.status === 'success').length,
    failed: failures.length,
    cancelled: jobs.filter((j) => j.status === 'cancelled').length,
    failures
  }
}

/**
 * Job sắp tới giờ đăng (trong vòng `leadMs` nữa) mà chưa được kiểm tra cookie lần nào.
 * Bỏ qua job đã quá giờ (scheduled_at <= now) vì chúng sắp được đăng ngay ở lượt quét này rồi,
 * kiểm tra trước cũng không kịp làm gì.
 */
export function findJobsNeedingCookieCheck(leadMs) {
  const now = Date.now()
  return all(
    `SELECT * FROM jobs
     WHERE status = 'pending' AND precheck_at IS NULL AND scheduled_at > ? AND scheduled_at <= ?
     ORDER BY scheduled_at ASC`,
    [now, now + leadMs]
  ).map(toJob)
}

/** Ghi nhận job vừa được thử đăng thêm một lượt. */
export function bumpAttempts(id) {
  run('UPDATE jobs SET attempts = attempts + 1, updated_at = ? WHERE id = ?', [Date.now(), id])
}

export function markPrechecked(id) {
  run('UPDATE jobs SET precheck_at = ? WHERE id = ?', [Date.now(), id])
}

/** Chỉ scheduler nội bộ dùng — không lọc theo user vì chạy nền cho mọi user. */
export function updateJob(id, patch) {
  const fields = []
  const params = []
  if (patch.status !== undefined) {
    fields.push('status = ?')
    params.push(patch.status)
  }
  if (patch.message !== undefined) {
    fields.push('message = ?')
    params.push(patch.message)
  }
  if (patch.postUrl !== undefined) {
    fields.push('post_url = ?')
    params.push(patch.postUrl)
  }
  fields.push('updated_at = ?')
  params.push(Date.now())
  params.push(id)

  run(`UPDATE jobs SET ${fields.join(', ')} WHERE id = ?`, params)
  return toJob(get('SELECT * FROM jobs WHERE id = ?', [id]))
}

/**
 * Job "sau" job vừa huỷ (cùng lô, còn pending, giờ đăng muộn hơn) dịch lên sớm hơn để lấp đúng
 * chỗ trống job vừa huỷ để lại — thay vì mỗi job giữ nguyên giờ cũ và để hở 1 khung giờ.
 * Chỉ dịch trong phạm vi các mốc giờ ĐÃ CÓ SẴN của lô (không phát minh mốc mới), nên không đụng
 * gì tới cấu hình khung giờ ban đầu của lô.
 */
function compactSchedulesAfterCancel(userId, batchId, cancelledScheduledAt) {
  if (!batchId) return 0
  const laterJobs = all(
    "SELECT id, scheduled_at FROM jobs WHERE user_id = ? AND batch_id = ? AND status = 'pending' AND scheduled_at > ? ORDER BY scheduled_at ASC, created_at ASC",
    [userId, batchId, cancelledScheduledAt]
  )
  if (laterJobs.length === 0) return 0

  // Mốc giờ job vừa huỷ để lại, cộng mốc giờ của từng job sau nó — bỏ mốc cuối cùng vì giờ dư
  // ra (không job pending nào cần tới nữa).
  const slots = [cancelledScheduledAt, ...laterJobs.map((j) => j.scheduled_at)].slice(0, -1)
  const now = Date.now()
  laterJobs.forEach((job, i) => {
    run('UPDATE jobs SET scheduled_at = ?, updated_at = ? WHERE id = ?', [slots[i], now, job.id])
  })
  return laterJobs.length
}

/** compact: true để dồn giờ đăng của các job pending sau đó (cùng lô) lên sớm hơn, lấp chỗ trống. */
export function cancelJob(userId, id, { compact = false } = {}) {
  const job = get('SELECT * FROM jobs WHERE id = ? AND user_id = ?', [id, userId])
  if (!job || job.status !== 'pending') return false
  run("UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE id = ?", [Date.now(), id])
  if (compact) {
    compactSchedulesAfterCancel(userId, job.batch_id, job.scheduled_at)
  }
  return true
}

/** Xoá hẳn (không phải huỷ) toàn bộ job 'pending' của hồ sơ đang chọn — dọn sạch hàng đợi thay vì bấm huỷ từng job. */
export function deleteAllPending(userId, profileId) {
  const where = profileId ? 'user_id = ? AND profile_id = ? AND status = ?' : 'user_id = ? AND status = ?'
  const params = profileId ? [userId, profileId, 'pending'] : [userId, 'pending']
  const count = get(`SELECT COUNT(*) as count FROM jobs WHERE ${where}`, params).count
  if (count > 0) run(`DELETE FROM jobs WHERE ${where}`, params)
  return count
}

/** Đưa 1 job thất bại về hàng đợi, đăng lại ngay — chỉ cho phép với job của chính user đó. */
export function retryJob(userId, id) {
  const job = get('SELECT * FROM jobs WHERE id = ? AND user_id = ?', [id, userId])
  if (!job || job.status !== 'failed') return null
  run("UPDATE jobs SET status = 'pending', message = '', scheduled_at = ?, updated_at = ? WHERE id = ?", [
    Date.now(),
    Date.now(),
    id
  ])
  return toJob(get('SELECT * FROM jobs WHERE id = ?', [id]))
}

/** Có job pending/running nào khác (khác id) đang chờ đúng videoUrl này không — dùng để biết có an toàn xoá file cache vật lý hay chưa. */
export function hasOtherPendingJobForVideo(videoUrl, excludeId) {
  const row = get("SELECT id FROM jobs WHERE video_url = ? AND id != ? AND status IN ('pending', 'running') LIMIT 1", [
    videoUrl,
    excludeId
  ])
  return !!row
}

/**
 * Trong `videoUrls`, những link nào đã có job chờ đăng / đang đăng / đã đăng thành công lên
 * cùng 1 hồ sơ — dùng để không lên lịch trùng (đăng cùng 1 video 2 lần lên cùng 1 Page).
 * So khớp theo chuỗi URL nguyên văn: link rút gọn và link đầy đủ của cùng 1 video sẽ không
 * nhận ra nhau, vì muốn biết chắc thì phải gọi mạng resolve từng link (rất chậm khi dán hàng loạt).
 */
export function findExistingJobUrls(userId, profileId, videoUrls) {
  if (videoUrls.length === 0) return new Set()
  const placeholders = videoUrls.map(() => '?').join(', ')
  const rows = all(
    `SELECT DISTINCT video_url FROM jobs
     WHERE user_id = ? AND profile_id = ? AND status IN ('pending', 'running', 'success')
       AND video_url IN (${placeholders})`,
    [userId, profileId, ...videoUrls]
  )
  return new Set(rows.map((r) => r.video_url))
}

/** Các mốc giờ đã có job chờ đăng/đang đăng của 1 hồ sơ — để lần lên lịch sau không xếp đè lên. */
export function listTakenSlots(userId, profileId, excludeBatchId = null) {
  if (excludeBatchId) {
    const rows = all(
      "SELECT scheduled_at FROM jobs WHERE user_id = ? AND profile_id = ? AND status IN ('pending', 'running') AND (batch_id IS NULL OR batch_id != ?)",
      [userId, profileId, excludeBatchId]
    )
    return new Set(rows.map((r) => r.scheduled_at))
  }
  const rows = all(
    "SELECT scheduled_at FROM jobs WHERE user_id = ? AND profile_id = ? AND status IN ('pending', 'running')",
    [userId, profileId]
  )
  return new Set(rows.map((r) => r.scheduled_at))
}

export function saveBatchRecord(userId, { batchId, profileId, profileLabel, mode, scheduleConfig, createdAt }) {
  const now = createdAt || Date.now()
  const configStr = typeof scheduleConfig === 'string' ? scheduleConfig : JSON.stringify(scheduleConfig || {})
  run(
    `INSERT OR REPLACE INTO batches (id, user_id, profile_id, profile_label, mode, schedule_config, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [batchId, userId, profileId, profileLabel, mode || 'daily', configStr, now]
  )
}

export function syncLegacyBatches(userId) {
  const missingBatches = all(
    `SELECT DISTINCT j.batch_id, j.user_id, j.profile_id, j.profile_label, MIN(j.created_at) as created_at
     FROM jobs j
     LEFT JOIN batches b ON j.batch_id = b.id
     WHERE j.user_id = ? AND j.batch_id IS NOT NULL AND (b.id IS NULL OR b.schedule_config LIKE '%"08:00","12:00","18:00"%' OR b.schedule_config LIKE '%"13:44"%')
     GROUP BY j.batch_id`,
    [userId]
  )

  for (const b of missingBatches) {
    if (!b.batch_id) continue

    // Lấy các job pending trước để trích xuất mốc giờ sạch chuẩn xác, nếu không có mới lấy toàn bộ job
    let batchJobs = all(
      "SELECT scheduled_at FROM jobs WHERE batch_id = ? AND status = 'pending' ORDER BY scheduled_at ASC",
      [b.batch_id]
    )
    if (batchJobs.length === 0) {
      batchJobs = all(
        'SELECT scheduled_at FROM jobs WHERE batch_id = ? ORDER BY scheduled_at ASC',
        [b.batch_id]
      )
    }

    const timesSet = new Set()
    let startDateStr = ''

    if (batchJobs.length > 0) {
      const firstDate = new Date(batchJobs[0].scheduled_at)
      const yyyy = firstDate.getFullYear()
      const mm = String(firstDate.getMonth() + 1).padStart(2, '0')
      const dd = String(firstDate.getDate()).padStart(2, '0')
      startDateStr = `${yyyy}-${mm}-${dd}`

      for (const j of batchJobs) {
        const d = new Date(j.scheduled_at)
        const hh = String(d.getHours()).padStart(2, '0')
        const min = String(d.getMinutes()).padStart(2, '0')
        timesSet.add(`${hh}:${min}`)
      }
    }

    const extractedTimes = Array.from(timesSet).sort()
    const dailyTimes = extractedTimes.length > 0 ? extractedTimes : ['08:00', '12:00', '18:00']

    saveBatchRecord(userId, {
      batchId: b.batch_id,
      profileId: b.profile_id,
      profileLabel: b.profile_label || 'Hồ sơ',
      mode: 'daily',
      scheduleConfig: { dailyTimes, startDate: startDateStr },
      createdAt: b.created_at
    })
  }
}

export function getBatch(userId, batchId) {
  syncLegacyBatches(userId)
  const row = get('SELECT * FROM batches WHERE id = ? AND user_id = ?', [batchId, userId])
  if (!row) return null
  let config = {}
  try {
    config = JSON.parse(row.schedule_config)
  } catch (e) {}
  return {
    id: row.id,
    userId: row.user_id,
    profileId: row.profile_id,
    profileLabel: row.profile_label,
    mode: row.mode,
    scheduleConfig: config,
    createdAt: row.created_at
  }
}

export function listBatches(userId, profileId) {
  syncLegacyBatches(userId)
  const where = profileId ? 'user_id = ? AND profile_id = ?' : 'user_id = ?'
  const params = profileId ? [userId, profileId] : [userId]
  const rows = all(`SELECT * FROM batches WHERE ${where} ORDER BY created_at DESC`, params)
  return rows.map((r) => {
    let config = {}
    try {
      config = JSON.parse(r.schedule_config)
    } catch (e) {}
    const statsRow = get(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) as success,
              SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) as pending,
              SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed,
              SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) as cancelled
       FROM jobs WHERE batch_id = ?`,
      [r.id]
    )
    return {
      id: r.id,
      userId: r.user_id,
      profileId: r.profile_id,
      profileLabel: r.profile_label,
      mode: r.mode,
      scheduleConfig: config,
      createdAt: r.created_at,
      stats: {
        total: statsRow?.total || 0,
        success: statsRow?.success || 0,
        pending: statsRow?.pending || 0,
        failed: statsRow?.failed || 0,
        cancelled: statsRow?.cancelled || 0
      }
    }
  })
}

export function rescheduleBatchJobs(userId, batchId, newTimestamps) {
  const pendingJobs = all(
    "SELECT id FROM jobs WHERE user_id = ? AND batch_id = ? AND status = 'pending' ORDER BY scheduled_at ASC, created_at ASC",
    [userId, batchId]
  )
  if (pendingJobs.length === 0) return 0

  const now = Date.now()
  let count = 0
  for (let i = 0; i < pendingJobs.length; i++) {
    if (i < newTimestamps.length) {
      run('UPDATE jobs SET scheduled_at = ?, updated_at = ? WHERE id = ?', [newTimestamps[i], now, pendingJobs[i].id])
      count++
    }
  }
  return count
}

export function updateJobDetails(userId, id, { scheduledAt, caption }) {
  const job = get('SELECT * FROM jobs WHERE id = ? AND user_id = ?', [id, userId])
  if (!job || job.status !== 'pending') return null

  const fields = ['updated_at = ?']
  const params = [Date.now()]

  if (scheduledAt) {
    fields.push('scheduled_at = ?')
    params.push(scheduledAt)
  }
  if (caption !== undefined) {
    fields.push('caption = ?')
    params.push(caption.trim())
  }
  params.push(id)

  run(`UPDATE jobs SET ${fields.join(', ')} WHERE id = ?`, params)
  return toJob(get('SELECT * FROM jobs WHERE id = ?', [id]))
}

/**
 * Job còn đang ở trạng thái 'running' lúc server vừa khởi động chắc chắn là job bị bỏ dở do
 * restart/crash (scheduler chạy tuần tự, không thể có job nào đang chạy thật lúc này). Đánh dấu
 * failed để người dùng bấm "Thử lại" được — nếu để nguyên 'running' thì job đó kẹt vĩnh viễn:
 * scheduler chỉ nhặt job 'pending', còn retryJob chỉ nhận job 'failed'.
 */
export function resetStuckRunningJobs() {
  const stuck = all("SELECT id FROM jobs WHERE status = 'running'")
  if (stuck.length === 0) return 0
  run("UPDATE jobs SET status = 'failed', message = ?, updated_at = ? WHERE status = 'running'", [
    'Server khởi động lại khi job đang chạy — bấm "Thử lại" để đăng lại.',
    Date.now()
  ])
  return stuck.length
}

/**
 * Quét toàn bộ user tìm mọi job pending đã tới giờ, cũ nhất trước — dùng cho scheduler nền.
 * Trả về tất cả (không LIMIT 1) vì scheduler chạy song song theo hồ sơ: mỗi tick có thể bắt đầu
 * nhiều job cùng lúc, miễn mỗi hồ sơ chỉ có tối đa 1 job đang chạy.
 */
export function findDuePendingJobs() {
  const now = Date.now()
  return all('SELECT * FROM jobs WHERE status = ? AND scheduled_at <= ? ORDER BY scheduled_at ASC', ['pending', now]).map(
    toJob
  )
}

/** Huỷ hàng loạt job pending — bỏ qua job đã không còn pending (không báo lỗi). */
export function bulkCancel(userId, ids) {
  if (!ids || ids.length === 0) return 0
  const placeholders = ids.map(() => '?').join(', ')
  const result = all(
    `SELECT id FROM jobs WHERE user_id = ? AND status = 'pending' AND id IN (${placeholders})`,
    [userId, ...ids]
  )
  const validIds = result.map((r) => r.id)
  if (validIds.length === 0) return 0
  const p2 = validIds.map(() => '?').join(', ')
  run(`UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE id IN (${p2})`, [Date.now(), ...validIds])
  return validIds.length
}

/** Retry hàng loạt job failed — đặt lại scheduledAt = ngay bây giờ. Bỏ qua job không phải failed. */
export function bulkRetry(userId, ids) {
  if (!ids || ids.length === 0) return 0
  const placeholders = ids.map(() => '?').join(', ')
  const result = all(
    `SELECT id FROM jobs WHERE user_id = ? AND status = 'failed' AND id IN (${placeholders})`,
    [userId, ...ids]
  )
  const validIds = result.map((r) => r.id)
  if (validIds.length === 0) return 0
  const now = Date.now()
  const p2 = validIds.map(() => '?').join(', ')
  run(
    `UPDATE jobs SET status = 'pending', message = '', scheduled_at = ?, updated_at = ? WHERE id IN (${p2})`,
    [now, now, ...validIds]
  )
  return validIds.length
}

/** Duyệt hàng loạt job đang "chờ duyệt" (từ kênh theo dõi tự động) → chuyển sang pending để scheduler nhặt lên bình thường. */
export function bulkApprove(userId, ids) {
  if (!ids || ids.length === 0) return 0
  const placeholders = ids.map(() => '?').join(', ')
  const result = all(
    `SELECT id FROM jobs WHERE user_id = ? AND status = 'awaiting_approval' AND id IN (${placeholders})`,
    [userId, ...ids]
  )
  const validIds = result.map((r) => r.id)
  if (validIds.length === 0) return 0
  const p2 = validIds.map(() => '?').join(', ')
  run(`UPDATE jobs SET status = 'pending', updated_at = ? WHERE id IN (${p2})`, [Date.now(), ...validIds])
  return validIds.length
}

/** Từ chối hàng loạt job "chờ duyệt" — xoá hẳn (khác Huỷ: đây chỉ là gợi ý chưa từng thật sự lên lịch). */
export function bulkReject(userId, ids) {
  if (!ids || ids.length === 0) return 0
  const placeholders = ids.map(() => '?').join(', ')
  const result = all(
    `SELECT id FROM jobs WHERE user_id = ? AND status = 'awaiting_approval' AND id IN (${placeholders})`,
    [userId, ...ids]
  )
  const validIds = result.map((r) => r.id)
  if (validIds.length === 0) return 0
  const p2 = validIds.map(() => '?').join(', ')
  run(`DELETE FROM jobs WHERE id IN (${p2})`, validIds)
  return validIds.length
}

/** Clone 1 job thành công/thất bại → job mới với hồ sơ và giờ có thể khác. */
export function cloneJob(userId, sourceId, { profileId, profileLabel, platform, scheduledAt }) {
  const source = get('SELECT * FROM jobs WHERE id = ? AND user_id = ?', [sourceId, userId])
  if (!source) throw new Error('Job nguồn không tồn tại.')
  return addJob(userId, {
    videoUrl: source.video_url,
    profileId,
    profileLabel,
    platform,
    caption: source.caption || '',
    scheduledAt
  })
}

/**
 * Thống kê job theo ngày trong N ngày gần nhất — dùng cho dashboard.
 * Trả về { counts: { pending, running, success, failed, cancelled, all },
 *           daily: [{ date: 'YYYY-MM-DD', success, failed }] }
 */
export function getJobStats(userId, days = 7) {
  const counts = { pending: 0, running: 0, success: 0, failed: 0, cancelled: 0, awaiting_approval: 0, all: 0 }
  const allRows = all('SELECT status FROM jobs WHERE user_id = ?', [userId])
  allRows.forEach((r) => {
    counts.all++
    if (counts[r.status] !== undefined) counts[r.status]++
  })

  const since = Date.now() - days * 24 * 60 * 60 * 1000
  const recentRows = all(
    "SELECT status, updated_at FROM jobs WHERE user_id = ? AND updated_at >= ? AND status IN ('success','failed')",
    [userId, since]
  )

  const dailyMap = {}
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    dailyMap[key] = { date: key, success: 0, failed: 0 }
  }
  recentRows.forEach((r) => {
    const d = new Date(r.updated_at)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    if (dailyMap[key]) dailyMap[key][r.status]++
  })

  return { counts, daily: Object.values(dailyMap) }
}
