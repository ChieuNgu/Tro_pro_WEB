"use strict";

const fs   = require("fs");
const path = require("path");
const XLSX = require("xlsx");

// ═══════════════════════════════════════════════════════════
// HÀM TIỆN ÍCH
// ═══════════════════════════════════════════════════════════

/**
 * Đọc 1 file (.xlsx, .xls, hoặc .json) → trả về mảng object
 */
function readFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".json") {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    // Hỗ trợ cả dạng mảng lẫn object bọc ngoài
    return Array.isArray(raw) ? raw : [raw];
  }

  if (ext === ".xlsx" || ext === ".xls") {
    const wb    = XLSX.readFile(filePath);
    const sheet = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(sheet, { defval: null });
  }

  console.warn(`  ⚠️  Bỏ qua file không hỗ trợ: ${filePath}`);
  return [];
}

/**
 * Đọc toàn bộ file trong 1 thư mục → gộp thành 1 mảng
 */
function readFolder(folderPath) {
  if (!fs.existsSync(folderPath)) {
    console.warn(`  ⚠️  Thư mục không tồn tại: ${folderPath}`);
    return [];
  }

  const files = fs.readdirSync(folderPath).filter(f =>
    [".xlsx", ".xls", ".json"].includes(path.extname(f).toLowerCase())
  );

  if (files.length === 0) {
    console.warn(`  ⚠️  Không có file nào trong: ${folderPath}`);
    return [];
  }

  let all = [];
  for (const file of files) {
    const rows = readFile(path.join(folderPath, file));
    console.log(`  📄 Đọc [${file}]: ${rows.length} dòng`);
    all = all.concat(rows);
  }
  return all;
}

// ═══════════════════════════════════════════════════════════
// XỬ LÝ TỪNG FOLDER
// ═══════════════════════════════════════════════════════════

/**
 * FOLDER 1 — Bài đăng Facebook (auto matching)
 * Trả về: { groups: [...], posts: [...] }
 *
 * Quy tắc nhận dạng file theo tên:
 *   - chứa "group" hoặc "nhom" → facebook_groups
 *   - còn lại                  → facebook_posts
 */
function processFolder1(basePath) {
  const dir = path.join(basePath, "folder1");
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter(f =>
        [".xlsx", ".xls", ".json"].includes(path.extname(f).toLowerCase())
      )
    : [];

  let groups = [], posts = [];

  for (const file of files) {
    const rows = readFile(path.join(dir, file));
    const name = file.toLowerCase();
    if (name.includes("group") || name.includes("nhom")) {
      groups = groups.concat(rows);
    } else {
      posts = posts.concat(rows);
    }
    console.log(`  📄 Folder1 [${file}]: ${rows.length} dòng`);
  }

  return { groups, posts };
}

/**
 * FOLDER 2 — Kho hàng (properties + rooms)
 * Trả về: { properties: [...], rooms: [...] }
 *
 * Quy tắc nhận dạng file theo tên:
 *   - chứa "propert" hoặc "toa" → properties
 *   - chứa "room"   hoặc "phong" → rooms
 */
function processFolder2(basePath) {
  const dir = path.join(basePath, "folder2");
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter(f =>
        [".xlsx", ".xls", ".json"].includes(path.extname(f).toLowerCase())
      )
    : [];

  let properties = [], rooms = [];

  for (const file of files) {
    const rows = readFile(path.join(dir, file));
    const name = file.toLowerCase();
    if (name.includes("propert") || name.includes("toa")) {
      properties = properties.concat(rows);
    } else if (name.includes("room") || name.includes("phong")) {
      rooms = rooms.concat(rows);
    } else {
      console.warn(`  ⚠️  Folder2: không nhận dạng được [${file}], bỏ qua.`);
    }
    console.log(`  📄 Folder2 [${file}]: ${rows.length} dòng`);
  }

  return { properties, rooms };
}

/**
 * FOLDER 3 — Tìm kiếm thủ công (5 bài lẻ)
 * Trả về: { manual_searches: [...] }
 *
 * Mỗi file trong folder3 = 1 bài tìm kiếm (hoặc mảng nhiều bài)
 */
function processFolder3(basePath) {
  const dir = path.join(basePath, "folder3");
  const rows = readFolder(dir);
  return { manual_searches: rows };
}

/**
 * HÀM TỔNG — Nạp theo mode
 * mode: "AUTO" | "MANUAL" | "BOTH"
 * basePath: thư mục gốc chứa folder1, folder2, folder3
 *           (mặc định = uploads_tmp/)
 */
function loadData(basePath, mode = "BOTH") {
  const result = {
    facebook_groups: [],
    facebook_posts:  [],
    properties:      [],
    rooms:           [],
    manual_searches: [],
  };

  // Folder 2 luôn được nạp (kho hàng cần thiết cho cả 2 luồng)
  const f2 = processFolder2(basePath);
  result.properties = f2.properties;
  result.rooms      = f2.rooms;

  if (mode === "AUTO" || mode === "BOTH") {
    const f1 = processFolder1(basePath);
    result.facebook_groups = f1.groups;
    result.facebook_posts  = f1.posts;
  }

  if (mode === "MANUAL" || mode === "BOTH") {
    const f3 = processFolder3(basePath);
    result.manual_searches = f3.manual_searches;
  }

  return result;
}

// ═══════════════════════════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════════════════════════
module.exports = {
  loadData,         // dùng trong Main.js (chạy độc lập)
  processFolder1,   // dùng trong server.js (upload từng folder)
  processFolder2,
  processFolder3,
  readFile,         // tiện ích đọc 1 file
  readFolder,       // tiện ích đọc cả thư mục
};