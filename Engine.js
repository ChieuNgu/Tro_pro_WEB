/**
 * ENGINE XỬ LÝ LOGIC SO KHỚP (MATCHING ENGINE)
 * Chức năng: Tính toán khoảng cách, chấm điểm dịch vụ và lọc Top 6 phòng ưu tiên.
 */

const Engine = {
  // 1. Hàm tính khoảng cách giữa 2 tọa độ (Haversine Formula)
  haversineKm: (lat1, lon1, lat2, lon2) => {
    if (!lat1 || !lon1 || !lat2 || !lon2) return 999; // Trả về khoảng cách lớn nếu thiếu tọa độ
    const R = 6371; // Bán kính Trái Đất (km)
    const dLat = (lat2 - lat1) * (Math.PI / 180);
    const dLon = (lon2 - lon1) * (Math.PI / 180);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  },

  // 2. Hàm đánh giá điểm chất lượng dịch vụ của phòng
  // Trọng số: Khép kín (40đ), Điều hòa (30đ), Pet (25đ), Thang máy (20đ), Xe điện (20đ)
  calculateServiceScore: (room) => {
    let score = 0;

    // Phân loại phòng
    if (room.loai_phong === "Khép kín") score += 40;
    else if (room.loai_phong === "Chung chủ") score -= 10;

    // Tiện ích (Dựa trên các cột trong bảng rooms của bạn)
    if (room.has_air_conditioner || room.dieu_hoa) score += 30;
    if (room.has_elevator || room.thang_may) score += 20;
    if (room.has_balcony || room.ban_cong) score += 15;

    // Chính sách đặc biệt
    if (room.pet) score += 25;      // Cho nuôi thú cưng
    if (room.xe_dien) score += 20;  // Có chỗ sạc xe điện

    return score;
  },

  // 3. Logic chính xử lý theo cụm (Dùng cho cả Tự động và Thủ công)
  // Nhận vào mảng bài đăng, mảng phòng trong khu vực và bán kính (mặc định 2km)
  processLocationChunk: (postChunk, roomsInArea, radius = 2.0) => {
    let allResults = [];

    postChunk.forEach(post => {
      // BƯỚC A: Lọc phòng trong bán kính và chấm điểm
      const scoredRooms = roomsInArea.map(room => {
        const dist = Engine.haversineKm(
          post.center_lat, post.center_lng, 
          room.latitude, room.longitude
        );
        
        // Chỉ xét phòng trong bán kính 2km (hoặc tham số truyền vào)
        if (dist > radius) return null;

        const serviceScore = Engine.calculateServiceScore(room);

        return { ...room, dist, serviceScore };
      }).filter(Boolean); // Loại bỏ các phòng ở quá xa (null)

      // BƯỚC B: Chọn ra 6 phòng theo tiêu chí "2 Rẻ - 2 Gần - 2 Tốt"
      const selectedRoomIds = new Set();

      // 1. Lấy 2 phòng GIÁ RẺ NHẤT
      const topCheap = [...scoredRooms]
        .sort((a, b) => a.gia_thue - b.gia_thue)
        .slice(0, 2)
        .map(r => { selectedRoomIds.add(r.id); return { ...r, match_type: 'Giá rẻ' }; });

      // 2. Lấy 2 phòng GẦN NHẤT (không trùng nhóm trên)
      const topNear = scoredRooms
        .filter(r => !selectedRoomIds.has(r.id))
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 2)
        .map(r => { selectedRoomIds.add(r.id); return { ...r, match_type: 'Gần nhất' }; });

      // 3. Lấy 2 phòng DỊCH VỤ TỐT NHẤT (không trùng các nhóm trên)
      const topService = scoredRooms
        .filter(r => !selectedRoomIds.has(r.id))
        .sort((a, b) => b.serviceScore - a.serviceScore)
        .slice(0, 2)
        .map(r => { return { ...r, match_type: 'Dịch vụ tốt' }; });

      // BƯỚC C: Gộp lại và định dạng dữ liệu trả về cho DB
      const finalSelection = [...topCheap, ...topNear, ...topService];
      
      finalSelection.forEach(r => {
        allResults.push({
          post_id: post.id,
          room_id: r.id,
          match_type: r.match_type,
          distance_km: parseFloat(r.dist.toFixed(2)), // Làm tròn 2 chữ số thập phân
          score: r.serviceScore
        });
      });
    });

    return allResults;
  }
};

module.exports = Engine;