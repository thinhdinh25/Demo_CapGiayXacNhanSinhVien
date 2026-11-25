# Hệ Thống Cấp Giấy Xác Nhận Sinh Viên (Camunda 8 BPMN)

Ứng dụng Web đơn giản tích hợp **Camunda 8 (Zeebe)** phục vụ quy trình xin cấp và duyệt **Giấy xác nhận sinh viên** với 2 hình thức **Bản mềm (tự động gửi PDF qua Email)** và **Bản cứng (Admin hẹn lịch lấy)**.

---

## 1. Tài khoản đăng nhập (2 User)

| Vai trò | Tài khoản (`username`) | Mật khẩu (`password`) | Chức năng chính |
| :--- | :--- | :--- | :--- |
| **Sinh viên** | `sinhvien` | `123` | Gửi yêu cầu cấp giấy xác nhận, chọn **Bản mềm** hoặc **Bản cứng**, nhập Email nhận giấy, theo dõi trạng thái & tải PDF |
| **Admin** | `admin` | `123` | **Verify (Xác minh & Duyệt)** yêu cầu của sinh viên: nếu là **Bản cứng** thì chọn ngày/giờ hẹn lịch lấy; nếu là **Bản mềm** sau khi bấm Verify hệ thống tự động tạo PDF và gửi qua Email sinh viên |

*(Trên màn hình đăng nhập có sẵn 2 nút bấm chọn nhanh tài khoản **Sinh viên** và **Admin**)*

---

## 2. Quy trình Camunda 8 BPMN (`bpmn/student-certificate.bpmn`)

File quy trình chuẩn Camunda 8 Zeebe được đặt tại [`bpmn/student-certificate.bpmn`](bpmn/student-certificate.bpmn) (có thể mở bằng **Camunda Modeler 5.x** hoặc **Camunda 8 Web Modeler**):

1. **Start Event (`StartEvent_RequestSubmitted`)**: Sinh viên gửi yêu cầu cấp giấy xác nhận (`copyType = "SOFT"` hoặc `"HARD"`).
2. **Service Task (`Task_AdminVerify` - type: `admin-verify-certificate`)**: Hồ sơ nằm chờ Admin bấm **Verify** trên giao diện Web.
3. **Exclusive Gateway (`Gateway_IsApproved`)**: Kiểm tra `=approved = true` hay `=approved = false`.
4. **Exclusive Gateway (`Gateway_CopyType`)**: Phân luồng theo loại bản cấp:
   - Nếu `=copyType = "SOFT"` (**Bản mềm**) ➡️ Chạy Service Task **`Task_SendSoftCopyEmail`** (`type: send-soft-copy-email`): Worker tự động sinh file PDF Giấy xác nhận sinh viên có dấu xác thực và gửi thẳng vào Email sinh viên.
   - Nếu `=copyType = "HARD"` (**Bản cứng**) ➡️ Chạy Service Task **`Task_ScheduleHardCopy`** (`type: schedule-hard-copy`): Worker ghi nhận lịch hẹn ngày/giờ và địa điểm lấy bản cứng cho sinh viên.

---

## 3. Cách chạy trực tiếp trên máy (Local)

```bash
npm install
npm start
```

Mở trình duyệt tại: **http://localhost:3000**

> **Lưu ý:** Ứng dụng có cơ chế **Dual-Mode (Tự động thích ứng)**:
> - Nếu bạn bật cụm **Camunda 8 Zeebe** (qua Docker hoặc Camunda 8 SaaS), ứng dụng sẽ kết nối trực tiếp vào Zeebe Broker thông qua `@camunda8/sdk`, tự động deploy file `student-certificate.bpmn` và chạy 3 Zeebe Workers thật.
> - Nếu chưa bật Docker/Zeebe bên ngoài, ứng dụng tự động dùng **Camunda 8 Built-in Engine** đi kèm để bạn vẫn chạy thử toàn bộ luồng BPMN, tạo PDF và gửi Email ngay lập tức mà không bị lỗi kết nối.

---

## 4. Cách chạy cả Camunda 8 (Zeebe) + Web Public ngay trên GitHub (GitHub Codespaces)

Dự án đã được cấu hình sẵn [`.devcontainer/devcontainer.json`](.devcontainer/devcontainer.json) và [`docker-compose.yml`](docker-compose.yml) để bạn chạy trực tiếp cả cụm **Camunda 8 Zeebe** trên GitHub với đường link Web **Public**:

1. Đẩy code lên repository GitHub của bạn.
2. Trên giao diện GitHub repo, bấm nút **`<> Code`** ➡️ chọn tab **`Codespaces`** ➡️ bấm **`Create codespace on main`**.
3. Khi cửa sổ Codespaces mở ra:
   - **Cách A (Chạy Web ngay trong 2 giây):**
     ```bash
     npm start
     ```
   - **Cách B (Chạy cả cụm Camunda 8 Zeebe Broker thật bằng Docker trên GitHub Codespaces):**
     ```bash
     docker-compose up -d
     ```
4. Ở tab **PORTS** bên dưới GitHub Codespaces, cổng `3000` đã được cấu hình sẵn `visibility: public` — bạn có thể mở link public đó để truy cập web từ bất kỳ thiết bị nào!

---

## 5. Cấu hình gửi Email Bản mềm (Gmail thật hoặc Ethereal Email tự động)

- **Mặc định (Không cần cấu hình gì thêm):** Hệ thống sử dụng `nodemailer` tự động tạo hộp thư **Ethereal SMTP** miễn phí. Ngay sau khi Admin bấm **Verify** một yêu cầu **Bản mềm**, trên màn hình sẽ hiện nút **"📬 Mở xem Email đã gửi"** để bạn xem trực tiếp email vừa gửi kèm file PDF đính kèm, hoặc bấm **"📄 Tải / Xem Giấy Xác Nhận (PDF)"**.
- **Gửi qua Gmail thật:** Tạo file `.env` (dựa theo [`.env.example`](.env.example)) và điền `SMTP_HOST=smtp.gmail.com`, `SMTP_USER`, `SMTP_PASS` (App Password 16 ký tự của Gmail).
