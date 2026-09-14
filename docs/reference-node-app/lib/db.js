// SQLite qua sql.js (SQLite biên dịch sẵn dạng WASM, không cần native build tools).
// sql.js chạy hoàn toàn trong bộ nhớ — mọi thay đổi phải persist() ra file thủ công.
import initSqlJs from 'sql.js'
import fs from 'fs-extra'
import path from 'path'

const DB_FILE = path.resolve('./data.db')

let SQL
let db

export async function initDb() {
  if (db) return db

  SQL = await initSqlJs()

  if (await fs.pathExists(DB_FILE)) {
    const fileBuffer = await fs.readFile(DB_FILE)
    db = new SQL.Database(fileBuffer)
  } else {
    db = new SQL.Database()
  }

  db.run('PRAGMA foreign_keys = ON;')

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      telegram_chat_id TEXT,
      notify_enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      cookies_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      video_url TEXT NOT NULL,
      profile_id INTEGER,
      profile_label TEXT NOT NULL,
      caption TEXT,
      scheduled_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      message TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS videos (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      caption TEXT,
      file_path TEXT NOT NULL,
      downloaded_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS batches (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      profile_id INTEGER,
      profile_label TEXT,
      mode TEXT NOT NULL DEFAULT 'daily',
      schedule_config TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS channel_watches (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel_url TEXT NOT NULL,
      label TEXT,
      profile_ids TEXT NOT NULL,
      auto_post INTEGER NOT NULL DEFAULT 0,
      schedule_mode TEXT NOT NULL DEFAULT 'daily',
      schedule_config TEXT NOT NULL,
      check_interval_minutes INTEGER NOT NULL DEFAULT 180,
      status TEXT NOT NULL DEFAULT 'active',
      last_checked_at INTEGER,
      source_cookies_json TEXT,
      created_at INTEGER NOT NULL
    );

    -- Video nào của mỗi kênh theo dõi đã được xét qua rồi (đưa vào hàng đợi hoặc chờ duyệt) —
    -- tách riêng khỏi bảng jobs vì job có thể bị xoá/thất bại/thử lại, nhưng video đó thì không
    -- nên bị lấy lại lần quét sau.
    CREATE TABLE IF NOT EXISTS channel_watch_seen (
      watch_id TEXT NOT NULL REFERENCES channel_watches(id) ON DELETE CASCADE,
      video_url TEXT NOT NULL,
      seen_at INTEGER NOT NULL,
      PRIMARY KEY (watch_id, video_url)
    );

    -- "Bộ comment": mỗi bộ gồm nhiều dòng bình luận riêng, dùng để đăng lần lượt nhiều bình luận
    -- (vd link affiliate) lên 1 bài đăng đã có sẵn. items_json là mảng string (mỗi dòng 1 bình
    -- luận) — giống cách channel_watches.profile_ids lưu mảng dạng JSON trong 1 cột TEXT, không
    -- cần bảng con riêng vì không có dữ liệu phụ nào khác đi kèm mỗi dòng.
    CREATE TABLE IF NOT EXISTS comment_sets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      items_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    );

    -- Cookie nguồn theo nền tảng (douyin/tiktok/facebook): dùng khi tải video từ các nền tảng đó,
    -- khác hoàn toàn với cookie hồ sơ ĐÍCH (dùng để đăng). Mỗi user chỉ có 1 bộ / nền tảng.
    CREATE TABLE IF NOT EXISTS source_cookies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      platform TEXT NOT NULL,
      cookies_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(user_id, platform)
    );
  `)

  // Migration nhỏ cho DB đã tồn tại trước khi có cột này (ALTER TABLE ADD COLUMN báo lỗi nếu đã có, bỏ qua).
  try {
    db.run('ALTER TABLE jobs ADD COLUMN post_url TEXT')
  } catch (err) {
    // đã có cột rồi, bỏ qua
  }

  try {
    db.run('ALTER TABLE users ADD COLUMN active_profile_id INTEGER')
  } catch (err) {
    // đã có cột rồi, bỏ qua
  }

  // Gom các job được tạo trong cùng 1 lần lên lịch hàng loạt, để biết khi nào cả lô chạy xong.
  try {
    db.run('ALTER TABLE jobs ADD COLUMN batch_id TEXT')
  } catch (err) {
    // đã có cột rồi, bỏ qua
  }

  // Mốc đã kiểm tra cookie trước giờ đăng cho job này — để mỗi job chỉ kiểm tra đúng 1 lần.
  try {
    db.run('ALTER TABLE jobs ADD COLUMN precheck_at INTEGER')
  } catch (err) {
    // đã có cột rồi, bỏ qua
  }

  // Kết quả lần kiểm tra cookie gần nhất của hồ sơ — để mở trang lên là thấy ngay tình trạng,
  // không phải bấm kiểm tra lại mỗi lần tải trang (mỗi lần kiểm mất ~7 giây và mở Chrome).
  for (const col of ['cookie_checked_at INTEGER', 'cookie_ok INTEGER', 'cookie_reason TEXT']) {
    try {
      db.run(`ALTER TABLE profiles ADD COLUMN ${col}`)
    } catch (err) {
      // đã có cột rồi, bỏ qua
    }
  }

  // Số lần đã thử đăng (kể cả lần đầu) — để biết job thành công ngay hay phải thử lại mấy lượt.
  try {
    db.run('ALTER TABLE jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0')
  } catch (err) {
    // đã có cột rồi, bỏ qua
  }

  // Nền tảng đích của hồ sơ ('facebook' | 'tiktok'). Mặc định 'facebook' để hồ sơ cũ (từ trước
  // khi có TikTok) không bị đổi hành vi. jobs.platform là bản chụp lại lúc tạo job (giống
  // profile_label) — job cũ vẫn hiện đúng "facebook" dù hồ sơ sau này bị xoá/đổi.
  try {
    db.run("ALTER TABLE profiles ADD COLUMN platform TEXT NOT NULL DEFAULT 'facebook'")
  } catch (err) {
    // đã có cột rồi, bỏ qua
  }
  try {
    db.run("ALTER TABLE jobs ADD COLUMN platform TEXT NOT NULL DEFAULT 'facebook'")
  } catch (err) {
    // đã có cột rồi, bỏ qua
  }

  // Bối cảnh/nhân vật do user tự đặt để chèn vào prompt Gemini lúc sinh caption — vd "nhân vật
  // là cô gái Gen Z hay bắt trend" — để caption ra đúng "chất" kênh thay vì trung tính chung chung.
  try {
    db.run('ALTER TABLE users ADD COLUMN gemini_prompt_context TEXT')
  } catch (err) {
    // đã có cột rồi, bỏ qua
  }

  // Cookie riêng để QUÉT kênh nguồn (khác cookie hồ sơ đích dùng để ĐĂNG) — Douyin/TikTok hay
  // chặn xem kênh khi không đăng nhập, cookie hồ sơ đích (Facebook/TikTok để đăng) không giúp
  // được gì cho domain khác. Bảng channel_watches có thể đã tồn tại từ trước cột này.
  try {
    db.run('ALTER TABLE channel_watches ADD COLUMN source_cookies_json TEXT')
  } catch (err) {
    // đã có cột rồi, bỏ qua
  }

  // Bài dạng ảnh (album/slideshow, vd TikTok photo post) thay vì video — file_path lúc này
  // không dùng, danh sách file ảnh nằm ở file_paths_json (mảng string, JSON). Chỉ nền tảng
  // TikTok hỗ trợ đăng lại kiểu này (Facebook Reels vẫn chỉ nhận video).
  try {
    db.run('ALTER TABLE videos ADD COLUMN is_images INTEGER NOT NULL DEFAULT 0')
  } catch (err) {
    // đã có cột rồi, bỏ qua
  }
  try {
    db.run('ALTER TABLE videos ADD COLUMN file_paths_json TEXT')
  } catch (err) {
    // đã có cột rồi, bỏ qua
  }

  persist()
  return db
}

export function getDb() {
  if (!db) throw new Error('DB chưa được khởi tạo — gọi initDb() trước.')
  return db
}

// Ghi toàn bộ DB (đang ở RAM) xuống file. Gọi sau mỗi lần ghi/sửa/xoá dữ liệu.
// Ghi ra file tạm rồi rename đè lên: rename là thao tác nguyên tử ở mức hệ điều hành, nên
// mất điện/crash giữa chừng chỉ hỏng file .tmp, data.db cũ vẫn nguyên vẹn. Ghi thẳng vào
// data.db thì một lần crash giữa chừng là mất sạch toàn bộ database.
export function persist() {
  const data = db.export()
  const tmpFile = `${DB_FILE}.tmp`
  fs.writeFileSync(tmpFile, Buffer.from(data))
  fs.renameSync(tmpFile, DB_FILE)
}

/**
 * Chạy 1 câu lệnh (INSERT/UPDATE/DELETE) với tham số, rồi tự persist.
 * Trả về id vừa autoincrement (nếu câu lệnh là INSERT) — phải đọc TRƯỚC khi persist(),
 * vì db.export() (bên trong persist) làm reset trạng thái last_insert_rowid() của sql.js.
 */
export function run(sql, params = []) {
  db.run(sql, params)
  const insertId = db.exec('SELECT last_insert_rowid() as id')[0]?.values[0][0] ?? null
  persist()
  return insertId
}

/** Lấy nhiều dòng kết quả dạng mảng object. */
export function all(sql, params = []) {
  const stmt = db.prepare(sql)
  stmt.bind(params)
  const rows = []
  while (stmt.step()) {
    rows.push(stmt.getAsObject())
  }
  stmt.free()
  return rows
}

/** Lấy 1 dòng kết quả (hoặc null nếu không có). */
export function get(sql, params = []) {
  const rows = all(sql, params)
  return rows[0] || null
}
