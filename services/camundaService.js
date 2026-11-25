const path = require('path');
const fs = require('fs');
const { Camunda8 } = require('@camunda8/sdk');
const {
  sendSoftCopyCertificateEmail,
  sendHardCopyAppointmentEmail
} = require('./emailService');

const DATA_FILE = path.join(__dirname, '..', 'data', 'requests.json');
const BPMN_FILE = path.join(__dirname, '..', 'bpmn', 'student-certificate.bpmn');

// Đảm bảo thư mục data tồn tại
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

class CamundaEngineManager {
  constructor() {
    this.zeebe = null;
    this.isConnectedToRealZeebe = false;
    this.engineMode = 'INITIALIZING';
    this.pendingVerifyJobs = new Map(); // requestId -> Zeebe job对象 (nếu đang giữ job)
    this.lastDeployInfo = null;
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

        // Thử deploy BPMN lên Zeebe Broker thật
        const deployRes = await this.zeebe.deployResource({
          processFilename: BPMN_FILE
        });

        this.isConnectedToRealZeebe = true;
        this.engineMode = 'CAMUNDA_8_ZEEBE_CLUSTER';
        this.lastDeployInfo = deployRes;
        console.log('[Camunda 8] Đã kết nối Zeebe Broker & Deploy BPMN thành công!');

        this.startZeebeWorkers();
        return;
      } catch (err) {
        console.warn(
          '[Camunda 8] Không kết nối được Zeebe Broker bên ngoài (' +
            err.message +
            '). Tự động chuyển sang Camunda 8 Built-in BPMN Simulator để web vẫn chạy mượt mà!'
        );
      }
    } else {
      console.log(
        '[Camunda 8] Chưa cấu hình ZEEBE_ADDRESS trong .env -> Chạy chế độ Camunda 8 Built-in BPMN Engine (mô phỏng đầy đủ các node trong student-certificate.bpmn).'
      );
    }

    this.isConnectedToRealZeebe = false;
    this.engineMode = 'CAMUNDA_8_BUILTIN_ENGINE';
  }

  /**
   * Đăng ký các Zeebe Job Workers thật tương ứng với 3 Service Task trong BPMN:
   * 1. admin-verify-certificate
   * 2. send-soft-copy-email
   * 3. schedule-hard-copy
   */
  startZeebeWorkers() {
    if (!this.zeebe) return;

    // Worker 1: Giữ job chờ Admin bấm Verify trên giao diện Web
    this.zeebe.createWorker({
      taskType: 'admin-verify-certificate',
      timeout: 3600000, // Giữ job tối đa 1 tiếng chờ Admin duyệt
      taskHandler: async (job) => {
        const { requestId } = job.variables;
        if (requestId) {
          this.pendingVerifyJobs.set(requestId, job);
          const reqItem = this.getRequestById(requestId);
          if (reqItem) {
            reqItem.currentBpmnActivity = 'Task_AdminVerify (Admin xác minh & duyệt yêu cầu)';
            reqItem.zeebeJobKey = String(job.key);
            saveStore();
          }
          // Nếu Admin đã duyệt trước khi worker poll tới
          if (reqItem && reqItem.status !== 'PENDING_VERIFY') {
            this.pendingVerifyJobs.delete(requestId);
            return job.complete({
              approved: reqItem.approved,
              copyType: reqItem.copyType,
              appointmentDate: reqItem.appointmentDate || '',
              adminNote: reqItem.adminNote || ''
            });
          }
        }
        // Không complete ngay mà giữ trong pendingVerifyJobs cho đến khi Admin bấm nút Duyệt/Từ chối trên web
        return job.forward();
      }
    });

    // Worker 2: Tự động tạo PDF & gửi Email khi là Bản mềm (SOFT)
    this.zeebe.createWorker({
      taskType: 'send-soft-copy-email',
      taskHandler: async (job) => {
        const { requestId } = job.variables;
        const reqItem = this.getRequestById(requestId);
        if (reqItem) {
          await this.executeSendSoftCopyWorker(reqItem);
        }
        return job.complete({
          emailSent: true,
          completedAt: new Date().toISOString()
        });
      }
    });

    // Worker 3: Xử lý lịch hẹn lấy Bản cứng (HARD)
    this.zeebe.createWorker({
      taskType: 'schedule-hard-copy',
      taskHandler: async (job) => {
        const { requestId } = job.variables;
        const reqItem = this.getRequestById(requestId);
        if (reqItem) {
          await this.executeScheduleHardCopyWorker(reqItem);
        }
        return job.complete({
          scheduled: true,
          completedAt: new Date().toISOString()
        });
      }
    });
  }

  getAllRequests() {
    return [...requestsStore].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  getRequestById(id) {
    return requestsStore.find((r) => r.id === id);
  }

  /**
   * Bước 1 (Start Event): Sinh viên gửi yêu cầu cấp giấy xác nhận
   */
  async createStudentRequest({
    studentUsername,
    studentName,
    studentCode,
    studentEmail,
    faculty,
    copyType,
    reason
  }) {
    const id = 'REQ-' + Date.now().toString().slice(-6);
    const now = new Date().toISOString();

    const newReq = {
      id,
      processDefinitionId: 'student_certificate_process',
      processInstanceKey: '22517998' + Math.floor(100000 + Math.random() * 900000),
      studentUsername,
      studentName,
      studentCode,
      studentEmail,
      faculty: faculty || 'Công nghệ thông tin',
      copyType: copyType === 'HARD' ? 'HARD' : 'SOFT', // SOFT | HARD
      reason,
      status: 'PENDING_VERIFY', // PENDING_VERIFY | COMPLETED_SOFT_SENT | COMPLETED_HARD_SCHEDULED | REJECTED
      approved: null,
      currentBpmnActivity: 'Task_AdminVerify (Chờ Admin xác minh)',
      bpmnHistory: [
        {
          step: 'StartEvent_RequestSubmitted',
          name: 'Sinh viên gửi yêu cầu',
          timestamp: now
        },
        {
          step: 'Task_AdminVerify',
          name: 'Đang chờ Admin xác minh (Job: admin-verify-certificate)',
          timestamp: now
        }
      ],
      appointmentDate: null,
      pickupLocation: null,
      adminNote: null,
      verifiedBy: null,
      verifiedAt: null,
      emailResult: null,
      createdAt: now
    };

    // Nếu kết nối Zeebe Broker thật, tạo Process Instance trên Camunda 8
    if (this.isConnectedToRealZeebe && this.zeebe) {
      try {
        const result = await this.zeebe.createProcessInstance({
          bpmnProcessId: 'student_certificate_process',
          variables: {
            requestId: newReq.id,
            studentName: newReq.studentName,
            studentCode: newReq.studentCode,
            studentEmail: newReq.studentEmail,
            copyType: newReq.copyType,
            reason: newReq.reason
          }
        });
        newReq.processInstanceKey = String(result.processInstanceKey);
      } catch (err) {
        console.warn('[Camunda 8] Không tạo được instance trên Zeebe thật, dùng key mô phỏng:', err.message);
      }
    }

    requestsStore.push(newReq);
    saveStore();
    return newReq;
  }

  /**
   * Bước 2 (Service Task / User Action): Admin verify giấy xác nhận hoặc từ chối
   */
  async verifyRequestByAdmin(requestId, { approved, appointmentDate, pickupLocation, adminNote, verifiedBy }) {
    const reqItem = this.getRequestById(requestId);
    if (!reqItem) {
      throw new Error('Không tìm thấy yêu cầu cấp giấy xác nhận!');
    }
    if (reqItem.status !== 'PENDING_VERIFY') {
      throw new Error('Yêu cầu này đã được xử lý trước đó!');
    }

    const now = new Date().toISOString();
    reqItem.approved = Boolean(approved);
    reqItem.adminNote = adminNote || '';
    reqItem.verifiedBy = verifiedBy || 'admin';
    reqItem.verifiedAt = now;

    if (reqItem.copyType === 'HARD' && reqItem.approved) {
      reqItem.appointmentDate = appointmentDate;
      reqItem.pickupLocation = pickupLocation || 'Phòng Công tác Sinh viên - P.102 Nhà A1';
    }

    reqItem.bpmnHistory.push({
      step: 'Gateway_IsApproved',
      name: reqItem.approved ? 'Admin ĐÃ DUYỆT (approved = true)' : 'Admin TỪ CHỐI (approved = false)',
      timestamp: now
    });

    // Nếu từ chối -> đi tới EndEvent_Rejected
    if (!reqItem.approved) {
      reqItem.status = 'REJECTED';
      reqItem.currentBpmnActivity = 'EndEvent_Rejected (Đã từ chối)';
      reqItem.bpmnHistory.push({
        step: 'EndEvent_Rejected',
        name: 'Kết thúc quy trình (Từ chối cấp giấy)',
        timestamp: now
      });
      saveStore();
      await this.completeZeebeVerifyJobIfPresent(requestId, reqItem);
      return reqItem;
    }

    // Nếu được duyệt -> đi qua Gateway_CopyType
    reqItem.bpmnHistory.push({
      step: 'Gateway_CopyType',
      name: `Phân luồng loại bản cấp: ${reqItem.copyType === 'SOFT' ? 'Bản mềm (SOFT)' : 'Bản cứng (HARD)'}`,
      timestamp: now
    });

    // Nếu đang có Zeebe job chờ sẵn, complete job để Zeebe kích hoạt worker tiếp theo
    const completedViaZeebe = await this.completeZeebeVerifyJobIfPresent(requestId, reqItem);

    // Thực thi worker tương ứng (hoặc trực tiếp nếu chạy chế độ Built-in / job chưa poll kịp)
    if (!completedViaZeebe) {
      if (reqItem.copyType === 'SOFT') {
        await this.executeSendSoftCopyWorker(reqItem);
      } else {
        await this.executeScheduleHardCopyWorker(reqItem);
      }
    }

    saveStore();
    return reqItem;
  }

  async completeZeebeVerifyJobIfPresent(requestId, reqItem) {
    const pendingJob = this.pendingVerifyJobs.get(requestId);
    if (pendingJob) {
      this.pendingVerifyJobs.delete(requestId);
      try {
        await pendingJob.complete({
          approved: reqItem.approved,
          copyType: reqItem.copyType,
          appointmentDate: reqItem.appointmentDate || '',
          adminNote: reqItem.adminNote || ''
        });
        return true;
      } catch (err) {
        console.warn('[Camunda 8] Complete job qua Zeebe lỗi, chuyển sang xử lý trực tiếp:', err.message);
      }
    }
    return false;
  }

  /**
   * Worker thực thi node: Task_SendSoftCopyEmail (Tự động tạo PDF và gửi qua Email sinh viên)
   */
  async executeSendSoftCopyWorker(reqItem) {
    const now = new Date().toISOString();
    reqItem.currentBpmnActivity = 'Task_SendSoftCopyEmail (Đang gửi Email bản mềm)';
    reqItem.bpmnHistory.push({
      step: 'Task_SendSoftCopyEmail',
      name: 'Service Task [send-soft-copy-email]: Tạo PDF & Gửi email tự động cho sinh viên',
      timestamp: now
    });

    const emailRes = await sendSoftCopyCertificateEmail(reqItem);
    reqItem.emailResult = emailRes;
    reqItem.status = 'COMPLETED_SOFT_SENT';
    reqItem.currentBpmnActivity = 'EndEvent_Completed (Đã gửi bản mềm qua Email)';
    reqItem.bpmnHistory.push({
      step: 'EndEvent_Completed',
      name: `Hoàn tất cấp bản mềm - Đã gửi tới ${reqItem.studentEmail}`,
      timestamp: new Date().toISOString()
    });
    saveStore();
  }

  /**
   * Worker thực thi node: Task_ScheduleHardCopy (Hẹn lịch lấy bản cứng & thông báo cho sinh viên)
   */
  async executeScheduleHardCopyWorker(reqItem) {
    const now = new Date().toISOString();
    reqItem.currentBpmnActivity = 'Task_ScheduleHardCopy (Hẹn lịch lấy bản cứng)';
    reqItem.bpmnHistory.push({
      step: 'Task_ScheduleHardCopy',
      name: `Service Task [schedule-hard-copy]: Ghi nhận lịch hẹn lấy bản cứng (${reqItem.appointmentDate})`,
      timestamp: now
    });

    const emailRes = await sendHardCopyAppointmentEmail(reqItem);
    reqItem.emailResult = emailRes;
    reqItem.status = 'COMPLETED_HARD_SCHEDULED';
    reqItem.currentBpmnActivity = 'EndEvent_Completed (Đã hẹn lịch lấy bản cứng)';
    reqItem.bpmnHistory.push({
      step: 'EndEvent_Completed',
      name: `Hoàn tất hẹn lịch lấy bản cứng vào ${reqItem.appointmentDate}`,
      timestamp: new Date().toISOString()
    });
    saveStore();
  }
}

const camundaManager = new CamundaEngineManager();
module.exports = { camundaManager };
