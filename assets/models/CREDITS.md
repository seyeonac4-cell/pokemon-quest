# 3D 모델 출처 (assets/models)

`vr.html` 체험관에 쓰는 동물·바다생물 모델입니다. 모두 **CC0 1.0 (퍼블릭 도메인)** 이라
상업적 이용·수정·재배포가 자유롭고 출처 표기도 필요 없습니다. (아래는 예의상 기록)

| 파일 | 동물 | 원본 | 라이선스 |
|---|---|---|---|
| `puppy.glb` | 아기 비숑 (흰 강아지) | Quaternius *Ultimate Animated Animals* — `ShibaInu` (재질을 크림/화이트로) | CC0 |
| `cat.glb` | 치즈냥 | Vuena *Cute Pets FREE Sample* — `animal_cat` | CC0 |
| `capybara.glb` | 카피바라 | Gamideo *Cozy Animals 3D Models* — `Capybara` | CC0 |
| `llama.glb` | 알파카 | Quaternius *Ultimate Animated Animals* — `Alpaca` | CC0 |
| `rabbit.glb` | 아기토끼 | Gobkit *Free Animal Pack* (animal006) — `Hare` | CC0 |
| `dolphin.glb` | 돌고래 | Quaternius *Fish Pack* — `Dolphin` | CC0 |
| `sea-turtle.glb` | 바다거북 | Gamideo *Cozy Animals 3D Models* — `Turtle` | CC0 |
| `clownfish.glb` | 흰동가리 | Quaternius *Fish Pack* — `Clownfish` | CC0 |
| `great-white-shark.glb` | 아기상어 | Quaternius *Fish Pack* — `Shark` | CC0 |
| `jellyfish.glb` | 야광 해파리 | Gobkit *Free Animal Pack* — `Jellyfish` | CC0 |

## 애니메이션 클립

모델마다 이름이 달라 `vr.html` 의 `clipRole()` 이 역할(idle / walk / run / jump / eat / sit / sleep / emote / swim)로
묶어서 재생합니다.

- Quaternius 육상: `Idle`, `Idle_2`, `Idle_2_HeadLow`, `Walk`, `Gallop`, `Gallop_Jump`, `Jump_ToIdle`, `Eating`
- Vuena 고양이: `idle`, `idle_alt`, `walk`, `run`, `jump`, `eat`, `sit`, `sleep`, `call`
- Gamideo: `idle`, `walk`, `gesture`, `swimIdle`, `swim`
- Gobkit: `idle`, `walk`
- Quaternius 물고기: `Swimming_Normal`, `Swimming_Fast`, `Swimming_Impulse`, `Armature|Swim`
