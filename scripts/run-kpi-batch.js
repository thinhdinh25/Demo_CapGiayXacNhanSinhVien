require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { camundaManager } = require('../services/camundaService');
const { getStudentByCode } = require('../services/studentDbService');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SCENARIO_CSV = path.join(DATA_DIR, 'kpi_scenario_instances.csv');
const ELEMENT_CSV = path.join(DATA_DIR, 'kpi_element_instances.csv');
const SUMMARY_JSON = path.join(DATA_DIR, 'kpi_summary.json');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function csvEscape(val) {
  if (val === null || val === undefined) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function statsOf(nums) {
  if (!nums.length) return { count: 0, mean: 0, median: 0, min: 0, max: 0 };
  const sorted = [...nums].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return {
    count: sorted.length,
    mean: Number((sum / sorted.length).toFixed(2)),
    median: Number(median.toFixed(2)),
    min: Number(sorted[0].toFixed(2)),
    max: Number(sorted[sorted.length - 1].toFixed(2))
  };
}

async function runBatch() {
  console.log('======================================================================');
  console.log(' CHẠY THỰC NGHIỆM BATCH 40 HỒ SƠ CẤP GIẤY XÁC NHẬN SINH VIÊN (TO-BE)');
  console.log('======================================================================');

  await camundaManager.init();
  camundaManager.clearAllRequests();

  // Thiết lập SLA thử nghiệm ngắn (1500 ms) cho kịch bản quá hạn để quan sát bộ hẹn giờ tự động kích hoạt
  const NORMAL_SLA_MS = 60000;
  const OVERDUE_TEST_SLA_MS = 1500;

  const activeCodes = ['24020097', '24020313', '24020205', '22028115', '23020512'];
  const standardPurposes = [
    {
      code: 'HOC_BONG',
      reason: 'Xin cấp giấy xác nhận sinh viên để nộp hồ sơ xét học bổng khuyến khích học tập'
    },
    {
      code: 'VAY_VON',
      reason: 'Xác nhận sinh viên đang theo học để làm thủ tục vay vốn Ngân hàng Chính sách Xã hội'
    },
    {
      code: 'NGHIA_VU_QUAN_SU',
      reason: 'Bổ sung hồ sơ tạm hoãn nghĩa vụ quân sự năm 2026 tại địa phương'
    },
    {
      code: 'VE_UU_DAI',
      reason: 'Đăng ký mua vé tháng xe buýt và vé tàu ưu đãi dành cho sinh viên'
    }
  ];

  // 1. Kịch bản 1: stp (32 hồ sơ - 80% tổng số hồ sơ)
  //    23 bản điện tử (SOFT) + 9 bản cứng (HARD) để kiểm thử cả nhánh phát bản giấy
  console.log('\n[1/4] Đang chạy 32 hồ sơ kịch bản Xử lý thẳng (stp)...');
  for (let i = 0; i < 32; i++) {
    const code = activeCodes[i % activeCodes.length];
    const stu = getStudentByCode(code);
    const p = standardPurposes[i % standardPurposes.length];
    const copyType = i < 23 ? 'SOFT' : 'HARD';

    const req = await camundaManager.createStudentRequest(
      {
        studentUsername: code,
        studentName: stu.fullName,
        studentCode: code,
        studentEmail: stu.email,
        faculty: stu.faculty,
        purposeCategory: p.code,
        copyType,
        reason: p.reason,
        baseUrl: 'http://localhost:3000',
        scenarioTag: 'stp'
      },
      { simulateEmail: true, slaTimeoutMs: NORMAL_SLA_MS }
    );

    if (copyType === 'HARD' && req.status === 'WAITING_HARD_PICKUP') {
      await sleep(180 + (i % 4) * 35);
      await camundaManager.confirmHardCopyIssued(req.id, {
        issuedBy: 'Chuyên viên CTSV (Quầy P.104-E3)',
        note: 'Đã đối chiếu thẻ sinh viên và giao bản giấy có dấu đỏ'
      });
    }
  }

  // 2. Kịch bản 2: duyet_ngoai_le (3 hồ sơ ngoại lệ hợp lệ - chuyên viên duyệt trong hạn SLA)
  console.log('[2/4] Đang chạy 3 hồ sơ kịch bản Duyệt ngoại lệ trong hạn (duyet_ngoai_le)...');
  const exceptionApproveCases = [
    {
      code: '24020313',
      purposeCategory: 'KHAC',
      copyType: 'SOFT',
      reason: 'Xin giấy xác nhận song ngữ để nộp hồ sơ thực tập kỹ sư phần mềm tại doanh nghiệp đối tác',
      adminNote: 'Đã kiểm tra thư mời thực tập, đồng ý cấp bản điện tử'
    },
    {
      code: '23021108',
      purposeCategory: 'VAY_VON',
      copyType: 'HARD',
      reason: 'Xin xác nhận vay vốn tín dụng sinh viên (đã nộp bổ sung biên lai gia hạn học phí)',
      adminNote: 'Đã đối soát biên lai gia hạn học phí hợp lệ với Phòng Kế hoạch - Tài chính'
    },
    {
      code: '24020097',
      purposeCategory: 'KHAC',
      copyType: 'SOFT',
      reason: 'Xin xác nhận sinh viên tham gia chương trình trao đổi học thuật ngắn hạn tại Nhật Bản',
      adminNote: 'Hồ sơ trao đổi hợp lệ theo danh sách đề cử của Khoa CNTT'
    }
  ];

  for (let i = 0; i < exceptionApproveCases.length; i++) {
    const c = exceptionApproveCases[i];
    const stu = getStudentByCode(c.code);
    const req = await camundaManager.createStudentRequest(
      {
        studentUsername: c.code,
        studentName: stu.fullName,
        studentCode: c.code,
        studentEmail: stu.email,
        faculty: stu.faculty,
        purposeCategory: c.purposeCategory,
        copyType: c.copyType,
        reason: c.reason,
        baseUrl: 'http://localhost:3000',
        scenarioTag: 'duyet_ngoai_le'
      },
      { simulateEmail: true, slaTimeoutMs: NORMAL_SLA_MS }
    );

    await sleep(650 + i * 140);
    await camundaManager.verifyRequestByAdmin(
      req.id,
      {
        approved: true,
        adminNote: c.adminNote,
        verifiedBy: 'Chuyên viên CTSV'
      },
      { simulateEmail: true }
    );

    const updated = camundaManager.getRequestById(req.id);
    if (updated.status === 'WAITING_HARD_PICKUP') {
      await sleep(220);
      await camundaManager.confirmHardCopyIssued(req.id, {
        issuedBy: 'Chuyên viên CTSV (Quầy P.104-E3)',
        note: 'Đã bàn giao bản cứng có dấu đỏ'
      });
    }
  }

  // 3. Kịch bản 3: tu_choi (2 hồ sơ bị từ chối: 1 tự động do bảo lưu + 1 chuyên viên từ chối do thiếu minh chứng)
  console.log('[3/4] Đang chạy 2 hồ sơ kịch bản Từ chối (tu_choi)...');
  // 3a. Hồ sơ sinh viên đang bảo lưu -> Hệ thống tự động từ chối ở cổng MSSV hợp lệ?
  const leaveStu = getStudentByCode('22024019');
  await camundaManager.createStudentRequest(
    {
      studentUsername: leaveStu.studentCode,
      studentName: leaveStu.fullName,
      studentCode: leaveStu.studentCode,
      studentEmail: leaveStu.email,
      faculty: leaveStu.faculty,
      purposeCategory: 'VE_UU_DAI',
      copyType: 'SOFT',
      reason: 'Xin giấy xác nhận sinh viên để đăng ký vé tháng xe buýt',
      baseUrl: 'http://localhost:3000',
      scenarioTag: 'tu_choi'
    },
    { simulateEmail: true, slaTimeoutMs: NORMAL_SLA_MS }
  );

  // 3b. Hồ sơ mục đích ngoại lệ không rõ ràng -> Chuyên viên CTSV từ chối kèm lý do
  const rejectStu = getStudentByCode('24020205');
  const reqManualReject = await camundaManager.createStudentRequest(
    {
      studentUsername: rejectStu.studentCode,
      studentName: rejectStu.fullName,
      studentCode: rejectStu.studentCode,
      studentEmail: rejectStu.email,
      faculty: rejectStu.faculty,
      purposeCategory: 'KHAC',
      copyType: 'SOFT',
      reason: 'Xin xác nhận mục đích cá nhân khác nhưng chưa ghi rõ đơn vị tiếp nhận',
      baseUrl: 'http://localhost:3000',
      scenarioTag: 'tu_choi'
    },
    { simulateEmail: true, slaTimeoutMs: NORMAL_SLA_MS }
  );
  await sleep(720);
  await camundaManager.verifyRequestByAdmin(
    reqManualReject.id,
    {
      approved: false,
      adminNote: 'Đề nghị sinh viên nêu rõ tên cơ quan tiếp nhận và mục đích sử dụng cụ thể trước khi nộp lại',
      verifiedBy: 'Chuyên viên CTSV'
    },
    { simulateEmail: true }
  );

  // 4. Kịch bản 4: qua_han_sla (3 hồ sơ ngoại lệ chờ vượt mốc SLA 1.5s -> Timer_QuaHanSLA kích hoạt gửi nhắc việc -> sau đó duyệt 2, từ chối 1)
  console.log('[4/4] Đang chạy 3 hồ sơ kịch bản Quá hạn SLA (qua_han_sla - chờ Timer kích hoạt)...');
  const overdueCases = [
    {
      code: '22028115',
      purposeCategory: 'KHAC',
      copyType: 'SOFT',
      reason: 'Xin giấy xác nhận sinh viên để bổ sung hồ sơ xin thị thực tham dự hội thảo quốc tế',
      approved: true,
      adminNote: 'Đã xác minh thư mời báo cáo hội thảo sau khi nhận email nhắc hạn SLA'
    },
    {
      code: '23020512',
      purposeCategory: 'KHAC',
      copyType: 'HARD',
      reason: 'Xin xác nhận sinh viên bản cứng để hoàn tất thủ tục bảo hiểm thân nhân tại địa phương',
      approved: true,
      adminNote: 'Hồ sơ hợp lệ, đồng ý cấp bản cứng sau nhắc việc SLA'
    },
    {
      code: '23021108',
      purposeCategory: 'HOC_BONG',
      copyType: 'SOFT',
      reason: 'Xin xác nhận xét tài trợ doanh nghiệp khi đang còn khoản công nợ học phí học kỳ hiện tại',
      approved: false,
      adminNote: 'Chưa hoàn thành nghĩa vụ học phí học kỳ hiện tại theo quy chế xét tài trợ'
    }
  ];

  const overdueReqs = [];
  for (const c of overdueCases) {
    const stu = getStudentByCode(c.code);
    const r = await camundaManager.createStudentRequest(
      {
        studentUsername: c.code,
        studentName: stu.fullName,
        studentCode: c.code,
        studentEmail: stu.email,
        faculty: stu.faculty,
        purposeCategory: c.purposeCategory,
        copyType: c.copyType,
        reason: c.reason,
        baseUrl: 'http://localhost:3000',
        scenarioTag: 'qua_han_sla'
      },
      { simulateEmail: true, slaTimeoutMs: OVERDUE_TEST_SLA_MS }
    );
    overdueReqs.push({ req: r, spec: c });
  }

  // Chờ vượt ngưỡng OVERDUE_TEST_SLA_MS (1500 ms) để Non-interrupting Boundary Timer tự động nổ
  await sleep(1950);

  for (let i = 0; i < overdueReqs.length; i++) {
    const { req, spec } = overdueReqs[i];
    await sleep(200 + i * 120);
    await camundaManager.verifyRequestByAdmin(
      req.id,
      {
        approved: spec.approved,
        adminNote: spec.adminNote,
        verifiedBy: 'Chuyên viên CTSV'
      },
      { simulateEmail: true }
    );
    const updated = camundaManager.getRequestById(req.id);
    if (updated.status === 'WAITING_HARD_PICKUP') {
      await sleep(210);
      await camundaManager.confirmHardCopyIssued(req.id, {
        issuedBy: 'Chuyên viên CTSV (Quầy P.104-E3)',
        note: 'Đã phát bản cứng sau khi duyệt hồ sơ quá hạn'
      });
    }
  }

  // Thu thập toàn bộ 40 hồ sơ theo đúng thứ tự khởi tạo
  const all = camundaManager
    .getAllRequests()
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  // Xuất file CSV 1: kpi_scenario_instances.csv
  const scenarioHeaders = [
    'instance_index',
    'request_id',
    'process_instance_key',
    'scenario',
    'student_code',
    'student_name',
    'academic_status',
    'purpose_category',
    'copy_type',
    'processing_mode',
    'sla_reminded',
    'final_status',
    'end_event_id',
    'outcome',
    'created_at',
    'completed_at',
    'lead_time_ms',
    'lead_time_sec'
  ];

  const scenarioLines = [scenarioHeaders.join(',')];
  all.forEach((r, idx) => {
    const outcome = r.approved ? 'CAP_GIAY' : 'TU_CHOI';
    const leadSec = Number(((r.leadTimeMs || 0) / 1000).toFixed(3));
    scenarioLines.push(
      [
        idx + 1,
        r.id,
        r.processInstanceKey,
        r.scenarioTag,
        r.studentCode,
        r.studentName,
        r.academicStatus,
        r.purposeCategory,
        r.copyType,
        r.processingMode,
        r.slaReminded ? 'true' : 'false',
        r.status,
        r.endEventId,
        outcome,
        r.createdAt,
        r.completedAt,
        r.leadTimeMs,
        leadSec
      ]
        .map(csvEscape)
        .join(',')
    );
  });
  fs.writeFileSync(SCENARIO_CSV, scenarioLines.join('\n') + '\n', 'utf8');

  // Xuất file CSV 2: kpi_element_instances.csv
  const elementHeaders = [
    'event_index',
    'request_id',
    'scenario',
    'element_id',
    'element_name',
    'element_type',
    'started_at',
    'completed_at',
    'duration_ms',
    'duration_sec'
  ];
  const elementLines = [elementHeaders.join(',')];
  let evIdx = 1;
  all.forEach((r) => {
    (r.elementInstances || []).forEach((el) => {
      elementLines.push(
        [
          evIdx++,
          r.id,
          r.scenarioTag,
          el.elementId,
          el.elementName,
          el.elementType,
          el.startedAt,
          el.completedAt,
          el.durationMs,
          Number((el.durationMs / 1000).toFixed(3))
        ]
          .map(csvEscape)
          .join(',')
      );
    });
  });
  fs.writeFileSync(ELEMENT_CSV, elementLines.join('\n') + '\n', 'utf8');

  // Tổng hợp thống kê chi tiết ra kpi_summary.json
  const scenarioOrder = ['stp', 'duyet_ngoai_le', 'tu_choi', 'qua_han_sla'];
  const byScenario = {};
  for (const sc of scenarioOrder) {
    const items = all.filter((r) => r.scenarioTag === sc);
    const approvedCount = items.filter((r) => r.approved === true).length;
    const rejectedCount = items.filter((r) => r.approved === false).length;
    const remindedCount = items.filter((r) => r.slaReminded).length;
    const softCount = items.filter((r) => r.copyType === 'SOFT').length;
    const hardCount = items.filter((r) => r.copyType === 'HARD').length;
    const leadTimesMs = items.map((r) => r.leadTimeMs || 0);
    const leadTimesSec = leadTimesMs.map((v) => v / 1000);
    byScenario[sc] = {
      count: items.length,
      approvedCount,
      rejectedCount,
      remindedCount,
      softCount,
      hardCount,
      leadTimeMs: statsOf(leadTimesMs),
      leadTimeSec: statsOf(leadTimesSec)
    };
  }

  const elementMap = {};
  all.forEach((r) => {
    (r.elementInstances || []).forEach((el) => {
      if (!elementMap[el.elementId]) {
        elementMap[el.elementId] = {
          elementId: el.elementId,
          elementName: el.elementName,
          elementType: el.elementType,
          durationsMs: []
        };
      }
      elementMap[el.elementId].durationsMs.push(el.durationMs);
    });
  });

  const byElement = {};
  for (const [elId, info] of Object.entries(elementMap)) {
    byElement[elId] = {
      elementId: elId,
      elementName: info.elementName,
      elementType: info.elementType,
      runs: info.durationsMs.length,
      durationMs: statsOf(info.durationsMs),
      durationSec: statsOf(info.durationsMs.map((v) => v / 1000))
    };
  }

  const allLeadMs = all.map((r) => r.leadTimeMs || 0);
  const summary = {
    generatedAt: new Date().toISOString(),
    engineMode: camundaManager.engineMode,
    totalRequests: all.length,
    totalApproved: all.filter((r) => r.approved === true).length,
    totalRejected: all.filter((r) => r.approved === false).length,
    totalStp: all.filter((r) => r.processingMode === 'STP').length,
    totalManualException: all.filter((r) => r.processingMode === 'MANUAL_EXCEPTION').length,
    totalAutoRejected: all.filter((r) => r.processingMode === 'AUTO_REJECTED').length,
    totalSlaReminded: all.filter((r) => r.slaReminded).length,
    totalSoftCopyIssued: all.filter((r) => r.status === 'COMPLETED_SOFT_SENT').length,
    totalHardCopyIssued: all.filter((r) => r.status === 'COMPLETED_HARD_ISSUED').length,
    totalElementEvents: evIdx - 1,
    overallLeadTimeMs: statsOf(allLeadMs),
    overallLeadTimeSec: statsOf(allLeadMs.map((v) => v / 1000)),
    byScenario,
    byElement
  };

  fs.writeFileSync(SUMMARY_JSON, JSON.stringify(summary, null, 2), 'utf8');

  console.log('\n================ KẾT QUẢ THỰC NGHIỆM 40 HỒ SƠ ================');
  console.log(`- Tổng số hồ sơ         : ${summary.totalRequests}`);
  console.log(`- Được cấp              : ${summary.totalApproved} (${((summary.totalApproved / summary.totalRequests) * 100).toFixed(1)}%)`);
  console.log(`  + Bản điện tử (SOFT)  : ${summary.totalSoftCopyIssued}`);
  console.log(`  + Kèm bản cứng (HARD) : ${summary.totalHardCopyIssued}`);
  console.log(`- Bị từ chối            : ${summary.totalRejected} (${((summary.totalRejected / summary.totalRequests) * 100).toFixed(1)}%)`);
  console.log(`- Xử lý thẳng (STP)     : ${summary.totalStp} (${((summary.totalStp / summary.totalRequests) * 100).toFixed(1)}%)`);
  console.log(`- Nhắc việc quá hạn SLA : ${summary.totalSlaReminded} hồ sơ`);
  console.log(`- Lead time TB toàn cục : ${summary.overallLeadTimeMs.mean} ms (${summary.overallLeadTimeSec.mean} s) | Trung vị: ${summary.overallLeadTimeMs.median} ms`);
  console.log(`- Đã xuất CSV kịch bản  : ${SCENARIO_CSV}`);
  console.log(`- Đã xuất CSV từng bước : ${ELEMENT_CSV} (${summary.totalElementEvents} bản ghi)`);
  console.log(`- Đã xuất JSON tổng hợp : ${SUMMARY_JSON}`);
}

runBatch().catch((err) => {
  console.error('[KPI Batch] Lỗi khi chạy thực nghiệm:', err);
  process.exit(1);
});
