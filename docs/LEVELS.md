# 레벨 규칙

레벨은 glb 하나(또는 코드로 만든 `THREE.Group`)를 노드 이름 규칙으로 읽는다: `loadLevel(ctx, { id, path })`, `buildLevel(ctx, root, { id, path })`.
좌표는 Blender Z-up, 1 BU = 1 m. glTF로 내보내면 Y-up이 된다. 빈 오브젝트의 정면은 Blender −Y(three.js 로컬 +Z)다.

## 노드

| 이름 | 뜻 |
|---|---|
| (일반 메시) | 보이는 메시. 정적 트라이메시 충돌체가 된다. 커스텀 속성 `collider=0`이면 장식(충돌 없음), `collider="box"`면 경계 상자 충돌체 |
| `COL_*` | 렌더하지 않고 충돌체만. 덩어리마다 상자 → 회전 상자, 볼록 → 볼록 껍질, 아니면 트라이메시 |
| `SPAWN_<id>` | 시작 자리 (`level.spawn(id)`). 내비 굽기의 씨앗 |
| `NPC_<id>` | 캐릭터 마커 (`CharacterSet`이 세운다. 속성 `model`, `pose`, `look` …) |
| `WP_<path>_<nn>` | 경로점 (`level.path('<path>')`가 이름순으로 준다) |
| `MARK_<id>` | 이름 붙은 자리 |
| `PROP_<id>` | 소품 자리. 속성 `model`(public/models 기준 경로)이면 그 모델을 붙인다. `collider=0`이면 충돌 없음 |
| `TRIG_<id>` | 트리거 부피 (메시 경계 상자, 회전·축척 반영). 렌더하지 않는다. `level.triggers.get(id).contains(p)` |
| `DOOR_<id>` | 키네마틱 문. 속성 `move="x,y,z"`(three.js 기준)만큼 열린다. `level.doors.get(id).setTarget(1)` |
| `CAM_<shot>_<nn>`, `LOOK_<shot>_<nn>` | 카메라 레일 키와 시선 점 (속성 `t` 초, `fov`). `CameraRail.from(level.rails.get(shot))` |
| `LIGHT_<id>` | 켜고 끄는 등 (조명 또는 발광 메시). `LightGroups`가 묶음(`group`)으로 켜고 끈다. 속성 `on`, `blink`, `color`, `emissiveToggle` |
| `FX_<id>` | 연출 지점 마커 |

## 노드 속성

| 속성 | 뜻 |
|---|---|
| `hidden=1`, `on=0` | 처음에 숨긴다 (연출이 켠다) |
| `state="<이름>"` | `level.setState(name)`이면 그 이름인 노드만 보인다 |
| `drift="x,y,z"` | m/s로 천천히 움직인다 |
| `spin="x,y,z"` | 도/s로 돈다 |
| `dynamic=1` 또는 `MOVING_PROPS`의 속성 | 코드가 움직이는 노드: 행렬을 얼리지 않는다 |
| `bake=1` | 그 묶음의 정적 메시를 정점 색 메시 하나 + 외곽선 하나로 합친다 |
| `ray=0｜pass｜1` | 보이는 형상 레이 분류 (무시·지나감·막음). 자식에게 상속 |
| `surface="<종류>"` | 맞은 자리 표면 태그 (concrete·metal·wood·dirt·glass·water·cloth). 발소리도 쓴다 |
| `step="<표면>"` | 발소리 표면만 따로 |
| `climb=0` | 넘기·오르기 링크를 만들지 않는다 |
| `outline=<m>`, `noOutline=1` | 외곽선 두께, 외곽선 없음 (자식에게 상속) |

## 루트 속성 (환경)

`sky`, `fog="near,far"`, `sun="x,y,z"`(빛이 오는 방향), `ambient`, `sunColor`, `sunIntensity`, `hemiSky`, `hemiGround`, `near`/`far`(카메라 평면), `skyNode`(카메라를 따라 옮길 원경 노드), `music`, `timeOfDay`, `navBounds="x0,z0,x1,z1"`.
씬 extras → 루트 → 최상위 자식 순으로 찾는다.

## 계단

캐릭터 컨트롤러가 계단을 오르게 하려면 충돌체를 단 코를 잇는 경사판 하나로 둔다 (`COL_`). 보이는 디딤판은 따로 두면 `RapierGround`가 캐릭터 발을 디딤판 높이에 맞춘다.
