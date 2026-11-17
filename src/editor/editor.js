// FullShot - editor
import { stitch, crop } from '../lib/stitcher.js';
import { jpegToPdf, dataUrlToBytes } from '../lib/pdf.js';

const $ = (id) => document.getElementById(id);

const els = {
  loading: $('loading'),
  viewport: $('viewport'),
  preview: $('preview'),
  cropBox: $('cropBox'),
  format: $('format'),
  quality: $('quality'),
  qualityVal: $('qualityVal'),
  cropToggle: $('cropToggle'),
  cropApply: $('cropApply'),
  cropCancel: $('cropCancel'),
  resetBtn: $('resetBtn'),
  downloadBtn: $('downloadBtn'),
  copyBtn: $('copyBtn'),
  metaInfo: $('metaInfo'),
  toast: $('toast'),
};

let fullCanvas = null; // 합성 원본
let workCanvas = null; // 현재(크롭 반영) canvas
let meta = null;

function toast(msg, isErr) {
  els.toast.textContent = msg;
  els.toast.classList.toggle('err', !!isErr);
  els.toast.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (els.toast.hidden = true), 3000);
}

function getParam(name) {
  return new URLSearchParams(location.search).get(name);
}

// 화면에 맞춰 표시 크기 계산 (업스케일 안 함)
function renderPreview() {
  const ctx = els.preview.getContext('2d');
  els.preview.width = workCanvas.width;
  els.preview.height = workCanvas.height;
  ctx.drawImage(workCanvas, 0, 0);

  const maxW = els.viewport.parentElement.clientWidth - 48;
  const scale = Math.min(1, maxW / workCanvas.width);
  els.preview.style.width = workCanvas.width * scale + 'px';
  els.preview.style.height = workCanvas.height * scale + 'px';

  els.metaInfo.textContent = `${workCanvas.width} × ${workCanvas.height}px · ${meta.mode}`;
}

// 팝업 설정(기본 형식 / JPEG 품질)을 에디터 컨트롤의 초기값으로 반영
async function applySavedSettings() {
  try {
    const cfg = await chrome.storage.sync.get({ format: 'png', quality: 0.92 });
    els.format.value = cfg.format;
    els.quality.value = cfg.quality;
    els.qualityVal.textContent = els.quality.value;
  } catch (_) {
    // 설정을 못 읽으면 HTML 기본값 유지
  }
}

async function init() {
  await applySavedSettings();
  const id = getParam('id');
  if (!id) {
    els.loading.textContent = '잘못된 접근입니다 (id 없음).';
    return;
  }
  const store = await chrome.storage.local.get(id);
  const data = store[id];
  if (!data) {
    els.loading.textContent = '캡처 데이터를 찾을 수 없습니다 (만료되었거나 이미 사용됨).';
    return;
  }
  // 사용 후 정리
  chrome.storage.local.remove(id);

  meta = data.meta;
  try {
    const { canvas, warnings } = await stitch(data.tiles, meta);
    fullCanvas = canvas;
    workCanvas = canvas;
    els.loading.hidden = true;
    els.viewport.hidden = false;
    renderPreview();
    if (warnings.length) toast(warnings.join(' '), true);
  } catch (e) {
    els.loading.textContent = '합성 실패: ' + e.message;
  }
}

/* ---------- 크롭 ---------- */
let cropMode = false;
let dragging = false;
let cropRectDisplay = null; // 표시 좌표 기준 {x,y,w,h}

function displayScale() {
  return workCanvas.width / els.preview.clientWidth;
}

function enterCrop() {
  cropMode = true;
  cropRectDisplay = null;
  els.cropBox.hidden = true;
  els.cropToggle.classList.add('active');
  els.cropApply.hidden = false;
  els.cropCancel.hidden = false;
  els.preview.style.cursor = 'crosshair';
}
function exitCrop() {
  cropMode = false;
  dragging = false;
  els.cropBox.hidden = true;
  els.cropToggle.classList.remove('active');
  els.cropApply.hidden = true;
  els.cropCancel.hidden = true;
  els.preview.style.cursor = '';
}

els.cropToggle.addEventListener('click', () => {
  if (cropMode) exitCrop();
  else enterCrop();
});
els.cropCancel.addEventListener('click', exitCrop);

els.viewport.addEventListener('mousedown', (e) => {
  if (!cropMode) return;
  const rect = els.preview.getBoundingClientRect();
  dragging = true;
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  cropRectDisplay = { x: sx, y: sy, w: 0, h: 0, sx, sy };
  updateCropBox();
});
window.addEventListener('mousemove', (e) => {
  if (!cropMode || !dragging) return;
  const rect = els.preview.getBoundingClientRect();
  const cx = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
  const cy = Math.max(0, Math.min(e.clientY - rect.top, rect.height));
  const r = cropRectDisplay;
  r.x = Math.min(cx, r.sx);
  r.y = Math.min(cy, r.sy);
  r.w = Math.abs(cx - r.sx);
  r.h = Math.abs(cy - r.sy);
  updateCropBox();
});
window.addEventListener('mouseup', () => {
  if (cropMode) dragging = false;
});

function updateCropBox() {
  const r = cropRectDisplay;
  if (!r || r.w < 2 || r.h < 2) {
    els.cropBox.hidden = true;
    return;
  }
  els.cropBox.hidden = false;
  els.cropBox.style.left = els.preview.offsetLeft + r.x + 'px';
  els.cropBox.style.top = els.preview.offsetTop + r.y + 'px';
  els.cropBox.style.width = r.w + 'px';
  els.cropBox.style.height = r.h + 'px';
}

els.cropApply.addEventListener('click', () => {
  if (!cropRectDisplay || cropRectDisplay.w < 2 || cropRectDisplay.h < 2) {
    exitCrop();
    return;
  }
  const s = displayScale();
  const r = cropRectDisplay;
  workCanvas = crop(workCanvas, {
    x: r.x * s,
    y: r.y * s,
    w: r.w * s,
    h: r.h * s,
  });
  exitCrop();
  renderPreview();
  els.resetBtn.hidden = false;
  toast('크롭 완료');
});

els.resetBtn.addEventListener('click', () => {
  workCanvas = fullCanvas;
  renderPreview();
  els.resetBtn.hidden = true;
});

/* ---------- 출력 ---------- */
els.quality.addEventListener('input', () => {
  els.qualityVal.textContent = els.quality.value;
});

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(
    d.getHours()
  )}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

els.downloadBtn.addEventListener('click', async () => {
  const fmt = els.format.value;
  const quality = parseFloat(els.quality.value);
  const base = `fullshot_${timestamp()}`;
  try {
    if (fmt === 'png') {
      const blob = await canvasToBlob(workCanvas, 'image/png');
      triggerDownload(blob, base + '.png');
    } else if (fmt === 'jpeg') {
      const blob = await canvasToBlob(workCanvas, 'image/jpeg', quality);
      triggerDownload(blob, base + '.jpg');
    } else if (fmt === 'pdf') {
      const dataUrl = workCanvas.toDataURL('image/jpeg', quality);
      const bytes = dataUrlToBytes(dataUrl);
      const blob = jpegToPdf(bytes, workCanvas.width, workCanvas.height);
      triggerDownload(blob, base + '.pdf');
    }
    toast('저장 완료');
  } catch (e) {
    toast('저장 실패: ' + e.message, true);
  }
});

els.copyBtn.addEventListener('click', async () => {
  try {
    const blob = await canvasToBlob(workCanvas, 'image/png');
    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': blob }),
    ]);
    toast('클립보드에 복사됨');
  } catch (e) {
    toast('복사 실패: ' + e.message, true);
  }
});

init();
