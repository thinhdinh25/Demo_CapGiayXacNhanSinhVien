const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

function getVietnameseFontPaths() {
  const bundledRegular = path.join(__dirname, '..', 'assets', 'fonts', 'times.ttf');
  const bundledBold = path.join(__dirname, '..', 'assets', 'fonts', 'timesbd.ttf');

  const regularCandidates = [
    bundledRegular,
    'C:\\Windows\\Fonts\\times.ttf',
    'C:\\Windows\\Fonts\\arial.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
  ];

  const boldCandidates = [
    bundledBold,
    'C:\\Windows\\Fonts\\timesbd.ttf',
    'C:\\Windows\\Fonts\\arialbd.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
  ];

  let regular = null;
  let bold = null;

  for (const p of regularCandidates) {
    if (fs.existsSync(p)) {
      regular = p;
      break;
    }
  }
  for (const p of boldCandidates) {
    if (fs.existsSync(p)) {
      bold = p;
      break;
    }
  }

  return { regular, bold: bold || regular };
}

function resolvePublicBaseUrl(requestData) {
  if (requestData && requestData.baseUrl) {
    return String(requestData.baseUrl).replace(/\/+$/, '');
  }
  if (process.env.PUBLIC_BASE_URL) {
    return String(process.env.PUBLIC_BASE_URL).replace(/\/+$/, '');
  }
  if (process.env.RENDER_EXTERNAL_URL) {
    return String(process.env.RENDER_EXTERNAL_URL).replace(/\/+$/, '');
  }
  const port = process.env.PORT || 3000;
  return `http://localhost:${port}`;
}

function formatDobVi(dobStr) {
  if (!dobStr) return '14/05/2006';
  const m = String(dobStr).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  return dobStr;
}

function generateCertificatePDF(requestData) {
  return new Promise(async (resolve, reject) => {
    try {
      const baseUrl = resolvePublicBaseUrl(requestData);
      const pdfVerifyUrl = `${baseUrl}/api/requests/${requestData.id}/pdf`;
      const certNo = requestData.certificateNo || `${requestData.id}/GXN-ĐHCN`;
      const verifyCode = requestData.verificationCode || requestData.id.replace('REQ-', 'UET-');

      const qrBuffer = await QRCode.toBuffer(pdfVerifyUrl, {
        type: 'png',
        width: 116,
        margin: 1,
        errorCorrectionLevel: 'M'
      });

      const doc = new PDFDocument({ size: 'A4', margin: 54 });
      const buffers = [];
      doc.on('data', (chunk) => buffers.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(buffers)));

      const { regular: fontRegular, bold: fontBold } = getVietnameseFontPaths();

      const setRegular = () => {
        if (fontRegular) doc.font(fontRegular);
        else doc.font('Helvetica');
      };

      const setBold = () => {
        if (fontBold) doc.font(fontBold);
        else doc.font('Helvetica-Bold');
      };

      // 1. Quốc hiệu & Tiêu ngữ chuẩn văn bản hành chính
      setRegular();
      doc.fillColor('#000000');
      doc.fontSize(11).text('ĐẠI HỌC QUỐC GIA HÀ NỘI', 54, 48, { width: 220, align: 'center' });
      setBold();
      doc.fontSize(11).text('TRƯỜNG ĐẠI HỌC CÔNG NGHỆ', 54, 64, { width: 220, align: 'center' });
      setRegular();
      doc.moveTo(105, 80).lineTo(223, 80).lineWidth(0.7).strokeColor('#000000').stroke();
      doc.fontSize(10).text(`Số: ${certNo}`, 54, 86, { width: 220, align: 'center' });

      setBold();
      doc.fontSize(11).text('CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM', 280, 48, { width: 260, align: 'center' });
      doc.fontSize(11).text('Độc lập - Tự do - Hạnh phúc', 280, 64, { width: 260, align: 'center' });
      doc.moveTo(340, 80).lineTo(480, 80).lineWidth(0.7).strokeColor('#000000').stroke();

      // 2. Tiêu đề Giấy xác nhận
      setBold();
      doc.fontSize(16).text('GIẤY XÁC NHẬN SINH VIÊN', 54, 134, {
        align: 'center',
        width: 487
      });

      // 3. Nội dung xác nhận đối chiếu từ CSDL đào tạo
      setBold();
      doc.fontSize(12).text('Trường Đại học Công nghệ - Đại học Quốc gia Hà Nội xác nhận:', 54, 174);

      setRegular();
      doc.fontSize(12).lineGap(6);
      doc.text(`Họ và tên sinh viên: ${requestData.studentName}`, 54, 198);
      doc.text(`Ngày sinh: ${formatDobVi(requestData.studentDob)}          Mã số sinh viên: ${requestData.studentCode}`);
      doc.text(`Khóa đào tạo: ${requestData.studentCohort || 'QH-2024-I/CQ'}          Ngành học: ${requestData.studentProgram || 'Công nghệ thông tin'}`);
      doc.text(`Đơn vị đào tạo: ${requestData.faculty || 'Khoa Công nghệ Thông tin - Trường ĐH Công nghệ'}`);
      doc.text(`Tình trạng học tập: ${requestData.academicStatusLabel || 'Đang học (Hệ chính quy)'}`);
      doc.text(`Mục đích xác nhận: ${requestData.reason}`);
      doc.text(
        `Hình thức cấp: ${
          requestData.copyType === 'SOFT'
            ? 'Bản điện tử xác thực QR gửi qua thư điện tử'
            : 'Bản điện tử kèm bản giấy đóng dấu tại Phòng Công tác Sinh viên'
        }`
      );

      doc.moveDown(0.6);
      doc.text(
        'Hiện đang là sinh viên hệ chính quy đang theo học tại Trường Đại học Công nghệ - Đại học Quốc gia Hà Nội. Giấy xác nhận này có giá trị trong thời hạn 03 tháng kể từ ngày cấp.',
        { align: 'justify', width: 487 }
      );

      if (requestData.adminNote) {
        doc.moveDown(0.4);
        doc.text(`Ghi chú: ${requestData.adminNote}`);
      }

      // 4. Mã QR tra cứu trực tuyến và Chữ ký xác thực
      doc.moveDown(1.6);
      const verifiedDate = requestData.verifiedAt ? new Date(requestData.verifiedAt) : new Date();
      const day = String(verifiedDate.getDate()).padStart(2, '0');
      const month = String(verifiedDate.getMonth() + 1).padStart(2, '0');
      const year = verifiedDate.getFullYear();

      const signY = doc.y;

      if (qrBuffer) {
        doc.image(qrBuffer, 68, signY + 4, { width: 82, height: 82 });
        setBold();
        doc
          .fillColor('#1e3a8a')
          .fontSize(8.5)
          .text(`Mã xác thực: ${verifyCode}`, 48, signY + 90, { width: 122, align: 'center' });
        setRegular();
        doc
          .fillColor('#374151')
          .fontSize(8)
          .text('Quét mã QR để đối chiếu bản gốc PDF điện tử', 48, signY + 102, { width: 122, align: 'center' });
      }

      doc.fillColor('#000000');
      setRegular();
      doc.fontSize(11).text(`Hà Nội, ngày ${day} tháng ${month} năm ${year}`, 280, signY, {
        width: 260,
        align: 'center'
      });

      setBold();
      doc.fontSize(11).text('TL. HIỆU TRƯỞNG', 280, signY + 20, { width: 260, align: 'center' });
      doc.fontSize(11).text('TRƯỞNG PHÒNG CÔNG TÁC SINH VIÊN', 280, signY + 36, {
        width: 260,
        align: 'center'
      });

      setRegular();
      doc
        .fillColor('#005a32')
        .fontSize(10)
        .text(
          requestData.processingMode === 'STP'
            ? '(Đã ký & cấp tự động theo quy trình STP)'
            : '(Đã thẩm định & xác thực điện tử)',
          280,
          signY + 66,
          { width: 260, align: 'center' }
        );

      setBold();
      doc
        .fillColor('#000000')
        .fontSize(11)
        .text('Phòng Công tác Sinh viên', 280, signY + 88, {
          width: 260,
          align: 'center'
        });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generateCertificatePDF };
