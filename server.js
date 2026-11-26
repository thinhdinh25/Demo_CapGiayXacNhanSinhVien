require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const { OAuth2Client } = require('google-auth-library');
const { camundaManager } = require('./services/camundaService');
const { generateCertificatePDF } = require('./services/pdfService');
const {
  STANDARD_PURPOSES,
  getAllStudents,
  getStudentByCode,
  upsertStudent
} = require('./services/studentDbService');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let runtimeGoogleClientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
let restrictVnuDomainOnly = process.env.GOOGLE_RESTRICT_VNU_DOMAIN === 'true';
const adminEmailSet = new Set(
  String(process.env.ADMIN_EMAILS || 'ctsv@vnu.edu.vn,admin@vnu.edu.vn,thinhdinh26117@gmail.com')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

const ADMIN_ACCOUNT = {
  username: 'ctsv@vnu.edu.vn',
  aliases: ['ctsv@vnu.edu.vn', 'admin@vnu.edu.vn', 'admin'],
  password: '123',
  role: 'ADMIN',
  fullName: 'Phòng Công tác Sinh viên - UET',
  defaultEmail: 'thinhdinh26117@gmail.com'
};

const sessions = new Map();

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token || !sessions.has(token)) {
    return res.status(401).json({ error: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.' });
  }
  req.user = sessions.get(token);
  next();
}

// 1. API Đăng nhập bằng tài khoản/mật khẩu (Hỗ trợ cả Admin và Sinh viên theo MSSV / mật khẩu 123 để demo thuận tiện)
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const rawInput = String(username || '').trim().toLowerCase();
  const rawPass = String(password || '').trim();

  if (!rawInput || !rawPass) {
    return res.status(400).json({ error: 'Vui lòng nhập tài khoản và mật khẩu.' });
  }

  // Tài khoản Cán bộ Admin
  if (ADMIN_ACCOUNT.aliases.includes(rawInput) && rawPass === ADMIN_ACCOUNT.password) {
    const token = 'adm_' + Date.now();
    const safeUser = {
      username: ADMIN_ACCOUNT.username,
      role: 'ADMIN',
      fullName: ADMIN_ACCOUNT.fullName,
      studentCode: null,
      faculty: 'Trường Đại học Công nghệ - ĐHQGHN',
      defaultEmail: ADMIN_ACCOUNT.defaultEmail
    };
    sessions.set(token, safeUser);
    return res.json({ token, user: safeUser });
  }

  // Tài khoản Sinh viên tra cứu từ CSDL (nhập MSSV hoặc email @vnu.edu.vn, mật khẩu mặc định 123)
  const codeCandidate = rawInput.replace('@vnu.edu.vn', '').trim();
  const stu =
    getStudentByCode(codeCandidate) ||
    (rawInput === 'sinhvien' ? getStudentByCode('24020313') : null);

  if (stu && rawPass === '123') {
    const token = 'stu_' + stu.studentCode + '_' + Date.now();
    const safeUser = {
      username: stu.email,
      role: 'STUDENT',
      fullName: stu.fullName,
      studentCode: stu.studentCode,
      faculty: stu.faculty,
      defaultEmail: stu.email
    };
    sessions.set(token, safeUser);
    return res.json({ token, user: safeUser });
  }

  return res.status(401).json({
    error: 'Sai thông tin đăng nhập. Cán bộ dùng ctsv@vnu.edu.vn / 123; Sinh viên dùng MSSV / 123 hoặc Google OAuth.'
  });
});

// 2. API Cấu hình Google OAuth 2.0
app.get('/api/auth/config', (req, res) => {
  res.json({
    googleClientId: runtimeGoogleClientId || null,
    restrictVnuDomainOnly
  });
});

app.post('/api/auth/config', (req, res) => {
  const { googleClientId, restrictVnuOnly } = req.body;
  runtimeGoogleClientId = String(googleClientId || '').trim();
  if (typeof restrictVnuOnly === 'boolean') {
    restrictVnuDomainOnly = restrictVnuOnly;
  }

  try {
    const envPath = path.join(__dirname, '.env');
    let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    if (envContent.includes('GOOGLE_CLIENT_ID=')) {
      envContent = envContent.replace(/GOOGLE_CLIENT_ID=.*/g, `GOOGLE_CLIENT_ID=${runtimeGoogleClientId}`);
    } else {
      envContent += `\nGOOGLE_CLIENT_ID=${runtimeGoogleClientId}\n`;
    }
    fs.writeFileSync(envPath, envContent.trim() + '\n', 'utf8');
  } catch (e) {}

  res.json({
    message: 'Đã lưu cấu hình Google OAuth Client ID.',
    googleClientId: runtimeGoogleClientId,
    restrictVnuDomainOnly
  });
});

// 3. API Xác thực Google OAuth 2.0
app.post('/api/auth/google', async (req, res) => {
  try {
    const { credential, accessToken, clientId } = req.body;
    const activeClientId = (clientId || runtimeGoogleClientId || '').trim();

    if (!activeClientId) {
      return res.status(400).json({
        error: 'Chưa cấu hình GOOGLE_CLIENT_ID. Vui lòng nhập Google OAuth Client ID hoặc dùng tài khoản MSSV / 123.'
      });
    }

    let googlePayload = null;

    if (credential) {
      const oauthClient = new OAuth2Client(activeClientId);
      const ticket = await oauthClient.verifyIdToken({
        idToken: credential,
        audience: activeClientId
      });
      googlePayload = ticket.getPayload();
    } else if (accessToken) {
      const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      if (!userInfoRes.ok) {
        throw new Error('Access Token Google không hợp lệ hoặc đã hết hạn.');
      }
      googlePayload = await userInfoRes.json();
    } else {
      return res.status(400).json({ error: 'Thiếu thông tin xác thực từ Google.' });
    }

    if (!googlePayload || !googlePayload.email) {
      return res.status(401).json({ error: 'Không lấy được địa chỉ email từ tài khoản Google.' });
    }

    const email = String(googlePayload.email).toLowerCase();
    const localPart = email.split('@')[0];

    if (restrictVnuDomainOnly && !email.endsWith('@vnu.edu.vn') && !adminEmailSet.has(email)) {
      return res.status(403).json({
        error: `Truy cập bị từ chối: Tài khoản ${email} không thuộc tên miền @vnu.edu.vn.`
      });
    }

    const isAdminEmail = adminEmailSet.has(email);
    const studentCodeMatch = localPart.match(/\d{8}/);
    const matchedCode = studentCodeMatch ? studentCodeMatch[0] : '24020313';
    const dbStudent = getStudentByCode(matchedCode);

    const safeUser = isAdminEmail
      ? {
          username: email,
          role: 'ADMIN',
          fullName: googlePayload.name || 'Chuyên viên CTSV',
          studentCode: null,
          faculty: 'Trường Đại học Công nghệ - ĐHQGHN',
          defaultEmail: email,
          authProvider: 'GOOGLE_OAUTH_2.0'
        }
      : {
          username: email,
          role: 'STUDENT',
          fullName: (dbStudent && dbStudent.fullName) || googlePayload.name || localPart,
          studentCode: matchedCode,
          faculty: (dbStudent && dbStudent.faculty) || 'Khoa Công nghệ Thông tin - Trường ĐH Công nghệ',
          defaultEmail: email,
          authProvider: 'GOOGLE_OAUTH_2.0',
          picture: googlePayload.picture || null
        };

    const token = 'goog_' + Buffer.from(email).toString('hex').slice(0, 12) + '_' + Date.now();
    sessions.set(token, safeUser);

    res.json({ token, user: safeUser });
  } catch (err) {
    res.status(401).json({
      error: 'Xác thực Google OAuth thất bại: ' + err.message
    });
  }
});

// 4. API Danh mục mục đích & CSDL Sinh viên
app.get('/api/purposes', (req, res) => {
  res.json({ purposes: STANDARD_PURPOSES });
});

app.get('/api/students', authMiddleware, (req, res) => {
  res.json({ students: getAllStudents() });
});

app.get('/api/students/:code', authMiddleware, (req, res) => {
  const s = getStudentByCode(req.params.code);
  if (!s) {
    return res.status(404).json({ error: 'Không tìm thấy sinh viên trong CSDL.' });
  }
  res.json({ student: s });
});

app.post('/api/students', authMiddleware, (req, res) => {
  try {
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Chỉ cán bộ quản trị mới được cập nhật CSDL sinh viên.' });
    }
    const saved = upsertStudent(req.body);
    res.json({
      message: `Đã cập nhật thông tin sinh viên ${saved.fullName} (${saved.studentCode}) vào CSDL.`,
      student: saved
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 5. API Cấu hình & Theo dõi SLA / Engine
app.get('/api/sla-config', authMiddleware, (req, res) => {
  res.json(camundaManager.getSlaConfig());
});

app.post('/api/sla-config', authMiddleware, (req, res) => {
  try {
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Chỉ Admin mới được thay đổi cấu hình SLA.' });
    }
    const updated = camundaManager.setSlaTimeoutMs(req.body.slaTimeoutMs);
    res.json({
      message: `Đã cập nhật mốc hẹn giờ nhắc việc SLA thành ${updated.slaLabel}.`,
      config: updated
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 6. API Thống kê KPI trực tiếp
app.get('/api/stats', authMiddleware, (req, res) => {
  const all = camundaManager.getAllRequests();
  const total = all.length;
  const stpCount = all.filter((r) => r.processingMode === 'STP').length;
  const exceptionCount = all.filter((r) => r.processingMode === 'MANUAL_EXCEPTION').length;
  const autoRejectedCount = all.filter((r) => r.processingMode === 'AUTO_REJECTED').length;
  const pendingCount = all.filter((r) => r.status === 'PENDING_VERIFY').length;
  const waitingHardCount = all.filter((r) => r.status === 'WAITING_HARD_PICKUP').length;
  const slaRemindedCount = all.filter((r) => r.slaReminded).length;
  const approvedCount = all.filter((r) => r.approved === true).length;
  const rejectedCount = all.filter((r) => r.approved === false).length;

  const completedWithLead = all.filter((r) => typeof r.leadTimeMs === 'number');
  const avgLeadTimeSec =
    completedWithLead.length > 0
      ? Number(
          (
            completedWithLead.reduce((acc, r) => acc + r.leadTimeMs, 0) /
            completedWithLead.length /
            1000
          ).toFixed(2)
        )
      : 0;

  res.json({
    total,
    stpCount,
    exceptionCount,
    autoRejectedCount,
    pendingCount,
    waitingHardCount,
    slaRemindedCount,
    approvedCount,
    rejectedCount,
    avgLeadTimeSec,
    slaConfig: camundaManager.getSlaConfig()
  });
});

// 7. API Lấy danh sách yêu cầu cấp giấy xác nhận
app.get('/api/requests', authMiddleware, (req, res) => {
  const all = camundaManager.getAllRequests();
  if (req.user.role === 'ADMIN') {
    return res.json({ requests: all, slaConfig: camundaManager.getSlaConfig() });
  }
  const myRequests = all.filter(
    (r) =>
      r.studentUsername === req.user.username ||
      r.studentEmail === req.user.defaultEmail ||
      (req.user.studentCode && r.studentCode === req.user.studentCode)
  );
  return res.json({ requests: myRequests, slaConfig: camundaManager.getSlaConfig() });
});

// 8. API Sinh viên gửi yêu cầu cấp giấy xác nhận (Tự động kích hoạt Tra cứu CSDL + STP / Ngoại lệ + SLA Timer)
app.post('/api/requests', authMiddleware, async (req, res) => {
  try {
    const { studentName, studentCode, studentEmail, faculty, purposeCategory, copyType, reason } = req.body;

    if (!studentName || !studentCode || !studentEmail || !reason) {
      return res.status(400).json({
        error: 'Vui lòng điền đầy đủ Họ tên, Mã sinh viên, Email nhận giấy và Mục đích xin xác nhận.'
      });
    }

    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const baseUrl = `${proto}://${host}`;

    const created = await camundaManager.createStudentRequest({
      studentUsername: req.user.username,
      studentName: studentName.trim(),
      studentCode: studentCode.trim(),
      studentEmail: studentEmail.trim(),
      faculty: (faculty || req.user.faculty || 'Khoa Công nghệ Thông tin - Trường ĐH Công nghệ').trim(),
      purposeCategory: purposeCategory || 'HOC_BONG',
      copyType: copyType === 'HARD' ? 'HARD' : 'SOFT',
      reason: reason.trim(),
      baseUrl
    });

    let message = 'Đã tiếp nhận yêu cầu cấp giấy xác nhận sinh viên.';
    if (created.processingMode === 'STP') {
      message =
        created.copyType === 'SOFT'
          ? `Xử lý thẳng (STP) thành công. Hệ thống đã đối chiếu CSDL, sinh PDF có mã QR và gửi tới ${created.studentEmail}.`
          : `Xử lý thẳng (STP) thành công. Đã gửi bản điện tử PDF qua email và xếp lịch nhận bản cứng vào ${created.appointmentDate}.`;
    } else if (created.processingMode === 'MANUAL_EXCEPTION') {
      message = `Hồ sơ thuộc diện ngoại lệ (${created.classificationReason}), đã chuyển chuyên viên CTSV thẩm định kèm hẹn giờ nhắc hạn SLA.`;
    } else if (created.processingMode === 'AUTO_REJECTED') {
      message = `Hồ sơ không đủ điều kiện cấp tự động: ${created.classificationReason}`;
    }

    res.status(201).json({
      message,
      request: created
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 9. API Chuyên viên CTSV duyệt hoặc từ chối hồ sơ ngoại lệ
app.post('/api/requests/:id/verify', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Bạn không có quyền thực hiện chức năng này.' });
    }

    const requestId = req.params.id;
    const { approved, appointmentDate, pickupLocation, adminNote } = req.body;

    const existing = camundaManager.getRequestById(requestId);
    if (!existing) {
      return res.status(404).json({ error: 'Không tìm thấy hồ sơ yêu cầu.' });
    }

    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.get('host');
    existing.baseUrl = `${proto}://${host}`;

    const updated = await camundaManager.verifyRequestByAdmin(requestId, {
      approved: Boolean(approved),
      appointmentDate,
      pickupLocation,
      adminNote,
      verifiedBy: req.user.fullName
    });

    let msg = `Đã từ chối hồ sơ ${updated.id} và gửi email thông báo lý do cho sinh viên.`;
    if (updated.approved) {
      msg =
        updated.copyType === 'SOFT'
          ? `Đã phê duyệt ngoại lệ và gửi bản điện tử PDF tới ${updated.studentEmail}.`
          : `Đã phê duyệt ngoại lệ, gửi PDF qua email và hẹn trả bản cứng vào ${updated.appointmentDate}.`;
    }

    res.json({
      message: msg,
      request: updated
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 10. API Xác nhận đã bàn giao bản cứng tại quầy CTSV
app.post('/api/requests/:id/issue-hard-copy', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Chỉ cán bộ CTSV mới thực hiện chức năng này.' });
    }
    const updated = await camundaManager.confirmHardCopyIssued(req.params.id, {
      issuedBy: req.user.fullName,
      note: req.body.note || 'Sinh viên đã xuất trình thẻ SV và ký sổ nhận giấy'
    });
    res.json({
      message: `Đã xác nhận bàn giao bản cứng cho sinh viên ${updated.studentName} (${updated.id}).`,
      request: updated
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 11. API Tải / Xem trực tiếp file PDF Giấy xác nhận sinh viên (Cũng là URL đích của mã QR)
app.get('/api/requests/:id/pdf', async (req, res) => {
  try {
    const reqItem = camundaManager.getRequestById(req.params.id);
    if (!reqItem) {
      return res.status(404).send('Không tìm thấy hồ sơ.');
    }
    if (!reqItem.approved) {
      return res.status(400).send('Hồ sơ chưa được phê duyệt hoặc đã bị từ chối.');
    }

    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.get('host');
    reqItem.baseUrl = `${proto}://${host}`;

    const pdfBuffer = await generateCertificatePDF(reqItem);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="GiayXacNhanSinhVien_${reqItem.studentCode}_${reqItem.id}.pdf"`
    );
    res.send(pdfBuffer);
  } catch (err) {
    res.status(500).send('Lỗi xuất văn bản PDF: ' + err.message);
  }
});

// 12. API Xem bản lưu Email đã gửi (cấp giấy / từ chối / nhắc hạn SLA) ngay trên trình duyệt
app.get('/api/requests/:id/email-preview', (req, res) => {
  const reqItem = camundaManager.getRequestById(req.params.id);
  if (!reqItem || !reqItem.emailResult || !reqItem.emailResult.htmlSnapshot) {
    return res.status(404).send('Chưa có bản ghi email cho hồ sơ này.');
  }
  const { to, subject, mode, messageId, htmlSnapshot } = reqItem.emailResult;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="vi"><head><meta charset="utf-8"/><title>${subject}</title>
<style>body{font-family:'Segoe UI',Arial,sans-serif;background:#f3f4f6;margin:0;padding:24px;}
.wrap{max-width:700px;margin:0 auto;background:#fff;border:1px solid #d1d5db;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06);}
.meta{background:#f9fafb;padding:16px 24px;border-bottom:1px solid #e5e7eb;font-size:14px;line-height:1.6;}
.badge{display:inline-block;background:#e0f2fe;color:#0369a1;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600;}
.content{padding:24px;}</style></head>
<body><div class="wrap">
  <div class="meta">
    <div><strong>Tiêu đề:</strong> ${subject}</div>
    <div><strong>Người nhận:</strong> ${to} &nbsp;|&nbsp; <span class="badge">${mode}</span></div>
    <div style="font-size:12px;color:#6b7280;">Message ID: ${messageId || 'N/A'}</div>
  </div>
  <div class="content">${htmlSnapshot}</div>
</div></body></html>`);
});

app.get('/api/requests/:id/sla-email-preview', (req, res) => {
  const reqItem = camundaManager.getRequestById(req.params.id);
  if (!reqItem || !reqItem.slaEmailResult || !reqItem.slaEmailResult.htmlSnapshot) {
    return res.status(404).send('Hồ sơ này chưa phát sinh email nhắc việc SLA.');
  }
  const { to, subject, mode, messageId, htmlSnapshot } = reqItem.slaEmailResult;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="vi"><head><meta charset="utf-8"/><title>${subject}</title>
<style>body{font-family:'Segoe UI',Arial,sans-serif;background:#f3f4f6;margin:0;padding:24px;}
.wrap{max-width:700px;margin:0 auto;background:#fff;border:1px solid #fcd34d;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06);}
.meta{background:#fffbeb;padding:16px 24px;border-bottom:1px solid #fde68a;font-size:14px;line-height:1.6;}
.badge{display:inline-block;background:#fef3c7;color:#92400e;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600;}
.content{padding:24px;}</style></head>
<body><div class="wrap">
  <div class="meta">
    <div><strong>Tiêu đề:</strong> ${subject}</div>
    <div><strong>Người nhận:</strong> ${to} &nbsp;|&nbsp; <span class="badge">Boundary Timer SLA (${mode})</span></div>
    <div style="font-size:12px;color:#6b7280;">Thời điểm nhắc: ${reqItem.slaRemindedAt} | Message ID: ${messageId || 'N/A'}</div>
  </div>
  <div class="content">${htmlSnapshot}</div>
</div></body></html>`);
});

if (require.main === module) {
  camundaManager.init().then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Cổng dịch vụ sinh viên UET (Camunda 8 To-Be) đang chạy tại: http://localhost:${PORT}`);
    });
  });
}

module.exports = { app, camundaManager };
