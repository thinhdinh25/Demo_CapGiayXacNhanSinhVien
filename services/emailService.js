const nodemailer = require('nodemailer');
const { generateCertificatePDF } = require('./pdfService');

let cachedTransporter = null;
let etherealAccountInfo = null;

async function getTransporter() {
  if (cachedTransporter) return cachedTransporter;

  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    cachedTransporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });
    return cachedTransporter;
  }

  try {
    const testAccount = await nodemailer.createTestAccount();
    etherealAccountInfo = testAccount;
    cachedTransporter = nodemailer.createTransport({
      host: testAccount.smtp.host,
      port: testAccount.smtp.port,
      secure: testAccount.smtp.secure,
      auth: {
        user: testAccount.user,
        pass: testAccount.pass
      }
    });
    return cachedTransporter;
  } catch (err) {
    return null;
  }
}

async function sendSoftCopyCertificateEmail(requestData) {
  const pdfBuffer = await generateCertificatePDF(requestData);
  const transporter = await getTransporter();

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

  if (!transporter) {
    return {
      sent: true,
      mode: 'LOCAL_FALLBACK',
      previewUrl: `/api/requests/${requestData.id}/pdf`,
      messageId: `local-${Date.now()}`
    };
  }

  const info = await transporter.sendMail(mailOptions);
  const previewUrl = nodemailer.getTestMessageUrl(info) || null;

  return {
    sent: true,
    mode: etherealAccountInfo ? 'ETHEREAL_SMTP' : 'REAL_SMTP',
    messageId: info.messageId,
    previewUrl
  };
}

async function sendHardCopyAppointmentEmail(requestData) {
  const transporter = await getTransporter();
  if (!transporter) {
    return { sent: true, mode: 'LOCAL_FALLBACK', previewUrl: null };
  }

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

  const info = await transporter.sendMail(mailOptions);
  const previewUrl = nodemailer.getTestMessageUrl(info) || null;
  return {
    sent: true,
    mode: etherealAccountInfo ? 'ETHEREAL_SMTP' : 'REAL_SMTP',
    messageId: info.messageId,
    previewUrl
  };
}

module.exports = {
  sendSoftCopyCertificateEmail,
  sendHardCopyAppointmentEmail
};
