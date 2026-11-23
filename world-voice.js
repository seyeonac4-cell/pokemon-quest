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

   v1.5 (2026-11-23)
     · 마이크 자리를 화면 아래 → 화면 위(HUD·안내 띠 바로 아래)로 옮김
       — 미니게임 방향 버튼(D-pad)·점프·행동 버튼을 가리지 않게
     · 알약 크기를 조금 줄이고, 칩·상태·안내는 마이크 아래로 자라게
   v1.4 (2026-11-23)
     · 화면 아래에 "지금 상대 목소리가 들리는지"를 또렷하게 표시
       (형원 마이크가 꺼져 있어요 / 연결 중 / 🔊 듣는 중 / 새로고침 필요)
     · 가족 칩에 마이크 꺼진 사람은 이름 + 🔇 로 표시, 꺼지면 토스트로 알림
     · 서로 판(version)을 주고받아 옛 판이면 "새로고침 필요"를 알려 줌
     · 상대 중계 소리가 막히면 스스로 살려요 (멈춤 감지 → 머리말부터 다시,
       그래도 안 되면 Web Audio 로 직접 풀어 재생 — MSE 가 안 되는 기기 대비)
     · 소리를 막는 브라우저 정책에 걸리면 1.3초마다 다시 재생 시도(🔊 버튼도 같이)
     · 내 목소리가 연결에 안 실렸으면 다시 맺어서 양쪽 다 보내게 함
     · worldVoice/diag/{pid} 에 기기 진단(버전·수신 상태·마이크 크기)을
       10초마다 짧게 남김 — 안 들릴 때 원인을 바로 볼 수 있음
   ============================================================ */
(function (global) {
  'use strict';
  if (global.WorldVoice && global.WorldVoice.version) return;

  var VERSION = '1.5';
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

  /* TURN 서버(중계 서버) — 없어도 아래 RTDB 보조 중계가 있어요.
     나중에 TURN 계정을 만들면 주소창에
       ?turn=turn:서버:443?transport=tcp|turn:서버:3478&turnu=아이디&turnp=비번
     으로 넣거나, 기기 저장값(wv_turn_v1)에 넣으면 그대로 씁니다. */
  var TURN_PRESET = [];

  function iceServers() {
    var list = STUN.slice();
    var extra = [];
    try {
      var tu = qp('turn');
      if (tu) extra.push({ urls: tu.split('|'), username: qp('turnu') || '', credential: qp('turnp') || '' });
    } catch (e) { }
    try {
      var s = safeGet('wv_turn_v1');
      if (s) { var arr = JSON.parse(s); if (arr && arr.length) extra = arr.concat(extra); }
    } catch (e) { }
    return list.concat(extra, TURN_PRESET);
  }

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

  /* ?wvroom=시험방 — 주소창에 넣으면 가족방(main) 대신 다른 방을 써서
     실제 데이터를 더럽히지 않고 시험할 수 있어요 */
  var ROOM_OVR = qp('wvroom');
  if (ROOM_OVR) ROOM = ROOM_OVR;

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
    audios: {}, analysers: {}, speaking: {}, heard: {}, level: {},
    transport: null, seenSig: {}, candBox: {}, idled: false, lastAct: now(),
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
  var el = { bar: null, chips: null, mic: null, ico: null, txt: null, toast: null, stat: null, unmute: null };
  var toastT = 0;

  function injectStyle() {
    if (document.getElementById('wv-style')) return;
    var st = document.createElement('style');
    st.id = 'wv-style';
    st.textContent = [
      '#wv-bar{position:fixed;left:50%;transform:translateX(-50%);',
      'top:calc(var(--wv-ty,8px) + env(safe-area-inset-top,0px));',
      'z-index:2147483002;display:flex;flex-direction:column;align-items:center;gap:4px;pointer-events:none;',
      'font-family:"Jua","Pretendard Variable",-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;',
      '-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent}',
      /* 위에서 아래로: 마이크 → 소리 듣기 → 가족 칩 → 상태 → 알림 (아래로 자라요) */
      '#wv-mic{order:1}#wv-unmute{order:2}#wv-chips{order:3}#wv-stat{order:4}#wv-toast{order:5}',

      '#wv-toast{max-width:70vw;padding:0 14px;height:0;border-radius:12px;background:rgba(38,28,60,.93);color:#fff;',
      'font-size:12px;font-weight:800;line-height:1.35;letter-spacing:-.02em;text-align:center;',
      'box-shadow:0 8px 22px rgba(20,10,40,.32);opacity:0;overflow:hidden;transition:opacity .2s;',
      'pointer-events:none;word-break:keep-all}',
      '#wv-toast.show{opacity:1;height:auto;padding:7px 14px}',

      '#wv-chips{display:flex;align-items:center;gap:4px;min-height:0;pointer-events:none}',
      '.wv-chip{display:inline-flex;align-items:center;gap:2px;height:21px;padding:0 6px 0 4px;border-radius:999px;',
      'background:rgba(255,255,255,.93);border:1.5px solid rgba(150,165,195,.32);color:#4d5c7a;',
      'font-size:10.5px;font-weight:800;letter-spacing:-.02em;white-space:nowrap;',
      'box-shadow:0 3px 9px rgba(30,50,80,.16);transition:background .2s,border-color .2s,transform .2s}',
      '.wv-chip .e{font-size:13px;line-height:1}',
      '.wv-chip .n{font-size:10.5px}',
      '.wv-chip .x{font-size:9.5px;opacity:.9;margin-left:-1px}',
      '.wv-chip.on{background:linear-gradient(180deg,#ecfff8,#c9f7e5);border-color:#4fdcb2;color:#0d6b4c}',
      '.wv-chip.off{background:rgba(255,255,255,.86);border-style:dashed;color:#8b98b1}',
      '.wv-chip.spk{animation:wv-spk .9s ease-in-out infinite;border-color:#25c79a}',
      '.wv-chip.wait{background:rgba(255,255,255,.82);color:#7b88a3;border-style:dashed}',
      '@keyframes wv-spk{0%,100%{transform:scale(1);box-shadow:0 3px 9px rgba(30,50,80,.16)}',
      '50%{transform:scale(1.07);box-shadow:0 0 0 3px rgba(63,214,176,.42),0 4px 14px rgba(20,130,95,.3)}}',

      '#wv-mic{pointer-events:auto;display:inline-flex;align-items:center;gap:4px;height:33px;padding:0 11px;',
      'border-radius:999px;border:2px solid #fff;background:rgba(255,255,255,.96);color:#4a5a78;',
      'font-family:inherit;font-size:12px;font-weight:800;letter-spacing:-.02em;white-space:nowrap;',
      'box-shadow:0 6px 16px rgba(30,50,80,.22);transition:transform .1s,background .2s,box-shadow .2s,color .2s;',
      'cursor:pointer;touch-action:manipulation}',
      '#wv-mic:active{transform:scale(.95)}',
      '#wv-mic .wv-ico{font-size:15px;line-height:1}',
      '#wv-mic .wv-dot{width:7px;height:7px;border-radius:50%;background:#b9c4d8;box-shadow:0 0 0 2px rgba(185,196,216,.25)}',
      '#wv-bar[data-on="1"] #wv-mic{background:linear-gradient(180deg,#84f3ca,#2ecf9c);color:#054433;border-color:#fff;',
      'box-shadow:0 0 0 3px rgba(63,214,176,.34),0 8px 20px rgba(18,150,110,.42);animation:wv-pulse 2.2s ease-in-out infinite}',
      '#wv-bar[data-on="1"] #wv-mic .wv-dot{background:#0c9d72;box-shadow:0 0 0 2px rgba(12,157,114,.22)}',
      '@keyframes wv-pulse{0%,100%{box-shadow:0 0 0 3px rgba(63,214,176,.30),0 8px 20px rgba(18,150,110,.40)}',
      '50%{box-shadow:0 0 0 6px rgba(63,214,176,.16),0 10px 26px rgba(18,150,110,.52)}}',
      '#wv-bar[data-busy="1"] #wv-mic{opacity:.72}',

      '#wv-stat{display:none;align-items:center;gap:3px;height:21px;padding:0 8px;border-radius:999px;',
      'background:rgba(24,18,40,.82);color:#fff;font-size:10.5px;font-weight:800;letter-spacing:-.02em;',
      'white-space:nowrap;pointer-events:none;box-shadow:0 3px 10px rgba(20,10,40,.25)}',
      '#wv-stat.show{display:inline-flex}',
      '#wv-stat.ok{background:linear-gradient(180deg,#eafff7,#c9f7e5);color:#0d6b4c}',
      '#wv-stat.relay{background:linear-gradient(180deg,#fff6e0,#ffe0a3);color:#7a4d00}',
      '#wv-stat.wait{background:rgba(24,18,40,.82);color:#ffd166}',

      '#wv-unmute{display:none;pointer-events:auto;align-items:center;gap:4px;height:30px;padding:0 12px;',
      'border-radius:999px;border:0;background:linear-gradient(180deg,#ffd166,#ffb020);color:#4a2c00;',
      'font-family:inherit;font-size:12.5px;font-weight:800;box-shadow:0 6px 16px rgba(150,90,0,.3);',
      'cursor:pointer;touch-action:manipulation;animation:wv-blink 1.6s ease-in-out infinite}',
      '#wv-unmute:active{filter:brightness(.94)}',
      '#wv-unmute.show{display:inline-flex}',
      '@keyframes wv-blink{0%,100%{box-shadow:0 6px 16px rgba(150,90,0,.3)}50%{box-shadow:0 6px 22px rgba(255,170,40,.85)}}',

      '@media (min-width:820px){#wv-bar{gap:6px}}'
    ].join('');
    (document.head || document.documentElement).appendChild(st);
  }

  /* ---------- 어디에 앉힐까 ----------
     예전엔 화면 아래 가운데(bottom:56px)에 있었는데, 그 자리가 바로
     아이들 미니게임의 방향 버튼(D-pad)·점프 버튼·행동 버튼 자리라서
     마이크가 방향 버튼을 가렸어요. 이제는 화면 위쪽 띠(HUD·안내 띠·
     미니게임 머리) 바로 아래 빈 곳에 앉혀요.
       · 가로로 겹치는 띠만 피하고, 화면 높이의 30%를 넘어가면 멈춤
       · 화면을 통째로 덮는 판(캔버스 껍데기)은 장애물로 안 셈
       · 마이크를 켜면 칩·상태가 "아래로" 자라서 위로는 안 올라감 */
  var CHROME_SEL = ['#hud', '.hud', 'header.top', '.topbar', '.top-bar',
                    '#hint', '#tipBar', '.tipbar', '#fairyBub', '#worldBar', '.worldbar',
                    '.mhead', '.mgTop',
                    /* 방 안에서 눌러 들어가는 자리(포털)·말걸기 창도 안 가리게 */
                    '.zone', '[data-zone]', '[data-mzone]', '#prompt'];
  var barTy = null;
  function setBarTy(v) {
    barTy = v;
    if (el.bar) el.bar.style.setProperty('--wv-ty', v + 'px');
  }
  /* 지금 화면을 덮고 있는 판(시작 창·미니게임) 찾기
     — 그 판 밖의 띠(가려진 HUD·안내)는 장애물로 안 셈. */
  var DIALOG_SEL = ['#starter', '.miniwrap', '.modal', '.overlay', '.sheet', '.sheetwrap'];
  function openDialog() {
    var vw = window.innerWidth, vh = window.innerHeight;
    for (var k = 0; k < DIALOG_SEL.length; k++) {
      var list;
      try { list = document.querySelectorAll(DIALOG_SEL[k]); } catch (e) { list = []; }
      for (var i = 0; i < list.length; i++) {
        var d = list[i], cs = getComputedStyle(d);
        if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.05) continue;
        var r = d.getBoundingClientRect();
        if (r.width >= vw * 0.85 && r.height >= vh * 0.85) return d;
      }
    }
    return null;
  }
  function placeBar() {
    if (!el.bar) return;
    var vh = window.innerHeight || document.documentElement.clientHeight || 800;
    var lim = Math.max(48, Math.min(vh * 0.30, 260));
    var root = openDialog();
    var nodes = [];
    for (var k = 0; k < CHROME_SEL.length; k++) {
      var list;
      try { list = document.querySelectorAll(CHROME_SEL[k]); } catch (e) { list = []; }
      for (var i = 0; i < list.length; i++) {
        if (root && !root.contains(list[i])) continue;
        nodes.push(list[i]);
      }
    }
    setBarTy(8);
    for (var pass = 0; pass < 8; pass++) {
      var r = el.bar.getBoundingClientRect();
      if (!r.width) return;
      var low = 0;
      for (var n = 0; n < nodes.length; n++) {
        var nb = nodes[n].getBoundingClientRect();
        if (nb.width < 8 || nb.height < 8) continue;
        if (nb.height > vh * 0.35) continue;             /* 화면을 덮는 껍데기는 건너뜀 */
        if (nb.bottom <= r.top + 2) continue;            /* 이미 위에 있음 */
        if (nb.top >= lim) continue;                     /* 너무 아래 띠는 무시 */
        if (nb.right < r.left + 6 || nb.left > r.right - 6) continue;  /* 가로로 안 겹침 */
        if (nb.bottom > low) low = nb.bottom;
      }
      if (!low) break;
      var next = Math.min(lim, Math.round(low) + 6);
      if (next <= barTy + 0.5) break;
      setBarTy(next);
    }
  }
  var placeT = 0;
  function placeSoon(ms) {
    if (placeT) return;
    placeT = setTimeout(function () {
      placeT = 0;
      try { placeBar(); } catch (e) { }
      /* 창이 서서히 닫히는 동안(0.4초)에도 한 번 더 */
      setTimeout(function () { try { placeBar(); } catch (e) { } }, 900);
      setTimeout(function () { try { placeBar(); } catch (e) { } }, 2200);
    }, ms || 400);
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

    var stat = document.createElement('div');
    stat.id = 'wv-stat';

    var mic = document.createElement('button');
    mic.id = 'wv-mic';
    mic.type = 'button';
    mic.setAttribute('aria-pressed', 'false');
    mic.setAttribute('aria-label', '마이크 켜기');
    mic.innerHTML = '<span class="wv-ico">🎙️</span><span class="wv-txt">마이크</span><span class="wv-dot"></span>';

    var un = document.createElement('button');
    un.id = 'wv-unmute';
    un.type = 'button';
    un.textContent = '🔊 소리 듣기';

    bar.appendChild(toast);
    bar.appendChild(stat);
    bar.appendChild(chips);
    bar.appendChild(mic);
    bar.appendChild(un);
    (document.body || document.documentElement).appendChild(bar);

    el.bar = bar; el.toast = toast; el.chips = chips; el.mic = mic;
    el.stat = stat; el.unmute = un;
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
    un.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      S.audioBlocked = false;
      unlockAudio();
      render();
      toast('🔊 소리를 켰어요', 1600);
    });
    render();
    placeBar();
    setTimeout(placeBar, 350);
    setTimeout(placeBar, 1200);
  }

  function toast(msg, ms) {
    if (!el.toast) return;
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(function () { if (el.toast) el.toast.classList.remove('show'); }, ms || 3000);
  }

  /* 가족 마이크가 꺼지거나 켜지면 한 번씩 알려 줘요
     ("왜 안 들리지" 싶을 때 화면만 봐도 알 수 있게) */
  var micSnap = {};
  function checkPeerMics() {
    var cur = {};
    Object.keys(S.peers).forEach(function (pid) {
      var p = S.peers[pid];
      if (!p || !p.who) return;
      cur[p.who] = cur[p.who] || !!p.micOn;
    });
    Object.keys(cur).forEach(function (who) {
      if (!(who in micSnap)) { micSnap[who] = cur[who]; return; }
      if (micSnap[who] && !cur[who]) toast(person(who).name + ' 마이크가 꺼졌어요 🔇 (그 폰에서 🎙️를 눌러야 들려요)', 3600);
      else if (!micSnap[who] && cur[who] && S.micOn) toast(person(who).name + ' 마이크 켜짐 🔉', 2000);
      micSnap[who] = cur[who];
    });
    Object.keys(micSnap).forEach(function (who) { if (!(who in cur)) delete micSnap[who]; });
  }

  var announceT = 0;
  function announceSoon() {
    if (announceT) return;
    announceT = setTimeout(function () {
      announceT = 0;
      try { if (S.transport) S.transport.announce(); } catch (e) { }
    }, 80);
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
    renderStat();
    renderChips();
  }

  /* 연결 상태 한 줄: 상대 마이크 꺼짐 / 옛 버전 / 연결 중 / 수신 중 */
  function peerNames(pidList) {
    var seen = {}, out = [];
    pidList.forEach(function (pid) {
      var p = S.peers[pid];
      if (!p || !p.who || seen[p.who]) return;
      seen[p.who] = 1;
      out.push(person(p.who).name);
    });
    return out.length ? out.join('·') : '가족';
  }
  function micOnPeers() {
    return Object.keys(S.peers).filter(function (pid) { return S.peers[pid] && S.peers[pid].micOn; });
  }
  function verNum(v) {
    var n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.]/g, ''));
    return isNaN(n) ? 0 : n;
  }
  /* 새 버전은 서로 판(version)을 알려 줘요 — 옛 판이면 "새로고침 필요"를 보여 줘요 */
  function isOldPeer(p) {
    if (!p) return false;
    if (!p.v) return true;
    return verNum(p.v) < verNum(VERSION) - 0.001;
  }
  function oldVerPeers() {
    return Object.keys(S.peers).filter(function (pid) {
      var p = S.peers[pid];
      if (!p || !p.micOn) return false;
      return isOldPeer(p);
    });
  }
  /* 지금 실제로 상대 목소리가 재생되고 있나 — WebRTC 소리 / 연결 / 중계 */
  /* WebRTC 로 연결됐고 상대 목소리 크기가 잡히나 */
  function p2pSound() {
    return Object.keys(S.conns).some(function (pid) {
      if (!p2pConnected(pid)) return false;
      return (S.level[pid] || 0) > 0.006;
    });
  }
  function p2pLive() {
    return Object.keys(S.conns).some(function (pid) { return p2pConnected(pid); });
  }
  function receivingNow() {
    if (p2pSound()) return 'sound';
    if (p2pLive()) return 'link';
    var relay = Object.keys(RLY.rx).some(function (pid) {
      var R = RLY.rx[pid];
      if (!R) return false;
      if (R.dmode) return (R.decN || 0) > 0 && (now() - (R.decAt || 0) < 3500) && (!S.ac || S.ac.state === 'running');
      return !!(R.audio && !R.audio.paused && (now() - (R.lastChunkAt || 0) < 3500));
    });
    return relay ? 'sound' : '';
  }
  function statusOf() {
    var micPeers = micOnPeers();
    var olds = oldVerPeers();
    var anyPeer = Object.keys(S.peers).length > 0;
    var hear = receivingNow();
    if (S.audioBlocked) return { t: '🔇 소리가 막혔어요 — 🔊 버튼을 눌러 주세요', k: 'wait' };
    if (anyPeer && !micPeers.length) return { t: '🔇 ' + peerNames(Object.keys(S.peers)) + ' 마이크가 꺼져 있어요', k: 'wait' };
    if (hear === 'sound') return { t: '🔊 ' + peerNames(micPeers) + ' 목소리 듣는 중', k: 'ok' };
    if (olds.length) return { t: '⚠️ ' + peerNames(olds) + ' 폰은 새로고침이 필요해요', k: 'wait' };
    if (hear === 'link') return { t: '🔗 ' + peerNames(micPeers) + ' 연결됨 · 말하면 들려요', k: 'ok' };
    if (micPeers.length) return { t: '⏳ ' + peerNames(micPeers) + ' 목소리 연결 중…', k: 'relay' };
    if (S.micOn) return { t: '가족을 기다리는 중', k: 'wait' };
    return null;
  }

  var statSig = '#';
  function anyPausedRemote() {
    var list = Object.keys(S.audios).map(function (pid) { return S.audios[pid]; });
    Object.keys(RLY.rx).forEach(function (pid) { var R = RLY.rx[pid]; if (R && R.audio) list.push(R.audio); });
    return list.some(function (a) {
      try { return !!(a && a.paused && (a.srcObject || a.src)); } catch (e) { return false; }
    });
  }
  function renderStat() {
    if (!el.stat) return;
    var st = statusOf();
    var needsUn = S.audioBlocked || anyPausedRemote();
    var sig = (st ? st.t + '|' + st.k : '-') + (needsUn ? '|u' : '');
    if (sig === statSig) return;
    statSig = sig;
    if (st) {
      el.stat.textContent = st.t;
      el.stat.className = 'show ' + st.k;
    } else {
      el.stat.textContent = '';
      el.stat.className = '';
    }
    if (el.unmute) {
      if (needsUn) el.unmute.classList.add('show');
      else el.unmute.classList.remove('show');
    }
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

  /* 말하는 중이면 반짝, 마이크가 꺼진 가족은 이름 + 🔇 로 보여 줘요 */
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
      c.className = 'wv-chip' + (it.micOn ? ' on' : ' off') + (it.speaking ? ' spk' : '');
      c.setAttribute('title', p.name + (it.micOn ? ' · 마이크 켜짐' : ' · 마이크 꺼짐(이 사람 목소리는 안 들려요)'));
      c.innerHTML = '<span class="e">' + p.emo + '</span><span class="n">' + p.name + '</span>' +
                    (it.micOn ? '' : '<span class="x">🔇</span>');
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
          try { root.child('rel/' + S.pid).onDisconnect().remove(); } catch (e) { }
          try { root.child('diag/' + S.pid).onDisconnect().remove(); } catch (e) { }

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
              out[pid] = { who: p.who, micOn: !!p.micOn, ver: p.ver || 0, v: p.v || '', ts: p.ts, world: p.world || '' };
            });
            if (peerCb) peerCb(out);
            try { checkPeerMics(); } catch (e) { }
          }, function () { });

          /* 나에게 온 offer / answer / 후보 */
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
              if (box.cands) {
                Object.keys(box.cands).forEach(function (ck) {
                  var cd = box.cands[ck];
                  if (!cd || !cd.sid || !cd.c) return;
                  var k2 = from + '|cand|' + ck;
                  if (S.seenSig[k2]) return;
                  S.seenSig[k2] = 1;
                  onSignal(from, 'cand', { sid: cd.sid, cand: cd.c });
                });
              }
            });
          }, function () { });

          try {
            db.ref('.info/connected').on('value', function (s) { if (s.val() && started) this.announce(); }.bind(this));
          } catch (e) { }

          started = true;
          this.announce();
          /* 1시간 넘은 옛 시그널 자국·10분 넘은 옛 진단 자국은 조용히 치워요 */
          try {
            root.child('diag').once('value', function (snap) {
              var v = snap.val() || {}, t = now();
              Object.keys(v).forEach(function (pid) {
                if (pid === S.pid) return;
                var d = v[pid] || {};
                if (!d.ts || t - d.ts > 10 * 60 * 1000) {
                  try { root.child('diag/' + pid).remove().catch(function () { }); } catch (e) { }
                }
              });
            });
          } catch (e) { }
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
            who: S.who, micOn: S.micOn ? 1 : 0, ver: S.myVer, v: VERSION,
            ts: now(), world: S.world || ''
          }).catch(function () { });
        } catch (e) { }
      },
      remove: function () {
        if (!root) return;
        try { if (myRef) myRef.remove().catch(function () { }); } catch (e) { }
        try { root.child('sig/' + S.pid).remove().catch(function () { }); } catch (e) { }
        try { root.child('rel/' + S.pid).remove().catch(function () { }); } catch (e) { }
        try { root.child('diag/' + S.pid).remove().catch(function () { }); } catch (e) { }
      },
      send: function (to, kind, data) {
        if (!root) return;
        try {
          if (kind === 'cand') {
            root.child('sig/' + to + '/' + S.pid + '/cands').push({ sid: data.sid, c: data.cand, ts: now() })
              .catch(function () { });
            return;
          }
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

      /* ---- 보조 중계(목소리 조각) ---- */
      relayHdr: function (b64) {
        if (!root) return;
        try { root.child('rel/' + S.pid + '/hdr').set({ d: b64, m: RLY.mime || '', ts: now() }).catch(function () { }); } catch (e) { }
      },
      relayChunk: function (seq, b64) {
        if (!root) return;
        try { root.child('rel/' + S.pid + '/c/' + seq).set({ d: b64, ts: now() }).catch(function () { }); } catch (e) { }
      },
      relayPrune: function (upto) {
        if (!root) return;
        for (var n = upto - 12; n < upto; n++) {
          try { root.child('rel/' + S.pid + '/c/' + n).remove().catch(function () { }); } catch (e) { }
        }
      },
      relayStop: function () {
        if (!root) return;
        try { root.child('rel/' + S.pid).remove().catch(function () { }); } catch (e) { }
      },
      relayWatch: function (cb) {
        if (!root) return;
        var relRef = root.child('rel');
        var watched = {};
        relRef.on('child_added', function (snap) {
          var pid = snap.key;
          if (!pid || pid === S.pid || watched[pid]) return;
          watched[pid] = 1;
          cb('peer', pid, null, null);
          relRef.child(pid + '/hdr').on('value', function (h) {
            var v = h.val();
            if (v && v.d) cb('hdr', pid, v.d, v.m || '');
          }, function () { });
          relRef.child(pid + '/c').on('child_added', function (c) {
            var v = c.val();
            if (v && v.d) cb('chunk', pid, v.d, c.key);
          }, function () { });
        }, function () { });
        relRef.on('child_removed', function (snap) {
          var pid = snap.key;
          if (watched[pid]) {
            try { relRef.child(pid + '/hdr').off(); relRef.child(pid + '/c').off(); } catch (e) { }
            delete watched[pid];
          }
          cb('gone', pid, null, null);
        }, function () { });
      },
      /* ---- 기기 진단(무엇이 들리고 있는지) — 문제 생겼을 때 읽어 보려고 ---- */
      diag: function (obj) {
        if (!root) return;
        try { root.child('diag/' + S.pid).update(obj).catch(function () { }); } catch (e) { }
      },
      close: function () {
        try { if (root) { root.child('peers').off(); root.child('sig/' + S.pid).off(); } } catch (e) { }
      }
    };
  }

  function makeLocal() {
    var bc = null, cb = null, peers = {}, beat = 0, relCb = null;
    var relCache = {};   /* 시험 모드에서는 새로 들어온 창에 최근 조각을 다시 보내 줘요 */
    var name = 'wv-mesh-' + (qp('wvroom') || ROOM);
    try { bc = new BroadcastChannel(name); } catch (e) { bc = null; }
    function post(m) { try { if (bc) bc.postMessage(m); } catch (e) { } }
    function state() {
      if (S.idled) return;   /* 5분 무활동이면 내 자리를 비워 둬요 */
      post({ t: 'wv', pid: S.pid, who: S.who, micOn: S.micOn ? 1 : 0, ver: S.myVer, v: VERSION, ts: now(), world: S.world });
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
          peers[m.pid] = { who: m.who, micOn: !!m.micOn, ver: m.ver || 0, v: m.v || '', ts: m.ts || now(), world: m.world || '' };
          emit();
        } else if (m.t === 'sig' && m.to === S.pid) {
          onSignal(m.from, m.kind, { sid: m.sid, sdp: m.sdp, cand: m.cand });
        } else if (m.t === 'rh') {
          if (m.pid === S.pid) return;
          var rc = relCache[m.pid] || (relCache[m.pid] = { hdr: '', c: [] });
          rc.hdr = m.h;
          if (relCb) relCb('hdr', m.pid, m.h, null);
        } else if (m.t === 'rq') {
          if (m.pid === S.pid) return;
          var rc2 = relCache[m.pid] || (relCache[m.pid] = { hdr: '', c: [] });
          rc2.c.push({ s: m.seq, d: m.d });
          if (rc2.c.length > 12) rc2.c.shift();
          if (relCb) relCb('chunk', m.pid, m.d, m.seq);
        } else if (m.t === 'rx') {
          delete relCache[m.pid];
          if (relCb) relCb('gone', m.pid, null, null);
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
      send: function (to, kind, data) { post({ t: 'sig', to: to, from: S.pid, kind: kind, sid: data.sid, sdp: data.sdp, cand: data.cand }); },
      dropPeer: function () { },
      relayHdr: function (b64) { post({ t: 'rh', pid: S.pid, h: b64, m: RLY.mime || '' }); },
      relayChunk: function (seq, b64) { post({ t: 'rq', pid: S.pid, seq: seq, d: b64 }); },
      relayPrune: function () { },
      relayStop: function () { post({ t: 'rx', pid: S.pid }); },
      diag: function () { },
      relayWatch: function (fn) {
        relCb = fn;
        /* 이미 켜저 있던 참가자의 최근 중계 조각을 한 번 보내 줘요 */
        setTimeout(function () {
          Object.keys(relCache).forEach(function (pid) {
            var rc = relCache[pid];
            if (rc.hdr) fn('hdr', pid, rc.hdr, null);
            rc.c.slice(-2).forEach(function (it) { fn('chunk', pid, it.d, it.s); });
          });
        }, 60);
      },
      close: function () { try { clearInterval(beat); } catch (e) { } try { if (bc) bc.close(); } catch (e) { } }
    };
  }

  /* ============================================================
     WebRTC 그물(mesh)
     ============================================================ */
  function desired(p) { return !!(S.micOn || (p && p.micOn)); }
  /* 두 기기가 같은 열쇠를 갖도록 항상 작은 수부터 (예전엔 방향이 반대라
     offer 를 받은 쪽이 방금 만든 연결을 스스로 닫아 버렸어요 — 소리가
     안 들리던 원인) */
  function pairKey(p) {
    var a = S.myVer, b = (p && p.ver) || 0;
    return a <= b ? (a + ':' + b) : (b + ':' + a);
  }
  function isInitiator(pid) { return String(S.pid) < String(pid); }
  function p2pConnected(pid) {
    var c = S.conns[pid];
    return !!(c && c.alive && c.pc && c.pc.connectionState === 'connected');
  }
  function anyConnected() {
    return Object.keys(S.conns).some(function (pid) { return p2pConnected(pid); });
  }

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
      if (!desired(p) || c.key !== pairKey(p)) { S.attempts[pid] = 0; closeConn(pid); return; }
      /* 내 마이크는 켰는데 이 연결에 내 목소리가 안 실렸으면(먼저 듣기만 했을 때)
         다시 맺어서 내 목소리도 보내요 */
      if (S.micOn && !c.hasOut) { S.attempts[pid] = 0; closeConn(pid); }
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
      pc = new RTCPeerConnection({ iceServers: iceServers(), iceCandidatePoolSize: 2 });
    } catch (e) {
      return null;
    }
    DBG.pc++;
    var c = {
      pid: pid, pc: pc, sid: sid, key: sid.split('#')[0], initiator: initiator, alive: true,
      hasOut: !!(S.stream && S.micOn),
      outCands: [], inCands: [], sdpSent: false, t0: now()
    };
    S.conns[pid] = c;

    /* 후보(candidate)는 조금씩 늦게 모여요 — 모이는 족족 바로 보내고
       (trickle) 받는 쪽은 준비되면 차례로 넣어요 */
    pc.onicecandidate = function (ev) {
      if (!c.alive) return;
      if (!ev.candidate) { c.gatherDone = true; return; }
      if (c.sdpSent) sendCand(pid, sid, ev.candidate);
      else c.outCands.push(ev.candidate);
    };

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
      renderChips(); render();
    };
    return c;
  }

  /* ---------- 후보 보내기/받기 ---------- */
  function sendCand(pid, sid, cand) {
    try {
      var j = cand && cand.toJSON ? cand.toJSON() : cand;
      if (S.transport && S.transport.send) S.transport.send(pid, 'cand', { sid: sid, cand: j });
    } catch (e) { }
  }
  function flushCands(c) {
    if (!c || !c.alive) return;
    c.sdpSent = true;
    var out = c.outCands || [];
    c.outCands = [];
    out.forEach(function (cd) { sendCand(c.pid, c.sid, cd); });
  }
  function applyCand(c, cand) {
    if (!c || !c.alive || !cand) return;
    if (!c.pc.remoteDescription) { c.inCands.push(cand); return; }
    try { c.pc.addIceCandidate(new RTCIceCandidate(cand)).catch(function () { }); } catch (e) { }
  }
  function flushInCands(c) {
    if (!c) return;
    var list = (S.candBox && S.candBox[c.sid]) || [];
    if (S.candBox) delete S.candBox[c.sid];
    list = list.concat(c.inCands || []);
    c.inCands = [];
    list.forEach(function (cd) { applyCand(c, cd); });
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
          flushCands(c);
        }
      })
      .catch(function (e) { dbgErr('offer', e); clearTimeout(abort); retryConn(pid, c); });

    /* 7초 동안 연결이 안 되면 다시 시도 (느린 망 대비) */
    var slow = setTimeout(function () {
      if (c.alive && !p2pConnected(pid)) retryConn(pid, c);
    }, 7000);
    c.slowT = slow;
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
      /* 자리를 비운(이미 사라진) 기기에서 온 offer 는 무시해요 —
         유령 연결에 재생기를 만들어 소리가 묻히는 것을 막어요 */
      if (!p) return;
      /* 이제 필요 없어진 연결이면(마이크 다 꺼짐) 무시 */
      if (!desired(p)) return;
      if (cur) closeConn(from);
      var c = makePC(from, data.sid, false);
      if (!c) { dbgErr('makePC-answer', 'null'); return; }
      var pc = c.pc;
      pc.setRemoteDescription(new RTCSessionDescription(data.sdp))
        .then(function () { flushInCands(c); return pc.createAnswer(); })
        .then(function (ans) { return pc.setLocalDescription(ans); })
        .then(function () { return waitIce(pc, 2400); })
        .then(function () {
          if (!c.alive || !pc.localDescription) return;
          DBG.answerOut++;
          S.transport.send(from, 'answer', { sid: data.sid, sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
          flushCands(c);
        })
        .catch(function (e) { dbgErr('answer', e); closeConn(from); });
      return;
    }

    if (kind === 'cand') {
      if (!data.cand) return;
      if (cur && cur.sid === data.sid) { applyCand(cur, data.cand); return; }
      if (!S.candBox) S.candBox = {};
      (S.candBox[data.sid] = S.candBox[data.sid] || []).push(data.cand);
      return;
    }

    if (kind === 'answer') {
      DBG.answerIn++;
      if (!cur || cur.sid !== data.sid || !cur.initiator) return;
      if (cur.pc.remoteDescription) return;
      cur.pc.setRemoteDescription(new RTCSessionDescription(data.sdp))
        .then(function () { flushInCands(cur); })
        .catch(function () { retryConn(from, cur); });
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
      try { clearTimeout(c.slowT); } catch (e) { }
      try { c.pc.ontrack = null; c.pc.onconnectionstatechange = null; c.pc.onicecandidate = null; } catch (e) { }
      try { c.pc.close(); } catch (e) { }
      delete S.conns[pid];
    }
    detachRemote(pid);
    renderChips(); render();
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
    try {
      a.muted = false;
      a.volume = 1;
      a.defaultMuted = false;
    } catch (e) { }
    if (!a.__wvPause) {
      a.__wvPause = 1;
      a.addEventListener('pause', function () { if (S.audios[pid] === a) { try { playAudio(a); } catch (e) { } } });
    }
    playAudio(a);
    try { setupAnalyser(pid, stream); } catch (e) { }
  }

  var playRetryT = 0;
  function schedulePlayRetry() {
    if (playRetryT) return;
    playRetryT = setTimeout(function () {
      playRetryT = 0;
      try { unlockAudio(); } catch (e) { }
    }, 1300);
  }

  function playAudio(a) {
    if (!a) return;
    try { a.muted = false; } catch (e) { }
    try {
      var pr = a.play();
      if (pr && pr.then) pr.then(function () { S.audioBlocked = false; renderStat(); }, function () {
        S.audioBlocked = true;
        renderStat();
        schedulePlayRetry();      /* 브라우저가 막으면 화면을 한 번 만질 때까지 계속 다시 시도해요 */
      });
    } catch (e) { S.audioBlocked = true; renderStat(); schedulePlayRetry(); }
  }

  function unlockAudio() {
    if (S.ac && S.ac.state === 'suspended') { try { S.ac.resume(); } catch (e) { } }
    Object.keys(S.audios).forEach(function (pid) { playAudio(S.audios[pid]); });
    Object.keys(RLY.rx).forEach(function (pid) { var R = RLY.rx[pid]; if (R && R.audio) playAudio(R.audio); });
    renderStat();
  }

  function detachRemote(pid) {
    var a = S.audios[pid];
    if (a) { try { a.srcObject = null; } catch (e) { } try { a.parentNode.removeChild(a); } catch (e) { } delete S.audios[pid]; }
    delete S.level[pid];
    if (S.analysers[pid]) {
      try { S.analysers[pid].src.disconnect(); } catch (e) { }
      delete S.analysers[pid];
    }
    delete S.speaking[pid];
  }

  /* 내 마이크가 실제로 소리를 잡고 있는지(진단용) */
  function setupMicAnalyser(stream) {
    var AC = global.AudioContext || global.webkitAudioContext;
    if (!AC || !stream) return;
    if (S.micAn) { try { S.micAn.src.disconnect(); } catch (e) { } S.micAn = null; }
    if (!S.ac) { try { S.ac = new AC(); } catch (e) { return; } }
    if (S.ac.state === 'suspended') { try { S.ac.resume(); } catch (e) { } }
    try {
      var src = S.ac.createMediaStreamSource(stream);
      var an = S.ac.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      S.micAn = { src: src, an: an, buf: new Uint8Array(an.fftSize) };
    } catch (e) { }
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

  function isSpeaking(pid) {
    if (S.speaking[pid] && (now() - S.speaking[pid] < 1100)) return true;
    /* 중계로 들어오는 소리도 "듣는 중"으로 보여 줘요 */
    return !!(S.heard[pid] && (now() - S.heard[pid] < 700));
  }

  var levelT = 0;
  function pollLevels() {
    var any = false;
    if (S.micAn) {
      try {
        S.micAn.an.getByteTimeDomainData(S.micAn.buf);
        var ms = 0;
        for (var k = 0; k < S.micAn.buf.length; k++) { var mv = (S.micAn.buf[k] - 128) / 128; ms += mv * mv; }
        S.micRms = Math.sqrt(ms / S.micAn.buf.length);
      } catch (e) { }
    }
    Object.keys(S.analysers).forEach(function (pid) {
      var o = S.analysers[pid];
      if (!o) return;
      any = true;
      try {
        o.an.getByteTimeDomainData(o.buf);
        var sum = 0;
        for (var i = 0; i < o.buf.length; i++) { var v = (o.buf[i] - 128) / 128; sum += v * v; }
        var rms = Math.sqrt(sum / o.buf.length);
        S.level[pid] = rms;
        if (rms > 0.035) S.speaking[pid] = now();
      } catch (e) { }
    });
    if (any) renderChips();
  }

  /* ============================================================
     🔁 보조 중계 모드 — WebRTC 가 안 붙을 때
     ------------------------------------------------------------
     같은 집 WiFi 가 아니거나 공유기가 기기끼리 직접 통신을 막아 두면
     P2P(WebRTC) 는 붙지 않아요. 그래도 소리는 들려야 하니, 6초 동안
     P2P 가 안 되면 자동으로 이 모드로 바꿉니다.
       · 0.25초짜리 오디오 조각(Opus, 초당 약 2.5KB)을 Firebase 에 올리고
       · 상대는 그 조각을 이어 붙여(MSE) 바로 재생해요.
       · 0.5~1.5초쯤 늦게 들리지만 NAT·통신사와 상관없이 전달돼요.
     P2P 가 붙으면 이 모드는 저절로 꺼집니다.
     ============================================================ */
  var RLY = {
    out: false, rec: null, seq: 0, hdrSent: false, mime: '', waitSince: 0,
    rx: {}, encQ: null
  };

  function b64ToU8(b64) {
    var s = global.atob(b64), u8 = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
    return u8;
  }

  function blobToB64(blob) {
    return new Promise(function (resolve) {
      try {
        var fr = new FileReader();
        fr.onload = function () {
          var s = String(fr.result || '');
          var i = s.indexOf(',');
          resolve(i < 0 ? '' : s.slice(i + 1));
        };
        fr.onerror = function () { resolve(''); };
        fr.readAsDataURL(blob);
      } catch (e) { resolve(''); }
    });
  }

  /* ---------- 보내는 쪽 ---------- */
  function relayPickMime() {
    var MR = global.MediaRecorder;
    if (!MR) return '';
    var cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
    for (var i = 0; i < cands.length; i++) {
      try { if (MR.isTypeSupported(cands[i])) return cands[i]; } catch (e) { }
    }
    return '';
  }

  function relayStartOut() {
    if (RLY.out) { if (!RLY.rec && S.stream && S.micOn) relayRecStart(); return; }
    if (!S.stream || !S.micOn) return;
    if (!global.MediaRecorder) return;
    RLY.out = true; RLY.seq = 0; RLY.hdrSent = false;
    relayRecStart();
    announceSoon();
    render();
  }

  function relayRecStart() {
    if (!S.stream || !S.micOn) return;
    if (RLY.rec) {
      try { if (RLY.rec.state !== 'inactive') return; } catch (e) { }
      RLY.rec = null;
    }
    var mime = relayPickMime();
    var rec = null;
    try {
      rec = new MediaRecorder(S.stream, mime ? { mimeType: mime, audioBitsPerSecond: 20000 } : { audioBitsPerSecond: 20000 });
    } catch (e) { dbgErr('relrec', e); return; }
    RLY.rec = rec;
    RLY.hdrSent = false;      /* 새 녹음이면 첫 조각을 새 머리말로 보내요 */
    RLY.recN = (RLY.recN || 0) + 1;
    RLY.mime = (rec.mimeType || mime || 'audio/webm').split(';')[0];
    RLY.encQ = Promise.resolve();

    rec.ondataavailable = function (ev) {
      var blob = ev.data;
      if (!blob || !blob.size) return;
      RLY.encQ = RLY.encQ.then(function () { return blobToB64(blob); }).then(function (b64) {
        if (!RLY.out || !b64 || b64.length > 24000) return;
        if (!RLY.hdrSent) {
          RLY.hdrSent = true;
          RLY.hdr = b64;
          RLY.hdrAt = now();
          if (S.transport && S.transport.relayHdr) S.transport.relayHdr(b64);
          return;
        }
        RLY.seq++;
        if (S.transport && S.transport.relayChunk) S.transport.relayChunk(RLY.seq, b64);
        if (RLY.seq > 10 && (RLY.seq % 8) === 0 && S.transport.relayPrune) S.transport.relayPrune(RLY.seq - 8);
      }).catch(function () { });
    };
    rec.onstop = function () {
      if (RLY.rec === rec) { RLY.rec = null; RLY.stopAt = now(); }
    };
    try { rec.start(250); } catch (e) { dbgErr('relstart', e); RLY.rec = null; }
  }

  function relayStopOut() {
    if (!RLY.out) return;
    RLY.out = false;
    RLY.waitSince = 0;
    RLY.hdrSent = false;
    RLY.seq = 0;
    try { if (RLY.rec) { RLY.rec.onstop = null; RLY.rec.stop(); } } catch (e) { }
    RLY.rec = null;
    try { if (S.transport && S.transport.relayStop) S.transport.relayStop(); } catch (e) { }
    render();
  }

  /* ---------- 듣는 쪽 ---------- */
  function rxEnsure(pid) {
    return RLY.rx[pid] || (RLY.rx[pid] = {
      hdr: '', mime: '', q: [], sb: null, ms: null, audio: null, url: '',
      joined: now(), opening: false, openAt: 0, got: 0, hdrN: 0, err: '',
      lastChunkAt: 0, lastSeq: 0, rebuilds: 0, rebuiltAt: 0,
      stallRef: -1, stallAt: 0,
      dmode: false, dparts: [], dropped: 0, playedTo: 0, schedEnd: 0,
      decAt: 0, decBusy: false, decN: 0
    });
  }

  function rxReset(pid) {
    var R = RLY.rx[pid];
    if (!R) return;
    delete RLY.rx[pid];
    try { if (R.ms && R.ms.readyState === 'open') { try { R.ms.endOfStream(); } catch (e) { } } } catch (e) { }
    try {
      if (R.audio) {
        R.audio.onerror = null;
        R.audio.pause();
        R.audio.src = '';
        if (R.audio.parentNode) R.audio.parentNode.removeChild(R.audio);
      }
    } catch (e) { }
    try { if (R.url) URL.revokeObjectURL(R.url); } catch (e) { }
    render();
  }

  function rxHdr(pid, b64, mime) {
    if (!b64) return;
    var R = RLY.rx[pid];
    if (R && R.hdr === b64) { R.lastHdrAt = now(); return; }   /* 같은 머리말 반복은 무시 */
    var keepRebuilds = R ? (R.rebuilds || 0) : 0;
    var keepDecode = R ? !!R.dmode : false;
    if (R) rxReset(pid);                 /* 새 녹음이 시작되면 처음부터 다시 */
    R = rxEnsure(pid);
    R.hdr = b64;
    R.mime = mime || '';
    R.hdrN++;
    R.rebuilds = keepRebuilds;
    R.dmode = keepDecode;
    R.dparts = [];                       /* 새 녹음 조각은 앞 녹음과 섞이면 안 돼요 */
    R.dropped = 0;
    R.joined = now();
    R.lastHdrAt = now();
    renderChips(); render();
  }

  /* 최근 조각을 조금 들고 있어요 — MSE 가 안 되는 기기에서 직접 풀어 재생할 때 씀 */
  function rxKeep(pid, u8) {
    var R = RLY.rx[pid];
    if (!R) return;
    R.dparts.push(u8);
    if (R.dparts.length > 40) { R.dparts.shift(); R.dropped++; }
  }

  function rxChunk(pid, b64, seq) {
    if (!b64) return;
    var R = RLY.rx[pid];
    if (!R || !R.hdr) return;
    if (p2pConnected(pid)) { rxReset(pid); return; }   /* P2P 로 잘 들리면 중계는 안 써요 */
    var q = parseInt(seq, 10);
    if (!isNaN(q)) {
      if (R.lastSeq && q <= R.lastSeq) return;          /* 중복·순서 엇갈림은 버림 */
      R.lastSeq = q;
    }
    R.lastChunkAt = now();
    S.heard[pid] = now();
    var u8;
    try { u8 = b64ToU8(b64); } catch (e) { return; }
    rxKeep(pid, u8);
    if (now() - R.joined < 400) return;                /* 접속 직후 밀린 옛 조각은 버림 */
    if (R.dmode) { rxDecodePump(pid, R); return; }
    if (!R.audio) { rxOpen(pid, R); return; }           /* 첫 조각은 재생기 만드는 데 씀 */
    R.q.push(b64);
    R.got++;
    if (R.q.length > 30) R.q.splice(0, R.q.length - 30);
    rxPump(pid, R);
  }

  function rxOpen(pid, R) {
    if (!global.MediaSource) { rxToDecode(pid); return; }
    if (R.opening) return;
    R.opening = true;
    R.openAt = now();
    var audio = document.createElement('audio');
    audio.autoplay = true;
    audio.setAttribute('playsinline', '');
    audio.muted = false;
    audio.volume = 1;
    audio.style.display = 'none';
    audio.dataset.wvRelay = pid;
    audio.onerror = function () {
      var R2 = RLY.rx[pid];
      if (R2) { R2.err = 'media' + ((audio.error && audio.error.code) || ''); }
      rxRebuild(pid);
    };
    (document.body || document.documentElement).appendChild(audio);
    var ms;
    try { ms = new global.MediaSource(); } catch (e) { R.opening = false; rxToDecode(pid); return; }
    R.ms = ms; R.audio = audio;
    try {
      R.url = URL.createObjectURL(ms);
      audio.src = R.url;
    } catch (e) { R.opening = false; rxToDecode(pid); return; }
    ms.addEventListener('sourceopen', function () {
      if (!R.ms || R.ms !== ms || !R.hdr) return;
      var m = (R.mime || RLY.mime || 'audio/webm');
      var types = m.indexOf('mp4') >= 0
        ? ['audio/mp4; codecs="mp4a.40.2"', 'audio/mp4']
        : ['audio/webm; codecs="opus"', 'audio/webm;codecs=opus', 'audio/webm'];
      var sb = null;
      try {
        for (var i = 0; i < types.length && !sb; i++) {
          var okType = true;
          try { if (global.MediaSource.isTypeSupported && !global.MediaSource.isTypeSupported(types[i])) okType = false; } catch (e) { }
          if (!okType) continue;
          try { sb = ms.addSourceBuffer(types[i]); } catch (e) { }
        }
        for (var j = 0; j < types.length && !sb; j++) { try { sb = ms.addSourceBuffer(types[j]); } catch (e) { } }
      } catch (e) { }
      if (!sb) { R.opening = false; R.err = 'nosb'; rxToDecode(pid); return; }
      R.sb = sb;
      try { sb.mode = 'sequence'; } catch (e) { }
      sb.addEventListener('updateend', function () { rxPump(pid, R); });
      try { sb.appendBuffer(b64ToU8(R.hdr)); } catch (e) { R.err = 'hdr:' + ((e && e.name) || ''); }
      playAudio(audio);
      render();
    }, { once: true });
  }

  /* MSE(미디어소스) 가 안 되는 기기 — 조각을 Web Audio 로 직접 풀어서 이어 재생해요
     (0.3~0.6초쯤 늦게 들리지만 소리는 확실히 납니다) */
  function rxToDecode(pid) {
    var R = RLY.rx[pid];
    if (!R || R.dmode) return;
    var AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) { R.err = 'no-ac'; return; }
    R.dmode = true;
    R.err = R.err || 'decode';
    try {
      if (R.audio) {
        R.audio.onerror = null;
        try { R.audio.pause(); } catch (e) { }
        try { R.audio.src = ''; } catch (e) { }
        if (R.audio.parentNode) R.audio.parentNode.removeChild(R.audio);
      }
    } catch (e) { }
    R.audio = null; R.sb = null; R.ms = null;
    try { if (R.url) URL.revokeObjectURL(R.url); } catch (e) { }
    R.url = '';
    R.q.length = 0;
    R.playedTo = 0;
    R.schedEnd = 0;
    render();
  }

  function rxDecodePump(pid, R) {
    if (!R || !R.hdr || !R.dmode) return;
    if (R.decBusy) return;
    if (!R.dparts || !R.dparts.length) return;
    if (now() - (R.decAt || 0) < 420) return;
    var AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return;
    if (!S.ac) { try { S.ac = new AC(); } catch (e) { return; } }
    if (S.ac.state !== 'running') {
      try { S.ac.resume(); } catch (e) { }
      if (S.ac.state !== 'running') { S.audioBlocked = true; renderStat(); return; }
    }
    R.decAt = now();
    R.decBusy = true;
    var keep = Math.min(30, R.dparts.length);
    var winStart = ((R.dropped || 0) + (R.dparts.length - keep)) * 0.25;
    var parts = [b64ToU8(R.hdr)].concat(R.dparts.slice(R.dparts.length - keep));
    var blob;
    try { blob = new Blob(parts, { type: R.mime || RLY.mime || 'audio/webm' }); } catch (e) { R.decBusy = false; return; }
    var fr = new FileReader();
    fr.onload = function () {
      if (!S.ac || !S.ac.decodeAudioData) { R.decBusy = false; return; }
      try {
        S.ac.decodeAudioData(fr.result, function (buf) {
          R.decBusy = false;
          try {
            var dur = buf.duration || 0;
            var from = Math.max(0, (R.playedTo || 0) - winStart);
            var to = dur - 0.10;
            if (to - from < 0.05) {
              if (dur > 0.3 && (R.playedTo || 0) < winStart) R.playedTo = winStart;
              return;
            }
            var src = S.ac.createBufferSource();
            src.buffer = buf;
            var w = S.ac.currentTime + 0.04;
            if (R.schedEnd && R.schedEnd > w && R.schedEnd - w < 1.2) w = R.schedEnd;
            src.connect(S.ac.destination);
            src.start(w, from, to - from);
            R.schedEnd = w + (to - from);
            R.playedTo = winStart + to;
            R.decN = (R.decN || 0) + 1;
            S.heard[pid] = now();
          } catch (e) { R.err = 'dec2'; }
        }, function () {
          R.decBusy = false;
          if (!R.decN) R.err = 'decode';      /* 아직 한 번도 못 풀었을 때만 오류로 표시 */
        });
      } catch (e) { R.decBusy = false; R.err = 'decode'; }
    };
    fr.onerror = function () { R.decBusy = false; };
    try { fr.readAsArrayBuffer(blob); } catch (e) { R.decBusy = false; }
  }

  /* 재생기가 막히거나 깨졌으면 머리말부터 다시 붙여 살려요 */
  function rxRebuild(pid) {
    var R = RLY.rx[pid];
    if (!R) return;
    if (R.rebuiltAt && now() - R.rebuiltAt < 1200) return;
    var keepHdr = R.hdr, keepMime = R.mime, keepSeq = R.lastSeq;
    var rebuilds = (R.rebuilds || 0) + 1;
    var keepParts = (R.dparts || []).slice(-8);
    var keepDropped = (R.dropped || 0) + ((R.dparts || []).length - keepParts.length);
    var playedTo = R.playedTo || 0;
    rxReset(pid);
    var R2 = rxEnsure(pid);
    R2.hdr = keepHdr; R2.mime = keepMime; R2.lastSeq = keepSeq;
    R2.rebuilds = rebuilds; R2.rebuiltAt = now();
    R2.joined = now() - 1200;
    R2.dparts = keepParts; R2.dropped = keepDropped;
    R2.playedTo = playedTo;
    if (rebuilds >= 2) rxToDecode(pid);       /* 두 번 실패하면 MSE 대신 직접 재생 */
    render();
  }

  function rxPump(pid, R) {
    if (!R || !R.sb || R.sb.updating || !R.q.length) return;
    if (R.audio && R.audio.error) { rxRebuild(pid); return; }
    var b = R.q.shift();
    try { R.sb.appendBuffer(b64ToU8(b)); }
    catch (e) {
      R.err = (e && e.name || '') + ':' + String((e && e.message) || '').slice(0, 60);
      if (e && e.name === 'QuotaExceededError') {
        R.q.length = 0;
        try {
          if (R.sb.buffered.length) R.sb.remove(0, R.sb.buffered.start(0));
          else if (R.audio) R.sb.remove(0, R.audio.currentTime || 0);
        } catch (e2) { }
      } else {
        rxRebuild(pid);
      }
    }
  }

  /* 늦게 쌓인 소리는 건너뛰어 1초 안쪽으로 유지 */
  function rxCatchup() {
    Object.keys(RLY.rx).forEach(function (pid) {
      var R = RLY.rx[pid];
      if (!R || R.dmode || !R.audio || !R.sb) return;
      try {
        if (!R.sb.buffered || !R.sb.buffered.length) return;
        var end = R.sb.buffered.end(R.sb.buffered.length - 1);
        if (end - R.audio.currentTime > 1.4) R.audio.currentTime = Math.max(0, end - 0.5);
      } catch (e) { }
    });
  }

  /* 1초마다: 소리가 오는데 재생이 멈춰 있으면 살려요 (안드로이드에서 자주 있는 일) */
  function rxHealth() {
    Object.keys(RLY.rx).forEach(function (pid) {
      var R = RLY.rx[pid];
      if (!R || !R.hdr) return;
      var live = (now() - (R.lastChunkAt || 0) < 3500);
      if (!live) {
        if (R.audio && !R.audio.paused) { try { R.audio.pause(); } catch (e) { } }
        return;
      }
      if (R.dmode) { rxDecodePump(pid, R); return; }
      if (!R.sb) {
        if (R.opening && now() - (R.openAt || 0) > 2500) { R.opening = false; R.err = 'open-timeout'; rxRebuild(pid); }
        return;
      }
      if (!R.audio) return;
      if (R.audio.paused) playAudio(R.audio);
      var ct = 0;
      try { ct = R.audio.currentTime || 0; } catch (e) { }
      if (R.stallRef < 0) { R.stallRef = ct; R.stallAt = now(); }
      else if (Math.abs(ct - R.stallRef) < 0.04) {
        if (now() - (R.stallAt || 0) > 2600) { R.stallRef = -1; rxRebuild(pid); }
      } else {
        R.stallRef = ct;
        R.stallAt = now();
      }
      rxPump(pid, R);
    });
  }

  function relayOnMessage(kind, pid, a, b) {
    if (!pid || pid === S.pid) return;
    if (kind === 'hdr') { rxHdr(pid, a, b); return; }
    if (kind === 'chunk') { rxChunk(pid, a, b); return; }
    if (kind === 'gone') { rxReset(pid); return; }
  }

  /* 6초 동안 P2P 가 안 되면 중계로 전환, 다 붙으면 원래대로
     (세 명이 있을 때 한 명만 P2P 가 되는 경우도 그 한 명은 중계로 들려요) */
  function relayWatchdog() {
    var wantPeers = Object.keys(S.peers).filter(function (pid) { return S.peers[pid] && desired(S.peers[pid]); });
    var missing = wantPeers.filter(function (pid) { return !p2pConnected(pid); });
    if (!S.micOn || !S.stream || !missing.length) {
      RLY.waitSince = 0;
      if (RLY.out) relayStopOut();
      return;
    }
    if (!RLY.waitSince) RLY.waitSince = now();
    if (!RLY.out && now() - RLY.waitSince > 6000) relayStartOut();
    /* 머리말을 한 번씩 다시 보내 줘요 — 혹시 한쪽 재생기가 깨졌을 때 스스로 복구 */
    if (RLY.out && RLY.hdr && now() - (RLY.hdrAt || 0) > 12000) {
      RLY.hdrAt = now();
      try { if (S.transport && S.transport.relayHdr) S.transport.relayHdr(RLY.hdr); } catch (e) { }
    }
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
      try { setupMicAnalyser(stream); } catch (e) { }
      render();
      if (S.transport) { S.transport.announce(); syncMesh(); }
      unlockAudio();
      var mp = micOnPeers();
      var allPeers = Object.keys(S.peers);
      var extra = (allPeers.length && !mp.length) ? (' · ' + peerNames(allPeers) + ' 마이크가 꺼져 있어요 🔇') : '';
      toast('🎙️ 마이크 켜짐! 이야기해 보세요' + extra, 2600);
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
    try { if (S.micAn) { S.micAn.src.disconnect(); } } catch (e) { }
    S.micAn = null;
    S.micRms = -1;
    S.myVer++;
    try { relayStopOut(); } catch (e) { }
    closeAllConns();
    render();
    if (S.transport) { S.transport.announce(); syncMesh(); }
    if (reason === 'user') toast('마이크 껐어요 🔇', 1800);
    else if (reason === 'idle') toast('5분 동안 조용해서 마이크를 껐어요 💤', 3200);
    else if (reason === 'blocked') toast('하은이 대화 중이라 마이크를 잠깐 껐어요 🎤', 3000);
  }

  /* ============================================================
     기기 진단 — 이 폰이 뭔 듣고 있는지 Firebase 에 짧게 남깁니다
     (worldVoice/diag/{pid}, 10초마다 · 창을 닫으면 지워짐)
     ============================================================ */
  function pushDiag() {
    if (TEST || !S.transport || !S.transport.diag) return;
    var rx = Object.keys(RLY.rx).map(function (pid) {
      var R = RLY.rx[pid] || {};
      var ct = 0;
      try { ct = R.audio ? +(R.audio.currentTime || 0).toFixed(1) : 0; } catch (e) { }
      return (R.dmode ? 'D' : 'M') + (R.hdr ? 'h' : '-') + (R.sb ? 's' : '-') +
             ((R.audio && !R.audio.paused) ? 'p' : '-') + ' g' + (R.got || 0) + ' d' + (R.decN || 0) +
             ' c' + ct + (R.err ? ' e' + String(R.err).slice(0, 16) : '');
    }).join(' ; ').slice(0, 200);
    var peerStr = Object.keys(S.peers).map(function (pid) {
      var p = S.peers[pid] || {};
      return (p.who || '?') + (p.micOn ? '1' : '0') + '@' + (p.v || '-');
    }).join(',');
    var pcs = Object.keys(S.conns).map(function (pid) {
      try { return S.conns[pid].pc.connectionState; } catch (e) { return '?'; }
    }).join(',');
    try {
      S.transport.diag({
        v: VERSION, who: S.who, w: (S.world || '').slice(0, 12),
        mic: S.micOn ? 1 : 0, blk: S.audioBlocked ? 1 : 0,
        ac: (S.ac && S.ac.state) ? S.ac.state : '-',
        au: Object.keys(S.audios).length, pc: pcs.slice(0, 40),
        rl: (RLY.out ? 1 : 0) + '/' + (RLY.seq || 0),
        mv: (S.micRms == null ? '-' : (+S.micRms).toFixed(3)),
        peers: peerStr.slice(0, 120), rx: rx,
        st: (statusOf() || {}).t || '',
        ua: (((UA.match(/Android[^;)]*/) || [''])[0]) + ' ' + ((UA.match(/Chrome\/[\d.]+/) || [''])[0])).slice(0, 60),
        ts: now()
      });
    } catch (e) { }
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

    /* 화면을 돌리거나 창 크기가 바뀌어도 방향 버튼을 안 가리게 다시 앉혀요 */
    try {
      window.addEventListener('resize', function () { setTimeout(placeBar, 60); }, { passive: true });
      window.addEventListener('orientationchange', function () { setTimeout(placeBar, 260); }, { passive: true });
      /* 시작 창을 닫거나 미니게임을 열어 화면이 바뀌면 다시 앉히기 */
      ['pointerdown', 'click', 'touchend'].forEach(function (ev) {
        document.addEventListener(ev, function () { placeSoon(450); }, { capture: true, passive: true });
      });
    } catch (e) { }

    /* 시험 모드에서는 Firebase 에 절대 쓰지 않아요 */
    S.transport = TEST ? makeLocal() : makeFirebase();
    var relayWatched = false;
    function watchRelay() {
      if (relayWatched) return;
      try { S.transport.relayWatch(relayOnMessage); relayWatched = true; } catch (e) { }
    }
    var ok = false;
    try { ok = S.transport.start(onPeers); } catch (e) { ok = false; }
    if (ok) watchRelay();
    if (!ok && !TEST) {
      /* SDK 가 아직 안 됐으면 잠깐 기다렸다 다시 (인터넷 느릴 때)
         — 몇 번째 시도에서 붙든 중계(상대 목소리)는 꼭 들어야 해요 */
      var tries = 0;
      var t = setInterval(function () {
        tries++;
        var done = false;
        try { done = S.transport.start(onPeers); } catch (e) { done = false; }
        if (done) watchRelay();
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

    /* 중계 모드 전환 감시 + 늦게 쌓인 소리 따라잡기 + 막힌 재생기 살리기 */
    S.timers.push(setInterval(function () { try { relayWatchdog(); } catch (e) { } }, 1000));
    S.timers.push(setInterval(function () { try { rxCatchup(); } catch (e) { } }, 800));
    S.timers.push(setInterval(function () { try { rxHealth(); } catch (e) { } }, 1000));
    S.timers.push(setInterval(function () { renderStat(); }, 1200));
    /* 기기 진단 — 무엇이 들리고 있는지 worldVoice/diag 에 남겨 둬요 */
    S.timers.push(setInterval(function () { try { pushDiag(); } catch (e) { } }, 10000));

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
    if (S.audioBlocked || anyPausedRemote()) unlockAudio();
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
    try { relayStopOut(); } catch (e) { }
    try { Object.keys(RLY.rx).forEach(rxReset); } catch (e) { }
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
        relay: {
          out: RLY.out, seq: RLY.seq, recN: RLY.recN || 0, rec: RLY.rec ? RLY.rec.state : '',
          rx: Object.keys(RLY.rx).map(function (pid) {
            var R = RLY.rx[pid];
            var buffered = 0;
            try { if (R.sb && R.sb.buffered.length) buffered = +(R.sb.buffered.end(R.sb.buffered.length - 1) - (R.audio ? R.audio.currentTime : 0)).toFixed(2); } catch (e) { }
            return { pid: pid, hdr: !!R.hdr, playing: !!(R.audio && !R.audio.paused), q: R.q.length, ahead: buffered, got: R.got, hdrN: R.hdrN, age: Math.round((now() - R.joined) / 1000), err: R.err, mode: R.dmode ? 'decode' : 'mse', rebuilds: R.rebuilds || 0, decN: R.decN || 0, playedTo: +(R.playedTo || 0).toFixed(2), sched: +(R.schedEnd || 0).toFixed(2) };
          })
        },
        status: (statusOf() || {}).t || '',
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
