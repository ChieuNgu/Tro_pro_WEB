const { Pool } = require('pg');

// Cấu hình kết nối - Thay thông tin bằng tài khoản của bạn
const dbConfig = {
  user: 'postgres',
  host: 'localhost',
  database: 'ten_database_cua_ban',
  password: 'mat_khau_cua_ban',
  port: 5432,
};
const CONFIG = {
    maxParallelChunks: 5, // TỐI ƯU: Số cụm chạy song song (giảm nếu máy lag)
    chunkSize: 50,         // Số bài đăng trong mỗi cụm
    radius: 2.0            // Bán kính tìm kiếm 2km
};

class PostgresDB {
  constructor() {
    this.pool = new Pool(dbConfig);
  }

  async insertBatch(tableName, data) {
    if (!data || data.length === 0) return [];

    const keys = Object.keys(data[0]).filter(k => !k.startsWith('_'));
    const columns = keys.join(', ');
    
    // Tạo câu lệnh SQL động cho nhiều dòng
    const valuesPlaceholders = data.map((_, i) => 
      `(${keys.map((_, j) => `$${i * keys.length + j + 1}`).join(', ')})`
    ).join(', ');

    const flatValues = data.flatMap(row => keys.map(k => row[k]));

    // Logic Upsert: Nếu trùng ID hoặc mã định danh thì UPDATE thay vì báo lỗi
    let conflictClause = '';
    if (tableName === 'properties') conflictClause = 'ON CONFLICT (ma_toa) DO UPDATE SET dia_chi = EXCLUDED.dia_chi';
    else if (tableName === 'facebook_groups') conflictClause = 'ON CONFLICT (link_nhom) DO UPDATE SET thanh_vien = EXCLUDED.thanh_vien';
    else conflictClause = 'ON CONFLICT DO NOTHING';

    const query = `INSERT INTO ${tableName} (${columns}) VALUES ${valuesPlaceholders} ${conflictClause} RETURNING *`;
    
    try {
      const res = await this.pool.query(query, flatValues);
      return res.rows;
    } catch (err) {
      console.error(`❌ Lỗi khi INSERT vào ${tableName}:`, err.message);
      return [];
    }
  }

  // Logic gợi ý cho Main.js
  async insertInChunks(tableName, data, chunkSize = 500) {
      for (let i = 0; i < data.length; i += chunkSize) {
          const chunk = data.slice(i, i + chunkSize);
          await this.insertBatch(tableName, chunk); // Gọi lại hàm insertBatch bạn đã viết
          console.log(`Đã nạp ${i + chunk.length} dòng vào ${tableName}`);
      }
  }

  async getRoomsByArea(areaName) {
    const sql = `
        SELECT r.*, p.latitude, p.longitude 
        FROM rooms r 
        JOIN properties p ON r.property_id = p.id 
        WHERE p.quan_huyen = $1 AND r.tinh_trang = 'còn trống'
    `;
    const res = await this.pool.query(sql, [areaName]);
    return res.rows;
  }

  async close() {
    await this.pool.end();
  }
}


// . Hàm runPipeline chính
async function runPipeline(options) {
    const db = new PostgresDB();
    
    try {
        console.log("🚀 Khởi động hệ thống xử lý...");

        // BƯỚC 1: NẠP KHO HÀNG (FOLDER 2)
        const f2 = processFolder2(options.folder2Path);
        await db.insertInChunks("properties", f2.properties);
        await db.insertInChunks("rooms", f2.rooms);

        // BƯỚC 2: XỬ LÝ LUỒNG TỰ ĐỘNG (FOLDER 1 - 1000 BÀI)
        if (options.runAuto) {
            console.log("🤖 Đang xử lý luồng tự động...");
            const f1 = processFolder1(options.folder1Path);
            const allPosts = f1.posts;

            // CHIA CỤM 50 BÀI
            const chunks = [];
            for (let i = 0; i < allPosts.length; i += CONFIG.chunkSize) {
                chunks.push(allPosts.slice(i, i + CONFIG.chunkSize));
            }

            // ĐIỀU TIẾT SONG SONG
            const executing = new Set();
            for (let i = 0; i < chunks.length; i++) {
                const task = (async (chunk, index) => {
                    // Lấy phòng theo khu vực của bài đầu tiên trong cụm
                    const area = chunk[0].quan_huyen;
                    const roomsInArea = await db.getRoomsByArea(area);
                    
                    // Gọi Engine mới (Top 6: 2 rẻ, 2 gần, 2 tốt)
                    const results = Engine.processLocationChunk(chunk, roomsInArea, CONFIG.radius);
                    
                    if (results.length > 0) {
                        await db.insertInChunks("matched_results", results);
                    }
                    console.log(`✅ Đã xong cụm tự động ${index + 1}/${chunks.length}`);
                })(chunks[i], i);

                executing.add(task);
                task.then(() => executing.delete(task));

                if (executing.size >= CONFIG.maxParallelChunks) {
                    await Promise.race(executing);
                }
            }
            await Promise.all(executing);
        }

        // BƯỚC 3: XỬ LÝ LUỒNG THỦ CÔNG (FOLDER 3 - 5 BÀI LẺ)
        if (options.runManual) {
            console.log("🛠️ Đang xử lý luồng thủ công...");
            const f3 = processFolder3(options.folder3Path);
            const manualPosts = f3.manual_searches;

            if (manualPosts.length > 0) {
                // Xử lý gom nhóm theo quận cho các bài lẻ
                const grouped = manualPosts.reduce((acc, p) => {
                    const area = p.quan_huyen || "Khác";
                    if (!acc[area]) acc[area] = [];
                    acc[area].push(p);
                    return acc;
                }, {});

                for (const area in grouped) {
                    const roomsInArea = await db.getRoomsByArea(area);
                    const results = Engine.processLocationChunk(grouped[area], roomsInArea, CONFIG.radius);
                    
                    if (results.length > 0) {
                        await db.insertInChunks("manual_matched_results", results);
                    }
                }
                console.log(`✅ Đã xử lý xong ${manualPosts.length} bài tìm kiếm lẻ.`);
            }
        }

    } catch (error) {
        console.error("❌ Lỗi Pipeline:", error);
    } finally {
        await db.close();
        console.log("🔌 Đã ngắt kết nối.");
    }
}