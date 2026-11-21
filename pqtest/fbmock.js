/* 테스트용 Firebase RTDB 모의 객체 — 실제 서버에 아무것도 쓰지 않는다.
   앱이 쓰는 만큼만 구현: ref().on('value') / once('value') / update() / .info/connected
   window.__fb 로 외부에서 상태를 보고 고칠 수 있다. */
(function () {
  var store = { kids: {}, chat: {}, settings: {} };
  var listeners = [];
  var writes = [];
  var hold = false;

  function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

  function notify() {
    var snap = {
      val: function () { return clone(store); },
      exists: function () { return !!(store && (store.kids || store.chat || store.settings)); }
    };
    listeners.slice().forEach(function (cb) { setTimeout(function () { cb(snap); }, 0); });
  }

  function getAt(obj, parts) {
    var cur = obj;
    for (var i = 0; i < parts.length; i++) {
      if (!cur || typeof cur !== 'object') return null;
      cur = cur[parts[i]];
    }
    return cur === undefined ? null : cur;
  }

  function setAt(obj, parts, val) {
    var cur = obj;
    for (var i = 0; i < parts.length - 1; i++) {
      var p = parts[i];
      if (!cur[p] || typeof cur[p] !== 'object') {
        if (val === null) return;
        cur[p] = {};
      }
      cur = cur[p];
    }
    var last = parts[parts.length - 1];
    if (val === null) { delete cur[last]; return; }
    if (typeof val === 'object') {
      if (!cur[last] || typeof cur[last] !== 'object') cur[last] = {};
      var dst = cur[last];
      Object.keys(val).forEach(function (k) {
        if (val[k] === null) delete dst[k];
        else if (typeof val[k] === 'object') setAt(dst, [k], val[k]);  /* update()는 객체를 병합한다 */
        else dst[k] = val[k];
      });
      return;
    }
    cur[last] = val;
  }

  function applyPatch(patch) {
    Object.keys(patch || {}).forEach(function (k) {
      setAt(store, k.split('/'), patch[k]);
    });
  }

  function refFor(path) {
    var base = String(path || '').split('/').filter(Boolean);
    return {
      on: function (evt, cb) {
        if (evt === '.info/connected' || /(^|\/)\.info\/connected$/.test(path)) {
          setTimeout(function () { cb({ val: function () { return true; } }); }, 0);
          return cb;
        }
        listeners.push(cb);
        setTimeout(notify, 0);
        return cb;
      },
      off: function () {},
      once: function () {
        return Promise.resolve({
          val: function () { return clone(getAt(store, base)); }
        });
      },
      child: function (p) { return refFor(path + '/' + p); },
      update: function (patch) {
        writes.push(clone(patch));
        if (hold) return Promise.reject(new Error('mock-offline'));
        applyPatch(patch);
        notify();
        return Promise.resolve();
      },
      set: function (val) {
        var patch = {};
        patch[base.join('/')] = val;
        writes.push(clone(patch));
        if (hold) return Promise.reject(new Error('mock-offline'));
        applyPatch(patch);
        notify();
        return Promise.resolve();
      },
      remove: function () { return Promise.resolve(); }
    };
  }

  window.firebase = {
    apps: [],
    app: function () { return window.firebase.__app; },
    initializeApp: function () {
      var app = {
        database: function () { return { ref: function (p) { return refFor(p); } }; }
      };
      window.firebase.__app = app;
      window.firebase.apps.push(app);
      return app;
    }
  };

  window.__fb = {
    get store() { return clone(store); },
    get writes() { return clone(writes); },
    set hold(v) { hold = !!v; },
    get hold() { return hold; },
    /* 다른 기기가 서버에 쓴 것처럼 만든다 */
    write: function (path, val) { setAt(store, path.split('/'), val); notify(); },
    patch: function (patch) { applyPatch(patch); notify(); },
    reset: function () { store = { kids: {}, chat: {}, settings: {} }; notify(); }
  };
})();
