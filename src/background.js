// FullShot - background service worker
// 캡처 오케스트레이션 + captureVisibleTab throttle + 결과 저장 후 에디터 오픈

// captureVisibleTab 은 초당 2회(MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND) 제한.
// 1초 윈도우에 3번 들어가지 않도록 600ms 이상 간격을 둔다.
const MIN_CAPTURE_INTERVAL_MS = 600;
let lastCaptureTs = 0;

// 진행 중인 캡처 세션 (탭 ID -> 세션)
const sessions = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 캡처 불가 페이지 차단 (chrome://, 웹스토어 등)
function isCapturableUrl(url) {
  if (!url) return false;
  return /^(https?|file|ftp):/i.test(url) && !url.startsWith('https://chrome.google.com/webstore');
}

async function captureOnce(windowId) {
  const now = Date.now();
  const wait = MIN_CAPTURE_INTERVAL_MS - (now - lastCaptureTs);
  if (wait > 0) await sleep(wait);
  lastCaptureTs = Date.now();
  return chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
}

// 쿼터 초과(MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND) 에러 시 한 박자 쉬고 재시도
async function throttledCapture(windowId) {
  try {
    return await captureOnce(windowId);
  } catch (e) {
    if (/MAX_CAPTURE_VISIBLE_TAB|quota/i.test(e.message || '')) {
      await sleep(1100);
      lastCaptureTs = Date.now();
      return chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    }
    throw e;
  }
}

// content script 를 대상 탭에 주입 (중복 주입은 content 쪽 가드로 무해)
async function ensureContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['src/content.js'],
  });
}

// 에디터 탭을 열고 세션 데이터를 storage.local 에 저장
async function openEditor(session) {
  const id = `cap_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  await chrome.storage.local.set({
    [id]: {
      meta: session.meta,
      tiles: session.tiles,
      createdAt: Date.now(),
    },
  });
  const url = chrome.runtime.getURL(`src/editor/editor.html?id=${id}`);
  await chrome.tabs.create({ url });
}

// 팝업 -> background: 캡처 시작
async function startCapture(mode) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return { ok: false, error: '활성 탭을 찾을 수 없습니다.' };
  if (!isCapturableUrl(tab.url)) {
    return { ok: false, error: '이 페이지는 캡처할 수 없습니다 (chrome:// 등 내부 페이지).' };
  }

  sessions.set(tab.id, { windowId: tab.windowId, tiles: [], meta: null, mode });

  try {
    await ensureContentScript(tab.id);
  } catch (e) {
    sessions.delete(tab.id);
    return { ok: false, error: '페이지에 접근할 수 없습니다: ' + e.message };
  }

  // content 에게 시작 지시 (content 가 스크롤/캡처 루프를 주도)
  chrome.tabs.sendMessage(tab.id, { type: 'FULLSHOT_START', mode });
  return { ok: true };
}

// 메시지 라우팅
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'FULLSHOT_CAPTURE_REQUEST') {
    // popup 에서 옴
    startCapture(msg.mode).then(sendResponse);
    return true; // async
  }

  // 이하 메시지는 content script(대상 탭)에서 옴
  const tabId = sender.tab && sender.tab.id;

  if (msg.type === 'CAPTURE_TILE') {
    const session = sessions.get(tabId);
    if (!session) {
      sendResponse({ ok: false, error: 'no session' });
      return false;
    }
    throttledCapture(session.windowId)
      .then((dataUrl) => {
        session.tiles.push({ x: msg.x, y: msg.y, dataUrl });
        sendResponse({ ok: true });
      })
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true; // async
  }

  if (msg.type === 'CAPTURE_FINISH') {
    const session = sessions.get(tabId);
    if (!session) {
      sendResponse({ ok: false, error: 'no session' });
      return false;
    }
    session.meta = msg.meta;
    openEditor(session)
      .then(() => {
        sessions.delete(tabId);
        sendResponse({ ok: true });
      })
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true; // async
  }

  if (msg.type === 'CAPTURE_ABORT') {
    sessions.delete(tabId);
    sendResponse({ ok: true });
    return false;
  }
});
