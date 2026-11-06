# 에셋 파이프라인

Blender 헤드리스 스크립트(`art/blender/**.py`) → `public/models/**.glb` → three.js 툰 셰이딩.

```bash
npm run model -- art/blender/examples/example_crate.py   # Blender로 glb 만들기 (BLENDER 환경 변수로 실행 파일 지정)
npm run shot -- examples/example_crate.glb               # 헤드리스 Chrome으로 모델 뷰어를 찍는다 (shots/*.png)
npm run dev                                              # /viewer.html 모델 뷰어
```

## 공용 라이브러리 (`art/blender/lib/cb.py`)

`cb.reset()`, `cb.mat(name, '#rrggbb', unlit=…, emission=…)`, `cb.box/cylinder/sphere/profile_extrude/from_pydata`, `cb.armature`, `cb.parent_to_bone`, `cb.skin_to`, `cb.empty('socket_…')`, `cb.export('<public/models 기준 경로>', props={...})`.
스크립트는 환경 변수 `PROJECT_ROOT`(npm run model이 넣는다)로 라이브러리를 찾는다.
예전 이름 `COMBATIUM_ROOT`도 대신 받는다.

## SD 캐릭터 키트 (`art/blender/lib/elf.py`)

몸·A 포즈 리그·머리·얼굴 데칼과 표정 모프·머리카락·옷을 같은 규칙으로 만드는 캐릭터 키트. 사용법과 설계 규칙은 [CHARACTER_KIT.md](CHARACTER_KIT.md).

## 규칙

- 1 BU = 1 m, Z-up. glTF로 내보내면 Y-up.
- 캐릭터: 발바닥 z=0, 원점 중심, −Y를 바라봄 (three.js에서 +Z). 캐릭터의 왼쪽 = +X.
- 손에 드는 소품: 앞쪽이 +Y, 원점 = 오른손 파지점.
- 이름에 점(.) 금지 (three.js가 지운다). 좌우는 `_L` / `_R`.
- 머티리얼 이름이 `UNLIT_`로 시작하면 조명 없는 머티리얼 (발광부, 화면).
- 커스텀 속성 `outline=<m>`은 외곽선 두께, `noOutline=1`은 외곽선 없음 (자식에게 상속). 머티리얼 속성 `lineColor="#rrggbb"`는 외곽선 색.
- 캐릭터 리그 루트 속성 `charHeight`, `charRadius`(m)는 런타임 캐릭터 충돌 캡슐 크기다 (`Character`).
- Blender 5에서 새로 만든 셰이프 키는 가중치 1로 내보내진다: 표정 키를 만든 뒤 `key_block.value = 0.0`으로 되돌린다.
