/**
 * SERVER.JS — PhòngTrọ Pro
 * ─────────────────────────────────────────────────────────────
 * REST API  : login, work_schedules, upload folders (pipeline)
 * WebSocket : internal_chats (real-time)
 * Database  : PostgreSQL (pg Pool)
 * Upload    : multer (multipart/form-data)
 * ─────────────────────────────────────────────────────────────
 * Cài dependencies (chạy 1 lần):
 *   npm install express pg multer ws xlsx bcrypt cors
 *
 * Chạy server:
 *   node server.js
 * ─────────────────────────────────────────────────────────────
 */
require("dotenv").config({ path: "./process.env" });
"use strict";

const express   = require("express");
const http      = require("http");
const path      = require("path");
const fs        = require("fs");
const cors      = require("cors");
const multer    = require("multer");
const bcrypt    = require("bcrypt");
const XLSX      = require("xlsx");
const { Pool }  = require("pg");
const { WebSocketServer } = require("ws");

// Import engine & processors của bạn
const Engine     = require("./Engine");
const { loadData } = require("./Processors");   // hàm loadData từ Processors.js

// ═══════════════════════════════════════════════════════════
// 1. CẤU HÌNH
// ═══════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;

const DB_CONFIG = {
  user:     process.env.DB_USER     || "postgres",
  host:     process.env.DB_HOST     || "localhost",
  database: process.env.DB_NAME     || "phongtro_pro",
  password: process.env.DB_PASS     || "mat_khau_cua_ban",
  port:     parseInt(process.env.DB_PORT || "5432"),
};

const PIPELINE_CONFIG = {
  maxParallelChunks: 5,
  chunkSize: 50,
  radius: 2.0,
};

// Thư mục tạm lưu file upload
const UPLOAD_DIR = path.join(__dirname, "uploads_tmp");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ═══════════════════════════════════════════════════════════
// 2. KHỞI TẠO APP & DATABASE POOL
// ═══════════════════════════════════════════════════════════
const app    = express();
const server = http.createServer(app);
const pool   = new Pool(DB_CONFIG);

// Kiểm tra kết nối DB khi khởi động
pool.connect()
  .then(client => {
    console.log("✅ Kết nối PostgreSQL thành công.");
    client.release();
  })
  .catch(err => console.error("❌ Không thể kết nối PostgreSQL:", err.message));

// ═══════════════════════════════════════════════════════════
// 3. MIDDLEWARE
// ═══════════════════════════════════════════════════════════
app.use(cors({ origin: "*" }));          // Cho phép frontend ở bất kỳ origin nào (local dev)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Phục vụ file HTML tĩnh (phongtro_pro.html)
app.use(express.static(path.join(__dirname)));

// ═══════════════════════════════════════════════════════════
// 4. MULTER — CẤU HÌNH UPLOAD FILE
// ═══════════════════════════════════════════════════════════
// Lưu file theo folder: uploads_tmp/folder1/, folder2/, folder3/
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // req.body.folder_type = "folder1" | "folder2" | "folder3"
    // (được gửi kèm FormData từ frontend)
    const folderType = req.body.folder_type || req.query.folder_type || "folder1";
    const dest = path.join(UPLOAD_DIR, folderType);
    fs.mkdirSync(dest, { recursive: true });
    cb(null, dest);
  },
  filename: (req, file, cb) => {
    // Giữ nguyên tên file gốc, thay khoảng trắng bằng _
    cb(null, file.originalname.replace(/\s+/g, "_"));
  },
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    // Chỉ nhận .xlsx, .xls, .json
    const allowed = [".xlsx", ".xls", ".json"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error(`Định dạng không hỗ trợ: ${ext}`));
  },
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB / file
});

// ═══════════════════════════════════════════════════════════
// 5. HÀM TIỆN ÍCH DATABASE
// ═══════════════════════════════════════════════════════════

/**
 * Chèn nhiều dòng vào DB (batch insert, có upsert)
 */
async function insertBatch(tableName, data) {
  if (!data || data.length === 0) return [];

  const keys = Object.keys(data[0]).filter(k => !k.startsWith("_"));
  const columns = keys.join(", ");
  const valuesPlaceholders = data
    .map((_, i) => `(${keys.map((_, j) => `$${i * keys.length + j + 1}`).join(", ")})`)
    .join(", ");
  const flatValues = data.flatMap(row => keys.map(k => row[k]));

  let conflictClause = "ON CONFLICT DO NOTHING";
  if (tableName === "properties")      conflictClause = "ON CONFLICT (ma_toa) DO UPDATE SET dia_chi = EXCLUDED.dia_chi";
  if (tableName === "facebook_groups") conflictClause = "ON CONFLICT (link_nhom) DO UPDATE SET thanh_vien = EXCLUDED.thanh_vien";

  const query = `INSERT INTO ${tableName} (${columns}) VALUES ${valuesPlaceholders} ${conflictClause} RETURNING *`;

  try {
    const res = await pool.query(query, flatValues);
    return res.rows;
  } catch (err) {
    console.error(`❌ insertBatch [${tableName}]:`, err.message);
    return [];
  }
}

/**
 * Chèn từng chunk 500 dòng để tránh quá tải
 */
async function insertInChunks(tableName, data, chunkSize = 500) {
  for (let i = 0; i < data.length; i += chunkSize) {
    const chunk = data.slice(i, i + chunkSize);
    await insertBatch(tableName, chunk);
    console.log(`  → Đã nạp ${Math.min(i + chunkSize, data.length)}/${data.length} dòng vào [${tableName}]`);
  }
}

/**
 * Lấy phòng còn trống theo quận
 */
async function getRoomsByArea(areaName) {
  const sql = `
    SELECT r.*, p.latitude, p.longitude, p.pet, p.xe_dien
    FROM rooms r
    JOIN properties p ON r.property_id = p.id
    WHERE p.quan = $1 AND r.tinh_trang = 'còn trống'
  `;
  const res = await pool.query(sql, [areaName]);
  return res.rows;
}

// ═══════════════════════════════════════════════════════════
// 6. HÀM ĐỌC EXCEL → JSON
// ═══════════════════════════════════════════════════════════
/**
 * Đọc file Excel (.xlsx/.xls) hoặc JSON, trả về mảng object
 */
function readFileToJson(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".json") {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  }
  // Excel
  const wb = XLSX.readFile(filePath);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: null });
}

// ═══════════════════════════════════════════════════════════
// 7. HÀM PIPELINE (XỬ LÝ SAU KHI UPLOAD)
// ═══════════════════════════════════════════════════════════
async function runPipeline(folderTypes) {
  console.log("\n🚀 Bắt đầu Pipeline...", folderTypes);

  // ── FOLDER 2: Kho hàng (properties + rooms) ──────────────
  if (folderTypes.includes("folder2")) {
    const f2Dir = path.join(UPLOAD_DIR, "folder2");
    const files = fs.readdirSync(f2Dir);

    for (const file of files) {
      const rows = readFileToJson(path.join(f2Dir, file));
      const name = file.toLowerCase();
      if (name.includes("propert") || name.includes("toa"))   await insertInChunks("properties", rows);
      else if (name.includes("room") || name.includes("phong")) await insertInChunks("rooms", rows);
      else console.warn(`  ⚠️ Không nhận dạng được file: ${file}`);
    }
    console.log("✅ Đã nạp Folder 2 (kho hàng).");
  }

  // ── FOLDER 1: Bài đăng Facebook (auto matching) ──────────
  if (folderTypes.includes("folder1")) {
    const f1Dir = path.join(UPLOAD_DIR, "folder1");
    const files = fs.readdirSync(f1Dir);

    let allPosts = [], allGroups = [];
    for (const file of files) {
      const rows = readFileToJson(path.join(f1Dir, file));
      const name = file.toLowerCase();
      if (name.includes("group") || name.includes("nhom")) allGroups = allGroups.concat(rows);
      else if (name.includes("post") || name.includes("bai"))  allPosts  = allPosts.concat(rows);
    }

    if (allGroups.length) await insertInChunks("facebook_groups", allGroups);
    if (allPosts.length)  await insertInChunks("facebook_posts",  allPosts);

    // Chia cụm & matching song song
    const chunks = [];
    for (let i = 0; i < allPosts.length; i += PIPELINE_CONFIG.chunkSize) {
      chunks.push(allPosts.slice(i, i + PIPELINE_CONFIG.chunkSize));
    }

    const executing = new Set();
    for (let i = 0; i < chunks.length; i++) {
      const task = (async (chunk, idx) => {
        const area = chunk[0]?.quan_huyen || chunk[0]?.quan || "Hải Phòng";
        const rooms = await getRoomsByArea(area);
        const results = Engine.processLocationChunk(chunk, rooms, PIPELINE_CONFIG.radius);
        if (results.length) await insertInChunks("matched_results", results);
        console.log(`  ✅ Cụm tự động ${idx + 1}/${chunks.length} xong (${results.length} kết quả).`);
      })(chunks[i], i);

      executing.add(task);
      task.then(() => executing.delete(task));
      if (executing.size >= PIPELINE_CONFIG.maxParallelChunks) await Promise.race(executing);
    }
    await Promise.all(executing);
    console.log("✅ Đã xử lý xong Folder 1 (auto matching).");
  }

  // ── FOLDER 3: Tìm kiếm thủ công ──────────────────────────
  if (folderTypes.includes("folder3")) {
    const f3Dir = path.join(UPLOAD_DIR, "folder3");
    const files = fs.readdirSync(f3Dir);

    let manualPosts = [];
    for (const file of files) {
      const rows = readFileToJson(path.join(f3Dir, file));
      manualPosts = manualPosts.concat(Array.isArray(rows) ? rows : [rows]);
    }

    if (manualPosts.length) {
      await insertInChunks("manual_search", manualPosts);

      // Gom nhóm theo quận
      const grouped = manualPosts.reduce((acc, p) => {
        const area = p.quan_huyen || p.quan || "Hải Phòng";
        if (!acc[area]) acc[area] = [];
        acc[area].push(p);
        return acc;
      }, {});

      for (const area in grouped) {
        const rooms = await getRoomsByArea(area);
        const results = Engine.processLocationChunk(grouped[area], rooms, PIPELINE_CONFIG.radius);
        if (results.length) await insertInChunks("manual_matched_results", results);
      }
      console.log(`✅ Đã xử lý xong Folder 3 (${manualPosts.length} bài thủ công).`);
    }
  }

  console.log("🏁 Pipeline hoàn tất.\n");
}

// ═══════════════════════════════════════════════════════════
// 8. REST API — AUTH
// ═══════════════════════════════════════════════════════════

/**
 * POST /api/login
 * Body: { username, password }
 * Trả về: { ok, user: { id, ho_ten, vai_tro } }
 */
app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ ok: false, message: "Thiếu username hoặc password." });

  try {
    const result = await pool.query(
      "SELECT * FROM users WHERE username = $1 LIMIT 1",
      [username]
    );
    const user = result.rows[0];

    if (!user) return res.status(401).json({ ok: false, message: "Tài khoản không tồn tại." });

    // So sánh password (bcrypt). Nếu chưa hash thì so sánh thẳng (dev mode)
    let match = false;
    if (user.password_hash && user.password_hash.startsWith("$2")) {
      match = await bcrypt.compare(password, user.password_hash);
    } else {
      match = password === user.password_hash; // plain text (chỉ dùng khi dev)
    }

    if (!match) return res.status(401).json({ ok: false, message: "Sai mật khẩu." });

    // Cập nhật last_active_at
    await pool.query("UPDATE users SET last_active_at = NOW() WHERE id = $1", [user.id]);

    res.json({
      ok: true,
      user: { id: user.id, ho_ten: user.ho_ten, vai_tro: user.vai_tro },
    });
  } catch (err) {
    console.error("❌ /api/login:", err.message);
    res.status(500).json({ ok: false, message: "Lỗi server." });
  }
});

// ═══════════════════════════════════════════════════════════
// 9. REST API — WORK SCHEDULES
// ═══════════════════════════════════════════════════════════

/**
 * GET /api/work_schedules
 * Query: ?assigned_to=<user_id>  (tuỳ chọn lọc theo nhân viên)
 */
app.get("/api/work_schedules", async (req, res) => {
  try {
    const { assigned_to } = req.query;
    let sql = `
      SELECT ws.*, 
             u1.ho_ten AS ten_nguoi_giao,
             u2.ho_ten AS ten_nguoi_nhan
      FROM work_schedules ws
      LEFT JOIN users u1 ON ws.created_by  = u1.id
      LEFT JOIN users u2 ON ws.assigned_to = u2.id
      ORDER BY ws.id DESC
    `;
    const params = [];
    if (assigned_to) {
      sql = `
        SELECT ws.*, 
               u1.ho_ten AS ten_nguoi_giao,
               u2.ho_ten AS ten_nguoi_nhan
        FROM work_schedules ws
        LEFT JOIN users u1 ON ws.created_by  = u1.id
        LEFT JOIN users u2 ON ws.assigned_to = u2.id
        WHERE ws.assigned_to = $1
        ORDER BY ws.id DESC
      `;
      params.push(assigned_to);
    }
    const result = await pool.query(sql, params);
    res.json({ ok: true, data: result.rows });
  } catch (err) {
    console.error("❌ GET /api/work_schedules:", err.message);
    res.status(500).json({ ok: false, message: "Lỗi server." });
  }
});

/**
 * POST /api/work_schedules
 * Body: { created_by, assigned_to, tieu_de, noi_dung_cong_viec,
 *         thoi_gian_bat_dau, thoi_gian_ket_thuc }
 */
app.post("/api/work_schedules", async (req, res) => {
  const {
    created_by, assigned_to, tieu_de,
    noi_dung_cong_viec, thoi_gian_bat_dau, thoi_gian_ket_thuc,
  } = req.body;

  if (!created_by || !assigned_to || !tieu_de || !noi_dung_cong_viec)
    return res.status(400).json({ ok: false, message: "Thiếu thông tin bắt buộc." });

  try {
    const result = await pool.query(
      `INSERT INTO work_schedules
         (created_by, assigned_to, tieu_de, noi_dung_cong_viec,
          thoi_gian_bat_dau, thoi_gian_ket_thuc, trang_thai)
       VALUES ($1,$2,$3,$4,$5,$6,'chưa bắt đầu')
       RETURNING *`,
      [created_by, assigned_to, tieu_de, noi_dung_cong_viec,
       thoi_gian_bat_dau || null, thoi_gian_ket_thuc || null]
    );
    res.status(201).json({ ok: true, data: result.rows[0] });
  } catch (err) {
    console.error("❌ POST /api/work_schedules:", err.message);
    res.status(500).json({ ok: false, message: "Lỗi server." });
  }
});

/**
 * PATCH /api/work_schedules/:id
 * Body: { trang_thai }   — cập nhật trạng thái
 */
app.patch("/api/work_schedules/:id", async (req, res) => {
  const { id } = req.params;
  const { trang_thai, phan_hoi_nhan_vien } = req.body;
  try {
    const result = await pool.query(
      `UPDATE work_schedules
       SET trang_thai = COALESCE($1, trang_thai),
           phan_hoi_nhan_vien = COALESCE($2, phan_hoi_nhan_vien)
       WHERE id = $3 RETURNING *`,
      [trang_thai || null, phan_hoi_nhan_vien || null, id]
    );
    if (!result.rows.length) return res.status(404).json({ ok: false, message: "Không tìm thấy." });
    res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    console.error("❌ PATCH /api/work_schedules:", err.message);
    res.status(500).json({ ok: false, message: "Lỗi server." });
  }
});

// ═══════════════════════════════════════════════════════════
// 10. REST API — USERS (danh sách nhân viên)
// ═══════════════════════════════════════════════════════════

/**
 * GET /api/users
 * Trả về danh sách nhân viên (không trả password_hash)
 */
app.get("/api/users", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, ho_ten, vai_tro, is_available, last_active_at FROM users ORDER BY id"
    );
    res.json({ ok: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, message: "Lỗi server." });
  }
});

/**
 * PATCH /api/users/:id/available
 * Body: { is_available: true | false }
 */
app.patch("/api/users/:id/available", async (req, res) => {
  const { id } = req.params;
  const { is_available } = req.body;
  try {
    await pool.query(
      "UPDATE users SET is_available = $1, last_active_at = NOW() WHERE id = $2",
      [is_available, id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, message: "Lỗi server." });
  }
});

// ═══════════════════════════════════════════════════════════
// 11. REST API — UPLOAD FOLDERS & TRIGGER PIPELINE
// ═══════════════════════════════════════════════════════════

/**
 * POST /api/upload
 * FormData fields:
 *   folder_type = "folder1" | "folder2" | "folder3"
 *   files[]     = (nhiều file Excel/JSON)
 *
 * Sau khi upload xong, tự chạy pipeline cho folder đó.
 */
app.post("/api/upload", upload.array("files"), async (req, res) => {
  const folderType = req.body.folder_type || req.query.folder_type;

  if (!folderType || !["folder1", "folder2", "folder3"].includes(folderType)) {
    return res.status(400).json({ ok: false, message: "folder_type không hợp lệ." });
  }

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ ok: false, message: "Không có file nào được upload." });
  }

  const fileNames = req.files.map(f => f.originalname);
  console.log(`📂 Upload [${folderType}]:`, fileNames);

  // Phản hồi ngay, pipeline chạy nền
  res.json({
    ok: true,
    message: `Đã nhận ${req.files.length} file. Pipeline đang chạy nền...`,
    files: fileNames,
  });

  // Chạy pipeline bất đồng bộ (không block response)
  runPipeline([folderType]).catch(err =>
    console.error("❌ Pipeline error:", err.message)
  );
});

/**
 * POST /api/upload/all
 * Chạy pipeline cho cả 3 folder cùng lúc
 * (Dùng khi upload xong hết rồi mới bấm "Chạy tất cả")
 */
app.post("/api/upload/all", async (req, res) => {
  res.json({ ok: true, message: "Pipeline cho cả 3 folder đang chạy nền..." });
  runPipeline(["folder2", "folder1", "folder3"]).catch(err =>
    console.error("❌ Pipeline all error:", err.message)
  );
});

// ═══════════════════════════════════════════════════════════
// 12. REST API — LỊCH SỬ CHAT (tải lại khi mở app)
// ═══════════════════════════════════════════════════════════

/**
 * GET /api/chats/:userId
 * Lấy toàn bộ tin nhắn giữa admin (id=1) và userId
 */
app.get("/api/chats/:userId", async (req, res) => {
  const { userId } = req.params;
  try {
    const result = await pool.query(
      `SELECT * FROM internal_chats
       WHERE (sender_id = 1 AND receiver_id = $1)
          OR (sender_id = $1 AND receiver_id = 1)
       ORDER BY created_at ASC`,
      [userId]
    );
    res.json({ ok: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, message: "Lỗi server." });
  }
});

// ═══════════════════════════════════════════════════════════
// 13. WEBSOCKET SERVER — INTERNAL CHAT (REAL-TIME)
// ═══════════════════════════════════════════════════════════
const wss = new WebSocketServer({ server });

// Map: userId → WebSocket client (để biết gửi tin đến ai)
const wsClients = new Map();

wss.on("connection", (ws, req) => {
  console.log("🔌 WebSocket client kết nối.");

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── ĐĂNG KÝ: { type: "register", userId: 1 }
    if (msg.type === "register") {
      ws.userId = msg.userId;
      wsClients.set(msg.userId, ws);
      console.log(`  👤 User ${msg.userId} đã đăng ký WebSocket.`);
      return;
    }

    // ── GỬI TIN NHẮN: { type: "chat", sender_id, receiver_id, message_text, image_url }
    if (msg.type === "chat") {
      const { sender_id, receiver_id, message_text, image_url } = msg;

      // Lưu vào DB
      let saved = null;
      try {
        const result = await pool.query(
          `INSERT INTO internal_chats (sender_id, receiver_id, message_text, image_url, is_read)
           VALUES ($1, $2, $3, $4, FALSE)
           RETURNING *`,
          [sender_id, receiver_id, message_text || null, image_url || null]
        );
        saved = result.rows[0];
      } catch (err) {
        console.error("❌ Lưu chat thất bại:", err.message);
        return;
      }

      // Gói tin gửi đi
      const packet = JSON.stringify({ type: "chat", data: saved });

      // Gửi đến người nhận (nếu đang online)
      const receiverWs = wsClients.get(receiver_id);
      if (receiverWs && receiverWs.readyState === 1) receiverWs.send(packet);

      // Gửi lại cho người gửi (để đồng bộ UI)
      if (ws.readyState === 1) ws.send(packet);

      // Đánh dấu đã đọc nếu receiver đang online
      if (receiverWs && receiverWs.readyState === 1) {
        await pool.query(
          "UPDATE internal_chats SET is_read = TRUE WHERE id = $1",
          [saved.id]
        ).catch(() => {});
      }
    }

    // ── ĐỌC TIN: { type: "read", sender_id, reader_id }
    if (msg.type === "read") {
      await pool.query(
        `UPDATE internal_chats SET is_read = TRUE
         WHERE sender_id = $1 AND receiver_id = $2 AND is_read = FALSE`,
        [msg.sender_id, msg.reader_id]
      ).catch(() => {});
    }
  });

  ws.on("close", () => {
    if (ws.userId) {
      wsClients.delete(ws.userId);
      console.log(`  ❌ User ${ws.userId} ngắt kết nối WebSocket.`);
    }
  });

  ws.on("error", err => console.error("WebSocket error:", err.message));
});

// ═══════════════════════════════════════════════════════════
// 14. ROUTE MẶC ĐỊNH — Phục vụ HTML
// ═══════════════════════════════════════════════════════════
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "phongtro_pro.html"));
});

// Xử lý 404
app.use((req, res) => {
  res.status(404).json({ ok: false, message: `Route không tồn tại: ${req.path}` });
});

// ═══════════════════════════════════════════════════════════
// 15. KHỞI ĐỘNG SERVER
// ═══════════════════════════════════════════════════════════
server.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════════════════════════════════╗
  ║        PhòngTrọ Pro — Server Ready                                   ║
  ╠══════════════════════════════════════════════════════════════════════╣
  ║  HTTP  : http://localhost:${PORT}                                    ║
  ║  WS    : ws://localhost:${PORT}                                      ║
  ║  DB    : ${DB_CONFIG.database}@${DB_CONFIG.host}:${DB_CONFIG.port}   ║
  ╚══════════════════════════════════════════════════════════════════════╝
  `);
});
