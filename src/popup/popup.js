// FullShot - popup
const $ = (id) => document.getElementById(id);
const statusEl = $('status');

const DEFAULTS = { format: 'png', quality: 0.92, scrollDelay: 200 };

// 설정 로드
chrome.storage.sync.get(DEFAULTS, (cfg) => {
  $('format').value = cfg.format;
  $('quality').value = cfg.quality;
  $('qualityVal').textContent = cfg.quality;
  $('scrollDelay').value = cfg.scrollDelay;
  $('delayVal').textContent = cfg.scrollDelay;
});

function saveSetting(key, value) {
  chrome.storage.sync.set({ [key]: value });
}

$('format').addEventListener('change', (e) => saveSetting('format', e.target.value));
$('quality').addEventListener('input', (e) => {
  $('qualityVal').textContent = e.target.value;
  saveSetting('quality', parseFloat(e.target.value));
});
$('scrollDelay').addEventListener('input', (e) => {
  $('delayVal').textContent = e.target.value;
  saveSetting('scrollDelay', parseInt(e.target.value, 10));
});

function setStatus(msg, ok) {
  statusEl.textContent = msg;
  statusEl.classList.toggle('ok', !!ok);
}

document.querySelectorAll('.btn[data-mode]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const mode = btn.dataset.mode;
    setStatus('캡처 시작…', true);
    document.querySelectorAll('.btn').forEach((b) => (b.disabled = true));
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'FULLSHOT_CAPTURE_REQUEST',
        mode,
      });
      if (resp && resp.ok) {
        // content script 가 작업을 이어가므로 팝업은 닫는다
        window.close();
      } else {
        setStatus((resp && resp.error) || '캡처를 시작할 수 없습니다.', false);
        document.querySelectorAll('.btn').forEach((b) => (b.disabled = false));
      }
    } catch (e) {
      setStatus('오류: ' + e.message, false);
      document.querySelectorAll('.btn').forEach((b) => (b.disabled = false));
    }
  });
});
