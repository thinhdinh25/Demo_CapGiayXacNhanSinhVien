const PDFDocument = require('pdfkit');
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

function generateCertificatePDF(requestData) {
  return new Promise((resolve, reject) => {
    try {
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
      doc
        .moveTo(105, 80)
        .lineTo(223, 80)
        .lineWidth(0.7)
        .strokeColor('#000000')
        .stroke();
      doc.fontSize(10).text(`Số: ${requestData.id}/GXN-CTSV`, 54, 86, { width: 220, align: 'center' });

      setBold();
      doc.fontSize(11).text('CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM', 280, 48, { width: 260, align: 'center' });
      doc.fontSize(11).text('Độc lập - Tự do - Hạnh phúc', 280, 64, { width: 260, align: 'center' });
      doc
        .moveTo(340, 80)
        .lineTo(480, 80)
        .lineWidth(0.7)
        .strokeColor('#000000')
        .stroke();

      // 2. Tiêu đề Giấy xác nhận
      setBold();
      doc.fontSize(16).text('GIẤY XÁC NHẬN SINH VIÊN', 54, 140, {
        align: 'center',
        width: 487
      });

      // 3. Nội dung xác nhận tiếng Việt có dấu
      doc.moveDown(1.5);
      setBold();
      doc.fontSize(12).text('Trường Đại học Công nghệ - Đại học Quốc gia Hà Nội xác nhận:', 54, 185);

      setRegular();
      doc.fontSize(12).lineGap(7);
      doc.text(`Họ và tên sinh viên: ${requestData.studentName}`, 54, 212);
      doc.text(`Mã số sinh viên: ${requestData.studentCode}`);
      doc.text(`Đơn vị đào tạo: ${requestData.faculty || 'Khoa Công nghệ Thông tin - Trường ĐH Công nghệ'}`);
      doc.text(`Thư điện tử VNU: ${requestData.studentEmail}`);
      doc.text(`Lý do xin xác nhận: ${requestData.reason}`);
      doc.text(
        `Hình thức nhận: ${
          requestData.copyType === 'SOFT'
            ? 'Bản điện tử gửi qua thư điện tử'
            : 'Bản cứng nhận trực tiếp tại Phòng Công tác Sinh viên'
        }`
      );

      doc.moveDown(0.8);
      doc.text(
        'Hiện đang là sinh viên hệ chính quy đang theo học tại Trường Đại học Công nghệ - Đại học Quốc gia Hà Nội. Giấy xác nhận này có giá trị trong thời hạn 03 tháng kể từ ngày ký.',
        { align: 'justify', width: 487 }
      );

      if (requestData.adminNote) {
        doc.moveDown(0.5);
        doc.text(`Ghi chú: ${requestData.adminNote}`);
      }

      // 4. Chữ ký của Phòng Công tác Sinh viên
      doc.moveDown(2);
      const verifiedDate = requestData.verifiedAt ? new Date(requestData.verifiedAt) : new Date();
      const day = String(verifiedDate.getDate()).padStart(2, '0');
      const month = String(verifiedDate.getMonth() + 1).padStart(2, '0');
      const year = verifiedDate.getFullYear();

      const signY = doc.y;
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
        .text('(Đã ký và xác thực điện tử)', 280, signY + 66, { width: 260, align: 'center' });

      setBold();
      doc
        .fillColor('#000000')
        .fontSize(11)
        .text('Phòng Công tác Sinh viên', 280, signY + 86, {
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
