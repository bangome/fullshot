// FullShot - content script (대상 페이지에 주입)
// 페이지 측정 · 스크롤 시퀀스 · 고정요소 처리 · 영역선택 오버레이

(() => {
  // 중복 주입 가드 (executeScript 가 여러 번 실행돼도 리스너 1개만)
  if (window.__FULLSHOT_INJECTED__) return;
  window.__FULLSHOT_INJECTED__ = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nextFrame = () =>
    new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  function send(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (resp) => resolve(resp));
    });
  }

  // 페이지 전체 크기 측정 (CSS px)
  function measurePage() {
    const de = document.documentElement;
    const body = document.body;
    const width = de.clientWidth; // 스크롤바 제외 viewport 폭
    const height = Math.max(
      de.scrollHeight,
      de.offsetHeight,
      body ? body.scrollHeight : 0,
      body ? body.offsetHeight : 0
    );
    return { width, height };
  }

  // scroll-behavior: smooth 인 페이지에서도 즉시 이동 (애니메이션 중 캡처 방지)
  function scrollToInstant(x, y) {
    window.scrollTo({ left: x, top: y, behavior: 'instant' });
  }

  // fixed / sticky 요소 수집 (헤더/배너 중복 방지용)
  // fixed 는 화면 위쪽/아래쪽 중 어디에 붙어 있는지(anchor)도 기록한다.
  function collectPinnedElements(viewportH) {
    const result = [];
    const all = document.body ? document.body.getElementsByTagName('*') : [];
    for (const el of all) {
      const pos = getComputedStyle(el).position;
      if (pos === 'fixed') {
        const rect = el.getBoundingClientRect();
        const anchor = rect.top >= viewportH / 2 ? 'bottom' : 'top';
        result.push({ el, kind: 'fixed', anchor, saved: {} });
      } else if (pos === 'sticky') {
        result.push({ el, kind: 'sticky', saved: {} });
      }
    }
    return result;
  }

  // 인라인 스타일을 !important 로 덮어쓰되, 원래 값은 최초 1회만 저장
  function overrideStyle(item, prop, value) {
    const s = item.el.style;
    if (!(prop in item.saved)) {
      item.saved[prop] = [s.getPropertyValue(prop), s.getPropertyPriority(prop)];
    }
    s.setProperty(prop, value, 'important');
  }

  function restoreProp(item, prop) {
    if (!(prop in item.saved)) return;
    const [value, priority] = item.saved[prop];
    if (value) item.el.style.setProperty(prop, value, priority);
    else item.el.style.removeProperty(prop);
    delete item.saved[prop];
  }

  function restoreStyles(list) {
    for (const item of list) {
      for (const prop of Object.keys(item.saved)) restoreProp(item, prop);
    }
  }

  // sticky 요소를 원래 흐름 위치에 고정시킨다. 레이아웃 공간은 그대로라
  // 페이지 높이는 변하지 않고, 내용은 제자리에 정확히 한 번만 찍힌다.
  function neutralizeSticky(list) {
    for (const item of list) {
      if (item.kind !== 'sticky') continue;
      overrideStyle(item, 'position', 'relative');
      for (const side of ['top', 'right', 'bottom', 'left']) {
        overrideStyle(item, side, 'auto');
      }
    }
  }

  // fixed 요소: 위쪽에 붙은 것은 첫 타일에만, 아래쪽에 붙은 것은 마지막 타일에만 표시
  function setFixedVisibility(list, showTop, showBottom) {
    for (const item of list) {
      if (item.kind !== 'fixed') continue;
      const visible = item.anchor === 'top' ? showTop : showBottom;
      if (visible) restoreProp(item, 'visibility');
      else overrideStyle(item, 'visibility', 'hidden');
    }
  }

  // 스크롤 후 안정화 대기
  async function settle(delay) {
    await nextFrame();
    await sleep(delay);
  }

  // 무한 스크롤 페이지에서 프리로드가 끝나지 않는 것을 막는 상한 (화면 수)
  const MAX_PRELOAD_STEPS = 100;

  // lazy-load 콘텐츠 강제 로드: 끝까지 빠르게 스크롤 후 top 복귀.
  // 스크롤 중 페이지가 늘어날 수 있으므로 매 단계 높이를 다시 측정한다.
  async function preloadLazyContent(viewportH) {
    let y = 0;
    for (let i = 0; i < MAX_PRELOAD_STEPS; i++) {
      scrollToInstant(0, y);
      await sleep(40);
      if (y + viewportH >= measurePage().height) break;
      y += viewportH;
    }
    scrollToInstant(0, 0);
    await sleep(150);
  }

  // 공통 캡처 루프: yStart ~ yEnd 구간을 viewport 높이만큼 스크롤하며 캡처
  // origin 기준은 호출자가 meta 로 전달
  async function captureBand(yStart, yEnd, viewportH, pinned, captureDelay) {
    const positions = [];
    for (let y = yStart; y < yEnd; y += viewportH) positions.push(y);
    if (positions.length === 0) positions.push(yStart);

    for (let i = 0; i < positions.length; i++) {
      scrollToInstant(0, positions[i]);
      await settle(captureDelay);
      const actualY = window.scrollY;
      const actualX = window.scrollX;

      // 위쪽 고정요소는 첫 타일, 아래쪽 고정요소는 마지막 타일에만 표시
      setFixedVisibility(pinned, i === 0, i === positions.length - 1);
      await nextFrame();

      const resp = await send({ type: 'CAPTURE_TILE', x: actualX, y: actualY });
      if (!resp || !resp.ok) {
        throw new Error(resp ? resp.error : '캡처 응답 없음');
      }
    }
  }

  async function doFullPage(captureDelay) {
    const original = { x: window.scrollX, y: window.scrollY };
    const viewportH = window.innerHeight;
    const dpr = window.devicePixelRatio || 1;
    let pinned = [];
    let size;

    try {
      await preloadLazyContent(viewportH);
      // 프리로드로 추가된 요소·늘어난 높이를 반영하도록 프리로드 이후에 수집/측정
      pinned = collectPinnedElements(viewportH);
      neutralizeSticky(pinned);
      await nextFrame();
      size = measurePage();
      await captureBand(0, size.height, viewportH, pinned, captureDelay);
    } finally {
      restoreStyles(pinned);
      scrollToInstant(original.x, original.y);
    }

    return {
      dpr,
      viewportW: size.width,
      viewportH,
      originX: 0,
      originY: 0,
      canvasWidth: size.width,
      canvasHeight: size.height,
      mode: 'full',
    };
  }

  async function doVisible() {
    const dpr = window.devicePixelRatio || 1;
    const width = document.documentElement.clientWidth;
    const viewportH = window.innerHeight;
    const x = window.scrollX;
    const y = window.scrollY;

    const resp = await send({ type: 'CAPTURE_TILE', x, y });
    if (!resp || !resp.ok) throw new Error(resp ? resp.error : '캡처 응답 없음');

    return {
      dpr,
      viewportW: width,
      viewportH,
      originX: x,
      originY: y,
      canvasWidth: width,
      canvasHeight: viewportH,
      mode: 'visible',
    };
  }

  // 오버레이 스타일을 페이지에 1회 주입 (동적 주입 방식이라 CSS 파일 미적용)
  function ensureOverlayStyle() {
    if (document.getElementById('fullshot-style')) return;
    const style = document.createElement('style');
    style.id = 'fullshot-style';
    style.textContent = `
      .fullshot-overlay{position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgba(0,0,0,.25)}
      .fullshot-selection{position:fixed;display:none;border:2px dashed #4f8cff;background:rgba(79,140,255,.15)}
      .fullshot-hint{position:fixed;top:16px;left:50%;transform:translateX(-50%);background:#1f2937;color:#fff;padding:8px 14px;border-radius:8px;font:13px/1.4 system-ui,sans-serif}
    `;
    document.documentElement.appendChild(style);
  }

  // 영역 선택 오버레이: 드래그한 사각형(document 좌표) 반환
  function selectArea() {
    ensureOverlayStyle();
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'fullshot-overlay';
      const box = document.createElement('div');
      box.className = 'fullshot-selection';
      const hint = document.createElement('div');
      hint.className = 'fullshot-hint';
      hint.textContent = '드래그하여 영역을 선택하세요 · ESC 취소';
      overlay.appendChild(box);
      overlay.appendChild(hint);
      document.documentElement.appendChild(overlay);

      let startX = 0, startY = 0, dragging = false;

      function cleanup() {
        overlay.remove();
        document.removeEventListener('keydown', onKey, true);
      }
      function onKey(e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          cleanup();
          resolve(null);
        }
      }
      document.addEventListener('keydown', onKey, true);

      overlay.addEventListener('mousedown', (e) => {
        dragging = true;
        startX = e.clientX;
        startY = e.clientY;
        box.style.left = startX + 'px';
        box.style.top = startY + 'px';
        box.style.width = '0px';
        box.style.height = '0px';
        box.style.display = 'block';
      });
      overlay.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const x = Math.min(e.clientX, startX);
        const y = Math.min(e.clientY, startY);
        const w = Math.abs(e.clientX - startX);
        const h = Math.abs(e.clientY - startY);
        box.style.left = x + 'px';
        box.style.top = y + 'px';
        box.style.width = w + 'px';
        box.style.height = h + 'px';
      });
      overlay.addEventListener('mouseup', (e) => {
        if (!dragging) return;
        dragging = false;
        const left = Math.min(e.clientX, startX);
        const top = Math.min(e.clientY, startY);
        const w = Math.abs(e.clientX - startX);
        const h = Math.abs(e.clientY - startY);
        cleanup();
        if (w < 5 || h < 5) {
          resolve(null);
          return;
        }
        // viewport 좌표 -> document 좌표
        resolve({
          x: left + window.scrollX,
          y: top + window.scrollY,
          w,
          h,
        });
      });
    });
  }

  async function doArea() {
    const rect = await selectArea();
    if (!rect) return null; // 취소

    const viewportH = window.innerHeight;
    const dpr = window.devicePixelRatio || 1;
    const width = document.documentElement.clientWidth;

    // 선택 영역은 항상 현재 화면 안에 있으므로 스크롤·고정요소 조작 없이
    // 보이는 그대로 한 장만 찍는다. 오버레이가 지워진 프레임을 기다린다.
    await nextFrame();
    const resp = await send({
      type: 'CAPTURE_TILE',
      x: window.scrollX,
      y: window.scrollY,
    });
    if (!resp || !resp.ok) throw new Error(resp ? resp.error : '캡처 응답 없음');

    return {
      dpr,
      viewportW: width,
      viewportH,
      originX: rect.x,
      originY: rect.y,
      canvasWidth: rect.w,
      canvasHeight: rect.h,
      mode: 'area',
    };
  }

  async function run(mode) {
    // 설정에서 캡처 지연 읽기
    let captureDelay = 200;
    try {
      const cfg = await chrome.storage.sync.get({ scrollDelay: 200 });
      captureDelay = cfg.scrollDelay;
    } catch (_) {}

    let meta = null;
    try {
      if (mode === 'full') meta = await doFullPage(captureDelay);
      else if (mode === 'visible') meta = await doVisible();
      else if (mode === 'area') meta = await doArea();
    } catch (e) {
      await send({ type: 'CAPTURE_ABORT' });
      alert('FullShot 캡처 실패: ' + e.message);
      return;
    }

    if (!meta) {
      await send({ type: 'CAPTURE_ABORT' }); // 사용자 취소
      return;
    }
    await send({ type: 'CAPTURE_FINISH', meta });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'FULLSHOT_START') {
      run(msg.mode);
    }
  });
})();
