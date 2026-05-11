SET client_encoding = 'UTF8';
-- Xóa bảng cũ nếu đã tồn tại (phải xóa bảng trước vì bảng đang dùng ENUM)
DROP TABLE IF EXISTS facebook_posts CASCADE;
DROP TABLE IF EXISTS facebook_groups CASCADE;
DROP TABLE IF EXISTS properties CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS properties CASCADE;
DROP TABLE IF EXISTS rooms CASCADE;
DROP TABLE IF EXISTS matched_results CASCADE;
DROP TABLE IF EXISTS marketing_log CASCADE;
DROP TABLE IF EXISTS work_schedules CASCADE;
DROP TABLE IF EXISTS internal_chats CASCADE;
DROP TABLE IF EXISTS manual_search CASCADE;
DROP TABLE IF EXISTS manual_matched_results CASCADE;


-- 2. Xóa TOÀN BỘ các ENUM đã tạo
DROP TYPE IF EXISTS room_type_values;
DROP TYPE IF EXISTS send_status;
DROP TYPE IF EXISTS view_status;
DROP TYPE IF EXISTS deposit_status;    -- Bạn đang thiếu dòng này
DROP TYPE IF EXISTS checkin_status;    -- Và dòng này
DROP TYPE IF EXISTS marketing_status;  -- Và dòng này
DROP TYPE IF EXISTS uu_tien_type;
DROP TYPE IF EXISTS priority_sell_status;
DROP TYPE IF EXISTS tinh_trang;
-- ... Thêm tương tự cho các TYPE khác của bạn ...

-- 1. Khởi tạo các ENUM (Kiểu dữ liệu danh mục)
CREATE TYPE room_type_values AS ENUM ('1n1k', '2n1k', '3n1k', 'studio', 'Khép kín', 'WC Chung', '1N1B', '1N1K1B', 'duplex', 'MBKD');
CREATE TYPE send_status AS ENUM ('chưa gửi', 'đã gửi');
CREATE TYPE view_status AS ENUM ('chưa xem', 'đã xem');
CREATE TYPE deposit_status AS ENUM ('chưa đóng', 'đã đóng');
CREATE TYPE checkin_status AS ENUM ('đang chờ', 'đã nhận', 'hủy');
CREATE TYPE marketing_status AS ENUM ('thành công', 'bị ẩn', 'vi phạm');
CREATE TYPE uu_tien_type AS ENUM ('giá rẻ', 'khoảng cách');
CREATE TYPE priority_sell_status AS ENUM ('ưu tiên', 'không ưu tiên');
CREATE TYPE tinh_trang AS ENUM ('còn trống', 'hết phòng');

-- 2. Bảng Users (Nhân sự)
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username VARCHAR UNIQUE NOT NULL,
    password_hash VARCHAR,
    ho_ten VARCHAR,
    vai_tro VARCHAR,
    last_active_at TIMESTAMP DEFAULT NOW(),
    is_available BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- 3. Bảng Facebook Groups (Folder 1)
CREATE TABLE facebook_groups (
    id SERIAL PRIMARY KEY,
    link_nhom VARCHAR UNIQUE NOT NULL,
    thanh_vien FLOAT
);

-- 4. Bảng Posts (Folder 1)
CREATE TABLE facebook_posts (
    id SERIAL PRIMARY KEY,
    group_id INT REFERENCES facebook_groups(id),
    noi_dung TEXT,
    assign_to INT REFERENCES users(id),
    uu_tien uu_tien_type DEFAULT 'giá rẻ',
    so_nguoi_o INT DEFAULT 2,
    xe_dien BOOLEAN DEFAULT FALSE,
    pet BOOLEAN DEFAULT FALSE,
    ban_cong BOOLEAN DEFAULT FALSE,
    loai_phong room_type_values,
    center_lat DECIMAL(10, 8),
    center_lng DECIMAL(11, 8),
    radius_km FLOAT DEFAULT 2
);

-- 5. Bảng Properties (Folder 2)
CREATE TABLE properties (
    id SERIAL PRIMARY KEY,
    ma_toa VARCHAR UNIQUE NOT NULL,
    dia_chi VARCHAR,
    quan VARCHAR,
    dich_vu_chung TEXT,
    latitude DECIMAL(10, 8),
    longitude DECIMAL(11, 8),
    pet BOOLEAN,
    xe_dien BOOLEAN
);

-- 6. Bảng Rooms (Folder 2)
CREATE TABLE rooms (
    id SERIAL PRIMARY KEY,
    property_id INT REFERENCES properties(id),
    so_phong VARCHAR,
    gia_thue INT,
    tinh_trang tinh_trang,
    so_nguoi_toi_da INT,
    loai_phong room_type_values,
    ban_cong BOOLEAN,
    link_anh VARCHAR,
    mo_ta_rieng TEXT,
    trang_thai_dang_tin priority_sell_status DEFAULT 'không ưu tiên',
    luot_khach_dang_cham INT DEFAULT 0,
    UNIQUE(property_id, so_phong) -- Đảm bảo không trùng số phòng trong cùng 1 tòa
);

-- 7. Bảng Matched Results (Output AUTO)
CREATE TABLE matched_results (
    id SERIAL PRIMARY KEY,
    post_id INT REFERENCES facebook_posts(id),
    room_id INT REFERENCES rooms(id),
    user_id INT REFERENCES users(id),
    distance_km FLOAT,
    match_score FLOAT,
    label_match VARCHAR,
    is_matched BOOLEAN DEFAULT TRUE,
    gui_thong_tin send_status DEFAULT 'chưa gửi',
    khach_co_rep_comment BOOLEAN DEFAULT FALSE,
    khach_xem_phong view_status DEFAULT 'chưa xem',
    dong_coc deposit_status DEFAULT 'chưa đóng',
    tinh_trang_nhan_phong checkin_status DEFAULT 'đang chờ',
    ghi_chu TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- 8. Bảng Marketing Log
CREATE TABLE marketing_log (
    id SERIAL PRIMARY KEY,
    room_id INT REFERENCES rooms(id),
    group_id INT REFERENCES facebook_groups(id),
    user_id INT REFERENCES users(id),
    thoi_gian_dang TIMESTAMP DEFAULT NOW(),
    trang_thai marketing_status DEFAULT 'thành công',
    so_luong_khach_phan_hoi INT DEFAULT 0,
    da_chot_don_tu_bai_nay BOOLEAN DEFAULT FALSE,
    ghi_chu_loi TEXT
);

-- 9. Bảng Work Schedules
CREATE TABLE work_schedules (
    id SERIAL PRIMARY KEY,
    created_by INT REFERENCES users(id),
    assigned_to INT REFERENCES users(id),
    matched_result_id INT REFERENCES matched_results(id),
    tieu_de VARCHAR,
    noi_dung_cong_viec TEXT,
    thoi_gian_bat_dau TIMESTAMP,
    thoi_gian_ket_thuc TIMESTAMP,
    trang_thai VARCHAR DEFAULT 'chưa bắt đầu',
    phan_hoi_nhan_vien TEXT
);

-- 10. Bảng Internal Chats
CREATE TABLE internal_chats (
    id SERIAL PRIMARY KEY,
    sender_id INT REFERENCES users(id),
    receiver_id INT REFERENCES users(id),
    message_text TEXT,
    image_url VARCHAR,
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- 11. Bảng Manual Search (Folder 3)
CREATE TABLE manual_search (
    id SERIAL PRIMARY KEY,
    link_nhom VARCHAR,
    noi_dung TEXT,
    uu_tien uu_tien_type DEFAULT 'giá rẻ',
    so_nguoi_o INT DEFAULT 2,
    xe_dien BOOLEAN DEFAULT FALSE,
    pet BOOLEAN DEFAULT FALSE,
    ban_cong BOOLEAN DEFAULT FALSE,
    loai_phong room_type_values,
    center_lat DECIMAL(10, 8),
    center_lng DECIMAL(11, 8),
    radius_km FLOAT DEFAULT 2,
    created_at TIMESTAMP DEFAULT NOW()
);

-- 12. Bảng Manual Matched Results (Output MANUAL)
CREATE TABLE manual_matched_results (
    id SERIAL PRIMARY KEY,
    manual_search_id INT REFERENCES manual_search(id),
    room_id INT REFERENCES rooms(id),
    distance_km FLOAT,
    match_score FLOAT,
    created_at TIMESTAMP DEFAULT NOW()
);