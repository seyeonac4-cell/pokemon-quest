/* ============================================================
   🎙️ 채씨네 3종 월드 가족 음성 대화 — world-voice.js
   ------------------------------------------------------------
   block-world.html · grow-garden.html · dress-up.html 세 게임이
   이 파일 하나를 같이 써요.

   쓰는 법 (게임 안에서)
     WorldVoice.init({ world:'블록 월드', blockSel:'#friendOverlay.open' });
     · world     : 지금 놀고 있는 월드 이름(가족 칩 설명에만 씀)
     · blockSel  : 이 창이 열려 있으면 마이크를 잠깐 꺼 두는 선택자
                   (블록 월드의 하은이 음성 대화가 SpeechRecognition 을
                    쓰기 때문에 마이크를 동시에 못 씁니다)
   init 을 안 불러도 페이지가 열리면 자동으로 켜져요.

   누르면 마이크 ON · 다시 누르면 OFF
     OFF : 마이크 장치를 아예 안 잡아요(getUserMedia 안 부름)
     ON  : echoCancellation · noiseSuppression · autoGainControl 로
           오디오만 열고, 같은 방(worldVoice/main)에 있는 가족과
           WebRTC P2P 오디오로 이야기해요.
     다시 누르면 track.enabled=false + track.stop() 으로
     마이크를 완전히 끄고 스트림을 닫아요.

   시그널링
     family-lim-7660/worldVoice  (독립 경로 — kids·worldCoins·
     growGarden 은 절대 건드리지 않아요.)
       peers/{peerId}  = { who, micOn, ver, ts, world }
       sig/{상대}/{나}/offer|answer = { sid, sdp, ts }
     · 20초마다 heartbeat, 창을 닫으면 onDisconnect 로 내 노드를 지워요.
     · 5분 동안 아무것도 안 만지면 마이크를 끄고 내 노드도 정리해요.
       (?wvidle=6 처럼 초 단위로 줄여 시험할 수 있어요)
     · ?wvtest=1 (또는 ?wctest=1) 이면 Firebase 에 아무것도 쓰지 않고
       브라우저 안(BroadcastChannel)에서만 시험해요.

   테스트/디버그
     window.__WV.state() / toggle() / on() / off() / peers()
   ============================================================ */
(function (global) {
  'use strict';
  if (global.WorldVoice && global.WorldVoice.version) return;

  var VERSION = '1.1';
  var PATH = 'family-lim-7660/worldVoice';
  var ROOM = 'main';
  var K_ACTIVE = 'lim_active_kid';

  var FB_CFG = {
    apiKey: 'AIzaSyCy_TrcTcwRusSeQH4x3yrGv1bwzi7wBhI',
    authDomain: 'pokemon-quest-lim.firebaseapp.com',
    databaseURL: 'https://pokemon-quest-lim-default-rtdb.asia-southeast1.firebasedatabase.app',
    projectId: 'pokemon-quest-lim',
    storageBucket: 'pokemon-quest-lim.firebasestorage.app',
    messagingSenderId: '186869020161',
    appId: '1:186869020161:web:e3edcca0d1d2675d89f200'
  };

  /* 무료 STUN 여러 개 — 같은 집 WiFi 면 직접(host) 후보로 바로 붙어요 */
  var STUN = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302',
             'stun:stun2.l.google.com:19302', 'stun:stun3.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:global.stun.twilio.com:3478' }
  ];

  var PEOPLE = {
    yunjin:   { name: '윤진', emo: '🦊' },
    hyungwon: { name: '형원', emo: '🐣' },
    mom:      { name: '엄마', emo: '👩' },
    dad:      { name: '아빠', emo: '👨' }
  };

  /* ---------- 주소창 옵션 ---------- */
  var Q = null;
  try { Q = new URLSearchParams(location.search || ''); } catch (e) { Q = null; }
  function qp(k) { try { return Q ? Q.get(k) : null; } catch (e) { return null; } }

  function normWho(v) {
    if (!v) return null;
    v = String(v).trim().toLowerCase();
    if (v === 'yunjin' || v === '윤진') return 'yunjin';
    if (v === 'hyungwon' || v === 'hyeongwon' || v === '형원') return 'hyungwon';
    if (v === 'mom' || v === '엄마') return 'mom';
    if (v === 'dad' || v === '아빠') return 'dad';
    return null;
  }

  var TEST = (qp('wvtest') === '1') || (qp('wctest') === '1') || (qp('wvlocal') === '1');
  var FORCE_WHO = normWho(qp('wvwho'));
  var NO_UI = qp('wvnoui') === '1';
  var IDLE_MS = 5 * 60 * 1000;
  try { var _idle = parseFloat(qp('wvidle')); if (_idle > 0) IDLE_MS = _idle * 1000; } catch (e) { }

  function rnd(n) { return Math.random().toString(36).slice(2, 2 + (n || 5)); }
  function now() { return Date.now(); }
  function person(who) { return PEOPLE[who] || { name: '가족', emo: '🙂' }; }
  function safeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

  var UA = navigator.userAgent || '';
  var IN_APP = /KAKAOTALK|NAVER|DaumApps|Instagram|FBAN|FBAV|FB_IAB|Line\/|WhatsApp|Snapchat|Twitter|Threads|everytimeApp|KAKAOSTORY/i.test(UA);

  /* ---------- 상태 ---------- */
  var S = {
    ready: false, started: false, cfg: {},
    who: FORCE_WHO || 'yunjin', pid: '', world: '',
    micOn: false, micBusy: false, stream: null,
    myVer: 1, peers: {}, conns: {}, attempts: {},
    audios: {}, analysers: {}, speaking: {},
    transport: null, seenSig: {}, idled: false, lastAct: now(),
    timers: [], ac: null, audioBlocked: false, retryT: {}
  };
  var DBG = { offerIn: 0, offerOut: 0, answerIn: 0, answerOut: 0, pc: 0, err: [] };
  function dbgErr(tag, e) { if (DBG.err.length < 8) DBG.err.push(tag + ': ' + ((e && (e.name || e.message)) || e)); }

  function detectWho() {
    if (FORCE_WHO) return FORCE_WHO;
    var w = normWho(safeGet(K_ACTIVE));
    if (w) return w;
    return 'yunjin';
  }

  /* ============================================================
     화면 (마이크 토글 + 가족 칩 + 안내 토스트)
     ============================================================ */
  var el = { bar: null, chips: null, mic: null, ico: null, txt: null, toast: null };
  var toastT = 0;

  function injectStyle() {
    if (document.getElementById('wv-style')) return;
    var st = document.createElement('style');
    st.id = 'wv-style';
    st.textContent = [
      '#wv-bar{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(56px + env(safe-area-inset-bottom,0px));',
      'z-index:2147483002;display:flex;flex-direction:column;align-items:center;gap:5px;pointer-events:none;',
      'font-family:"Jua","Pretendard Variable",-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;',
      '-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent}',

      '#wv-toast{max-width:64vw;padding:8px 14px;border-radius:14px;background:rgba(38,28,60,.93);color:#fff;',
      'font-size:12.5px;font-weight:800;line-height:1.35;letter-spacing:-.02em;text-align:center;',
      'box-shadow:0 8px 22px rgba(20,10,40,.32);opacity:0;transform:translateY(4px);transition:opacity .2s,transform .2s;',
      'pointer-events:none;word-break:keep-all}',
      '#wv-toast.show{opacity:1;transform:none}',

      '#wv-chips{display:flex;align-items:center;gap:4px;min-height:0;pointer-events:none}',
      '.wv-chip{display:inline-flex;align-items:center;gap:2px;height:23px;padding:0 7px 0 5px;border-radius:999px;',
      'background:rgba(255,255,255,.93);border:1.5px solid rgba(150,165,195,.32);color:#4d5c7a;',
      'font-size:11px;font-weight:800;letter-spacing:-.02em;white-space:nowrap;',
      'box-shadow:0 3px 9px rgba(30,50,80,.16);transition:background .2s,border-color .2s,transform .2s}',
      '.wv-chip .e{font-size:13px;line-height:1}',
      '.wv-chip .n{font-size:10.5px}',
      '.wv-chip.on{background:linear-gradient(180deg,#ecfff8,#c9f7e5);border-color:#4fdcb2;color:#0d6b4c}',
      '.wv-chip.spk{animation:wv-spk .9s ease-in-out infinite;border-color:#25c79a}',
      '.wv-chip.wait{background:rgba(255,255,255,.82);color:#7b88a3;border-style:dashed}',
      '@keyframes wv-spk{0%,100%{transform:scale(1);box-shadow:0 3px 9px rgba(30,50,80,.16)}',
      '50%{transform:scale(1.07);box-shadow:0 0 0 3px rgba(63,214,176,.42),0 4px 14px rgba(20,130,95,.3)}}',

      '#wv-mic{pointer-events:auto;display:inline-flex;align-items:center;gap:5px;height:38px;padding:0 15px;',
      'border-radius:999px;border:2px solid #fff;background:rgba(255,255,255,.96);color:#4a5a78;',
      'font-family:inherit;font-size:13.5px;font-weight:800;letter-spacing:-.02em;white-space:nowrap;',
      'box-shadow:0 6px 16px rgba(30,50,80,.22);transition:transform .1s,background .2s,box-shadow .2s,color .2s;',
      'cursor:pointer;touch-action:manipulation}',
      '#wv-mic:active{transform:scale(.95)}',
      '#wv-mic .wv-ico{font-size:16px;line-height:1}',
      '#wv-mic .wv-dot{width:7px;height:7px;border-radius:50%;background:#b9c4d8;box-shadow:0 0 0 2px rgba(185,196,216,.25)}',
      '#wv-bar[data-on="1"] #wv-mic{background:linear-gradient(180deg,#84f3ca,#2ecf9c);color:#054433;border-color:#fff;',
      'box-shadow:0 0 0 3px rgba(63,214,176,.34),0 8px 20px rgba(18,150,110,.42);animation:wv-pulse 2.2s ease-in-out infinite}',
      '#wv-bar[data-on="1"] #wv-mic .wv-dot{background:#0c9d72;box-shadow:0 0 0 2px rgba(12,157,114,.22)}',
      '@keyframes wv-pulse{0%,100%{box-shadow:0 0 0 3px rgba(63,214,176,.30),0 8px 20px rgba(18,150,110,.40)}',
      '50%{box-shadow:0 0 0 6px rgba(63,214,176,.16),0 10px 26px rgba(18,150,110,.52)}}',
      '#wv-bar[data-busy="1"] #wv-mic{opacity:.72}',

      '@media (min-width:820px){#wv-bar{left:calc(50% - 210px);bottom:calc(60px + env(safe-area-inset-bottom,0px))}}'
    ].join('');
    (document.head || document.documentElement).appendChild(st);
  }

  function buildUI() {
    if (NO_UI || el.bar) return;
    injectStyle();
    var bar = document.createElement('div');
    bar.id = 'wv-bar';
    bar.setAttribute('data-on', '0');

    var toast = document.createElement('div');
    toast.id = 'wv-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');

    var chips = document.createElement('div');
    chips.id = 'wv-chips';

    var mic = document.createElement('button');
    mic.id = 'wv-mic';
    mic.type = 'button';
    mic.setAttribute('aria-pressed', 'false');
    mic.setAttribute('aria-label', '마이크 켜기');
    mic.innerHTML = '<span class="wv-ico">🎙️</span><span class="wv-txt">마이크</span><span class="wv-dot"></span>';

    bar.appendChild(toast);
    bar.appendChild(chips);
    bar.appendChild(mic);
    (document.body || document.documentElement).appendChild(bar);

    el.bar = bar; el.toast = toast; el.chips = chips; el.mic = mic;
    el.txt = mic.querySelector('.wv-txt');
    el.ico = mic.querySelector('.wv-ico');

    ['pointerdown', 'touchstart', 'mousedown', 'click', 'keydown'].forEach(function (ev) {
      bar.addEventListener(ev, function (e) { e.stopPropagation(); }, false);
    });
    mic.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      S.lastAct = now();
      unlockAudio();
      toggle();
    });
    render();
  }

  function toast(msg, ms) {
    if (!el.toast) return;
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(function () { if (el.toast) el.toast.classList.remove('show'); }, ms || 3000);
  }

  function render() {
    if (!el.bar) return;
    el.bar.setAttribute('data-on', S.micOn ? '1' : '0');
    el.bar.setAttribute('data-busy', S.micBusy ? '1' : '0');
    if (el.txt) el.txt.textContent = S.micOn ? '켜짐' : '마이크';
    if (el.ico) el.ico.textContent = S.micOn ? '🟢' : '🎙️';
    if (el.mic) {
      el.mic.setAttribute('aria-pressed', S.micOn ? 'true' : 'false');
      el.mic.setAttribute('aria-label', S.micOn ? '마이크 끄기' : '마이크 켜기');
    }
    renderChips();
  }

  /* 가족 칩: 방에 들어와 있는 사람(마이크 켠 사람은 초록, 말하면 반짝) */
  function peerList() {
    var seen = {}, list = [];
    Object.keys(S.peers).forEach(function (pid) {
      var p = S.peers[pid];
      if (!p || !p.who) return;
      /* 같은 사람이 기기를 두 개 켜 두면 칩은 하나만 보여 줘요 */
      var prev = seen[p.who];
      if (prev) {
        prev.micOn = prev.micOn || !!p.micOn;
        prev.speaking = prev.speaking || isSpeaking(pid) || isSpeaking(prev.pid);
        return;
      }
      var item = { pid: pid, who: p.who, micOn: !!p.micOn, speaking: isSpeaking(pid), ver: p.ver || 0 };
      seen[p.who] = item;
      list.push(item);
    });
    list.sort(function (a, b) {
      if (!!a.micOn !== !!b.micOn) return a.micOn ? -1 : 1;
      var order = { yunjin: 0, hyungwon: 1, mom: 2, dad: 3 };
      return (order[a.who] || 9) - (order[b.who] || 9);
    });
    return list;
  }

  var chipSig = '';
  function renderChips() {
    if (!el.chips) return;
    var list = peerList();
    var sig = list.map(function (it) { return it.who + (it.micOn ? '1' : '0') + (it.speaking ? 's' : '') + it.pid; }).join('|') + '#' + (S.micOn ? 'M' : '-') + (list.length ? '' : 'E');
    if (sig === chipSig) return;
    chipSig = sig;
    el.chips.textContent = '';
    if (!list.length) {
      if (S.micOn) {
        var w = document.createElement('span');
        w.className = 'wv-chip wait';
        w.innerHTML = '<span class="e">👀</span><span class="n">가족을 기다리는 중</span>';
        el.chips.appendChild(w);
      }
      return;
    }
    list.slice(0, 4).forEach(function (it) {
      var p = person(it.who);
      var c = document.createElement('span');
      c.className = 'wv-chip' + (it.micOn ? ' on' : '') + (it.speaking ? ' spk' : '');
      c.setAttribute('title', p.name + (it.micOn ? ' · 마이크 켜짐' : ' · 듣는 중'));
      c.innerHTML = '<span class="e">' + p.emo + '</span>' + (it.micOn ? '<span class="n">' + p.name + '</span>' : '');
      el.chips.appendChild(c);
    });
  }

  /* ============================================================
     시그널링 — Firebase (실제) / BroadcastChannel (시험)
     ============================================================ */
  function makeFirebase() {
    var db = null, root = null, myRef = null, peerCb = null, started = false;

    function fire(kind, data) {
      try { onSignal(kind.from, kind.kind, kind.data); } catch (e) { }
    }

    return {
      name: 'firebase',
      start: function (cb) {
        peerCb = cb;
        if (!global.firebase || !global.firebase.database) return false;
        if (started) { try { this.announce(); } catch (e) { } return true; }
        try {
          var app = (firebase.apps && firebase.apps.length) ? firebase.app() : firebase.initializeApp(FB_CFG);
          db = firebase.database(app);
          root = db.ref(PATH + '/' + ROOM);
          myRef = root.child('peers/' + S.pid);
          try { myRef.onDisconnect().remove(); } catch (e) { }

          root.child('peers').on('value', function (snap) {
            var v = snap.val() || {};
            var out = {};
            var t = now();
            Object.keys(v).forEach(function (pid) {
              if (pid === S.pid) return;
              var p = v[pid];
              if (!p || !p.ts) return;
              if (t - p.ts > 90 * 1000) {
                /* 오래된 유령 노드(앱이 강제 종료된 경우)는 정리해요 */
                if (t - p.ts > 4 * 60 * 1000) { try { root.child('peers/' + pid).remove().catch(function () { }); } catch (e) { } }
                return;
              }
              out[pid] = { who: p.who, micOn: !!p.micOn, ver: p.ver || 0, ts: p.ts, world: p.world || '' };
            });
            if (peerCb) peerCb(out);
          }, function () { });

          /* 나에게 온 offer / answer */
          root.child('sig/' + S.pid).on('value', function (snap) {
            var v = snap.val() || {};
            Object.keys(v).forEach(function (from) {
              var box = v[from] || {};
              ['offer', 'answer'].forEach(function (kind) {
                var m = box[kind];
                if (!m || !m.sid || !m.sdp) return;
                var k = from + '|' + kind;
                if (S.seenSig[k] === m.sid) return;
                S.seenSig[k] = m.sid;
                onSignal(from, kind, { sid: m.sid, sdp: m.sdp });
              });
            });
          }, function () { });

          try {
            db.ref('.info/connected').on('value', function (s) { if (s.val() && started) this.announce(); }.bind(this));
          } catch (e) { }

          started = true;
          this.announce();
          /* 1시간 넘은 옛 시그널 자국(앱이 강제 종료된 경우 등)은 조용히 치워요 */
          try {
            root.child('sig').once('value', function (snap) {
              var v = snap.val() || {}, t = now();
              Object.keys(v).forEach(function (pid) {
                if (pid === S.pid) return;
                var box = v[pid] || {}, latest = 0;
                Object.keys(box).forEach(function (from) {
                  var b = box[from] || {};
                  ['offer', 'answer'].forEach(function (k) { if (b[k] && b[k].ts > latest) latest = b[k].ts; });
                });
                if (latest && t - latest > 60 * 60 * 1000) {
                  try { root.child('sig/' + pid).remove().catch(function () { }); } catch (e) { }
                }
              });
            });
          } catch (e) { }
          return true;
        } catch (e) {
          return false;
        }
      },
      announce: function () {
        if (!myRef) return;
        try {
          myRef.update({
            who: S.who, micOn: S.micOn ? 1 : 0, ver: S.myVer,
            ts: now(), world: S.world || ''
          }).catch(function () { });
        } catch (e) { }
      },
      remove: function () {
        if (!root) return;
        try { if (myRef) myRef.remove().catch(function () { }); } catch (e) { }
        try { root.child('sig/' + S.pid).remove().catch(function () { }); } catch (e) { }
      },
      send: function (to, kind, data) {
        if (!root) return;
        try {
          root.child('sig/' + to + '/' + S.pid + '/' + kind)
            .set({ sid: data.sid, sdp: data.sdp, ts: now() }).catch(function () { });
        } catch (e) { }
      },
      /* 그 가족과 주고받던 시그널 자국을 지워요 (SDP 에는 IP 가 들어 있어요) */
      dropPeer: function (pid) {
        if (!root || !pid) return;
        try { root.child('sig/' + pid + '/' + S.pid).remove().catch(function () { }); } catch (e) { }
        try { root.child('sig/' + S.pid + '/' + pid).remove().catch(function () { }); } catch (e) { }
      },
      close: function () {
        try { if (root) { root.child('peers').off(); root.child('sig/' + S.pid).off(); } } catch (e) { }
      }
    };
  }

  function makeLocal() {
    var bc = null, cb = null, peers = {}, beat = 0;
    var name = 'wv-mesh-' + (qp('wvroom') || ROOM);
    try { bc = new BroadcastChannel(name); } catch (e) { bc = null; }
    function post(m) { try { if (bc) bc.postMessage(m); } catch (e) { } }
    function state() {
      if (S.idled) return;   /* 5분 무활동이면 내 자리를 비워 둬요 */
      post({ t: 'wv', pid: S.pid, who: S.who, micOn: S.micOn ? 1 : 0, ver: S.myVer, ts: now(), world: S.world });
    }
    function emit() {
      var t = now(), out = {};
      Object.keys(peers).forEach(function (pid) {
        var p = peers[pid];
        if (!p || t - (p.ts || 0) > 20000) { delete peers[pid]; return; }
        out[pid] = p;
      });
      if (cb) cb(out);
    }
    if (bc) {
      bc.onmessage = function (ev) {
        var m = ev.data;
        if (!m || !m.t) return;
        if (m.t === 'wv') {
          if (m.pid === S.pid) return;
          peers[m.pid] = { who: m.who, micOn: !!m.micOn, ver: m.ver || 0, ts: m.ts || now(), world: m.world || '' };
          emit();
        } else if (m.t === 'sig' && m.to === S.pid) {
          onSignal(m.from, m.kind, { sid: m.sid, sdp: m.sdp });
        } else if (m.t === 'bye') {
          delete peers[m.pid]; emit();
        }
      };
    }
    beat = setInterval(state, 1500);
    S.timers.push(beat);
    return {
      name: 'local',
      start: function (c) { cb = c; state(); setTimeout(emit, 40); return true; },
      announce: state,
      remove: function () { post({ t: 'bye', pid: S.pid }); },
      send: function (to, kind, data) { post({ t: 'sig', to: to, from: S.pid, kind: kind, sid: data.sid, sdp: data.sdp }); },
      dropPeer: function () { },
      close: function () { try { clearInterval(beat); } catch (e) { } try { if (bc) bc.close(); } catch (e) { } }
    };
  }

  /* ============================================================
     WebRTC 그물(mesh)
     ============================================================ */
  function desired(p) { return !!(S.micOn || (p && p.micOn)); }
  function pairKey(p) { return S.myVer + ':' + ((p && p.ver) || 0); }
  function isInitiator(pid) { return String(S.pid) < String(pid); }

  function onPeers(map) {
    S.peers = map || {};
    renderChips();
    syncMesh();
  }

  function syncMesh() {
    Object.keys(S.conns).forEach(function (pid) {
      var c = S.conns[pid], p = S.peers[pid];
      if (!c) return;
      if (!p) {
        /* 잠깐 안 보이는 것일 수 있어요(백그라운드 탭 등) — 20초는 기다려요 */
        if (!c.goneAt) c.goneAt = now();
        if (now() - c.goneAt > 20000) { try { if (S.transport && S.transport.dropPeer) S.transport.dropPeer(pid); } catch (e) { } closeConn(pid); }
        return;
      }
      if (!desired(p) || c.key !== pairKey(p)) { S.attempts[pid] = 0; closeConn(pid); }
    });
    Object.keys(S.peers).forEach(function (pid) {
      var p = S.peers[pid];
      if (!p || !desired(p)) return;
      var c = S.conns[pid];
      if (c && c.key === pairKey(p)) return;
      if (!isInitiator(pid)) return;
      if (S.retryT[pid]) return;              /* 다시 붙이는 중이면 기다려요 */
      connect(pid);
    });
  }

  function makePC(pid, sid, initiator) {
    var pc;
    try {
      pc = new RTCPeerConnection({ iceServers: STUN, iceCandidatePoolSize: 2 });
    } catch (e) {
      return null;
    }
    DBG.pc++;
    var c = { pid: pid, pc: pc, sid: sid, key: sid.split('#')[0], initiator: initiator, alive: true };
    S.conns[pid] = c;

    /* 보내는 쪽(마이크 ON)이면 내 목소리를, 아니면 듣기만 */
    if (S.stream && S.micOn) {
      S.stream.getAudioTracks().forEach(function (t) { try { pc.addTrack(t, S.stream); } catch (e) { } });
    } else if (initiator) {
      try { pc.addTransceiver('audio', { direction: 'recvonly' }); } catch (e) { }
    }

    pc.ontrack = function (ev) {
      var stream = (ev.streams && ev.streams[0]) ? ev.streams[0] : new MediaStream([ev.track]);
      attachRemote(pid, stream);
    };
    pc.onconnectionstatechange = function () {
      if (!c.alive) return;
      var st = pc.connectionState;
      if (st === 'connected') { S.retryT[pid] = 0; S.attempts[pid] = 0; }
      else if (st === 'failed') retryConn(pid, c);
      renderChips();
    };
    return c;
  }

  function connect(pid) {
    var p = S.peers[pid];
    if (!p) return;
    var key = pairKey(p);
    S.attempts[pid] = (S.attempts[pid] || 0) + 1;
    var sid = key + '#' + S.attempts[pid];
    var c = makePC(pid, sid, true);
    if (!c) { dbgErr('makePC', 'null'); return; }
    var pc = c.pc;
    var abort = setTimeout(function () { if (c.alive && pc.signalingState === 'have-local-offer' && !pc.remoteDescription) retryConn(pid, c); }, 9000);

    pc.createOffer()
      .then(function (off) { return pc.setLocalDescription(off); })
      .then(function () { return waitIce(pc, 2400); })
      .then(function () {
        if (!c.alive || !pc.localDescription) return;
        if (!pc.remoteDescription) {
          DBG.offerOut++;
          S.transport.send(pid, 'offer', { sid: sid, sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
        }
      })
      .catch(function (e) { dbgErr('offer', e); clearTimeout(abort); retryConn(pid, c); });
  }

  function waitIce(pc, ms) {
    return new Promise(function (resolve) {
      if (pc.iceGatheringState === 'complete') return resolve();
      var done = false;
      function fin() { if (!done) { done = true; try { pc.removeEventListener('icegatheringstatechange', ch); } catch (e) { } resolve(); } }
      function ch() { if (pc.iceGatheringState === 'complete') fin(); }
      try { pc.addEventListener('icegatheringstatechange', ch); } catch (e) { }
      setTimeout(fin, ms || 2400);
    });
  }

  function onSignal(from, kind, data) {
    if (!data || !data.sid || !data.sdp) return;
    var cur = S.conns[from];
    var key = String(data.sid).split('#')[0];

    if (kind === 'offer') {
      DBG.offerIn++;
      var p = S.peers[from];
      /* 이제 필요 없어진 연결이면(마이크 다 꺼짐) 무시 */
      if (p && !desired(p)) return;
      if (cur) closeConn(from);
      var c = makePC(from, data.sid, false);
      if (!c) { dbgErr('makePC-answer', 'null'); return; }
      var pc = c.pc;
      pc.setRemoteDescription(new RTCSessionDescription(data.sdp))
        .then(function () { return pc.createAnswer(); })
        .then(function (ans) { return pc.setLocalDescription(ans); })
        .then(function () { return waitIce(pc, 2400); })
        .then(function () {
          if (!c.alive || !pc.localDescription) return;
          DBG.answerOut++;
          S.transport.send(from, 'answer', { sid: data.sid, sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
        })
        .catch(function (e) { dbgErr('answer', e); closeConn(from); });
      return;
    }

    if (kind === 'answer') {
      DBG.answerIn++;
      if (!cur || cur.sid !== data.sid || !cur.initiator) return;
      if (cur.pc.remoteDescription) return;
      cur.pc.setRemoteDescription(new RTCSessionDescription(data.sdp)).catch(function () { retryConn(from, cur); });
    }
  }

  function retryConn(pid, c) {
    if (!c || !c.alive) return;
    var p = S.peers[pid];
    closeConn(pid);
    if (!p || !desired(p) || !isInitiator(pid)) return;
    var n = S.attempts[pid] || 0;
    if (n > 6) return;
    clearTimeout(S.retryT[pid]);
    S.retryT[pid] = setTimeout(function () {
      S.retryT[pid] = 0;
      if (S.peers[pid] && desired(S.peers[pid]) && !S.conns[pid]) connect(pid);
    }, 1600 + Math.random() * 900);
  }

  function closeConn(pid) {
    var c = S.conns[pid];
    if (c) {
      c.alive = false;
      try { c.pc.ontrack = null; c.pc.onconnectionstatechange = null; } catch (e) { }
      try { c.pc.close(); } catch (e) { }
      delete S.conns[pid];
    }
    detachRemote(pid);
    renderChips();
  }

  function closeAllConns() {
    Object.keys(S.conns).forEach(closeConn);
  }

  /* ---------- 상대 목소리 재생 + 말하는지 감지 ---------- */
  function attachRemote(pid, stream) {
    var a = S.audios[pid];
    if (!a) {
      a = document.createElement('audio');
      a.autoplay = true;
      a.setAttribute('playsinline', '');
      a.style.display = 'none';
      a.dataset.wv = pid;
      (document.body || document.documentElement).appendChild(a);
      S.audios[pid] = a;
    }
    try { a.srcObject = stream; } catch (e) { }
    playAudio(a);
    try { setupAnalyser(pid, stream); } catch (e) { }
  }

  function playAudio(a) {
    try {
      var pr = a.play();
      if (pr && pr.catch) pr.catch(function () { S.audioBlocked = true; });
    } catch (e) { S.audioBlocked = true; }
  }

  function unlockAudio() {
    if (S.ac && S.ac.state === 'suspended') { try { S.ac.resume(); } catch (e) { } }
    Object.keys(S.audios).forEach(function (pid) { playAudio(S.audios[pid]); });
  }

  function detachRemote(pid) {
    var a = S.audios[pid];
    if (a) { try { a.srcObject = null; } catch (e) { } try { a.parentNode.removeChild(a); } catch (e) { } delete S.audios[pid]; }
    if (S.analysers[pid]) {
      try { S.analysers[pid].src.disconnect(); } catch (e) { }
      delete S.analysers[pid];
    }
    delete S.speaking[pid];
  }

  function setupAnalyser(pid, stream) {
    var AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return;
    if (!S.ac) { try { S.ac = new AC(); } catch (e) { S.ac = null; } }
    if (!S.ac) return;
    if (S.ac.state === 'suspended') { try { S.ac.resume(); } catch (e) { } }
    if (S.analysers[pid]) { try { S.analysers[pid].src.disconnect(); } catch (e) { } }
    var src, an;
    try {
      src = S.ac.createMediaStreamSource(stream);
      an = S.ac.createAnalyser();
      an.fftSize = 512;
      an.smoothingTimeConstant = 0.6;
      src.connect(an);
    } catch (e) { return; }
    S.analysers[pid] = { src: src, an: an, buf: new Uint8Array(an.fftSize) };
  }

  function isSpeaking(pid) { return !!S.speaking[pid] && (now() - S.speaking[pid] < 1100); }

  var levelT = 0;
  function pollLevels() {
    var any = false;
    Object.keys(S.analysers).forEach(function (pid) {
      var o = S.analysers[pid];
      if (!o) return;
      any = true;
      try {
        o.an.getByteTimeDomainData(o.buf);
        var sum = 0;
        for (var i = 0; i < o.buf.length; i++) { var v = (o.buf[i] - 128) / 128; sum += v * v; }
        var rms = Math.sqrt(sum / o.buf.length);
        if (rms > 0.035) S.speaking[pid] = now();
      } catch (e) { }
    });
    if (any) renderChips();
  }

  /* ============================================================
     마이크 ON / OFF
     ============================================================ */
  function blockedNow() {
    var sel = S.cfg && S.cfg.blockSel;
    if (!sel) return false;
    try { return !!document.querySelector(sel); } catch (e) { return false; }
  }

  function micErrText(e) {
    var n = (e && e.name) || '';
    if (n === 'NotAllowedError' || n === 'SecurityError') return 'Chrome에서 마이크 허용을 눌러 주세요! (주소창 옆 🔒 → 마이크 허용)';
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return '마이크를 찾지 못했어요. 기기에 마이크가 있는지 확인해 주세요.';
    if (n === 'NotReadableError' || n === 'AbortError') return '다른 앱이 마이크를 쓰고 있어요. 그 앱을 닫고 다시 눌러 주세요.';
    if (n === 'NotSupportedError') return '이 창에선 마이크를 못 열어요. Chrome에서 열고 마이크 허용을 눌러 주세요!';
    return '마이크를 켜지 못했어요. 잠시 뒤에 다시 눌러 주세요.';
  }

  function toggle() {
    if (S.micBusy) return;
    if (S.micOn) micOff('user');
    else micOn();
  }

  function micOn() {
    if (S.micBusy) return;

    if (blockedNow()) {
      toast('하은이랑 이야기하는 중엔 마이크를 같이 켤 수 없어요. 대화를 끝내고 눌러 주세요!', 3600);
      return;
    }
    if (IN_APP) {
      toast('카톡·네이버 앱 안에서는 마이크가 안 열려요. Chrome으로 열어 주세요! 🙂', 4000);
      return;
    }
    var md = navigator.mediaDevices;
    if (!md || !md.getUserMedia) {
      toast('이 브라우저에서는 마이크를 쓸 수 없어요. Chrome에서 열어 주세요!', 4000);
      return;
    }

    S.micBusy = true; render();
    var req;
    try {
      req = md.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false
      });
    } catch (e) { S.micBusy = false; render(); toast(micErrText(e), 4000); return; }

    req.then(function (stream) {
      S.stream = stream;
      stream.getAudioTracks().forEach(function (t) {
        try { t.enabled = true; } catch (e) { }
        t.onended = function () { if (S.micOn) micOff('ended'); };
      });
      S.micOn = true; S.micBusy = false; S.myVer++;
      S.idled = false; S.lastAct = now();
      render();
      if (S.transport) { S.transport.announce(); syncMesh(); }
      unlockAudio();
      toast('🎙️ 마이크 켜짐! 이야기해 보세요', 2200);
    }).catch(function (err) {
      S.micBusy = false; S.micOn = false; render();
      dbgErr('mic:' + ((err && err.name) || '?'), err);
      toast(micErrText(err), 4200);
    });
  }

  function micOff(reason) {
    S.micOn = false;
    S.micBusy = false;
    if (S.stream) {
      S.stream.getTracks().forEach(function (t) {
        try { t.enabled = false; } catch (e) { }
        try { t.stop(); } catch (e) { }
      });
    }
    S.stream = null;
    S.myVer++;
    closeAllConns();
    render();
    if (S.transport) { S.transport.announce(); syncMesh(); }
    if (reason === 'user') toast('마이크 껐어요 🔇', 1800);
    else if (reason === 'idle') toast('5분 동안 조용해서 마이크를 껐어요 💤', 3200);
    else if (reason === 'blocked') toast('하은이 대화 중이라 마이크를 잠깐 껐어요 🎤', 3000);
  }

  /* ============================================================
     시작
     ============================================================ */
  function start() {
    if (S.started) return;
    S.started = true;
    S.who = detectWho();
    S.pid = S.who + '_' + rnd(5);
    S.world = (S.cfg && S.cfg.world) || '';

    try { buildUI(); } catch (e) { }

    /* 시험 모드에서는 Firebase 에 절대 쓰지 않아요 */
    S.transport = TEST ? makeLocal() : makeFirebase();
    var ok = false;
    try { ok = S.transport.start(onPeers); } catch (e) { ok = false; }
    if (!ok && !TEST) {
      /* SDK 가 아직 안 떴으면 잠깐 기다렸다 다시 (인터넷 느릴 때) */
      var tries = 0;
      var t = setInterval(function () {
        tries++;
        var done = false;
        try { done = S.transport.start(onPeers); } catch (e) { done = false; }
        if (done || tries > 20) clearInterval(t);
      }, 800);
      S.timers.push(t);
    }

    /* 하트비트 */
    S.timers.push(setInterval(function () {
      if (!S.micOn && S.idled) return;
      if (S.transport) S.transport.announce();
    }, 20000));

    /* 상대 목소리 크기 감지 */
    S.timers.push(setInterval(pollLevels, 300));

    /* 하은이 대화처럼 마이크를 같이 쓰는 창이 열리면 안전하게 OFF */
    S.timers.push(setInterval(function () {
      if (blockedNow() && S.micOn) micOff('blocked');
      renderChips();
    }, 700));

    /* 캐릭터 변경(누구로 놀까요) 따라가기 */
    S.timers.push(setInterval(function () {
      var w = detectWho();
      if (w !== S.who) {
        if (S.micOn) micOff('switch');
        S.who = w;
        S.myVer++;
        if (S.transport) S.transport.announce();
        render();
      }
    }, 1500));

    /* 5분 무활동이면 마이크 OFF + 내 노드 정리 */
    S.timers.push(setInterval(function () {
      if (now() - S.lastAct < IDLE_MS) return;
      if (S.micOn) micOff('idle');
      if (!S.idled) { S.idled = true; try { S.transport.remove(); } catch (e) { } renderChips(); }
    }, 5000));

    S.ready = true;
    render();
  }

  function markActive() {
    S.lastAct = now();
    /* 화면을 한 번이라도 만지면 상대 목소리가 막혀 있던 것도 풀어요 */
    if (S.audioBlocked) { S.audioBlocked = false; unlockAudio(); }
    if (S.idled) {
      S.idled = false;
      if (S.transport) S.transport.announce();
    }
  }
  ['pointerdown', 'keydown', 'touchstart', 'focus'].forEach(function (ev) {
    try { document.addEventListener(ev, markActive, { capture: true, passive: true }); } catch (e) { }
  });

  function cleanup() {
    try {
      if (S.transport && S.transport.dropPeer) {
        Object.keys(S.peers).forEach(function (pid) { try { S.transport.dropPeer(pid); } catch (e) { } });
      }
    } catch (e) { }
    try { if (S.micOn || !S.idled) { if (S.transport) S.transport.remove(); } } catch (e) { }
    try { closeAllConns(); } catch (e) { }
    try { if (S.stream) S.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { } }); } catch (e) { }
    try { if (S.transport) S.transport.close(); } catch (e) { }
  }
  global.addEventListener('pagehide', cleanup);
  global.addEventListener('beforeunload', cleanup);

  /* ============================================================
     바깥에 내놓는 것
     ============================================================ */
  function init(cfg) {
    S.cfg = cfg || {};
    if (cfg && cfg.world) S.world = cfg.world;
    if (S.started) { if (S.transport) S.transport.announce(); render(); }
    else start();
  }

  var API = {
    version: VERSION,
    init: init,
    toggle: toggle,
    on: micOn,
    off: function () { micOff('api'); },
    isOn: function () { return S.micOn; },
    peers: function () { return peerList(); },
    test: TEST,
    state: function () {
      return {
        test: TEST, inApp: IN_APP, ready: S.ready, who: S.who, pid: S.pid,
        micOn: S.micOn, micBusy: S.micBusy, ver: S.myVer, idled: S.idled,
        blocked: blockedNow(), transport: S.transport ? S.transport.name : '',
        tracks: S.stream ? S.stream.getAudioTracks().map(function (t) { return { enabled: t.enabled, state: t.readyState }; }) : [],
        peers: peerList(),
        conns: Object.keys(S.conns).map(function (pid) {
          return { pid: pid, state: S.conns[pid].pc.connectionState, initiator: S.conns[pid].initiator };
        }),
        audios: Object.keys(S.audios).length,
        dbg: { offerIn: DBG.offerIn, offerOut: DBG.offerOut, answerIn: DBG.answerIn, answerOut: DBG.answerOut, pc: DBG.pc, err: DBG.err.slice() }
      };
    },
    /* 연결 상태 자세히 보기 (문제 생겼을 때 콘솔에서 __WV.dump()) */
    dump: function () {
      return Object.keys(S.conns).map(function (pid) {
        var c = S.conns[pid], pc = c.pc;
        function n(sdp) { return sdp ? (sdp.match(/^a=candidate/gm) || []).length : 0; }
        function kinds(sdp) {
          if (!sdp) return [];
          return sdp.split('\n').filter(function (l) { return l.indexOf('a=candidate') === 0; }).map(function (l) {
            var p = l.split(' ');
            return (p[7] || '?') + '/' + (p[2] || '?') + '/' + ((/\.local$/i.test(p[4] || '') || /^[0-9a-f-]+\.local$/i.test(p[4] || '')) ? 'mdns' : (p[4] || '?'));
          });
        }
        return {
          pid: pid, sid: c.sid, initiator: c.initiator,
          conn: pc.connectionState, ice: pc.iceConnectionState, sig: pc.signalingState, gather: pc.iceGatheringState,
          lcand: n(pc.localDescription && pc.localDescription.sdp),
          rcand: n(pc.remoteDescription && pc.remoteDescription.sdp),
          lkinds: kinds(pc.localDescription && pc.localDescription.sdp),
          rkinds: kinds(pc.remoteDescription && pc.remoteDescription.sdp)
        };
      });
    }
  };

  global.WorldVoice = API;
  global.__WV = API;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { start(); });
  } else {
    start();
  }
})(window);
