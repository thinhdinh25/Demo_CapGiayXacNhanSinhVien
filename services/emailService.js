const nodemailer = require('nodemailer');
const { generateCertificatePDF } = require('./pdfService');

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

async function sendViaGoogleAppsScript({ to, subject, html, pdfBuffer, filename, requestId }) {
  const webhookUrl = (process.env.GAS_EMAIL_WEBHOOK || DEFAULT_GAS_WEBHOOK_URL).trim();
  if (!webhookUrl || process.env.DISABLE_GAS_WEBHOOK === 'true') return null;

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

async function sendEmailUniversal({ to, subject, html, pdfBuffer, filename, requestId, simulateOnly = false }) {
  const actualRecipient = (process.env.EMAIL_OVERRIDE_TO || to || '').trim();

  // Cho phép chế độ mô phỏng nhanh khi chạy script batch 40 hồ sơ để tránh giới hạn quota Gmail
  if (simulateOnly || process.env.EMAIL_SIMULATE_ONLY === 'true') {
    await new Promise((r) => setTimeout(r, 35));
    return {
      sent: true,
      mode: 'SIMULATED_SMTP',
      to: actualRecipient,
      subject,
      htmlSnapshot: html,
      messageId: `sim-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      previewUrl: pdfBuffer ? `/api/requests/${requestId}/pdf` : `/api/requests/${requestId}/email-preview`
    };
  }

  // 1. Gửi qua Google Apps Script HTTPS
  try {
    const gasRes = await sendViaGoogleAppsScript({
      to: actualRecipient,
      subject,
      html,
      pdfBuffer,
      filename,
      requestId
    });
    if (gasRes) {
      return {
        ...gasRes,
        to: actualRecipient,
        subject,
        htmlSnapshot: html,
        previewUrl: `/api/requests/${requestId}/email-preview`
      };
    }
  } catch (err) {
    console.warn('[EmailService] Lỗi GAS Webhook, chuyển sang SMTP:', err.message);
  }

  // 2. Dự phòng: Gửi qua SMTP trong .env
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
        to: actualRecipient,
        subject,
        html,
        attachments:
          pdfBuffer && filename
            ? [{ filename, content: pdfBuffer, contentType: 'application/pdf' }]
            : []
      };

      const info = await Promise.race([
        transporter.sendMail(mailOptions),
        new Promise((_, reject) => setTimeout(() => reject(new Error('SMTP_TIMEOUT')), 6500))
      ]);

      return {
        sent: true,
        mode: 'REAL_SMTP',
        to: actualRecipient,
        subject,
        htmlSnapshot: html,
        messageId: info.messageId,
        previewUrl: `/api/requests/${requestId}/email-preview`
      };
    } catch (err) {
      console.warn('[EmailService] SMTP không phản hồi:', err.message);
    }
  }

  return {
    sent: true,
    mode: 'LOCAL_EMAIL_LOG',
    to: actualRecipient,
    subject,
    htmlSnapshot: html,
    messageId: `local-${Date.now()}`,
    previewUrl: `/api/requests/${requestId}/email-preview`
  };
}

/**
 * 1. Email cấp Giấy xác nhận sinh viên (đính kèm PDF có QR xác thực; kèm lịch hẹn nếu sinh viên đăng ký thêm bản cứng)
 */
async function sendApprovedCertificateEmail(requestData, pdfBufferInput = null, options = {}) {
  const pdfBuffer = pdfBufferInput || (await generateCertificatePDF(requestData));
  const filename = `GiayXacNhanSinhVien_${requestData.studentCode}_${requestData.id}.pdf`;

  const hardCopyBlock =
    requestData.copyType === 'HARD'
      ? `
      <div style="margin:14px 0; padding:12px 14px; background:#eff6ff; border-left:4px solid #1d4ed8; font-size:14px;">
        <strong>Lịch hẹn nhận bản cứng đóng dấu đỏ:</strong><br/>
        - Thời gian hẹn: <strong>${requestData.appointmentDate || 'Trong giờ hành chính ngày làm việc kế tiếp'}</strong><br/>
        - Địa điểm: ${requestData.pickupLocation || 'Phòng Công tác Sinh viên - P.104 Nhà E3, 144 Xuân Thủy'}<br/>
        - Lưu ý: Sinh viên xuất trình thẻ sinh viên khi đến nhận giấy.
      </div>`
      : '';

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #111827; max-width: 640px; border: 1px solid #d1d5db; padding: 24px; background:#ffffff;">
      <p style="margin-top:0; font-weight:bold; color:#005a32;">TRƯỜNG ĐẠI HỌC CÔNG NGHỆ - PHÒNG CÔNG TÁC SINH VIÊN</p>
      <hr style="border:none; border-top:1px solid #e5e7eb; margin:12px 0;" />
      <p>Kính gửi sinh viên <strong>${requestData.studentName}</strong> (MSSV: <strong>${requestData.studentCode}</strong>),</p>
      <p>Yêu cầu cấp Giấy xác nhận sinh viên của bạn đã được phê duyệt (${
        requestData.processingMode === 'STP' ? 'xử lý thẳng tự động STP' : 'chuyên viên CTSV thẩm định'
      }).</p>
      <table style="width:100%; border-collapse:collapse; margin:14px 0; font-size:14px;">
        <tr>
          <td style="padding:5px 0; color:#4b5563; width:170px;">Số giấy / Mã hồ sơ:</td>
          <td style="padding:5px 0; font-weight:600;">${requestData.certificateNo || requestData.id + '/GXN-ĐHCN'}</td>
        </tr>
        <tr>
          <td style="padding:5px 0; color:#4b5563;">Mã xác thực QR:</td>
          <td style="padding:5px 0; font-weight:600; color:#1e3a8a;">${requestData.verificationCode || requestData.id}</td>
        </tr>
        <tr>
          <td style="padding:5px 0; color:#4b5563;">Mục đích xác nhận:</td>
          <td style="padding:5px 0;">${requestData.reason}</td>
        </tr>
        <tr>
          <td style="padding:5px 0; color:#4b5563;">Hình thức nhận:</td>
          <td style="padding:5px 0;">${
            requestData.copyType === 'SOFT'
              ? 'Bản điện tử PDF có mã QR xác thực'
              : 'Bản điện tử PDF kèm nhận bản giấy tại Phòng CTSV'
          }</td>
        </tr>
        <tr>
          <td style="padding:5px 0; color:#4b5563;">Ghi chú xử lý:</td>
          <td style="padding:5px 0;">${requestData.adminNote || 'Hồ sơ hợp lệ'}</td>
        </tr>
      </table>
      ${hardCopyBlock}
      <p>Tệp <strong>${filename}</strong> đã được đính kèm trong email này.</p>
      <p style="margin-bottom:0; font-size:13px; color:#6b7280;">Trân trọng,<br/>Phòng Công tác Sinh viên - Trường ĐH Công nghệ, ĐHQGHN</p>
    </div>
  `;

  return await sendEmailUniversal({
    to: requestData.studentEmail,
    subject: `[UET-CTSV] Đã cấp Giấy xác nhận sinh viên - Hồ sơ ${requestData.id}`,
    html,
    pdfBuffer,
    filename,
    requestId: requestData.id,
    simulateOnly: Boolean(options.simulateOnly)
  });
}

/**
 * 2. Email thông báo từ chối / không đủ điều kiện kèm lý do
 */
async function sendRejectionNoticeEmail(requestData, reasonText, options = {}) {
  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #111827; max-width: 640px; border: 1px solid #fecaca; padding: 24px; background:#ffffff;">
      <p style="margin-top:0; font-weight:bold; color:#991b1b;">TRƯỜNG ĐẠI HỌC CÔNG NGHỆ - PHÒNG CÔNG TÁC SINH VIÊN</p>
      <hr style="border:none; border-top:1px solid #fee2e2; margin:12px 0;" />
      <p>Chào <strong>${requestData.studentName}</strong> (MSSV: <strong>${requestData.studentCode}</strong>),</p>
      <p>Yêu cầu cấp Giấy xác nhận sinh viên (Mã hồ sơ: <strong>${requestData.id}</strong>) chưa thể phê duyệt vì lý do sau:</p>
      <div style="margin:14px 0; padding:12px 14px; background:#fef2f2; border-left:4px solid #dc2626; font-size:14px;">
        <strong>Lý do từ chối / cần bổ sung:</strong> ${reasonText || 'Chưa đủ điều kiện hoặc thiếu thông tin minh chứng.'}
      </div>
      <p>Mục đích đã đăng ký: ${requestData.reason}</p>
      <p>Nếu cần giải đáp hoặc bổ sung minh chứng, sinh viên vui lòng liên hệ Phòng Công tác Sinh viên (P.104 - Nhà E3) hoặc gửi lại yêu cầu mới.</p>
      <p style="margin-bottom:0; font-size:13px; color:#6b7280;">Trân trọng,<br/>Phòng Công tác Sinh viên - Trường ĐH Công nghệ, ĐHQGHN</p>
    </div>
  `;

  return await sendEmailUniversal({
    to: requestData.studentEmail,
    subject: `[UET-CTSV] Thông báo từ chối / yêu cầu bổ sung hồ sơ ${requestData.id}`,
    html,
    pdfBuffer: null,
    filename: null,
    requestId: requestData.id,
    simulateOnly: Boolean(options.simulateOnly)
  });
}

/**
 * 3. Email nhắc việc SLA (gửi cán bộ CTSV & trưởng phòng khi hồ sơ ngoại lệ chờ duyệt quá hạn)
 */
async function sendSlaOverdueReminderEmail(requestData, slaThresholdLabel, options = {}) {
  const staffRecipient =
    process.env.SLA_NOTIFY_EMAIL || process.env.SMTP_USER || 'ctsv@vnu.edu.vn';

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #111827; max-width: 640px; border: 1px solid #fcd34d; padding: 24px; background:#ffffff;">
      <p style="margin-top:0; font-weight:bold; color:#92400e;">[CẢNH BÁO SLA] NHẮC DUYỆT HỒ SƠ NGOẠI LỆ QUÁ THỜI HẠN</p>
      <hr style="border:none; border-top:1px solid #fde68a; margin:12px 0;" />
      <p>Kính gửi <strong>Chuyên viên phụ trách &amp; Trưởng phòng Công tác Sinh viên</strong>,</p>
      <p>Hệ thống điều phối quy trình ghi nhận một hồ sơ ngoại lệ đang chờ duyệt vượt quá mốc cam kết SLA (<strong>${slaThresholdLabel}</strong>):</p>
      <table style="width:100%; border-collapse:collapse; margin:14px 0; font-size:14px;">
        <tr>
          <td style="padding:5px 0; color:#4b5563; width:170px;">Mã hồ sơ:</td>
          <td style="padding:5px 0; font-weight:600;">${requestData.id}</td>
        </tr>
        <tr>
          <td style="padding:5px 0; color:#4b5563;">Sinh viên:</td>
          <td style="padding:5px 0;">${requestData.studentName} (MSSV: <strong>${requestData.studentCode}</strong>)</td>
        </tr>
        <tr>
          <td style="padding:5px 0; color:#4b5563;">Mục đích xin giấy:</td>
          <td style="padding:5px 0;">${requestData.reason}</td>
        </tr>
        <tr>
          <td style="padding:5px 0; color:#4b5563;">Lý do chuyển duyệt tay:</td>
          <td style="padding:5px 0; color:#92400e;">${requestData.classificationReason || 'Hồ sơ ngoại lệ cần thẩm định'}</td>
        </tr>
      </table>
      <p>Tác vụ <strong>Duyệt ngoại lệ</strong> vẫn đang được giữ trên danh sách công việc (bộ hẹn giờ không ngắt). Đề nghị cán bộ truy cập cổng quản trị để xử lý sớm.</p>
      <p style="margin-bottom:0; font-size:13px; color:#6b7280;">Hệ thống tự động Camunda 8 BPMN - UET</p>
    </div>
  `;

  return await sendEmailUniversal({
    to: staffRecipient,
    subject: `[SLA Nhắc việc] Hồ sơ ${requestData.id} của SV ${requestData.studentName} (${requestData.studentCode}) quá hạn chờ duyệt`,
    html,
    pdfBuffer: null,
    filename: null,
    requestId: requestData.id,
    simulateOnly: Boolean(options.simulateOnly)
  });
}

module.exports = {
  sendApprovedCertificateEmail,
  sendRejectionNoticeEmail,
  sendSlaOverdueReminderEmail
};
