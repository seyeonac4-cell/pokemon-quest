/* ============================================================
   pwa-install.js  —  「📲 앱으로 설치」 한 번 누르기 버튼 (14개 앱 공통)
   ------------------------------------------------------------
   · 브라우저가 beforeinstallprompt 를 보내면 화면 구석에 작은 알약 버튼을 띄운다.
   · 버튼을 누르면 브라우저 설치 창이 바로 뜬다 (⋮ 메뉴에서 찾을 필요 없음).
   · 이미 앱으로 설치되어 실행 중(standalone)이면 절대 뜨지 않는다.
   · × 를 누르면 그 앱에서는 7일 동안 다시 뜨지 않는다.
   ============================================================ */
(function () {
  'use strict';

  if (window.__pwaInstallReady) return;   // 두 번 불러와도 한 번만
  window.__pwaInstallReady = true;

  var DAY = 86400000;
  var DISMISS_DAYS = 7;
  var INSTALLED_DAYS = 30;

  /* ---------- 저장소 (막혀 있어도 조용히 넘어감) ---------- */
  var mem = {};

  function readNum(key) {
    try {
      var v = window.localStorage.getItem(key);
      if (v !== null) return Number(v) || 0;
    } catch (e) {}
    return mem[key] || 0;
  }

  function writeNum(key, val) {
    mem[key] = val;
    try { window.localStorage.setItem(key, String(val)); } catch (e) {}
  }

  /* 앱마다 따로 기억 (모두 같은 주소 안에 있어도 파일 이름으로 구분) */
  var pageKey = (function () {
    var name = (location.pathname.split('/').pop() || 'index.html');
    return name.replace(/[^0-9a-zA-Z._-]/g, '_');
  })();
  var K_DISMISS = 'pwaInstall.dismiss.' + pageKey;
  var K_INSTALLED = 'pwaInstall.installed.' + pageKey;

  /* ---------- 상태 확인 ---------- */
  function isStandalone() {
    try {
      if (window.navigator.standalone === true) return true;
      var q = window.matchMedia;
      if (!q) return false;
      if (q('(display-mode: standalone)').matches) return true;
      if (q('(display-mode: fullscreen)').matches) return true;
      if (q('(display-mode: window-controls-overlay)').matches) return true;
    } catch (e) {}
    return false;
  }

  function isQuiet() {
    var now = Date.now();
    var d = readNum(K_DISMISS);
    if (d && now - d < DISMISS_DAYS * DAY) return true;
    var i = readNum(K_INSTALLED);
    if (i && now - i < INSTALLED_DAYS * DAY) return true;
    return false;
  }

  /* ---------- 꾸미기 ---------- */
  var style = null;
  var bar = null;
  var toastEl = null;
  var toastTimer = 0;
  var deferred = null;
  var quietThisPage = false;
  var shown = false;

  function addStyle() {
    if (style || !document.head) return;
    style = document.createElement('style');
    style.id = 'pwaInstallStyle';
    style.textContent = [
      '#pwaInstallBar{',
      ' position:fixed;right:calc(12px + env(safe-area-inset-right,0px));',
      ' bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:45;',
      ' display:flex;align-items:center;gap:1px;padding:3px 4px 3px 4px;border-radius:999px;',
      ' background:linear-gradient(150deg,#ffffff 0%,#eef4ff 100%);border:2px solid #a8c8ff;',
      ' box-shadow:0 8px 22px rgba(30,42,68,.22);font-family:inherit;',
      ' opacity:0;transform:translateY(12px);pointer-events:none;',
      ' transition:opacity .28s ease,transform .28s ease,bottom .2s ease;',
      ' -webkit-tap-highlight-color:transparent}',
      '#pwaInstallBar.on{opacity:1;transform:translateY(0);pointer-events:auto}',
      '#pwaInstallBar .pi-go{',
      ' border:0;background:transparent;display:flex;align-items:center;gap:6px;',
      ' padding:7px 9px 7px 7px;border-radius:999px;font-family:inherit;',
      ' font-size:13px;font-weight:900;letter-spacing:-.02em;line-height:1.1;',
      ' color:#26406f;cursor:pointer;white-space:nowrap}',
      '#pwaInstallBar .pi-go:active{transform:scale(.96)}',
      '#pwaInstallBar .pi-ico{font-size:15px;line-height:1}',
      '#pwaInstallBar .pi-x{',
      ' border:0;background:#e8effd;color:#5a6f97;width:23px;height:23px;border-radius:999px;',
      ' font-family:inherit;font-size:14px;font-weight:900;line-height:1;padding:0;',
      ' display:flex;align-items:center;justify-content:center;cursor:pointer;flex:0 0 auto}',
      '#pwaInstallBar .pi-x:active{background:#d7e3f8}',
      '#pwaInstallToast{',
      ' position:fixed;left:50%;bottom:calc(22px + env(safe-area-inset-bottom,0px));z-index:46;',
      ' transform:translate(-50%,14px);opacity:0;pointer-events:none;',
      ' background:rgba(26,34,54,.94);color:#fff;font-family:inherit;font-size:12.5px;',
      ' font-weight:800;line-height:1.45;letter-spacing:-.01em;padding:11px 16px;border-radius:16px;',
      ' max-width:min(86vw,340px);text-align:center;box-shadow:0 10px 26px rgba(20,28,46,.26);',
      ' transition:opacity .25s ease,transform .25s ease}',
      '#pwaInstallToast.on{opacity:1;transform:translate(-50%,0)}',
      '@media print{#pwaInstallBar,#pwaInstallToast{display:none!important}}',
      '@media (prefers-reduced-motion:reduce){#pwaInstallBar,#pwaInstallToast{transition:none}}'
    ].join('');
    document.head.appendChild(style);
  }

  /* 하단에 이미 붙어 있는 것들(사용시간 알약, 인쇄 바 등)과 겹치지 않게 위로 올린다 */
  function place() {
    if (!bar) return;
    var vh = window.innerHeight || 800;
    var rect = bar.getBoundingClientRect();
    var lift = 0;

    var all = document.body ? document.body.getElementsByTagName('*') : [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el === bar || el === toastEl || (bar.contains && bar.contains(el))) continue;
      var cs;
      try { cs = window.getComputedStyle(el); } catch (e) { continue; }
      if (!cs) continue;
      var pos = cs.position;
      if (pos !== 'fixed' && pos !== 'sticky') continue;
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      if (cs.opacity === '0') continue;
      var r = el.getBoundingClientRect();
      if (r.width < 12 || r.height < 12) continue;
      if (r.height > vh * 0.5) continue;             // 화면 전체 배경/오버레이는 무시
      if (r.bottom < vh - 44 || r.top > vh) continue;  // 바닥에 붙은 것만
      if (r.right < rect.left - 4 || r.left > rect.right + 4) continue;  // 좌우로 안 겹치면 무시
      var need = vh - r.top + 8;
      if (need > lift) lift = need;
    }

    var cap = Math.round(vh * 0.45);
    if (lift > cap) lift = cap;
    if (lift < 24) lift = 0;

    bar.style.bottom = lift
      ? 'calc(' + Math.round(lift) + 'px + env(safe-area-inset-bottom,0px))'
      : 'calc(12px + env(safe-area-inset-bottom,0px))';
  }

  function buildBar() {
    if (bar || !document.body) return;
    addStyle();

    bar = document.createElement('div');
    bar.id = 'pwaInstallBar';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', '앱으로 설치');

    var go = document.createElement('button');
    go.type = 'button';
    go.className = 'pi-go';
    go.innerHTML = '<span class="pi-ico" aria-hidden="true">\uD83D\uDCF2</span>앱으로 설치';

    var x = document.createElement('button');
    x.type = 'button';
    x.className = 'pi-x';
    x.setAttribute('aria-label', '설치 안내 닫기');
    x.textContent = '\u00D7';

    go.addEventListener('click', onInstallClick);
    x.addEventListener('click', onCloseClick);

    bar.appendChild(go);
    bar.appendChild(x);
    document.body.appendChild(bar);

    /* 화면이 작거나 이상한 경우 한 번 더 자리 계산 */
    window.addEventListener('resize', function () { if (shown) place(); });
    window.addEventListener('orientationchange', function () { setTimeout(function () { if (shown) place(); }, 320); });
  }

  function toast(msg) {
    if (!document.body) return;
    addStyle();
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.id = 'pwaInstallToast';
      toastEl.setAttribute('role', 'status');
      toastEl.setAttribute('aria-live', 'polite');
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    // 강제 리플로우 후 표시
    void toastEl.offsetWidth;
    toastEl.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('on'); }, 4600);
  }

  function hide() {
    shown = false;
    if (bar) bar.classList.remove('on');
  }

  function show() {
    if (!deferred || quietThisPage) return;
    if (isStandalone() || isQuiet()) return;
    buildBar();
    if (!bar) return;
    shown = true;
    place();
    // 레이아웃이 잡힌 뒤 부드럽게 등장
    requestAnimationFrame(function () {
      if (!shown) return;
      bar.classList.add('on');
      place();
    });
  }

  /* ---------- 버튼 동작 ---------- */
  function onInstallClick() {
    if (!deferred) { hide(); return; }
    var ev = deferred;
    deferred = null;
    hide();
    try {
      ev.prompt();
    } catch (e) {
      quietThisPage = true;
      return;
    }
    if (ev.userChoice && typeof ev.userChoice.then === 'function') {
      ev.userChoice.then(function (res) {
        if (res && res.outcome === 'accepted') {
          writeNum(K_INSTALLED, Date.now());
          hide();
          toast('앱이 설치 중이에요! 잠시 후 홈 화면이나 전체 앱 목록을 확인해 보세요.');
        } else {
          /* 설치 창을 그냥 닫은 경우: 이번 화면에서는 조용히 */
          quietThisPage = true;
          hide();
        }
      }).catch(function () {
        quietThisPage = true;
        hide();
      });
    }
  }

  function onCloseClick() {
    writeNum(K_DISMISS, Date.now());
    hide();
  }

  /* ---------- 브라우저 신호 ---------- */
  window.addEventListener('beforeinstallprompt', function (e) {
    if (isStandalone()) return;          // 이미 앱으로 열려 있으면 아무것도 안 함
    e.preventDefault();
    deferred = e;
    show();
  });

  window.addEventListener('appinstalled', function () {
    writeNum(K_INSTALLED, Date.now());
    deferred = null;
    hide();
  });

  try {
    var mq = window.matchMedia('(display-mode: standalone)');
    var onChange = function () { if (mq.matches) { deferred = null; hide(); } };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  } catch (e) {}
})();
