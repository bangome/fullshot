// FullShot - stitcher
// 캡처 타일들을 하나의 canvas 로 합성. meta 의 origin 기준으로 배치하고
// canvas 크기 밖은 자동 클리핑된다(전체/보이는화면/영역 모드 통합 처리).

const MAX_CANVAS_DIM = 16384; // 브라우저 canvas 최대 크기 보수적 한계

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('이미지 로드 실패'));
    img.src = src;
  });
}

// meta: { dpr, originX, originY, canvasWidth, canvasHeight }
// tiles: [{ x, y, dataUrl }]  (x,y 는 document CSS 좌표)
export async function stitch(tiles, meta) {
  const dpr = meta.dpr || 1;
  let w = Math.round(meta.canvasWidth * dpr);
  let h = Math.round(meta.canvasHeight * dpr);

  const warnings = [];
  if (h > MAX_CANVAS_DIM) {
    warnings.push(
      `페이지가 매우 길어(${h}px) canvas 한계(${MAX_CANVAS_DIM}px)를 초과하여 잘렸습니다.`
    );
    h = MAX_CANVAS_DIM;
  }
  if (w > MAX_CANVAS_DIM) {
    warnings.push(`페이지 폭이 canvas 한계를 초과하여 잘렸습니다.`);
    w = MAX_CANVAS_DIM;
  }

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  for (const tile of tiles) {
    const img = await loadImage(tile.dataUrl);
    const dx = Math.round((tile.x - meta.originX) * dpr);
    const dy = Math.round((tile.y - meta.originY) * dpr);
    ctx.drawImage(img, dx, dy);
  }

  return { canvas, warnings };
}

// 직사각형 영역 크롭 (canvas 픽셀 좌표)
export function crop(sourceCanvas, rect) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(rect.w));
  c.height = Math.max(1, Math.round(rect.h));
  const ctx = c.getContext('2d');
  ctx.drawImage(
    sourceCanvas,
    Math.round(rect.x), Math.round(rect.y), c.width, c.height,
    0, 0, c.width, c.height
  );
  return c;
}
