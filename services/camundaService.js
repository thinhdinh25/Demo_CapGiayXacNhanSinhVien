const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Camunda8 } = require('@camunda8/sdk');
const { evaluateStudentAndPurpose } = require('./studentDbService');
const { generateCertificatePDF } = require('./pdfService');
const {
  sendApprovedCertificateEmail,
  sendRejectionNoticeEmail,
  sendSlaOverdueReminderEmail
} = require('./emailService');

const DATA_FILE = path.join(__dirname, '..', 'data', 'requests.json');
const BPMN_FILE = path.join(__dirname, '..', 'bpmn', 'student-certificate.bpmn');

if (!fs.existsSync(path.dirname(DATA_FILE))) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
}

let requestsStore = [];
try {
  if (fs.existsSync(DATA_FILE)) {
    requestsStore = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  }
} catch (err) {
  requestsStore = [];
}

function saveStore() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(requestsStore, null, 2), 'utf8');
  } catch (err) {
    console.error('[Store] Lỗi lưu file requests.json:', err.message);
  }
}

function getNextWorkingDayMorningISO() {
  const d = new Date(Date.now() + 24 * 3600 * 1000);
  if (d.getDay() === 0) d.setDate(d.getDate() + 1);
  if (d.getDay() === 6) d.setDate(d.getDate() + 2);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}, 09:00`;
}

function msToIsoDuration(ms) {
  const sec = Math.max(5, Math.round(ms / 1000));
  if (sec % 3600 === 0) return `PT${sec / 3600}H`;
  if (sec % 60 === 0) return `PT${sec / 60}M`;
  return `PT${sec}S`;
}

function formatSlaLabel(ms) {
  const sec = Math.round(ms / 1000);
  if (sec >= 3600) return `${(sec / 3600).toFixed(sec % 3600 === 0 ? 0 : 1)} giờ`;
  if (sec >= 60) return `${Math.round(sec / 60)} phút (chế độ thử nghiệm; thiết kế 4 giờ)`;
  return `${sec} giây (chế độ thử nghiệm; thiết kế 4 giờ)`;
}

class CamundaEngineManager {
  constructor() {
    this.zeebe = null;
    this.isConnectedToRealZeebe = false;
    this.engineMode = 'INITIALIZING';
    this.pendingVerifyJobs = new Map();
    this.pendingHardCopyJobs = new Map();
    this.slaTimers = new Map(); // requestId -> NodeJS.Timeout
    this.lastDeployInfo = null;
    // Mặc định 60 giây (1 phút) khi chạy demo để dễ quan sát bộ hẹn giờ SLA; thiết kế chuẩn là 4 giờ (14400000 ms)
    this.slaTimeoutMs = Number(process.env.SLA_TIMEOUT_MS || 60000);
    // Cache PDF trong RAM cho phiên chạy
    this.pdfCache = new Map();
  }

  getSlaConfig() {
    return {
      slaTimeoutMs: this.slaTimeoutMs,
      slaIsoDuration: msToIsoDuration(this.slaTimeoutMs),
      slaLabel: formatSlaLabel(this.slaTimeoutMs),
      designSlaHours: 4,
      engineMode: this.engineMode,
      isConnectedToRealZeebe: this.isConnectedToRealZeebe
    };
  }

  setSlaTimeoutMs(ms) {
    const val = Number(ms);
    if (!Number.isFinite(val) || val < 3000) {
      throw new Error('Thời hạn SLA tối thiểu để thử nghiệm là 3000 ms (3 giây).');
    }
    this.slaTimeoutMs = Math.round(val);
    return this.getSlaConfig();
  }

  async init() {
    const hasZeebeConfig =
      Boolean(process.env.ZEEBE_ADDRESS) ||
      Boolean(process.env.CAMUNDA_CLUSTER_ID) ||
      process.env.USE_LOCAL_ZEEBE === 'true';

    if (hasZeebeConfig) {
      try {
        if (!process.env.ZEEBE_ADDRESS && process.env.USE_LOCAL_ZEEBE === 'true') {
          process.env.ZEEBE_ADDRESS = 'localhost:26500';
          process.env.CAMUNDA_SECURE_CONNECTION = 'false';
        }

        const c8 = new Camunda8();
        this.zeebe = c8.getZeebeGrpcApiClient();

        const deployRes = await this.zeebe.deployResource({
          processFilename: BPMN_FILE
        });

        this.isConnectedToRealZeebe = true;
        this.engineMode = 'CAMUNDA_8_ZEEBE_CLUSTER';
        this.lastDeployInfo = deployRes;
        console.log('[Camunda 8] Đã kết nối Zeebe Broker & Deploy BPMN To-Be thành công!');

        this.startZeebeWorkers();
      } catch (err) {
        console.warn(
          '[Camunda 8] Không kết nối được Zeebe Broker bên ngoài (' +
            err.message +
            '). Chuyển sang Camunda 8 Built-in BPMN Engine!'
        );
        this.isConnectedToRealZeebe = false;
        this.engineMode = 'CAMUNDA_8_BUILTIN_ENGINE';
      }
    } else {
      console.log(
        '[Camunda 8] Chạy chế độ Camunda 8 Built-in BPMN Engine (thực thi đầy đủ STP, Duyệt ngoại lệ & Boundary Timer SLA).'
      );
      this.isConnectedToRealZeebe = false;
      this.engineMode = 'CAMUNDA_8_BUILTIN_ENGINE';
    }

    // Khôi phục bộ hẹn giờ SLA cho các hồ sơ đang PENDING_VERIFY khi khởi động lại server
    for (const item of requestsStore) {
      if (item.status === 'PENDING_VERIFY' && !item.slaReminded) {
        const elapsed = Date.now() - new Date(item.createdAt).getTime();
        const remain = Math.max(1500, this.slaTimeoutMs - elapsed);
        this.scheduleLocalSlaTimer(item.id, remain);
      }
    }
  }

  recordElementInstance(reqItem, elementId, elementName, elementType, startedAtMs, completedAtMs, extra = {}) {
    if (!Array.isArray(reqItem.elementInstances)) {
      reqItem.elementInstances = [];
    }
    const durationMs = Math.max(1, completedAtMs - startedAtMs);
    reqItem.elementInstances.push({
      elementId,
      elementName,
      elementType,
      startedAt: new Date(startedAtMs).toISOString(),
      completedAt: new Date(completedAtMs).toISOString(),
      durationMs,
      ...extra
    });
  }

  startZeebeWorkers() {
    if (!this.zeebe) return;

    this.zeebe.createWorker({
      taskType: 'tra-cuu-mssv',
      taskHandler: async (job) => {
        const { requestId } = job.variables;
        const reqItem = this.getRequestById(requestId);
        if (!reqItem) {
          return job.complete({ isEligible: false, needManualReview: false });
        }
        return job.complete({
          isEligible: Boolean(reqItem.isEligible),
          needManualReview: Boolean(reqItem.needManualReview)
        });
      }
    });

    this.zeebe.createWorker({
      taskType: 'duyet-ngoai-le',
      timeout: 7200000,
      taskHandler: async (job) => {
        const { requestId } = job.variables;
        const reqItem = this.getRequestById(requestId);
        if (reqItem && reqItem.status !== 'PENDING_VERIFY') {
          return job.complete({ approved: Boolean(reqItem.approved) });
        }
        if (requestId) {
          this.pendingVerifyJobs.set(requestId, job);
        }
        return job.forward();
      }
    });

    this.zeebe.createWorker({
      taskType: 'nhac-viec-sla',
      taskHandler: async (job) => {
        const { requestId } = job.variables;
        if (requestId) {
          await this.triggerSlaReminder(requestId);
        }
        return job.complete({ reminded: true });
      }
    });

    this.zeebe.createWorker({
      taskType: 'sinh-giay-pdf',
      taskHandler: async (job) => {
        return job.complete({ pdfGenerated: true });
      }
    });

    this.zeebe.createWorker({
      taskType: 'gui-thong-bao-cap',
      taskHandler: async (job) => {
        return job.complete({ emailSent: true });
      }
    });

    this.zeebe.createWorker({
      taskType: 'gui-thong-bao-tu-choi',
      taskHandler: async (job) => {
        return job.complete({ rejectionSent: true });
      }
    });

    this.zeebe.createWorker({
      taskType: 'phat-ban-cung',
      timeout: 86400000,
      taskHandler: async (job) => {
        const { requestId } = job.variables;
        const reqItem = this.getRequestById(requestId);
        if (reqItem && reqItem.status === 'COMPLETED_HARD_ISSUED') {
          return job.complete({ hardCopyIssued: true });
        }
        if (requestId) {
          this.pendingHardCopyJobs.set(requestId, job);
        }
        return job.forward();
      }
    });
  }

  getAllRequests() {
    return [...requestsStore].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  getRequestById(id) {
    return requestsStore.find((r) => r.id === id);
  }

  clearAllRequests() {
    for (const timer of this.slaTimers.values()) {
      clearTimeout(timer);
    }
    this.slaTimers.clear();
    requestsStore = [];
    saveStore();
  }

  scheduleLocalSlaTimer(requestId, timeoutMs, options = {}) {
    if (this.slaTimers.has(requestId)) {
      clearTimeout(this.slaTimers.get(requestId));
    }
    const timer = setTimeout(async () => {
      this.slaTimers.delete(requestId);
      try {
        await this.triggerSlaReminder(requestId, options);
      } catch (err) {
        console.error('[SLA Timer] Lỗi kích hoạt nhắc việc:', err.message);
      }
    }, timeoutMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    this.slaTimers.set(requestId, timer);
  }

  clearLocalSlaTimer(requestId) {
    if (this.slaTimers.has(requestId)) {
      clearTimeout(this.slaTimers.get(requestId));
      this.slaTimers.delete(requestId);
    }
  }

  /**
   * Bộ hẹn giờ không ngắt (Non-interrupting Boundary Timer):
   * Gửi nhắc cán bộ & trưởng phòng nhưng KHÔNG hủy tác vụ PENDING_VERIFY
   */
  async triggerSlaReminder(requestId, options = {}) {
    const reqItem = this.getRequestById(requestId);
    if (!reqItem || reqItem.status !== 'PENDING_VERIFY') {
      return null;
    }
    if (reqItem.slaReminded && !options.forceRemind) {
      return reqItem;
    }

    const tStart = Date.now();
    const slaLabel = formatSlaLabel(reqItem.slaTimeoutMs || this.slaTimeoutMs);
    const emailRes = await sendSlaOverdueReminderEmail(reqItem, slaLabel, {
      simulateOnly: Boolean(options.simulateEmail || reqItem.simulateEmail)
    });
    const tEnd = Date.now();

    reqItem.slaReminded = true;
    reqItem.slaRemindedAt = new Date(tEnd).toISOString();
    reqItem.slaReminderCount = (reqItem.slaReminderCount || 0) + 1;
    reqItem.slaEmailResult = emailRes;

    reqItem.bpmnHistory.push({
      step: 'Timer_QuaHanSLA',
      name: `Bộ hẹn giờ không ngắt kích hoạt (vượt mốc ${slaLabel})`,
      timestamp: new Date(tStart).toISOString()
    });
    reqItem.bpmnHistory.push({
      step: 'Task_NhacViec',
      name: 'Service Task [nhac-viec-sla]: Đã gửi email nhắc cán bộ CTSV & báo trưởng phòng (tác vụ duyệt vẫn giữ nguyên)',
      timestamp: new Date(tEnd).toISOString()
    });
    reqItem.bpmnHistory.push({
      step: 'EndEvent_DaNhac',
      name: 'Hoàn tất nhánh nhắc việc SLA (Đã nhắc)',
      timestamp: new Date(tEnd).toISOString()
    });

    this.recordElementInstance(
      reqItem,
      'Task_NhacViec',
      'Nhắc cán bộ, báo trưởng phòng',
      'SERVICE_TASK',
      tStart,
      tEnd
    );

    saveStore();
    return reqItem;
  }

  /**
   * Bước 1: Sinh viên nộp yêu cầu -> Tự động chạy Task_TraCuu -> Phân luồng:
   *  - Không hợp lệ -> Gửi email từ chối tự động -> Kết thúc (EndEvent_KhongDuDieuKien)
   *  - Hợp lệ + STP (không cần duyệt tay) -> Tự động Sinh PDF + Gửi Email -> Đã cấp (hoặc Chờ phát bản cứng)
   *  - Hợp lệ + Ngoại lệ -> Chuyển vào Task_DuyetNgoaiLe + Bật Non-interrupting Timer SLA
   */
  async createStudentRequest(
    {
      studentUsername,
      studentName,
      studentCode,
      studentEmail,
      faculty,
      purposeCategory,
      copyType,
      reason,
      baseUrl,
      scenarioTag
    },
    options = {}
  ) {
    const tCreated = Date.now();
    const suffix = Math.floor(100000 + Math.random() * 900000);
    const id = 'REQ-' + String(tCreated).slice(-3) + String(suffix).slice(0, 3);
    const verifyCode = crypto.randomBytes(5).toString('hex').toUpperCase();
    const effectiveSlaMs = Number(options.slaTimeoutMs || this.slaTimeoutMs);

    const newReq = {
      id,
      certificateNo: `XN-${new Date().getFullYear()}-${id.replace('REQ-', '')}`,
      verificationCode: verifyCode,
      scenarioTag: scenarioTag || null,
      processDefinitionId: 'student_certificate_process',
      processInstanceKey: '22517998' + Math.floor(10000000 + Math.random() * 89999999),
      studentUsername,
      studentName,
      studentCode,
      studentEmail,
      studentDob: null,
      studentCohort: null,
      studentProgram: null,
      academicStatus: null,
      academicStatusLabel: null,
      faculty: faculty || 'Khoa Công nghệ Thông tin - Trường ĐH Công nghệ',
      purposeCategory: purposeCategory || 'HOC_BONG',
      copyType: copyType === 'HARD' ? 'HARD' : 'SOFT',
      reason,
      baseUrl: baseUrl || `http://localhost:${process.env.PORT || 3000}`,
      isEligible: null,
      needManualReview: null,
      processingMode: null, // STP | MANUAL_EXCEPTION | AUTO_REJECTED
      classificationReason: '',
      status: 'PROCESSING',
      approved: null,
      endEventId: null,
      currentBpmnActivity: 'Task_TraCuu (Đang tra cứu CSDL & phân loại)',
      slaTimeoutMs: effectiveSlaMs,
      slaDeadlineAt: null,
      slaReminded: false,
      slaRemindedAt: null,
      slaReminderCount: 0,
      slaEmailResult: null,
      appointmentDate: null,
      pickupLocation: null,
      hardCopyIssuedAt: null,
      adminNote: null,
      verifiedBy: null,
      verifiedAt: null,
      emailResult: null,
      simulateEmail: Boolean(options.simulateEmail),
      bpmnHistory: [
        {
          step: 'StartEvent_RequestSubmitted',
          name: 'Sinh viên gửi yêu cầu trên cổng dịch vụ',
          timestamp: new Date(tCreated).toISOString()
        }
      ],
      elementInstances: [],
      createdAt: new Date(tCreated).toISOString(),
      completedAt: null,
      leadTimeMs: null
    };

    requestsStore.push(newReq);

    // Thực thi Worker 1: Task_TraCuu (tra-cuu-mssv)
    const tLookupStart = Date.now();
    await new Promise((r) => setTimeout(r, 18)); // Mô phỏng truy vấn I/O CSDL thực tế
    const evalRes = evaluateStudentAndPurpose({
      studentCode: newReq.studentCode,
      purposeCategory: newReq.purposeCategory,
      reason: newReq.reason
    });
    const tLookupEnd = Date.now();

    if (evalRes.student) {
      newReq.studentName = evalRes.student.fullName || newReq.studentName;
      newReq.studentDob = evalRes.student.dob;
      newReq.studentCohort = evalRes.student.cohort;
      newReq.studentProgram = evalRes.student.program;
      newReq.faculty = evalRes.student.faculty || newReq.faculty;
      newReq.academicStatus = evalRes.student.academicStatus;
      newReq.academicStatusLabel = evalRes.student.academicStatusLabel;
    } else {
      newReq.academicStatus = 'NOT_FOUND';
      newReq.academicStatusLabel = 'Không tìm thấy trong CSDL';
    }

    newReq.isEligible = evalRes.isEligible;
    newReq.needManualReview = evalRes.needManualReview;
    newReq.classificationReason = evalRes.classificationReason;

    newReq.bpmnHistory.push({
      step: 'Task_TraCuu',
      name: `Service Task [tra-cuu-mssv]: ${evalRes.classificationReason}`,
      timestamp: new Date(tLookupEnd).toISOString()
    });
    this.recordElementInstance(
      newReq,
      'Task_TraCuu',
      'Tra cứu MSSV và phân loại',
      'SERVICE_TASK',
      tLookupStart,
      tLookupEnd
    );

    // Khởi tạo Process Instance trên Zeebe thật nếu đang kết nối
    if (this.isConnectedToRealZeebe && this.zeebe) {
      try {
        const zRes = await this.zeebe.createProcessInstance({
          bpmnProcessId: 'student_certificate_process',
          variables: {
            requestId: newReq.id,
            studentCode: newReq.studentCode,
            isEligible: newReq.isEligible,
            needManualReview: newReq.needManualReview,
            copyType: newReq.copyType,
            slaDuration: msToIsoDuration(effectiveSlaMs)
          }
        });
        newReq.processInstanceKey = String(zRes.processInstanceKey);
      } catch (err) {
        console.warn('[Camunda 8] Không tạo được instance trên Zeebe thật:', err.message);
      }
    }

    // Nhánh 1: MSSV không đủ điều kiện -> Tự động gửi thông báo từ chối
    if (!newReq.isEligible) {
      newReq.processingMode = 'AUTO_REJECTED';
      newReq.approved = false;
      newReq.verifiedBy = 'Hệ thống tự động (Tra cứu CSDL)';
      newReq.verifiedAt = new Date().toISOString();
      newReq.adminNote = evalRes.classificationReason;

      newReq.bpmnHistory.push({
        step: 'Gateway_MssvHopLe',
        name: 'Cổng [MSSV hợp lệ?]: Không đủ điều kiện',
        timestamp: new Date().toISOString()
      });

      await this.executeSendRejectionWorker(
        newReq,
        'Task_ThongBaoKhongDuDieuKien',
        'EndEvent_KhongDuDieuKien',
        evalRes.classificationReason,
        options
      );
      saveStore();
      return newReq;
    }

    newReq.bpmnHistory.push({
      step: 'Gateway_MssvHopLe',
      name: 'Cổng [MSSV hợp lệ?]: Hợp lệ (Đang theo học)',
      timestamp: new Date().toISOString()
    });

    // Nhánh 2: Đủ điều kiện & Xử lý thẳng (STP - không qua người duyệt!)
    if (!newReq.needManualReview) {
      newReq.processingMode = 'STP';
      newReq.approved = true;
      newReq.verifiedBy = 'Hệ thống tự động (STP)';
      newReq.verifiedAt = new Date().toISOString();
      newReq.adminNote = 'Hồ sơ hợp lệ, phê duyệt tự động theo luồng xử lý thẳng (STP)';

      newReq.bpmnHistory.push({
        step: 'Gateway_CanDuyetTay',
        name: 'Cổng [Cần duyệt tay?]: Không -> Đi thẳng luồng tự động (STP)',
        timestamp: new Date().toISOString()
      });

      await this.executeIssueCertificateFlow(newReq, options);
      saveStore();
      return newReq;
    }

    // Nhánh 3: Hồ sơ ngoại lệ -> Chờ chuyên viên CTSV duyệt + Bật bộ hẹn giờ SLA không ngắt
    newReq.processingMode = 'MANUAL_EXCEPTION';
    newReq.status = 'PENDING_VERIFY';
    newReq.duyetEnteredAtMs = Date.now();
    newReq.slaDeadlineAt = new Date(newReq.duyetEnteredAtMs + effectiveSlaMs).toISOString();
    newReq.currentBpmnActivity = 'Task_DuyetNgoaiLe (Chờ chuyên viên CTSV duyệt ngoại lệ)';

    newReq.bpmnHistory.push({
      step: 'Gateway_CanDuyetTay',
      name: 'Cổng [Cần duyệt tay?]: Có (Hồ sơ ngoại lệ)',
      timestamp: new Date().toISOString()
    });
    newReq.bpmnHistory.push({
      step: 'Task_DuyetNgoaiLe',
      name: `Đang chờ chuyên viên CTSV thẩm định (Hẹn giờ nhắc việc SLA: ${formatSlaLabel(effectiveSlaMs)})`,
      timestamp: new Date().toISOString()
    });

    this.scheduleLocalSlaTimer(newReq.id, effectiveSlaMs, options);
    saveStore();
    return newReq;
  }

  /**
   * Thực thi cặp tác vụ tự động: Task_SinhPDF -> Task_GuiEmail -> Rẽ nhánh Bản mềm / Bản cứng
   */
  async executeIssueCertificateFlow(reqItem, options = {}) {
    // 1. Task_SinhPDF
    const tPdfStart = Date.now();
    const pdfBuffer = await generateCertificatePDF(reqItem);
    this.pdfCache.set(reqItem.id, pdfBuffer);
    const tPdfEnd = Date.now();

    reqItem.bpmnHistory.push({
      step: 'Task_SinhPDF',
      name: `Service Task [sinh-giay-pdf]: Đã sinh PDF (${reqItem.certificateNo}) kèm mã QR xác thực`,
      timestamp: new Date(tPdfEnd).toISOString()
    });
    this.recordElementInstance(
      reqItem,
      'Task_SinhPDF',
      'Sinh PDF có QR xác thực',
      'SERVICE_TASK',
      tPdfStart,
      tPdfEnd
    );

    // Nếu sinh viên chọn kèm bản cứng mà chưa có lịch hẹn thì tự động gán lịch hẹn buổi làm việc kế tiếp
    if (reqItem.copyType === 'HARD' && !reqItem.appointmentDate) {
      reqItem.appointmentDate = getNextWorkingDayMorningISO();
      reqItem.pickupLocation = 'Phòng Công tác Sinh viên - P.104 Nhà E3, 144 Xuân Thủy';
    }

    // 2. Task_GuiEmail
    const tMailStart = Date.now();
    const emailRes = await sendApprovedCertificateEmail(reqItem, pdfBuffer, {
      simulateOnly: Boolean(options.simulateEmail || reqItem.simulateEmail)
    });
    const tMailEnd = Date.now();
    reqItem.emailResult = emailRes;

    reqItem.bpmnHistory.push({
      step: 'Task_GuiEmail',
      name: `Service Task [gui-thong-bao-cap]: Đã gửi email kèm bản điện tử PDF tới ${reqItem.studentEmail}`,
      timestamp: new Date(tMailEnd).toISOString()
    });
    this.recordElementInstance(
      reqItem,
      'Task_GuiEmail',
      'Gửi bản điện tử qua email',
      'SERVICE_TASK',
      tMailStart,
      tMailEnd
    );

    // 3. Gateway_CanBanCung
    if (reqItem.copyType === 'SOFT') {
      const tDone = Date.now();
      reqItem.status = 'COMPLETED_SOFT_SENT';
      reqItem.endEventId = 'EndEvent_DaCapDienTu';
      reqItem.currentBpmnActivity = 'EndEvent_DaCapDienTu (Đã cấp bản điện tử)';
      reqItem.completedAt = new Date(tDone).toISOString();
      reqItem.leadTimeMs = Math.max(1, tDone - new Date(reqItem.createdAt).getTime());

      reqItem.bpmnHistory.push({
        step: 'Gateway_CanBanCung',
        name: 'Cổng [Cần bản cứng?]: Không (Chỉ nhận bản điện tử)',
        timestamp: new Date(tDone).toISOString()
      });
      reqItem.bpmnHistory.push({
        step: 'EndEvent_DaCapDienTu',
        name: 'Kết thúc: Đã cấp (bản điện tử)',
        timestamp: new Date(tDone).toISOString()
      });
    } else {
      const tWaitHard = Date.now();
      reqItem.status = 'WAITING_HARD_PICKUP';
      reqItem.hardCopyEnteredAtMs = tWaitHard;
      reqItem.currentBpmnActivity = 'Task_PhatBanCung (Đã gửi PDF - Chờ phát bản cứng tại phòng CTSV)';

      reqItem.bpmnHistory.push({
        step: 'Gateway_CanBanCung',
        name: 'Cổng [Cần bản cứng?]: Có -> Chuyển tới quầy phát bản cứng',
        timestamp: new Date(tWaitHard).toISOString()
      });
      reqItem.bpmnHistory.push({
        step: 'Task_PhatBanCung',
        name: `Chờ sinh viên đến nhận bản giấy có dấu (Hẹn: ${reqItem.appointmentDate})`,
        timestamp: new Date(tWaitHard).toISOString()
      });
    }
  }

  async executeSendRejectionWorker(reqItem, taskStepId, endEventId, reasonText, options = {}) {
    const tStart = Date.now();
    const emailRes = await sendRejectionNoticeEmail(reqItem, reasonText, {
      simulateOnly: Boolean(options.simulateEmail || reqItem.simulateEmail)
    });
    const tEnd = Date.now();

    reqItem.emailResult = emailRes;
    reqItem.status = endEventId === 'EndEvent_KhongDuDieuKien' ? 'REJECTED_INELIGIBLE' : 'REJECTED';
    reqItem.endEventId = endEventId;
    reqItem.currentBpmnActivity = `${endEventId} (${
      endEventId === 'EndEvent_KhongDuDieuKien' ? 'Không đủ điều kiện' : 'Bị từ chối'
    })`;
    reqItem.completedAt = new Date(tEnd).toISOString();
    reqItem.leadTimeMs = Math.max(1, tEnd - new Date(reqItem.createdAt).getTime());

    const taskLabel =
      taskStepId === 'Task_ThongBaoKhongDuDieuKien'
        ? 'Thông báo không đủ điều kiện'
        : 'Thông báo từ chối kèm lý do';

    reqItem.bpmnHistory.push({
      step: taskStepId,
      name: `Service Task [gui-thong-bao-tu-choi]: Đã gửi email thông báo từ chối tới ${reqItem.studentEmail}`,
      timestamp: new Date(tEnd).toISOString()
    });
    reqItem.bpmnHistory.push({
      step: endEventId,
      name: `Kết thúc: ${endEventId === 'EndEvent_KhongDuDieuKien' ? 'Không đủ điều kiện' : 'Bị từ chối'}`,
      timestamp: new Date(tEnd).toISOString()
    });

    this.recordElementInstance(reqItem, taskStepId, taskLabel, 'SERVICE_TASK', tStart, tEnd);
  }

  /**
   * Bước 2 (Chuyên viên CTSV duyệt hoặc từ chối hồ sơ ngoại lệ trên giao diện Web)
   */
  async verifyRequestByAdmin(
    requestId,
    { approved, appointmentDate, pickupLocation, adminNote, verifiedBy },
    options = {}
  ) {
    const reqItem = this.getRequestById(requestId);
    if (!reqItem) {
      throw new Error('Không tìm thấy yêu cầu cấp giấy xác nhận!');
    }
    if (reqItem.status !== 'PENDING_VERIFY') {
      throw new Error('Hồ sơ này không ở trạng thái chờ duyệt ngoại lệ!');
    }

    this.clearLocalSlaTimer(requestId);

    const tDecision = Date.now();
    const enteredMs = reqItem.duyetEnteredAtMs || new Date(reqItem.createdAt).getTime();
    this.recordElementInstance(
      reqItem,
      'Task_DuyetNgoaiLe',
      'Duyệt ngoại lệ',
      'USER_TASK',
      enteredMs,
      tDecision
    );

    reqItem.approved = Boolean(approved);
    reqItem.adminNote =
      adminNote ||
      (reqItem.approved ? 'Đã thẩm định hồ sơ ngoại lệ hợp lệ' : 'Chưa đủ minh chứng cho mục đích ngoại lệ');
    reqItem.verifiedBy = verifiedBy || 'Chuyên viên CTSV';
    reqItem.verifiedAt = new Date(tDecision).toISOString();

    if (reqItem.copyType === 'HARD' && reqItem.approved) {
      reqItem.appointmentDate = appointmentDate || getNextWorkingDayMorningISO();
      reqItem.pickupLocation = pickupLocation || 'Phòng Công tác Sinh viên - P.104 Nhà E3, 144 Xuân Thủy';
    }

    await this.completeZeebeVerifyJobIfPresent(requestId, reqItem);

    reqItem.bpmnHistory.push({
      step: 'Gateway_DongY',
      name: reqItem.approved
        ? `Cổng [Đồng ý?]: Chuyên viên ĐỒNG Ý cấp (${reqItem.verifiedBy})`
        : `Cổng [Đồng ý?]: Chuyên viên TỪ CHỐI (${reqItem.adminNote})`,
      timestamp: new Date(tDecision).toISOString()
    });

    if (!reqItem.approved) {
      await this.executeSendRejectionWorker(
        reqItem,
        'Task_ThongBaoTuChoi',
        'EndEvent_BiTuChoi',
        reqItem.adminNote,
        options
      );
      saveStore();
      return reqItem;
    }

    await this.executeIssueCertificateFlow(reqItem, options);
    saveStore();
    return reqItem;
  }

  /**
   * Bước 3 (Tác vụ Phát bản cứng tại phòng CTSV cho sinh viên đăng ký nhận bản giấy)
   */
  async confirmHardCopyIssued(requestId, { issuedBy, note } = {}) {
    const reqItem = this.getRequestById(requestId);
    if (!reqItem) {
      throw new Error('Không tìm thấy hồ sơ.');
    }
    if (reqItem.status !== 'WAITING_HARD_PICKUP') {
      throw new Error('Hồ sơ này không ở trạng thái chờ phát bản cứng.');
    }

    const tDone = Date.now();
    const enteredHardMs = reqItem.hardCopyEnteredAtMs || tDone - 1000;
    this.recordElementInstance(
      reqItem,
      'Task_PhatBanCung',
      'Phát bản cứng tại phòng CTSV',
      'USER_TASK',
      enteredHardMs,
      tDone
    );

    const pendingHardJob = this.pendingHardCopyJobs.get(requestId);
    if (pendingHardJob) {
      this.pendingHardCopyJobs.delete(requestId);
      try {
        await pendingHardJob.complete({ hardCopyIssued: true });
      } catch (e) {}
    }

    reqItem.status = 'COMPLETED_HARD_ISSUED';
    reqItem.endEventId = 'EndEvent_DaCapBanCung';
    reqItem.hardCopyIssuedAt = new Date(tDone).toISOString();
    reqItem.currentBpmnActivity = 'EndEvent_DaCapBanCung (Đã cấp kèm bản cứng)';
    reqItem.completedAt = new Date(tDone).toISOString();
    reqItem.leadTimeMs = Math.max(1, tDone - new Date(reqItem.createdAt).getTime());

    reqItem.bpmnHistory.push({
      step: 'EndEvent_DaCapBanCung',
      name: `Đã đối soát thẻ sinh viên và bàn giao bản cứng (${issuedBy || 'Chuyên viên CTSV'}${note ? ' - ' + note : ''})`,
      timestamp: new Date(tDone).toISOString()
    });

    saveStore();
    return reqItem;
  }

  async completeZeebeVerifyJobIfPresent(requestId, reqItem) {
    const pendingJob = this.pendingVerifyJobs.get(requestId);
    if (pendingJob) {
      this.pendingVerifyJobs.delete(requestId);
      try {
        await pendingJob.complete({
          approved: Boolean(reqItem.approved),
          copyType: reqItem.copyType,
          appointmentDate: reqItem.appointmentDate || '',
          adminNote: reqItem.adminNote || ''
        });
        return true;
      } catch (err) {
        console.warn('[Camunda 8] Complete job qua Zeebe lỗi:', err.message);
      }
    }
    return false;
  }
}

const camundaManager = new CamundaEngineManager();
module.exports = { camundaManager };
