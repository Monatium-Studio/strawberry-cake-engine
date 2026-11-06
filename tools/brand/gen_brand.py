"""브랜드 로고 생성기: 모나티엄 스튜디오 가로 로고, 스트로베리 케이크 엔진 로고, 엔진 인트로 첫 카드.

출력 (저장소 루트 기준):
  brand/monatium-studio.svg                 가로 로고, 어두운 바탕용 (금속 글자)
  brand/monatium-studio-light.svg           가로 로고, 밝은 바탕용 (흑연색 글자)
  brand/strawberry-cake-engine.svg          가로 로고, 어두운 바탕용
  brand/strawberry-cake-engine-light.svg    가로 로고, 밝은 바탕용
  brand/strawberry-cake-engine-mark.svg     조각 케이크 마크만 (정사각형, 아이콘·파비콘용)
  src/intro/assets/credits-*.svg            인트로 첫 카드(Produced by · Powered by) 레이어
  src/intro/credits.layout.ts               그 레이어 배치 (무대 좌표의 상자, 회전·확대 기준점)

글자는 전부 윤곽선이라 웹 글꼴이 필요 없다.
글꼴(Google Fonts, OFL): KronaOne-Regular.ttf, Michroma-Regular.ttf, BagelFatOne-Regular.ttf
  https://github.com/google/fonts/tree/main/ofl/{kronaone,michroma,bagelfatone}

usage: python3 -I tools/brand/gen_brand.py <repo_root> <fonts_dir>
필요: fonttools, uharfbuzz
"""
import json, math, os, re, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from textpath import Font
from svgutil import f, P, union, grow, xform, svg_doc, gear_path

ROOT, FONTS = sys.argv[1], sys.argv[2]
KRONA = Font(os.path.join(FONTS, 'KronaOne-Regular.ttf'))
MICHROMA = Font(os.path.join(FONTS, 'Michroma-Regular.ttf'))
BAGEL = Font(os.path.join(FONTS, 'BagelFatOne-Regular.ttf'))
os.makedirs(os.path.join(ROOT, 'brand'), exist_ok=True)
os.makedirs(os.path.join(ROOT, 'src/intro/assets'), exist_ok=True)


def write(rel, text):
    with open(os.path.join(ROOT, rel), 'w') as fh:
        fh.write(text)


# =====================================================================================
# 모나티엄 스튜디오 (가로): 왼쪽 톱니 마크, 오른쪽 MONATIUM / STUDIO ─────
# =====================================================================================
_mono = open(os.path.join(HERE, 'elf_logo_mono.svg')).read()
GD = re.search(r' d="([^"]+)"', _mono).group(1)
GW, GH = [float(v) for v in re.search(r'viewBox="([^"]+)"', _mono).group(1).split()][2:]
HOLE = (498.24, 498.75)            # 톱니 중심(렌치 구멍). trace_elf 출력값
GS = 200 / GH                      # 마크 높이 200
GPX, GPY = HOLE[0] * GS, HOLE[1] * GS
GEAR_BOX = (0, 0, GW * GS, GH * GS)
K = GS / 0.30                      # 금속 필터 크기 (원래 인트로 로고는 배율 0.30)


def grey(L, tint=0.012):
    L = max(0, min(1, L))
    return '#%02x%02x%02x' % tuple(int(max(0, min(1, v)) * 255) for v in (L - tint, L, L + tint))


def ms_gear(p):
    """회색 금속 톱니. p: id 접두사 (한 문서에 여러 번 넣을 때)"""
    use = f'<use href="#{p}g" transform="scale({f(GS)})"/>'
    wedges = []
    N = 144
    for i in range(N):
        a0 = math.radians(i * 360 / N); a1 = math.radians((i + 1.15) * 360 / N)
        th = (i + 0.5) * 2 * math.pi / N
        L = 0.60 + 0.24 * math.cos(2 * (th - math.radians(35))) + 0.05 * math.cos(6 * th + 1.3)
        R = 240 * K
        wedges.append(f'<path d="M{f(GPX)} {f(GPY)} L{f(GPX + R * math.cos(a0))} {f(GPY + R * math.sin(a0))} '
                      f'L{f(GPX + R * math.cos(a1))} {f(GPY + R * math.sin(a1))} Z" fill="{grey(L)}"/>')
    rings = ''.join(f'<circle cx="{f(GPX)}" cy="{f(GPY)}" r="{f(r * K)}" stroke="{"#fff" if k % 2 else "#000"}" stroke-opacity="{.07 if k % 2 else .06}"/>'
                    for k, r in enumerate([4 + q * 2.2 for q in range(80)]))
    defs = (f'<path id="{p}g" d="{GD}"/>'
            f'<filter id="{p}metal" x="-15%" y="-15%" width="130%" height="140%" color-interpolation-filters="sRGB">'
            f'<feGaussianBlur in="SourceAlpha" stdDeviation="{f(3.4 * K)}" result="b"/>'
            f'<feSpecularLighting in="b" surfaceScale="{f(5 * K)}" specularConstant=".95" specularExponent="24" lighting-color="#fff" result="spec"><feDistantLight azimuth="235" elevation="36"/></feSpecularLighting>'
            '<feComposite in="spec" in2="SourceAlpha" operator="in" result="specIn"/>'
            f'<feGaussianBlur in="SourceAlpha" stdDeviation="{f(1.1 * K)}" result="b2"/>'
            f'<feSpecularLighting in="b2" surfaceScale="{f(2.4 * K)}" specularConstant="1.1" specularExponent="38" lighting-color="#fff" result="spec2"><feDistantLight azimuth="235" elevation="30"/></feSpecularLighting>'
            '<feComposite in="spec2" in2="SourceAlpha" operator="in" result="edgeIn"/>'
            f'<feDiffuseLighting in="b" surfaceScale="{f(5 * K)}" diffuseConstant="1" lighting-color="#fff" result="diff"><feDistantLight azimuth="235" elevation="55"/></feDiffuseLighting>'
            '<feComposite in="SourceGraphic" in2="diff" operator="arithmetic" k1="1.08" k2="0" k3="0" k4="0" result="shaded"/>'
            '<feComposite in="shaded" in2="specIn" operator="arithmetic" k1="0" k2="1" k3=".55" k4="0" result="lit1"/>'
            '<feComposite in="lit1" in2="edgeIn" operator="arithmetic" k1="0" k2="1" k3=".45" k4="0" result="lit"/>'
            f'<feMorphology in="SourceAlpha" operator="erode" radius="{f(1.6 * K)}" result="er"/>'
            '<feComposite in="SourceAlpha" in2="er" operator="out" result="rim"/>'
            '<feFlood flood-color="#1b1e22" flood-opacity=".55"/><feComposite in2="rim" operator="in" result="rimDark"/>'
            '<feMerge result="litRim"><feMergeNode in="lit"/><feMergeNode in="rimDark"/></feMerge>'
            '<feComposite in="litRim" in2="SourceAlpha" operator="in"/></filter>'
            f'<linearGradient id="{p}tone" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="{f(GEAR_BOX[3])}">'
            '<stop offset=".18" stop-color="#fff" stop-opacity=".22"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/>'
            '<stop offset=".62" stop-color="#000" stop-opacity=".08"/><stop offset=".82" stop-color="#000" stop-opacity=".32"/></linearGradient>'
            f'<clipPath id="{p}gc">{use}</clipPath>')
    body = (f'<g filter="url(#{p}metal)"><g clip-path="url(#{p}gc)"><g>{"".join(wedges)}</g>'
            f'<g fill="none" stroke-width="{f(1.1 * K)}">{rings}</g>'
            f'<rect x="{f(GPX - 260 * K)}" y="{f(GPY - 260 * K)}" width="{f(520 * K)}" height="{f(520 * K)}" fill="url(#{p}tone)"/></g></g>')
    return defs, body


def ms_gear_shadow(p, dark=True):
    defs = (f'<path id="{p}g" d="{GD}"/><filter id="{p}shadow" x="-20%" y="-20%" width="140%" height="150%">'
            f'<feGaussianBlur in="SourceAlpha" stdDeviation="{f(8 * K)}"/>'
            f'<feComponentTransfer><feFuncA type="linear" slope="{".8" if dark else ".35"}"/></feComponentTransfer></filter>')
    body = f'<g filter="url(#{p}shadow)" transform="translate(0 {f(9 * K)})"><use href="#{p}g" transform="scale({f(GS)})"/></g>'
    return defs, body


MS_TX = GEAR_BOX[2] + 40
MON_D, MON_B = KRONA.path('MONATIUM', 96, MS_TX, 116, 'start', 6)
STU_D, STU_B = MICHROMA.path('STUDIO', 31, MS_TX + 3, 172, 'start', 19)
MS_RULE = (STU_B[2] + 22, (STU_B[1] + STU_B[3]) / 2 - 1, MON_B[2], (STU_B[1] + STU_B[3]) / 2 + 1)
MS_BOX = union(GEAR_BOX, MON_B, STU_B)


def ms_text(p, dark=True):
    """MONATIUM, STUDIO + 가는 선. (defs, word_body, sub_body)"""
    if dark:
        grad = lambda gid, b: (f'<linearGradient id="{gid}" gradientUnits="userSpaceOnUse" x1="0" y1="{f(b[1])}" x2="0" y2="{f(b[3])}">'
                               '<stop offset="0" stop-color="#f6f7f8"/><stop offset=".38" stop-color="#bfc4c9"/><stop offset=".5" stop-color="#62676e"/>'
                               '<stop offset=".6" stop-color="#a9afb5"/><stop offset="1" stop-color="#e3e6e9"/></linearGradient>')
        filt = (f'<filter id="{p}mt" x="-5%" y="-30%" width="110%" height="170%" color-interpolation-filters="sRGB">'
                '<feGaussianBlur in="SourceAlpha" stdDeviation="1.4" result="b"/>'
                '<feSpecularLighting in="b" surfaceScale="3" specularConstant=".9" specularExponent="22" lighting-color="#fff" result="spec"><feDistantLight azimuth="235" elevation="40"/></feSpecularLighting>'
                '<feComposite in="spec" in2="SourceAlpha" operator="in" result="specIn"/>'
                '<feComposite in="SourceGraphic" in2="specIn" operator="arithmetic" k1="0" k2="1" k3=".5" k4="0" result="lit"/>'
                '<feGaussianBlur in="SourceAlpha" stdDeviation="4" result="sb"/><feOffset in="sb" dy="5" result="so"/>'
                '<feFlood flood-color="#000" flood-opacity=".7"/><feComposite in2="so" operator="in" result="shadow"/>'
                '<feMerge><feMergeNode in="shadow"/><feMergeNode in="lit"/></feMerge></filter>')
        rule_c = '#c8cdd2'
        fa = f' filter="url(#{p}mt)"'
    else:
        grad = lambda gid, b: (f'<linearGradient id="{gid}" gradientUnits="userSpaceOnUse" x1="0" y1="{f(b[1])}" x2="0" y2="{f(b[3])}">'
                               '<stop offset="0" stop-color="#4a5058"/><stop offset=".55" stop-color="#2a2e34"/><stop offset="1" stop-color="#16191d"/></linearGradient>')
        filt = ''
        rule_c = '#5a6068'
        fa = ''
    defs = (grad(f'{p}tw', MON_B) + grad(f'{p}ts', STU_B) + filt
            + f'<linearGradient id="{p}rule" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="{rule_c}"/><stop offset="1" stop-color="{rule_c}" stop-opacity="0"/></linearGradient>')
    word = f'<path d="{MON_D}" fill="url(#{p}tw)"{fa}/>'
    r = MS_RULE
    sub = (f'<path d="{STU_D}" fill="url(#{p}ts)"{fa}/>'
           f'<rect x="{f(r[0])}" y="{f(r[1])}" width="{f(r[2] - r[0])}" height="{f(r[3] - r[1])}" fill="url(#{p}rule)"/>')
    return defs, word, sub


# =====================================================================================
# 스트로베리 케이크 엔진: 조각 케이크 마크 (위에 딸기, 꼭지는 톱니) + STRAWBERRY CAKE / ENGINE ─────
# =====================================================================================
INK = '#4a2018'                    # 외곽선 (진한 초콜릿)
CREAM, SPONGE, SPONGE_D = '#fff6ec', '#f7c873', '#e3a04c'
BERRY, BERRY_L, BERRY_D = '#ef3f55', '#ff8a9c', '#b81f37'
LEAF = '#58b947'

CT = (16, 122)                     # 케이크 앞 꼭지점 (윗면)
CB2 = (200, 96)                    # 오른쪽 앞 모서리 (윗면)
CB1 = (152, 62)                    # 뒤 모서리 (윗면)
CHT = 86                           # 케이크 높이
SW = 6                             # 외곽선 굵기


def lerp(a, b, u):
    return (a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u)


def band(u0, u1, fill):
    """잘린 면의 띠 (높이 비율 u0~u1)"""
    pts = [(CT[0], CT[1] + CHT * u0), (CB2[0], CB2[1] + CHT * u0), (CB2[0], CB2[1] + CHT * u1), (CT[0], CT[1] + CHT * u1)]
    return f'<path d="M{P(pts[:1])} L{P(pts[1:])} Z" fill="{fill}"/>'


def cake_body(p):
    """케이크 본체 (딸기 제외)"""
    # 바깥 둥근 면 (생크림): 오른쪽 앞 모서리 → 뒤 모서리, 아래로 같은 모양
    arc_c = (CB2[0] + 26, CB1[1] + 4)
    outer = (f'M{P([CB2])} Q{P([arc_c])} {P([CB1])} L{P([(CB1[0], CB1[1] + CHT)])} '
             f'Q{P([(arc_c[0], arc_c[1] + CHT)])} {P([(CB2[0], CB2[1] + CHT)])} Z')
    top = f'M{P([CT])} L{P([CB1])} Q{P([arc_c])} {P([CB2])} Z'
    side = f'M{P([CT])} L{P([CB2])} L{P([(CB2[0], CB2[1] + CHT)])} L{P([(CT[0], CT[1] + CHT)])} Z'
    # 가운데 크림 띠의 딸기 단면
    slices = ''
    for u in (.2, .5, .8):
        c = lerp(CT, CB2, u)
        cy = c[1] + CHT * .53
        ang = math.degrees(math.atan2(CB2[1] - CT[1], CB2[0] - CT[0]))
        slices += (f'<g transform="translate({f(c[0])} {f(cy)}) rotate({f(ang)})">'
                   f'<ellipse rx="17" ry="8.5" fill="{BERRY}" stroke="{INK}" stroke-width="2.5"/>'
                   f'<ellipse rx="9" ry="3.6" fill="{BERRY_L}"/></g>')
    # 윗면 크림 결과 그림자
    shade = (f'<path d="M{P([lerp(CT, CB2, .08)])} L{P([lerp(CB1, CB2, .6)])}" stroke="#f1dccb" stroke-width="5" stroke-linecap="round" fill="none"/>')
    defs = (f'<clipPath id="{p}side"><path d="{side}"/></clipPath>'
            f'<linearGradient id="{p}out" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff1f3"/><stop offset="1" stop-color="#f7cdd5"/></linearGradient>')
    body = (f'<path d="{outer}" fill="url(#{p}out)" stroke="{INK}" stroke-width="{SW}" stroke-linejoin="round"/>'
            f'<g clip-path="url(#{p}side)">' + band(0, .17, CREAM) + band(.17, .44, SPONGE) + band(.44, .62, CREAM)
            + band(.62, .9, SPONGE) + band(.9, 1, SPONGE_D) + slices + '</g>'
            f'<path d="{side}" fill="none" stroke="{INK}" stroke-width="{SW}" stroke-linejoin="round"/>'
            # 띠 경계선 (가늘게)
            + ''.join(f'<path d="M{P([(CT[0], CT[1] + CHT * u)])} L{P([(CB2[0], CB2[1] + CHT * u)])}" stroke="{INK}" stroke-opacity=".35" stroke-width="1.6"/>' for u in (.17, .44, .62, .9))
            + f'<path d="{top}" fill="{CREAM}" stroke="{INK}" stroke-width="{SW}" stroke-linejoin="round"/>' + shade
            # 크림 받침 (딸기 아래)
            + f'<path d="M126 86 C118 70 132 62 142 66 C150 56 168 60 166 72 C178 74 176 90 164 92 C150 98 134 96 126 86 Z" fill="#fffdf9" stroke="{INK}" stroke-width="4" stroke-linejoin="round"/>')
    return defs, body


BERRY_C = (146, 46)                # 딸기 중심
BERRY_BASE = (146, 74)             # 딸기가 앉는 점 (튀어 앉는 연출 기준점)


def berry_body(p):
    x, y = BERRY_C
    shape = (f'M{f(x - 26)} {f(y - 10)} C{f(x - 28)} {f(y - 30)} {f(x + 28)} {f(y - 30)} {f(x + 26)} {f(y - 10)} '
             f'C{f(x + 24)} {f(y + 12)} {f(x + 8)} {f(y + 28)} {f(x)} {f(y + 32)} C{f(x - 8)} {f(y + 28)} {f(x - 24)} {f(y + 12)} {f(x - 26)} {f(y - 10)} Z')
    seeds = ''.join(f'<ellipse cx="{f(x + dx)}" cy="{f(y + dy)}" rx="1.9" ry="2.8" fill="#ffe08a" transform="rotate({f(dx * 1.4)} {f(x + dx)} {f(y + dy)})"/>'
                    for dx, dy in ((-14, -6), (0, -9), (14, -6), (-8, 6), (8, 6), (0, 18), (-17, 6), (17, 6)))
    calyx = gear_path(x, y - 22, 8, 15, 10.5, duty=0.62)
    defs = (f'<radialGradient id="{p}berry" cx=".38" cy=".3" r=".8"><stop offset="0" stop-color="#ff6d80"/>'
            f'<stop offset=".6" stop-color="{BERRY}"/><stop offset="1" stop-color="{BERRY_D}"/></radialGradient>')
    body = (f'<path d="{shape}" fill="url(#{p}berry)" stroke="{INK}" stroke-width="{SW}" stroke-linejoin="round"/>' + seeds
            + f'<ellipse cx="{f(x - 12)}" cy="{f(y - 8)}" rx="5" ry="9" fill="#fff" opacity=".55" transform="rotate(28 {f(x - 12)} {f(y - 8)})"/>'
            + f'<path d="{calyx}" fill="{LEAF}" stroke="{INK}" stroke-width="4" stroke-linejoin="round"/>'
            + f'<circle cx="{f(x)}" cy="{f(y - 22)}" r="4" fill="#2f7d2a"/>'
            + f'<path d="M{f(x)} {f(y - 34)} Q{f(x + 2)} {f(y - 44)} {f(x + 9)} {f(y - 48)}" fill="none" stroke="{INK}" stroke-width="8" stroke-linecap="round"/>'
            + f'<path d="M{f(x)} {f(y - 34)} Q{f(x + 2)} {f(y - 44)} {f(x + 9)} {f(y - 48)}" fill="none" stroke="{LEAF}" stroke-width="3.5" stroke-linecap="round"/>')
    bx, by = BERRY_BASE
    return defs, f'<g transform="translate({f(bx)} {f(by)}) scale({BERRY_K}) translate({f(-bx)} {f(-by)})">{body}</g>'


BERRY_K = 1.3                      # 딸기 확대 (앉는 점 기준)
BERRY_BOX = (BERRY_BASE[0] - 34 * BERRY_K, BERRY_BASE[1] - 82 * BERRY_K, BERRY_BASE[0] + 34 * BERRY_K, BERRY_BASE[1] + 8 * BERRY_K)
MARK_BOX = (CT[0] - SW, BERRY_BOX[1], CB2[0] + 30, CT[1] + CHT + SW)
EN_TX = MARK_BOX[2] + 30
_mid = (MARK_BOX[1] + MARK_BOX[3]) / 2
SC_D, SC_B = BAGEL.path('STRAWBERRY CAKE', 74, EN_TX, _mid - 2, 'start', 1.5)
ENG_D, ENG_B = KRONA.path('ENGINE', 30, EN_TX + 4, _mid + 58, 'start', 21)
EN_RULE = (ENG_B[2] + 22, (ENG_B[1] + ENG_B[3]) / 2 - 1.2, SC_B[2], (ENG_B[1] + ENG_B[3]) / 2 + 1.2)
EN_BOX = union(MARK_BOX, SC_B, ENG_B)


def en_text(p, dark=True):
    sub_c = '#f6e3d6' if dark else INK
    defs = (f'<linearGradient id="{p}sc" gradientUnits="userSpaceOnUse" x1="0" y1="{f(SC_B[1])}" x2="0" y2="{f(SC_B[3])}">'
            '<stop offset="0" stop-color="#ff8fa0"/><stop offset=".5" stop-color="#f2475e"/><stop offset="1" stop-color="#d42a44"/></linearGradient>'
            f'<linearGradient id="{p}er" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#f2475e"/><stop offset="1" stop-color="#f2475e" stop-opacity="0"/></linearGradient>')
    outer = f'<path d="{SC_D}" fill="#fff6ec" stroke="#fff6ec" stroke-width="16" stroke-linejoin="round"/>' if dark else ''
    word = (outer + f'<path d="{SC_D}" fill="{INK}" stroke="{INK}" stroke-width="9" stroke-linejoin="round"/>'
            f'<path d="{SC_D}" fill="url(#{p}sc)"/>')
    r = EN_RULE
    sub = (f'<path d="{ENG_D}" fill="{sub_c}"/>'
           f'<rect x="{f(r[0])}" y="{f(r[1])}" width="{f(r[2] - r[0])}" height="{f(r[3] - r[1])}" fill="url(#{p}er)"/>')
    return defs, word, sub


# =====================================================================================
# 정적 가로 로고
# =====================================================================================
for dark, suffix in ((True, ''), (False, '-light')):
    sd, sb = ms_gear_shadow('a', dark); gd, gb = ms_gear('b'); td, tw, ts = ms_text('c', dark)
    write(f'brand/monatium-studio{suffix}.svg', svg_doc(
        grow(MS_BOX, 22, 10),
        '<!-- MONATIUM STUDIO horizontal logo. Gear mark: vector trace of the elf race icon from Trickcal Revive (EPIDGames). Type: Krona One, Michroma (OFL), outlined. -->\n'
        + sb + gb + tw + ts, sd + gd + td, ' role="img" aria-label="MONATIUM STUDIO"'))

    cd, cb = cake_body('k'); bd, bb = berry_body('k'); ed, ew, es = en_text('t', dark)
    write(f'brand/strawberry-cake-engine{suffix}.svg', svg_doc(
        grow(EN_BOX, 16),
        '<!-- STRAWBERRY CAKE ENGINE logo. Original design by Monatium Studio. Type: Bagel Fat One, Krona One (OFL), outlined. -->\n'
        + cb + bb + ew + es, cd + bd + ed, ' role="img" aria-label="STRAWBERRY CAKE ENGINE"'))

cd, cb = cake_body('k'); bd, bb = berry_body('k')
mb = MARK_BOX
side = max(mb[2] - mb[0], mb[3] - mb[1]) + 24
mcx, mcy = (mb[0] + mb[2]) / 2, (mb[1] + mb[3]) / 2
write('brand/strawberry-cake-engine-mark.svg', svg_doc(
    (mcx - side / 2, mcy - side / 2, mcx + side / 2, mcy + side / 2),
    '<!-- STRAWBERRY CAKE ENGINE mark. Original design by Monatium Studio. -->\n' + cb + bb, cd + bd,
    ' role="img" aria-label="STRAWBERRY CAKE ENGINE"'))

# =====================================================================================
# 인트로 첫 카드: 왼쪽 Produced by + 스튜디오, 가운데 세로선, 오른쪽 Powered by + 엔진
# =====================================================================================
CW, CH = 1800, 460
LX, RX, MY = 450, 1350, 262        # 두 로고 가운데, 로고 세로 가운데
FIT = 640                          # 로고 너비
layers = []


def place(box, cx, cy, width):
    s = width / (box[2] - box[0])
    return s, cx - (box[0] + box[2]) / 2 * s, cy - (box[1] + box[3]) / 2 * s


def layer(lid, nat_box, body, defs, tr, origin_nat=None):
    s, dx, dy = tr
    box = xform(nat_box, s, dx, dy)
    src = f'src/intro/assets/credits-{lid}.svg'
    write(src, svg_doc(box, f'<g transform="translate({f(dx)} {f(dy)}) scale({f(s)})">{body}</g>', defs))
    o = ((box[0] + box[2]) / 2, (box[1] + box[3]) / 2) if origin_nat is None else (origin_nat[0] * s + dx, origin_nat[1] * s + dy)
    layers.append({'id': lid, 'file': f'credits-{lid}.svg', 'box': [round(box[0], 2), round(box[1], 2), round(box[2] - box[0], 2), round(box[3] - box[1], 2)],
                   'origin': [round(o[0], 2), round(o[1], 2)]})


trL = place(MS_BOX, LX, MY, FIT)
trR = place(EN_BOX, RX, MY, FIT * 0.98)

sd, sb = ms_gear_shadow('a'); gd, gb = ms_gear('b'); td, tw, ts = ms_text('c')
layer('ms-gear-shadow', grow(GEAR_BOX, 34, 12), sb, sd, trL, (GPX, GPY + 9 * K))
layer('ms-gear', grow(GEAR_BOX, 8), gb, gd, trL, (GPX, GPY))
layer('ms-word', grow(MON_B, 14, 8), tw, td, trL)
layer('ms-sub', grow(union(STU_B, MS_RULE), 12, 8), ts, td, trL)

cd, cb = cake_body('k'); bd, bb = berry_body('k'); ed, ew, es = en_text('t')
layer('en-cake', grow((CT[0], CB1[1] - 4, CB2[0] + 30, CT[1] + CHT), 8), cb, cd, trR, ((CT[0] + CB2[0]) / 2, CB2[1] + CHT))
layer('en-berry', BERRY_BOX, bb, bd, trR, BERRY_BASE)
layer('en-word', grow(SC_B, 14), ew, ed, trR)
layer('en-sub', grow(union(ENG_B, EN_RULE), 8), es, ed, trR)

# 라벨: 각 로고 위, 로고 왼쪽 끝에 맞춘다
lbl_y = 128
for lid, text, tr, box in (('lbl-produced', 'PRODUCED BY', trL, MS_BOX), ('lbl-powered', 'POWERED BY', trR, EN_BOX)):
    x0 = box[0] * tr[0] + tr[1]
    d, b = MICHROMA.path(text, 15, x0 + 2, lbl_y, 'start', 7)
    src_box = grow(b, 6)
    write(f'src/intro/assets/credits-{lid}.svg', svg_doc(src_box, f'<path d="{d}" fill="#8f959c"/>'))
    layers.append({'id': lid, 'file': f'credits-{lid}.svg', 'box': [round(src_box[0], 2), round(src_box[1], 2), round(src_box[2] - src_box[0], 2), round(src_box[3] - src_box[1], 2)],
                   'origin': [round(b[0], 2), round((b[1] + b[3]) / 2, 2)]})

# 가운데 세로선
div_box = (CW / 2 - 2, 110, CW / 2 + 2, 400)
write('src/intro/assets/credits-divider.svg', svg_doc(div_box,
      f'<rect x="{f(CW / 2 - 0.8)}" y="110" width="1.6" height="290" fill="url(#dv)"/>',
      '<linearGradient id="dv" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9aa0a6" stop-opacity="0"/>'
      '<stop offset=".5" stop-color="#9aa0a6" stop-opacity=".7"/><stop offset="1" stop-color="#9aa0a6" stop-opacity="0"/></linearGradient>'))
layers.insert(0, {'id': 'divider', 'file': 'credits-divider.svg', 'box': [div_box[0], div_box[1], 4, 290], 'origin': [CW / 2, 255]})

# 광택 마스크: 톱니 + MONATIUM + STRAWBERRY CAKE
s, dx, dy = trL
s2, dx2, dy2 = trR
write('src/intro/assets/credits-sheen-mask.svg', svg_doc((0, 0, CW, CH),
      f'<g fill="#fff"><g transform="translate({f(dx)} {f(dy)}) scale({f(s)})"><use href="#g" transform="scale({f(GS)})"/><path d="{MON_D}"/></g>'
      f'<g transform="translate({f(dx2)} {f(dy2)}) scale({f(s2)})"><path d="{SC_D}" stroke="#fff" stroke-width="9" stroke-linejoin="round"/></g></g>',
      f'<path id="g" d="{GD}"/>'))

# 배치 정보: 정적 new URL(...)이어야 번들러가 파일을 함께 내보낸다
ts_lines = ['// 생성 파일: tools/brand/gen_brand.py. 손으로 고치지 않는다.', "import type { IntroLayer } from './Intro';", '',
            f'export const CREDITS_STAGE: [number, number] = [{CW}, {CH}];', '', 'export const CREDITS_LAYERS: IntroLayer[] = [']
for L in layers:
    ts_lines.append(f"  {{ id: '{L['id']}', url: new URL('./assets/{L['file']}', import.meta.url).href, box: {json.dumps(L['box'])}, origin: {json.dumps(L['origin'])} }},")
ts_lines += ['];', '', "export const CREDITS_SHEEN = new URL('./assets/credits-sheen-mask.svg', import.meta.url).href;", '']
write('src/intro/credits.layout.ts', '\n'.join(ts_lines))
print('credits layers', [L['id'] for L in layers])
