"""Blender 공용 라이브러리 (cb): 헤드리스 모델 스크립트 → glb.

모델 스크립트에서:
    import os, sys
    sys.path.insert(0, os.path.join(os.environ["PROJECT_ROOT"], "art", "blender", "lib"))
    import cb
    cb.reset()
    ... 모델링 ...
    cb.export("props/crate.glb", props={"outline": 0.003})

좌표 규칙 (docs/ASSETS.md):
  - 1 BU = 1 m, Z-up. glTF로 내보내면 Y-up으로 바뀐다.
  - 캐릭터: 발바닥 z=0, 원점 중심, **-Y를 바라봄** (Blender 정면 뷰에서 얼굴이 보임). 캐릭터의 왼쪽 = +X.
    → three.js에서 +Z를 바라봄.
  - 손에 드는 소품: 앞쪽이 **+Y** 방향, 원점 = 오른손 파지점. → three.js에서 앞쪽이 -Z.
  - 이름에 점(.) 금지 (three.js가 지움). 좌우는 _L / _R.

알려진 함정:
  - Blender 5에서 새로 만든 셰이프 키는 value(가중치)가 1인 채로 glTF에 내보내진다.
    표정 키를 만든 뒤 `key_block.value = 0.0`으로 되돌려야 기본 표정이 중립으로 나온다 .
  - bmesh create_cone(cylinder)의 첫 꼭짓점은 +90°에 있다 (cylinder 주석 참고).
"""
from __future__ import annotations

import math
import os

import bmesh
import bpy
from mathutils import Matrix, Vector

# PROJECT_ROOT: 프로젝트 루트 (npm run model이 넣는다). COMBATIUM_ROOT는 예전 이름이라 대신 받아 준다
ROOT = os.environ.get("PROJECT_ROOT") or os.environ.get("COMBATIUM_ROOT") or os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..")
)
MODELS_DIR = os.path.join(ROOT, "public", "models")


# ------------------------------------------------------------------ scene

def reset():
    """빈 씬으로 시작. 미터 단위."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    s = bpy.context.scene
    s.unit_settings.system = "METRIC"
    s.unit_settings.scale_length = 1.0
    _mat_cache.clear()


def collection() -> bpy.types.Collection:
    return bpy.context.scene.collection


def link(obj: bpy.types.Object, parent: bpy.types.Object | None = None) -> bpy.types.Object:
    if obj.name not in collection().objects:
        collection().objects.link(obj)
    if parent is not None:
        obj.parent = parent
    return obj


def empty(name: str, loc=(0, 0, 0), parent=None, size=0.05) -> bpy.types.Object:
    """앵커/소켓용 빈 오브젝트 (glTF 노드로 내보내짐)."""
    e = bpy.data.objects.new(name, None)
    e.empty_display_type = "PLAIN_AXES"
    e.empty_display_size = size
    e.location = loc
    return link(e, parent)


# ------------------------------------------------------------------ color / materials

def srgb_to_linear(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_lin(h: str) -> tuple[float, float, float]:
    h = h.lstrip("#")
    r, g, b = (int(h[i : i + 2], 16) / 255 for i in (0, 2, 4))
    return srgb_to_linear(r), srgb_to_linear(g), srgb_to_linear(b)


_mat_cache: dict[str, bpy.types.Material] = {}


def mat(
    name: str,
    color: str,
    *,
    emission: str | None = None,
    emission_strength: float = 1.0,
    unlit: bool = False,
    alpha: float | None = None,
    line: str | None = None,
    roughness: float = 0.6,
    metallic: float = 0.0,
    double_sided: bool = True,
) -> bpy.types.Material:
    """툰 파이프라인용 머티리얼.

    color: 'sRGB #rrggbb' (내부에서 선형으로 변환)
    unlit: True면 이름이 UNLIT_로 시작 → three.js에서 조명 없는 단색 (눈 하이라이트, 화면, 램프)
    emission: 발광색. unlit이면 이 색이 그대로 보인다.
    line: 아웃라인 색. 없으면 바탕색을 어둡게 한 색이 자동으로 쓰인다.
    double_sided: False면 뒷면 컬링(glTF doubleSided=false). 닫힌 메시에는 False가 싸고 깔끔하다.
    """
    full = f"UNLIT_{name}" if unlit and not name.startswith("UNLIT_") else name
    if full in _mat_cache:
        return _mat_cache[full]
    m = bpy.data.materials.new(full)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*hex_lin(color), 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    if emission:
        bsdf.inputs["Emission Color"].default_value = (*hex_lin(emission), 1.0)
        bsdf.inputs["Emission Strength"].default_value = emission_strength
    if alpha is not None:
        bsdf.inputs["Alpha"].default_value = alpha
        try:
            m.surface_render_method = "BLENDED"
        except AttributeError:
            pass
    if line:
        m["lineColor"] = line
    m.use_backface_culling = not double_sided
    m.diffuse_color = (*hex_lin(color), 1.0)  # 뷰포트 표시용
    _mat_cache[full] = m
    return m


def assign(obj: bpy.types.Object, *materials: bpy.types.Material) -> bpy.types.Object:
    obj.data.materials.clear()
    for m in materials:
        obj.data.materials.append(m)
    return obj


# ------------------------------------------------------------------ primitives

def _new_mesh_obj(name: str, bm: bmesh.types.BMesh, parent=None) -> bpy.types.Object:
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    return link(obj, parent)


def _place(obj, loc, rot, scale):
    obj.location = loc
    obj.rotation_euler = [math.radians(a) for a in rot]
    obj.scale = scale
    return obj


def box(name, size=(1, 1, 1), loc=(0, 0, 0), rot=(0, 0, 0), *, bevel=0.0, bevel_segments=2,
        material=None, parent=None) -> bpy.types.Object:
    """size는 전체 크기(m). bevel>0이면 베벨 모디파이어."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector(size), verts=bm.verts)
    obj = _new_mesh_obj(name, bm, parent)
    _place(obj, loc, rot, (1, 1, 1))
    if bevel > 0:
        add_bevel(obj, bevel, bevel_segments)
    if material:
        assign(obj, material)
    return obj


def cylinder(name, radius=0.05, depth=0.1, loc=(0, 0, 0), rot=(0, 0, 0), *, verts=24, radius2=None,
             bevel=0.0, bevel_segments=2, material=None, parent=None, cap=True) -> bpy.types.Object:
    """Z축 방향 원기둥(중심 기준). radius2를 주면 원뿔대.

    주의: bmesh create_cone은 첫 꼭짓점을 +90°(+Y 쪽)에 둔다. verts=6/5로 육각·오각 기둥을 만들면
    면·꼭짓점 방향이 예상과 30~90° 어긋나므로 rot의 Z 회전으로 보정한다.
    """
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=cap, cap_tris=False, segments=verts,
                          radius1=radius, radius2=radius if radius2 is None else radius2, depth=depth)
    obj = _new_mesh_obj(name, bm, parent)
    _place(obj, loc, rot, (1, 1, 1))
    if bevel > 0:
        add_bevel(obj, bevel, bevel_segments)
    if material:
        assign(obj, material)
    smooth(obj)
    return obj


def sphere(name, radius=0.1, loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1), *, segments=32, rings=16,
           material=None, parent=None) -> bpy.types.Object:
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segments, v_segments=rings, radius=radius)
    obj = _new_mesh_obj(name, bm, parent)
    _place(obj, loc, rot, scale)
    if material:
        assign(obj, material)
    smooth(obj, angle=180)
    return obj


def from_pydata(name, verts, faces, *, material=None, parent=None, loc=(0, 0, 0)) -> bpy.types.Object:
    me = bpy.data.meshes.new(name)
    me.from_pydata([Vector(v) for v in verts], [], faces)
    me.update()
    obj = bpy.data.objects.new(name, me)
    obj.location = loc
    link(obj, parent)
    if material:
        assign(obj, material)
    return obj


def profile_extrude(name, points_2d, depth, *, axis="X", loc=(0, 0, 0), bevel=0.0, bevel_segments=2,
                    material=None, parent=None) -> bpy.types.Object:
    """2D 외곽선(반시계, (u,v) 리스트)을 두께 depth로 돌출. 옆모습 실루엣으로 만드는 소품에 유용.

    axis='X'면 외곽선이 YZ 평면(u=Y, v=Z)에 놓이고 X로 두께가 생긴다 (앞쪽 +Y 규칙과 맞음).
    """
    bm = bmesh.new()
    half = depth / 2
    if axis == "X":
        front = [bm.verts.new((-half, u, v)) for u, v in points_2d]
        back = [bm.verts.new((half, u, v)) for u, v in points_2d]
    elif axis == "Y":
        front = [bm.verts.new((u, -half, v)) for u, v in points_2d]
        back = [bm.verts.new((u, half, v)) for u, v in points_2d]
    else:
        front = [bm.verts.new((u, v, -half)) for u, v in points_2d]
        back = [bm.verts.new((u, v, half)) for u, v in points_2d]
    bm.faces.new(list(reversed(front)))
    bm.faces.new(back)
    n = len(points_2d)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((front[i], front[j], back[j], back[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    obj = _new_mesh_obj(name, bm, parent)
    obj.location = loc
    if bevel > 0:
        add_bevel(obj, bevel, bevel_segments)
    if material:
        assign(obj, material)
    return obj


# ------------------------------------------------------------------ modifiers / shading

def add_bevel(obj, width=0.005, segments=2, angle=40.0):
    mod = obj.modifiers.new("Bevel", "BEVEL")
    mod.width = width
    mod.segments = segments
    mod.limit_method = "ANGLE"
    mod.angle_limit = math.radians(angle)
    mod.harden_normals = False
    smooth(obj, angle=angle + 5)
    return mod


def subsurf(obj, levels=2):
    mod = obj.modifiers.new("Subsurf", "SUBSURF")
    mod.levels = levels
    mod.render_levels = levels
    smooth(obj, angle=180)
    return mod


def mirror_x(obj, merge=True):
    mod = obj.modifiers.new("Mirror", "MIRROR")
    mod.use_axis[0] = True
    mod.use_clip = merge
    mod.use_mirror_merge = merge
    return mod


def solidify(obj, thickness=0.01, offset=-1.0):
    mod = obj.modifiers.new("Solidify", "SOLIDIFY")
    mod.thickness = thickness
    mod.offset = offset
    return mod


def smooth(obj, angle: float = 35.0):
    """각도 기준 스무스 셰이딩. angle>=180이면 전부 스무스."""
    me = obj.data
    if not hasattr(me, "polygons"):
        return
    for p in me.polygons:
        p.use_smooth = True
    if angle < 180:
        bm = bmesh.new()
        bm.from_mesh(me)
        lim = math.radians(angle)
        for e in bm.edges:
            if e.is_manifold and len(e.link_faces) == 2:
                e.smooth = e.calc_face_angle(0.0) < lim
            else:
                e.smooth = True
        bm.to_mesh(me)
        bm.free()
    me.update()


def apply_transform(obj, location=False, rotation=True, scale=True):
    """오브젝트 변환을 메시에 굽는다 (선택 상태를 건드림)."""
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.transform_apply(location=location, rotation=rotation, scale=scale)
    obj.select_set(False)


def join(objs: list[bpy.types.Object], name: str | None = None) -> bpy.types.Object:
    """여러 메시를 하나로 합친다 (드로우콜 절약). 모디파이어는 먼저 적용된다."""
    for o in objs:
        apply_modifiers(o)
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    out = bpy.context.view_layer.objects.active
    if name:
        out.name = name
        out.data.name = name
    out.select_set(False)
    return out


def apply_modifiers(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    for m in list(obj.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)
    obj.select_set(False)


# ------------------------------------------------------------------ rigging

def armature(name: str, bones: list[tuple], *, loc=(0, 0, 0)) -> bpy.types.Object:
    """bones: [(이름, head(x,y,z), tail(x,y,z), 부모이름 또는 None), ...] 순서대로 생성."""
    arm_data = bpy.data.armatures.new(name)
    arm = bpy.data.objects.new(name, arm_data)
    arm.location = loc
    link(arm)
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = arm
    arm.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    eb = arm_data.edit_bones
    for bname, head, tail, parent in bones:
        b = eb.new(bname)
        b.head = head
        b.tail = tail
        if parent:
            b.parent = eb[parent]
            b.use_connect = False
    bpy.ops.object.mode_set(mode="OBJECT")
    arm.select_set(False)
    return arm


def parent_to_bone(obj: bpy.types.Object, arm: bpy.types.Object, bone: str):
    """강체 파츠를 본에 붙인다 (월드 위치 유지). 스키닝 없이 본 애니메이션을 따라감."""
    bpy.context.view_layer.update()
    mw = obj.matrix_world.copy()
    obj.parent = arm
    obj.parent_type = "BONE"
    obj.parent_bone = bone
    bpy.context.view_layer.update()
    obj.matrix_world = mw


def skin_to(obj: bpy.types.Object, arm: bpy.types.Object, *, auto=True):
    """연속 메시를 아마추어에 스키닝 (자동 웨이트). 실패하면 예외."""
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.parent_set(type="ARMATURE_AUTO" if auto else "ARMATURE_NAME")
    bpy.ops.object.select_all(action="DESELECT")


# ------------------------------------------------------------------ export / report

def tri_count() -> int:
    deps = bpy.context.evaluated_depsgraph_get()
    total = 0
    for o in bpy.context.scene.objects:
        if o.type != "MESH" or not o.visible_get():
            continue
        ev = o.evaluated_get(deps)
        me = ev.to_mesh()
        me.calc_loop_triangles()
        total += len(me.loop_triangles)
        ev.to_mesh_clear()
    return total


def bounds() -> tuple[Vector, Vector]:
    deps = bpy.context.evaluated_depsgraph_get()
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for o in bpy.context.scene.objects:
        if o.type != "MESH" or not o.visible_get():
            continue
        ev = o.evaluated_get(deps)
        me = ev.to_mesh()
        mw = ev.matrix_world
        for v in me.vertices:
            p = mw @ v.co
            lo = Vector(map(min, lo, p))
            hi = Vector(map(max, hi, p))
        ev.to_mesh_clear()
    return lo, hi


def export(rel_path: str, *, props: dict | None = None, root: bpy.types.Object | None = None) -> str:
    """public/models/<rel_path> 로 .glb 내보내기.

    props: 루트 오브젝트 커스텀 속성 (예: {"outline": 0.004}). root가 없으면 최상위 오브젝트 전부에 적용.
    """
    path = os.path.join(MODELS_DIR, rel_path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if props:
        targets = [root] if root else [o for o in bpy.context.scene.objects if o.parent is None]
        for t in targets:
            for k, v in props.items():
                t[k] = v
    bpy.context.view_layer.update()
    tris = tri_count()
    lo, hi = bounds()
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=False,
        use_visible=True,
        export_apply=True,
        export_yup=True,
        export_extras=True,
        export_cameras=False,
        export_lights=False,
        export_animations=True,
        export_skins=True,
        export_materials="EXPORT",
        export_image_format="AUTO",
    )
    size = hi - lo
    print(f"[cb] exported {rel_path}")
    print(f"[cb] tris={tris} objects={len(bpy.context.scene.objects)} materials={len(bpy.data.materials)}")
    print(f"[cb] blender bounds min=({lo.x:.3f},{lo.y:.3f},{lo.z:.3f}) max=({hi.x:.3f},{hi.y:.3f},{hi.z:.3f}) "
          f"size=({size.x:.3f},{size.y:.3f},{size.z:.3f})")
    return path
