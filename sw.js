/* 채씨네 가족 앱 서비스 워커 (2026-11-19)
 *
 * 하는 일은 '최소한'뿐이다.
 *  - install: skipWaiting / activate: clients.claim → 새 버전이 기다리지 않고 바로 적용된다.
 *  - fetch: respondWith를 쓰지 않는다 → 모든 요청은 지금까지처럼 그대로 네트워크로 간다.
 *    캐시를 하지 않으므로 오래된 HTML/JSON/Firebase 응답이 묶여 화면이 안 바뀌는 일이 없다.
 *
 * 참고: 2026년 기준 Android Chrome은 '앱 설치(WebAPK)'에 서비스 워커를 필수로 보지 않는다
 * (Chrome 108에서 fetch 핸들러 요구가 사라졌고, 빈 핸들러는 설치 판단에서 무시된다).
 * 그래도 등록해 두면 앱이 같은 범위(scope)로 묶여 동작하고, 나중에 푸시·오프라인을 붙일 때 그대로 쓸 수 있다.
 * 설치가 '크롬 로고 붙은 바로가기'로 되는지는 매니페스트(id·start_url·scope·icons·display)와
 * Chrome 메뉴에서 '앱 설치'를 골랐는지가 결정한다. 자세한 안내는 apps.html 하단 참고.
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
