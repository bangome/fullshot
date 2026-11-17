// FullShot - 최소 PDF 생성기 (외부 라이브러리 없음)
// JPEG 바이트를 DCTDecode 필터로 PDF 에 그대로 임베드한다.
// 매우 긴 이미지는 A4 폭 기준으로 비율 유지하여 한 페이지(긴 페이지)로 출력.

// 문자열 -> 바이트
function strBytes(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

function concat(chunks) {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * @param {Uint8Array} jpegBytes  - JPEG 이미지 바이트
 * @param {number} pxW            - 이미지 픽셀 폭
 * @param {number} pxH            - 이미지 픽셀 높이
 * @returns {Blob} application/pdf
 */
export function jpegToPdf(jpegBytes, pxW, pxH) {
  // 페이지 크기(pt): A4 폭(595.28pt)에 맞춰 비율 유지
  const A4_W = 595.28;
  const scale = A4_W / pxW;
  const pageW = A4_W;
  const pageH = pxH * scale;

  const chunks = [];
  const offsets = []; // 객체별 바이트 오프셋
  let pos = 0;
  const push = (data) => {
    const bytes = typeof data === 'string' ? strBytes(data) : data;
    chunks.push(bytes);
    pos += bytes.length;
  };
  const startObj = (n) => {
    offsets[n] = pos;
  };

  // Header
  push('%PDF-1.4\n%\xFF\xFF\xFF\xFF\n');

  // 1: Catalog
  startObj(1);
  push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  // 2: Pages
  startObj(2);
  push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');

  // 3: Page
  startObj(3);
  push(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW.toFixed(
      2
    )} ${pageH.toFixed(
      2
    )}] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>\nendobj\n`
  );

  // 4: Contents (이미지를 페이지 전체에 그림)
  const content = `q\n${pageW.toFixed(2)} 0 0 ${pageH.toFixed(
    2
  )} 0 0 cm\n/Im0 Do\nQ\n`;
  const contentBytes = strBytes(content);
  startObj(4);
  push(`4 0 obj\n<< /Length ${contentBytes.length} >>\nstream\n`);
  push(contentBytes);
  push('\nendstream\nendobj\n');

  // 5: Image XObject (DCTDecode = JPEG)
  startObj(5);
  push(
    `5 0 obj\n<< /Type /XObject /Subtype /Image /Width ${pxW} /Height ${pxH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`
  );
  push(jpegBytes);
  push('\nendstream\nendobj\n');

  // xref
  const xrefStart = pos;
  const objCount = 6; // 0..5
  let xref = `xref\n0 ${objCount}\n0000000000 65535 f \n`;
  for (let i = 1; i < objCount; i++) {
    xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  push(xref);
  push(
    `trailer\n<< /Size ${objCount} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`
  );

  return new Blob([concat(chunks)], { type: 'application/pdf' });
}

// dataURL(image/jpeg) -> Uint8Array
export function dataUrlToBytes(dataUrl) {
  const base64 = dataUrl.split(',')[1];
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
