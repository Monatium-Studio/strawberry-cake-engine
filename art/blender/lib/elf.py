"""SD 캐릭터 베이스 키트 (elf).

머리가 큰 SD 툰 화풍(약 2.5등신)의 엘프형 캐릭터를 Blender 헤드리스 스크립트로 빠르게 만드는 도구.
몸·리그(A 포즈)·머리·얼굴(표정 모프)·머리카락·옷과 장비·볼 리그·속옷 층을 같은 규칙으로 만든다.
사용법과 설계 규칙은 docs/CHARACTER_KIT.md.

    import os, sys
    sys.path.insert(0, os.path.join(os.environ["PROJECT_ROOT"], "art", "blender", "lib"))
    import cb, elf
    cb.reset()
    e = elf.Elf("hero", skin="#fff0e9")
    e.face(eye_color="#5b7fb8")
    h = e.hair("#7a5140"); h.cap(); h.bangs(); h.back(length=0.30)
    e.shirt(cb.mat("jacket", "#9aa58f")); e.pants(cb.mat("pants", "#8d927f")); e.boots(cb.mat("boots", "#3d3a38"))
    e.finalize()
    e.export("characters/hero.glb")

핵심 결정 (근거는 CHARACTER_KIT.md):
  - 스키닝은 자동 웨이트(bone heat)를 쓰지 않는다. 모든 파츠가 만들어질 때 웨이트를 직접 계산해 정점 그룹에 넣는다.
    → 헤드리스에서 항상 같은 결과, 실패 없음.
  - 단단한 장비도 '본 하나에 100%'로 스키닝해서 같은 메시에 합친다. 최종 메시는 fpHide 그룹별로 셋
    (body / arms / head) + 표정 셰이프 키가 있는 face(머리 본에 강체 부착).
  - merge=True(기본)면 불투명 툰 머티리얼을 정점색으로 구워 머티리얼 하나(toon_vc)로 합친다 → 드로우콜 최소.
    라인색은 전부 같은 붉은 갈색(Elf.line).
"""
from __future__ import annotations

import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cb  # noqa: E402

V = Vector
LINE = "#4a2229"          # 붉은 갈색 라인 (모든 툰 머티리얼 공통)
SKIN = "#fff0ea"
SKIN_SHADE = "#f6d3cc"
BUST_DEPTH = 0.052        # bust=1일 때 가슴 앞 꼭짓점이 더 나오는 두께(m, e.k 곱함). CHARACTER_KIT.md 2장

ARM_BONES_PREFIX = ("upperarm", "forearm", "hand", "thumb", "f1_", "f2_", "f3_")
HEAD_BONES_PREFIX = ("neck", "head", "ear", "hair", "cheek")


# =========================================================================== math helpers

def clamp(x, a=0.0, b=1.0):
    return a if x < a else b if x > b else x


def lerp(a, b, t):
    return a + (b - a) * t


def smooth01(x):
    x = clamp(x)
    return x * x * (3 - 2 * x)


def smoothstep(a, b, x):
    if a == b:
        return 1.0 if x >= b else 0.0
    return smooth01((x - a) / (b - a))


def keys(table, t):
    """[(t, v), ...] 표를 t에서 부드럽게 보간 (v는 수 또는 튜플)."""
    if t <= table[0][0]:
        return table[0][1]
    if t >= table[-1][0]:
        return table[-1][1]
    for (t0, v0), (t1, v1) in zip(table, table[1:]):
        if t0 <= t <= t1:
            a = smooth01((t - t0) / (t1 - t0)) * 0.5 + (t - t0) / (t1 - t0) * 0.5
            if isinstance(v0, (tuple, list)):
                return tuple(lerp(x0, x1, a) for x0, x1 in zip(v0, v1))
            return lerp(v0, v1, a)
    return table[-1][1]


def mixw(w1: dict, w2: dict, a: float) -> dict:
    """웨이트 사전 두 개를 섞는다 (a=0 → w1, a=1 → w2)."""
    out = {}
    for k, v in w1.items():
        out[k] = out.get(k, 0.0) + v * (1 - a)
    for k, v in w2.items():
        out[k] = out.get(k, 0.0) + v * a
    return {k: v for k, v in out.items() if v > 1e-4}


def hex_srgb(h: str):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))


def srgb_hex(c) -> str:
    return "#" + "".join(f"{int(round(clamp(x) * 255)):02x}" for x in c[:3])


def shade(h: str, k: float) -> str:
    """색을 밝게(k>0) 또는 어둡게(k<0)."""
    r, g, b = hex_srgb(h)
    if k >= 0:
        return srgb_hex((lerp(r, 1, k), lerp(g, 1, k), lerp(b, 1, k)))
    return srgb_hex((r * (1 + k), g * (1 + k), b * (1 + k)))


def mix_hex(a: str, b: str, t: float) -> str:
    ca, cbb = hex_srgb(a), hex_srgb(b)
    return srgb_hex(tuple(lerp(x, y, t) for x, y in zip(ca, cbb)))


def _lin_to_srgb(c):
    return 12.92 * c if c <= 0.0031308 else 1.055 * (c ** (1 / 2.4)) - 0.055


def mat_srgb(m: bpy.types.Material):
    """머티리얼 바탕색(sRGB 0~1)."""
    try:
        bsdf = m.node_tree.nodes.get("Principled BSDF")
        c = bsdf.inputs["Base Color"].default_value
        return tuple(_lin_to_srgb(x) for x in c[:3])
    except Exception:  # noqa: BLE001
        return tuple(_lin_to_srgb(x) for x in m.diffuse_color[:3])


def frame(normal, up=(0, 0, 1)) -> Matrix:
    """바깥 법선과 위 방향으로 회전 행렬. 로컬 -Y = 법선(바깥), +Z = 위, +X = 옆."""
    n = V(normal).normalized()
    u = V(up)
    u = (u - n * u.dot(n))
    if u.length < 1e-6:
        u = V((0, 0, 1)) if abs(n.z) < 0.9 else V((0, 1, 0))
        u = (u - n * u.dot(n))
    u.normalize()
    y = -n
    x = y.cross(u).normalized()
    return Matrix((x, y, u)).transposed().to_4x4()


# =========================================================================== mesh buffer

class Buf:
    """정점/면/머티리얼/웨이트를 모았다가 오브젝트 하나로 만든다."""

    def __init__(self):
        self.v: list[Vector] = []
        self.w: list[dict] = []
        self.f: list[tuple] = []
        self.fm: list[int] = []
        self.mats: list = []
        self.sharp: set = set()

    def mi(self, m) -> int:
        if m is None:
            m = _default_mat()
        if m not in self.mats:
            self.mats.append(m)
        return self.mats.index(m)

    def vert(self, co, w=None) -> int:
        self.v.append(V(co))
        self.w.append(dict(w or {}))
        return len(self.v) - 1

    def face(self, idx, m=None):
        self.f.append(tuple(idx))
        self.fm.append(self.mi(m))

    def obj(self, name, *, smooth=True, angle=180.0, parent=None) -> bpy.types.Object:
        me = bpy.data.meshes.new(name)
        me.from_pydata([tuple(p) for p in self.v], [], self.f)
        me.update()
        ob = bpy.data.objects.new(name, me)
        cb.link(ob, parent)
        for m in self.mats:
            me.materials.append(m)
        for p, mi in zip(me.polygons, self.fm):
            p.material_index = mi
        groups = {}
        for i, w in enumerate(self.w):
            for b, x in w.items():
                if x <= 1e-4:
                    continue
                if b not in groups:
                    groups[b] = ob.vertex_groups.new(name=b)
                groups[b].add([i], x, "REPLACE")
        if smooth:
            cb.smooth(ob, angle=angle)
        return ob


_DEFAULT = None


def _default_mat():
    global _DEFAULT
    if _DEFAULT is None or _DEFAULT.name not in bpy.data.materials:
        _DEFAULT = cb.mat("elf_default", "#cccccc")
    return _DEFAULT


def ring_pts(c, A, B, rx, ry, segs, *, p=2.0, rxn=None, ryn=None, ox=0.0, oy=0.0, rot=0.0):
    """단면 링. A=로컬 x축(rx), B=로컬 y축(ry). p>2면 각진 초타원, p<2면 마름모."""
    out = []
    e = 2.0 / p
    for k in range(segs):
        th = rot + 2 * math.pi * k / segs
        ca, sa = math.cos(th), math.sin(th)
        x = math.copysign(abs(ca) ** e, ca)
        y = math.copysign(abs(sa) ** e, sa)
        x *= rx if x >= 0 else (rx if rxn is None else rxn)
        y *= ry if y >= 0 else (ry if ryn is None else ryn)
        out.append(V(c) + A * (x + ox) + B * (y + oy))
    return out


def loft(buf: Buf, stations: list[dict], *, segs=16, cap0="round", cap1="round", ref=(1, 0, 0),
         p=2.0, mat=None, cap_len0=None, cap_len1=None, wfn=None, cap_rings=3) -> list[list[int]]:
    """단면을 이어 붙인 관(tube).

    station: {"c": 중심, "rx", "ry", 선택: "w"(웨이트 사전), "ref"(단면 x축 기준 벡터), "p", "rxn", "ryn",
              "ox", "oy", "rot", "disp"(disp(점, station) → 더할 벡터 또는 None. 몸통 가슴 볼륨 등)}
    cap: "round"(반구) | "flat" | "lip"(옷단 두께 테두리, station "lip"=두께) | None(열림)
    wfn(pos, station_index) → 웨이트 사전을 주면 정점별로 계산 (몸통의 어깨 웨이트 등)
    반환: 링별 정점 인덱스 목록
    """
    n = len(stations)
    cs = [V(s["c"]) for s in stations]
    rings = []
    frames = []
    prevA = None
    for i, s in enumerate(stations):
        a = cs[max(i - 1, 0)]
        b = cs[min(i + 1, n - 1)]
        t = (b - a)
        t = t.normalized() if t.length > 1e-9 else V((0, 0, 1))
        r = V(s.get("ref", ref))
        A = r - t * r.dot(t)
        if A.length < 1e-6:
            A = prevA if prevA is not None else V((1, 0, 0))
        A.normalize()
        B = t.cross(A).normalized()
        prevA = A
        frames.append((t, A, B))
        pts = ring_pts(cs[i], A, B, s["rx"], s["ry"], segs, p=s.get("p", p), rxn=s.get("rxn"),
                       ryn=s.get("ryn"), ox=s.get("ox", 0.0), oy=s.get("oy", 0.0), rot=s.get("rot", 0.0))
        dsp = s.get("disp")
        if dsp is not None:
            pts = [q + d if d is not None else q for q, d in ((q, dsp(q, s)) for q in pts)]
        ring = []
        for q in pts:
            w = wfn(q, i) if wfn else s.get("w", {})
            ring.append(buf.vert(q, w))
        rings.append(ring)
    for i in range(n - 1):
        r0, r1 = rings[i], rings[i + 1]
        for k in range(segs):
            k2 = (k + 1) % segs
            buf.face((r0[k], r0[k2], r1[k2], r1[k]), mat)

    def cap(end):
        i = 0 if end == 0 else n - 1
        kind = cap0 if end == 0 else cap1
        if not kind:
            return
        s = stations[i]
        t, A, B = frames[i]
        sign = -1 if end == 0 else 1
        base = rings[i]
        w = wfn(cs[i], i) if wfn else s.get("w", {})
        if kind == "lip":
            # 열린 끝에 두께 테두리 (옷단): 안쪽으로 접힌 링
            th = s.get("lip", min(s["rx"], s["ry"]) * 0.12)
            ctr = cs[i] + A * s.get("ox", 0) + B * s.get("oy", 0)
            prev = base
            for j, (sc_off, along) in enumerate(((th * 0.6, th * 0.5), (th, 0.0), (th, -th * 1.5))):
                ring = []
                for idx in base:
                    q = buf.v[idx]
                    d = q - ctr
                    L0 = d.length
                    dn = d / L0 if L0 > 1e-9 else d
                    ring.append(buf.vert(ctr + dn * max(L0 - sc_off, 1e-4) + t * (sign * along), buf.w[idx]))
                for kk in range(segs):
                    k2 = (kk + 1) % segs
                    if end == 0:
                        buf.face((ring[kk], ring[k2], prev[k2], prev[kk]), mat)
                    else:
                        buf.face((prev[kk], prev[k2], ring[k2], ring[kk]), mat)
                prev = ring
            return
        if kind == "flat":
            c = buf.vert(cs[i] + A * s.get("ox", 0) + B * s.get("oy", 0), w)
            for k in range(segs):
                k2 = (k + 1) % segs
                if end == 0:
                    buf.face((c, base[k2], base[k]), mat)
                else:
                    buf.face((c, base[k], base[k2]), mat)
            return
        L = (cap_len0 if end == 0 else cap_len1)
        if L is None:
            L = min(s["rx"], s["ry"]) * 0.9
        prev = base
        m = cap_rings
        for j in range(1, m):
            ang = (j / m) * (math.pi / 2)
            sc = math.cos(ang)
            off = t * (sign * L * math.sin(ang))
            ring = []
            for idx in base:
                q = buf.v[idx]
                ctr = cs[i] + A * s.get("ox", 0) + B * s.get("oy", 0)
                ring.append(buf.vert(ctr + (q - ctr) * sc + off, buf.w[idx]))
            for k in range(segs):
                k2 = (k + 1) % segs
                if end == 0:
                    buf.face((ring[k], ring[k2], prev[k2], prev[k]), mat)
                else:
                    buf.face((prev[k], prev[k2], ring[k2], ring[k]), mat)
            prev = ring
        ctr = cs[i] + A * s.get("ox", 0) + B * s.get("oy", 0)
        pole = buf.vert(ctr + t * (sign * L), w)
        for k in range(segs):
            k2 = (k + 1) % segs
            if end == 0:
                buf.face((pole, prev[k2], prev[k]), mat)
            else:
                buf.face((pole, prev[k], prev[k2]), mat)

    cap(0)
    cap(1)
    return rings


def band(buf: Buf, c, axis, ref, rx, ry, h, th, *, segs=20, p=2.0, mat=None, w=None, ryn=None, rxn=None,
         taper=0.0, disp=None):
    """링 모양 띠(벨트, 커프스, 끈, 모자 띠). axis 방향으로 높이 h, 두께 th인 닫힌 고리.
    disp(점) → 더할 벡터 또는 None: 안·바깥 링을 같은 양만큼 민다 (몸통 가슴 볼륨을 따라가는 가슴띠)."""
    axis = V(axis).normalized()
    r = V(ref)
    A = (r - axis * r.dot(axis)).normalized()
    B = axis.cross(A).normalized()
    c = V(c)
    lo = c - axis * (h / 2)
    hi = c + axis * (h / 2)
    k = 1 + taper
    rings = [
        ring_pts(lo, A, B, rx + th, ry + th, segs, p=p, rxn=None if rxn is None else rxn + th,
                 ryn=None if ryn is None else ryn + th),
        ring_pts(hi, A, B, (rx + th) * k, (ry + th) * k, segs, p=p, rxn=None if rxn is None else (rxn + th) * k,
                 ryn=None if ryn is None else (ryn + th) * k),
        ring_pts(hi, A, B, rx * k, ry * k, segs, p=p, rxn=None if rxn is None else rxn * k,
                 ryn=None if ryn is None else ryn * k),
        ring_pts(lo, A, B, rx, ry, segs, p=p, rxn=rxn, ryn=ryn),
    ]
    if disp is not None:
        # 안쪽 링 점으로 계산한 밀기를 같은 열의 바깥 링에도 써서 띠 두께를 그대로 둔다
        for j in range(segs):
            d0, d1 = disp(rings[3][j]), disp(rings[2][j])
            if d0 is not None:
                rings[3][j] = rings[3][j] + d0
                rings[0][j] = rings[0][j] + d0
            if d1 is not None:
                rings[2][j] = rings[2][j] + d1
                rings[1][j] = rings[1][j] + d1
    idx = [[buf.vert(q, w) for q in rg] for rg in rings]
    for a in range(4):
        r0, r1 = idx[a], idx[(a + 1) % 4]
        for kk in range(segs):
            k2 = (kk + 1) % segs
            buf.face((r0[kk], r0[k2], r1[k2], r1[kk]), mat)
    return idx


def rbox(buf: Buf, size, M: Matrix, *, mat=None, w=None, r=0.25, segs=1, taper=0.0):
    """둥근 상자(베벨 근사, 저폴리). size=(x,y,z) 전체 크기, M=배치 행렬. r=모서리 반경 비율(0~0.5).
    segs=1이면 64삼각형, 2면 144삼각형. taper>0이면 위(+Z)가 좁아짐."""
    sx, sy, sz = (s / 2 for s in size)
    rr = min(sx, sy, sz) * 2 * clamp(r, 0.02, 0.5)
    p = 2 + 8 * (1 - clamp(r * 2))
    n = 4 * (segs + 1)
    m = segs
    # 링 순서: 아래 극(작은 링) → 아래 적도 → 위 적도 → 위 극. (예전엔 아래쪽을 거꾸로 돌아 옆면이 잘록했다)
    zs = []
    for j in range(m, -1, -1):
        a = j / max(m, 1) * (math.pi / 2)
        zs.append((-sz + rr * (1 - math.sin(a)), math.cos(a) if m > 0 else 1.0))
    for j in range(m + 1):
        a = j / max(m, 1) * (math.pi / 2)
        zs.append((sz - rr * (1 - math.sin(a)), math.cos(a) if m > 0 else 1.0))
    rings = []
    for z, sc in zs:
        tz = 1 - taper * ((z + sz) / (2 * sz))
        rx = max((sx - rr) * tz + rr * sc, 1e-5)
        ry = max((sy - rr) * tz + rr * sc, 1e-5)
        pts = ring_pts(V((0, 0, z)), V((1, 0, 0)), V((0, 1, 0)), rx, ry, n, p=p, rot=math.pi / n)
        rings.append([buf.vert(M @ q, w) for q in pts])
    for a in range(len(rings) - 1):
        r0, r1 = rings[a], rings[a + 1]
        for k in range(n):
            k2 = (k + 1) % n
            buf.face((r0[k], r0[k2], r1[k2], r1[k]), mat)
    for end, rg in ((0, rings[0]), (1, rings[-1])):
        ctr = sum((buf.v[i] for i in rg), V()) / len(rg)
        c = buf.vert(ctr, w)
        for k in range(n):
            k2 = (k + 1) % n
            buf.face((c, rg[k2], rg[k]) if end == 0 else (c, rg[k], rg[k2]), mat)


def disc(buf: Buf, c, normal, up, rx, ry, th, *, segs=16, mat=None, w=None, p=2.0):
    """얇은 원판/타원판 (단추, 패치, 렌즈). normal 쪽이 앞면."""
    n = V(normal).normalized()
    u = V(up)
    u = (u - n * u.dot(n)).normalized()
    x = u.cross(n).normalized()
    c = V(c)
    f = ring_pts(c + n * th, x, u, rx, ry, segs, p=p)
    b = ring_pts(c, x, u, rx, ry, segs, p=p)
    fi = [buf.vert(q, w) for q in f]
    bi = [buf.vert(q, w) for q in b]
    cf = buf.vert(c + n * th, w)
    cbk = buf.vert(c, w)
    for k in range(segs):
        k2 = (k + 1) % segs
        buf.face((cf, fi[k], fi[k2]), mat)
        buf.face((cbk, bi[k2], bi[k]), mat)
        buf.face((bi[k], bi[k2], fi[k2], fi[k]), mat)


# =========================================================================== chain (bone path)

class Chain:
    """관절 점들을 잇는 경로 + 본 이름. t∈[0,1](길이 비율)에서 위치·접선·웨이트를 준다."""

    def __init__(self, pts, bones, *, blend=0.32, start: dict | None = None, start_blend=0.35):
        self.p = [V(x) for x in pts]
        self.bones = list(bones)
        self.blend = blend
        self.start = start
        self.start_blend = start_blend
        self.seg = [(b - a).length for a, b in zip(self.p, self.p[1:])]
        self.total = sum(self.seg)
        self.s = [0.0]
        for L in self.seg:
            self.s.append(self.s[-1] + L)

    def at(self, t):
        s = t * self.total
        if s <= 0:
            d = (self.p[1] - self.p[0]).normalized()
            return self.p[0] + d * s, d
        if s >= self.total:
            d = (self.p[-1] - self.p[-2]).normalized()
            return self.p[-1] + d * (s - self.total), d
        for i, L in enumerate(self.seg):
            if s <= self.s[i + 1] + 1e-9:
                a = (s - self.s[i]) / L if L > 0 else 0
                d = (self.p[i + 1] - self.p[i]).normalized()
                # 관절 근처에서 접선을 부드럽게
                tan = d
                bw = 0.25 * L
                if i + 1 < len(self.seg) and self.s[i + 1] - s < bw:
                    d2 = (self.p[i + 2] - self.p[i + 1]).normalized()
                    k = 0.5 * (1 - (self.s[i + 1] - s) / bw)
                    tan = (d * (1 - k) + d2 * k).normalized()
                if i > 0 and s - self.s[i] < bw:
                    d0 = (self.p[i] - self.p[i - 1]).normalized()
                    k = 0.5 * (1 - (s - self.s[i]) / bw)
                    tan = (d * (1 - k) + d0 * k).normalized()
                return self.p[i].lerp(self.p[i + 1], a), tan
        return self.p[-1], (self.p[-1] - self.p[-2]).normalized()

    def weights(self, t):
        s = clamp(t) * self.total
        i = 0
        while i < len(self.seg) - 1 and s > self.s[i + 1]:
            i += 1
        w = {self.bones[i]: 1.0}
        for j in range(1, len(self.seg)):
            sj = self.s[j]
            bw = self.blend * min(self.seg[j - 1], self.seg[j])
            if abs(s - sj) < bw:
                a = smoothstep(-bw, bw, s - sj)
                w = mixw({self.bones[j - 1]: 1.0}, {self.bones[j]: 1.0}, a)
        if self.start:
            bw = self.start_blend * self.seg[0]
            if s < bw:
                a = 0.5 + 0.5 * smoothstep(0, bw, s)
                w = mixw(self.start, w, a)
        return w


# =========================================================================== armature

def build_armature(name, bones):
    """bones: [(이름, head, tail, 부모, roll_z벡터 또는 None)]. roll_z: 본 로컬 Z축이 향할 방향."""
    data = bpy.data.armatures.new(name)
    arm = bpy.data.objects.new(name, data)
    cb.link(arm)
    data.display_type = "STICK"
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = arm
    arm.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    eb = data.edit_bones
    for bname, head, tail, parent, rollz in bones:
        b = eb.new(bname)
        b.head = head
        b.tail = tail
        if rollz is not None:
            b.align_roll(V(rollz))
        if parent:
            b.parent = eb[parent]
            b.use_connect = False
        b.use_deform = True
    bpy.ops.object.mode_set(mode="OBJECT")
    arm.select_set(False)
    return arm


# =========================================================================== the Elf

class Part:
    def __init__(self, obj, group, tag=None, keep=False, node=None, props=None):
        self.obj = obj
        self.group = group
        self.tag = tag
        self.keep = keep
        self.node = node      # 같은 node끼리 따로 합쳐 별도 오브젝트(<이름>_<node>)로 만든다
        self.props = props or {}


class Elf:
    """파라메트릭 엘프 한 명. 만들면 바로 리그(아마추어+소켓)와 머리가 생긴다.

    height  정수리까지 키(m, 귀·머리카락 제외). 기본 1.20
    head    턱~정수리(m). 기본 0.45 (≈2.7등신, 머리카락 포함 ≈2.5등신)
    head_w  머리 폭 / head (기본 1.04: 볼이 빵빵해 폭이 높이보다 약간 넓다)
    head_d  머리 깊이 / head (기본 0.92)
    cheek   볼 부풂 0~0.2 (기본 0.08)
    shoulders, hips  어깨/골반 폭 배율 (기본 1.0)
    limb    팔다리 굵기 배율 (기본 1.0)
    arm, leg  팔/다리 길이 배율 (기본 1.0)
    chest   가슴 볼륨 0~1 (기본 0.15): 흉곽 앞뒤 두께
    bust    가슴(흉부) 형태 0~1 (기본 0 = 지금까지와 같은 평평한 몸통). 성인 체형으로 가슴 볼륨이 보이는 인물만 준다.
            앞쪽 두 둥근 볼륨이 한 덩어리로 이어진 완만한 형태이고, 몸통을 따르는 옷(shirt, Shell, 가슴띠, 파우치, 끈,
            패치)이 같이 따라간다. 바깥 옷일수록 아래쪽이 천처럼 완만하게 떨어진다. CHARACTER_KIT.md 2장
    apose   A 포즈 팔 각도: 수평에서 아래로 몇 도 (기본 40)
    ear_len, ear_angle, ear_sweep, ear_width  귀 길이(m)/위로 든 각/뒤로 젖힌 각/폭(m)
    skin    피부색
    line    라인색 (merge 시 모든 툰 머티리얼 공통)
    segs    전체 분할 배율 (기본 1.0, 다수 등장 단역 0.7~0.8)
    hand_q  손 분할 배율 (기본 1.0, 1인칭 팔 1.2, 3인칭 단역 0.6)
    cheek_rig  볼 리그 (기본 True): head의 자식 본 cheek_L·cheek_R과 볼 둘레 부드러운 웨이트(머리 피부 + 얼굴 데칼).
            런타임 CheekRig가 본을 옮기고 늘려 볼이 출렁이고·부풀고·눌리고·늘어난다. CHARACTER_KIT.md 8장
    eye_depth  socket_eye를 얼굴 표면에서 머리 안쪽으로 넣는 깊이(m, 기본 0.04). 높이·좌우는 두 눈 사이 중앙.
            SD 머리는 얼굴이 가슴보다 0.17m 앞에 있다. 얼굴 표면이면 -80°에서도 가슴 앞만 스치고, 너무 깊으면
            (0.1↑) 가슴 윗면이 화면을 덮는다. 0.04면 -60°에 가슴 장비 앞 모서리, -80°에 가슴 장비 전체가 보인다.
    """

    def __init__(self, name="elf", *, height=1.20, head=0.45, head_w=1.06, head_d=0.92, cheek=0.10,
                 shoulders=1.0, hips=1.0, limb=1.0, arm=1.0, leg=1.0, chest=0.15, bust=0.0, apose=40.0,
                 ear_len=0.095, ear_angle=14.0, ear_sweep=12.0, ear_width=0.060, ear_inner=True,
                 skin=SKIN, line=LINE, segs=1.0, hand_q=1.0, eye_depth=0.04, cheek_rig=True):
        self.name = name
        self.H = height
        self.hh = head
        self.hw = head * head_w
        self.hd = head * head_d
        self.cheek = cheek
        self.sh = shoulders
        self.hp = hips
        self.lb = limb
        self.arm_k = arm
        self.leg_k = leg
        self.chest_amt = chest
        self.bust_amt = max(0.0, float(bust))
        self.apose = apose
        self.ear = dict(len=ear_len, angle=ear_angle, sweep=ear_sweep, width=ear_width, inner=ear_inner)
        self.line = line
        self.q = segs  # 분할 배율 (여럿 등장하는 단역은 0.7~0.8)
        self.hq = hand_q  # 손 분할 배율 (1인칭 팔은 1.0 이상, 3인칭 단역은 0.6~0.8)
        self.eye_depth = eye_depth
        self.cheek_rig = bool(cheek_rig)
        self.cheeks = {}          # 볼 리그: side → {"c": 볼 중심(피부), "n": 바깥 법선, "tx": 가로 접선} (_build_cheek_rig)
        self.face_decals = []     # 얼굴 데칼로 등록한 파츠 태그 (볼 웨이트를 받는다, face_decal())
        self.skin_mat = mat(f"{name}_skin", skin) if isinstance(skin, str) else skin
        self.skin_hex = skin if isinstance(skin, str) else srgb_hex(mat_srgb(skin))
        self.parts: list[Part] = []
        self.cover = {"torso": [], "arm_L": [], "arm_R": [], "leg_L": [], "leg_R": []}
        self.hide_hands = False
        self.hide_feet = False
        self.hands_mat = None
        self.feet_done = False
        self._layout()
        self.arm_obj = self._rig()
        self._head()
        self._ears()
        self._neck()
        self.face_obj = None
        self._finalized = False

    # ------------------------------------------------------------------ proportions
    def _layout(self):
        H, hh = self.H, self.hh
        self.chin = H - hh
        k = self.chin / 0.75
        self.k = k
        self.head_c = V((0, 0.0, self.chin + hh / 2))
        self.shoulder_z = 0.686 * k
        self.torso_top = 0.752 * k
        self.hipj_z = 0.348 * k * self.leg_k
        self.crotch_z = self.hipj_z - 0.050 * k
        self.knee_z = self.hipj_z * 0.54
        self.ankle_z = 0.062 * k
        self.waist_z = lerp(self.hipj_z, self.shoulder_z, 0.45)
        self.chest_z = lerp(self.hipj_z, self.shoulder_z, 0.70)
        self.bust_z = lerp(self.hipj_z, self.shoulder_z, 0.71)   # 가슴 볼륨 꼭짓점 높이
        self.neck_top = self.chin + 0.03 * k
        # 팔 (A 포즈)
        a = math.radians(self.apose)
        self.arm_len = (0.128 * k * self.arm_k, 0.112 * k * self.arm_k)
        self.hand_len = 0.050 * k * self.arm_k
        self.finger_len = 0.036 * k * self.arm_k
        sx = 0.136 * k * self.sh
        self.S = {}
        self.E = {}
        self.W = {}
        self.adir = {}
        self.palm_n = {}
        for side, s in (("L", 1), ("R", -1)):
            d = V((s * math.cos(a), 0, -math.sin(a)))
            S = V((s * sx, 0.0, self.shoulder_z))
            E = S + d * self.arm_len[0]
            W = E + d * self.arm_len[1]
            self.S[side], self.E[side], self.W[side], self.adir[side] = S, E, W, d
            self.palm_n[side] = V((-s * math.sin(a), 0, -math.cos(a)))
        # 다리
        hx = 0.072 * k * self.hp
        self.Hj, self.K, self.A = {}, {}, {}
        for side, s in (("L", 1), ("R", -1)):
            self.Hj[side] = V((s * hx, 0.0, self.hipj_z))
            self.K[side] = V((s * hx * 1.04, -0.004 * k, self.knee_z))
            self.A[side] = V((s * hx * 1.04, 0.004 * k, self.ankle_z))
        # 몸통 단면 표 (u: 0=가랑이, 1=목 밑)
        ch = self.chest_amt
        self.torso_tab = [
            (0.00, (0.092, 0.068, 0.010)),
            (0.07, (0.126, 0.088, 0.012)),
            (0.17, (0.134, 0.093, 0.010)),
            (0.33, (0.128, 0.088, 0.004)),
            (0.46, (0.120, 0.083, 0.000)),
            (0.60, (0.125, 0.085 + 0.006 * ch, -0.004 - 0.004 * ch)),
            (0.74, (0.131, 0.086 + 0.012 * ch, -0.006 - 0.008 * ch)),
            (0.85, (0.130, 0.081, -0.002)),
            (0.92, (0.116, 0.071, 0.000)),
            (0.97, (0.086, 0.059, 0.002)),
            (1.00, (0.056, 0.048, 0.004)),
        ]

    def torso_at(self, z):
        """높이 z에서 몸통 단면 (rx, ry_front, ry_back, cy). 몸통 표면 위치 계산용."""
        u = (z - self.crotch_z) / (self.torso_top - self.crotch_z)
        rx, ry, cy = keys(self.torso_tab, u)
        hpk = lerp(self.hp, self.sh, smoothstep(0.35, 0.65, u))
        rx *= hpk * self.k
        ry *= self.k
        return rx, ry, cy * self.k

    def bust_off(self, z, angle, off=0.0):
        """가슴 볼륨(bust)이 몸통 표면에 더하는 바깥 두께(m). z: 높이, angle: 0=정면, 90=왼쪽.
        off: 몸 표면에서 띄운 거리(m). 바깥 옷일수록 가운데 골이 메워지고 아래쪽이 천처럼 완만하게 떨어진다.
        bust=0이면 언제나 0이다 (기존 모델이 그대로 나온다)."""
        b = self.bust_amt
        if b <= 0.0:
            return 0.0
        k = self.k
        dr = smoothstep(0.004 * k, 0.026 * k, off)
        dz = z - self.bust_z
        s = (0.046 + 0.008 * dr) * k if dz > 0 else (0.024 + 0.024 * dr) * k
        vz = math.exp(-(dz / s) ** 2)
        if vz < 1e-4:
            return 0.0
        a = abs(((angle + 180.0) % 360.0) - 180.0)
        a = math.sqrt(a * a + 25.0)            # 정면 가운데를 둥글게 (꺾임 없음)
        a0 = 31.0                              # 두 볼륨의 중심 방위
        if a < a0:
            br = lerp(0.62, 0.86, dr)          # 가운데(골) 높이: 맨살 62%, 옷 86%
            ha = br + (1.0 - br) * math.exp(-((a - a0) / 20.0) ** 2)
        else:
            ha = math.exp(-((a - a0) / 28.0) ** 2)
        return BUST_DEPTH * k * b * vz * ha

    def _bust_vec(self, q, rx, ry, cy, p, off):
        """단면(rx, ry, cy, p) 위의 점 q를 가슴 볼륨만큼 미는 벡터 (없으면 None). loft·band의 disp에 쓴다."""
        X = q.x / rx
        Y = (q.y - cy) / ry
        h = p / 2.0
        ang = math.degrees(math.atan2(math.copysign(abs(X) ** h, X), -math.copysign(abs(Y) ** h, Y)))
        b = self.bust_off(q.z, ang, off)
        if b <= 1e-7:
            return None
        n = V((math.copysign(abs(X) ** (p - 1), X) / rx, math.copysign(abs(Y) ** (p - 1), Y) / ry, 0.0))
        return n.normalized() * b if n.length > 1e-9 else None

    def _bust_disp(self, off):
        """loft station용 disp (torso_stations가 bust > 0일 때 단다)."""
        return lambda q, s: self._bust_vec(q, s["rx"], s["ry"], s["c"][1], s.get("p", 2.0), off)

    def torso_point(self, z, angle, off=0.0):
        """몸통 표면 점과 법선. angle: 0=정면(-Y), 90=왼쪽(+X), 180=등, -90=오른쪽.
        bust > 0이면 가슴 볼륨 위의 점이고, 법선도 볼륨 곡면을 따른다."""
        p, nrm = self._torso_point0(z, angle, off)
        if self.bust_amt <= 0.0:
            return p, nrm
        b = self.bust_off(z, angle, off)
        if b <= 1e-7:
            return p, nrm

        def S(zz, aa):
            q, n = self._torso_point0(zz, aa, off)
            return q + n * self.bust_off(zz, aa, off)
        dz = 0.003 * self.k
        n2 = (S(z, angle + 1.5) - S(z, angle - 1.5)).cross(S(z + dz, angle) - S(z - dz, angle))
        if n2.length < 1e-12:
            return p + nrm * b, nrm
        if n2.dot(nrm) < 0:
            n2 = -n2
        return p + nrm * b, n2.normalized()

    def _torso_point0(self, z, angle, off=0.0):
        """가슴 볼륨 없는 몸통 단면 위의 점과 수평 법선."""
        rx, ry, cy = self.torso_at(z)
        a = math.radians(angle)
        dx, dy = math.sin(a), -math.cos(a)
        p = 2.3
        e = 2 / p
        x = math.copysign(abs(dx) ** e, dx) * rx
        y = math.copysign(abs(dy) ** e, dy) * ry + cy
        # 근사 법선
        nrm = V((x / (rx * rx), (y - cy) / (ry * ry), 0)).normalized()
        return V((x, y, z)) + nrm * off, nrm

    def arm_chain(self, side):
        return Chain([self.S[side], self.E[side], self.W[side]], [f"upperarm_{side}", f"forearm_{side}"],
                     start={f"shoulder_{side}": 1.0})

    def leg_chain(self, side):
        return Chain([self.Hj[side], self.K[side], self.A[side]], [f"thigh_{side}", f"shin_{side}"],
                     start={"hips": 1.0}, start_blend=0.25)

    def arm_r(self, t):
        """팔 반경 (rx, ry) at t."""
        r = keys([(0.0, 0.047), (0.12, 0.045), (0.45, 0.039), (0.53, 0.037), (0.70, 0.037), (1.0, 0.031)], t)
        return r * self.k * self.lb, r * self.k * self.lb * 0.94

    def leg_r(self, t):
        r = keys([(0.0, 0.076), (0.25, 0.071), (0.52, 0.057), (0.62, 0.057), (0.78, 0.053), (1.0, 0.043)], t)
        return r * self.k * self.lb, r * self.k * self.lb * 0.96

    def limb_point(self, limb, t, angle, off=0.0):
        """팔다리 표면 점과 법선. limb='arm_L'|'leg_R' 등. angle: 0=앞, +90=캐릭터 왼쪽(+X), -90=오른쪽, 180=뒤."""
        kind, side = limb.split("_")
        ch = self.arm_chain(side) if kind == "arm" else self.leg_chain(side)
        c, tan = ch.at(t)
        rx, ry = (self.arm_r if kind == "arm" else self.leg_r)(t)
        fwd = V((0, -1, 0))
        A = (fwd - tan * fwd.dot(tan)).normalized()
        B = -tan.cross(A).normalized()   # +X(캐릭터 왼쪽) 쪽
        a = math.radians(angle)
        n = (A * math.cos(a) + B * math.sin(a)).normalized()
        p = c + A * (rx * math.cos(a)) + B * (ry * math.sin(a))
        return p + n * off, n

    # ------------------------------------------------------------------ rig
    def _rig(self):
        k = self.k
        fwd = (0, -1, 0)
        up = (0, 0, 1)
        bones = [
            ("root", (0, 0, 0), (0, 0, 0.12 * k), None, fwd),
            ("hips", (0, 0, self.hipj_z), (0, 0, self.waist_z), "root", fwd),
            ("spine", (0, 0, self.waist_z), (0, 0, self.chest_z), "hips", fwd),
            ("chest", (0, 0, self.chest_z), (0, 0, self.torso_top - 0.012 * k), "spine", fwd),
            ("neck", (0, 0, self.torso_top - 0.012 * k), (0, 0, self.neck_top), "chest", fwd),
            ("head", (0, 0, self.neck_top), (0, 0, self.H - 0.04 * k), "neck", fwd),
        ]
        for side, s in (("L", 1), ("R", -1)):
            S, E, W, d, P = self.S[side], self.E[side], self.W[side], self.adir[side], self.palm_n[side]
            bones += [
                (f"shoulder_{side}", (s * 0.025 * k, 0, self.shoulder_z - 0.004 * k), tuple(S), "chest", fwd),
                (f"upperarm_{side}", tuple(S), tuple(E), f"shoulder_{side}", fwd),
                (f"forearm_{side}", tuple(E), tuple(W), f"upperarm_{side}", fwd),
                (f"hand_{side}", tuple(W), tuple(W + d * self.hand_len), f"forearm_{side}", tuple(P)),
            ]
            for nm, base, mid, tip in self._finger_joints(side):
                bones.append((f"{nm}_01_{side}", tuple(base), tuple(mid), f"hand_{side}", tuple(P)))
                bones.append((f"{nm}_02_{side}", tuple(mid), tuple(tip), f"{nm}_01_{side}", tuple(P)))
            Hj, K, A = self.Hj[side], self.K[side], self.A[side]
            toe = A + V((0, -0.075 * k, -0.035 * k))
            bones += [
                (f"thigh_{side}", tuple(Hj), tuple(K), "hips", fwd),
                (f"shin_{side}", tuple(K), tuple(A), f"thigh_{side}", fwd),
                (f"foot_{side}", tuple(A), tuple(toe), f"shin_{side}", up),
            ]
        # 귀 본 (머리를 만든 뒤 위치가 확정되므로 근사값으로 만들고 _ears에서 맞춘다)
        for side, s in (("L", 1), ("R", -1)):
            base, tip = self._ear_axis(side)
            bones.append((f"ear_{side}", tuple(base), tuple(tip), "head", up))
        arm = build_armature(f"{self.name}_rig", bones)
        self.bone_names = [b[0] for b in bones]
        # 소켓
        self._socket("socket_hand_R", "hand_R", self._grip_point("R"), self._grip_rot("R"), arm=arm)
        self._socket("socket_hand_L", "hand_L", self._grip_point("L"), self._grip_rot("L"), arm=arm)
        rx, ry, cy = self.torso_at(self.chest_z)
        self._socket("socket_back", "chest", V((0, cy + ry + 0.05 * k, self.chest_z)), None, arm=arm)
        hrx, _, _ = self.torso_at(self.hipj_z)
        self._socket("socket_hip_R", "hips", V((-(hrx + 0.03 * k), 0.0, self.hipj_z - 0.03 * k)), None, arm=arm)
        return arm

    def _socket(self, name, bone, pos, rot, arm=None):
        arm = arm or self.arm_obj
        e = cb.empty(name, loc=tuple(pos))
        if rot is not None:
            e.rotation_euler = rot.to_euler()
        cb.parent_to_bone(e, arm, bone)
        return e

    def _grip_point(self, side):
        W, d, P = self.W[side], self.adir[side], self.palm_n[side]
        return W + d * (self.hand_len * 0.75) + P * (0.026 * self.k)

    def _grip_rot(self, side):
        d, P = self.adir[side], self.palm_n[side]
        T = V((0, -1, 0))
        y = d.normalized()
        z = T
        x = y.cross(z).normalized()
        return Matrix((x, y, z)).transposed()

    # ------------------------------------------------------------------ head
    def _head_fn(self, x, y, z):
        """단위구 좌표 → 머리 표면. SD: 정수리 둥글고, 아래쪽 볼이 옆·앞으로 빵빵, 얼굴 앞면은 평평한 편."""
        W, D, Hh = self.hw / 2, self.hd / 2, self.hh / 2
        ck = self.cheek
        # 볼: 아래 앞쪽 옆을 부풀림
        low = math.exp(-((z + 0.38) / 0.36) ** 2)
        front = smoothstep(0.35, -0.75, y)
        sx = 1 + ck * 1.3 * low * (0.4 + 0.6 * front)
        sy = 1 + ck * 0.5 * low * front
        # 턱: 아래로 갈수록 좁게
        jaw = smoothstep(-0.55, -1.0, z)
        sx *= 1 - 0.16 * jaw
        sy *= 1 - 0.14 * jaw
        # 얼굴 앞면을 평평하게
        if y < 0:
            flat = 0.16 * smoothstep(0.75, -0.2, z) * (1 - 0.6 * abs(x))
            sy *= 1 - flat
        # 뒤통수 약간 볼록
        if y > 0:
            sy *= 1 + 0.05 * smoothstep(-0.2, 0.6, z)
        # 바닥(목 닿는 곳)을 살짝 평평하게
        zz = z * (1 - 0.06 * smoothstep(-0.85, -1.0, z))
        return V((x * W * sx, y * D * sy, zz * Hh)) + self.head_c

    def _head(self):
        k = self.k
        segs = int(34 * self.q) // 2 * 2
        rings = int(22 * self.q)
        buf = Buf()
        verts = [[None] * segs for _ in range(rings - 1)]
        w = {"head": 1.0}
        for i in range(1, rings):
            el = math.pi / 2 - math.pi * i / rings
            for j in range(segs):
                az = 2 * math.pi * j / segs
                x = math.cos(el) * math.sin(az)
                y = -math.cos(el) * math.cos(az)
                z = math.sin(el)
                verts[i - 1][j] = buf.vert(self._head_fn(x, y, z), w)
        top = buf.vert(self._head_fn(0, 0, 1), w)
        bot = buf.vert(self._head_fn(0, 0, -1), w)
        m = self.skin_mat
        for j in range(segs):
            j2 = (j + 1) % segs
            buf.face((top, verts[0][j], verts[0][j2]), m)
            buf.face((bot, verts[-1][j2], verts[-1][j]), m)
        for i in range(rings - 2):
            for j in range(segs):
                j2 = (j + 1) % segs
                buf.face((verts[i][j], verts[i + 1][j], verts[i + 1][j2], verts[i][j2]), m)
        ob = buf.obj(f"{self.name}_head_skin")
        self.head_obj = ob
        self.add(ob, group="head", tag="head")
        # BVH (얼굴 투영, 머리카락·모자 표면 계산용)
        bm = bmesh.new()
        bm.from_mesh(ob.data)
        bm.transform(ob.matrix_world)
        self.head_bvh = BVHTree.FromBMesh(bm)
        bm.free()
        # 눈 소켓: 두 눈 사이 중앙, 얼굴 표면 살짝 안쪽
        ez = self.eye_z()
        hit = self.head_bvh.ray_cast(V((0, -2, ez)), V((0, 1, 0)))
        fy = hit[0].y if hit[0] else -self.hd / 2
        self.face_y = fy
        self._socket("socket_eye", "head", V((0, fy + self.eye_depth * k, ez)), None)
        if self.cheek_rig:
            self._build_cheek_rig()

    # ------------------------------------------------------------------ cheeks (볼 리그)
    # 볼 둘레 웨이트 모양 (머리 크기 hh/0.45 배): 가로 반경, 위·아래 반경, 깊이 반경 (m)
    CHEEK_R = {"u": 0.100, "up": 0.052, "dn": 0.078, "h": 0.064}
    CHEEK_DEPTH = 0.045       # 본 머리(늘이기 중심)를 볼 표면에서 머리 안쪽으로 넣는 깊이 (m, 머리 크기 배)

    def _cheek_center(self, side):
        """볼 중심 (기본 볼터치 자리 근처, 눈 아래 바깥)을 얼굴 표면에 투영한 점과 법선."""
        hs = self.hh / 0.45
        s = 1 if side == "L" else -1
        x = s * (0.098 * (self.hw / 0.477) + 0.036 * hs)
        z = self.eye_z() - 0.058 * hs
        return self.face_project(x, z)

    def _cheek_r2(self, p, side):
        """볼 중심에서 타원체 거리의 제곱 (1 = 웨이트 경계)."""
        ck = self.cheeks.get(side)
        if ck is None:
            return 1e9
        hs = self.hh / 0.45
        R = self.CHEEK_R
        d = V(p) - ck["c"]
        u = d.dot(ck["tx"]) / (R["u"] * hs)
        v = d.z / ((R["up"] if d.z > 0 else R["dn"]) * hs)
        h = d.dot(ck["n"]) / (R["h"] * hs)
        return u * u + v * v + h * h

    def cheek_weight(self, p, side):
        """점 p(머리 피부 근처)의 볼 본 웨이트 0~1. 볼 중심에서 타원체 거리 r로 (1 - r²)² (경계에서 매끄럽게 0).
        위쪽 반경이 짧아 눈 윗부분과 이마에는 닿지 않고, 깊이 반경으로 머리 옆·뒤 피부에는 닿지 않는다."""
        r2 = self._cheek_r2(p, side)
        return (1.0 - r2) ** 2 if r2 < 1.0 else 0.0

    def _cheek_w(self, p):
        """머리 피부 웨이트 사전 (head + cheek_L/R, 합 1)."""
        wl = self.cheek_weight(p, "L")
        wr = self.cheek_weight(p, "R")
        t = wl + wr
        if t > 1.0:
            wl, wr = wl / t, wr / t
            t = 1.0
        w = {"head": 1.0 - t}
        if wl > 1e-4:
            w["cheek_L"] = wl
        if wr > 1e-4:
            w["cheek_R"] = wr
        return w

    def _build_cheek_rig(self):
        """볼 본 둘 + 머리 피부 볼 웨이트. 볼 둘레 머리 피부 면만 3×3으로 나눠(평평하게: 표면 모양은 거의 그대로) 늘이고
        부풀려도 매끈하다. 나눈 뒤 얼굴 투영용 BVH(head_bvh)를 새 피부로 다시 만든다: 얼굴 데칼·귀·머리카락이 실제로 그려지는
        피부 위에 놓여, 나눈 면의 쌍선형 점이 데칼을 뚫고 나오지 않는다."""
        hs = self.hh / 0.45
        up = V((0, 0, 1))
        for side in ("L", "R"):
            c, n = self._cheek_center(side)
            n = n.normalized()
            tx = up.cross(n)
            tx = tx.normalized() if tx.length > 1e-6 else V((1, 0, 0))
            self.cheeks[side] = {"c": c, "n": n, "tx": tx}
            # 본: 머리 안쪽(늘이기 중심) → 볼 표면. 로컬 +Y = 바깥 법선, +Z = 위
            self.add_bone(f"cheek_{side}", c - n * (self.CHEEK_DEPTH * hs), c, "head", roll=(0, 0, 1))
        ob = self.head_obj
        bm = bmesh.new()
        bm.from_mesh(ob.data)
        # 볼 웨이트가 닿는 면과 그 바로 바깥 한 줄 (경계가 매끄럽게 이어지게)
        near = [f for f in bm.faces if any(self._cheek_r2(v.co, sd) < 1.2 for sd in ("L", "R") for v in f.verts)]
        edges = list({e for f in near for e in f.edges})
        if edges:
            bmesh.ops.subdivide_edges(bm, edges=edges, cuts=2, use_grid_fill=True, smooth=1.0)
        for f in bm.faces:
            f.smooth = True
        bm.to_mesh(ob.data)
        bm.transform(ob.matrix_world)
        self.head_bvh = BVHTree.FromBMesh(bm)
        bm.free()
        ob.data.update()
        ob.vertex_groups.clear()
        groups = {}
        for v in ob.data.vertices:
            for b, x in self._cheek_w(v.co).items():
                if x <= 1e-4:
                    continue
                if b not in groups:
                    groups[b] = ob.vertex_groups.new(name=b)
                groups[b].add([v.index], x, "REPLACE")
        # 데칼 웨이트용: 분할한 피부 삼각형 BVH + 정점 웨이트 (find_nearest → 무게중심 보간)
        me = ob.data
        me.calc_loop_triangles()
        mw = ob.matrix_world
        verts = [mw @ v.co for v in me.vertices]
        tris = [tuple(t.vertices) for t in me.loop_triangles]
        self._cheek_skin = (BVHTree.FromPolygons(verts, tris), verts, tris, [self._cheek_w(p) for p in verts])

    def cheek_decal_w(self, p, max_dist=0.012):
        """얼굴 데칼 정점 p의 웨이트: 가장 가까운 머리 피부 삼각형 세 꼭짓점 웨이트를 무게중심 좌표로 섞는다.
        피부와 같은 식으로 움직이므로 볼을 옮기면(늘리기) 데칼이 피부에 정확히 붙어 간다. 피부에서 max_dist(m, 머리 크기 배)
        보다 멀면 head 100% (머리카락 가닥 등)."""
        if not self.cheeks:
            return {"head": 1.0}
        bvh, verts, tris, ws = self._cheek_skin
        loc, _n, idx, dist = bvh.find_nearest(V(p))
        if loc is None or dist > max_dist * self.hh / 0.45:
            return {"head": 1.0}
        a, b, c = (verts[i] for i in tris[idx])
        v0, v1, v2 = b - a, c - a, loc - a
        d00, d01, d11 = v0.dot(v0), v0.dot(v1), v1.dot(v1)
        d20, d21 = v2.dot(v0), v2.dot(v1)
        den = d00 * d11 - d01 * d01
        if abs(den) < 1e-18:
            bw = (1.0, 0.0, 0.0)
        else:
            y = (d11 * d20 - d01 * d21) / den
            z = (d00 * d21 - d01 * d20) / den
            bw = (1.0 - y - z, y, z)
        out = {}
        for wv, i in zip(bw, tris[idx]):
            for bn, x in ws[i].items():
                out[bn] = out.get(bn, 0.0) + wv * x
        return {bn: x for bn, x in out.items() if x > 1e-4}

    def face_decal(self, tag_or_obj):
        """얼굴 위 데칼 파츠(눈물 자국, 볼 빗금, 감은 눈 속눈썹 등 얼굴 표면에 붙인 것)를 등록한다. 볼 리그가 있으면
        finalize 때 피부와 같은 볼 웨이트를 받아 볼을 늘리고 부풀려도 피부에서 떨어지지 않는다. face()의 얼굴은 자동."""
        tag = tag_or_obj if isinstance(tag_or_obj, str) else next(
            (p.tag for p in self.parts if p.obj is tag_or_obj), None)
        if tag and tag not in self.face_decals:
            self.face_decals.append(tag)
        return tag

    def _weight_decal_obj(self, ob):
        """오브젝트 정점마다 cheek_decal_w로 정점 그룹을 다시 쓴다 (셰이프 키 Basis 위치 기준)."""
        me = ob.data
        mw = ob.matrix_world
        ob.vertex_groups.clear()
        groups = {}
        for v in me.vertices:
            for b, x in self.cheek_decal_w(mw @ v.co).items():
                if b not in groups:
                    groups[b] = ob.vertex_groups.new(name=b)
                groups[b].add([v.index], x, "REPLACE")

    def _s(self, n, lo=6):
        """분할 수에 품질 배율 적용 (짝수)."""
        return max(lo, int(round(n * self.q / 2)) * 2)

    def eye_z(self):
        return self.chin + self.hh * 0.335

    def head_point(self, az, el, off=0.0):
        """머리 표면 점과 법선. az: 0=정면, 90=왼쪽(+X), 180=뒤. el: 위로 +도. off: 바깥으로 띄우기."""
        a, e = math.radians(az), math.radians(el)
        d = V((math.cos(e) * math.sin(a), -math.cos(e) * math.cos(a), math.sin(e)))
        o = self.head_c
        hit = self.head_bvh.ray_cast(o + d * 1.0, -d)
        if hit[0] is None:
            return o + d * (self.hh / 2 + off), d
        n = hit[1].normalized()
        return hit[0] + n * off, n

    def face_project(self, x, z, off=0.0):
        """정면(-Y)에서 (x, z)를 얼굴 표면에 투영."""
        hit = self.head_bvh.ray_cast(V((x, -2.0, z)), V((0, 1, 0)))
        if hit[0] is None:
            return V((x, self.face_y, z)), V((0, -1, 0))
        n = hit[1].normalized()
        return hit[0] + n * off, n

    # ------------------------------------------------------------------ ears
    def _ear_axis(self, side):
        s = 1 if side == "L" else -1
        ear = self.ear
        bz = self.chin + self.hh * 0.40
        bx = s * self.hw / 2 * 0.86
        base = V((bx, 0.03 * self.k, bz))
        a = math.radians(ear["angle"])
        sw = math.radians(ear["sweep"])
        d = V((s * math.cos(a) * math.cos(sw), math.sin(sw) * math.cos(a), math.sin(a)))
        return base, base + d * (ear["len"] + self.hw / 2 * 0.14)

    def _ears(self):
        ear = self.ear
        for side, s in (("L", 1), ("R", -1)):
            # 실제 머리 표면 위의 뿌리
            a = math.radians(ear["angle"])
            sw = math.radians(ear["sweep"])
            d = V((s * math.cos(a) * math.cos(sw), math.sin(sw) * math.cos(a), math.sin(a)))
            bz = self.chin + self.hh * 0.40
            hit = self.head_bvh.ray_cast(V((s * 1.0, 0.02 * self.k, bz)), V((-s, 0, 0)))
            root = hit[0] if hit[0] else V((s * self.hw / 2, 0, bz))
            L = ear["len"]
            Wd = ear["width"]
            pts = [root - d * 0.02 * self.k, root, root + d * L * 0.45 + V((0, 0, 0.004)), root + d * L]
            ch = Chain(pts, [f"ear_{side}"] * 3)
            buf = Buf()
            st = []
            n = 9
            for i in range(n):
                t = i / (n - 1)
                c, tan = ch.at(t)
                c = c + V((0, 0, 0.006 * math.sin(t * math.pi))) * self.k
                wr = keys([(0.0, 0.50), (0.22, 0.52), (0.5, 0.40), (0.8, 0.18), (1.0, 0.02)], t) * Wd
                th = keys([(0.0, 0.40), (0.3, 0.32), (0.8, 0.22), (1.0, 0.05)], t) * Wd * 0.42
                wb = {"head": 1.0} if t < 0.18 else mixw({"head": 1.0}, {f"ear_{side}": 1.0}, smoothstep(0.18, 0.4, t))
                st.append({"c": c, "rx": wr, "ry": th, "w": wb, "ref": (0, 0, 1), "oy": 0.0})
            loft(buf, st, segs=max(8, int(10 * self.q)), cap0="round", cap1="round", mat=self.skin_mat, cap_len1=0.004,
                 cap_rings=2)
            if ear["inner"]:
                inner = mat(f"{self.name}_ear_in", mix_hex(self.skin_hex, "#f2a7a0", 0.45))
                st2 = []
                for i in range(n):
                    t = 0.12 + 0.7 * i / (n - 1)
                    c, tan = ch.at(t)
                    c = c + V((0, 0, 0.006 * math.sin(t * math.pi))) * self.k
                    # 앞쪽 면으로 약간 내밈
                    B = tan.cross(V((0, 0, 1)) - tan * tan.z).normalized()
                    fwd = -B if B.y > 0 else B
                    th = keys([(0.0, 0.40), (0.3, 0.32), (0.8, 0.22), (1.0, 0.05)], t) * Wd * 0.42
                    wr = keys([(0.12, 0.30), (0.4, 0.26), (0.7, 0.12), (0.82, 0.02)], t) * Wd
                    wb = mixw({"head": 1.0}, {f"ear_{side}": 1.0}, smoothstep(0.18, 0.4, t))
                    st2.append({"c": c + fwd * th * 0.62 - V((0, 0, 0.003)) * self.k, "rx": wr, "ry": th * 0.45,
                                "w": wb, "ref": (0, 0, 1)})
                loft(buf, st2, segs=8, cap0="round", cap1="round", mat=inner, cap_len0=0.004, cap_len1=0.003,
                     cap_rings=2)
            ob = buf.obj(f"{self.name}_ear_{side}")
            self.add(ob, group="head", tag=f"ear_{side}")

    def _neck(self):
        k = self.k
        buf = Buf()
        z0, z1 = self.torso_top - 0.03 * k, self.chin + 0.06 * k
        st = []
        for i in range(5):
            t = i / 4
            z = lerp(z0, z1, t)
            w = mixw({"chest": 1.0}, {"neck": 1.0}, smoothstep(0.0, 0.35, t))
            w = mixw(w, {"head": 1.0}, smoothstep(0.7, 1.0, t))
            st.append({"c": (0, 0.004 * k, z), "rx": 0.050 * k, "ry": 0.045 * k, "w": w})
        loft(buf, st, segs=14, cap0=None, cap1="round", mat=self.skin_mat, ref=(1, 0, 0))
        ob = buf.obj(f"{self.name}_neck")
        self.add(ob, group="head", tag="neck")

    # ------------------------------------------------------------------ body (deferred)
    def _uncovered(self, key, lo, hi, margin):
        """[lo,hi] 중 옷에 덮이지 않은 구간 목록 (덮인 구간 안쪽으로 margin만큼 겹치게)."""
        segs = [(lo, hi)]
        for a, b in self.cover[key]:
            a2 = a + margin if a > lo + 1e-6 else a
            b2 = b - margin if b < hi - 1e-6 else b
            if b2 <= a2:
                continue
            out = []
            for x, y in segs:
                if b2 <= x or a2 >= y:
                    out.append((x, y))
                    continue
                if a2 > x:
                    out.append((x, a2))
                if b2 < y:
                    out.append((b2, y))
            segs = out
        return [(x, y) for x, y in segs if y - x > 1e-3]

    def _torso_wfn(self, q, i):
        z = q.z
        k = self.k
        w = {"hips": 1.0}
        a1 = smoothstep(self.waist_z - 0.05 * k, self.waist_z + 0.04 * k, z)
        w = mixw(w, {"spine": 1.0}, a1)
        a2 = smoothstep(self.chest_z - 0.05 * k, self.chest_z + 0.04 * k, z)
        w = mixw(w, {"chest": 1.0}, a2)
        # 어깨 위쪽 바깥은 shoulder 본 (으쓱)
        sh = smoothstep(0.045 * k, 0.11 * k, abs(q.x)) * smoothstep(self.shoulder_z - 0.07 * k, self.shoulder_z, z)
        if sh > 0:
            side = "L" if q.x > 0 else "R"
            w = mixw(w, {f"shoulder_{side}": 1.0}, sh * 0.7)
        # 가랑이 아래쪽은 허벅지 쪽으로 조금
        lg = smoothstep(self.hipj_z, self.crotch_z, z) * smoothstep(0.02 * k, 0.07 * k, abs(q.x))
        if lg > 0:
            side = "L" if q.x > 0 else "R"
            w = mixw(w, {f"thigh_{side}": 1.0}, lg * 0.5)
        return w

    def torso_stations(self, z0, z1, *, off=0.0, n=None, flare=None, p=2.3, ref=(1, 0, 0)):
        """몸통 표를 따라 z0~z1 단면 목록 (옷 셸에 씀). flare: [(u,추가반경),...] u=0(z0)~1(z1)."""
        n = n or max(4, int(abs(z1 - z0) / (0.028 * self.k)) + 2)
        st = []
        for i in range(n):
            u = i / (n - 1)
            z = lerp(z0, z1, u)
            rx, ry, cy = self.torso_at(z)
            fl = keys(flare, u) if flare else 0.0
            st.append({"c": (0, cy, z), "rx": rx + off + fl, "ry": ry + off + fl, "p": p})
            if self.bust_amt > 0.0:
                st[-1]["disp"] = self._bust_disp(off + fl)
        return st

    def _build_skin(self):
        k = self.k
        m = self.skin_mat
        # 몸통
        for a, b in self._uncovered("torso", self.crotch_z, self.torso_top, 0.03 * k):
            buf = Buf()
            st = self.torso_stations(a, b)
            cap0 = "round" if a <= self.crotch_z + 1e-4 else None
            cap1 = "round" if b >= self.torso_top - 1e-4 else None
            loft(buf, st, segs=int(22 * self.q), cap0=cap0, cap1=cap1, mat=m, wfn=self._torso_wfn,
                 cap_len0=0.035 * k, cap_len1=0.03 * k)
            self.add(buf.obj(f"{self.name}_torso_skin"), group="body", tag="skin")
        for side in ("L", "R"):
            # 팔
            ch = self.arm_chain(side)
            for a, b in self._uncovered(f"arm_{side}", 0.0, 1.0, 0.06):
                buf = Buf()
                cap1 = "round" if b > 0.999 else None
                if self.hide_hands and b > 0.999:
                    b, cap1 = 0.975, "flat"   # 장갑 커프 안에서 끝냄 (둥근 끝이 장갑 밖으로 비치지 않게)
                if b - a < 0.02:
                    continue
                self._limb_loft(buf, ch, self.arm_r, a, b, m, segs=int(14 * self.q),
                                cap0="round" if a < 1e-3 else None, cap1=cap1)
                self.add(buf.obj(f"{self.name}_arm_{side}_skin"), group="arms", tag="skin")
            if not self.hide_hands:
                self.add(self.hand(side, m), group="arms", tag=f"hand_{side}")
            # 다리
            ch = self.leg_chain(side)
            for a, b in self._uncovered(f"leg_{side}", -0.08, 1.0, 0.06):
                buf = Buf()
                self._limb_loft(buf, ch, self.leg_r, a, b, m, segs=int(16 * self.q),
                                cap0="round" if a < 0 else None, cap1="round" if b > 0.999 else None)
                self.add(buf.obj(f"{self.name}_leg_{side}_skin"), group="body", tag="skin")
            if not self.hide_feet:
                self.add(self.foot(side, m), group="body", tag=f"foot_{side}")

    def _limb_loft(self, buf, ch, rfn, a, b, m, *, segs=14, cap0=None, cap1=None, off=0.0, extra=None, p=2.0,
                   n=None, ref=(0, -1, 0), mat_fn=None):
        n = n or max(3, int((b - a) * ch.total / (0.018 * self.k)) + 2)
        st = []
        for i in range(n):
            t = lerp(a, b, i / (n - 1))
            c, tan = ch.at(t)
            rx, ry = rfn(clamp(t))
            ex = extra(t) if extra else 0.0
            st.append({"c": c, "rx": rx + off + ex, "ry": ry + off + ex, "w": ch.weights(t), "p": p})
        return loft(buf, st, segs=segs, cap0=cap0, cap1=cap1, mat=m, ref=ref,
                    cap_len0=min(st[0]["rx"], st[0]["ry"]) * 0.8, cap_len1=min(st[-1]["rx"], st[-1]["ry"]) * 0.8)

    # ------------------------------------------------------------------ hands & feet
    def _finger_joints(self, side):
        """[(이름, base, mid, tip)] 엄지 + 손가락 3개."""
        k = self.k * self.arm_k
        W, L, P = self.W[side], self.adir[side], self.palm_n[side]
        T = V((0, -1, 0))
        out = []
        knuck = W + L * self.hand_len
        specs = [("f1", 0.0165, 1.00, 5), ("f2", -0.0005, 1.06, 0), ("f3", -0.0175, 0.90, -6)]
        for nm, toff, lk, fan in specs:
            base = knuck + T * (toff * k) + P * (0.002 * k)
            d = (L + T * math.tan(math.radians(fan))).normalized()
            # 약간 손바닥 쪽으로 굽은 휴식 자세
            d1 = (d + P * 0.12).normalized()
            d2 = (d + P * 0.32).normalized()
            Lf = self.finger_len * lk
            mid = base + d1 * Lf * 0.55
            tip = mid + d2 * Lf * 0.45
            out.append((nm, base, mid, tip))
        base = W + L * (0.012 * k) + T * (0.021 * k) + P * (0.008 * k)
        d = (T * 0.78 + L * 0.50 + P * 0.30).normalized()
        Lt = self.finger_len * 0.95
        mid = base + d * Lt * 0.5
        d2 = (T * 0.55 + L * 0.68 + P * 0.42).normalized()
        tip = mid + d2 * Lt * 0.5
        out.insert(0, ("thumb", base, mid, tip))
        return out

    def hand(self, side, material, *, inflate=0.0, cuff=None, name=None) -> bpy.types.Object:
        """손 메시 (엄지+손가락 3개, 손가락 본 웨이트 포함). inflate>0이면 장갑처럼 부풀림."""
        k = self.k * self.arm_k
        W, L, P = self.W[side], self.adir[side], self.palm_n[side]
        T = V((0, -1, 0))
        buf = Buf()
        hb = f"hand_{side}"
        # 손바닥
        st = []
        tab = [(0.0, (0.021, 0.013)), (0.35, (0.0275, 0.0155)), (0.75, (0.0285, 0.015)), (1.0, (0.026, 0.013))]
        n = 6
        for i in range(n):
            t = i / (n - 1)
            rx, ry = keys(tab, t)
            c = W + L * (lerp(-0.004, 1.0, t) * self.hand_len) + P * (0.001 * k) + T * (0.001 * k)
            w = mixw({f"forearm_{side}": 1.0}, {hb: 1.0}, smoothstep(0.0, 0.25, t))
            st.append({"c": c, "rx": rx * k + inflate, "ry": ry * k + inflate, "w": w, "ref": tuple(T), "p": 2.6})
        loft(buf, st, segs=max(8, int(14 * self.hq) // 2 * 2), cap0="round", cap1="round", mat=material,
             cap_len0=0.006 * k, cap_len1=0.007 * k, cap_rings=2 if self.hq < 1 else 3)
        # 손가락
        for nm, base, mid, tip in self._finger_joints(side):
            r0 = (0.0112 if nm == "thumb" else 0.0102) * k + inflate
            r1 = (0.0098 if nm == "thumb" else 0.0090) * k + inflate
            back = base - (mid - base).normalized() * 0.008 * k
            ch = Chain([back, base, mid, tip], [hb, f"{nm}_01_{side}", f"{nm}_02_{side}"], blend=0.45)
            st = []
            nn = 7 if self.hq >= 1 else 5
            for i in range(nn):
                t = i / (nn - 1)
                c, tan = ch.at(t)
                r = lerp(r0, r1, t)
                st.append({"c": c, "rx": r, "ry": r * 0.92, "w": ch.weights(t), "ref": tuple(T)})
            loft(buf, st, segs=max(6, int(10 * self.hq) // 2 * 2), cap0="round", cap1="round", mat=material,
                 cap_len1=r1 * 0.9, cap_rings=2 if self.hq < 1 else 3)
        if cuff:
            cm, ch_, th = cuff
            ar = self.arm_r(1.0)
            band(buf, W - L * (ch_ * 0.35), L, T, ar[0] + inflate * 0.6, ar[1] + inflate * 0.6, ch_, th, segs=self._s(16),
                 mat=cm, w={f"forearm_{side}": 0.6, hb: 0.4})
        return buf.obj(name or f"{self.name}_hand_{side}")

    def foot(self, side, material, *, inflate=0.0, name=None, sole=None, toe_up=0.0) -> bpy.types.Object:
        """발 (뭉툭한 덩어리). inflate>0 + sole=(재질, 두께)면 신발/장화."""
        k = self.k
        A = self.A[side]
        buf = Buf()
        fb = f"foot_{side}"
        tab = [(0.0, (0.034, 0.032, 0.036)), (0.25, (0.038, 0.036, 0.038)), (0.6, (0.039, 0.028, 0.028)),
               (1.0, (0.035, 0.022, 0.024))]
        st = []
        n = 8
        for i in range(n):
            t = i / (n - 1)
            rx, ryu, cz = keys(tab, t)
            y = lerp(0.034, -0.088, t) * k
            c = V((A.x, A.y + y, cz * k + toe_up * t * t))
            w = mixw({f"shin_{side}": 1.0}, {fb: 1.0}, smoothstep(0.0, 0.35, t))
            st.append({"c": c, "rx": rx * k + inflate, "ry": ryu * k + inflate, "ryn": (cz * k) - 0.0005 + inflate,
                       "w": w, "ref": (1, 0, 0), "p": 2.4})
        fs = max(10, int(14 * self.q) // 2 * 2)
        loft(buf, st, segs=fs, cap0="round", cap1="round", mat=material, cap_len0=0.02 * k, cap_len1=0.026 * k,
             cap_rings=2)
        if sole:
            sm, th = sole
            # 밑창: 발 윤곽을 따라 납작한 판
            stp = []
            for i in range(n):
                t = i / (n - 1)
                rx, ryu, cz = keys(tab, t)
                y = lerp(0.034, -0.088, t) * k
                stp.append({"c": V((A.x, A.y + y, th / 2 - 0.0005)), "rx": rx * k + inflate + 0.003 * k,
                            "ry": th / 2, "w": {fb: 1.0}, "ref": (1, 0, 0), "p": 4.0})
            loft(buf, stp, segs=fs, cap0="round", cap1="round", mat=sm, cap_len0=0.022 * k + inflate,
                 cap_len1=0.03 * k + inflate, cap_rings=2)
        return buf.obj(name or f"{self.name}_foot_{side}")

    # ------------------------------------------------------------------ registry
    def add(self, obj, *, bone=None, group=None, tag=None, keep=False, node=None, props=None):
        """파츠 등록. bone을 주면 그 본에 100% 스키닝(강체). group: 'body'|'arms'|'head' (생략 시 웨이트로 추정).
        keep=True면 합치지 않고 별도 오브젝트로 남긴다 (움직이는 장비 등).
        node='이름'이면 같은 node 파츠끼리 따로 합쳐 '<인물>_<node>' 오브젝트로 만들고 props(커스텀 속성, 예:
        {"outline": 0.0035} / {"noOutline": 1})를 단다. 반환: obj"""
        if bone:
            cb.apply_modifiers(obj)
            _bake_transform(obj)
            obj.vertex_groups.clear()
            vg = obj.vertex_groups.new(name=bone)
            vg.add(list(range(len(obj.data.vertices))), 1.0, "REPLACE")
        if group is None:
            group = _infer_group(obj)
        self.parts.append(Part(obj, group, tag, keep, node, props))
        return obj

    def remove(self, tag):
        for p in [p for p in self.parts if p.tag == tag]:
            bpy.data.objects.remove(p.obj, do_unlink=True)
            self.parts.remove(p)

    def group_of_bone(self, bone):
        if bone.startswith(ARM_BONES_PREFIX):
            return "arms"
        if bone.startswith(HEAD_BONES_PREFIX):
            return "head"
        return "body"

    # ------------------------------------------------------------------ finalize
    def finalize(self, *, merge=True, outline=None, report=True, only=None):
        """맨살 파츠 생성 → fpHide 그룹별로 합치고 스키닝 → 얼굴은 head 본에 부착.
        merge=True면 불투명 툰 머티리얼을 정점색으로 구워 'toon_vc' 하나로 합친다.
        only=('arms',)처럼 주면 그 그룹만 남긴다 (1인칭 팔 뷰모델). 리그·소켓은 그대로 남는다."""
        if self._finalized:
            return
        for h in getattr(self, "_hairs", []):
            h.done()
        self._build_skin()
        if only is not None:
            for p in [p for p in self.parts if p.group not in only]:
                bpy.data.objects.remove(p.obj, do_unlink=True)
                self.parts.remove(p)
            if "head" not in only and self.face_obj is not None:
                bpy.data.objects.remove(self.face_obj, do_unlink=True)
                self.face_obj = None
        if report:
            rows = {}
            for p in self.parts:
                me = p.obj.evaluated_get(bpy.context.evaluated_depsgraph_get()).to_mesh()
                me.calc_loop_triangles()
                key = (p.tag or p.obj.name).rstrip("0123456789")
                rows[key] = rows.get(key, 0) + len(me.loop_triangles)
            if self.face_obj is not None:
                rows["face"] = sum(len(pl.vertices) - 2 for pl in self.face_obj.data.polygons)
            tot = sum(rows.values())
            print(f"[elf] {self.name} tris={tot}  " + "  ".join(f"{k}={v}" for k, v in
                                                            sorted(rows.items(), key=lambda kv: -kv[1])))
        if self.cheeks:
            for p in self.parts:
                if p.tag in self.face_decals:
                    cb.apply_modifiers(p.obj)
                    _bake_transform(p.obj)
                    self._weight_decal_obj(p.obj)
            if self.face_obj is not None:
                self._weight_decal_obj(self.face_obj)
        vc = vc_material(f"{self.name}_toon_vc", self.line) if merge else None
        result = {}
        keys_ = []
        for g in ("body", "arms", "head"):
            keys_.append((g, None))
            for p in self.parts:
                if p.group == g and p.node and (g, p.node) not in keys_:
                    keys_.append((g, p.node))
        for g, node in keys_:
            sel = [p for p in self.parts if p.group == g and not p.keep and p.node == node]
            objs = [p.obj for p in sel]
            if not objs:
                continue
            for o in objs:
                cb.apply_modifiers(o)
                _bake_transform(o)
                if merge:
                    bake_vcol(o)
            ob = cb.join(objs, name=f"{self.name}_{node or g}")
            if merge:
                remap_to_vc(ob, vc)
            collapse_slots(ob)
            if g != "body":
                ob["fpHide"] = g
            for p in sel:
                for kk, vv in p.props.items():
                    ob[kk] = vv
            if outline is not None:
                ob["outline"] = outline
            mod = ob.modifiers.new("Armature", "ARMATURE")
            mod.object = self.arm_obj
            ob.parent = self.arm_obj
            result[node or g] = ob
        for p in self.parts:
            if p.keep:
                if p.group != "body":
                    p.obj["fpHide"] = p.group
                if p.obj.parent is None and p.obj.vertex_groups:
                    mod = p.obj.modifiers.new("Armature", "ARMATURE")
                    mod.object = self.arm_obj
                    p.obj.parent = self.arm_obj
        if self.face_obj is not None:
            f = self.face_obj
            f["noOutline"] = 1
            f["fpHide"] = "head"
            if self.cheeks:
                # 볼 리그: 머리 피부와 같은 볼 웨이트로 스키닝 (셰이프 키 + Armature는 glTF 스킨 + 모프로 나간다)
                mod = f.modifiers.new("Armature", "ARMATURE")
                mod.object = self.arm_obj
                f.parent = self.arm_obj
            else:
                cb.parent_to_bone(f, self.arm_obj, "head")
            result["face"] = f
        self.result = result
        self._finalized = True
        return result

    def export(self, rel_path, *, outline=0.006, props=None):
        if not self._finalized:
            self.finalize()
        pr = {"outline": outline}
        if props:
            pr.update(props)
        return cb.export(rel_path, props=pr, root=self.arm_obj)

    # ------------------------------------------------------------------ pose (test / clips)
    def pose(self, rots: dict, *, action="pose", frames=(1, 2)):
        """본 회전(도, 로컬 XYZ 오일러)을 키프레임한 액션을 만든다. 뷰어 --mode single 로 확인.
        rots: {"upperarm_L": (x, y, z), ...}"""
        arm = self.arm_obj
        arm.animation_data_create()
        act = bpy.data.actions.new(action)
        arm.animation_data.action = act
        for b in arm.pose.bones:
            b.rotation_mode = "XYZ"
        for f in frames:
            for bn, r in rots.items():
                pb = arm.pose.bones[bn]
                pb.rotation_euler = [math.radians(x) for x in r]
                pb.keyframe_insert("rotation_euler", frame=f)
        return act


# =========================================================================== materials / baking

def mat(name, color, **kw):
    """cb.mat 래퍼 (같은 인자). 키트 안에서 쓰는 머티리얼 생성."""
    return cb.mat(name, color, **kw)


def vc_material(name, line=LINE):
    if name in bpy.data.materials:
        return bpy.data.materials[name]
    m = bpy.data.materials.new(name)
    try:
        m.use_nodes = True
    except Exception:  # noqa: BLE001
        pass
    nt = m.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    node = nt.nodes.new("ShaderNodeVertexColor")
    node.layer_name = "Col"
    nt.links.new(node.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.6
    m["lineColor"] = line
    return m


def _mergeable(m) -> bool:
    if m is None:
        return True
    if m.name.startswith("UNLIT_"):
        return False
    try:
        bsdf = m.node_tree.nodes.get("Principled BSDF")
        if bsdf.inputs["Alpha"].default_value < 0.999:
            return False
        es = bsdf.inputs["Emission Strength"].default_value
        ec = bsdf.inputs["Emission Color"].default_value
        if es > 0 and (ec[0] + ec[1] + ec[2]) > 0.001:
            return False
    except Exception:  # noqa: BLE001
        pass
    return True


def bake_vcol(obj):
    """면 머티리얼 색을 'Col' 정점색으로 굽는다. 합칠 수 없는 머티리얼(UNLIT, 발광, 투명) 면은 흰색."""
    me = obj.data
    if "Col" in me.color_attributes:
        ca = me.color_attributes["Col"]
    else:
        ca = me.color_attributes.new(name="Col", type="BYTE_COLOR", domain="CORNER")
    cols = []
    for m in me.materials:
        cols.append((*mat_srgb(m), 1.0) if _mergeable(m) else (1.0, 1.0, 1.0, 1.0))
    if not cols:
        cols = [(1, 1, 1, 1)]
    for poly in me.polygons:
        c = cols[min(poly.material_index, len(cols) - 1)]
        for li in poly.loop_indices:
            ca.data[li].color_srgb = c


def remap_to_vc(obj, vc):
    me = obj.data
    for i, m in enumerate(me.materials):
        if _mergeable(m):
            me.materials[i] = vc


def collapse_slots(obj):
    """같은 머티리얼을 가리키는 슬롯을 하나로 (glTF 프리미티브 수 = 드로우콜 수)."""
    me = obj.data
    mats = list(me.materials)
    uniq = []
    remap = {}
    for i, m in enumerate(mats):
        if m not in uniq:
            uniq.append(m)
        remap[i] = uniq.index(m)
    idx = [remap.get(p.material_index, 0) for p in me.polygons]
    me.materials.clear()
    for m in uniq:
        me.materials.append(m)
    for p, i in zip(me.polygons, idx):
        p.material_index = i


def _bake_transform(obj):
    if obj.parent is None and obj.matrix_world != Matrix.Identity(4):
        obj.data.transform(obj.matrix_world)
        obj.matrix_world = Matrix.Identity(4)


def _infer_group(obj):
    tot = {}
    for v in obj.data.vertices:
        for g in v.groups:
            nm = obj.vertex_groups[g.group].name
            tot[nm] = tot.get(nm, 0) + g.weight
    if not tot:
        return "body"
    best = max(tot, key=tot.get)
    if best.startswith(ARM_BONES_PREFIX):
        return "arms"
    if best.startswith(HEAD_BONES_PREFIX):
        return "head"
    return "body"


# =========================================================================== face (expressions)

FACE_NEUTRAL = {
    # 눈 윤곽: w 폭, top/bot 윗·아랫 호 높이, cin/cout 안·바깥 눈꼬리 높이, ktop/kbot 호 각짐(2=둥금),
    # tilt_in/out 윗눈꺼풀 안/바깥쪽 내림(-)·올림(+), lift 아래눈꺼풀 들어올림, close 감기(0~1)
    "eye": {"w": 0.074, "top": 0.030, "bot": 0.054, "cin": 0.010, "cout": 0.016, "ktop": 3.0, "kbot": 2.1,
            "tilt_in": 0.0, "tilt_out": 0.0, "lift": 0.0, "close": 0.0},
    # 홍채: 반경, 중심(눈 중심 기준), pupil 동공 배율
    # 홍채 위쪽은 항상 윗눈꺼풀에 잘려야 한다 (cz+ry ≥ cin/cout+top). 아니면 속눈썹과 홍채 사이에 흰 띠가 생겨
    # 속눈썹이 눈썹처럼 떠 보인다 (특히 smile에서 아래 눈꺼풀이 올라갈 때).
    # gx/gz: 시선 이동 (얼굴 평면의 월드 x/z, 두 눈 같은 방향). 홍채·동공·하이라이트가 함께 움직이고 눈 윤곽에 잘린다.
    "iris": {"rx": 0.0285, "ry": 0.0400, "cx": 0.0, "cz": 0.0045, "pupil": 1.0, "gx": 0.0, "gz": 0.0},
    # 눈썹: 눈 중심 기준 높이 dz, 바깥쪽 이동 dx, 길이, 두께, 각도(+면 안쪽 끝이 올라감), 아치
    "brow": {"dz": 0.064, "dx": 0.004, "len": 0.040, "th": 0.0062, "ang": 0.0, "arch": 0.003},
    # 입: 폭, 입꼬리 곡률(+ 웃음), 벌림, 윗입술 아치, 물결
    "mouth": {"w": 0.022, "curve": 0.0030, "open": 0.0, "top_arch": 0.0, "wave": 0.0, "dz": 0.0},
}

FACE_EXPR = {
    "blink": {"eye": {"close": 1.0}},
    "serious": {"eye": {"top": 0.018, "ktop": 3.6, "tilt_in": -0.012, "bot": 0.050, "cin": 0.006},
                "brow": {"ang": -16.0, "dz": 0.054, "arch": 0.0, "th": 0.0072},
                "mouth": {"w": 0.019, "curve": -0.0008}},
    "surprised": {"eye": {"top": 0.038, "bot": 0.058, "ktop": 2.1, "kbot": 2.0},
                  "iris": {"pupil": 0.62, "rx": 0.0255, "ry": 0.033, "cz": 0.002},
                  "brow": {"dz": 0.080, "arch": 0.008},
                  "mouth": {"w": 0.015, "open": 0.017, "top_arch": 0.004, "curve": 0.0}},
    "pained": {"eye": {"top": 0.014, "tilt_in": 0.012, "tilt_out": -0.010, "lift": 0.014, "ktop": 2.2,
                       "cout": 0.008},
               "brow": {"ang": 20.0, "dz": 0.060, "arch": -0.002},
               "mouth": {"w": 0.027, "curve": -0.0055, "open": 0.0055, "wave": 0.0016}},
    "smile": {"eye": {"lift": 0.024, "top": 0.026, "kbot": 2.4},
              "brow": {"dz": 0.068, "arch": 0.006},
              "mouth": {"w": 0.028, "curve": 0.0065, "open": 0.0095, "top_arch": -0.001}},
    # 말하기: 입만 연다 (다른 표정과 더해도 입이 자연스럽게 열린다)
    "talk": {"mouth": {"open": 0.013, "w": 0.020, "top_arch": 0.0015}},
    "talk_o": {"mouth": {"open": 0.019, "w": 0.016, "top_arch": 0.005, "curve": 0.0}},
    # 시선: 캐릭터 기준 왼쪽(+X)/오른쪽/위/아래
    "look_L": {"iris": {"gx": 0.0125}},
    "look_R": {"iris": {"gx": -0.0125}},
    "look_up": {"iris": {"gz": 0.009}},
    "look_down": {"iris": {"gz": -0.010}},
}


def _merge_expr(base, over):
    out = {k: dict(v) for k, v in base.items()}
    for k, v in over.items():
        out[k].update(v)
    return out


def _sup(s, k):
    s = clamp(abs(s), 0.0, 1.0)
    return (1 - s ** k) ** (1 / k)


def _pip(pt, poly):
    x, y = pt
    inside = False
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        if (y1 > y) != (y2 > y):
            xi = x1 + (y - y1) * (x2 - x1) / (y2 - y1 + 1e-12)
            if xi > x:
                inside = not inside
    return inside


def _nearest_on_poly(pt, poly):
    best = None
    bd = 1e9
    px, py = pt
    n = len(poly)
    for i in range(n):
        ax, ay = poly[i]
        bx, by = poly[(i + 1) % n]
        dx, dy = bx - ax, by - ay
        L = dx * dx + dy * dy
        t = 0.0 if L < 1e-14 else clamp(((px - ax) * dx + (py - ay) * dy) / L)
        qx, qy = ax + dx * t, ay + dy * t
        d = (qx - px) ** 2 + (qy - py) ** 2
        if d < bd:
            bd, best = d, (qx, qy)
    return best


def clip_to(pts, poly):
    """볼록 다각형 poly 밖의 점을 경계로 당긴다 (같은 정점 수 유지 → 셰이프 키 호환)."""
    return [p if _pip(p, poly) else _nearest_on_poly(p, poly) for p in pts]


def ellipse2(cx, cz, rx, rz, n, rot=0.0):
    return [(cx + rx * math.cos(rot + 2 * math.pi * i / n), cz + rz * math.sin(rot + 2 * math.pi * i / n))
            for i in range(n)]


class Face:
    """얼굴 파츠(눈·눈썹·입·볼터치)를 머리 표면에 투영해 만든다. 표정은 셰이프 키.

    Elf.face(...)로 만든다. 2D 설계 좌표는 정면에서 본 (x, z) 월드 좌표다.
    """

    LASH_SKIP = 3  # 윗 호 안쪽 끝에서 속눈썹을 그리지 않는 점 수 (안쪽 눈꼬리가 갈고리처럼 보이지 않게)

    def __init__(self, e: "Elf", *, eye_color="#5a7fb5", eye_size=1.0, eye_spacing=1.0, eye_height=0.0,
                 lash="#3a2027", brow=None, brow_th=1.0, mouth_color="#9a3b45", tongue="#f2898c",
                 blush="#f9aca8", blush_size=1.0, blush_lines=0, sclera="#fffaf7", iris_dark=None,
                 iris_light=None, pupil=None, highlight="#ffffff", lower_lash=True, expr=None, base=None):
        self.e = e
        k = e.k
        self.sz = 1.12 * eye_size * (e.hh / 0.45)
        self.ex = 0.098 * eye_spacing * (e.hw / 0.477)
        self.ez = e.eye_z() + eye_height
        self.lash_c = lash
        self.brow_c = brow or lash
        self.brow_th = brow_th
        self.blush_size = blush_size
        self.blush_lines = blush_lines
        self.lower_lash = lower_lash
        n = e.name
        self.m = {
            "sclera": mat(f"{n}_f_sclera", sclera),
            "iris": mat(f"{n}_f_iris", eye_color),
            "iris_dark": mat(f"{n}_f_iris_d", iris_dark or shade(eye_color, -0.55)),
            "iris_light": mat(f"{n}_f_iris_l", iris_light or mix_hex(shade(eye_color, 0.30), "#ffe7b8", 0.18)),
            "pupil": mat(f"{n}_f_pupil", pupil or mix_hex(shade(eye_color, -0.78), "#1c1218", 0.5)),
            "hl": mat(f"{n}_f_hl", highlight, unlit=True),
            "lash": mat(f"{n}_f_lash", lash),
            "lash2": mat(f"{n}_f_lash2", mix_hex(lash, e.skin_hex, 0.45)),
            "brow": mat(f"{n}_f_brow", self.brow_c),
            "mouth": mat(f"{n}_f_mouth", mouth_color),
            "mline": mat(f"{n}_f_mline", mix_hex(lash, mouth_color, 0.25)),
            "tongue": mat(f"{n}_f_tongue", tongue),
            "blush": mat(f"{n}_f_blush", blush),
            "blush_l": mat(f"{n}_f_blushl", shade(blush, -0.18)),
        }
        self.base = _merge_expr(FACE_NEUTRAL, base or {})
        self.exprs = dict(FACE_EXPR)
        if expr:
            for k2, v in expr.items():
                self.exprs[k2] = v

    # ---- 2D shapes (face plane) ----
    def eye_outline(self, side, P):
        """눈 윤곽 2D 다각형 (반시계). side=+1 왼눈(+X), -1 오른눈."""
        q = P["eye"]
        sz = self.sz
        w = q["w"] * sz / 2
        nt, nb = 16, 12
        cx, cz = side * self.ex, self.ez

        def v0(s):
            return lerp(q["cin"], q["cout"], (s + 1) / 2) * sz

        def top(s):
            v = v0(s) + q["top"] * sz * _sup(s, q["ktop"])
            v += q["tilt_in"] * sz * (1 - s) / 2 * _sup(s, 2.0)
            v += q["tilt_out"] * sz * (1 + s) / 2 * _sup(s, 2.0)
            return v

        def bot(s):
            v = v0(s) - q["bot"] * sz * _sup(s, q["kbot"]) + q["lift"] * sz * 1.7 * _sup(s, 2.0)
            return v

        def closed(s):
            return v0(s) - 0.010 * sz * _sup(s, 2.0)

        c = q["close"]
        # 속눈썹 선은 윗 호의 LASH_SKIP번째 점부터 시작한다. 눈을 감을수록 그보다 안쪽 점들을 속눈썹 시작점으로
        # 모아서, 감은 눈에서 접힌 홍채·흰자가 속눈썹 밖으로 비치지 않게 한다.
        s0 = -1 + 2 * self.LASH_SKIP / nt

        def se(s):
            return lerp(s, max(s, s0), c)

        topline = []
        for i in range(nt + 1):
            s = se(-1 + 2 * i / nt)   # 안쪽(-1) → 바깥(+1)
            t = lerp(top(s), closed(s), c)
            topline.append((cx + side * s * w, cz + t))
        botline = []
        for i in range(1, nb):
            s = se(1 - 2 * i / nb)
            t = lerp(top(s), closed(s), c)
            b = lerp(min(bot(s), t - 0.0004), closed(s) - 0.0004, c)
            b = min(b, t - 0.0004)
            botline.append((cx + side * s * w, cz + b))
        pts = topline + botline
        self._botline = list(reversed(botline))  # 안쪽 → 바깥
        if side < 0:
            pts = list(reversed(pts))
        return pts, topline

    def build(self):
        """셰이프 키: 표정마다 1개 + 교정 키 blink_<표정>.
        모프는 더해지기 때문에 blink와 다른 표정을 함께 1로 두면 눈꺼풀이 겹친다. 교정 키는
        기본 + (표정+감은 눈 − 기본) − (표정 − 기본) − (blink − 기본)이라서, 런타임에서 blink_<표정> = blink × 표정 으로 주면
        감은 눈이 정확히 닫힌다 (CHARACTER_KIT.md 6장)."""
        P0 = self.base
        bufs = {"neutral": self._build(P0)}
        for nm, ov in self.exprs.items():
            bufs[nm] = self._build(_merge_expr(P0, ov))
        b0 = bufs["neutral"]
        keys_co = {nm: b.v for nm, b in bufs.items() if nm != "neutral"}
        if "blink" in self.exprs:
            vb = bufs["blink"].v
            for nm, ov in self.exprs.items():
                if nm.startswith("blink") or ov.get("eye", {}).get("close", 0) >= 1:
                    continue
                comb = self._build(_merge_expr(_merge_expr(P0, ov), {"eye": {"close": 1.0}})).v
                ve = bufs[nm].v
                # 절대 좌표: 기본 + (합-기본) - (표정-기본) - (blink-기본)
                co = [c - e - b + o * 2 for c, e, b, o in zip(comb, ve, vb, b0.v)]
                if max((x - o).length for x, o in zip(co, b0.v)) < 1e-6:
                    continue   # 눈을 건드리지 않는 표정(talk 등)은 교정 키가 필요 없다 (용량 절약)
                keys_co[f"blink_{nm}"] = co
        ob = b0.obj(f"{self.e.name}_face", smooth=True)
        ob.shape_key_add(name="Basis")
        for nm, co_list in keys_co.items():
            assert len(co_list) == len(b0.v), f"표정 {nm}: 정점 수 불일치 {len(co_list)} != {len(b0.v)}"
            key = ob.shape_key_add(name=nm, from_mix=False)
            for i, co in enumerate(co_list):
                key.data[i].co = co
            key.value = 0.0  # glTF 기본 weight (Blender 5는 새 키가 1.0으로 내보내질 수 있음)
        return ob

    # ---- geometry helpers ----
    def _fill(self, buf, pts2, off, m, rings=(0.55,)):
        e = self.e
        n = len(pts2)
        cx = sum(p[0] for p in pts2) / n
        cz = sum(p[1] for p in pts2) / n
        layers = [pts2] + [[(cx + (x - cx) * r, cz + (z - cz) * r) for x, z in pts2] for r in rings]
        idx = []
        for L in layers:
            idx.append([buf.vert(e.face_project(x, z, off)[0]) for x, z in L])
        c = buf.vert(e.face_project(cx, cz, off)[0])
        for a in range(len(idx) - 1):
            r0, r1 = idx[a], idx[a + 1]
            for i in range(n):
                j = (i + 1) % n
                buf.face((r0[i], r0[j], r1[j], r1[i]), m)
        last = idx[-1]
        for i in range(n):
            j = (i + 1) % n
            buf.face((last[i], last[j], c), m)

    def _stroke(self, buf, line, widths, off, m, shift=0.0):
        """2D 선 (중심선 + 굵기) → 띠. shift>0이면 선 법선 '위' 방향으로 밀기."""
        e = self.e
        n = len(line)
        L, R = [], []
        for i in range(n):
            a = line[max(i - 1, 0)]
            b = line[min(i + 1, n - 1)]
            tx, tz = b[0] - a[0], b[1] - a[1]
            ln = math.hypot(tx, tz) or 1.0
            nx, nz = -tz / ln, tx / ln
            if nz < 0:
                nx, nz = -nx, -nz
            x, z = line[i]
            w = widths[i] / 2
            x += nx * shift * widths[i]
            z += nz * shift * widths[i]
            L.append(buf.vert(e.face_project(x + nx * w, z + nz * w, off)[0]))
            R.append(buf.vert(e.face_project(x - nx * w, z - nz * w, off)[0]))
        for i in range(n - 1):
            buf.face((R[i], R[i + 1], L[i + 1], L[i]), m)

    def _build(self, P):
        buf = Buf()
        m = self.m
        sz = self.sz
        for side in (1, -1):
            outline, topline = self.eye_outline(side, P)
            cx, cz = side * self.ex, self.ez
            # 흰자
            self._fill(buf, outline, 0.0010, m["sclera"])
            # 홍채
            ip = P["iris"]
            icx = cx + side * ip["cx"] * sz + ip.get("gx", 0.0) * sz
            icz = cz + ip["cz"] * sz + ip.get("gz", 0.0) * sz
            nq = self.e.q
            iris = clip_to(ellipse2(icx, icz, ip["rx"] * sz, ip["ry"] * sz, max(16, int(24 * nq))), outline)
            self._fill(buf, iris, 0.0016, m["iris"])
            dark = clip_to(ellipse2(icx, icz + ip["ry"] * sz * 0.55, ip["rx"] * sz * 1.1, ip["ry"] * sz * 0.62,
                                    max(14, int(20 * nq))), iris)
            self._fill(buf, dark, 0.0020, m["iris_dark"], rings=(0.5,))
            light = clip_to(ellipse2(icx, icz - ip["ry"] * sz * 0.66, ip["rx"] * sz * 0.66, ip["ry"] * sz * 0.30, 18),
                            iris)
            self._fill(buf, light, 0.0022, m["iris_light"], rings=(0.5,))
            pr = ip["pupil"]
            pupil = clip_to(ellipse2(icx, icz + 0.002 * sz, ip["rx"] * sz * 0.40 * pr, ip["ry"] * sz * 0.44 * pr, 18),
                            iris)
            self._fill(buf, pupil, 0.0025, m["pupil"], rings=())
            # 하이라이트 (화면 왼쪽 위에서 빛: 두 눈 같은 방향)
            h1 = clip_to(ellipse2(icx - 0.0085 * sz, icz + 0.0115 * sz, 0.0088 * sz, 0.0105 * sz, 16, rot=0.3), outline)
            self._fill(buf, h1, 0.0031, m["hl"], rings=())
            h2 = clip_to(ellipse2(icx + 0.0095 * sz, icz - 0.0125 * sz, 0.0036 * sz, 0.0036 * sz, 10), outline)
            self._fill(buf, h2, 0.0031, m["hl"], rings=())
            # 윗 속눈썹 선: 윗 호를 따라, 바깥 눈꼬리에서 살짝 뻗음
            line = list(topline)[:-1]
            sgn = side
            ox, oz = line[-1]
            # 바깥 눈꼬리: 아래로 꺾이지 않고 옆으로 짧게 뻗는다 (이 키트의 고유 형태)
            line.append((ox + sgn * 0.0060 * sz, oz - 0.0010 * sz))
            line = line[self.LASH_SKIP:]
            nL = len(line)
            widths = [keys([(0.0, 0.0032), (0.15, 0.0062), (0.55, 0.0078), (0.88, 0.0090), (1.0, 0.0046)], i / (nL - 1)) * sz
                      for i in range(nL)]
            self._stroke(buf, line, widths, 0.0036, m["lash"], shift=0.32)
            # 아랫 속눈썹 (바깥쪽 짧은 선)
            if self.lower_lash:
                bl = self._botline
                nb = len(bl)
                seg = bl[int(nb * 0.45):int(nb * 0.85) + 1]
                pts = [(x, z - 0.0016 * sz) for x, z in seg]
                nn = len(pts)
                self._stroke(buf, pts, [0.0022 * sz * keys([(0, 0.35), (0.5, 1.0), (1, 0.35)], i / max(nn - 1, 1))
                                        for i in range(nn)], 0.0030, m["lash2"])
            # 눈썹
            bq = P["brow"]
            bl = bq["len"] * sz
            pts = []
            wds = []
            for i in range(7):
                s = -1 + 2 * i / 6
                u = s * bl / 2
                v = bq["dz"] * sz + bq["arch"] * sz * (1 - s * s) - math.tan(math.radians(bq["ang"])) * s * bl / 2
                pts.append((cx + side * (bq["dx"] * sz + u), cz + v))
                wds.append(bq["th"] * sz * self.brow_th * keys([(-1, 0.80), (-0.3, 1.0), (0.4, 0.9), (1, 0.40)], s))
            self._stroke(buf, pts, wds, 0.0016, m["brow"])
            # 볼터치
            bs = self.blush_size
            bx, bz = cx + side * 0.034 * sz, cz - 0.050 * sz
            # 볼 리그가 있으면 볼터치를 더 촘촘히 나눈다: 볼이 늘고 부풀 때 굽은 피부를 긴 현(弦)이 파고들지 않게
            if self.e.cheeks:
                self._fill(buf, ellipse2(bx, bz, 0.031 * sz * bs, 0.0175 * sz * bs, 28), 0.0009, m["blush"],
                           rings=(0.8, 0.6, 0.4, 0.2))
            else:
                self._fill(buf, ellipse2(bx, bz, 0.031 * sz * bs, 0.0175 * sz * bs, 20), 0.0009, m["blush"],
                           rings=(0.7, 0.4))
            for j in range(self.blush_lines):
                ox = (j - (self.blush_lines - 1) / 2) * 0.011 * sz * bs
                self._stroke(buf, [(bx + ox + 0.003 * sz, bz + 0.006 * sz), (bx + ox - 0.003 * sz, bz - 0.006 * sz)],
                             [0.0018 * sz, 0.0018 * sz], 0.0011, m["blush_l"])
        # 입
        mq = P["mouth"]
        mw = mq["w"] * sz / 2
        mz = self.ez - 0.074 * sz + mq["dz"] * sz
        n = 11
        top, bot = [], []
        for i in range(n):
            s = -1 + 2 * i / (n - 1)
            v = mq["curve"] * sz * s * s + mq["top_arch"] * sz * (1 - s * s)
            v += mq["wave"] * sz * math.sin(s * math.pi * 2.0)
            top.append((s * mw, mz + v))
            o = mq["open"] * sz * _sup(s, 1.6)
            bot.append((s * mw, mz + v - o - 0.0002))
        # 벌린 입 속 (빨강) + 혀
        poly = top + list(reversed(bot[1:-1]))
        poly = list(reversed(poly))
        self._fill(buf, poly, 0.0008, m["mouth"], rings=())
        tng = clip_to(ellipse2(0.0, mz - mq["open"] * sz * 0.85, mw * 0.55, max(mq["open"] * sz * 0.45, 0.0003), 14),
                      poly)
        self._fill(buf, tng, 0.0012, m["tongue"], rings=())
        # 입 선: 윗선(굵게) + 아랫선(가늘게)
        wl = [0.0026 * sz * keys([(0, 0.45), (0.2, 1.0), (0.8, 1.0), (1, 0.45)], i / (n - 1)) for i in range(n)]
        self._stroke(buf, top, wl, 0.0016, m["mline"])
        wl2 = [0.0016 * sz * keys([(0, 0.3), (0.3, 1.0), (0.7, 1.0), (1, 0.3)], i / (n - 1)) for i in range(n)]
        self._stroke(buf, bot, wl2, 0.0014, m["mline"])
        return buf


def _elf_face(self, **kw):
    """얼굴 만들기. 인자는 Face 참고 (eye_color, eye_size, eye_spacing, eye_height, lash, brow, blush, ...).
    셰이프 키: blink, serious, surprised, pained, smile, talk, talk_o, look_L, look_R, look_up, look_down
    (+ expr={'이름': {...}}로 추가) + 교정 키 blink_<표정>."""
    f = Face(self, **kw)
    ob = f.build()
    vc = vc_material(f"{self.name}_toon_vc", self.line)
    bake_vcol(ob)
    remap_to_vc(ob, vc)
    collapse_slots(ob)
    self.face_obj = ob
    self.face_builder = f
    return ob


Elf.face = _elf_face


# =========================================================================== hair (v2)

def catmull(pts, n):
    """제어점을 지나는 부드러운 곡선을 n점으로."""
    P = [V(p) for p in pts]
    if len(P) == 2:
        return [P[0].lerp(P[1], i / (n - 1)) for i in range(n)]
    P = [P[0] * 2 - P[1]] + P + [P[-1] * 2 - P[-2]]
    segs = len(P) - 3
    out = []
    for i in range(n):
        u = i / (n - 1) * segs
        k = min(int(u), segs - 1)
        t = u - k
        p0, p1, p2, p3 = P[k], P[k + 1], P[k + 2], P[k + 3]
        t2, t3 = t * t, t * t * t
        out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3))
    return out


def _rnd(i, seed=0.0):
    """결정적 의사난수 0~1 (같은 인자면 같은 값)."""
    x = math.sin(i * 12.9898 + seed * 78.233) * 43758.5453
    return x - math.floor(x)


def _wrap(a):
    """각도를 -180~180으로."""
    return (a + 180.0) % 360.0 - 180.0


def _tip(x, p=2.0):
    """끝만 모이는 폭 곡선: x=0에서 1, 대부분 유지하다 x=1에서 0."""
    x = clamp(x)
    return (1.0 - x ** p) ** (1.0 / p)


def lock_ring(c, A, B, w, th, segs, *, p=1.8, bend=0.35):
    """머리 다발 단면: 렌즈형(가장자리 얇고 가운데 두꺼움). bend>0이면 안쪽(−B)이 오목한 초승달."""
    out = []
    e = 2.0 / p
    for k in range(segs):
        a = 2 * math.pi * k / segs
        ca, sa = math.cos(a), math.sin(a)
        x = math.copysign(abs(ca) ** e, ca)
        y = math.copysign(abs(sa) ** e, sa)
        yy = y * th - bend * th * (1.0 - x * x)
        out.append(V(c) + A * (x * w) + B * yy)
    return out


SWEEP_WINDING = "outward"   # sweep()이 만드는 면의 법선 방향. 예전 면 뒤집기 우회 코드는 이 값을 보고 판단한다.


def sweep(buf, pts, width_fn, thick_fn, *, segs=10, ref=None, ref_fn=None, mat=None, w=None, bend=0.35, p=1.8,
          cap0="round"):
    """매끈한 머리 다발 볼륨: 곡선 pts(이미 촘촘한 점)를 따라 렌즈 단면을 쓸어낸다.
    width_fn(t)/thick_fn(t): 반폭/반두께(m). ref_fn(t)이나 ref: 넓은 면이 향할 방향(바깥). w: 웨이트 사전 또는 함수(t)."""
    n = len(pts)
    rings = []
    for i, q in enumerate(pts):
        t = i / (n - 1)
        tan = pts[min(i + 1, n - 1)] - pts[max(i - 1, 0)]
        tan = tan.normalized() if tan.length > 1e-9 else V((0, 0, -1))
        out = V(ref_fn(t) if ref_fn else (ref or (0, -1, 0)))
        out = out - tan * out.dot(tan)
        out = out.normalized() if out.length > 1e-6 else V((1, 0, 0))
        A = tan.cross(out).normalized()   # 폭 방향
        B = out                           # 두께 방향(바깥)
        ww = w(t) if callable(w) else (w or {"head": 1.0})
        wr, th = max(width_fn(t), 0.0004), max(thick_fn(t), 0.0003)
        rings.append([buf.vert(v, ww) for v in lock_ring(q, A, B, wr, th, segs, p=p, bend=bend)])
    # 면은 바깥을 보게 감는다 (A=접선×바깥 이라 링이 접선 기준 시계 방향 → 순서를 거꾸로 이어야 법선이 바깥).
    # 2026-11-01 이전에는 안쪽을 봐서 아웃라인 헐이 생기지 않았다 (SWEEP_WINDING 참고).
    for i in range(n - 1):
        r0, r1 = rings[i], rings[i + 1]
        for k in range(segs):
            k2 = (k + 1) % segs
            buf.face((r0[k], r1[k], r1[k2], r0[k2]), mat)
    # 끝: 마지막 링을 한 점으로 닫는다
    tip = buf.vert(sum((buf.v[i] for i in rings[-1]), V()) / segs, buf.w[rings[-1][0]])
    for k in range(segs):
        buf.face((tip, rings[-1][(k + 1) % segs], rings[-1][k]), mat)
    root = buf.vert(sum((buf.v[i] for i in rings[0]), V()) / segs - (pts[1] - pts[0]).normalized() * 0.004,
                    buf.w[rings[0][0]])
    for k in range(segs):
        buf.face((root, rings[0][k], rings[0][(k + 1) % segs]), mat)
    return rings


def _warn(msg):
    print(f"[elf] 경고: {msg}")


class Hair:
    """머리카락 v2: 매끈한 머리 덩어리(한 장의 셸)를 다발로 나누고, 다발은 끝 쪽에서만 갈라져 날렵하게 모인다.

    - 셸: 정수리에서 시작해 머리 표면을 따라 내려오고, 머리가 가장 넓은 곳에서부터는 아래로 떨어진다(긴 머리).
      다발끼리는 위쪽에서 한 면으로 이어져 있어 서로 파고들지 않는다 → 아웃라인 쐐기가 생기지 않는다.
    - 다발 경계에는 얕은 결 홈, 가르마에는 낮은 홈.
    - 속층(어두운 색, 아웃라인 없음)이 다발 사이 틈을 메운다.
    - 포니테일·트윈테일·땋은 머리·긴 머리는 흔들림 본 사슬과 부드러운 웨이트를 쓴다.

    사용: h = e.hair(color); h.cap(); h.bangs(); h.sides(); h.back(); (h.ponytail() 등). finalize()가 h.done()을 부른다.
    좌표 도우미 h.sp(az, el, off): 머리 표면 점 (az 0=정면, 90=왼쪽 / el 위로 +도).
    """

    def __init__(self, e: "Elf", color, *, dark=None, light=None, off=0.028, outline=0.0035, volume=1.0):
        self.e = e
        self.k = e.k
        self.color = color
        self.m = mat(f"{e.name}_hair", color)
        self.md = mat(f"{e.name}_hair_d", dark or shade(color, -0.30))
        self.ml = mat(f"{e.name}_hair_l", light or mix_hex(color, "#ffffff", 0.45))
        self.vol = off * self.k * volume
        self.off = self.vol   # v1 호환 (sp 기본 오프셋)
        self.outline = outline
        self.hl = (26.0, -12.0, -50.0)
        self.part = 0.0
        self.spec = {}
        self.buf = Buf()       # 바깥층 (셸 + 꼬리 + 바보털)
        self.buf_in = Buf()    # 속층 + 광택 (아웃라인 없음)
        self._T = None
        self._shines = []
        self._tails = []
        self._chains = {}

    # ------------------------------------------------------------------ 표면
    def _surf(self, az, el):
        a, b = math.radians(az), math.radians(el)
        return self.e._head_fn(math.cos(b) * math.sin(a), -math.cos(b) * math.cos(a), math.sin(b))

    def _surf_n(self, az, el):
        p = self._surf(az, el)
        if el > 88.0:
            return p, V((0, 0, 1))
        da = self._surf(az + 0.6, el) - self._surf(az - 0.6, el)
        de = self._surf(az, el + 0.6) - self._surf(az, el - 0.6)
        n = da.cross(de)
        if n.length < 1e-9:
            n = p - self.e.head_c
        n.normalize()
        if n.dot(p - self.e.head_c) < 0:
            n = -n
        return p, n

    def _volume(self, az, el):
        """머리 덩어리 두께(두피에서 바깥 면까지). 옆·뒤 가운데 높이에서 부풀어 SD 실루엣을 만든다."""
        sb = smoothstep(20.0, 85.0, abs(_wrap(az)))
        f = 0.86 + 0.55 * sb * math.exp(-((el - 4.0) / 40.0) ** 2) - 0.08 * smoothstep(60.0, 89.0, el)
        return self.vol * f

    def _drift(self, az):
        """긴 머리가 떨어지는 방향 보정 (y 성분): 옆머리는 앞으로(어깨 앞), 옆뒤는 뒤로(팔 뒤), 뒤는 살짝 뒤로."""
        a = abs(_wrap(az))
        fwd = -0.14 * smoothstep(40.0, 70.0, a) * (1 - smoothstep(88.0, 100.0, a))
        back = 0.16 * smoothstep(92.0, 112.0, a) * (1 - smoothstep(125.0, 150.0, a)) + 0.04 * smoothstep(140, 175, a)
        return fwd + back

    def _prep(self):
        if self._T is not None:
            return
        c = self.e.head_c
        n_az = 144
        self._daz = 360.0 / n_az
        els = [89.0 - 2.0 * j for j in range(70)]
        T = []
        for i in range(n_az):
            az = i * self._daz
            P, N = [], []
            for el in els:
                p, n = self._surf_n(az, el)
                P.append(p + n * self._volume(az, el))
                N.append(n)
            best = None
            for j, el in enumerate(els):
                if -40.0 <= el <= 12.0:
                    r = math.hypot(P[j].x - c.x, P[j].y - c.y)
                    if best is None or r > best[0] + 1e-6:
                        best = (r, j)
            jb = best[1]
            P, N = P[:jb + 1], N[:jb + 1]
            cum = [0.0]
            for a_, b_ in zip(P, P[1:]):
                cum.append(cum[-1] + (b_ - a_).length)
            rad = V((P[-1].x - c.x, P[-1].y - c.y, 0.0)).normalized()
            T.append({"P": P, "N": N, "cum": cum, "sb": cum[-1], "rad": rad, "drift": self._drift(az),
                      "elb": els[jb]})
        self._T = T
        self._els = els

    def _eval(self, L, s):
        if s <= L["sb"]:
            cum = L["cum"]
            lo, hi = 0, len(cum) - 1
            while hi - lo > 1:
                mid = (lo + hi) // 2
                if cum[mid] <= s:
                    lo = mid
                else:
                    hi = mid
            seg = cum[hi] - cum[lo]
            a = (s - cum[lo]) / seg if seg > 1e-9 else 0.0
            p = L["P"][lo].lerp(L["P"][hi], a)
            n = L["N"][lo].lerp(L["N"][hi], a)
            n = n.lerp(L["rad"], smoothstep(L["sb"] - 0.05 * self.k, L["sb"], s))
            return p, n.normalized()
        d = s - L["sb"]
        # 수직으로 떨어지며 살짝 벌어짐. 앞뒤 흐름(drift)은 6cm 아래부터 (단발이 기울지 않게)
        d2 = max(0.0, d - 0.06 * self.k)
        p = L["P"][-1] + V((0, 0, -d)) + L["rad"] * (0.06 * d) + V((0, L["drift"] * d2 * d2 / (d2 + 0.08 * self.k), 0))
        return p, L["rad"]

    def path(self, az, s, dv=0.0):
        """정수리에서 경도 az를 따라 길이 s만큼 내려간 머리 덩어리 바깥 면의 점과 법선."""
        self._prep()
        f = (az % 360.0) / self._daz
        i0 = int(math.floor(f)) % len(self._T)
        i1 = (i0 + 1) % len(self._T)
        t = f - math.floor(f)
        p0, n0 = self._eval(self._T[i0], s)
        p1, n1 = self._eval(self._T[i1], s)
        n = n0.lerp(n1, t).normalized()
        return p0.lerp(p1, t) + n * dv, n

    def s_break(self, az):
        self._prep()
        f = (az % 360.0) / self._daz
        i0 = int(math.floor(f)) % len(self._T)
        i1 = (i0 + 1) % len(self._T)
        return lerp(self._T[i0]["sb"], self._T[i1]["sb"], f - math.floor(f))

    def s_of_el(self, az, el):
        """경도 az에서 높이 el(도)까지의 길이. 머리가 가장 넓은 곳보다 아래면 수직 낙하 거리로 바꾼다."""
        self._prep()
        f = (az % 360.0) / self._daz
        i0 = int(round(f)) % len(self._T)
        L = self._T[i0]
        els = self._els
        if el >= L["elb"]:
            for j in range(len(L["cum"]) - 1):
                if els[j] >= el >= els[j + 1]:
                    a = (els[j] - el) / (els[j] - els[j + 1])
                    return lerp(L["cum"][j], L["cum"][j + 1], a)
            return 0.0
        zb = L["P"][-1].z
        z = self._surf(az, el).z
        return L["sb"] + max(0.0, zb - z)

    def sp(self, az, el, off=None):
        """머리 표면 점 (v1 호환): off는 두피에서 띄울 거리(m)."""
        p, n = self._surf_n(az, el)
        return p + n * (self.vol if off is None else off)

    def hairline(self, az):
        front, side, back = self.hl
        a = abs(_wrap(az - self.part * 0.0))
        return front + (side - front) * smoothstep(0, 95, a) + (back - side) * smoothstep(95, 180, a)

    # ------------------------------------------------------------------ 영역 지정 (v1 이름·인자 유지)
    def cap(self, *, front=26.0, side=-12.0, back=-50.0, part=0.0, segs=None, rows=None, volume=None):
        """머리선(앞·옆·뒤, 도)과 가르마 방위(도, 0=가운데). volume: 덩어리 두께 배율."""
        self.hl = (front, side, back)
        self.part = part
        self._res = (segs, rows)   # v2: 해상도 힌트 (작게 주면 성글게: 헬멧 아래 단역 등)
        if volume is not None:
            self.vol *= volume
            self.off = self.vol
            self._T = None
        self.spec["cap"] = True
        return self

    def bangs(self, *, n=7, spread=55.0, length=1.0, tip_el=5.0, width=None, part=None, sweep=0.0, curl=1.0,
              jag=0.25, thick=1.0, seed=0.0, mat=None, under_hat=None):
        """앞머리: n다발(5~9 권장). 가운데 큰 다발 1~2개 + 폭·길이가 다른 보조 다발. tip_el: 끝 높이(도, 0≈눈썹).
        length: 머리선에서 끝까지 길이 배율. sweep: 끝이 쓸리는 각(도). jag: 길이 변화 정도. width: v2에서는 무시.
        seed: 다발 폭·길이 변화의 씨앗. mat: 이 영역 머티리얼(브릿지·투톤 머리).
        under_hat: 모자·헬멧 아래용 뭉툭하고 둥근 끝 (None이면 e.helmet 등 모자가 있을 때 자동)."""
        if width is not None:
            _warn("bangs(width=)는 헤어 v2에서 무시된다 (다발 폭은 자동 변화). n, spread, seed로 조절한다")
        self.spec["bangs"] = dict(n=n, spread=spread, length=length, tip_el=tip_el, part=part, sweep=sweep,
                                  curl=curl, jag=jag, thick=thick, seed=seed, mat=mat, under_hat=under_hat)
        return self

    def sides(self, *, length=0.10, width=0.078, az=68.0, n=1, flare=None, curl=0.0, thick=1.0, puff=1.0,
              mat=None, left=None, right=None):
        """옆머리 (귀 앞, 얼굴선을 따라 내려옴). length: 턱선 아래로 더 내려오는 길이(m). width: 다발 폭(m).
        mat: 이 영역 머티리얼. left/right: 한쪽만 다르게 할 인자 사전 (예: right=dict(length=0.02, width=0.06)).
        flare는 v2에서 무시된다."""
        if flare is not None:
            _warn("sides(flare=)는 헤어 v2에서 무시된다. puff, curl로 조절한다")
        self.spec["sides"] = dict(length=length, width=width, az=az, n=n, curl=curl, thick=thick,
                                  puff=puff, mat=mat, left=dict(left or {}), right=dict(right or {}))
        return self

    def back(self, *, length=0.08, n=9, width=None, spread=88.0, flare=None, thick=1.0, layers=None, mat=None):
        """뒷머리: 목덜미 머리선 아래로 더 내려오는 길이(m, 0=단발). n은 홀수 권장.
        목덜미 머리선보다 0.10 넘게 내려오면 hair_back 흔들림 본(chest 자식). mat: 이 영역 머티리얼.
        width, flare, layers는 v2에서 무시된다."""
        for nm_, v_ in (("width", width), ("flare", flare), ("layers", layers)):
            if v_ is not None:
                _warn(f"back({nm_}=)는 헤어 v2에서 무시된다 (n, spread, length, thick로 조절)")
        self.spec["back"] = dict(length=length, n=max(3, n), spread=spread, thick=thick, mat=mat)
        return self

    # ------------------------------------------------------------------ 다발 배치
    def _locks(self):
        k = self.k
        L = []
        hl = self.hairline
        b = self.spec.get("bangs")
        if b:
            n = max(3, b["n"])
            part = self.part if b["part"] is None else b["part"]
            sp = b["spread"]
            c0 = part * 0.3
            ws = [0.75 + 0.5 * _rnd(i, n + b["seed"]) for i in range(n)]
            # 가르마에 가장 가까운 다발(과 이웃)을 크게: SD 앞머리의 '가운데 큰 다발'
            pos = [(-sp + 2 * sp * (i + 0.5) / n) + c0 for i in range(n)]
            ic = min(range(n), key=lambda i: abs(pos[i] - part))
            ws[ic] *= 1.65
            j2 = ic + (1 if part <= pos[ic] else -1)
            if 0 <= j2 < n:
                ws[j2] *= 1.25
            tot = sum(ws)
            a = -sp + c0
            hlf = hl(0.0)
            uh = b.get("under_hat")
            if uh is None:
                uh = bool(getattr(self.e, "_hats", []))
            for i in range(n):
                a1 = a + 2 * sp * ws[i] / tot
                u = ((a + a1) / 2 - c0) / sp
                big = ws[i] / (tot / n)
                tel = b["tip_el"] + 7.0 * u * u - 3.0 * (big - 1.0) + b["jag"] * 14.0 * (_rnd(i + 7, n) - 0.5)
                tel = hlf - (hlf - tel) * b["length"]
                ca = (a + a1) / 2
                Lk = self.s_of_el(ca, tel)
                shl = self.s_of_el(ca, hl(ca))
                lk = dict(a0=a, a1=a1, L=Lk, free=max(0.04 * k, (Lk - shl) * (0.72 + 0.22 * _rnd(i + 3, n)) + 0.03 * k),
                          sweep=b["sweep"] + 6.0 * u + 3.0 * (_rnd(i + 11, n) - 0.5),
                          curl=-0.007 * k * b["curl"], puff=0.002 * k, p=1.35 + 0.3 * _rnd(i + 5, n),
                          th=0.011 * k * b["thick"], region="front", bias=0.12 * (_rnd(i + 13, n) - 0.5),
                          mat=b.get("mat"))
                if uh:
                    # 모자 아래: 테 밑으로 끝만 보이므로 짧게 갈라지고 둥글고 두툼한 끝 (뾰족하게 읽히지 않게)
                    lk.update(free=max(0.025 * k, lk["free"] * 0.40), p=3.2, th=lk["th"] * 1.3, curl=lk["curl"] * 1.6,
                              sweep=lk["sweep"] * 0.5)
                L.append(lk)
                a = a1
        s0_ = self.spec.get("sides")
        if s0_:
            for sgn in (1, -1):
                s = dict(s0_)
                s.update(s0_["left"] if sgn > 0 else s0_["right"])
                cz = s["az"]
                wd = math.degrees(s["width"] * k / (self.e.hw / 2 + self.vol))
                nn = max(1, s["n"])
                for j in range(nn):
                    a0 = cz - wd / 2 + wd * j / nn
                    a1 = cz - wd / 2 + wd * (j + 1) / nn
                    ca = (a0 + a1) / 2
                    Lk = self.s_break(ca) + 0.05 * k + s["length"] * k * (1 - 0.18 * j)
                    shl = self.s_of_el(ca, hl(ca))
                    lk = dict(a0=a0, a1=a1, L=Lk, free=(Lk - shl) * 0.72, sweep=-3.0 - 2.0 * j,
                              curl=-(0.010 + 0.02 * s["curl"]) * k, puff=0.006 * k * s["puff"], p=1.6,
                              th=0.012 * k * s["thick"], region="side", bias=-0.08, mat=s.get("mat"))
                    if sgn < 0:
                        lk = dict(lk, a0=-a1, a1=-a0, sweep=-lk["sweep"], bias=-lk["bias"])
                    lk["side"] = "L" if sgn > 0 else "R"
                    L.append(lk)
        bk = self.spec.get("back")
        if bk:
            n = bk["n"]
            sp = bk["spread"]
            ws = [0.8 + 0.4 * _rnd(i + 21, n) for i in range(n)]
            ws[n // 2] *= 1.3
            tot = sum(ws)
            a = 180.0 - sp
            for i in range(n):
                a1 = a + 2 * sp * ws[i] / tot
                ca = (a + a1) / 2
                u = (ca - 180.0) / sp
                shl = max(self.s_of_el(ca, hl(ca)), self.s_break(ca))
                extra = 0.03 * k + bk["length"] * k * (1 - 0.15 * u * u) * (1 - 0.08 * (i % 2))
                Lk = shl + extra
                drop = Lk - self.s_break(ca)
                free = max(0.08 * k, min(drop * 0.32 + 0.06 * k, 0.20 * k, Lk * 0.5))
                L.append(dict(a0=a, a1=a1, L=Lk, free=free, sweep=4.0 * u + 3.0 * (_rnd(i + 17, n) - 0.5),
                              curl=(-0.010 if bk["length"] < 0.12 else 0.004) * k, puff=0.004 * k,
                              p=1.45 + 0.3 * _rnd(i + 23, n),
                              th=0.012 * k * bk["thick"], region="back", bias=0.1 * (_rnd(i + 19, n) - 0.5),
                              mat=bk.get("mat")))
                a = a1
        # 정렬 (정면 0 기준 -180~180) → 겹침 정리 → 빈 곳은 머리선까지 오는 짧은 다발로 채움
        for lk in L:
            sh = _wrap((lk["a0"] + lk["a1"]) / 2) - (lk["a0"] + lk["a1"]) / 2
            lk["a0"] += sh
            lk["a1"] += sh
        L.sort(key=lambda d: d["a0"])
        out = []
        for lk in L:
            if out and lk["a0"] < out[-1]["a1"]:
                lk["a0"] = out[-1]["a1"]
            if lk["a1"] - lk["a0"] > 2.0:
                out.append(lk)
        filled = []
        start = out[0]["a0"] if out else -180.0
        cur = start
        seq = out + [dict(a0=start + 360.0)]
        for lk in seq:
            gap = lk["a0"] - cur
            if 0.0 < gap <= 8.0 and filled:
                # 좁은 틈은 짧은 조각을 만들지 않고 이웃 다발을 넓혀 메운다 (관자놀이의 작은 갈고리 방지)
                filled[-1]["a1"] += gap / 2
                if "L" in lk:
                    lk["a0"] -= gap / 2
                gap = 0.0
                cur = filled[-1]["a1"]
            if gap > 1.0:
                m = max(1, int(math.ceil(gap / 26.0)))
                for j in range(m):
                    a0 = cur + gap * j / m
                    a1 = cur + gap * (j + 1) / m
                    ca = (a0 + a1) / 2
                    Lk = max(self.s_of_el(ca, hl(ca)), 0.05 * k)
                    filled.append(dict(a0=a0, a1=a1, L=Lk, free=min(0.05 * k, Lk * 0.3), sweep=0.0,
                                       curl=-0.004 * k, puff=0.0, p=2.0, th=0.010 * k, region="fill", bias=0.0))
            if "L" in lk:
                filled.append(lk)
                cur = lk["a1"]
        return filled

    # ------------------------------------------------------------------ 흔들림 본
    def _make_chains(self, locks):
        e, k = self.e, self.k
        back = [lk for lk in locks if lk["region"] == "back"]
        mx = max((lk["L"] - self.s_break((lk["a0"] + lk["a1"]) / 2) for lk in back), default=0.0)
        # 흔들림 본은 목덜미 머리선보다 0.10 넘게 내려오는 '긴 머리'일 때만 (단발에는 만들지 않는다)
        below = max((lk["L"] - max(self.s_break((lk["a0"] + lk["a1"]) / 2),
                                   self.s_of_el((lk["a0"] + lk["a1"]) / 2, self.hairline((lk["a0"] + lk["a1"]) / 2)))
                     for lk in back), default=0.0)
        if below > 0.10 * k and "back" not in self._chains:
            sb = self.s_break(180.0)
            nb = 2 if mx < 0.3 * k else 3
            pts = [self.path(180.0, sb + mx * i / nb, -self.vol * 0.6)[0] for i in range(nb + 1)]
            names = []
            prev = "chest"
            for i in range(nb):
                nm = f"hair_back_{i + 1:02d}"
                e.add_bone(nm, pts[i], pts[i + 1], prev)
                names.append(nm)
                prev = nm
            self._chains["back"] = (Chain(pts, names), mx)
        sides = [lk for lk in locks if lk["region"] == "side"]
        dmax = max((lk["L"] - self.s_break((lk["a0"] + lk["a1"]) / 2) for lk in sides), default=0.0)
        for lk in sides:
            ca = (lk["a0"] + lk["a1"]) / 2
            d = lk["L"] - self.s_break(ca)
            key = "side_" + lk["side"]
            # 좌우 대칭으로 결정 (한쪽만 문턱을 넘는 일이 없게 가장 긴 옆머리 기준)
            if dmax > 0.14 * k and key not in self._chains:
                sb = self.s_break(ca)
                pts = [self.path(ca, sb + d * i / 2, -self.vol * 0.5)[0] for i in range(3)]
                names = []
                prev = "chest"
                for i in range(2):
                    nm = f"hair_side_{lk['side']}_{i + 1:02d}"
                    e.add_bone(nm, pts[i], pts[i + 1], prev)
                    names.append(nm)
                    prev = nm
                self._chains[key] = (Chain(pts, names), d)

    def _w(self, lk, az, s):
        k = self.k
        key = "back" if lk["region"] == "back" else ("side_" + lk.get("side", "")) if lk["region"] == "side" else None
        if key not in self._chains:
            return {"head": 1.0}
        ch, ln = self._chains[key]
        d = s - self.s_break(az)
        if d < -0.02 * k:
            return {"head": 1.0}
        w = ch.weights(clamp(d / ln))
        return mixw({"head": 1.0}, w, smoothstep(-0.02 * k, 0.07 * k, d))

    # ------------------------------------------------------------------ 셸
    def _groove(self, az, s, bounds):
        k = self.k
        g = 0.0
        shl = self.s_of_el(self.part, self.hl[0])
        if "bangs" in self.spec or self.spec.get("cap"):
            da = _wrap(az - self.part)
            g += self.vol * 0.30 * math.exp(-(da / 3.2) ** 2) * smoothstep(0.02 * k, 0.07 * k, s) * \
                (1 - smoothstep(shl - 0.05 * k, shl + 0.01 * k, s))
        for (ba, S) in bounds:
            da = _wrap(az - ba)
            if abs(da) < 8.0:
                g += self.vol * 0.14 * math.exp(-(da / 2.4) ** 2) * smoothstep(S * 0.35, S * 0.85, s)
        return g

    def _shell(self):
        k = self.k
        q = self.e.q
        locks = self._locks()
        self._make_chains(locks)
        nL = len(locks)
        # 경계별 갈라짐 시작 길이
        S = []
        for j in range(nL):
            p_, q_ = locks[j - 1], locks[j]
            sj = max(p_["L"] - p_["free"], q_["L"] - q_["free"])
            sj = min(sj, min(p_["L"], q_["L"]) - 0.012 * k)
            S.append(max(sj, 0.03 * k))
        bounds = [(locks[j]["a0"], S[j]) for j in range(nL)]
        # 공통 행
        smax = max(max(S[j], S[(j + 1) % nL]) for j in range(nL))
        rows = [0.0]
        ds1, ds2 = 0.030 * k / q, 0.05 * k / q
        if getattr(self, "_res", (None, None))[1]:
            ds1 *= clamp(8.0 / self._res[1], 1.0, 1.8)
        s_ = 0.0
        while s_ < smax:
            s_ += ds1 if s_ < 0.40 * k else ds2
            rows.append(s_)
        rows = sorted(set(round(x, 6) for x in rows + S))
        buf = self.buf
        crown = buf.vert(self.path(0.0, 0.0)[0], {"head": 1.0})
        segs_h, rows_h = getattr(self, "_res", (None, None))
        col_deg = 9.5 / q
        if segs_h:
            col_deg = max(col_deg, min(16.0, 360.0 / (segs_h * 1.4)))

        def quad(a, b, c_, d, nref, m):
            pa, pb, pc = buf.v[a], buf.v[b], buf.v[c_]
            nn = (pb - pa).cross(pc - pa)
            if nn.length < 1e-12:
                pd = buf.v[d]
                nn = (pc - pa).cross(pd - pa)
            if nn.dot(nref) < 0:
                buf.face((d, c_, b, a), m)
            else:
                buf.face((a, b, c_, d), m)

        def tri(a, b, c_, nref, m):
            nn = (buf.v[b] - buf.v[a]).cross(buf.v[c_] - buf.v[a])
            buf.face((a, b, c_) if nn.dot(nref) >= 0 else (c_, b, a), m)

        for j, lk in enumerate(locks):
            SL, SR = S[j], S[(j + 1) % nL]
            Lk = lk["L"]
            smx = max(SL, SR)
            own = max(5, min(9, int((Lk - smx) / (0.024 * k / q)) + 2))
            rr = [r for r in rows if r < smx - 1e-6] + [smx] + [lerp(smx, Lk, i / (own - 1)) for i in range(1, own)]
            ncol = max(2, int(round((lk["a1"] - lk["a0"]) / col_deg)))
            ca = lerp(lk["a0"], lk["a1"], 0.5 + lk.get("bias", 0.0))
            s_in = max(0.02 * k, min(SL, SR, self.s_break(ca)) - 0.05 * k)
            grid_o, grid_i, nrm = [], [], []
            for r, s in enumerate(rr):
                ro, ri, rn = [], [], []
                if r == 0:
                    grid_o.append([crown] * (ncol + 1))
                    grid_i.append([None] * (ncol + 1))
                    nrm.append([V((0, 0, 1))] * (ncol + 1))
                    continue
                tip = s >= Lk - 1e-7
                tip_idx = None
                for i in range(ncol + 1):
                    f = i / ncol
                    A = lerp(lk["a0"], lk["a1"], f)
                    Sf = lerp(SL, SR, smooth01(f))
                    x = clamp((s - Sf) / max(Lk - Sf, 1e-6)) if s > Sf else 0.0
                    sq = _tip(x, lk["p"])
                    az = ca + (A - ca) * sq + lk["sweep"] * x ** 1.5
                    base, n = self.path(az, s)
                    nf = lk["curl"] * x * x + lk["puff"] * math.sin(math.pi * x)
                    o = base + n * (nf - self._groove(az, s, bounds))
                    th = lk["th"] * (1.0 - x ** 2.6) ** 0.55
                    w = self._w(lk, az, s)
                    if tip:
                        if tip_idx is None:
                            tip_idx = buf.vert(o, w)
                        ro.append(tip_idx)
                        ri.append(tip_idx)
                    else:
                        ro.append(buf.vert(o, w))
                        ri.append(buf.vert(o - n * th, w) if s >= s_in else None)
                    rn.append(n)
                grid_o.append(ro)
                grid_i.append(ri)
                nrm.append(rn)
            m = lk.get("mat") or self.m
            for r in range(len(rr) - 1):
                for i in range(ncol):
                    nref = nrm[r + 1][i]
                    a, b_, c_, d = grid_o[r][i], grid_o[r][i + 1], grid_o[r + 1][i + 1], grid_o[r + 1][i]
                    if r == 0:
                        tri(a, c_, d, nref, m)
                    elif c_ == d:
                        tri(a, b_, c_, nref, m)
                    else:
                        quad(a, b_, c_, d, nref, m)
                    ia, ib, ic, idd = grid_i[r][i], grid_i[r][i + 1], grid_i[r + 1][i + 1], grid_i[r + 1][i]
                    if None not in (ia, ib, ic, idd):
                        if ic == idd:
                            tri(ia, ib, ic, -nref, m)
                        else:
                            quad(ia, ib, ic, idd, -nref, m)
                # 갈라진 옆면 (두께)
                for side_i, Sx, sgn in ((0, SL, -1), (ncol, SR, 1)):
                    if rr[r + 1] <= Sx + 1e-7:
                        continue
                    oa, ob = grid_o[r][side_i], grid_o[r + 1][side_i]
                    ia, ib = grid_i[r][side_i], grid_i[r + 1][side_i]
                    if ia is None or ib is None:
                        continue
                    nb_i = side_i + (1 if side_i == 0 else -1)
                    out_dir = buf.v[oa] - buf.v[grid_o[r][nb_i]] if r > 0 else V((0, 0, 0))
                    if out_dir.length < 1e-9:
                        out_dir = buf.v[ob] - buf.v[grid_o[r + 1][nb_i]]
                    if ob == ib:
                        tri(oa, ob, ia, out_dir, m)
                    else:
                        quad(oa, ob, ib, ia, out_dir, m)
        self._locks_built = locks
        self._S = S
        return locks

    def _under(self, locks):
        """속층: 다발 사이 틈을 메우는 어두운 매끈한 덮개 (아웃라인 없음)."""
        k = self.k
        q = self.e.q
        buf = self.buf_in
        ncol = max(20, int(32 * q))
        hl = self.hairline

        def length_at(az):
            best = None
            for lk in locks:
                for sh in (0.0, 360.0, -360.0):
                    if lk["a0"] + sh <= az <= lk["a1"] + sh:
                        best = lk
            shl = self.s_of_el(az, hl(az))
            if best is None:
                return shl
            lo = best["L"] - 0.015 * k             # 바깥층보다 길면 안 된다
            if best["region"] == "back" and best["L"] - self.s_break(az) > 0.10 * k:
                return min(lo, best["L"] - best["free"] * 0.55)   # 긴 머리: 틈 뒤를 메우는 커튼
            if best["region"] == "front":
                return min(shl, lo)
            return min(shl, lo)

        lens = [length_at(360.0 * i / ncol - 180.0) for i in range(ncol)]
        lens = [(lens[i - 1] + 2 * lens[i] + lens[(i + 1) % ncol]) / 4 for i in range(ncol)]
        nr = max(7, int(11 * q))
        crown = buf.vert(self.path(0.0, 0.0, -self.vol * 0.35)[0], {"head": 1.0})
        cols = []
        for i in range(ncol):
            az = 360.0 * i / ncol - 180.0
            col = [crown]
            for r in range(1, nr + 1):
                s = lens[i] * r / nr
                p, n = self.path(az, s, -self.vol * (0.35 + 0.25 * smoothstep(0.0, 1.0, r / nr)))
                lk = {"region": "back"} if abs(_wrap(az)) > 100 else {"region": "fill"}
                col.append(buf.vert(p, self._w(lk, az, s)))
            cols.append(col)
        for i in range(ncol):
            c0, c1 = cols[i], cols[(i + 1) % ncol]
            for r in range(nr):
                if r == 0:
                    buf.face((c0[0], c1[1], c0[1]), self.md)
                else:
                    buf.face((c0[r], c1[r], c1[r + 1], c0[r + 1]), self.md)

    # ------------------------------------------------------------------ 꼬리·덧머리
    def strand(self, pts, width, thick=None, *, n=14, segs=10, taper=None, mat=None, p=1.8, w=None, flat=0.0,
               cap0="round", normal=None, bend=0.35):
        """임의 다발 하나: 제어점 pts를 지나는 매끈한 렌즈 단면 볼륨. width/thick: 전체 폭/두께(m).
        taper: [(t, 배율)] (기본: 뿌리 살짝 좁고, 대부분 유지, 끝에서만 모임). normal: 넓은 면 방향."""
        e = self.e
        n = max(10, int(round(n * e.q)))
        segs = max(8, int(round(segs * e.q)) // 2 * 2)
        P = catmull(pts, n)
        thick = thick if thick is not None else width * 0.42

        def prof(t):
            if taper:
                return keys(taper, t)
            return keys([(0.0, 0.78), (0.15, 1.0), (0.55, 1.0)], min(t, 0.55)) * _tip((t - 0.55) / 0.45, 2.0)

        c = e.head_c

        def ref_fn(t):
            if normal is not None:
                return normal
            qq = P[min(int(t * (n - 1)), n - 1)]
            d = V((qq.x - c.x, qq.y - c.y, max(qq.z - c.z, 0.0)))
            return d if d.length > 1e-6 else V((0, -1, 0))
        sweep(self.buf, P, lambda t: width / 2 * prof(t), lambda t: thick / 2 * max(prof(t), 0.2), segs=segs,
              ref_fn=ref_fn, mat=mat or self.m, w=w, bend=bend, p=p)
        return self

    def _tail(self, az, el, *, length, width, droop, clumps, prefix, tie, out=1.0, lift=1.0, curve=1.0,
              thick=None):
        """묶은 꼬리 하나 : 굵은 한 덩어리 몸통이 묶은 자리에서 모였다가 부풀고, S자로 늘어지다
        끝에서만 clumps갈래로 갈라진다. lift: 머리에서 튀어나오는 정도, curve: S자 휨 정도(0=곧게)."""
        e, k = self.e, self.k
        q = self.e.q
        s0 = self.s_of_el(az, el)
        base, n = self.path(az, s0)
        n_h = V((n.x, n.y, 0.0))
        n_h = n_h.normalized() if n_h.length > 1e-6 else V((0, 1, 0))
        side = V((0, 0, 1)).cross(n_h).normalized()
        L = length
        o = out * lift
        c = curve
        dn = V((0, 0, -1))
        ctrl = [base - n * 0.02 * k,
                base + n * 0.045 * k * o + V((0, 0, 0.012 * k)),
                base + n_h * (0.10 * k * o) + dn * (L * 0.20),
                base + n_h * (0.10 * k * o + 0.03 * k * droop * c) + dn * (L * 0.50) + side * (0.025 * k * c),
                base + n_h * (0.08 * k * o) + dn * (L * 0.78) - side * (0.012 * k * c),
                base + n_h * (0.06 * k * o) + dn * L + side * (0.03 * k * c)]
        P = catmull(ctrl, 120)
        cum = [0.0]
        for a_, b_ in zip(P, P[1:]):
            cum.append(cum[-1] + (b_ - a_).length)
        tot = cum[-1]

        def at(t):
            sv = clamp(t) * tot
            lo, hi = 0, len(cum) - 1
            while hi - lo > 1:
                mid = (lo + hi) // 2
                if cum[mid] <= sv:
                    lo = mid
                else:
                    hi = mid
            seg = cum[hi] - cum[lo]
            a = (sv - cum[lo]) / seg if seg > 1e-9 else 0.0
            return P[lo].lerp(P[hi], a), (P[hi] - P[lo]).normalized()

        chain = None
        t_tie = 0.07
        if prefix:
            js = [at(t_tie)[0], at(0.5)[0], at(1.0)[0]]
            nm = [f"{prefix}_01", f"{prefix}_02"]
            e.add_bone(nm[0], js[0], js[1], "head")
            e.add_bone(nm[1], js[1], js[2], nm[0])
            chain = Chain([ctrl[0]] + js, ["head"] + nm, blend=0.4)

        def wf(t):
            return chain.weights(t) if chain else {"head": 1.0}
        th = thick if thick is not None else width * 0.80
        root, puff, hold, body_end = 0.55, 0.22, 0.55, 0.90

        def prof(t):
            r = root if t <= t_tie else lerp(root, 1.0, smoothstep(t_tie, puff, t))
            x = (t - hold) / (body_end - hold)
            return r * (_tip(x, 2.0) if x > 0 else 1.0)
        nn = max(12, int(16 * max(q, 0.75)))
        segs = max(8, int(10 * q) // 2 * 2)
        ts = [body_end * i / (nn - 1) for i in range(nn)]
        sweep(self.buf, [at(t)[0] for t in ts], lambda u: width / 2 * prof(u * body_end),
              lambda u: th / 2 * max(prof(u * body_end), 0.22), segs=segs, ref=tuple(n_h), mat=self.m,
              w=lambda u: wf(u * body_end), bend=0.15)
        # 끝 갈래: 몸통 안에서 시작해 폭 방향으로 벌어지며 길이를 달리해 끝난다
        ends = max(1, clumps + 1) if clumps > 1 else 1
        if ends > 1:
            split, spread, end_w = 0.60, 0.55, 0.48
            lens = (1.0, 0.93, 0.87, 0.82)
            for i in range(ends):
                u_i = (i - (ends - 1) / 2) / ((ends - 1) / 2)
                te = lens[i % len(lens)]
                ts_ = split - 0.18
                m_ = max(8, nn // 2)
                tt = [lerp(ts_, te, j / (m_ - 1)) for j in range(m_)]
                Pi = []
                for t in tt:
                    cc, T = at(t)
                    A = T.cross(n_h).normalized()
                    a = smoothstep(ts_, te, t) ** 1.3
                    Pi.append(cc + A * (u_i * spread * width * 0.5 * a) + n_h * (th * 0.04 * (1 - abs(u_i)) * a))
                ln = te - ts_

                def eprof(u, ln=ln, ts_=ts_):
                    t = ts_ + u * ln
                    r = lerp(0.62, 1.0, smoothstep(ts_, split + 0.04, t))
                    return r * _tip((u - 0.40) / 0.60, 2.0) if u > 0.40 else r
                sweep(self.buf, Pi, lambda u, eprof=eprof: end_w * width / 2 * eprof(u),
                      lambda u, eprof=eprof: end_w * th / 2 * 1.05 * max(eprof(u), 0.25), segs=max(6, segs - 2),
                      ref=tuple(n_h), mat=self.m, w=lambda u, ln=ln, ts_=ts_: wf(ts_ + u * ln), bend=0.15)
        # 묶음 띠: 묶은 자리의 실제 굵기보다 조금 크게 (뿌리에 묻히지 않게)
        cc, T = at(t_tie)
        A = T.cross(n_h).normalized()
        hw = width / 2 * prof(t_tie) * 1.12
        hth = th / 2 * max(prof(t_tie), 0.22) * 1.25
        band(self.buf, cc, T, A, hw, hth, 0.022 * k, 0.007 * k, segs=16, mat=tie or self.md, w=wf(t_tie))

    def ponytail(self, *, height=34.0, length=0.30, width=0.115, clumps=2, droop=0.3, bones=True, tie=None,
                 lift=1.0, curve=1.0, thick=None):
        """포니테일 (SD 비율로 굵게). height: 묶는 높이(도), length: 꼬리 길이(m), width: 가장 굵은 폭(m).
        clumps≥2면 끝이 clumps+1갈래로 갈라진다. lift: 튀어나오는 정도(1=기본), curve: S자 휨(0=곧게).
        bones=True면 hair_tail_01/02."""
        self._tails.append(lambda: self._tail(180.0, height, length=length * self.k, width=width * self.k,
                                              droop=droop, clumps=max(1, clumps),
                                              prefix="hair_tail" if bones else None, tie=tie, out=1.25, lift=lift,
                                              curve=curve, thick=None if thick is None else thick * self.k))
        return self

    def twintails(self, *, height=30.0, az=125.0, length=0.30, width=0.10, clumps=2, droop=0.6, bones=True,
                  tie=None, lift=1.0, curve=1.0, thick=None):
        """트윈테일 (양옆 뒤). lift/curve는 ponytail과 같다. bones=True면 hair_tail_L_01/02, hair_tail_R_01/02."""
        for sd, sg in (("L", 1), ("R", -1)):
            self._tails.append(lambda sd=sd, sg=sg: self._tail(sg * az, height, length=length * self.k,
                                                               width=width * self.k, droop=droop,
                                                               clumps=max(1, clumps),
                                                               prefix=f"hair_tail_{sd}" if bones else None, tie=tie,
                                                               out=1.0, lift=lift, curve=curve,
                                                               thick=None if thick is None else thick * self.k))
        return self

    def braid(self, *, side=1, az=110.0, el=-25.0, length=0.30, width=0.05, beads=8, tie=None, bones=True,
              tilt=32.0, tuft=0.04):
        """땋은 머리: 경로를 따라 납작한 마디를 좌우로 번갈아 기울여 50% 겹친 연속 볼륨 + 본 사슬(hair_braid_L/R).
        beads: 마디 수(위아래 합), length: 길이(m)."""
        self._tails.append(lambda: self._braid(side, az, el, length * self.k, width * self.k, beads, tie, bones,
                                               tilt, tuft * self.k))
        return self

    def _braid(self, side, az, el, length, width, beads, tie, bones, tilt, tuft):
        e, k = self.e, self.k
        a = side * az
        base, n = self.path(a, self.s_of_el(a, el))
        n_h = V((n.x, n.y, 0.0)).normalized()
        ctrl = [base - n * 0.01 * k, base + n_h * 0.02 * k + V((0, 0, -length * 0.15)),
                base + n_h * 0.03 * k + V((0, 0, -length * 0.55)), base + n_h * 0.03 * k + V((0, 0, -length))]
        P = catmull(ctrl, 60)
        cum = [0.0]
        for p0, p1 in zip(P, P[1:]):
            cum.append(cum[-1] + (p1 - p0).length)
        tot = cum[-1]

        def at(t):
            s = clamp(t) * tot
            for i in range(len(cum) - 1):
                if s <= cum[i + 1] or i == len(cum) - 2:
                    seg = cum[i + 1] - cum[i]
                    u = (s - cum[i]) / seg if seg > 1e-9 else 0.0
                    return P[i].lerp(P[i + 1], clamp(u)), (P[i + 1] - P[i]).normalized()
            return P[-1], (P[-1] - P[-2]).normalized()
        chain = None
        sd = "L" if side > 0 else "R"
        if bones:
            js = [at(i / 3)[0] for i in range(4)]
            names = [f"hair_braid_{sd}_{i + 1:02d}" for i in range(3)]
            prev = "head"
            for i in range(3):
                e.add_bone(names[i], js[i], js[i + 1], prev)
                prev = names[i]
            chain = Chain(js, names, start={"head": 1.0}, start_blend=0.5)
        tie_at = 0.88
        sp = tie_at * tot / beads
        F = n_h
        q = self.e.q
        for i in range(beads):
            t = (i + 0.5) * sp / tot
            c, T = at(t)
            Fv = (F - T * F.dot(T)).normalized()
            S = T.cross(Fv).normalized()
            sg = 1 if i % 2 == 0 else -1
            w = lerp(width, width * 0.7, t)
            th = math.radians(-sg * tilt)
            Ax = (T * math.cos(th) + S * math.sin(th)).normalized()
            cen = c + S * (sg * 0.15 * w)
            ww = chain.weights(t) if chain else {"head": 1.0}
            # 납작한 타원체 마디 (길이 = 간격의 2배 → 이웃과 반씩 겹침)
            st = []
            nr = max(5, int(6 * q))
            for r in range(nr):
                u = -1 + 2 * r / (nr - 1)
                rad = math.sqrt(max(0.0, 1 - u * u))
                st.append({"c": cen + Ax * (u * sp * 1.05), "rx": max(0.44 * w * rad, 0.0006),
                           "ry": max(0.30 * w * rad, 0.0005), "w": ww, "ref": tuple(S)})
            loft(self.buf, st, segs=max(8, int(8 * q)), cap0="flat", cap1="flat", mat=self.m)
        c, T = at(tie_at)
        ww = chain.weights(tie_at) if chain else {"head": 1.0}
        Fv = (F - T * F.dot(T)).normalized()
        band(self.buf, c, T, Fv, 0.30 * width * 0.7, 0.22 * width * 0.7, 0.012 * k, 0.004 * k, segs=12,
             mat=tie or self.md, w=ww)
        if tuft:
            S = T.cross(Fv).normalized()
            ctrl_t = [c - T * 0.004 * k, c + T * tuft * 0.55 + S * 0.004 * k, c + T * tuft + S * 0.008 * k]
            self.strand(ctrl_t, width * 0.6, width * 0.35, w=ww, normal=tuple(Fv), n=10, segs=8)

    def ahoge(self, *, az=10.0, height=0.07, curl=1.0, width=0.016):
        """바보털 (정수리에서 솟아 S자로 휜 한 가닥)."""
        k = self.k
        s0 = 0.02 * k
        root, n = self.path(az, s0, -0.004 * k)
        side = V((math.cos(math.radians(az)), math.sin(math.radians(az)), 0))
        p1 = root + n * height * 0.55 * k + side * 0.01 * k
        p2 = p1 + n * height * 0.35 * k + side * 0.035 * k * curl
        p3 = p2 - n * height * 0.12 * k + side * 0.03 * k * curl
        self.strand([root, p1, p2, p3], width * k, width * 0.55 * k, n=14, segs=8,
                    taper=[(0, 1.0), (0.4, 0.9), (0.75, 0.6), (1, 0.0)], normal=tuple(-side))
        return self

    def bun(self, *, az=180.0, el=35.0, size=0.06):
        """올림머리 경단 (매끈한 타원체)."""
        k = self.k
        s0 = self.s_of_el(az, el)
        base, n = self.path(az, s0)
        c = base + n * size * 0.32 * k
        st = []
        for r in range(9):
            u = -1 + 2 * r / 8
            rad = math.sqrt(max(0.0, 1 - u * u))
            st.append({"c": c + n * (u * size * 0.45 * k), "rx": max(size * 0.52 * k * rad, 0.0006),
                       "ry": max(size * 0.5 * k * rad, 0.0006), "w": {"head": 1.0}, "ref": (0, 0, 1)})
        loft(self.buf, st, segs=14, cap0="flat", cap1="flat", mat=self.m)
        return self

    def shine(self, *, el=50.0, spread=74.0, n=2, size=1.35):
        """정수리 광택: 머리 곡면에 붙은 둥근 밝은 조각 . 아웃라인 없음."""
        self._shines.append(dict(el=el, spread=spread, n=n, size=size))
        return self

    def _shine_geo(self):
        k = self.k
        for sp_ in self._shines:
            n = max(1, sp_["n"])
            for i in range(n):
                u = (i / max(n - 1, 1)) * 2 - 1 if n > 1 else 0.0
                az = u * sp_["spread"] * 0.5 + self.part * 0.5
                s_c = self.s_of_el(az, sp_["el"])
                ra, rs = 10.0 * sp_["size"], 0.032 * k * sp_["size"]
                m = 18
                ring = []
                for j in range(m):
                    t = 2 * math.pi * j / m
                    da = ra * math.cos(t) * (1 - 0.25 * math.sin(t))
                    dsv = rs * math.sin(t)
                    p, nn = self.path(az + da, s_c + dsv, 0.0025 * k)
                    ring.append(self.buf_in.vert(p, {"head": 1.0}))
                pc, _ = self.path(az, s_c, 0.0028 * k)
                ci = self.buf_in.vert(pc, {"head": 1.0})
                nref = self.path(az, s_c)[1]
                for j in range(m):
                    a_, b_ = ring[j], ring[(j + 1) % m]
                    nn = (self.buf_in.v[b_] - self.buf_in.v[a_]).cross(self.buf_in.v[ci] - self.buf_in.v[a_])
                    self.buf_in.face((a_, b_, ci) if nn.dot(nref) >= 0 else (ci, b_, a_), self.ml)

    # ------------------------------------------------------------------ 헬멧 아래 누르기
    def squash(self, off, rim_el, margin=0.7, bufs=None, skip=None):
        """모자·헬멧(off, rim_el(az)) 안쪽으로 머리카락을 눌러 넣는다.
        겉면(buf)은 off×margin, 속층(buf_in)은 그보다 깊게(off×margin×0.55) 눌러 겉면 아래에 머문다
        (같은 깊이면 모자 띠 아래로 어두운 점이 비친다). skip=(i0, i1): 누르지 않을 겉면 정점 범위(꼬리 뿌리)."""
        e = self.e
        c = e.head_c
        if bufs is None:
            bufs = ((self.buf, margin, 1.2), (self.buf_in, margin * 0.55, 0.7))
        else:
            bufs = tuple((bf, margin, 1.2) for bf in bufs)
        for bf, mg, outer in bufs:
            lim = off * mg
            for i, q in enumerate(bf.v):
                if skip and bf is self.buf and skip[0] <= i < skip[1]:
                    continue
                d = q - c
                if d.length < 1e-6:
                    continue
                az = math.degrees(math.atan2(d.x, -d.y))
                el = math.degrees(math.asin(clamp(d.z / d.length, -1, 1)))
                r_el = rim_el(az)
                if el < r_el - 6:
                    continue
                sp, n = e.head_point(az, el, 0.0)
                dist = (q - sp).dot(n)
                fade = smoothstep(r_el - 6, r_el + 2, el)
                cap_d = lerp(off * outer, lim, fade)
                if dist > cap_d:
                    bf.v[i] = q - n * (dist - cap_d)

    # ------------------------------------------------------------------ 완성
    def done(self, name=None):
        """셸·속층·꼬리를 만들어 등록한다 (finalize가 자동으로 부른다)."""
        if getattr(self, "_done", False):
            return None
        self._done = True
        locks = self._shell()
        self._under(locks)
        t0 = len(self.buf.v)
        for fn in self._tails:
            fn()
        t1 = len(self.buf.v)
        self._shine_geo()
        for off, rim_el in getattr(self.e, "_hats", []):
            self.squash(off, rim_el, skip=(t0, t1))   # 꼬리·묶음 띠는 누르지 않는다
        nm = name or f"{self.e.name}_hair"
        ob = self.buf.obj(nm)
        _weld(ob, 2e-5)
        self.e.add(ob, group="head", tag="hair", node="hair", props={"outline": self.outline})
        if self.buf_in.v:
            ob2 = self.buf_in.obj(nm + "_in")
            _weld(ob2, 2e-5)
            self.e.add(ob2, group="head", tag="hair_in", node="hair_in", props={"noOutline": 1})
        return ob


def _weld(ob, dist):
    """겹친 정점 합치기 (다발 경계, 정수리). 웨이트는 정점마다 같으므로 그대로 유지된다."""
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=dist)
    bmesh.ops.dissolve_degenerate(bm, edges=bm.edges, dist=dist * 0.5)
    bm.to_mesh(ob.data)
    bm.free()
    ob.data.update()
    cb.smooth(ob, angle=180)


def _elf_hair(self, color, **kw):
    """머리카락 도구 시작: h = e.hair('#7a5140'); h.cap(); h.bangs(); h.sides(); h.back() ..."""
    h = Hair(self, color, **kw)
    self._hairs = getattr(self, "_hairs", []) + [h]
    return h


def _elf_add_bone(self, name, head, tail, parent, roll=(0, -1, 0)):
    """리그에 본 추가 (포니테일, 장비 관절 등). 이름은 소문자 + _L/_R 규칙."""
    arm = self.arm_obj
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = arm
    arm.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    eb = arm.data.edit_bones
    b = eb.new(name)
    b.head = tuple(head)
    b.tail = tuple(tail)
    if roll is not None:
        b.align_roll(V(roll))
    b.parent = eb[parent]
    b.use_deform = True
    bpy.ops.object.mode_set(mode="OBJECT")
    arm.select_set(False)
    self.bone_names.append(name)
    return name


Elf.hair = _elf_hair
Elf.add_bone = _elf_add_bone


# =========================================================================== clothing & gear

def _loop(buf, pts, nrm, ups, width, th, *, mat=None, w=None, closed=True):
    """점 목록을 따라 폭 width, 두께 th인 띠(리본). nrm: 각 점의 바깥 법선, ups: 띠 폭 방향.
    closed=True면 고리. 모자 띠, 헬멧 테두리, 끈에 쓴다."""
    n = len(pts)
    rings = []
    for i in range(n):
        c, nn, u = V(pts[i]), V(nrm[i]).normalized(), V(ups[i]).normalized()
        ww = w(i / max(n - 1, 1)) if callable(w) else (w or {})
        hw = width / 2
        quad = [c + u * hw, c + u * hw + nn * th, c - u * hw + nn * th, c - u * hw]
        rings.append([buf.vert(q, ww) for q in quad])
    rng = range(n) if closed else range(n - 1)
    for i in rng:
        r0, r1 = rings[i], rings[(i + 1) % n]
        for a in range(4):
            b = (a + 1) % 4
            buf.face((r0[a], r0[b], r1[b], r1[a]), mat)
    if not closed:
        buf.face(tuple(reversed(rings[0])), mat)
        buf.face(tuple(rings[-1]), mat)


class Anchor:
    """몸 표면의 한 지점: 위치, 바깥 법선, 위 방향, 웨이트, fpHide 그룹."""

    def __init__(self, pos, normal, up, w, group):
        self.pos, self.n, self.up, self.w, self.group = V(pos), V(normal).normalized(), V(up), w, group

    def matrix(self, lift=0.0, slide=(0.0, 0.0), tilt=0.0):
        """로컬: +Z=위, -Y=바깥(법선), +X=옆. lift: 법선 방향 띄우기, slide=(옆, 위) 이동, tilt: 법선축 회전(도)."""
        M = frame(self.n, self.up)
        if tilt:
            M = M @ Matrix.Rotation(math.radians(tilt), 4, "Y")
        x = M.col[0].to_3d()
        z = M.col[2].to_3d()
        p = self.pos + self.n * lift + x * slide[0] + z * slide[1]
        return Matrix.Translation(p) @ M


def _elf_anchor(self, at):
    """at: ('torso', z, angle[, off]) | ('leg_L', t, angle[, off]) | ('arm_R', t, angle[, off]) |
          ('head', az, el[, off]) → Anchor.  angle 0=앞, +90=캐릭터 왼쪽(+X)."""
    kind = at[0]
    off = at[3] if len(at) > 3 else 0.0
    if kind == "torso":
        p, n = self.torso_point(at[1], at[2], off)
        return Anchor(p, n, (0, 0, 1), self._torso_wfn(p, 0), "body")
    if kind.startswith(("leg_", "arm_")):
        limb, side = kind.split("_")
        ch = self.arm_chain(side) if limb == "arm" else self.leg_chain(side)
        p, n = self.limb_point(kind, at[1], at[2], off)
        c, tan = ch.at(at[1])
        return Anchor(p, n, -tan, ch.weights(at[1]), "arms" if limb == "arm" else "body")
    if kind == "head":
        p, n = self.head_point(at[1], at[2], off)
        return Anchor(p, n, (0, 0, 1), {"head": 1.0}, "head")
    raise ValueError(f"anchor 종류 모름: {kind}")


def pouch_geo(buf, M, size, mat, *, flap=None, button=None, w=None, flap_len=0.45, molle=None, r=0.22):
    """파우치: 몸통 + 덮개 + 똑딱단추 (+ 몰리 끈). M 로컬: -Y가 바깥, +Z 위, 원점 = 뒷면 중앙."""
    sx, sy, sz = size
    body = M @ Matrix.Translation((0, -sy / 2, 0))
    rbox(buf, (sx, sy, sz), body, mat=mat, w=w, r=r, segs=1)
    if flap is not None:
        fh = sz * flap_len
        fm = M @ Matrix.Translation((0, -sy / 2 - 0.0015, sz / 2 - fh / 2 + 0.002))
        rbox(buf, (sx * 1.06, sy * 1.08, fh), fm, mat=flap, w=w, r=0.3, segs=1)
        if button is not None:
            bc = M @ V((0, -sy - 0.0028, sz / 2 - fh * 0.78))
            n = (M.to_3x3() @ V((0, -1, 0))).normalized()
            up = M.to_3x3() @ V((0, 0, 1))
            disc(buf, bc, n, up, sx * 0.09, sx * 0.09, 0.0018, segs=8, mat=button, w=w)
    if molle is not None:
        for j in range(2):
            z = -sz * 0.05 - j * sz * 0.28
            mm = M @ Matrix.Translation((0, -sy - 0.0005, z))
            rbox(buf, (sx * 1.04, 0.003, sz * 0.09), mm, mat=molle, w=w, r=0.3, segs=1)


def _elf_part(self, name, group, fn):
    """Buf를 만들어 fn(buf)로 채우고 등록."""
    buf = Buf()
    fn(buf)
    ob = buf.obj(f"{self.name}_{name}", angle=40.0)
    return self.add(ob, group=group, tag=name)


def _elf_shirt(self, material, *, hem=None, off=0.010, flare=0.014, collar="stand", collar_mat=None,
               placket=None, buttons=None, p=2.3, n_rings=None, top_off=None):
    """윗옷 몸판 (셔츠·재킷·점프수트 상의). hem: 밑단 높이 z(기본 엉덩이). flare: 밑단 퍼짐(m).
    collar: 'stand'(차이나 칼라) | 'turtle' | None. placket: 앞여밈 띠 머티리얼, buttons: 단추 머티리얼."""
    k = self.k
    z0 = hem if hem is not None else self.hipj_z - 0.015 * k
    z1 = self.torso_top
    offk = off * k
    fl = [(0.0, flare * k), (0.25, flare * k * 0.3), (0.45, 0.0), (1.0, 0.0)]
    st = self.torso_stations(z0, z1, off=offk, flare=fl, p=p, n=n_rings)
    if top_off is not None:
        st[-1]["rx"] = 0.056 * k + top_off * k
        st[-1]["ry"] = 0.048 * k + top_off * k
    st[0]["lip"] = 0.005 * k
    self.cover["torso"].append((z0, z1 + 0.05))

    def fn(buf):
        loft(buf, st, segs=int(22 * self.q), cap0="lip", cap1="flat", mat=material, wfn=self._torso_wfn)
        cz = self.torso_top
        cm = collar_mat or material
        if collar == "stand":
            band(buf, (0, 0.004 * k, cz + 0.010 * k), (0, 0, 1), (1, 0, 0), 0.054 * k, 0.050 * k, 0.034 * k,
                 0.006 * k, segs=self._s(16), mat=cm, w={"neck": 0.5, "chest": 0.5}, taper=-0.04)
        elif collar == "turtle":
            band(buf, (0, 0.004 * k, cz + 0.016 * k), (0, 0, 1), (1, 0, 0), 0.053 * k, 0.049 * k, 0.05 * k,
                 0.009 * k, segs=self._s(20), mat=cm, w={"neck": 0.6, "chest": 0.4})
        if placket is not None:
            zs = [lerp(z0 + 0.004 * k, cz - 0.004 * k, i / 9) for i in range(10)]
            pts, nrm, ups = [], [], []
            for z in zs:
                pp, nn = self.torso_point(z, 0.0, offk + 0.0005)
                pts.append(pp)
                nrm.append(nn)
                ups.append(V((1, 0, 0)))
            _loop(buf, pts, nrm, ups, 0.014 * k, 0.0022 * k, mat=placket, closed=False,
                  w=lambda t: self._torso_wfn(V((0, 0, lerp(z0, cz, t))), 0))
            if buttons is not None:
                for i in range(4):
                    z = lerp(z0 + 0.05 * k, cz - 0.03 * k, i / 3)
                    pp, nn = self.torso_point(z, 0.0, offk + 0.0028 * k)
                    disc(buf, pp, nn, (0, 0, 1), 0.0042 * k, 0.0042 * k, 0.0018 * k, segs=10, mat=buttons,
                         w=self._torso_wfn(pp, 0))
    return self.part("shirt", "body", fn)


def _elf_sleeves(self, material, *, length=0.97, off=0.010, flare=0.006, cuff=None, puff=0.0):
    """소매 (양팔). length: 팔 길이 비율(1=손목). cuff=(재질, 높이, 두께) 소맷단 띠."""
    k = self.k
    for side in ("L", "R"):
        self.cover[f"arm_{side}"].append((0.0, length))
        ch = self.arm_chain(side)

        def extra(t, length=length):
            return (flare * smoothstep(length - 0.35, length, t) + puff * math.sin(math.pi * clamp(t / 0.5))) * k

        def fn(buf, ch=ch, side=side, extra=extra):
            rings = self._limb_loft(buf, ch, self.arm_r, -0.04, length, material, segs=int(14 * self.q),
                                    cap0="round", cap1=None, off=off * k, extra=extra)
            # 끝단 두께
            last = rings[-1]
            c, tan = ch.at(length)
            for kk in range(len(last)):
                pass
            if cuff:
                cm, ch_h, th = cuff
                rx, ry = self.arm_r(length)
                band(buf, c - tan * ch_h * 0.5 * k, tan, (0, -1, 0), rx + off * k + extra(length), ry + off * k + extra(length),
                     ch_h * k, th * k, segs=self._s(16), mat=cm, w=ch.weights(length - 0.03))
            else:
                rx, ry = self.arm_r(length)
                band(buf, c - tan * 0.002 * k, tan, (0, -1, 0), rx + off * k + extra(length) - 0.004 * k,
                     ry + off * k + extra(length) - 0.004 * k, 0.004 * k, 0.004 * k, segs=self._s(16), mat=material,
                     w=ch.weights(length))
        self.part(f"sleeve_{side}", "arms", fn)
    return self


def _elf_pants(self, material, *, waist=None, length=0.92, off=0.011, bag=0.012, blouse=0.016, cuff=None, p=2.2):
    """바지. waist: 허리 높이 z. length: 다리 길이 비율(1=발목). bag: 통 넓이, blouse: 장화 위 블라우징(주름 불룩)."""
    k = self.k
    zw = waist if waist is not None else lerp(self.hipj_z, self.waist_z, 0.85)
    self.cover["torso"].append((self.crotch_z - 0.05, zw))
    st = self.torso_stations(self.crotch_z + 0.002 * k, zw, off=off * k, p=p)
    st[-1]["lip"] = 0.004 * k

    def fn(buf):
        loft(buf, st, segs=int(24 * self.q), cap0="round", cap1="lip", mat=material, wfn=self._torso_wfn,
             cap_len0=0.04 * k)
    self.part("pants_top", "body", fn)
    for side in ("L", "R"):
        self.cover[f"leg_{side}"].append((-0.2, length))
        ch = self.leg_chain(side)

        def extra(t, length=length):
            e = bag * keys([(0.0, 0.3), (0.3, 1.0), (0.55, 0.8), (0.75, 0.9), (1.0, 1.0)], t)
            e += blouse * math.exp(-((t - (length - 0.12)) / 0.07) ** 2)
            return e * k

        def fn(buf, ch=ch, extra=extra, length=length):
            n = 16
            stl = []
            for i in range(n):
                t = lerp(-0.12, length, i / (n - 1))
                c, tan = ch.at(t)
                rx, ry = self.leg_r(clamp(t))
                ex = extra(t)
                stl.append({"c": c, "rx": rx + off * k + ex, "ry": ry + off * k + ex, "w": ch.weights(t)})
            stl[-1]["lip"] = 0.004 * k
            loft(buf, stl, segs=int(16 * self.q), cap0="round", cap1="lip", mat=material, ref=(0, -1, 0),
                 cap_len0=0.03 * k)
            if cuff:
                cm, hh, th = cuff
                c, tan = ch.at(length)
                rx, ry = self.leg_r(length)
                band(buf, c - tan * hh * 0.5 * k, tan, (0, -1, 0), rx + off * k + extra(length), ry + off * k + extra(length),
                     hh * k, th * k, segs=self._s(18), mat=cm, w=ch.weights(length))
        self.part(f"pants_{side}", "body", fn)
    return self


def _elf_boots(self, material, *, top=0.62, sole=None, cuff=None, laces=None, tab=None, straps=None, off=0.012,
               toe=0.0):
    """장화/신발. top: 다리 길이 비율에서 목 시작(작을수록 높은 목). sole=(재질, 두께),
    cuff=재질(목 패딩), laces=재질(앞 끈판), tab=재질(뒤 고리), straps=재질(가로 띠 2줄)."""
    k = self.k
    self.hide_feet = True
    for side in ("L", "R"):
        self.cover[f"leg_{side}"].append((top + 0.02, 1.2))
        ch = self.leg_chain(side)

        def fn(buf, ch=ch, side=side):
            n = 7
            stl = []
            for i in range(n):
                t = lerp(top, 1.02, i / (n - 1))
                c, tan = ch.at(t)
                rx, ry = self.leg_r(clamp(t))
                stl.append({"c": c, "rx": rx + off * k, "ry": ry + off * k, "w": ch.weights(t)})
            stl[0]["lip"] = 0.005 * k
            loft(buf, stl, segs=int(18 * self.q), cap0="lip", cap1="round", mat=material, ref=(0, -1, 0),
                 cap_len1=0.02 * k)
            if cuff is not None:
                c, tan = ch.at(top + 0.015)
                rx, ry = self.leg_r(top)
                band(buf, c, tan, (0, -1, 0), rx + off * k, ry + off * k, 0.016 * k, 0.005 * k, segs=self._s(18), mat=cuff,
                     w=ch.weights(top))
            if straps is not None:
                for j, t in enumerate((top + 0.12, top + 0.24)):
                    c, tan = ch.at(t)
                    rx, ry = self.leg_r(t)
                    band(buf, c, tan, (0, -1, 0), rx + off * k + 0.001, ry + off * k + 0.001, 0.009 * k, 0.003 * k,
                         segs=self._s(18), mat=straps, w=ch.weights(t))
            if laces is not None:
                ts = [lerp(top + 0.03, 0.97, i / 5) for i in range(6)]
                pts, nrm, ups = [], [], []
                for t in ts:
                    pp, nn = self.limb_point(f"leg_{side}", t, 0.0, off * k + 0.0008)
                    pts.append(pp)
                    nrm.append(nn)
                    ups.append(V((1, 0, 0)))
                _loop(buf, pts, nrm, ups, 0.022 * k, 0.0025 * k, mat=laces, closed=False,
                      w=lambda tt, ts=ts: ch.weights(lerp(ts[0], ts[-1], tt)))
                for t in (ts[1:-1] if self.q >= 0.8 else ts[2:-1:2]):
                    pp, nn = self.limb_point(f"leg_{side}", t, 0.0, off * k + 0.0033)
                    rbox(buf, (0.026 * k, 0.0025 * k, 0.0035 * k), Matrix.Translation(pp) @ frame(nn, (0, 0, 1)),
                         mat=material, w=ch.weights(t), r=0.4, segs=1)
            if tab is not None:
                pp, nn = self.limb_point(f"leg_{side}", top + 0.02, 180.0, off * k)
                rbox(buf, (0.016 * k, 0.004 * k, 0.03 * k), Matrix.Translation(pp + V((0, 0, 0.012 * k))) @ frame(nn),
                     mat=tab, w=ch.weights(top), r=0.4, segs=1)
        self.part(f"boot_shaft_{side}", "body", fn)
        sm = sole if sole else None
        ob = self.foot(side, material, inflate=0.013 * k, sole=sm, name=f"{self.name}_boot_{side}", toe_up=toe)
        self.add(ob, group="body", tag=f"boot_{side}")
    return self


def _elf_gloves(self, material, *, cuff=None, cuff_h=0.022, inflate=0.0028):
    """장갑 (맨손 대신). cuff=재질이면 손목 띠."""
    self.hide_hands = True
    k = self.k
    for side in ("L", "R"):
        self.cover[f"arm_{side}"].append((0.97, 1.2))
        c = (cuff, cuff_h * k, 0.004 * k) if cuff is not None else None
        ob = self.hand(side, material, inflate=inflate * k, cuff=c, name=f"{self.name}_glove_{side}")
        self.add(ob, group="arms", tag=f"glove_{side}")
    return self


def _elf_belt(self, material, *, z=None, h=0.028, th=0.006, off=None, buckle=None, buckle_size=(0.040, 0.032),
              loops=None, p=2.3):
    """벨트 + 버클 (+ 벨트 고리). z: 높이, off: 몸 표면에서 띄울 거리(기본: 바지 위)."""
    k = self.k
    zb = z if z is not None else lerp(self.hipj_z, self.waist_z, 0.72)
    o = (off if off is not None else 0.016) * k
    rx, ry, cy = self.torso_at(zb)

    def fn(buf):
        st_w = self._torso_wfn(V((0, 0, zb)), 0)
        band(buf, (0, cy, zb), (0, 0, 1), (1, 0, 0), rx + o, ry + o, h * k, th * k, segs=self._s(24), mat=material, w=st_w,
             p=p)
        if buckle is not None:
            pp, nn = self.torso_point(zb, 0.0, o + th * k)
            bw, bh = buckle_size
            M = Matrix.Translation(pp) @ frame(nn)
            rbox(buf, (bw * k, 0.005 * k, bh * k), M @ Matrix.Translation((0, -0.002 * k, 0)), mat=buckle, w=st_w,
                 r=0.25, segs=1)
            rbox(buf, (bw * 0.62 * k, 0.003 * k, bh * 0.5 * k), M @ Matrix.Translation((0, -0.0045 * k, 0)),
                 mat=material, w=st_w, r=0.3, segs=1)
        if loops is not None:
            for a in (-62, 62, -125, 125, 180):
                pp, nn = self.torso_point(zb, a, o + th * k)
                rbox(buf, (0.009 * k, 0.003 * k, h * 1.45 * k), Matrix.Translation(pp) @ frame(nn), mat=loops,
                     w=st_w, r=0.4, segs=1)
    return self.part("belt", "body", fn)


def _elf_pouch(self, material, at, *, size=(0.045, 0.022, 0.055), flap=None, button=None, molle=None, lift=0.0,
               tilt=0.0, name=None, strap=None, strap_h=0.012):
    """파우치. at: anchor 튜플 (예: ('leg_R', 0.3, -90) 허벅지 바깥, ('torso', 0.45, 0) 배 앞).
    strap=재질이면 팔다리를 감는 고정 끈(허벅지 파우치)."""
    a = self.anchor(at)
    k = self.k
    sz = tuple(x * k for x in size)
    nm = name or f"pouch{len(self.parts)}"

    def fn(buf):
        M = a.matrix(lift=lift * k, tilt=tilt)
        pouch_geo(buf, M, sz, material, flap=flap, button=button, w=a.w, molle=molle)
        if strap is not None and at[0].startswith(("leg_", "arm_")):
            limb, side = at[0].split("_")
            ch = self.arm_chain(side) if limb == "arm" else self.leg_chain(side)
            off = at[3] if len(at) > 3 else 0.0
            for dt in (-0.06, 0.06):
                t = at[1] + dt
                c, tan = ch.at(t)
                rx, ry = (self.arm_r if limb == "arm" else self.leg_r)(t)
                band(buf, c, tan, (0, -1, 0), rx + off + 0.0015, ry + off + 0.0015, strap_h * k, 0.003 * k, segs=self._s(18),
                     mat=strap, w=ch.weights(t))
    return self.part(nm, a.group, fn)


def _elf_ring(self, material, where, pos, *, h=0.014, th=0.004, off=0.0, name=None):
    """팔다리/몸통을 감는 띠. where='leg_L'|'arm_R'|'torso', pos=t(팔다리) 또는 z(몸통)."""
    k = self.k
    nm = name or f"ring{len(self.parts)}"
    if where == "torso":
        rx, ry, cy = self.torso_at(pos)

        dsp = None
        if self.bust_amt > 0.0:
            def dsp(q, r=(rx + off * k, ry + off * k)):
                return self._bust_vec(q, r[0], r[1], cy, 2.3, off * k)

        def fn(buf):
            band(buf, (0, cy, pos), (0, 0, 1), (1, 0, 0), rx + off * k, ry + off * k, h * k, th * k, segs=self._s(26),
                 mat=material, w=self._torso_wfn(V((0, 0, pos)), 0), p=2.3, disp=dsp)
        return self.part(nm, "body", fn)
    limb, side = where.split("_")
    ch = self.arm_chain(side) if limb == "arm" else self.leg_chain(side)
    c, tan = ch.at(pos)
    rx, ry = (self.arm_r if limb == "arm" else self.leg_r)(pos)

    def fn(buf):
        band(buf, c, tan, (0, -1, 0), rx + off * k, ry + off * k, h * k, th * k, segs=self._s(18), mat=material,
             w=ch.weights(pos))
    return self.part(nm, "arms" if limb == "arm" else "body", fn)


def _elf_strap(self, material, path, *, width=0.022, th=0.004, name=None, group="body"):
    """몸 표면을 따라가는 끈 (어깨끈, 멜빵, 슬링). path: anchor 튜플 목록. 웨이트는 점마다 보간."""
    k = self.k
    anchors = [self.anchor(a) for a in path]
    pts = catmull([a.pos for a in anchors], max(8, len(anchors) * 4))
    nrm = catmull([a.n for a in anchors], len(pts))
    ws = anchors

    def wf(t):
        f = t * (len(ws) - 1)
        i = min(int(f), len(ws) - 2)
        return mixw(ws[i].w, ws[i + 1].w, f - i)

    ups = []
    for i in range(len(pts)):
        tan = pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]
        ups.append(tan.cross(nrm[i]).normalized() if tan.length > 1e-9 else V((1, 0, 0)))
    nm = name or f"strap{len(self.parts)}"

    def fn(buf):
        _loop(buf, pts, nrm, ups, width * k, th * k, mat=material, closed=False, w=wf)
    return self.part(nm, group, fn)


def _elf_pad(self, material, at, *, size=(0.06, 0.016, 0.06), lift=0.0, name=None, r=0.4, curve=True, strap=None):
    """보호대 (무릎·팔꿈치·어깨). at: anchor. curve=True면 팔다리를 감싸는 둥근 판."""
    a = self.anchor(at)
    k = self.k
    sx, sy, sz = (x * k for x in size)
    nm = name or f"pad{len(self.parts)}"

    def fn(buf):
        if curve and at[0].startswith(("leg_", "arm_")):
            limb, side = at[0].split("_")
            ch = self.arm_chain(side) if limb == "arm" else self.leg_chain(side)
            rfn = self.arm_r if limb == "arm" else self.leg_r
            t0 = at[1]
            dt = sz / ch.total / 2
            off = (at[3] if len(at) > 3 else 0.0) + lift * k
            # 팔다리 단면의 앞쪽 호를 덮는 두꺼운 판
            span = sx / max(rfn(t0)[0], 1e-3)
            n = 5
            rows = []
            for i in range(n):
                t = t0 - dt + 2 * dt * i / (n - 1)
                row = []
                for j in range(9):
                    ang = math.degrees(-span / 2 + span * j / 8) + at[2]
                    pp, nn = self.limb_point(at[0], t, ang, off)
                    bulge = sy * 0.5 * math.sin(math.pi * j / 8) * math.sin(math.pi * i / (n - 1))
                    row.append((pp + nn * bulge, nn))
                rows.append(row)
            top = [[buf.vert(p + nn * sy, ch.weights(t0)) for p, nn in row] for row in rows]
            bot = [[buf.vert(p, ch.weights(t0)) for p, nn in row] for row in rows]
            for i in range(n - 1):
                for j in range(8):
                    buf.face((top[i][j], top[i][j + 1], top[i + 1][j + 1], top[i + 1][j]), material)
                    buf.face((bot[i][j], bot[i + 1][j], bot[i + 1][j + 1], bot[i][j + 1]), material)
            for i in range(n - 1):
                for j in (0, 8):
                    q = (top[i][j], top[i + 1][j], bot[i + 1][j], bot[i][j])
                    buf.face(q if j == 8 else tuple(reversed(q)), material)
            for i in (0, n - 1):
                for j in range(8):
                    q = (top[i][j], bot[i][j], bot[i][j + 1], top[i][j + 1])
                    buf.face(q if i == 0 else tuple(reversed(q)), material)
            if strap is not None:
                for dd in (-0.7, 0.7):
                    t = t0 + dd * dt
                    c, tan = ch.at(t)
                    rx, ry = rfn(t)
                    band(buf, c, tan, (0, -1, 0), rx + off, ry + off, 0.008 * k, 0.003 * k, segs=self._s(18), mat=strap,
                         w=ch.weights(t))
        else:
            rbox(buf, (sx, sy, sz), a.matrix(lift=lift * k + sy / 2), mat=material, w=a.w, r=r, segs=2)
    return self.part(nm, a.group, fn)


def _elf_patch(self, material, at, *, size=(0.03, 0.03), shape="rect", th=0.0018, name=None, lift=0.0, tilt=0.0):
    """평평한 패치·계급장·표식. shape: 'rect'|'round'|'chevron'|'bars2'|'bars3'|'diamond'.
    실제 문양을 옮기지 말고 단순한 기하 형태로 조합한다."""
    a = self.anchor(at)
    k = self.k
    w, h = size[0] * k, size[1] * k
    nm = name or f"patch{len(self.parts)}"

    def fn(buf):
        M = a.matrix(lift=lift * k, tilt=tilt)
        n = (M.to_3x3() @ V((0, -1, 0))).normalized()
        up = M.to_3x3() @ V((0, 0, 1))
        x = M.to_3x3() @ V((1, 0, 0))
        c = M.to_translation()
        if shape == "round":
            disc(buf, c, n, up, w / 2, h / 2, th, segs=self._s(16), mat=material, w=a.w)
        elif shape == "diamond":
            disc(buf, c, n, up, w / 2, h / 2, th, segs=4, mat=material, w=a.w, p=2.0)
        elif shape in ("bars2", "bars3"):
            nb = 2 if shape == "bars2" else 3
            for i in range(nb):
                zz = (i - (nb - 1) / 2) * h / nb * 1.15
                rbox(buf, (w, th * 2, h / nb * 0.7), Matrix.Translation(c + up * zz) @ M.to_3x3().to_4x4(),
                     mat=material, w=a.w, r=0.3, segs=1)
        elif shape == "chevron":
            for sgn in (-1, 1):
                R = M.to_3x3().to_4x4() @ Matrix.Rotation(math.radians(sgn * 32), 4, "Y")
                rbox(buf, (w * 0.58, th * 2, h * 0.28), Matrix.Translation(c + x * sgn * w * 0.23) @ R, mat=material,
                     w=a.w, r=0.3, segs=1)
        else:
            rbox(buf, (w, th * 2, h), M, mat=material, w=a.w, r=0.2, segs=1)
    return self.part(nm, a.group, fn)


def _elf_helmet(self, material, *, off=0.036, front=8.0, side=2.0, back=-24.0, rim=None, band_mat=None,
                band_el=38.0, buckle=None, strap=None, ridge=None, visor=None, vents=None, name="helmet"):
    """헬멧 (머리 모양을 따라 부풀린 돔). front/side/back: 테두리 높이(도). rim=재질(테두리 말림),
    band_mat=헬멧 띠, buckle=띠 버클, strap=턱끈, ridge=riot식 앞 챙 재질, visor=투명/색 바이저 재질,
    vents=정수리 통풍구 재질."""
    k = self.k
    o = off * k
    self._hats = getattr(self, "_hats", [])

    def rim_el(az):
        a = abs(((az + 180) % 360) - 180)
        return front + (side - front) * smoothstep(0, 90, a) + (back - side) * smoothstep(90, 180, a)

    def fn(buf):
        segs, rows = int(32 * self.q), int(9 * self.q)
        grid = []
        for j in range(segs):
            az = 360.0 * j / segs
            col = []
            e0 = rim_el(az)
            for i in range(rows + 1):
                u = i / rows
                el = lerp(e0, 89.0, u ** 0.85)
                col.append(buf.vert(self.head_point(az, el, o * (1 + 0.08 * math.sin(u * math.pi)))[0], {"head": 1.0}))
            grid.append(col)
        # 안쪽 면 (두께)
        inner = []
        for j in range(segs):
            az = 360.0 * j / segs
            e0 = rim_el(az)
            inner.append(buf.vert(self.head_point(az, e0 + 2, o * 0.45)[0], {"head": 1.0}))
        top = buf.vert(self.head_point(0, 90, o)[0], {"head": 1.0})
        for j in range(segs):
            j2 = (j + 1) % segs
            for i in range(rows):
                buf.face((grid[j][i], grid[j2][i], grid[j2][i + 1], grid[j][i + 1]), material)
            buf.face((grid[j][rows], grid[j2][rows], top), material)
            buf.face((inner[j], inner[j2], grid[j2][0], grid[j][0]), material)
        # 테두리 말림
        if rim is not None:
            pts, nrm, ups = [], [], []
            for j in range(segs):
                az = 360.0 * j / segs
                e0 = rim_el(az)
                pp, nn = self.head_point(az, e0 + 0.8, o - 0.004 * k)
                pts.append(pp)
                nrm.append(nn)
                p2, _ = self.head_point(az, e0 + 4, o)
                ups.append((p2 - pp).normalized())
            _loop(buf, pts, nrm, ups, 0.012 * k, 0.008 * k, mat=rim, w={"head": 1.0})
        if band_mat is not None:
            pts, nrm, ups = [], [], []
            for j in range(segs):
                az = 360.0 * j / segs
                el = band_el - 10 * smoothstep(60, 180, abs(((az + 180) % 360) - 180))
                pp, nn = self.head_point(az, el, o * 1.06)
                pts.append(pp)
                nrm.append(nn)
                p2, _ = self.head_point(az, el + 4, o * 1.06)
                ups.append((p2 - pp).normalized())
            _loop(buf, pts, nrm, ups, 0.026 * k, 0.004 * k, mat=band_mat, w={"head": 1.0})
            if buckle is not None:
                pp, nn = self.head_point(-24, band_el, o * 1.06 + 0.004 * k)
                p2, _ = self.head_point(-24, band_el + 4, o)
                M = Matrix.Translation(pp) @ frame(nn, (p2 - pp))
                rbox(buf, (0.03 * k, 0.005 * k, 0.03 * k), M, mat=buckle, w={"head": 1.0}, r=0.25, segs=1)
                rbox(buf, (0.018 * k, 0.003 * k, 0.014 * k), M @ Matrix.Translation((0, -0.003 * k, 0)),
                     mat=band_mat, w={"head": 1.0}, r=0.3, segs=1)
        if ridge is not None:
            # 이마 위 챙 (riot / 방탄모 앞 테)
            pts, nrm, ups = [], [], []
            for j in range(15):
                az = -70 + 140 * j / 14
                pp, nn = self.head_point(az, rim_el(az) + 1.5, o + 0.002 * k)
                pts.append(pp)
                fw = V((pp.x * 0.3, -1, 0)).normalized()
                nrm.append(V((0, 0, 1)))
                ups.append(fw)
            _loop(buf, [p - V((0, 0, 0.004 * k)) for p in pts], nrm, ups, 0.03 * k, 0.008 * k, mat=ridge,
                  w={"head": 1.0}, closed=False)
        if vents is not None:
            for j in range(3):
                pp, nn = self.head_point(-8 + 8 * j, 62, o * 1.12)
                rbox(buf, (0.012 * k, 0.006 * k, 0.07 * k), Matrix.Translation(pp) @ frame(nn, (0, -1, 0.2)),
                     mat=vents, w={"head": 1.0}, r=0.4, segs=1)
        self._hats.append((o, rim_el))
        if strap is not None:
            for s in (1, -1):
                pts = []
                nrm = []
                for j in range(7):
                    u = j / 6
                    az = s * lerp(100, 40, u)
                    el = lerp(side + 2, -72, u)
                    pp, nn = self.head_point(az, el, 0.004 * k + o * (1 - u) * 0.8)
                    pts.append(pp)
                    nrm.append(nn)
                ups = []
                for i in range(len(pts)):
                    tan = pts[min(i + 1, 6)] - pts[max(i - 1, 0)]
                    ups.append(tan.cross(nrm[i]).normalized())
                _loop(buf, pts, nrm, ups, 0.010 * k, 0.003 * k, mat=strap, closed=False, w={"head": 1.0})
        if visor is not None:
            segv = 15
            rowsv = 4
            g = []
            for j in range(segv):
                az = -75 + 150 * j / (segv - 1)
                col = []
                for i in range(rowsv):
                    el = rim_el(az) + 2 - 40 * i / (rowsv - 1)
                    col.append(buf.vert(self.head_point(az, el, o + 0.02 * k + 0.012 * k * i / (rowsv - 1))[0],
                                        {"head": 1.0}))
                g.append(col)
            for j in range(segv - 1):
                for i in range(rowsv - 1):
                    buf.face((g[j][i], g[j][i + 1], g[j + 1][i + 1], g[j + 1][i]), visor)
    return self.part(name, "head", fn)


def _elf_gear(self, name, at, fn_geo, *, group=None):
    """임의 장비를 anchor에 붙인다. fn_geo(buf, M, w): 로컬(+Z 위, -Y 바깥)에서 rbox/disc/loft로 그린다."""
    a = self.anchor(at)

    def fn(buf):
        fn_geo(buf, a.matrix(), a.w)
    return self.part(name, group or a.group, fn)


def _elf_epaulet(self, material, *, button=None, width=0.026, th=0.004, off=0.012, sides=("L", "R")):
    """견장(어깨 고리): 목깃 옆에서 어깨 끝까지 덮는 띠 + 단추. 1인칭에서 내려다볼 때 어깨 윗면을 채운다."""
    k = self.k
    for side in sides:
        s = 1 if side == "L" else -1
        path = [("torso", self.torso_top - 0.016 * k, s * 38, off * k),
                ("torso", self.shoulder_z + 0.014 * k, s * 72, off * k),
                ("torso", self.shoulder_z - 0.004 * k, s * 88, off * k)]
        self.strap(material, path, width=width, th=th, name=f"epaulet_{side}")
        if button is not None:
            a = self.anchor(("torso", self.torso_top - 0.02 * k, s * 44, off * k + th * k))
            self.part(f"epaulet_btn_{side}", "body",
                      lambda buf, a=a: disc(buf, a.pos, a.n, (0, 0, 1), 0.0048 * k, 0.0048 * k, 0.002 * k, segs=8,
                                            mat=button, w=a.w))
    return self


Elf.epaulet = _elf_epaulet
Elf.anchor = _elf_anchor
Elf.part = _elf_part
Elf.shirt = _elf_shirt
Elf.sleeves = _elf_sleeves
Elf.pants = _elf_pants
Elf.boots = _elf_boots
Elf.gloves = _elf_gloves
Elf.belt = _elf_belt
Elf.pouch = _elf_pouch
Elf.ring = _elf_ring
Elf.strap = _elf_strap
Elf.pad = _elf_pad
Elf.patch = _elf_patch
Elf.helmet = _elf_helmet
Elf.gear = _elf_gear
