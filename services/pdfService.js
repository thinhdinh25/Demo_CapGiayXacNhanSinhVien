const PDFDocument = require('pdfkit');
const fs = require('fs');

function getVietnameseFontPath() {
  const candidates = [
    'C:\\Windows\\Fonts\\times.ttf',
    'C:\\Windows\\Fonts\\arial.ttf',
    'C:\\Windows\\Fonts\\tahoma.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/TTF/DejaVuSans.ttf'
  ];
  for (const fontPath of candidates) {
    if (fs.existsSync(fontPath)) {
      return fontPath;
    }
  }
  return null;
}

function removeAccents(str) {
  if (!str) return '';
  return String(str)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

function generateCertificatePDF(requestData) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 54 });
      const buffers = [];
      doc.on('data', (chunk) => buffers.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(buffers)));

      const fontPath = getVietnameseFontPath();
      const formatText = (txt) => (fontPath ? String(txt || '') : removeAccents(txt || ''));

      if (fontPath) {
        doc.font(fontPath);
      } else {
        doc.font('Helvetica');
      }

      // Quốc hiệu & Tiêu ngữ chuẩn văn bản hành chính ĐHQGHN
      doc.fontSize(11).text(formatText('ĐẠI HỌC QUỐC GIA HÀ NỘI'), 54, 50, { width: 220, align: 'center' });
      doc.fontSize(11).text(formatText('TRƯỜNG ĐẠI HỌC CÔNG NGHỆ'), 54, 66, { width: 220, align: 'center' });
      doc.fontSize(10).text(formatText(`Số: ${requestData.id}/GXN-ĐHCN`), 54, 86, { width: 220, align: 'center' });

      doc.fontSize(11).text(formatText('CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM'), 280, 50, { width: 260, align: 'center' });
      doc.fontSize(11).text(formatText('Độc lập - Tự do - Hạnh phúc'), 280, 66, { width: 260, align: 'center' });

      doc.moveDown(3);

      // Tiêu đề giấy xác nhận
      doc.fontSize(16).text(formatText('GIẤY XÁC NHẬN SINH VIÊN'), 54, 145, {
        align: 'center',
        width: 487
      });

      doc.moveDown(1.5);
      doc.fontSize(12).lineGap(7);
      doc.text(formatText('Trường Đại học Công nghệ - Đại học Quốc gia Hà Nội xác nhận:'), 54, 190);
      doc.moveDown(0.5);

      doc.text(formatText(`Họ và tên sinh viên: ${requestData.studentName}`));
      doc.text(formatText(`Mã số sinh viên: ${requestData.studentCode}`));
      doc.text(formatText(`Đơn vị đào tạo: ${requestData.faculty || 'Khoa Công nghệ Thông tin'}`));
      doc.text(formatText(`Thư điện tử VNU: ${requestData.studentEmail}`));
      doc.text(formatText(`Mục đích xác nhận: ${requestData.reason}`));
      doc.text(
        formatText(
          `Hình thức cấp: ${
            requestData.copyType === 'SOFT' ? 'Bản điện tử gửi qua thư điện tử' : 'Bản giấy nhận trực tiếp tại Phòng CT&CTHSSV'
          }`
        )
      );

      doc.moveDown(0.8);
      doc.text(
        formatText(
          'Hiện đang là sinh viên hệ chính quy đang theo học tại Trường. Giấy xác nhận này có giá trị trong thời hạn 03 tháng kể từ ngày ký.'
        ),
        { align: 'justify', width: 487 }
      );

      if (requestData.adminNote) {
        doc.moveDown(0.5);
        doc.text(formatText(`Ghi chú: ${requestData.adminNote}`));
      }

      doc.moveDown(2);
      const verifiedDate = requestData.verifiedAt ? new Date(requestData.verifiedAt) : new Date();
      const day = String(verifiedDate.getDate()).padStart(2, '0');
      const month = String(verifiedDate.getMonth() + 1).padStart(2, '0');
      const year = verifiedDate.getFullYear();

      doc.fontSize(11).text(formatText(`Hà Nội, ngày ${day} tháng ${month} năm ${year}`), 280, doc.y, {
        width: 260,
        align: 'center'
      });
      doc.moveDown(0.4);
      doc.fontSize(11).text(formatText('TL. HIỆU TRƯỞNG'), 280, doc.y, { width: 260, align: 'center' });
      doc.fontSize(11).text(formatText('TRƯỞNG PHÒNG CT&CTHSSV'), 280, doc.y, { width: 260, align: 'center' });
      doc.moveDown(1.2);
      doc.fontSize(10).text(formatText('(Đã ký và xác thực điện tử)'), 280, doc.y, { width: 260, align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(11).text(formatText(requestData.verifiedBy || 'Phòng CT&CTHSSV'), 280, doc.y, {
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
