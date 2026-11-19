/* 채씨네 가족 앱 서비스 워커 (2026-11-19)
 *
 * 목적은 딱 하나 — Android Chrome이 '진짜 앱(WebAPK, 크롬 배지 없는 아이콘)'으로
 * 설치할 수 있게 해 주는 최소 조건(등록된 서비스 워커 + fetch 핸들러)을 만족시키는 것.
 *
 * 그래서 캐시는 일부러 하지 않는다.
 *  - fetch 핸들러는 respondWith를 쓰지 않는다 → 모든 요청은 지금까지처럼 그대로 네트워크로 간다.
 *  - 오래된 HTML/JSON/Firebase 응답이 캐시에 묶여 화면이 안 바뀌는 일이 없다.
 *  - 새 버전을 올리면 skipWaiting + clients.claim으로 바로 적용된다.
 */
self.addEventListener('install', () => {
  // 새 서비스 워커를 기다리지 않고 바로 대기 해제
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // 이미 열려 있는 탭도 즉시 새 서비스 워커의 관리 아래로
  event.waitUntil(self.clients.claim());
});

// 설치 조건(has fetch handler) 충족용. respondWith를 하지 않으므로 실제 동작은 100% 그대로.
self.addEventListener('fetch', () => {});
