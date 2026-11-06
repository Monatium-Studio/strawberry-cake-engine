"""Google Fonts TTF → SVG path (harfbuzz 셰이핑, 커닝 포함)"""
import uharfbuzz as hb
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen

def _n(v):
    s = f'{v:.2f}'.rstrip('0').rstrip('.')
    return '0' if s in ('-0', '') else s

class Font:
    def __init__(self, path):
        self.tt = TTFont(path)
        self.upem = self.tt['head'].unitsPerEm
        self.gs = self.tt.getGlyphSet()
        self.order = self.tt.getGlyphOrder()
        self.hb = hb.Font(hb.Face(hb.Blob.from_file_path(path)))

    def _layout(self, text, size, x, y, anchor, ls):
        buf = hb.Buffer(); buf.add_str(text); buf.guess_segment_properties()
        hb.shape(self.hb, buf, {'kern': True, 'liga': True})
        s = size / self.upem
        infos, poss = buf.glyph_infos, buf.glyph_positions
        adv = sum(p.x_advance for p in poss) * s + ls * (len(infos) - 1)
        cx = x - adv / 2 if anchor == 'middle' else (x - adv if anchor == 'end' else x)
        out = []
        for info, pos in zip(infos, poss):
            out.append((self.order[info.codepoint], (s, 0, 0, -s, cx + pos.x_offset * s, y - pos.y_offset * s)))
            cx += pos.x_advance * s + ls
        return out

    def path(self, text, size, x, y, anchor='start', ls=0.0):
        """returns (d, (xmin, ymin, xmax, ymax))"""
        pen = SVGPathPen(self.gs, ntos=_n)
        bp = BoundsPen(self.gs)
        for name, tr in self._layout(text, size, x, y, anchor, ls):
            self.gs[name].draw(TransformPen(pen, tr))
            self.gs[name].draw(TransformPen(bp, tr))
        return pen.getCommands(), bp.bounds
