/* ============================================================
   🔒 채씨네 놀이 월드 공용 — 1인 1기기 좌석 (world-seat.js)
   ------------------------------------------------------------
   블록 월드 · 그로우 어 가든 · 드레스 투 임프레스가 이 파일 하나를 같이 써요.

   왜 필요한가요?
    누가 윤진이로 놀고 있는데 다른 기기에서 또 윤진이로 들어오면,
    두 사람이 같은 캐릭터 하나를 끌고 다녀서 게임이 엉켜요.
    그래서 캐릭터마다 '지금 이 기기가 앉아 있어요' 라는 좌석을 하나씩 두고,
    이미 다른 기기가 앉아 있으면 들어오지 못하게 막아요.

   지키는 것
    1) 기기마다 고유 번호(deviceId)를 localStorage 에 한 번만 만들어 둬요.
       그래서 같은 기기에서 새로고침하거나 포털로 다른 월드에 가도
       '내 좌석'이라 그대로 이어져요 (막히지 않아요).
    2) 좌석은 family-lim-7660/worldSeats/{yunjin|hyungwon|mom|dad} 에
       { deviceId, page, ts } 로 적고, 10초마다 ts 를 새로 써요(heartbeat).
       25초 안에 갱신된 좌석만 '지금 노는 중'으로 봐요.
       (앱을 끄거나 인터넷이 끊겨도 25초 뒤에는 저절로 비어요)
    3) 들어가기·캐릭터 바꾸기는 서버 transaction 으로 확인해요.
       두 기기가 동시에 눌러도 한 기기만 이겨요.
    4) 막힐 때는 화면 위에 큰 안내 창을 띄우고, 남아 있는 가족 캐릭터를
       바로 눌러 전환할 수 있게 해요.

   게임에서 쓰는 법 (세 게임 모두 같은 방식)
     WorldSeat.init({
       who:    function(){ return ME_ID(); },        // 지금 내 캐릭터
       setWho: function(w){ ... }                    // 그 캐릭터로 실제 전환
     });
     WorldSeat.enter('yunjin');           // 입장 (검사 → 통과하면 setWho)
     WorldSeat.switchTo('hyungwon');      // 게임 안에서 캐릭터 바꾸기 (검사 → 통과하면 setWho)
     WorldSeat.release();                 // 내 좌석 비우기

   테스트
     ?wctest=1 · ?timertest=1 · ?seattest=1  → 진짜 좌석 대신 worldSeats_test 를 써요
     ?wseat=0                                → 이 기기에서는 좌석 기능을 끄고 그냥 들어가요
     window.__WS                             → 콘솔에서 seats / who / phase / enter / switchTo / release
   ============================================================ */
(function (global) {
  'use strict';
  try {
    if (global.WorldSeat && global.WorldSeat.version) return;   /* 두 번 불러도 한 번만 */

    var VERSION = '1.0';

    var CFG = {
      apiKey: 'AIzaSyCy_TrcTcwRusSeQH4x3yrGv1bwzi7wBhI',
      authDomain: 'pokemon-quest-lim.firebaseapp.com',
      databaseURL: 'https://pokemon-quest-lim-default-rtdb.asia-southeast1.firebasedatabase.app',
      projectId: 'pokemon-quest-lim',
      storageBucket: 'pokemon-quest-lim.firebasestorage.app',
      messagingSenderId: '186869020161',
      appId: '1:186869020161:web:e3edcca0d1d2675d89f200'
    };
    var REAL_PATH = 'family-lim-7660/worldSeats';
    var TEST_PATH = 'family-lim-7660/worldSeats_test';
    var LS_DEV = 'lim:device:v1';

    var FRESH = 25 * 1000;   /* 25초 안에 갱신된 좌석 = 지금 노는 중 */
    var BEAT = 10 * 1000;    /* 10초마다 내 좌석 시각 새로 쓰기 */

    var NAME = {
      yunjin:   { n: '윤진', e: '🦊', s: '초3 언니', j: '은' },
      hyungwon: { n: '형원', e: '🐣', s: '7살 동생', j: '은' },
      mom:      { n: '엄마', e: '👩', s: '우리 엄마', j: '은' },
      dad:      { n: '아빠', e: '👨', s: '우리 아빠', j: '는' }
    };
    var ORDER = ['yunjin', 'hyungwon', 'mom', 'dad'];
    var MAP = {
      yunjin: 'yunjin', '윤진': 'yunjin',
      hyungwon: 'hyungwon', hyeongwon: 'hyungwon', '형원': 'hyungwon',
      mom: 'mom', '엄마': 'mom',
      dad: 'dad', '아빠': 'dad'
    };
    function norm(v) {
      if (!v) return null;
      var s = String(v).trim().toLowerCase();
      return MAP[s] || null;
    }
    function nm(who) { return (NAME[who] && NAME[who].n) || '가족'; }
    function em(who) { return (NAME[who] && NAME[who].e) || '👪'; }
    function josa(who) { return (NAME[who] && NAME[who].j) || '은'; }

    /* ---------- 주소창 옵션 ---------- */
    var Q = null;
    try { Q = new URLSearchParams(global.location.search || ''); } catch (e) { Q = null; }
    function qp(k) { try { return Q ? Q.get(k) : null; } catch (e) { return null; } }
    var TEST = (qp('wctest') === '1' || qp('timertest') === '1' || qp('seattest') === '1');
    var OFF = (qp('wseat') === '0');
    var PAGE = (function () {
      try {
        var p = String(global.location.pathname || '').split('/').pop();
        return p || 'index.html';
      } catch (e) { return 'index.html'; }
    })();

    /* ---------- 기기 고유 번호 ---------- */
    var DEV = (function () {
      var v = null;
      try { v = global.localStorage.getItem(LS_DEV); } catch (e) {}
      if (v && /^[A-Za-z0-9_-]{6,64}$/.test(v)) return v;
      var rnd = '';
      try {
        var a = new Uint8Array(9);
        (global.crypto || global.msCrypto).getRandomValues(a);
        for (var i = 0; i < a.length; i++) rnd += ('0' + a[i].toString(36)).slice(-2);
      } catch (e) {}
      if (!rnd) rnd = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      var id = 'd' + Date.now().toString(36) + rnd.slice(0, 10);
      try { global.localStorage.setItem(LS_DEV, id); } catch (e) {}
      return id;
    })();

    var S = {
      db: null, root: null, ready: false, booting: false, tries: 0, connected: false, off: 0,
      seats: {}, me: null, phase: 'idle', beatT: 0, seq: 0, blockedWho: null,
      reclaimT: 0, lost: false, applying: false
    };
    var CEB = { who: null, setWho: null };
    var waiters = [];
    var hooked = false;

    function nowT() { return Date.now() + (S.off || 0); }
    function isFresh(rec) {
      if (!rec || !rec.ts) return false;
      return (nowT() - Number(rec.ts)) < FRESH;
    }
    function heldByOther(who) {
      var r = S.seats[who];
      return !!(r && r.deviceId && r.deviceId !== DEV && isFresh(r));
    }

    /* ---------- 서버 연결 ---------- */
    function whenReady(fn) {
      if (OFF) { try { if (fn) fn(); } catch (e) {} return; }
      if (S.root) { try { if (fn) fn(); } catch (e) {} return; }
      if (fn) waiters.push(fn);
      boot();
    }
    function boot() {
      if (OFF || S.root || S.booting) return;
      if (typeof global.firebase === 'undefined' || !global.firebase.initializeApp) {
        if (S.tries++ > 240) return;          /* 1분쯤 기다려도 없으면 조용히 포기 */
        global.setTimeout(boot, 250);
        return;
      }
      S.booting = true;
      try {
        var app = (global.firebase.apps && global.firebase.apps.length)
          ? global.firebase.app() : global.firebase.initializeApp(CFG);
        var db = global.firebase.database(app);
        S.db = db;
        try {
          db.ref('.info/serverTimeOffset').on('value', function (s) {
            S.off = Number(s.val()) || 0;
          }, function () {});
        } catch (e) {}
        try {
          db.ref('.info/connected').on('value', function (s) {
            var was = S.connected;
            S.connected = !!s.val();
            if (S.connected && !was) onBack();
          }, function () {});
        } catch (e) {}
        S.root = db.ref(TEST ? TEST_PATH : REAL_PATH);
        S.root.on('value', onSeats, function () {});
        S.ready = true;
        S.booting = false;
        var q = waiters; waiters = [];
        for (var i = 0; i < q.length; i++) { try { q[i](); } catch (e) {} }
      } catch (e) {
        S.booting = false;
        global.setTimeout(boot, 900);
      }
    }
    function onBack() {
      /* 인터넷이 다시 붙으면 내 좌석부터 다시 확인 */
      if (S.phase === 'in' && S.me) beat();
      else if (S.phase === 'blocked' && S.blockedWho) renderPicks();
    }

    /* ---------- 좌석 읽기 ---------- */
    function onSeats(snap) {
      var v = null;
      try { v = snap && snap.val ? snap.val() : null; } catch (e) { v = null; }
      S.seats = (v && typeof v === 'object') ? v : {};
      if (isBlockedOpen()) renderPicks();
      checkMine();
    }
    function checkMine() {
      if (S.phase !== 'in' || !S.me || OFF) return;
      var r = S.seats[S.me];
      if (!r || !r.deviceId) { scheduleReclaim(); return; }        /* 새로고침 경합으로 내 좌석이 지워졌을 때 */
      if (r.deviceId !== DEV && isFresh(r)) takenOver();
    }
    function scheduleReclaim() {
      if (OFF || S.reclaimT || S.phase !== 'in' || !S.me) return;
      S.reclaimT = global.setTimeout(function () {
        S.reclaimT = 0;
        if (OFF || S.phase !== 'in' || !S.me) return;
        var who = S.me;
        claim(who, function (ok, cur, why) {
          if (ok) { if (!S.beatT) armSeat(who); return; }
          if (why === 'taken' && S.me === who) takenOver();
        });
      }, 700);
    }
    function takenOver() {
      /* 내 좌석 자리를 다른 기기가 가져갔어요 (내 화면이 한참 잠들어 있었을 때) */
      if (S.lost) return;
      S.lost = true;
      if (S.beatT) { global.clearInterval(S.beatT); S.beatT = 0; }
      toast('⚠️ 다른 기기에서 ‘' + nm(S.me) + '’으로 접속했어요');
      global.setTimeout(function () {
        S.lost = false;
        if (S.phase === 'in' && S.me) scheduleReclaim();
      }, 20000);
    }

    /* ---------- 좌석 잡기 · 놓기 ---------- */
    function claim(who, cb) {
      cb = cb || function () {};
      whenReady(function () {
        if (OFF || !S.root) return cb(false, null, 'err');
        var ref;
        try { ref = S.root.child(who); } catch (e) { return cb(false, null, 'err'); }
        try {
          ref.transaction(function (cur) {
            var t = nowT();
            if (cur && cur.deviceId && cur.deviceId !== DEV && (t - (Number(cur.ts) || 0) < FRESH)) {
              return;                                  /* 다른 기기가 노는 중 → 취소 */
            }
            return { deviceId: DEV, page: PAGE, ts: t };
          }, function (err, committed, snap) {
            if (err) return cb(false, null, 'err');
            if (!committed) {
              var v = null;
              try { v = snap && snap.val ? snap.val() : null; } catch (e) { v = null; }
              return cb(false, v, 'taken');
            }
            var v2 = null;
            try { v2 = snap && snap.val ? snap.val() : null; } catch (e) { v2 = null; }
            cb(true, v2, null);
          }, false);
        } catch (e) { cb(false, null, 'err'); }
      });
    }
    function release(who) {
      who = who || S.me;
      if (OFF || !S.root || !who) return;
      try {
        S.root.child(who).transaction(function (cur) {
          if (cur && cur.deviceId === DEV) return null;   /* 내 좌석만 비워요 */
          return;                                        /* 남의 좌석은 그대로 */
        }, function () {}, false);
      } catch (e) {}
    }
    function beat() {
      if (OFF || !S.root || !S.me || S.phase !== 'in' || S.lost) return;
      var who = S.me;
      try {
        S.root.child(who).transaction(function (cur) {
          var t = nowT();
          if (cur && cur.deviceId && cur.deviceId !== DEV && (t - (Number(cur.ts) || 0) < FRESH)) return;
          return { deviceId: DEV, page: PAGE, ts: t };
        }, function (err, committed) {
          if (err) return;
          if (!committed && S.phase === 'in' && S.me === who) takenOver();
        }, false);
      } catch (e) {}
    }
    function armSeat(who) {
      S.me = who;
      S.phase = 'in';
      S.lost = false;
      try { if (S.root) S.root.child(who).onDisconnect().remove(); } catch (e) {}
      if (!S.beatT) S.beatT = global.setInterval(beat, BEAT);
      beat();
    }

    /* ---------- 게임 쪽에 알려 주기 ---------- */
    function applyWho(w) {
      if (!w) return false;
      S.applying = true;
      try { if (CEB.setWho) CEB.setWho(w); } catch (e) { try { console.warn('[world-seat] setWho', e); } catch (e2) {} }
      S.applying = false;
      return true;
    }

    /* ---------- 들어가기 ---------- */
    function enter(who, opts) {
      opts = opts || {};
      var w = norm(who);
      if (!w) { if (opts.apply !== false) applyWho(who); return; }
      if (OFF) {
        S.me = w; S.phase = 'in';
        if (opts.apply !== false) applyWho(w);
        return;
      }
      S.seq++;
      var token = S.seq, applied = false;
      S.phase = 'claim';
      S.me = w;
      claim(w, function (ok, cur, why) {
        if (token !== S.seq) return;
        if (ok) {
          armSeat(w);
          hideBlocked();
          if (!applied && opts.apply !== false) { applied = true; applyWho(w); }
        } else if (why === 'taken') {
          S.phase = 'blocked';
          S.blockedWho = w;
          showBlocked(w);
        } else {
          /* 서버를 못 읽었어요 → 아이들을 막지 않고 그냥 들어가게 해요 */
          S.phase = 'in';
          if (!S.beatT) S.beatT = global.setInterval(beat, BEAT);
          if (!applied && opts.apply !== false) { applied = true; applyWho(w); }
        }
      });
      /* 연결이 아주 느릴 때(2.5초)는 일단 들여보내고, 나중에 답이 오면 그때 확인해요 */
      global.setTimeout(function () {
        if (token !== S.seq || S.phase !== 'claim') return;
        S.phase = 'in';
        if (!S.beatT) S.beatT = global.setInterval(beat, BEAT);
        if (!applied && opts.apply !== false) { applied = true; applyWho(w); }
      }, 2500);
    }

    /* ---------- 게임 안에서 캐릭터 바꾸기 ---------- */
    function switchTo(who, opts) {
      opts = opts || {};
      var w = norm(who);
      if (!w) return false;
      if (OFF) {
        S.me = w; S.phase = 'in';
        if (opts.apply !== false) applyWho(w);
        return true;
      }
      if (S.phase === 'in' && S.me === w) {          /* 지금 쓰는 캐릭터 → 그대로 */
        if (opts.apply !== false) applyWho(w);
        beat();
        return true;
      }
      var token = ++S.seq;
      var old = S.me;
      claim(w, function (ok, cur, why) {
        if (token !== S.seq) return;
        if (ok) {
          armSeat(w);
          if (old && old !== w) release(old);
          hideBlocked();
          if (opts.apply !== false) applyWho(w);
        } else if (why === 'taken') {
          toast('🔒 ' + em(w) + ' ' + nm(w) + josa(w) + ' 이미 다른 기기에서 접속 중이에요!');
        } else {
          S.me = w; S.phase = 'in';
          if (!S.beatT) S.beatT = global.setInterval(beat, BEAT);
          if (old && old !== w) release(old);
          if (opts.apply !== false) applyWho(w);
        }
      });
      return true;
    }

    /* ---------- 화면: 가운데 안내 창 ---------- */
    var UI = null;
    var FONT = '"Pretendard Variable",Pretendard,system-ui,-apple-system,"Apple SD Gothic Neo","Noto Sans KR","Malgun Gothic",sans-serif';

    function ensureCSS() {
      if (global.document.getElementById('ws-style')) return;
      var st = global.document.createElement('style');
      st.id = 'ws-style';
      st.textContent = [
        '#ws-mask{position:fixed;inset:0;z-index:2147483600;display:none;align-items:center;justify-content:center;',
        'padding:18px;background:rgba(28,22,46,.58);-webkit-backdrop-filter:blur(7px);backdrop-filter:blur(7px);',
        'font-family:' + FONT + ';}',
        '#ws-mask.on{display:flex}',
        '#ws-card{width:100%;max-width:372px;background:#fff;border-radius:26px;padding:20px 16px 14px;text-align:center;',
        'box-shadow:0 26px 70px rgba(20,10,40,.38);animation:ws-pop .26s cubic-bezier(.2,1.3,.42,1) both;}',
        '@keyframes ws-pop{from{transform:scale(.92) translateY(10px);opacity:0}to{transform:none;opacity:1}}',
        '#ws-card .ws-ico{width:60px;height:60px;margin:0 auto 10px;border-radius:50%;display:flex;align-items:center;justify-content:center;',
        'font-size:30px;background:linear-gradient(160deg,#FFF0F6,#EFE7FF);box-shadow:inset 0 -3px 0 rgba(150,110,190,.14)}',
        '#ws-card h2{margin:0 0 6px;font-size:18px;line-height:1.36;font-weight:900;letter-spacing:-.03em;color:#2a2140}',
        '#ws-card h2 b{color:#B02A72}',
        '#ws-card .ws-sub{margin:0 0 13px;font-size:12.5px;font-weight:800;color:#7c7094;line-height:1.55}',
        '#ws-picks{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
        '#ws-picks button{position:relative;display:flex;flex-direction:column;align-items:center;gap:1px;padding:11px 6px 9px;',
        'border:2px solid #e9e3f5;border-radius:16px;background:#fbf9ff;cursor:pointer;font-family:inherit;transition:transform .08s,border-color .12s}',
        '#ws-picks button:active{transform:scale(.96)}',
        '#ws-picks button .e{font-size:24px;line-height:1.1}',
        '#ws-picks button b{font-size:14px;font-weight:900;color:#33294d;letter-spacing:-.03em}',
        '#ws-picks button small{font-size:10px;font-weight:800;color:#8b81a3}',
        '#ws-picks button[data-taken="1"]{opacity:.5;cursor:not-allowed;background:#f4f2f8;border-color:#ece8f3}',
        '#ws-picks button:last-child:nth-child(odd){grid-column:1 / -1}',
        '#ws-picks button[data-taken="1"] small{color:#ab6b6b}',
        '#ws-retry{margin:11px 0 0;width:100%;padding:12px;border:0;border-radius:15px;font-family:inherit;font-size:13.5px;font-weight:900;',
        'color:#fff;background:linear-gradient(140deg,#8E6BE8,#C954A6);cursor:pointer;letter-spacing:-.02em}',
        '#ws-retry:active{transform:scale(.98)}',
        '#ws-note{margin:8px 2px 0;font-size:10.5px;font-weight:800;color:#a49bb8;line-height:1.5}',
        '#ws-toast{position:fixed;left:50%;bottom:calc(26px + env(safe-area-inset-bottom,0px));transform:translate(-50%,16px);',
        'z-index:2147483646;max-width:calc(100vw - 32px);background:#2b2440;color:#fff;font-family:' + FONT + ';',
        'font-size:13px;font-weight:800;line-height:1.45;letter-spacing:-.02em;padding:11px 15px;border-radius:14px;',
        'box-shadow:0 12px 30px rgba(20,10,40,.34);opacity:0;pointer-events:none;transition:opacity .18s,transform .18s}',
        '#ws-toast.on{opacity:1;transform:translate(-50%,0)}'
      ].join('');
      (global.document.head || global.document.documentElement).appendChild(st);
    }

    function ensureUI() {
      if (UI) return UI;
      ensureCSS();
      var mask = global.document.createElement('div');
      mask.id = 'ws-mask';
      mask.setAttribute('role', 'dialog');
      mask.setAttribute('aria-modal', 'true');
      mask.innerHTML =
        '<div id="ws-card">' +
          '<div class="ws-ico">🔒</div>' +
          '<h2 id="ws-title">지금 다른 기기에서 놀고 있어요!</h2>' +
          '<p class="ws-sub">다른 가족 캐릭터를 골라 주세요.</p>' +
          '<div id="ws-picks"></div>' +
          '<button id="ws-retry" type="button">🔄 다시 확인해 볼게요</button>' +
          '<p id="ws-note">같은 기기에서 새로고침하거나 다른 월드로 옮겨 갈 때는 그대로 이어져요.</p>' +
        '</div>';
      global.document.body.appendChild(mask);
      var toast = global.document.createElement('div');
      toast.id = 'ws-toast';
      toast.setAttribute('role', 'status');
      toast.setAttribute('aria-live', 'polite');
      global.document.body.appendChild(toast);

      mask.addEventListener('click', function (e) {
        var t = e.target;
        while (t && t !== mask && !(t.getAttribute && t.getAttribute('data-w'))) t = t.parentNode;
        if (!t || t === mask || !t.getAttribute) return;
        if (t.getAttribute('data-taken') === '1') return;
        var w = norm(t.getAttribute('data-w'));
        if (!w) return;
        pickFree(w);
      });
      var rt = mask.querySelector('#ws-retry');
      if (rt) rt.addEventListener('click', function () { retry(); });

      UI = { mask: mask, card: mask.querySelector('#ws-card'), title: mask.querySelector('#ws-title'),
             sub: mask.querySelector('.ws-sub'), picks: mask.querySelector('#ws-picks'), toast: toast };
      return UI;
    }

    function isBlockedOpen() { return !!(UI && UI.mask && UI.mask.classList.contains('on')); }

    function showBlocked(who) {
      try {
        hideToastSoon();   /* 겹치지 않게 */
        var u = ensureUI();
        u.title.innerHTML = '🔒 지금 다른 기기에서<br>‘<b>' + nm(who) + '</b>’으로 놀고 있어요!';
        u.sub.textContent = '다른 가족 캐릭터를 골라 주세요.';
        renderPicks();
        u.mask.classList.add('on');
        try { global.document.documentElement.style.overflow = 'hidden'; } catch (e) {}
      } catch (e) { try { console.warn('[world-seat] blocked', e); } catch (e2) {} }
    }
    function hideBlocked() {
      try {
        if (UI && UI.mask) UI.mask.classList.remove('on');
        global.document.documentElement.style.overflow = '';
      } catch (e) {}
    }
    function renderPicks() {
      try {
        var u = ensureUI();
        var who = S.blockedWho;
        var html = '';
        for (var i = 0; i < ORDER.length; i++) {
          var k = ORDER[i];
          if (k === who) continue;
          var taken = heldByOther(k);
          html += '<button type="button" data-w="' + k + '"' + (taken ? ' data-taken="1"' : '') + '>' +
                  '<span class="e">' + NAME[k].e + '</span><b>' + NAME[k].n + '</b>' +
                  '<small>' + (taken ? '다른 기기에서 노는 중' : NAME[k].s) + '</small></button>';
        }
        u.picks.innerHTML = html;
      } catch (e) {}
    }
    function pickFree(w) {
      hideBlocked();
      S.blockedWho = null;
      if (S.phase === 'in' && S.me) switchTo(w);
      else enter(w);
    }
    function retry() {
      var who = S.blockedWho;
      if (!who) { hideBlocked(); return; }
      var btn = UI && UI.mask.querySelector('#ws-retry');
      if (btn) { btn.disabled = true; btn.textContent = '확인하는 중…'; }
      claim(who, function (ok, cur, why) {
        if (btn) { btn.disabled = false; btn.textContent = '🔄 다시 확인해 볼게요'; }
        if (ok) {
          hideBlocked();
          S.blockedWho = null;
          armSeat(who);
          applyWho(who);
        } else if (why === 'taken') {
          toast('아직 ‘' + nm(who) + '’으로 노는 기기가 있어요');
          renderPicks();
        } else {
          hideBlocked();
          S.blockedWho = null;
          S.phase = 'in';
          applyWho(who);
        }
      });
    }

    /* ---------- 작은 알림 ---------- */
    var toastT = 0;
    function toast(msg) {
      try {
        var u = ensureUI();
        u.toast.textContent = msg;
        u.toast.classList.add('on');
        if (toastT) global.clearTimeout(toastT);
        toastT = global.setTimeout(function () { try { u.toast.classList.remove('on'); } catch (e) {} }, 2600);
      } catch (e) {}
    }
    function hideToastSoon() {
      try { if (UI && UI.toast) UI.toast.classList.remove('on'); } catch (e) {}
    }

    /* ---------- 전역 정리 ---------- */
    function hookGlobal() {
      if (hooked) return;
      hooked = true;
      var bye = function () {
        if (S.phase !== 'in' || !S.me || !S.root) return;
        try { S.root.child(S.me).onDisconnect().cancel(); } catch (e) {}
        release(S.me);
      };
      global.addEventListener('beforeunload', bye);
      global.document.addEventListener('visibilitychange', function () {
        if (!global.document.hidden) {
          if (S.phase === 'in' && S.me) beat();
          if (isBlockedOpen()) renderPicks();
        }
      });
      global.addEventListener('online', function () {
        if (S.phase === 'in' && S.me) beat();
      });
    }

    /* ---------- 내보내기 ---------- */
    var API = {
      version: VERSION,
      deviceId: DEV,
      test: TEST,
      page: PAGE,
      init: function (opts) {
        opts = opts || {};
        if (typeof opts.setWho === 'function') CEB.setWho = opts.setWho;
        if (typeof opts.who === 'function') CEB.who = opts.who;
        hookGlobal();
        if (!OFF) boot();
        return API;
      },
      enter: function (who, opts) { try { enter(who, opts); } catch (e) {} return API; },
      switchTo: function (who, opts) { try { return switchTo(who, opts); } catch (e) { return false; } },
      release: function (who) { try { release(who); } catch (e) {} },
      retry: function () { try { retry(); } catch (e) {} },
      seats: function () { return S.seats; },
      who: function () { try { return CEB.who ? norm(CEB.who()) || S.me : S.me; } catch (e) { return S.me; } },
      phase: function () { return S.phase; },
      heldByOther: function (who) { return heldByOther(norm(who) || who); },
      hide: function () { hideBlocked(); },
      toast: toast
    };
    global.WorldSeat = API;
    try { global.__WS = API; } catch (e) {}
  } catch (e) {
    try { console.warn('[world-seat] 시작하지 못했어요', e); } catch (e2) {}
  }
})(window);
