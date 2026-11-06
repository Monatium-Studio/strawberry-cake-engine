"""SVG 숫자·상자·문서 도우미 (로고 생성기 공용)"""
import math


def f(v):
    s = ('%.2f' % v).rstrip('0').rstrip('.')
    return '0' if s in ('-0', '') else s


def P(pts):
    return ' '.join(f'{f(x)} {f(y)}' for x, y in pts)


def union(*bs):
    return (min(b[0] for b in bs), min(b[1] for b in bs), max(b[2] for b in bs), max(b[3] for b in bs))


def grow(b, m, mb=None):
    """상자 b를 m만큼 키운다 (mb: 아래쪽 추가 여유, 그림자용)"""
    return (b[0] - m, b[1] - m, b[2] + m, b[3] + m + (mb or 0))


def xform(b, s, dx, dy):
    """상자 b를 s배 하고 (dx, dy) 옮긴다"""
    return (b[0] * s + dx, b[1] * s + dy, b[2] * s + dx, b[3] * s + dy)


def svg_doc(box, body, defs='', extra=''):
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{f(x0)} {f(y0)} {f(w)} {f(h)}" width="{f(w)}" height="{f(h)}"{extra}>\n'
            + (f'<defs>\n{defs}\n</defs>\n' if defs else '') + body + '\n</svg>\n')


def gear_path(cx, cy, teeth, r_out, r_in, duty=0.5, hole=0.0):
    """톱니바퀴 윤곽 (사다리꼴 이), hole > 0이면 가운데 구멍 (evenodd로 칠한다)"""
    pts = []
    step = 2 * math.pi / teeth
    for i in range(teeth):
        a = i * step - math.pi / 2
        w_out = step * duty * 0.35
        w_in = step * duty * 0.5
        for ang, r in ((a - step / 2 + w_in, r_in), (a - w_out, r_out), (a + w_out, r_out), (a + step / 2 - w_in, r_in)):
            pts.append((cx + r * math.cos(ang), cy + r * math.sin(ang)))
    d = 'M' + P(pts[:1]) + ' L' + P(pts[1:]) + ' Z'
    if hole > 0:
        d += f' M{f(cx + hole)} {f(cy)} A{f(hole)} {f(hole)} 0 1 0 {f(cx - hole)} {f(cy)} A{f(hole)} {f(hole)} 0 1 0 {f(cx + hole)} {f(cy)} Z'
    return d
