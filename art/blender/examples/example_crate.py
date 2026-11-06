"""파이프라인 예제: 나무 상자 + 본에 붙은 뚜껑 + 언릿 램프 + 소켓.

npm run model -- art/blender/examples/example_crate.py
npm run shot -- examples/example_crate.glb
"""
import os
import sys

sys.path.insert(0, os.path.join(os.environ["PROJECT_ROOT"], "art", "blender", "lib"))
import cb  # noqa: E402

cb.reset()

wood = cb.mat("crate_wood", "#b07a4a")
metal = cb.mat("metal_dark", "#3a3d42", roughness=0.4, metallic=0.6)
label = cb.mat("label_cream", "#f2e6c8")
lamp = cb.mat("lamp", "#ffffff", emission="#ffb0c8", unlit=True)

body = cb.box("crate_body", size=(0.46, 0.26, 0.20), loc=(0, 0, 0.10), bevel=0.012, material=wood)
cb.box("crate_band_L", size=(0.03, 0.27, 0.205), loc=(0.15, 0, 0.10), bevel=0.004, material=metal)
cb.box("crate_band_R", size=(0.03, 0.27, 0.205), loc=(-0.15, 0, 0.10), bevel=0.004, material=metal)
cb.box("crate_label", size=(0.18, 0.002, 0.05), loc=(0, -0.131, 0.11), material=label)
cb.cylinder("crate_handle", radius=0.008, depth=0.12, loc=(0, 0, 0.215), rot=(0, 90, 0), material=metal)
cb.sphere("crate_lamp", radius=0.012, loc=(0.2, -0.12, 0.17), material=lamp)

# 뚜껑을 본에 붙여서 애니메이션 가능한 계층 확인
arm = cb.armature("crate_rig", [
    ("root", (0, 0, 0), (0, 0, 0.1), None),
    ("lid", (0, 0.13, 0.2), (0, 0.13, 0.3), "root"),
])
lid = cb.box("crate_lid", size=(0.47, 0.27, 0.03), loc=(0, 0, 0.215), bevel=0.01, material=wood)
cb.parent_to_bone(lid, arm, "lid")

cb.empty("socket_carry", loc=(0, 0, 0.23))

cb.export("examples/example_crate.glb", props={"outline": 0.004})
