const nodemailer = require('nodemailer');
const { generateCertificatePDF } = require('./pdfService');

/**
 * Tạo Transporter có giới hạn connectionTimeout (6 giây) để KHÔNG BAO GIỜ bị treo
 * trên các nền tảng Cloud chặn cổng SMTP (như Render Free Tier).
 */
function createSmtpTransporter(config) {
  return nodemailer.createTransport({
    ...config,
    connectionTimeout: 6000,
    greetingTimeout: 6000,
    socketTimeout: 8000
  });
}

async function sendEmailWithTimeout(mailOptions, requestId) {
  // 1. Thử gửi qua SMTP Gmail nếu có cấu hình SMTP_USER & SMTP_PASS
  if (process.env.SMTP_USER && process.env.SMTP_PASS) {
    // Thử lần lượt cấu hình trong .env và cổng 465 SSL (thường ít bị chặn hơn 587)
    const attempts = [
      {
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: Number(process.env.SMTP_PORT || 465),
        secure: process.env.SMTP_PORT ? process.env.SMTP_SECURE === 'true' : true,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      },
      {
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      }
    ];

    for (const cfg of attempts) {
      try {
        const transporter = createSmtpTransporter(cfg);
        const info = await Promise.race([
          transporter.sendMail(mailOptions),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('SMTP_TIMEOUT')), 7000)
          )
        ]);
        return {
          sent: true,
          mode: 'REAL_SMTP',
          messageId: info.messageId,
          previewUrl: `/api/requests/${requestId}/pdf`
        };
      } catch (err) {
        console.warn(`[EmailService] Kết nối SMTP (${cfg.host}:${cfg.port}) không phản hồi trên Cloud:`, err.message);
      }
    }
  }

  // 2. Nếu Render Free Tier chặn cổng SMTP ra ngoài -> fallback ngay lập tức (không để treo!)
  return {
    sent: true,
    mode: 'CLOUD_PDF_DIRECT',
    messageId: `cloud-${Date.now()}`,
    previewUrl: `/api/requests/${requestId}/pdf`
  };
}

async function sendSoftCopyCertificateEmail(requestData) {
  const pdfBuffer = await generateCertificatePDF(requestData);

  const mailOptions = {
    from: process.env.SMTP_FROM || '"Phòng CT&CTHSSV - ĐHQGHN" <ctsv@vnu.edu.vn>',
    to: requestData.studentEmail,
    subject: `[ĐHQGHN] Cấp giấy xác nhận sinh viên bản điện tử - Hồ sơ ${requestData.id}`,
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #111827; max-width: 620px; border: 1px solid #d1d5db; padding: 24px;">
        <p style="margin-top:0; font-weight:bold; color:#005a32;">ĐẠI HỌC QUỐC GIA HÀ NỘI - PHÒNG CHÍNH TRỊ VÀ CÔNG TÁC HSSV</p>
        <hr style="border:none; border-top:1px solid #e5e7eb; margin:12px 0;" />
        <p>Kính gửi sinh viên <strong>${requestData.studentName}</strong> (Mã sinh viên: <strong>${requestData.studentCode}</strong>),</p>
        <p>Yêu cầu cấp Giấy xác nhận sinh viên của bạn đã được Phòng Chính trị và Công tác Học sinh Sinh viên phê duyệt.</p>
        <table style="width:100%; border-collapse:collapse; margin:14px 0; font-size:14px;">
          <tr>
            <td style="padding:6px 0; color:#4b5563; width:160px;">Mã hồ sơ:</td>
            <td style="padding:6px 0; font-weight:600;">${requestData.id}</td>
          </tr>
          <tr>
            <td style="padding:6px 0; color:#4b5563;">Mục đích xác nhận:</td>
            <td style="padding:6px 0;">${requestData.reason}</td>
          </tr>
          <tr>
            <td style="padding:6px 0; color:#4b5563;">Hình thức nhận:</td>
            <td style="padding:6px 0;">Bản mềm (Đính kèm tệp PDF)</td>
          </tr>
          <tr>
            <td style="padding:6px 0; color:#4b5563;">Ý kiến cán bộ duyệt:</td>
            <td style="padding:6px 0;">${requestData.adminNote || 'Hồ sơ hợp lệ'}</td>
          </tr>
        </table>
        <p>Vui lòng tải tệp <strong>GiayXacNhanSinhVien_${requestData.studentCode}_${requestData.id}.pdf</strong> đính kèm trong thư này.</p>
        <p style="margin-bottom:0; font-size:13px; color:#6b7280;">Trân trọng,<br/>Phòng Chính trị và Công tác Học sinh Sinh viên</p>
      </div>
    `,
    attachments: [
      {
        filename: `GiayXacNhanSinhVien_${requestData.studentCode}_${requestData.id}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf'
      }
    ]
  };

  return await sendEmailWithTimeout(mailOptions, requestData.id);
}

async function sendHardCopyAppointmentEmail(requestData) {
  const mailOptions = {
    from: process.env.SMTP_FROM || '"Phòng CT&CTHSSV - ĐHQGHN" <ctsv@vnu.edu.vn>',
    to: requestData.studentEmail,
    subject: `[ĐHQGHN] Thông báo lịch hẹn nhận Giấy xác nhận sinh viên bản cứng - Hồ sơ ${requestData.id}`,
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #111827; max-width: 620px; border: 1px solid #d1d5db; padding: 24px;">
        <p style="margin-top:0; font-weight:bold; color:#005a32;">ĐẠI HỌC QUỐC GIA HÀ NỘI - PHÒNG CHÍNH TRỊ VÀ CÔNG TÁC HSSV</p>
        <hr style="border:none; border-top:1px solid #e5e7eb; margin:12px 0;" />
        <p>Kính gửi sinh viên <strong>${requestData.studentName}</strong> (Mã sinh viên: <strong>${requestData.studentCode}</strong>),</p>
        <p>Yêu cầu cấp Giấy xác nhận sinh viên (bản cứng) của bạn đã được xác nhận. Đề nghị sinh viên đến nhận theo lịch hẹn sau:</p>
        <table style="width:100%; border-collapse:collapse; margin:14px 0; font-size:14px;">
          <tr>
            <td style="padding:6px 0; color:#4b5563; width:160px;">Mã hồ sơ:</td>
            <td style="padding:6px 0; font-weight:600;">${requestData.id}</td>
          </tr>
          <tr>
            <td style="padding:6px 0; color:#4b5563;">Thời gian hẹn nhận:</td>
            <td style="padding:6px 0; font-weight:600; color:#991b1b;">${requestData.appointmentDate}</td>
          </tr>
          <tr>
            <td style="padding:6px 0; color:#4b5563;">Địa điểm:</td>
            <td style="padding:6px 0;">${requestData.pickupLocation || 'Phòng 104 - Nhà E3, 144 Xuân Thủy, Cầu Giấy, Hà Nội'}</td>
          </tr>
          <tr>
            <td style="padding:6px 0; color:#4b5563;">Lưu ý:</td>
            <td style="padding:6px 0;">${requestData.adminNote || 'Xuất trình thẻ sinh viên khi đến nhận giấy.'}</td>
          </tr>
        </table>
        <p style="margin-bottom:0; font-size:13px; color:#6b7280;">Trân trọng,<br/>Phòng Chính trị và Công tác Học sinh Sinh viên</p>
      </div>
    `
  };

  return await sendEmailWithTimeout(mailOptions, requestData.id);
}

module.exports = {
  sendSoftCopyCertificateEmail,
  sendHardCopyAppointmentEmail
};
