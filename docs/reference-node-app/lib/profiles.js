import { run, all, get } from './db.js'
import { deleteAllPending } from './jobs.js'

const PLATFORMS = ['facebook', 'tiktok']

function toPublicProfile(row) {
  if (!row) return null
  return {
    id: row.id,
    label: row.label,
    platform: row.platform || 'facebook',
    createdAt: row.created_at,
    // null = chưa kiểm tra lần nào
    cookieCheckedAt: row.cookie_checked_at || null,
    cookieOk: row.cookie_checked_at ? row.cookie_ok === 1 : null,
    cookieReason: row.cookie_reason || null
  }
}

/** Lưu kết quả kiểm tra cookie gần nhất, dùng chung cho cả nút bấm tay lẫn lượt kiểm tự động. */
export function setCookieCheckResult(profileId, ok, reason) {
  run('UPDATE profiles SET cookie_checked_at = ?, cookie_ok = ?, cookie_reason = ? WHERE id = ?', [
    Date.now(),
    ok ? 1 : 0,
    ok ? null : reason || 'Không rõ lý do',
    profileId
  ])
}

export function listProfiles(userId) {
  return all('SELECT * FROM profiles WHERE user_id = ? ORDER BY created_at ASC', [userId]).map(toPublicProfile)
}

/** Trả về profile đầy đủ (kèm cookies_json) — chỉ dùng nội bộ (scheduler, ReelsUpload), không trả ra API. */
export function getProfileRaw(userId, profileId) {
  return get('SELECT * FROM profiles WHERE id = ? AND user_id = ?', [profileId, userId])
}

export function getProfile(userId, profileId) {
  return toPublicProfile(getProfileRaw(userId, profileId))
}

export function addProfile(userId, { label, cookiesJsonText, platform }) {
  if (!label || !label.trim()) {
    throw new Error('Thiếu tên hiển thị cho hồ sơ.')
  }

  let parsed
  try {
    parsed = JSON.parse(cookiesJsonText)
  } catch (err) {
    throw new Error('Nội dung cookie không phải JSON hợp lệ.')
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('Cookie JSON phải là một mảng không rỗng.')
  }

  const platformValue = PLATFORMS.includes(platform) ? platform : 'facebook'

  const id = run('INSERT INTO profiles (user_id, label, cookies_json, platform, created_at) VALUES (?, ?, ?, ?, ?)', [
    userId,
    label.trim(),
    JSON.stringify(parsed),
    platformValue,
    Date.now()
  ])
  return toPublicProfile(get('SELECT * FROM profiles WHERE id = ?', [id]))
}

export function deleteProfile(userId, profileId) {
  const target = getProfileRaw(userId, profileId)
  if (!target) return false
  run('DELETE FROM profiles WHERE id = ? AND user_id = ?', [profileId, userId])
  // Job 'pending' của hồ sơ vừa xoá sẽ mãi mãi thất bại với "Hồ sơ đăng đã bị xoá." (attemptUpload
  // ở server.js) — dọn luôn hàng chờ thay vì để rác lại trong DB không ai xử lý được nữa.
  deleteAllPending(userId, profileId)
  return true
}

/**
 * Cập nhật cookie của hồ sơ mà không thay đổi profile_id — mọi job đang chờ sẽ
 * tự dùng cookie mới ở lần chạy tiếp theo (processJob đọc cookie từ DB lúc chạy).
 */
export function updateProfileCookies(userId, profileId, cookiesJsonText) {
  const target = getProfileRaw(userId, profileId)
  if (!target) throw new Error('Hồ sơ không tồn tại.')

  let parsed
  try {
    parsed = JSON.parse(cookiesJsonText)
  } catch (err) {
    throw new Error('Nội dung cookie không phải JSON hợp lệ.')
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('Cookie JSON phải là một mảng không rỗng.')
  }

  run('UPDATE profiles SET cookies_json = ? WHERE id = ? AND user_id = ?', [
    JSON.stringify(parsed),
    profileId,
    userId
  ])
  return toPublicProfile(getProfileRaw(userId, profileId))
}
