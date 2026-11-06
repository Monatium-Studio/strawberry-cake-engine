# SD 캐릭터 키트 (`art/blender/lib/elf.py`)

머리가 큰 SD 툰 화풍(약 2.5등신)의 엘프형 캐릭터를 같은 몸·리그·얼굴·화풍으로 만드는 Blender 헤드리스 키트다.
몸, A 포즈 리그와 소켓, 머리와 귀, 얼굴 데칼과 표정 모프, 머리카락, 옷과 장비를 만든다. `finalize()`가 파츠를 그룹별로 합치고, `export()`가 glb로 내보낸다.
런타임 쪽 짝은 `src/character/`다: `Character`, `FaceRig`(`face.ts`), 자세 표(`poses.ts`), 손 IK(`hold.ts`).

- 실행: `npm run model -- <스크립트.py>`. 실행기는 환경 변수 `PROJECT_ROOT`에 프로젝트 루트를 넣는다. 예전 이름 `COMBATIUM_ROOT`도 대신 받는다(`cb.ROOT`).
- 결과물: `public/models/<경로>.glb`. 확인: `npm run shot -- <경로>.glb`.

---

## 1. 빠른 시작

```python
import os, sys
sys.path.insert(0, os.path.join(os.environ["PROJECT_ROOT"], "art", "blender", "lib"))
import cb, elf

cb.reset()
e = elf.Elf("hero")                          # 몸 + 리그 + 머리 + 귀 + 소켓이 바로 생긴다
e.face(eye_color="#5b7fb8")                  # 눈·눈썹·입·볼터치 + 표정 셰이프 키
h = e.hair("#7a5140")                        # 머리카락 도구
h.cap(); h.bangs(); h.sides(); h.back(length=0.10)

jacket = elf.mat("hero_jacket", "#a3ada1")   # cb.mat과 같다
e.shirt(jacket, collar="stand")              # 몸판
e.sleeves(jacket, cuff=(elf.mat("hero_cuff", "#7f8a80"), 0.022, 0.0045))
e.pants(elf.mat("hero_pants", "#939e98"), blouse=0.02)
e.boots(elf.mat("hero_boots", "#58535d"), sole=(elf.mat("hero_sole", "#2f2b31"), 0.016))
e.belt(elf.mat("hero_belt", "#4a4149"), buckle=elf.mat("hero_metal", "#cfcac4"))

e.finalize()                                 # 맨살 생성 → 그룹별 합치기·스키닝 → 삼각형 보고
e.export("characters/hero.glb")              # outline 0.006 기본
```

```bash
npm run model -- art/blender/characters/hero.py      # [elf] 줄에 파츠별 삼각형 수가 찍힌다
npm run shot -- characters/hero.glb
npm run shot -- characters/hero.glb --focus hero_face --views front,34
```

순서: `Elf()` → `face()` → `hair()` → 옷·장비 → `finalize()` → `export()`.
옷은 아무 순서로 불러도 된다. 맨살은 `finalize()` 때 옷에 덮이지 않은 부분만 만들어진다.

게임 저장소에서 엔진을 하위 모듈(`engine/`)로 쓸 때는 엔진의 키트 폴더를 경로 앞에 넣는다. 게임 쪽 도우미 모듈은 그 뒤에 둔다.

```python
ROOT = os.environ.get("PROJECT_ROOT") or os.environ["COMBATIUM_ROOT"]
sys.path.insert(0, os.path.join(ROOT, "art", "blender", "lib"))                       # 게임 도우미
sys.path.insert(0, os.path.join(ROOT, "engine", "art", "blender", "lib"))             # 엔진 키트 (cb, elf)
```

---

## 2. 몸 파라미터 `Elf(name, **kw)`

| 인자 | 기본 | 뜻 |
|---|---|---|
| `height` | 1.20 | 정수리까지 키(m), 귀·머리카락 제외 |
| `head` | 0.45 | 턱~정수리(m). 2.67등신. 머리카락까지 넣으면 약 2.45등신 |
| `head_w`, `head_d` | 1.06, 0.92 | 머리 폭과 깊이 (`head`에 대한 비율) |
| `cheek` | 0.10 | 볼 부풂 (0~0.35). 머리 모양만 바꾼다 |
| `cheek_h`, `cheek_w` | -0.38, 0.36 | 볼 혹 중심 높이·세로 폭 (머리 단위구 z, 턱 = -1, 눈 ≈ -0.37) |
| `cheek_kx`, `cheek_ky` | 0.4, 0.5 | 볼 혹의 옆 기본 비중, 앞쪽 비중 |
| `jaw`, `jaw_d` | 0.16, 0.14 | 턱 가로·앞뒤 좁힘 (U자 턱) |
| `base` | 2.0 | 아래 반구 단면의 초타원 지수. 3이면 납작하고 넓은 떡 바닥 |
| `face_flat` | 1.0 | 얼굴 앞면을 평평하게 하는 정도 배율 |
| `face_shade` | 0.6 | 얼굴 음영 법선: 머리 피부·얼굴 데칼 법선을 앞쪽으로 눕히는 정도(0~1). 4장 '얼굴 음영' |
| `thigh` | 1.0 | 허벅지 굵기 배율. 고관절 쪽(t < 0.12)은 1배(옷 밖으로 비어져 나오지 않게), 허벅지 가운데에서 최대, 무릎 아래는 40%만 따라간다 |
| `shoulders`, `hips` | 1.0 | 어깨·골반 폭 배율 |
| `limb` | 1.0 | 팔다리 굵기 배율 |
| `arm`, `leg` | 1.0 | 팔·다리 길이 배율 |
| `chest` | 0.15 | 흉곽 앞뒤 두께 (0~1) |
| `bust` | 0 | 가슴(흉부) 형태 (0~1). 0이면 평평한 몸통이다. 아래 '체형: bust' 참고 |
| `apose` | 40 | A 포즈 팔 각도 (수평에서 아래로, 도) |
| `ear_len`, `ear_width` | 0.095, 0.060 | 귀 길이·폭(m) |
| `ear_angle`, `ear_sweep` | 14, 12 | 귀를 위로 든 각, 뒤로 젖힌 각(도) |
| `ear_inner` | True | 안쪽 귀 음영 판 |
| `skin` | `#fff0ea` | 피부색 (hex 또는 머티리얼) |
| `line` | `#4a2229` | 라인색 (merge 시 공통) |
| `segs` | 1.0 | 전체 분할 배율. 여럿 등장하는 단역은 0.7~0.85 |
| `hand_q` | 1.0 | 손 분할 배율. 1인칭 팔은 1.2, 3인칭 단역은 0.6~0.8 |
| `eye_depth` | 0.04 | `socket_eye`를 얼굴 표면에서 머리 안쪽으로 넣는 깊이(m). 7장 참고 |
| `cheek_rig` | True | 볼 리그(`cheek_L`·`cheek_R` 본 + 볼 웨이트). 8장 |

**얼굴 모양 = 하우스 스타일**: 키트 기본 얼굴·볼 모양(`cheek` 0.08~0.12와 `_head_fn`의 볼·턱 기본값)이 **모나티엄 스튜디오의 트릭컬 하우스 스타일**이다(사용자 결정, 2026-11-06). 새 인물도 이 모양으로 만든다.
- 떡 볼 인자(`cheek_h`, `cheek_w`, `cheek_kx`, `cheek_ky`, `jaw`, `jaw_d`, `base`)는 **시험용이고 기본은 꺼져 있다**(기본값 = 하우스 스타일 그대로).
  - 게임 저장소 `docs/art/cheeks-research.md` 4.3절 v6 값을 이드에 시험했다. 원래 볼이 맞다는 결정으로 쓰지 않는다.
  - v6 값: `cheek=0.30`, `cheek_h=-0.68`, `cheek_w=0.27`, `cheek_kx=0.3`, `cheek_ky=0.9`, `jaw=0`, `jaw_d=0.08`, `base=3.0`, `head_w=0.98`.
  - 켜면 볼 리그 본 자리(`_cheek_center`)와 촘촘한 격자 띠가 `cheek_h`를 따라 내려간다. 볼 혹 위 이음부(경도 ±50~75°)가 오목해 외곽선 헐이 비칠 수 있다.

기본 체격(m): 정수리 1.20, 눈 0.90, 턱 0.75, 어깨 관절 0.686(좌우 ±0.136), 고관절 0.348, 가랑이 0.298, 무릎 0.188, 발목 0.062.
`height`를 바꾸면 턱 아래 몸 전체가 같은 비율(`e.k`)로 줄거나 늘어난다. 옷과 장비 치수도 `e.k`를 곱해서 쓴다.

**체형: `bust`**
- 성인 체형으로 가슴 볼륨이 보이는 인물에게만 준다. 아이 체형은 0으로 둔다.
- 모양: 정면 ±31°에 중심을 둔 두 둥근 볼륨이 가운데에서 이어진 한 덩어리다. 위쪽은 쇄골 아래부터 완만하게 올라오고, 아래쪽은 더 둥글게 닫힌다. 꼭짓점 높이는 `e.bust_z`(고관절~어깨의 71%)다. `bust=1`이면 꼭짓점이 `BUST_DEPTH`(0.052 m × `e.k`)만큼 나온다.
- 옷 층: 몸에서 띄운 거리(`off`)가 클수록 가운데 골이 메워지고(맨살 62% → 옷 86%) 아래쪽이 천처럼 완만하게 떨어진다. 몸에 붙는 옷도 골을 파지 않는다. 과장하지 않고 SD 툰 화풍 안에서 단정한 형태만 낸다.
- 따라가는 것: 맨살, `shirt`(앞여밈·단추 포함), `pants`·`underwear` 윗단, `torso_stations`로 만든 모든 관(`loft` station의 `disp`), `ring("torso", …)` 가슴띠(`band(disp=)`), `torso_point`/`anchor`를 쓰는 파우치·패치·끈·장비. `torso_point`는 볼륨 곡면의 법선을 돌려준다.
- 직접 만든 몸통 파츠는 `e.bust_off(z, angle, off)`(바깥으로 더할 두께, m)를 더하면 같은 면을 따른다.
- 0이면 어떤 경로도 값을 더하지 않는다.

**표면 좌표 도우미** (장비를 직접 배치할 때)
- `e.torso_point(z, angle, off)` → (점, 법선). angle 0=정면, +90=캐릭터 왼쪽(+X), 180=등
- `e.limb_point("leg_R", t, angle, off)`. t는 팔다리 길이 비율(0=어깨·고관절, 1=손목·발목)
- `e.head_point(az, el, off)`. az 0=정면, 90=왼쪽, el은 위로 +도
- `e.face_project(x, z, off)`: 정면에서 (x, z)를 얼굴 표면에 투영
- `e.anchor(at)` → `Anchor`(위치, 법선, 위 방향, 웨이트, fpHide 그룹). at은 `("torso", z, angle[, off])`, `("leg_L", t, angle[, off])`, `("arm_R", t, angle[, off])`, `("head", az, el[, off])`
- 높이 상수: `e.chest_z`, `e.waist_z`, `e.hipj_z`, `e.crotch_z`, `e.knee_z`, `e.shoulder_z`, `e.torso_top`, `e.chin`, `e.eye_z()`

---

## 3. 리그

### 본 (38개 + 선택)

```
root
└ hips ─ spine ─ chest ─ neck ─ head ─ ear_L, ear_R, cheek_L, cheek_R, (hair_*)
  │               └ shoulder_L ─ upperarm_L ─ forearm_L ─ hand_L ─ thumb_01_L ─ thumb_02_L
  │                                                              ├ f1_01_L ─ f1_02_L   (검지 쪽)
  │                                                              ├ f2_01_L ─ f2_02_L
  │                                                              └ f3_01_L ─ f3_02_L   (새끼 쪽)
  ├ thigh_L ─ shin_L ─ foot_L
  └ (오른쪽 _R 대칭)
```
- 레스트 포즈는 A 포즈다(팔이 수평에서 40° 아래). 손바닥은 몸 쪽을 향하고 엄지는 앞을 향한다.
- `h.ponytail()`, `h.twintails()`는 `hair_tail_01/02`(또는 `hair_tail_L_01…`) 본을 더한다. 직접 더할 때는 `e.add_bone(name, head, tail, parent)`.

### 회전 규칙 (Blender 액션과 three.js 코드 모두 같다)

본 로컬 축: **+Y = 본 방향(자식 쪽)**, **+Z = 앞**(손·손가락은 손바닥 쪽, 발·귀는 위), X = Y × Z.
glTF로 나가도 축이 그대로다(`bone.rotation.x` = Blender 로컬 X).

| 본 | 로컬 회전(도) | 결과 |
|---|---|---|
| `spine`, `chest`, `neck`, `head` | +X | 앞으로 숙임 |
| `head` | +Y | 캐릭터 왼쪽으로 고개 돌림 |
| `head` | +Z | 오른쪽 귀를 어깨 쪽으로 기울임 |
| `upperarm_*` | +X | 팔을 앞으로 들기 |
| `upperarm_L` / `upperarm_R` | **+Z / −Z** | 팔을 옆으로 들기 (좌우 반대 부호) |
| `forearm_*` | +X | 팔꿈치 굽힘 |
| `hand_*` | +X | 손목을 손바닥 쪽으로 |
| `thumb_*`, `f1~f3_*` | +X | 손바닥 쪽으로 말기 (주먹: `_01` 70°, `_02` 80°, 엄지 25°/40°) |
| `thigh_*` | +X | 다리를 앞으로 들기 |
| `shin_*` | **−X** | 무릎 굽힘 |
| `foot_*` | +X | 발끝 들기 |
| `ear_*` | +X | 귀 끝을 위로 |
| `hair_tail_*` | +X | 꼬리를 위·앞으로 |

포즈 확인용 액션은 `e.pose({"upperarm_L": (70, 0, 0), ...})`로 만든다. 확인 명령은 `npm run shot -- characters/<이름>.glb --mode single --view 34`.

### 소켓 (빈 오브젝트, 본에 부착)

| 소켓 | 본 | 위치 | three.js 방향 |
|---|---|---|---|
| `socket_eye` | head | 두 눈 사이 중앙 높이(0.90 m), 얼굴 표면에서 `eye_depth` 안쪽 | 회전 없음 |
| `socket_hand_R` | hand_R | 주먹 안쪽 (손바닥에서 2.6 cm) | **−Z = 손가락 방향(소품 앞)**, **+Y = 엄지 쪽(소품 위)** → 소품 루트를 그대로 자식으로 붙인다 |
| `socket_hand_L` | hand_L | 같은 위치 (왼손) | 같은 규칙 |
| `socket_back` | chest | 등 뒤 5 cm | 회전 없음 |
| `socket_hip_R` | hips | 오른쪽 골반 바깥 3 cm | 회전 없음 |

---

## 4. 스키닝 방식과 근거

**결정: 모든 파츠를 '계산한 웨이트로 스키닝'한다. 자동 웨이트(bone heat)와 `parent_to_bone` 강체는 쓰지 않는다(볼 리그를 끈 얼굴만 예외).**

| 방식 | 헤드리스 안정성 | 관절 변형 | 드로우콜 | 결론 |
|---|---|---|---|---|
| `ARMATURE_AUTO`(bone heat) | 메시가 겹치거나 떨어져 있으면 "failed to find solution"으로 실패하고, 결과가 실행마다 달라질 수 있다 | 좋음 | 보통 | 안 씀 |
| `parent_to_bone` 강체 | 안정 | 관절이 갈라지거나 겹쳐 보인다 | 파츠 수만큼 늘어남 | 볼 리그를 끈 얼굴만 |
| **계산 웨이트 (채택)** | 항상 같은 결과, 실패 없음 | 관절 앞뒤로 부드럽게 섞음 | 그룹당 1메시 | **채택** |

- 몸·옷 관은 본 경로(`Chain`)를 따라 만들기 때문에 각 단면의 위치 t를 안다. 관절 앞뒤 32% 구간에서 두 본을 smoothstep으로 섞는다. 팔과 다리의 시작부는 `shoulder_*`·`hips`와 섞는다.
- 몸통은 높이에 따라 hips → spine → chest로 섞고, 어깨 위 바깥쪽은 `shoulder_*`, 가랑이 아래쪽은 `thigh_*`로 섞는다(`_torso_wfn`).
- 단단한 장비(버클, 파우치, 패치)는 붙는 지점(`anchor`)의 웨이트를 정점 전체에 그대로 쓴다. 결과는 강체처럼 움직이면서도 같은 메시에 합쳐진다.
- 손가락은 손가락마다 `hand → _01 → _02` 경로 웨이트, 귀는 뿌리에서 `head → ear_*`로 섞는다.
- 얼굴(`face`)과 얼굴 데칼 파츠는 볼 리그(8장)가 있으면 머리 피부와 같은 볼 웨이트로 스키닝하고, `cheek_rig=False`면 head 본에 강체로 붙인다.
- `e.add(obj, bone="chest")`로 직접 만든 메시를 그 본에 100% 스키닝해 합칠 수 있다. 움직이는 장비를 따로 남기려면 `keep=True`를 준다.

**얼굴 음영과 선 (각도마다 얼굴에 보이던 경계선 없애기)**
- 머리 피부 법선은 메시에서 계산하지 않고 **해석 표면(`_head_fn`)의 법선**을 custom split normals로 넣는다(`_head_normals`). 메시 밀도가 바뀌는 곳·극점 부채꼴에서도 툰 경계가 얼룩지지 않는다.
- **`face_shade`**(기본 0.6): 얼굴 앞 아래쪽(볼·턱) 법선을 앞으로 눕힌다(애니 얼굴 법선 기법). 카메라에 붙은 주광에서 툰 경계(밝음/중간)가 얼굴을 가로지르는 띠가 덜 생긴다. 0이면 해석 법선 그대로.
- **얼굴 데칼**(`_face`와 `face_decal()`로 등록한 파츠)도 바로 아래 피부의 같은 음영 법선을 받는다(`skin_normal_at`, `_decal_normals`). 볼터치 위 툰 경계가 피부 경계와 이어진다(예전: 볼터치 가장자리에 계단).
- **모프 법선은 내보내지 않는다**(`cb.export`의 `export_morph_normal=False`). 내보내기가 셰이프 키 법선을 기하에서 다시 계산해 정한 법선과의 차이(뒤집힘 Δ≈2)를 모프로 넣기 때문이다. 표정 모프는 위치만 움직인다.
- **얼굴 앞면은 볼록해야 한다**: 오목한 주름이 있으면 외곽선 헐(법선 방향으로 민 뒷면)이 얼굴 위에 짧은 선으로 비친다. `face_flat`의 가운데 V자 골(|x|)을 매끈한 절댓값으로 바꿨다.

---

## 5. 최종 메시 구조와 드로우콜

`finalize()`가 만드는 것:

| 노드 | 내용 | 스키닝 | 커스텀 속성 |
|---|---|---|---|
| `<이름>_body` | 몸통, 다리, 발/장화, 벨트, 파우치, 끈, 몸판 옷 | 계산 웨이트 | — |
| `<이름>_arms` | 위팔부터 손끝까지: 팔, 소매, 손/장갑, 팔 패치 | 계산 웨이트 | `fpHide="arms"` |
| `<이름>_head` | 목, 머리, 귀, 모자·헬멧, 머리 장비 | 계산 웨이트 (머리 피부는 head + 볼) | `fpHide="head"` |
| `<이름>_hair` | 머리카락 셸, 꼬리, 땋은 머리, 바보털 (모프 없음) | 계산 웨이트 (head + 흔들림 본) | `fpHide="head"`, `outline=0.0035` |
| `<이름>_hair_in` | 머리카락 속층, 광택 | 계산 웨이트 | `fpHide="head"`, `noOutline=1` |
| `<이름>_face` | 눈·눈썹·입·볼터치, 셰이프 키 | 볼 리그가 있으면 계산 웨이트 (head + 볼), 없으면 head 본에 부착 | `fpHide="head"`, `noOutline=1` |

- **merge=True(기본)**: 불투명 툰 머티리얼의 색을 정점색(`COLOR_0`)으로 굽고 머티리얼 하나(`<이름>_toon_vc`, `lineColor` 공통)로 합친다. UNLIT, 발광, 반투명 머티리얼은 따로 남는다.
  → 캐릭터 하나가 **보통 메시 6개(body, arms, head, hair, hair_in, face) × 머티리얼 1~2개**, 즉 드로우콜 7~8개(+아웃라인, hair_in·face 제외)다. 라인도 한 색이 된다.
- 머티리얼별 라인색이 꼭 필요하면 `finalize(merge=False)`를 쓴다. 이때 머티리얼 수가 예산(12개)을 넘지 않게 한다.
- `finalize(only=("arms",))`는 한 그룹만 남긴다(1인칭 팔). 리그와 소켓은 그대로 남는다.
- `e.add(obj, node="이름", props={...})`: 같은 node끼리 따로 합쳐 `<인물>_<node>` 오브젝트로 만든다(반투명 겉옷, 아웃라인 없는 표식 등).
- `[elf] <이름> tris=… hair=… helmet=…` 줄에 파츠별 삼각형 수가 찍힌다. 예산을 맞출 때 쓴다.

---

## 6. 얼굴과 표정 `e.face(**kw)`

얼굴 파츠는 머리 표면에 투영한 **데칼**이다: 2D 설계 좌표(정면에서 본 x, z)를 `face_project`로 머리 피부 위 0.8~3.1 mm에 띄운다. 그래서 머리 모양이 바뀌면 얼굴도 같이 따라간다.

| 인자 | 기본 | |
|---|---|---|
| `eye_color` | `#5a7fb5` | 홍채색. 짙은 띠, 밝은 반달, 동공 색은 자동으로 만든다(`iris_dark`, `iris_light`, `pupil`로 지정 가능) |
| `eye_size`, `eye_spacing`, `eye_height` | 1, 1, 0 | 크기 배율, 간격 배율, 높이 이동(m) |
| `lash`, `brow` | `#3a2027`, lash와 같음 | 속눈썹·눈썹 색 (머리색을 어둡게 해서 주면 자연스럽다) |
| `brow_th` | 1.0 | 눈썹 굵기 배율 |
| `mouth_color`, `tongue` | `#9a3b45`, `#f2898c` | |
| `blush`, `blush_size`, `blush_lines` | `#f9aca8`, 1, 0 | 볼터치. 빗금은 기본 0 (빗금은 점 5개 띠라 둥근 볼을 따른다) |
| `blush_dx`, `blush_dz` | 0.034, -0.050 | 볼터치 중심 (눈 중심 기준, 눈 크기 배). 떡 볼 인물은 바깥 0.06 |
| `blush_soft` | 0 | 볼터치 가장자리 그라데이션 (0~1): 바깥 고리부터 피부색으로 녹인다(정점색) |
| `blush_line_color` | 볼터치를 어둡게 | 빗금 색 |
| `closed_lash` | None | 감은 눈 속눈썹 띠 (True 또는 사전). 감은 눈꺼풀 선 아래로 처진 다발 n개의 연한 띠 + 가장자리 선. 깊이·선 굵기가 `close`에 비례해 뜬 눈에서는 선 위로 접힌다(모든 표정·`blink_` 교정 키와 같이 움직인다). 사전 키: `n`(3), `len`(0.020), `span`, `base`, `grow`, `skew`, `round`(0 뾰족 톱니 ~ 1 둥근 다발), `line_w`, `fill`, `line` (`CLOSED_LASH`) |
| `lower_lash` | True | 아래 속눈썹 짧은 선 |
| `base` | — | 무표정 자체를 바꾸는 사전. 예: `{"eye": {"top": 0.022}}` → 기본이 졸린 눈. `eye.cdip`: 감은 눈꺼풀 선 가운데가 내려가는 양(기본 0.010 = ‿, 음수면 ⌒ 졸린 눈) |
| `expr` | — | 표정 추가·덮어쓰기. 예: `{"wink_L": {...}}` |

**모프 타깃 이름** (glTF 순서 고정)
- 표정: `blink`, `serious`, `surprised`, `pained`, `smile`
- 말하기: `talk`(입만 연다), `talk_o`(오 모양). 눈·눈썹은 그대로다
- 시선: `look_L`, `look_R`, `look_up`, `look_down`. 캐릭터 기준 방향이고 두 눈이 같이 움직인다. 홍채·동공·하이라이트가 눈 윤곽 안에서 움직인다
- 교정 키: `blink_serious`, `blink_surprised`, `blink_pained`, `blink_smile`, `blink_look_L`, `blink_look_R`, `blink_look_up`, `blink_look_down`. 눈을 건드리지 않는 표정(talk)에는 없다
- 모프는 더해진다. 그래서 `blink`와 다른 표정을 함께 1로 두면 눈꺼풀이 겹친다(웃으면서 깜빡일 때 등).
- 교정 키는 '그 표정으로 눈을 감은 모양'에서 두 키의 합을 뺀 차이다. **런타임 규칙: `blink_`로 시작하는 모든 모프 키 `blink_<X>`에 대해 `blink × <X>`**. 인물이 `expr=`로 추가한 표정도 같은 규칙으로 처리된다. 예를 들어 smile 1에 blink 1이면 `blink_smile`도 1이고, 결과는 웃는 입에 감은 눈이다.
- `expr=`로 추가한 표정도 교정 키가 자동으로 생긴다(이름이 `blink`로 시작하거나 `close`를 쓰는 표정은 제외).
- 홍채 위쪽은 모든 표정에서 윗눈꺼풀에 잘리도록 둔다(`iris.cz + iris.ry` ≥ 윗눈꺼풀 높이). 사이에 흰 띠가 생기면 속눈썹이 두 번째 눈썹처럼 떠 보인다. `base=`나 `expr=`로 눈을 바꿀 때 이 조건을 지킨다.
- 모프는 `_face` 노드에만 둔다. 합친 몸 메시(body·head·hair)에는 셰이프 키를 두지 않는다(모프가 큰 메시 전체를 따라 GPU로 올라간다).
- 뷰어 확인: `npm run shot -- characters/<이름>.glb --focus <이름>_face --views front --morph smile:1,blink:1,blink_smile:1`

**런타임 규칙 (`FaceRig`, `Character`)**
1. **말하기**: 대사가 나오는 동안 `talk`를 0~1로 빠르게 진동시킨다. 둥근 모음에서는 `talk` 대신 `talk_o`를 섞는다. 다른 표정과는 그냥 더한다.
2. **시선**: 2축 값 `gx, gy ∈ [-1, 1]`(캐릭터 기준 왼쪽 +, 위 +)을 `look_L = max(gx, 0)`, `look_R = max(-gx, 0)`, `look_up = max(gy, 0)`, `look_down = max(-gy, 0)`으로 나눈다. 머리 회전(head 본)과 함께 쓰면 눈이 먼저, 머리가 뒤따르게 한다.
3. **눈을 가늘게 뜨는 표정과 시선**: 모프는 더해지므로 시선 값에 `(1 - 0.6 × max(smile, pained, serious))`를 곱한다.
4. **깜빡임**: `blink_<X> = blink × <X>`는 시선 키에도 그대로 적용된다.

표정 파라미터(`FACE_NEUTRAL`, `FACE_EXPR`)는 사전으로 되어 있다. 눈은 `top/bot/cin/cout/ktop/kbot/tilt_in/tilt_out/lift/close`, 홍채는 `rx/ry/cx/cz/pupil/gx/gz`, 눈썹은 `dz/dx/len/th/ang/arch`, 입은 `w/curve/open/top_arch/wave/dz`다.
모든 표정은 같은 정점 수로 다시 계산되므로 어떤 조합도 셰이프 키가 된다.

`face` 노드는 머티리얼 수만큼 자식 메시를 갖는다(본체 + UNLIT 하이라이트). `FaceRig`가 **모든 자식에 같은 값을** 넣는다. 아웃라인 헐은 같은 influence 배열을 공유한다(`toon.ts`). 얼굴은 `noOutline`이라 헐이 없다.

---

## 7. 1인칭 몸 규약

- **숨김 태그 `fpHide`**: `"head"`(목·머리·얼굴·머리카락·귀·모자/헬멧), `"arms"`(어깨 아래 팔·소매·장갑·손). 키트가 그룹을 나눠 자동으로 단다. 직접 만든 파츠는 `e.add(obj, group="head")`나 anchor로 그룹이 정해진다.
- **목은 head 그룹**이다. 내려다볼 때 목 단면이 카메라 안에 보이지 않는다. 몸판 옷의 목 구멍은 평평하게 막혀 있다.
- **socket_eye**: 두 눈 사이 중앙 높이이고, 얼굴 표면에서 `eye_depth`(기본 0.04 m)만큼 머리 안쪽에 있다. SD 머리는 얼굴이 가슴 앞면보다 약 0.17 m 앞에 있어서, 얼굴 표면에 두면 내려다봐도 발끝만 보이고, 0.1 m보다 깊으면 가슴 윗면이 화면을 덮는다. 0.04 m가 둘 사이 절충이다.
- 서 있을 때 벨트·허벅지·신발은 SD 몸통에 가려진다. 1인칭에서 보여야 할 장비는 가슴 높이(`e.chest_z` 근처)에 둔다.
- **1인칭 팔 뷰모델**은 같은 키트로 같은 소매·장갑을 입혀 `finalize(only=("arms",))`로 내보낸다(`hand_q=1.2`, outline 0.0015~0.0025). 전신 모델의 옷과 반드시 같은 함수·색을 쓴다.

---

## 8. 볼 리그 (볼따구) `Elf(cheek_rig=True)`

말랑한 볼은 이 화풍의 얼굴에서 가장 눈에 띄는 곳이다. 볼을 머리 모양 값(`cheek`)으로만 두지 않고, 런타임에서 출렁이고·부풀고·눌리고·잡아 늘일 수 있게 본 둘로 만든다. 무거운 모프를 합친 몸 메시에 두지 않고 본 이동·배율로 낸다.

**Blender 쪽 (`_build_cheek_rig`)**
- 본: `cheek_L`, `cheek_R` (head의 자식). 볼 중심 = 기본 볼터치 자리 근처(눈 아래 바깥)를 얼굴 표면에 투영한 점. 본 머리는 그 점에서 머리 안쪽으로 `CHEEK_DEPTH`(4.5 cm × 머리 크기), 꼬리는 볼 표면이다. 로컬 **+Y = 볼 바깥 법선**, **+Z = 위**. 본 머리가 안쪽에 있어서 본을 늘리면 볼이 바깥으로 부푼다.
- 웨이트: 볼 중심에서 타원체 거리 r로 `(1 - r²)²` (경계에서 매끄럽게 0). 반경(`CHEEK_R`, 머리 크기 배) 가로 10 cm, 위 5.2 cm, 아래 7.8 cm, 깊이 6.4 cm. 위쪽이 짧아 **눈 윗부분·이마·귀에는 닿지 않고**, 깊이 반경 때문에 머리 옆·뒤 피부에도 닿지 않는다. 좌우가 가운데에서 겹치지 않는다(합이 1을 넘으면 나눈다).
- **같은 웨이트를 피부와 데칼에 똑같이**: 머리 피부 정점은 위 식을 쓰고, 얼굴 데칼 정점(볼터치·입·눈 아래쪽·얼굴 표식)은 가장 가까운 피부 삼각형 세 꼭짓점 웨이트를 무게중심 좌표로 섞는다(`cheek_decal_w`). 그래서 볼을 옮기면 데칼이 아래 피부 삼각형과 정확히 같이 움직여 떨어지지 않는다. 머리카락에는 볼 웨이트를 주지 않는다.
- 볼 둘레는 머리를 만들 때부터 **촘촘한 쿼드 격자**로 만든다(`_graded`: 경도 ±4~72°, 높이 `cheek_h` 둘레의 간격을 매끈하게 2.6배 좁힘). 늘이고 부풀려도 각이 지지 않는다. 볼터치도 더 촘촘히 나눈다(테두리 28점, 고리 6겹). 비용: 머리 +0.3~0.5k, 얼굴 +0.5k 삼각형 안팎.
  - 예전에는 만든 뒤 볼 둘레 면만 `smooth=1.0`으로 3×3 나눴다. 새 점이 표면 밖으로 부풀어 나눈 영역 경계에 오목한 고리와 n각형 주름이 생겼다. 그 결과 각도마다 얼굴에 외곽선 헐이 선으로 비쳤고, 법선이 어긋나 툰 경계가 얼룩졌고, 볼터치 빗금이 피부에 묻혔다. 2026-11 고침.
- 얼굴(`_face`)은 셰이프 키를 가진 채 Armature로 스키닝된다(glTF 스킨 + 모프. Blender 5.2 내보내기 확인). 얼굴 데칼 파츠는 `e.face_decal(tag_or_obj)`로 등록하면 같은 웨이트를 받는다.
- 볼 모프를 더하고 싶으면 `_face` 노드에만 둔다(6장 규칙). 합친 몸 메시에는 모프를 두지 않는다.
- 끄기: `Elf(..., cheek_rig=False)` → 본·웨이트·면 나누기 없이 예전과 같은 모델(얼굴은 head 본에 강체 부착).

**런타임 (`src/character/cheeks.ts`, `CheekRig`)**
- `Character`가 모델에 `cheek_L`·`cheek_R` 본이 있으면 `ch.cheeks`를 만들고 `animate(dt)`마다 돌린다(없으면 null). 다른 곳에서 쓸 때는 `CheekRig.from(model)` + 매 프레임 `update(dt)`.
- 출렁임: 볼마다 질량-스프링-감쇠. head 본의 월드 가속도를 거꾸로 받아(관성) 달리기·착지·충격에 볼이 늦게 따라오며 흔들린다. 볼이 아래로 처지면(착지) 저절로 조금 눌린다.
- API
  - `puff(amount)`: 부풀리기 목표 0~1 (예: 차기 힘 모으는 동안 1, 놓으면 0 → 살짝 튕기며 가라앉는다)
  - `squash(amount)`: 한 번 눌렀다가 튕기며 돌아온다 (차기 순간, 착지). 세로로 눌리고 옆·바깥으로 퍼진다
  - `pull(side, vec)` / `release(side?)`: 볼을 잡아 끈다. `side`는 `'L'`·`'R'`·`'both'`, `vec`는 m(머리 크기 1 기준): **x = 얼굴 바깥쪽(양쪽 모두 +), y = 위, z = 앞**. 놓으면 출렁이며 돌아온다
  - `impulse(vec)`: 볼에 속도 충격 (월드 방향, 1 = 센 충격)
  - `set({ puff, squash })`: 점검·연출용으로 값을 바로 놓는다. `reset()`, `state()`, `enabled`
- 옵션(`CheekRigOptions`): `stiffness`(240), `damping`(7), `inertia`(0.12), `maxJiggle`(1.0 cm), `maxPull`(3.4 cm), `pullStiffness`, `puffScale`, `squashScale`, `shapeStiffness`, `shapeDamping`, `maxAccel`(120 m/s²), `maxDt`(0.1초), `teleport`(1 m). 길이 한계는 머리 크기(두 볼 본 사이 거리 / 0.238 m)를 곱한다.
- 한계: 출렁임은 `maxJiggle` 구 안, 잡기는 바깥 `maxPull`·안쪽 30%·위아래 50%·앞 80%·뒤 20% 타원체 안으로 부드럽게 자른다. 이 한계 안에서 데칼이 피부 아래로 묻히지 않는 것을 Blender에서 확인했다(가장 깊은 곳 0.3 mm 안쪽, 얼굴 깊이 치우침이 덮는다).
- 수치 안정: 한 프레임 dt는 `maxDt`까지만 쓰고 1/120초 조각의 암시적 오일러로 푼다(어떤 강성에서도 발산하지 않는다). 가속도는 `maxAccel`로 자르고, 순간 이동은 흔들림 없이 새 자리에서 다시 시작한다.

**해 보기**: 모델 뷰어 단일 보기(`/viewer.html?model=…`)에서 볼 리그가 있는 모델을 열면 오른쪽 아래에 조작판이 생긴다. P 부풀리기, S 눌림, L·R·B 왼볼·오른볼·양볼 늘리기, 스페이스 놓기, H 뛰어올랐다 착지, J 달리기(위아래 흔들림). 시트 모드 점검: `&cheek=puff:1`, `&cheek=squash:1`, `&cheek=pull:0.034;0;0.01`(`pullL`·`pullR`도 된다).

```ts
const ed = new Character('ed', model, physics);
ed.cheeks?.puff(1);                                   // 힘 모으기
ed.cheeks?.puff(0); ed.cheeks?.squash(1);             // 차는 순간
ed.cheeks?.pull('both', { x: 0.03, y: 0, z: 0.01 });  // 볼따구 늘리기
ed.cheeks?.release();
```

---

## 9. 머리카락 `h = e.hair(color, dark=None, light=None, off=0.028, outline=0.0035, volume=1.0)`

- **머리 덩어리 전체가 한 장의 매끈한 셸**이다. 정수리에서 경도마다 머리 표면을 따라 내려오고, 머리가 가장 넓은 곳부터는 아래로 떨어진다. 셸은 '다발'로 나뉘지만 **끝 쪽에서만 갈라지고**(다발마다 갈라짐 시작 길이가 다름), 위쪽은 한 면으로 이어진다. 다발끼리 서로 파고들지 않아서 아웃라인 쐐기가 생기지 않는다.
- 다발 끝은 `(1-x^p)^(1/p)` 곡선으로 폭과 두께를 유지하다 끝에서만 모인다. 다발마다 폭·길이·갈라짐 깊이·쓸림이 다르다. 경계에는 얕은 결 홈, 가르마에는 낮은 홈이 있다.
- **속층**(`<이름>_hair_in`, 어두운 머리색, `noOutline`)이 다발 사이 틈 뒤를 메운다. 머리 광택(`shine`)도 여기에 붙는다.
- 머리카락 메시는 `<이름>_hair` 노드로 따로 나오고 `outline=0.0035`(몸 0.006보다 얇음)를 단다. 둘 다 `fpHide="head"`이고 **모프는 없다**. 볼 본 웨이트도 받지 않는다.
- 긴 머리(머리가 가장 넓은 곳에서 0.12 m 넘게 떨어짐)는 흔들림 본 `hair_back_01..03`(chest 자식)을 만들고, 웨이트는 뿌리 head → 사슬로 섞는다. 긴 옆머리는 `hair_side_L/R_01/02`.
- 포니테일·트윈테일·땋은 머리는 매끈한 스윕 볼륨에 본 사슬과 부드러운 웨이트를 쓴다. 뿌리는 셸 안에 묻고 묶음 띠로 덮는다.
- `bangs/sides/back/ponytail/...`은 **사양만 기록**하고, 실제 기하는 `h.done()`(finalize가 부름)에서 한 번에 만든다. 영역 색은 `h.bangs(mat=...)`, `h.sides(mat=...)`, `h.back(mat=...)`로 준다.
- 무시되는 예전 인자(`bangs(width)`, `sides(flare)`, `back(width/flare/layers)`)는 `[elf] 경고:`를 출력하고 넘어간다.
- `elf.sweep`의 면은 바깥을 본다(`elf.SWEEP_WINDING == "outward"`).

| 함수 | 주요 인자 | |
|---|---|---|
| `h.cap()` | `front=26, side=-12, back=-50`(머리선 높이, 도), `part`(가르마 방위), `volume`, `segs`, `rows` | 머리선과 가르마 |
| `h.bangs()` | `n=7`(5~9), `spread=55`, `tip_el=5`(끝 높이, 0≈눈썹), `length`, `part`, `sweep`, `curl`, `jag`, `seed`, `mat`, `under_hat` | 앞머리: 가르마 쪽 큰 다발 1~2 + 보조 다발 |
| `h.sides()` | `length=0.10`(턱선 아래), `width=0.078`, `az=68`, `n=1`, `curl`, `puff`, `mat`, `left`, `right` | 귀 앞 옆머리. 좌우 따로 가능 |
| `h.back()` | `length=0.08`(목덜미 머리선 아래), `n=9`(홀수), `spread=88`, `mat` | 뒷머리. 길면 흔들림 본 |
| `h.ponytail()` | `height=34, length=0.30, width=0.115, clumps=2, droop, lift=1, curve=1, thick, bones=True, tie` | 굵은 S자, 끝 갈래 + `hair_tail_01/02` |
| `h.twintails()` | `height=30, az=125, length=0.30, width=0.10, lift, curve, thick, bones=True` | `hair_tail_L/R_01/02` |
| `h.braid()` | `side, az=110, el=-25, length=0.30, width=0.04, beads=8, tilt=32, bones=True, tie, tuft` | 땋은 머리 + `hair_braid_L/R_01..03` |
| `h.ahoge()`, `h.bun()` | | 바보털(S자), 경단(매끈한 타원체) |
| `h.shine()` | `el=50, spread=74, n=2, size=1.35` | 정수리 둥근 광택 (아웃라인 없음) |
| `h.strand(pts, width, thick, …)` | 제어점, `taper`, `normal`, `bend`, `w` | 임의 다발 (매끈한 렌즈·초승달 단면) |
| `h.sp(az, el, off)`, `h.path(az, s)` | | 머리 표면 점 / 머리 덩어리 바깥 면 점 |

헬멧이나 모자(`e.helmet`)가 있으면 그 안쪽으로 머리카락을 눌러 넣는다(`squash`). 테두리 아래로는 앞머리와 뒷머리 끝이 보인다.

---

## 10. 옷과 장비

모든 함수는 첫 인자로 머티리얼을 받는다. 치수는 기본 체격 기준 m이며, 내부에서 `e.k`를 곱한다.

| 함수 | 주요 인자 | 메모 |
|---|---|---|
| `e.shirt(m)` | `hem`(z), `off=0.010`, `flare=0.014`, `collar="stand"/"turtle"/None`, `collar_mat`, `placket`, `buttons` | 몸판. 밑단에 두께 테두리(lip). 몸통 맨살을 덮는다 |
| `e.sleeves(m)` | `length=0.97`, `off`, `flare`, `puff`, `cuff=(m, 높이, 두께)` | 양 소매 (arms 그룹) |
| `e.pants(m)` | `waist`, `length=0.92`, `off`, `bag`(통), `blouse`(블라우징), `cuff` | 골반부 + 양 다리. 가림 층으로 저절로 등록 |
| `e.underwear(m)` | `style='briefs'/'shorts'/'bloomers'` 또는 사전, `leg`, `waist`, `off`, `bag`, `gather` | 속옷 층(가림). 아래 '속옷 층' |
| `e.boots(m)` | `top=0.62`(목 높이: 다리 비율), `sole=(m, 두께)`, `cuff`, `laces`, `tab`, `straps`, `toe` | 맨발 대신 |
| `e.gloves(m)` | `cuff`, `cuff_h`, `inflate` | 맨손 대신 (손가락 본 그대로) |
| `e.belt(m)` | `z`, `h`, `th`, `off`, `buckle`, `buckle_size`, `loops` | |
| `e.pouch(m, at)` | `size`, `flap`, `button`, `molle`, `strap`(팔다리 고정끈), `tilt`, `lift` | at = anchor 튜플 |
| `e.ring(m, where, pos)` | `"leg_L"`/`"arm_R"`/`"torso"`, t 또는 z | 감는 띠 (허벅지끈, 완장, 가슴띠) |
| `e.strap(m, path)` | anchor 목록, `width`, `th` | 몸을 따라가는 끈 (멜빵, 슬링) |
| `e.pad(m, at)` | `size`, `strap`, `curve` | 무릎·팔꿈치·어깨 보호대 |
| `e.patch(m, at)` | `shape="rect"/"round"/"diamond"/"chevron"/"bars2"/"bars3"`, `size` | 표식. 기하 도형만 |
| `e.epaulet(m)` | `button`, `width` | 견장 (어깨 고리) |
| `e.helmet(m)` | `off=0.036`, `front/side/back`(테두리 높이), `rim`, `band_mat`, `buckle`, `strap`, `ridge`, `visor`, `vents` | 둥근 헬멧, 바이저 |
| `e.gear(name, at, fn)` | `fn(buf, M, w)` | 임의 장비. 로컬 +Z=위, −Y=바깥 법선 |
| `e.part(name, group, fn)` | `fn(buf)` | 임의 파츠를 Buf로 만들어 등록 |

- 옷이 덮은 구간은 `e.cover["torso"|"arm_L"|…]`에 (시작, 끝)으로 적는다. 맨살은 덮이지 않은 구간만 만든다. 직접 만든 옷도 이 표에 적으면 그 아래 맨살이 생기지 않는다.
- 저수준 도형(직접 장비를 만들 때): `elf.rbox(buf, size, M)`(둥근 상자, 64삼각형), `elf.disc(...)`(단추·렌즈), `elf.band(...)`(링 띠), `elf.loft(buf, stations)`(단면 관), `elf.sweep(...)`, `elf.pouch_geo(...)`, `elf.Buf()`(정점·면·웨이트 버퍼, `.obj(name)`), `elf.Chain`(본 경로 웨이트).

### 속옷 층 (가림) `e.underwear(material, *, style='briefs')`

치마·원피스를 입은 인물도 달리고 높이 찰 때 자락이 흔들린다. 그때 자락 아래가 비어 몸통 안이 보이거나, 구멍이나 빠진 면이 보이면 안 된다. 그래서 치마형 옷 아래에는 늘 단정한 속옷 층을 둔다.

- 피부와 치마 사이의 **불투명한 단색 옷**이다. 엉덩이와 가랑이를 빈틈없이 덮고(아래가 둥글게 닫힌 몸통 관), `shorts`·`bloomers`는 허벅지 윗부분까지 덮는다. 레이스·비침·트임·몸매 강조 같은 장식은 넣지 않는다.
- `pants`와 같은 규칙으로 만든다: 몸통은 `torso_stations` + `_torso_wfn`, 다리는 다리 사슬 웨이트(`Chain.weights`). 그래서 엉덩이·허벅지와 같이 움직인다. 덮은 구간의 맨살은 만들지 않는다(`cover`).
- 모양 표 `elf.UNDERWEAR_STYLES` (다리 길이 비율 `leg`: 0=고관절, 가랑이 ≈ 0.17):

| style | leg | waist (고관절 0 ~ 허리 1) | off (m) | bag (m) | gather (m) | |
|---|---|---|---|---|---|---|
| `briefs` | 0.19 | 0.62 | 0.003 | 0 | 0 | 가랑이 바로 아래까지 |
| `shorts` | 0.30 | 0.80 | 0.004 | 0.003 | 0 | 안전 바지: 허벅지 윗부분까지 |
| `bloomers` | 0.26 | 0.78 | 0.004 | 0.013 | 0.008 | 다리가 둥글게 부풀고 밑단이 모인다 |

- `style`에 사전을 주면 `shorts`를 바탕으로 덮어쓴다. `leg`·`waist`·`off`·`bag`·`gather` 인자로 하나씩 바꿀 수 있다. 인물마다 다른 디자인은 이 표에 새 모양을 더해서 넓힌다(색은 머티리얼).
- 치마 셸 길이에 맞춘다: 밑단(`leg`)은 서 있을 때 치마 밑단보다 위, `off`는 덮는 옷의 안쪽 벽보다 작게(얇은 속 원피스 아래면 0.002).
- 색은 옷에 맞는 단색: 흰 원피스 아래 흰색, 짙은 치마 아래 치마색.

**가림 확인 (`finalize`)**
- 치마형 옷이 있거나(`e.skirt_part(tag)`로 등록. 게임 쪽 자락 도우미가 skirt 셸을 만들 때 부른다) 바지가 없는데, 가림 층이 없으면 `[elf] 경고:`를 찍는다.
- 가림 층: `underwear()`, `pants()`(저절로 등록), 그리고 `e.coverage(tag_or_obj)`로 선언한 옷. **가랑이까지 막힌 바디슈트·레오타드·원피스 수영복은 그 옷 자체가 가림 층**이므로 속옷 층을 겹치지 말고 `e.coverage("leotard")`처럼 선언한다.

예: 허벅지 파우치, 무릎 보호대
```python
e.pouch(web, ("leg_R", 0.30, -75, 0.024 * e.k), size=(0.052, 0.026, 0.062), flap=web_d, button=metal, strap=belt)
e.pad(pad_mat, ("leg_L", 0.53, 0, 0.012 * e.k), size=(0.07, 0.018, 0.07), strap=belt)
```

---

## 11. 예산과 품질

| 모델 | 설정 | 삼각형 |
|---|---|---|
| 기본 몸 (바디슈트, 맨손·맨발, 단발 + 광택) | 기본 | 약 16k (머리카락 셸 3.8k + 속층 0.7k) |
| 전투복 일체 + 헬멧 | `segs=0.85, hand_q=0.8`, `cap(segs=20, rows=5)` | 약 18k |
| 긴 머리 / 단발 / 포니테일 / 트윈테일 | 기본 | 15~17k (머리 3.4~4.9k + 0.7k) |
| 여럿 등장하는 단역 (헬멧·모자) | `segs=0.7, hand_q=0.6`, `cap(segs=18, rows=4)` | 약 15k |
| 1인칭 팔 (소매 + 장갑) | `hand_q=1.2`, `only=("arms",)` | 약 4.3k |

- 비싼 순서: 머리카락(셸 3~5k, `Elf(segs)`·`cap(segs, rows)`로 조절) > 헬멧 > 몸판 > 얼굴(약 1k) > 장화·장갑 > 파우치(약 130). `[elf]` 보고를 보고 줄인다.

---

## 12. 새 인물 만드는 법

1. `Elf()` 체격(키, 머리, 어깨)과 `face()`(눈색, 눈썹)로 얼굴 인상을 먼저 정한다. `--focus <이름>_face`로 확인한다.
2. 머리카락으로 실루엣을 잡는다.
3. 옷을 입히고 3차 디테일(버클, 덮개, 끈, 패치)을 한 겹 더한다.
4. `[elf]` 삼각형 보고로 예산을 맞춘다.
5. 시트 4방향, 얼굴 클로즈업, `--mode single`을 찍어 직접 보고 고친다.

---

## 13. 알려진 한계

- 옷 셸은 몸 단면을 부풀린 관이라 치마·망토·코트 자락 같은 '몸에서 떨어지는 천'은 키트에 없다. 게임 쪽 도우미(행·열 격자 셸, 허벅지 섞기 웨이트)로 만든다.
- 위장 무늬 같은 텍스처는 지원하지 않는다(정점색 병합 방식). 색 블록 몇 개는 `e.patch`로 낼 수 있다.
- 1인칭에서 서 있을 때 다리는 몸통에 가려 보이지 않는다(7장).
- 머리카락: 다발이 서로 교차하는 복잡한 묶음 머리(반묶음, 땋아 올린 머리)는 `strand()`/`braid()`를 직접 조합해야 한다. 아주 짧은 쇼트컷은 `back(length=-0.05)`처럼 음수 길이로 근사한다.
