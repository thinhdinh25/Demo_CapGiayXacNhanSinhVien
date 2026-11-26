const fs = require('fs');
const path = require('path');

const STUDENTS_FILE = path.join(__dirname, '..', 'data', 'students.json');

// Danh mục mục đích thông thường được phép xử lý thẳng (STP - không cần cán bộ duyệt tay)
const STANDARD_PURPOSES = [
  {
    code: 'VAY_VON',
    label: 'Vay vốn ngân hàng chính sách xã hội',
    isStandard: true
  },
  {
    code: 'NGHIA_VU_QUAN_SU',
    label: 'Tạm hoãn nghĩa vụ quân sự tại địa phương',
    isStandard: true
  },
  {
    code: 'HOC_BONG',
    label: 'Bổ sung hồ sơ xin học bổng / thực tập doanh nghiệp',
    isStandard: true
  },
  {
    code: 'VE_UU_DAI',
    label: 'Làm vé tàu, vé xe buýt ưu đãi sinh viên',
    isStandard: true
  },
  {
    code: 'KHAC',
    label: 'Mục đích khác (Cần chuyên viên CTSV xem xét)',
    isStandard: false
  }
];

function loadStudents() {
  try {
    if (fs.existsSync(STUDENTS_FILE)) {
      return JSON.parse(fs.readFileSync(STUDENTS_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('[StudentDB] Lỗi đọc file students.json:', err.message);
  }
  return [];
}

function saveStudents(list) {
  try {
    if (!fs.existsSync(path.dirname(STUDENTS_FILE))) {
      fs.mkdirSync(path.dirname(STUDENTS_FILE), { recursive: true });
    }
    fs.writeFileSync(STUDENTS_FILE, JSON.stringify(list, null, 2), 'utf8');
  } catch (err) {
    console.error('[StudentDB] Lỗi lưu file students.json:', err.message);
  }
}

function getAllStudents() {
  return loadStudents();
}

function getStudentByCode(studentCode) {
  const code = String(studentCode || '').trim();
  return loadStudents().find((s) => s.studentCode === code) || null;
}

function upsertStudent(studentPayload) {
  const list = loadStudents();
  const code = String(studentPayload.studentCode || '').trim();
  if (!code) {
    throw new Error('Mã số sinh viên (MSSV) không được để trống.');
  }

  const statusMap = {
    ACTIVE: 'Đang học',
    ON_LEAVE: 'Đang bảo lưu',
    DROPPED: 'Đã thôi học',
    GRADUATED: 'Đã tốt nghiệp'
  };
  const academicStatus = statusMap[studentPayload.academicStatus] ? studentPayload.academicStatus : 'ACTIVE';
  const tuitionDebt = Boolean(studentPayload.tuitionDebt);
  const disciplinaryWarning = Boolean(studentPayload.disciplinaryWarning);

  let statusLabel = statusMap[academicStatus];
  if (academicStatus === 'ACTIVE' && tuitionDebt) {
    statusLabel = 'Đang học (Nợ học phí)';
  } else if (academicStatus === 'ACTIVE' && disciplinaryWarning) {
    statusLabel = 'Đang học (Cảnh báo học vụ)';
  }

  const normalized = {
    studentCode: code,
    fullName: String(studentPayload.fullName || '').trim(),
    dob: String(studentPayload.dob || '2005-01-01').trim(),
    email: String(studentPayload.email || `${code}@vnu.edu.vn`).trim().toLowerCase(),
    cohort: String(studentPayload.cohort || 'QH-2024-I/CQ').trim(),
    program: String(studentPayload.program || 'Công nghệ thông tin').trim(),
    faculty: String(studentPayload.faculty || 'Khoa Công nghệ Thông tin - Trường ĐH Công nghệ').trim(),
    academicStatus,
    academicStatusLabel: statusLabel,
    tuitionDebt,
    disciplinaryWarning,
    note: String(studentPayload.note || '').trim()
  };

  const idx = list.findIndex((s) => s.studentCode === code);
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...normalized };
  } else {
    list.push(normalized);
  }
  saveStudents(list);
  return normalized;
}

/**
 * Worker logic cho Task_TraCuu:
 * Tra cứu MSSV trong CSDL sinh viên và phân loại hồ sơ thành 3 luồng:
 * 1. isEligible = false: Không đủ điều kiện (MSSV không tồn tại, đã thôi học, bảo lưu...)
 * 2. isEligible = true, needManualReview = false: Đủ điều kiện xử lý thẳng (STP)
 * 3. isEligible = true, needManualReview = true: Cần chuyên viên CTSV duyệt tay (mục đích đặc biệt hoặc sinh viên nợ học phí/cảnh báo)
 */
function evaluateStudentAndPurpose({ studentCode, purposeCategory, reason }) {
  const student = getStudentByCode(studentCode);

  if (!student) {
    return {
      found: false,
      student: null,
      isEligible: false,
      needManualReview: false,
      classificationReason: `Không tìm thấy mã số sinh viên ${studentCode} trong cơ sở dữ liệu đào tạo.`
    };
  }

  if (student.academicStatus !== 'ACTIVE') {
    return {
      found: true,
      student,
      isEligible: false,
      needManualReview: false,
      classificationReason: `Sinh viên hiện ở trạng thái "${student.academicStatusLabel}" (${student.note || 'không thuộc diện đang theo học chính quy'}).`
    };
  }

  // Kiểm tra mục đích thông thường hay ngoại lệ
  const matchedCat = STANDARD_PURPOSES.find((p) => p.code === purposeCategory);
  const textLower = String(reason || '').toLowerCase();
  const isStandardByText =
    !purposeCategory &&
    ['vay vốn', 'quân sự', 'học bổng', 'thực tập', 'vé tàu', 'vé xe', 'ưu đãi'].some((kw) =>
      textLower.includes(kw)
    ) &&
    !textLower.includes('khác');

  const isStandardPurpose = matchedCat ? matchedCat.isStandard : isStandardByText;

  if (student.tuitionDebt || student.disciplinaryWarning) {
    const flagMsg = student.tuitionDebt
      ? 'Sinh viên đang có công nợ học phí cần kiểm tra'
      : 'Sinh viên đang trong diện cảnh báo học vụ';
    return {
      found: true,
      student,
      isEligible: true,
      needManualReview: true,
      classificationReason: `${flagMsg}${student.note ? ' (' + student.note + ')' : ''}.`
    };
  }

  if (!isStandardPurpose) {
    return {
      found: true,
      student,
      isEligible: true,
      needManualReview: true,
      classificationReason: `Mục đích xin xác nhận nằm ngoài danh mục tự duyệt ("${reason}").`
    };
  }

  return {
    found: true,
    student,
    isEligible: true,
    needManualReview: false,
    classificationReason: 'Sinh viên đang học hợp lệ, không nợ học phí và mục đích thuộc danh mục thông thường (Xử lý thẳng STP).'
  };
}

module.exports = {
  STANDARD_PURPOSES,
  getAllStudents,
  getStudentByCode,
  upsertStudent,
  evaluateStudentAndPurpose
};
