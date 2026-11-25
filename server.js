require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const { OAuth2Client } = require('google-auth-library');
const { camundaManager } = require('./services/camundaService');
const { generateCertificatePDF } = require('./services/pdfService');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let runtimeGoogleClientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
let restrictVnuDomainOnly = process.env.GOOGLE_RESTRICT_VNU_DOMAIN === 'true';

// Duy nhất 1 tài khoản đăng nhập qua form: Admin (ctsv@vnu.edu.vn / 123)
const ADMIN_ACCOUNT = {
  username: 'ctsv@vnu.edu.vn',
  password: '123',
  role: 'ADMIN',
  fullName: 'Phòng Chính trị và Công tác Học sinh Sinh viên',
  defaultEmail: 'ctsv@vnu.edu.vn'
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

// 1. API Đăng nhập bằng tài khoản/mật khẩu: CHỈ cho phép duy nhất ctsv@vnu.edu.vn / 123
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const rawInput = String(username || '').trim().toLowerCase();
  const rawPass = String(password || '').trim();

  if (!rawInput || !rawPass) {
    return res.status(400).json({ error: 'Vui lòng nhập tài khoản và mật khẩu.' });
  }

  if (rawInput !== ADMIN_ACCOUNT.username || rawPass !== ADMIN_ACCOUNT.password) {
    return res.status(401).json({
      error: 'Sai tài khoản hoặc mật khẩu. Sinh viên vui lòng đăng nhập bằng tài khoản Google bên dưới.'
    });
  }

  const token = 'adm_' + Date.now();
  const safeUser = {
    username: ADMIN_ACCOUNT.username,
    role: 'ADMIN',
    fullName: ADMIN_ACCOUNT.fullName,
    studentCode: null,
    faculty: 'ĐHQGHN',
    defaultEmail: ADMIN_ACCOUNT.defaultEmail
  };
  sessions.set(token, safeUser);

  res.json({
    token,
    user: safeUser
  });
});

// 2. API Lấy và Cập nhật cấu hình Google OAuth 2.0 Client ID
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

// 3. API Xác thực Google OAuth 2.0 thật: Mặc định đăng nhập với vai trò SINH VIÊN (STUDENT)
app.post('/api/auth/google', async (req, res) => {
  try {
    const { credential, accessToken, clientId } = req.body;
    const activeClientId = (clientId || runtimeGoogleClientId || '').trim();

    if (!activeClientId) {
      return res.status(400).json({
        error: 'Chưa cấu hình GOOGLE_CLIENT_ID. Vui lòng nhập Google OAuth Client ID.'
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
    const fullName = googlePayload.name || email.split('@')[0];
    const localPart = email.split('@')[0];

    if (restrictVnuDomainOnly && !email.endsWith('@vnu.edu.vn')) {
      return res.status(403).json({
        error: `Tài khoản Google (${email}) không thuộc tên miền @vnu.edu.vn.`
      });
    }

    const studentCodeMatch = localPart.match(/\d{8}/);
    const studentCode = studentCodeMatch ? studentCodeMatch[0] : '22028115';

    const safeUser = {
      username: email,
      role: 'STUDENT',
      fullName: fullName,
      studentCode: studentCode,
      faculty: 'Khoa Công nghệ Thông tin - Trường ĐH Công nghệ, ĐHQGHN',
      defaultEmail: email,
      authProvider: 'GOOGLE_OAUTH_2.0',
      picture: googlePayload.picture || null
    };

    const token = 'goog_' + Buffer.from(email).toString('hex').slice(0, 12) + '_' + Date.now();
    sessions.set(token, safeUser);

    res.json({
      token,
      user: safeUser
    });
  } catch (err) {
    res.status(401).json({
      error: 'Xác thực Google OAuth thất bại: ' + err.message
    });
  }
});

// 4. API Lấy danh sách yêu cầu cấp giấy xác nhận
app.get('/api/requests', authMiddleware, (req, res) => {
  const all = camundaManager.getAllRequests();
  if (req.user.role === 'ADMIN') {
    return res.json({ requests: all });
  }
  const myRequests = all.filter(
    (r) =>
      r.studentUsername === req.user.username ||
      r.studentEmail === req.user.defaultEmail ||
      (req.user.studentCode && r.studentCode === req.user.studentCode)
  );
  return res.json({ requests: myRequests });
});

// 5. API Sinh viên gửi yêu cầu cấp giấy xác nhận
app.post('/api/requests', authMiddleware, async (req, res) => {
  try {
    const { studentName, studentCode, studentEmail, faculty, copyType, reason } = req.body;

    if (!studentName || !studentCode || !studentEmail || !reason) {
      return res.status(400).json({
        error: 'Vui lòng điền đầy đủ Họ tên, Mã sinh viên, Email nhận giấy và Mục đích xin xác nhận.'
      });
    }

    const created = await camundaManager.createStudentRequest({
      studentUsername: req.user.username,
      studentName: studentName.trim(),
      studentCode: studentCode.trim(),
      studentEmail: studentEmail.trim(),
      faculty: (faculty || req.user.faculty || 'Trường Đại học Công nghệ - ĐHQGHN').trim(),
      copyType: copyType === 'HARD' ? 'HARD' : 'SOFT',
      reason: reason.trim()
    });

    res.status(201).json({
      message: 'Đã tiếp nhận yêu cầu cấp giấy xác nhận sinh viên.',
      request: created
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. API Cán bộ Admin xác nhận (Verify) & Hẹn lịch / Gửi bản mềm
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

    if (Boolean(approved) && existing.copyType === 'HARD' && !appointmentDate) {
      return res.status(400).json({
        error: 'Vui lòng chọn thời gian hẹn trả bản cứng cho sinh viên.'
      });
    }

    const updated = await camundaManager.verifyRequestByAdmin(requestId, {
      approved: Boolean(approved),
      appointmentDate,
      pickupLocation,
      adminNote,
      verifiedBy: req.user.fullName
    });

    let msg = 'Đã từ chối hồ sơ yêu cầu.';
    if (updated.approved) {
      msg =
        updated.copyType === 'SOFT'
          ? `Đã xác nhận hồ sơ và gửi bản mềm PDF tới địa chỉ ${updated.studentEmail}.`
          : `Đã xác nhận hồ sơ và lưu lịch hẹn nhận bản cứng vào ${updated.appointmentDate}.`;
    }

    res.json({
      message: msg,
      request: updated
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 7. API Tải file PDF Giấy xác nhận sinh viên
app.get('/api/requests/:id/pdf', async (req, res) => {
  try {
    const reqItem = camundaManager.getRequestById(req.params.id);
    if (!reqItem) {
      return res.status(404).send('Không tìm thấy hồ sơ.');
    }
    if (!reqItem.approved) {
      return res.status(400).send('Hồ sơ chưa được phê duyệt.');
    }

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

camundaManager.init().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Cổng dịch vụ sinh viên VNU đang chạy tại: http://localhost:${PORT}`);
  });
});
