# Hệ thống Tự động hóa Quy trình Cấp Giấy Xác Nhận Sinh Viên (To-Be)

Dự án mẫu (Proof of Concept) thuộc học phần **Khoa học Dịch vụ – INT3501** (Nhóm 14 – Trường Đại học Công nghệ, ĐHQGHN), hiện thực hóa quy trình đề xuất (**To-Be**) cho thủ tục cấp giấy xác nhận sinh viên trên nền tảng **Camunda 8 (Zeebe / Built-in Engine)** kết hợp cổng dịch vụ Web **Node.js / Express**.

---

## 1. Tính năng cốt lõi (Quy trình To-Be)

1. **Cơ sở dữ liệu sinh viên (`data/students.json` & `studentDbService.js`)**:
   - Lưu trữ hồ sơ học vụ (`ACTIVE` – Đang theo học, `ON_LEAVE` – Đang bảo lưu, `DROPPED` – Đã thôi học), tình trạng công nợ học phí, ngày sinh, khóa học, chương trình đào tạo và khoa/viện.
   - Cho phép chuyên viên CTSV xem, thêm mới hoặc cập nhật trạng thái sinh viên trực tiếp trên giao diện Web để kiểm thử các nhánh phân luồng.
2. **Xử lý thẳng tự động – Straight-Through Processing (`STP`)**:
   - Worker `tra-cuu-mssv` tự động đối chiếu MSSV và phân loại mục đích xin giấy ngay khi sinh viên gửi yêu cầu:
     - **Không đủ điều kiện** (bảo lưu, thôi học, không tồn tại MSSV): Tự động từ chối và gửi email thông báo lý do (`EndEvent_KhongDuDieuKien`).
     - **Đủ điều kiện + Mục đích thông thường** (`HOC_BONG`, `VAY_VON`, `NGHIA_VU_QUAN_SU`, `VE_UU_DAI`) và không nợ học phí: **Duyệt thẳng (STP)** không cần chờ cán bộ, tự động sinh file PDF kèm mã QR xác thực trực tuyến (`sinh-giay-pdf`) và gửi email đính kèm PDF cho sinh viên (`gui-thong-bao-cap`).
     - **Hồ sơ ngoại lệ** (mục đích `KHAC` hoặc có cảnh báo công nợ học phí): Chuyển sang hàng đợi thẩm định của chuyên viên CTSV (`Task_DuyetNgoaiLe`).
3. **Bộ hẹn giờ nhắc hạn SLA không ngắt (`Non-interrupting Boundary Timer`)**:
   - Gắn trực tiếp vào tác vụ `Task_DuyetNgoaiLe` (`Timer_QuaHanSLA`, `cancelActivity="false"`).
   - Mốc thiết kế chuẩn là **4 giờ**; trên giao diện quản trị có thể chuyển nhanh giữa **10 giây / 1 phút / 4 giờ** để kiểm thử trực quan. Khi quá hạn, worker `nhac-viec-sla` tự động gửi email nhắc cán bộ CTSV và báo trưởng phòng trong khi tác vụ duyệt vẫn giữ nguyên.
4. **Nhận bản điện tử hoặc kèm bản cứng**:
   - Sinh viên chỉ cần bản điện tử kết thúc ngay tại `EndEvent_DaCapDienTu` (0 lần lên trường).
   - Sinh viên cần bản giấy dấu đỏ vẫn nhận trước bản PDF qua email kèm lịch hẹn đến quầy CTSV (`Task_PhatBanCung` -> `EndEvent_DaCapBanCung`).

---

## 2. Tài khoản dùng thử tích hợp sẵn

| Vai trò | Tài khoản / MSSV | Mật khẩu | Kịch bản kiểm thử tiêu biểu |
| :--- | :--- | :---: | :--- |
| **Sinh viên đủ điều kiện (STP)** | `24020313` (Đinh Đức Thịnh)<br>`24020097` (Vũ Việt Dũng)<br>`24020205` (Đào Mạnh Hải Long) | `123` | Nộp mục đích chuẩn -> **Duyệt thẳng (STP)**, nhận PDF + QR ngay lập tức |
| **Sinh viên nợ học phí (Ngoại lệ)** | `23021108` (Lê Hoàng Nam) | `123` | Tự động chuyển vào `Task_DuyetNgoaiLe` + kích hoạt đồng hồ đếm ngược **SLA** |
| **Sinh viên đang bảo lưu** | `22024019` (Phạm Quang Huy) | `123` | Hệ thống tự động từ chối tại cổng `MSSV hợp lệ?` và gửi email thông báo |
| **Chuyên viên Phòng CTSV** | `ctsv@vnu.edu.vn` | `123` | Duyệt/từ chối ngoại lệ, chỉnh mốc Timer SLA, xác nhận phát bản cứng, quản lý CSDL |

*(Ngoài ra hỗ trợ đăng nhập một lần bằng tài khoản Google `@vnu.edu.vn` khi khai báo `GOOGLE_CLIENT_ID` trong `.env`.)*

---

## 3. Hướng dẫn cài đặt và chạy dự án

### Cách 1: Chạy nhanh trên máy cá nhân (Camunda 8 Built-in Engine)
```powershell
npm.cmd install
node server.js
```
Mở trình duyệt tại địa chỉ: `http://localhost:3000`.
*(Trên Windows PowerShell nếu bị chặn `npm.ps1`, sử dụng `npm.cmd` thay cho `npm`.)*

### Cách 2: Chạy kết hợp cụm Camunda 8 Zeebe Broker qua Docker
```bash
docker compose up -d --build
# Hoặc chỉ chạy Zeebe trên Docker và chạy Web ở máy host:
docker compose up -d zeebe
npm run deploy-bpmn
ZEEBE_ADDRESS=localhost:26500 node server.js
```

### Cách 3: Tái lập thực nghiệm 40 hồ sơ KPI (Chương 5 & Phụ lục)
```powershell
node scripts/run-kpi-batch.js
```
Script tự động khởi tạo và chạy 40 hồ sơ thuộc 4 kịch bản (`32 stp`, `3 duyet_ngoai_le`, `2 tu_choi`, `3 qua_han_sla`), xuất dữ liệu đo đạc ra:
- `data/kpi_scenario_instances.csv`
- `data/kpi_element_instances.csv`
- `data/kpi_summary.json`

---

## 4. Cấu trúc thư mục

```text
Demo_CapGiayXacNhanSinhVien/
├── bpmn/
│   └── student-certificate.bpmn     # Mô hình BPMN 2.0 thực thi (Pool 2 Lane, STP, Non-interrupting Timer SLA)
├── data/
│   ├── students.json                # CSDL sinh viên mẫu (trạng thái học vụ, công nợ, khóa, ngành)
│   ├── requests.json                # Lưu trữ trạng thái hồ sơ & lịch sử sự kiện BPMN
│   ├── kpi_scenario_instances.csv   # Log thực nghiệm 40 hồ sơ theo kịch bản
│   └── kpi_element_instances.csv    # Log thời gian thực thi từng bước BPMN
├── public/
│   └── index.html                   # Giao diện Cổng dịch vụ Sinh viên & Bảng điều khiển CTSV
├── scripts/
│   ├── deploy-bpmn.js               # Script deploy mô hình BPMN lên Zeebe Broker
│   └── run-kpi-batch.js             # Script chạy tự động batch 40 hồ sơ và xuất thống kê KPI
├── services/
│   ├── studentDbService.js          # Dịch vụ tra cứu CSDL sinh viên & phân loại STP / Ngoại lệ
│   ├── camundaService.js            # Điều phối Zeebe / Built-in Engine, Job Workers & SLA Timer
│   ├── pdfService.js                # Sinh Giấy xác nhận PDF hành chính kèm mã QR xác thực
│   └── emailService.js              # Gửi email cấp giấy, email từ chối và email nhắc hạn SLA
├── report/
│   └── baocaokhdv.docx              # Báo cáo bài tập lớn học phần Khoa học dịch vụ (INT3501)
├── server.js                        # Express REST API Server
├── docker-compose.yml               # Cấu hình triển khai Zeebe 8.5 + Webapp
└── .env.example                     # Mẫu biến môi trường cấu hình hệ thống
```
