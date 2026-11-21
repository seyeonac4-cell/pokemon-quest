/* ============================================================
   🪙 공용 코인 지갑 — world-coins.js
   블록 월드 · 그로우 어 가든 · 드레스 투 임프레스 세 게임이
   *하나의 코인 지갑*을 함께 씁니다.
   경로: family-lim-7660/worldCoins/{yunjin|hyungwon|mom|dad}
   (윤진·형원은 세 게임 공용, 엄마·아빠는 블록 월드에서도 놀 수 있게
    같은 지갑 구조로 mom/dad 칸을 더했습니다 — 아이들 값은 그대로예요.)

   지키는 것
   1) 코인의 진실(source of truth)은 항상 서버 값입니다.
      이 기기 localStorage에 남아 있던 옛 값(0, 150 …)은 서버로 올리지 않습니다.
   2) 코인을 벌거나(+N) 쓸 때(-N)만 트랜잭션으로 더하고 빼서,
      두 기기·두 게임이 동시에 써도 잃거나 겹치지 않습니다.
   3) 서버 값이 바뀌면 화면 코인이 바로 따라옵니다(실시간).
   4) 인터넷이 끊겨도 기기 값으로 놀 수 있고, 다시 연결되면 밀린 만큼 반영합니다.

   쓰는 법 (각 게임에서)
     WorldCoins.init({kid:'yunjin', onValue:function(v){ ... }});
     WorldCoins.setKid('hyungwon');
     WorldCoins.get();          // 지금 코인
     WorldCoins.earn(20);       // +20
     WorldCoins.spend(10);      // -10 (모자라면 false)
     WorldCoins.resetAll(50);   // 보호자 리셋: 두 아이 모두 50
     WorldCoins.resetWallets(['mom','dad'], 50);  // 엄마·아빠 지갑만 50
   ============================================================ */
(function (global) {
  'use strict';

  var START = 50;
  var PATH = 'family-lim-7660/worldCoins';
  var TEST_PATH = 'family-lim-7660/worldCoins_test';
  var LS = 'lim:worldCoins:v1';
  var CFG = {
    apiKey: 'AIzaSyCy_TrcTcwRusSeQH4x3yrGv1bwzi7wBhI',
    authDomain: 'pokemon-quest-lim.firebaseapp.com',
    databaseURL: 'https://pokemon-quest-lim-default-rtdb.asia-southeast1.firebasedatabase.app',
    projectId: 'pokemon-quest-lim',
    storageBucket: 'pokemon-quest-lim.firebasestorage.app',
    messagingSenderId: '186869020161',
    appId: '1:186869020161:web:e3edcca0d1d2675d89f200'
  };
  var ID_MAP = {
    yunjin: 'yunjin', hyungwon: 'hyungwon', hyeongwon: 'hyungwon',
    mom: 'mom', 엄마: 'mom', dad: 'dad', 아빠: 'dad'
  };
  var WALLETS = ['yunjin', 'hyungwon', 'mom', 'dad'];

  function num(v) {
    var n = Number(v);
    return (isFinite(n) && n >= 0) ? Math.floor(n) : null;
  }
  function kidKey(id) {
    var s = String(id == null ? '' : id).trim().toLowerCase();
    if (ID_MAP[s]) return ID_MAP[s];
    if (s.indexOf('hyung') === 0) return 'hyungwon';
    return 'yunjin';
  }
  function readLocal() {
    try {
      var o = JSON.parse(global.localStorage.getItem(LS) || 'null');
      return (o && typeof o === 'object') ? o : {};
    } catch (e) { return {}; }
  }

  var WC = {
    ready: false,      // 서버 값을 한 번이라도 받았는가
    connected: false,  // 지금 서버와 연결됐는가
    kid: 'yunjin',
    start: START,
    test: false,
    _root: PATH,
    _db: null,
    _ref: null,
    _vals: {},
    _subs: [],
    _denied: [],
    _queue: [],
    _tries: 0,
    _local: {}
  };
  WC._local = readLocal();
  WC.kidKey = kidKey;
  WC.WALLETS = WALLETS;

  function writeLocal() {
    try { global.localStorage.setItem(LS, JSON.stringify(WC._local)); } catch (e) {}
  }
  WC.rootPath = function () { return WC._root; };

  WC.get = function (id) {
    var k = id ? kidKey(id) : WC.kid;
    var v = num(WC._vals[k]);
    if (v == null) v = num(WC._local[k]);
    if (v == null) v = START;
    return v;
  };

  function emit() {
    var v = WC.get();
    for (var i = 0; i < WC._subs.length; i++) {
      try { WC._subs[i](v, WC.kid); } catch (e) {}
    }
  }
  WC.on = function (fn) {
    if (typeof fn !== 'function') return;
    WC._subs.push(fn);
    try { fn(WC.get(), WC.kid); } catch (e) {}
  };
  WC.onDenied = function (fn) { if (typeof fn === 'function') WC._denied.push(fn); };

  WC.setKid = function (id) {
    WC.kid = kidKey(id);
    try { WC._local[WC.kid] = WC.get(); writeLocal(); } catch (e) {}
    emit();
    return WC.get();
  };

  /* 서버 연결 — 다른 게임이 이미 연 firebase 앱을 그대로 씁니다 */
  WC.connect = function () {
    if (WC._ref) return;
    if (WC._tries > 60) return;
    if (typeof global.firebase === 'undefined' || !global.firebase.initializeApp) {
      WC._tries++;
      setTimeout(function () { WC.connect(); }, 500);
      return;
    }
    try {
      var app = (global.firebase.apps && global.firebase.apps.length) ? global.firebase.app() : global.firebase.initializeApp(CFG);
      var db = global.firebase.database(app);
      WC._db = db;
      try {
        db.ref('.info/connected').on('value', function (s) { WC.connected = !!s.val(); });
      } catch (e) {}
      WC._ref = db.ref(WC._root);
      WC._ref.on('value', function (snap) {
        var v = snap.val() || {};
        WALLETS.forEach(function (k) {
          var n = num(v[k]);
          if (n != null) WC._vals[k] = n;
        });
        /* 서버에 아직 없는 사람은 처음 값(50)부터 */
        WALLETS.forEach(function (k) {
          if (num(WC._vals[k]) == null) WC._vals[k] = START;
          WC._local[k] = WC._vals[k];
        });
        writeLocal();
        WC.ready = true;
        if (WC._queue.length) {
          var q = WC._queue.slice();
          WC._queue = [];
          q.forEach(function (it) { WC._push(it.k, it.d, it.cb); });
        }
        emit();
      }, function () { /* 읽기 실패 → 기기 값으로 계속 */ });
    } catch (e) {
      WC._tries++;
      setTimeout(function () { WC.connect(); }, 800);
    }
  };

  /* 실제 서버 반영(트랜잭션) */
  WC._push = function (k, d, cb) {
    if (!WC._db) {
      WC._queue.push({ k: k, d: d, cb: cb });
      WC.connect();
      return;
    }
    var ref;
    try { ref = WC._db.ref(WC._root + '/' + k); } catch (e) { WC._queue.push({ k: k, d: d, cb: cb }); return; }
    try {
      ref.transaction(function (cur) {
        var base = num(cur);
        if (base == null) base = START;
        var next = base + d;
        if (next < 0) return;         /* 모자라면 취소(undefined) */
        return next;
      }, function (err, committed) {
        if (!committed) {
          /* 서버에 코인이 모자라 취소됨 → 화면 값 되돌리기 */
          WC._vals[k] = Math.max(0, WC.get(k) - d);
          WC._local[k] = WC._vals[k];
          writeLocal();
          emit();
          for (var i = 0; i < WC._denied.length; i++) {
            try { WC._denied[i](k, d); } catch (e) {}
          }
        }
        if (cb) { try { cb(committed); } catch (e) {} }
      });
    } catch (e) {
      WC._queue.push({ k: k, d: d, cb: cb });
    }
  };

  /* 화면을 먼저 바꾸고(빠른 반응) 서버에 반영 */
  WC._apply = function (id, d, cb) {
    var k = kidKey(id);
    var cur = WC.get(k);
    var next = Math.max(0, cur + d);
    WC._vals[k] = next;
    WC._local[k] = next;
    writeLocal();
    if (k === WC.kid) emit();
    if (!WC.ready) {
      /* 아직 서버 값을 못 받았으면, 받은 뒤에 밀린 만큼 반영 */
      WC._queue.push({ k: k, d: d, cb: cb });
      WC.connect();
      return next;
    }
    WC._push(k, d, cb);
    return next;
  };

  WC.earn = function (n, id) {
    n = Math.floor(Number(n) || 0);
    if (n <= 0) return WC.get(id);
    return WC._apply(id || WC.kid, n);
  };

  WC.spend = function (n, id) {
    n = Math.floor(Number(n) || 0);
    if (n <= 0) return true;
    var k = id ? kidKey(id) : WC.kid;
    if (WC.get(k) < n) return false;
    WC._apply(k, -n);
    return true;
  };

  /* 보호자 리셋: 두 아이 지갑을 모두 v로 */
  WC.resetAll = function (v) {
    v = Math.max(0, Math.floor(Number(v) || 0));
    WC._vals.yunjin = v; WC._vals.hyungwon = v;
    WC._local.yunjin = v; WC._local.hyungwon = v;
    writeLocal();
    emit();
    try {
      if (!WC._db) { WC.connect(); return; }
      WC._db.ref(WC._root).update({ yunjin: v, hyungwon: v });
    } catch (e) {}
  };

  /* 고른 지갑만 v로 되돌리기 (아이들 값은 건드리지 않아요) */
  WC.resetWallets = function (ids, v) {
    v = Math.max(0, Math.floor(Number(v) || 0));
    var upd = {}, any = false;
    (ids || []).forEach(function (id) {
      var k = kidKey(id);
      if (WALLETS.indexOf(k) < 0) return;
      WC._vals[k] = v; WC._local[k] = v; upd[k] = v; any = true;
    });
    if (!any) return;
    writeLocal();
    emit();
    try {
      if (!WC._db) { WC.connect(); return; }
      WC._db.ref(WC._root).update(upd);
    } catch (e) {}
  };

  WC.init = function (opts) {
    opts = opts || {};
    if (opts.test !== undefined) WC.test = !!opts.test;
    WC._root = WC.test ? TEST_PATH : PATH;
    if (opts.kid) WC.kid = kidKey(opts.kid);
    var hint = num(opts.localHint);
    if (hint != null && num(WC._vals[WC.kid]) == null) {
      WC._local[WC.kid] = hint;
      writeLocal();
    }
    if (opts.onValue) WC._subs.push(opts.onValue);
    if (opts.onDenied) WC._denied.push(opts.onDenied);
    WC.connect();
    emit();
    return WC;
  };

  /* ?wctest=1 이면 테스트 지갑(worldCoins_test)을 씁니다 — 실제 아이들 코인은 건드리지 않아요 */
  WC.testFromUrl = function () {
    try {
      var q = new URLSearchParams(global.location.search || '');
      return q.get('wctest') === '1';
    } catch (e) { return false; }
  };

  global.WorldCoins = WC;
})(window);
