/* ============================================================
   ⏳ 채씨네 놀이 월드 공용 놀이 시간 제한 (2026-11-22)
   ------------------------------------------------------------
   block-world.html · grow-garden.html · dress-up.html
   세 게임이 이 파일 하나를 같이 써요.

   규칙
    · 윤진 · 형원 : 세 게임을 합쳐서 20분 놀면 → 30분 쉬기(잠금)
                    → 30분이 지나면 자동으로 다시 20분이 열려요.
    · 엄마 · 아빠 : 제한 없이 마음껏.

   왜 세 게임이 같이 줄어드나요?
    세 게임 모두 같은 주소(seyeonac4-cell.github.io) 아래 있어서
    localStorage 를 함께 써요. 그래서 블록 월드에서 10분 놀고
    그로우 어 가든으로 넘어가면 남은 10분부터 이어서 줄어요.
    (게임마다 따로 세면 세 게임 × 20분이 되어 버리니까요!)

   사람 알아보기
    ?who= → 이 기기에서 마지막에 고른 아이(lim_active_kid) → 없으면 윤진
    (게임 안에서 캐릭터를 바꾸면 1초 안에 그 아이 기준으로 바뀝니다)

   테스트
    ?timertest=1            테스트용 저장칸(wt1:test:)을 써서 진짜 기록은 안 건드려요
    &wtlimit=8&wtcd=10      20분/30분 대신 8초/10초로 빠르게
    &wtleft=5               남은 시간을 5초로 맞춰 놓고 시작
    &wtwho=hyungwon         그 아이로 고정
    &wtreset=1              시작할 때 기록 지우기
    window.__WT            콘솔에서 set / grant / lockNow / reset / state
   ============================================================ */
(function () {
  'use strict';
  if (window.__WT && window.__WT.version) return;   /* 두 번 불러도 한 번만 */

  var VERSION = '1.0';
  var LIMIT_DEFAULT = 20 * 60;      /* 20분 놀이 */
  var COOLDOWN_DEFAULT = 30 * 60;   /* 30분 쉬기 */
  var ADULT_SPAN = 3 * 60 * 60 * 1000;  /* 보호자가 열어 준 '제한 없음'은 3시간까지만 */

  var KIDS = {
    yunjin:  { name: '윤진', emo: '🦊' },
    hyungwon:{ name: '형원', emo: '🐣' }
  };
  var ADULTS = { mom: '엄마', dad: '아빠' };

  /* ---------- 주소창 옵션 ---------- */
  var Q = null;
  try { Q = new URLSearchParams(location.search || ''); } catch (e) { Q = null; }
  function qp(k) { try { return Q ? Q.get(k) : null; } catch (e) { return null; } }
  function qnum(k, d) {
    var v = parseFloat(qp(k));
    return (isFinite(v) && v >= 0) ? v : d;
  }

  var TEST = (qp('timertest') === '1') || (qp('wttest') === '1');
  var NS = TEST ? 'wt1:test:' : 'wt1:';
  var LIMIT = Math.round(qnum('wtlimit', LIMIT_DEFAULT));
  var COOLDOWN = Math.round(qnum('wtcd', COOLDOWN_DEFAULT));
  if (LIMIT < 1) LIMIT = LIMIT_DEFAULT;
  if (COOLDOWN < 1) COOLDOWN = COOLDOWN_DEFAULT;
  var FORCE_WHO = normWho(qp('wtwho'));

  /* ---------- 이름 정리 (게임마다 표기가 조금씩 달라요) ---------- */
  function normWho(v) {
    if (!v) return null;
    v = String(v).trim().toLowerCase();
    if (v === 'yunjin' || v === '윤진') return 'yunjin';
    if (v === 'hyungwon' || v === 'hyeongwon' || v === '형원') return 'hyungwon';
    if (v === 'mom' || v === '엄마') return 'mom';
    if (v === 'dad' || v === '아빠') return 'dad';
    return null;
  }
  function whoFromUrl() {
    try {
      var v = normWho(qp('who'));
      if (!v) v = normWho((location.hash || '').replace('#', ''));
      return v;
    } catch (e) { return null; }
  }
  function whoFromStore() {
    try { return normWho(localStorage.getItem('lim_active_kid')); } catch (e) { return null; }
  }
  function isKid(k) { return !!KIDS[k]; }
  function isAdult(k) { return !!ADULTS[k]; }

  /* ---------- 저장 ---------- */
  /* 아이 한 명당 한 칸: u=쓴 초, l=이번에 열린 한도(초), lock=잠금이 풀리는 시각 */
  function stateKey(k) { return NS + 'kid:' + k; }
  function readState(k) {
    try {
      var raw = localStorage.getItem(stateKey(k));
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o || typeof o.u !== 'number') return null;
      return {
        u: Math.max(0, o.u || 0),
        l: (o.l > 0 ? o.l : LIMIT),
        lock: (o.lock || 0),
        c: (o.c || Date.now())
      };
    } catch (e) { return null; }
  }
  function writeState(k, s) {
    try {
      var u = s.u, lock = s.lock || 0;
      var prev = readState(k);
      /* 두 탭이 같은 아이 기록을 같이 보고 있어도, 더 많이 쓴 쪽/더 늦게 잠긴 쪽을 남겨요 */
      if (prev && prev.c === s.c) {
        if (prev.u > u) u = prev.u;
        if ((prev.lock || 0) > lock) lock = prev.lock;
        if (prev.l > s.l) s.l = prev.l;
      }
      localStorage.setItem(stateKey(k), JSON.stringify({ u: Math.round(u * 10) / 10, l: s.l, lock: lock, c: s.c || Date.now() }));
    } catch (e) { }
  }
  function freshState() { return { u: 0, l: LIMIT, lock: 0, c: Date.now() }; }

  /* 보호자가 '엄마·아빠로 전환'한 기록 (3시간) */
  function readAdult() {
    try {
      var o = JSON.parse(localStorage.getItem(NS + 'adult') || 'null');
      if (!o || !o.until || o.until < Date.now()) return null;
      return o;
    } catch (e) { return null; }
  }
  function writeAdult(v) {
    try {
      if (!v) localStorage.removeItem(NS + 'adult');
      else localStorage.setItem(NS + 'adult', JSON.stringify(v));
    } catch (e) { }
  }

  /* ---------- 지금 노는 사람 ---------- */
  var who = null;
  var st = null;
  var lastTs = Date.now();
  var lastShownSec = -1;
  var adultMode = null;

  function detectWho() {
    if (FORCE_WHO) return FORCE_WHO;
    return whoFromStore() || whoFromUrl() || 'yunjin';
  }
  function loadFor(k) {
    var s = readState(k);
    if (!s) s = freshState();
    /* 30분 쉬기가 끝났으면 새 20분 */
    if (s.lock && Date.now() >= s.lock) { s = freshState(); writeState(k, s); }
    return s;
  }

  /* ---------- 화면 그리기 ---------- */
  var badge = null, lockEl = null, toastEl = null, toastTimer = 0;

  function css(el, o) { for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) el.style[k] = o[k]; }

  function ensureBadge() {
    if (badge && badge.parentNode) return badge;
    if (!document.body) return null;
    badge = document.createElement('div');
    badge.id = 'wt-badge';
    badge.setAttribute('role', 'status');
    badge.setAttribute('aria-live', 'off');
    css(badge, {
      position: 'fixed',
      left: '50%',
      bottom: 'calc(26px + env(safe-area-inset-bottom, 0px))',
      transform: 'translateX(-50%)',
      zIndex: '2147483000',
      display: 'flex', alignItems: 'center', gap: '4px',
      padding: '4px 10px 5px',
      borderRadius: '999px',
      background: 'rgba(255,255,255,.88)',
      color: '#5B2A7E',
      border: '1px solid rgba(120,60,160,.20)',
      boxShadow: '0 3px 10px rgba(60,20,90,.20)',
      font: '800 11.5px/1 -apple-system, BlinkMacSystemFont, "Pretendard Variable", "Segoe UI", system-ui, sans-serif',
      letterSpacing: '-.02em',
      fontVariantNumeric: 'tabular-nums',
      pointerEvents: 'none',
      userSelect: 'none',
      WebkitUserSelect: 'none',
      whiteSpace: 'nowrap',
      transition: 'background .25s, color .25s, opacity .25s'
    });
    document.body.appendChild(badge);
    return badge;
  }

  function fmt(sec) {
    sec = Math.max(0, Math.round(sec));
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + (s < 10 ? '0' + s : s);
  }

  function showBadge(text, warn) {
    var b = ensureBadge();
    if (!b) return;
    if (b.textContent !== text) b.textContent = text;
    if (warn) { b.style.background = 'rgba(255,238,238,.95)'; b.style.color = '#C62828'; b.style.borderColor = 'rgba(198,40,40,.25)'; }
    else { b.style.background = 'rgba(255,255,255,.88)'; b.style.color = '#5B2A7E'; b.style.borderColor = 'rgba(120,60,160,.20)'; }
    b.style.display = 'flex';
  }
  function hideBadge() { if (badge) badge.style.display = 'none'; }

  function toast(msg) {
    if (!document.body) return;
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.id = 'wt-toast';
      css(toastEl, {
        position: 'fixed', left: '50%', bottom: 'calc(52px + env(safe-area-inset-bottom, 0px))',
        transform: 'translateX(-50%)', zIndex: '2147483001',
        padding: '10px 16px', borderRadius: '14px',
        background: 'rgba(60,25,95,.94)', color: '#fff',
        font: '800 13px/1.25 -apple-system, BlinkMacSystemFont, "Pretendard Variable", system-ui, sans-serif',
        boxShadow: '0 8px 22px rgba(40,10,70,.3)',
        pointerEvents: 'none', opacity: '0', transition: 'opacity .25s',
        maxWidth: '86vw', textAlign: 'center'
      });
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { if (toastEl) toastEl.style.opacity = '0'; }, 2400);
  }

  /* ---------- 잠금 화면 ---------- */
  function ensureLock() {
    if (lockEl && lockEl.parentNode) return lockEl;
    if (!document.body) return null;
    if (!document.getElementById('wt-style')) {
      var stc = document.createElement('style');
      stc.id = 'wt-style';
      stc.textContent = [
        '#wt-lock *{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,"Pretendard Variable","Segoe UI",system-ui,sans-serif}',
        '#wt-lock{position:fixed;inset:0;z-index:2147483001;display:flex;align-items:center;justify-content:center;padding:20px;',
        'background:radial-gradient(120% 85% at 50% 0%,#7B57B8 0%,#553187 42%,#2E1854 100%);color:#fff;',
        '-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);overflow:auto;animation:wtin .28s ease both}',
        '@keyframes wtin{from{opacity:0}to{opacity:1}}',
        '#wt-lock .wt-card{width:100%;max-width:352px;text-align:center;padding:26px 20px 22px;border-radius:26px;',
        'background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.28);',
        'box-shadow:0 18px 50px rgba(10,0,30,.38),inset 0 1px 0 rgba(255,255,255,.28)}',
        '#wt-lock .wt-emo{font-size:52px;line-height:1;filter:drop-shadow(0 6px 14px rgba(0,0,0,.28));animation:wtbob 2.4s ease-in-out infinite}',
        '@keyframes wtbob{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}',
        '#wt-lock .wt-who{margin-top:10px;font-size:12.5px;font-weight:800;letter-spacing:-.01em;color:rgba(255,255,255,.78)}',
        '#wt-lock h2{margin-top:6px;font-size:19px;line-height:1.35;font-weight:900;letter-spacing:-.03em}',
        '#wt-lock .wt-sub{margin-top:6px;font-size:14px;line-height:1.4;font-weight:700;color:rgba(255,255,255,.88)}',
        '#wt-lock .wt-count{margin:16px auto 0;display:inline-block;padding:10px 22px 12px;border-radius:18px;',
        'background:rgba(255,255,255,.94);color:#4A2378;font-size:40px;font-weight:900;line-height:1;letter-spacing:-.02em;',
        'font-variant-numeric:tabular-nums;box-shadow:0 10px 24px rgba(20,0,40,.28)}',
        '#wt-lock .wt-after{margin-top:8px;font-size:13px;font-weight:800;color:rgba(255,255,255,.9)}',
        '#wt-lock .wt-btns{margin-top:20px;display:flex;flex-direction:column;gap:9px}',
        '#wt-lock button{width:100%;min-height:50px;border:0;border-radius:16px;font-family:inherit;font-size:14.5px;font-weight:900;',
        'letter-spacing:-.02em;cursor:pointer;-webkit-tap-highlight-color:transparent;transition:transform .08s}',
        '#wt-lock button:active{transform:scale(.975)}',
        '#wt-lock .wt-adult{background:rgba(255,255,255,.16);color:#fff;border:1.5px solid rgba(255,255,255,.5)}',
        '#wt-lock .wt-grant{background:linear-gradient(180deg,#FFD86B,#FFB93F);color:#5B3400;box-shadow:0 8px 18px rgba(120,70,0,.3)}',
        '#wt-lock .wt-mini{background:none;color:rgba(255,255,255,.72);font-size:12.5px;font-weight:800;min-height:34px}',
        '#wt-lock .wt-pin-note{margin-top:14px;font-size:11.5px;font-weight:700;color:rgba(255,255,255,.6);line-height:1.4}',
        '#wt-lock .wt-pinbox{display:flex;gap:8px;margin-top:14px}',
        '#wt-lock input{flex:1;min-width:0;height:52px;border:2px solid rgba(255,255,255,.42);border-radius:14px;',
        'background:rgba(255,255,255,.95);color:#3A1A5E;font-family:inherit;font-size:22px;font-weight:900;line-height:1;text-align:center;letter-spacing:.32em;padding-left:.32em}',
        '#wt-lock input::placeholder{font-size:12.5px;letter-spacing:0;color:#9B8BB4;padding-left:0}',
        '#wt-lock input:focus{outline:none;border-color:#FFD86B;box-shadow:0 0 0 3px rgba(255,216,107,.35)}',
        '#wt-lock .wt-pin-ok{width:88px;min-height:52px;background:#fff;color:#4A2378}',
        '#wt-lock .wt-err{min-height:16px;margin-top:8px;font-size:12px;font-weight:800;color:#FFC9C9}',
        '#wt-lock .wt-shake{animation:wtshake .3s}',
        '@keyframes wtshake{0%,100%{transform:translateX(0)}25%{transform:translateX(-6px)}75%{transform:translateX(6px)}}',
        '@media (max-width:360px){#wt-lock h2{font-size:17.5px}#wt-lock .wt-count{font-size:34px;padding:9px 18px 10px}}'
      ].join('');
      (document.head || document.documentElement).appendChild(stc);
    }
    lockEl = document.createElement('div');
    lockEl.id = 'wt-lock';
    lockEl.setAttribute('role', 'dialog');
    lockEl.setAttribute('aria-modal', 'true');
    document.body.appendChild(lockEl);
    return lockEl;
  }

  function card(msg) {
    var el = ensureLock();
    if (!el) return null;
    el.innerHTML = '<div class="wt-card">' + msg + '</div>';
    return el;
  }

  function renderLock() {
    hideBadge();
    var kid = KIDS[who] || { name: '우리 아이', emo: '🐣' };
    var el = card(
      '<div class="wt-emo">⏰</div>' +
      '<div class="wt-who">' + kid.emo + ' ' + kid.name + ' · 놀이 시간 20분</div>' +
      '<h2>20분 놀이 시간이 끝났어요!</h2>' +
      '<div class="wt-sub">눈 좀 쉬고 물 마시고 와요 💧</div>' +
      '<div class="wt-count" id="wt-count">30:00</div>' +
      '<div class="wt-after">뒤에 다시 놀 수 있어요!</div>' +
      '<div class="wt-btns">' +
      '<button type="button" class="wt-adult" id="wt-adult">👩 엄마·👨 아빠로 전환</button>' +
      '<button type="button" class="wt-grant" id="wt-grant">🛡️ 보호자 20분 더 열어주기</button>' +
      '</div>' +
      '<div class="wt-pin-note">보호자(엄마·아빠)만 누를 수 있어요 · PIN 필요</div>'
    );
    if (!el) return;
    var bA = el.querySelector('#wt-adult'), bG = el.querySelector('#wt-grant');
    if (bA) bA.addEventListener('click', function (e) { e.preventDefault(); adultChooser(); });
    if (bG) bG.addEventListener('click', function (e) { e.preventDefault(); grantFlow(); });
    updateLock();
  }

  function updateLock() {
    var c = document.getElementById('wt-count');
    if (!c || !st) return;
    var left = Math.max(0, Math.ceil((st.lock - Date.now()) / 1000));
    var txt = fmt(left);
    if (c.textContent !== txt) c.textContent = txt;
  }

  function showLock() {
    hideBadge();
    if (!lockEl || !lockEl.parentNode) { renderLock(); return; }
  }
  function hideLock() {
    if (lockEl && lockEl.parentNode) lockEl.parentNode.removeChild(lockEl);
    lockEl = null;
  }

  /* ---------- 보호자 PIN ---------- */
  var FB_CFG = {
    apiKey: 'AIzaSyCy_TrcTcwRusSeQH4x3yrGv1bwzi7wBhI',
    authDomain: 'pokemon-quest-lim.firebaseapp.com',
    databaseURL: 'https://pokemon-quest-lim-default-rtdb.asia-southeast1.firebasedatabase.app',
    projectId: 'pokemon-quest-lim',
    storageBucket: 'pokemon-quest-lim.firebasestorage.app',
    messagingSenderId: '186869020161',
    appId: '1:186869020161:web:e3edcca0d1d2675d89f200'
  };
  function fbPin(onDone) {
    var done = false;
    function finish(v) { if (!done) { done = true; onDone(v); } }
    var fb = window.firebase;
    if (!fb || !fb.database) { finish(undefined); return; }
    var ref = null;
    try {
      var app = (fb.apps && fb.apps.length) ? fb.app() : fb.initializeApp(FB_CFG);
      ref = fb.database(app).ref('family-lim-7660/settings/pin');
    } catch (e) { finish(undefined); return; }
    var timer = setTimeout(function () { finish(undefined); }, 4000);
    try {
      ref.once('value').then(function (snap) {
        clearTimeout(timer);
        var v = snap && snap.val();
        if (v === null || v === undefined) v = '0000';   /* 포켓몬 퀘스트와 같은 기본 PIN */
        finish(String(v));
      }).catch(function () { clearTimeout(timer); finish(undefined); });
    } catch (e) { clearTimeout(timer); finish(undefined); }
  }
  function cachedPin() {
    try { var v = localStorage.getItem(NS + 'pin'); return v ? String(v) : null; } catch (e) { return null; }
  }
  function savePin(v) { try { localStorage.setItem(NS + 'pin', String(v)); } catch (e) { } }

  function askGuardian(title, onOk) {
    var el = card(
      '<div class="wt-emo">🛡️</div>' +
      '<h2>' + title + '</h2>' +
      '<div class="wt-sub" id="wt-pinlead">보호자 PIN 4자리를 눌러 주세요</div>' +
      '<div class="wt-pinbox" id="wt-pinbox"></div>' +
      '<div class="wt-err" id="wt-pinerr"></div>' +
      '<div class="wt-btns"><button type="button" class="wt-mini" id="wt-cancel">그만두기</button></div>'
    );
    if (!el) return;
    var cancel = el.querySelector('#wt-cancel');
    if (cancel) cancel.addEventListener('click', function (e) { e.preventDefault(); closeAsk(); });

    var box = el.querySelector('#wt-pinbox');
    var err = el.querySelector('#wt-pinerr');
    var lead = el.querySelector('#wt-pinlead');

    function closeAsk() { if (lockEl && lockEl.parentNode) { renderLock(); } }
    function fail(msg) {
      if (err) err.textContent = msg;
      if (box) { box.classList.remove('wt-shake'); void box.offsetWidth; box.classList.add('wt-shake'); }
    }
    function ok() { if (err) err.textContent = ''; onOk(); }

    fbPin(function (remote) {
      var pin = remote || cachedPin();
      if (pin) {
        pin = String(pin);
        if (remote) savePin(pin);
        if (lead) lead.textContent = '보호자 PIN 4자리를 눌러 주세요';
        box.innerHTML = '<input id="wt-pin" type="password" inputmode="numeric" maxlength="4" placeholder="PIN 4자리" aria-label="보호자 PIN">' +
          '<button type="button" class="wt-pin-ok" id="wt-pinok">확인</button>';
        var inp = el.querySelector('#wt-pin');
        var btn = el.querySelector('#wt-pinok');
        function submit() {
          var v = (inp && inp.value || '').replace(/[^0-9]/g, '');
          if (v.length !== 4) { fail('숫자 4자리를 눌러 주세요'); return; }
          if (v === pin) { ok(); } else { if (inp) inp.value = ''; fail('PIN이 맞지 않아요. 다시 눌러 주세요'); }
        }
        if (btn) btn.addEventListener('click', function (e) { e.preventDefault(); submit(); });
        if (inp) {
          inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
          setTimeout(function () { try { inp.focus(); } catch (e2) { } }, 120);
        }
      } else {
        /* 인터넷이 없어 PIN을 못 읽었을 때: 보호자 확인 셈 */
        var a = 30 + Math.floor(Math.random() * 60);
        var b = 20 + Math.floor(Math.random() * 70);
        if (lead) lead.textContent = '보호자 확인 · 셈을 풀어 주세요';
        box.innerHTML = '<input id="wt-math" type="tel" inputmode="numeric" maxlength="4" placeholder="답" aria-label="보호자 확인 답">' +
          '<button type="button" class="wt-pin-ok" id="wt-mathok">확인</button>';
        if (err) err.textContent = a + ' + ' + b + ' = ?';
        var mi = el.querySelector('#wt-math');
        var mb = el.querySelector('#wt-mathok');
        function msubmit() {
          var v = (mi && mi.value || '').replace(/[^0-9]/g, '');
          if (parseInt(v, 10) === a + b) { ok(); } else { if (mi) mi.value = ''; err.textContent = a + ' + ' + b + ' = ?  (틀렸어요)'; }
        }
        if (mb) mb.addEventListener('click', function (e) { e.preventDefault(); msubmit(); });
        if (mi) {
          mi.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); msubmit(); } });
          setTimeout(function () { try { mi.focus(); } catch (e2) { } }, 120);
        }
      }
    });
  }

  function grantFlow() {
    askGuardian('20분 더 열어 줄까요?', function () {
      grant();
      toast('⏳ 20분 더 열었어요! 신나게 놀아요 💛');
    });
  }

  function adultChooser() {
    var el = card(
      '<div class="wt-emo">👩‍👨</div>' +
      '<h2>누구로 바꿀까요?</h2>' +
      '<div class="wt-sub">엄마·아빠는 놀이 시간 제한이 없어요</div>' +
      '<div class="wt-btns">' +
      '<button type="button" class="wt-adult" id="wt-mom">👩 엄마로 전환</button>' +
      '<button type="button" class="wt-adult" id="wt-dad">👨 아빠로 전환</button>' +
      '<button type="button" class="wt-mini" id="wt-back">돌아가기</button>' +
      '</div>' +
      '<div class="wt-pin-note">보호자 PIN을 한 번 더 확인해요</div>'
    );
    if (!el) return;
    function back() { renderLock(); }
    el.querySelector('#wt-back').addEventListener('click', function (e) { e.preventDefault(); back(); });
    el.querySelector('#wt-mom').addEventListener('click', function (e) { e.preventDefault(); adultFlow('mom'); });
    el.querySelector('#wt-dad').addEventListener('click', function (e) { e.preventDefault(); adultFlow('dad'); });
  }

  function adultFlow(whoAdult) {
    askGuardian((whoAdult === 'mom' ? '👩 엄마' : '👨 아빠') + '로 바꿀까요?', function () {
      goAdult(whoAdult);
    });
  }

  function goAdult(whoAdult) {
    adultMode = { who: whoAdult, until: Date.now() + ADULT_SPAN, at: Date.now() };
    writeAdult(adultMode);
    hideLock();
    hideBadge();
    refreshAdultChip();
    toast('👩‍👨 ' + ADULTS[whoAdult] + ' 모드 · 놀이 시간 제한 없음');
  }

  /* 보호자 모드일 때만 보이는 작은 표시 (누르면 다시 제한으로) */
  function refreshAdultChip() {
    if (!adultMode) { if (badge && badge.dataset.adult === '1') hideBadge(); return; }
    var b = ensureBadge();
    if (!b) return;
    b.dataset.adult = '1';
    b.textContent = '🔓 ' + ADULTS[adultMode.who] + ' 모드 · 제한 없음 ✕';
    b.style.background = 'rgba(255,255,255,.9)';
    b.style.color = '#2E7D32';
    b.style.borderColor = 'rgba(46,125,50,.28)';
    b.style.pointerEvents = 'auto';
    b.style.display = 'flex';
    if (!b.dataset.bound) {
      b.dataset.bound = '1';
      b.addEventListener('click', function () { endAdult(); });
    }
  }
  function endAdult() {
    adultMode = null;
    writeAdult(null);
    if (badge) { badge.dataset.adult = ''; badge.style.pointerEvents = 'none'; hideBadge(); }
    who = null;   /* 다시 아이 기준으로 */
    toast('놀이 시간 제한을 다시 켰어요 ⏳');
  }

  /* ---------- 20분 더 / 잠금 ---------- */
  function grant() {
    var k = who;
    if (!isKid(k)) return;
    if (!st) st = loadFor(k);
    st.l = st.l + LIMIT;
    st.lock = 0;
    writeState(k, st);
    hideLock();
    lastTs = Date.now();
    lastShownSec = -1;
  }
  function lockNow() {
    var k = who;
    if (!isKid(k)) return;
    if (!st) st = loadFor(k);
    st.u = st.l;
    st.lock = Date.now() + COOLDOWN * 1000;
    writeState(k, st);
    renderLock();
    updateLock();
  }
  function resetState(k) {
    try {
      if (k) localStorage.removeItem(stateKey(k));
      else { localStorage.removeItem(stateKey('yunjin')); localStorage.removeItem(stateKey('hyungwon')); }
    } catch (e) { }
    if (who && (!k || k === who)) { st = loadFor(who); }
    hideLock();
    lastShownSec = -1;
  }

  /* ---------- 1초마다 ---------- */
  function tick() {
    var now = Date.now();

    /* 사람이 바뀌었나? (게임 안에서 캐릭터를 바꾼 경우) */
    var w = detectWho();
    if (w !== who) {
      who = w;
      st = isKid(who) ? loadFor(who) : null;
      lastTs = now;
      lastShownSec = -1;
      if (lockEl && lockEl.parentNode && isKid(who) && st && st.lock) renderLock();
    }
    if (adultMode && adultMode.until < now) { adultMode = null; writeAdult(null); }

    /* 엄마·아빠 또는 보호자 모드 → 제한 없음 */
    if (isAdult(who) || adultMode) {
      if (lockEl && lockEl.parentNode) hideLock();
      if (adultMode) refreshAdultChip(); else hideBadge();
      return;
    }
    if (!isKid(who)) { hideBadge(); return; }

    if (!st) st = loadFor(who);

    /* 30분 쉬기가 끝났나? */
    if (st.lock && now >= st.lock) {
      st = freshState();
      writeState(who, st);
      hideLock();
      lastTs = now;
      lastShownSec = -1;
      toast('다시 놀 수 있어요! ⏳ 20분이 새로 열렸어요 🎉');
    }

    if (st.lock) {
      if (!lockEl || !lockEl.parentNode) renderLock();
      updateLock();
      lastTs = now;
      return;
    }

    /* 노는 중: 화면이 보일 때만 시간이 줄어요 */
    var visible = !document.hidden;
    var dt = (now - lastTs) / 1000;
    lastTs = now;
    if (dt < 0) dt = 0;
    if (dt > 5) dt = 5;          /* 폰이 잠깐 멈췄다 와도 최대 5초만 */
    if (visible && dt > 0) {
      st.u = Math.min(st.l, st.u + dt);
      writeState(who, st);
    }
    if (st.u >= st.l - 0.001) {
      st.u = st.l;
      st.lock = now + COOLDOWN * 1000;
      writeState(who, st);
      renderLock();
      updateLock();
      return;
    }

    var left = Math.ceil(st.l - st.u);
    if (left !== lastShownSec) {
      lastShownSec = left;
      showBadge('⏳ ' + fmt(left), left <= 60);
    }
  }

  function start() {
    if (whoFromStore() === null) {
      /* 이 기기에서 처음이면 주소의 ?who= 를 기억해 둬요 */
      var u = whoFromUrl();
      if (u) { try { localStorage.setItem('lim_active_kid', u); } catch (e) { } }
    }
    adultMode = readAdult();
    who = detectWho();
    st = isKid(who) ? loadFor(who) : null;
    if (TEST && qp('wtleft') !== null && st && isKid(who)) {
      var lf = qnum('wtleft', -1);
      if (lf >= 0) { st.u = Math.max(0, st.l - lf); writeState(who, st); }
    }
    lastTs = Date.now();
    tick();
    setInterval(tick, 1000);
    /* 기록을 확실히 남기기 */
    window.addEventListener('pagehide', saveNow);
    window.addEventListener('beforeunload', saveNow);
    document.addEventListener('visibilitychange', function () { saveNow(); lastTs = Date.now(); });
  }
  function saveNow() {
    if (who && isKid(who) && st) writeState(who, st);
  }

  /* ---------- 테스트/디버그 ---------- */
  window.__WT = {
    version: VERSION,
    test: TEST,
    who: function () { return who; },
    limit: function () { return LIMIT; },
    cooldown: function () { return COOLDOWN; },
    state: function () {
      if (!who) return null;
      return {
        who: who,
        adult: !!(adultMode || isAdult(who)),
        used: st ? Math.round(st.u) : 0,
        limit: st ? st.l : 0,
        left: st ? Math.max(0, Math.round(st.l - st.u)) : 0,
        lockLeft: (st && st.lock) ? Math.max(0, Math.round((st.lock - Date.now()) / 1000)) : 0
      };
    },
    set: function (o) {
      if (!isKid(who)) return null;
      if (!st) st = loadFor(who);
      o = o || {};
      if (typeof o.used === 'number') st.u = o.used;
      if (typeof o.limit === 'number') st.l = o.limit;
      if (typeof o.left === 'number') st.u = Math.max(0, st.l - o.left);
      if (typeof o.lockLeft === 'number') st.lock = Date.now() + o.lockLeft * 1000;
      writeState(who, st);
      lastShownSec = -1;
      tick();
      return this.state();
    },
    grant: function () { grant(); return this.state(); },
    lockNow: function () { lockNow(); return this.state(); },
    reset: function () { resetState(); return this.state(); },
    endAdult: function () { endAdult(); return this.state(); },
    cfg: function (o) {
      if (o && typeof o.limit === 'number') LIMIT = o.limit;
      if (o && typeof o.cooldown === 'number') COOLDOWN = o.cooldown;
      return { limit: LIMIT, cooldown: COOLDOWN };
    },
    tick: tick
  };

  if (TEST && qp('wtreset') === '1') { resetState(); writeAdult(null); }

  if (document.body) start();
  else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
