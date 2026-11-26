require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { Camunda8 } = require('@camunda8/sdk');

async function deployBpmn() {
  const bpmnPath = path.join(__dirname, '..', 'bpmn', 'student-certificate.bpmn');
  if (!fs.existsSync(bpmnPath)) {
    console.error('[Deploy BPMN] Không tìm thấy file mô hình:', bpmnPath);
    process.exit(1);
  }

  if (!process.env.ZEEBE_ADDRESS) {
    process.env.ZEEBE_ADDRESS = 'localhost:26500';
  }
  if (!process.env.CAMUNDA_SECURE_CONNECTION) {
    process.env.CAMUNDA_SECURE_CONNECTION = 'false';
  }

  console.log(`[Deploy BPMN] Đang kết nối tới Zeebe Broker tại ${process.env.ZEEBE_ADDRESS}...`);
  try {
    const c8 = new Camunda8();
    const zeebe = c8.getZeebeGrpcApiClient();
    const res = await zeebe.deployResource({
      processFilename: bpmnPath
    });
    console.log('[Deploy BPMN] Triển khai mô hình BPMN 2.0 thành công!');
    console.log(JSON.stringify(res, null, 2));
    process.exit(0);
  } catch (err) {
    console.error('[Deploy BPMN] Không thể kết nối Zeebe Broker:', err.message);
    console.error(
      'Gợi ý: Hãy khởi động cụm Zeebe bằng lệnh `docker compose up -d zeebe` trước khi chạy script này, hoặc chạy trực tiếp `node server.js` để sử dụng Camunda 8 Built-in Engine.'
    );
    process.exit(1);
  }
}

deployBpmn();
