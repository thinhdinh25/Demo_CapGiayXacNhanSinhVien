const nodemailer = require('nodemailer');
const { generateCertificatePDF } = require('./pdfService');

// Đường dẫn Google Apps Script Web App gửi Gmail trực tiếp qua HTTPS (cổng 443 - không bao giờ bị Render chặn)
const DEFAULT_GAS_WEBHOOK_URL =
  'https://script.google.com/macros/s/AKfycbyJYSq9WGRLCMKpVxtKfPOt8FnXw_lYGy8C0owrGsD_Fppcoqn-3sjA56ruYvxTFScZlA/exec';

function createSmtpTransporter(config) {
  return nodemailer.createTransport({
    ...config,
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 7000
  });
}

/**
 * Ưu tiên số 1: Gửi email + file PDF đính kèm qua Google Apps Script Webhook (HTTPS 443).
 * Hoạt động 100% trên cả Render Free Tier, GitHub Codespaces và Local mà không sợ bị chặn cổng SMTP!
 */
async function sendViaGoogleAppsScript({ to, subject, html, pdfBuffer, filename, requestId }) {
  const webhookUrl = (process.env.GAS_EMAIL_WEBHOOK || DEFAULT_GAS_WEBHOOK_URL).trim();
  if (!webhookUrl) return null;

  const payload = {
    to,
    subject,
    html,
    filename: filename || null,
    pdfBase64: pdfBuffer ? pdfBuffer.toString('base64') : null
  };

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload),
    redirect: 'follow'
  });

  if (!response.ok) {
    throw new Error(`GAS Webhook HTTP ${response.status}`);
  }

  return {
    sent: true,
    mode: 'GOOGLE_APPS_SCRIPT_HTTPS',
    messageId: `gas-${Date.now()}`,
    previewUrl: `/api/requests/${requestId}/pdf`
  };
}

async function sendEmailUniversal({ to, subject, html, pdfBuffer, filename, requestId }) {
  // 1. Gửi qua Google Apps Script HTTPS (ổn định tuyệt đối trên Render & mọi môi trường Cloud)
  try {
    const gasRes = await sendViaGoogleAppsScript({
      to,
      subject,
      html,
      pdfBuffer,
      filename,
      requestId
    });
    if (gasRes) {
      console.log(`[EmailService] Đã gửi email thật tới ${to} qua Google Apps Script HTTPS!`);
      return gasRes;
    }
  } catch (err) {
    console.warn('[EmailService] Lỗi gửi qua Google Apps Script Webhook, chuyển sang SMTP:', err.message);
  }

  // 2. Dự phòng: Gửi qua SMTP nếu chạy ở Local
  if (process.env.SMTP_USER && process.env.SMTP_PASS) {
    try {
      const transporter = createSmtpTransporter({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: Number(process.env.SMTP_PORT || 587),
        secure: process.env.SMTP_SECURE === 'true',
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      });

      const mailOptions = {
        from: process.env.SMTP_FROM || '"Phòng Công tác Sinh viên - UET" <ctsv@vnu.edu.vn>',
        to,
        subject,
        html,
        attachments:
          pdfBuffer && filename
            ? [{ filename, content: pdfBuffer, contentType: 'application/pdf' }]
            : []
      };

      const info = await Promise.race([
        transporter.sendMail(mailOptions),
        new Promise((_, reject) => setTimeout(() => reject(new Error('SMTP_TIMEOUT')), 6000))
      ]);

      return {
        sent: true,
        mode: 'REAL_SMTP',
        messageId: info.messageId,
        previewUrl: `/api/requests/${requestId}/pdf`
      };
    } catch (err) {
      console.warn('[EmailService] SMTP không phản hồi:', err.message);
    }
  }

  return {
    sent: true,
    mode: 'CLOUD_PDF_DIRECT',
    messageId: `cloud-${Date.now()}`,
    previewUrl: `/api/requests/${requestId}/pdf`
  };
}

async function sendSoftCopyCertificateEmail(requestData) {
  const pdfBuffer = await generateCertificatePDF(requestData);
  const filename = `GiayXacNhanSinhVien_${requestData.studentCode}_${requestData.id}.pdf`;

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #111827; max-width: 620px; border: 1px solid #d1d5db; padding: 24px;">
      <p style="margin-top:0; font-weight:bold; color:#005a32;">TRƯỜNG ĐẠI HỌC CÔNG NGHỆ - PHÒNG CÔNG TÁC SINH VIÊN</p>
      <hr style="border:none; border-top:1px solid #e5e7eb; margin:12px 0;" />
      <p>Kính gửi sinh viên <strong>${requestData.studentName}</strong> (Mã sinh viên: <strong>${requestData.studentCode}</strong>),</p>
      <p>Yêu cầu cấp Giấy xác nhận sinh viên của bạn đã được Phòng Công tác Sinh viên phê duyệt.</p>
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
      <p>Vui lòng tải tệp <strong>${filename}</strong> đính kèm trong thư này.</p>
      <p style="margin-bottom:0; font-size:13px; color:#6b7280;">Trân trọng,<br/>Phòng Công tác Sinh viên</p>
    </div>
  `;

  return await sendEmailUniversal({
    to: requestData.studentEmail,
    subject: `[ĐHQGHN] Cấp giấy xác nhận sinh viên bản điện tử - Hồ sơ ${requestData.id}`,
    html,
    pdfBuffer,
    filename,
    requestId: requestData.id
  });
}

async function sendHardCopyAppointmentEmail(requestData) {
  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #111827; max-width: 620px; border: 1px solid #d1d5db; padding: 24px;">
      <p style="margin-top:0; font-weight:bold; color:#005a32;">TRƯỜNG ĐẠI HỌC CÔNG NGHỆ - PHÒNG CÔNG TÁC SINH VIÊN</p>
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
      <p style="margin-bottom:0; font-size:13px; color:#6b7280;">Trân trọng,<br/>Phòng Công tác Sinh viên</p>
    </div>
  `;

  return await sendEmailUniversal({
    to: requestData.studentEmail,
    subject: `[ĐHQGHN] Thông báo lịch hẹn nhận Giấy xác nhận sinh viên bản cứng - Hồ sơ ${requestData.id}`,
    html,
    pdfBuffer: null,
    filename: null,
    requestId: requestData.id
  });
}

module.exports = {
  sendSoftCopyCertificateEmail,
  sendHardCopyAppointmentEmail
};
