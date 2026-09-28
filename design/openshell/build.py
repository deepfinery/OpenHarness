"""Build the OpenShell design PDF and local review images, without network access."""
from __future__ import annotations

import html
import math
import re
from pathlib import Path

import fitz
from reportlab import rl_config
from reportlab.graphics.shapes import Drawing, Line, Polygon, Rect, String
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak,
)

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
OUT = HERE.parent / "OpenHarness-OpenShell-Integration.pdf"
REVIEW = ROOT / "data/openshell-design-review"
W, H = 595.276, 841.89
MARGIN = 44
WIDTH = W - 2 * MARGIN
NAVY = "17324D"
TEAL = "087E8B"
BLUE = "315BC6"
ORANGE = "B65C15"
MUTED = "526477"


def color(s):
    return colors.HexColor("#" + s)


font_dir = next(Path(p) for p in rl_config.TTFSearchPath if (Path(p) / "Vera.ttf").exists())
for name, file in [("Design", "Vera.ttf"), ("DesignBold", "VeraBd.ttf")]:
    pdfmetrics.registerFont(TTFont(name, str(font_dir / file)))
pdfmetrics.registerFontFamily("Design", normal="Design", bold="DesignBold", italic="Design", boldItalic="DesignBold")

STYLES = {
    "h1": ParagraphStyle("h1", fontName="DesignBold", fontSize=22, leading=27,
                         textColor=color(NAVY), spaceAfter=15),
    "h2": ParagraphStyle("h2", fontName="DesignBold", fontSize=12, leading=16,
                         textColor=color(TEAL), spaceBefore=10, spaceAfter=8),
    "body": ParagraphStyle("body", fontName="Design", fontSize=9.2, leading=13.6,
                           textColor=color(NAVY), spaceAfter=9),
    "bullet": ParagraphStyle("bullet", fontName="Design", fontSize=9.1, leading=13.3,
                             textColor=color(NAVY), leftIndent=11, firstLineIndent=-8, spaceAfter=7),
    "cell": ParagraphStyle("cell", fontName="Design", fontSize=8.6, leading=12,
                           textColor=color(NAVY)),
}


def inline(s):
    s = html.escape(s)
    s = re.sub(r"\[([^\]]+)\]\((https://[^)]+)\)", r'<link href="\2" color="#087E8B">\1</link>', s)
    s = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", s)
    return re.sub(r"`([^`]+)`", r'<font color="#315BC6">\1</font>', s)


def label(d, x, y, text, size=8, fill=NAVY, bold=False, anchor="middle"):
    d.add(String(x, y, text, fontName="DesignBold" if bold else "Design", fontSize=size,
                 fillColor=color(fill), textAnchor=anchor))


def box(d, x, y, w, h, title, lines=(), fill="FFFFFF", stroke="B5C7D5"):
    d.add(Rect(x, y, w, h, rx=6, ry=6, fillColor=color(fill), strokeColor=color(stroke), strokeWidth=1))
    label(d, x + w / 2, y + h - 17, title, 9, bold=True)
    for i, line in enumerate(lines):
        label(d, x + w / 2, y + h - 32 - i * 12, line, 7.7, MUTED)


def arrow(d, points, stroke=BLUE, dashed=False):
    for a, b in zip(points, points[1:]):
        line = Line(*a, *b, strokeColor=color(stroke), strokeWidth=1.4)
        if dashed:
            line.strokeDashArray = [3, 3]
        d.add(line)
    a, b = points[-2:]
    theta = math.atan2(b[1] - a[1], b[0] - a[0])
    tip = [b[0], b[1]]
    for delta in (-0.45, 0.45):
        tip.extend([b[0] - 6 * math.cos(theta + delta), b[1] - 6 * math.sin(theta + delta)])
    d.add(Polygon(tip, fillColor=color(stroke), strokeColor=color(stroke)))


def deployment():
    d = Drawing(WIDTH, 410)
    d.add(Rect(0, 311, WIDTH, 97, rx=8, fillColor=color("EDF4FB"), strokeColor=color("BCD0E3")))
    label(d, 13, 391, "OPENHARNESS  |  existing trusted services", 9, bold=True, anchor="start")
    box(d, 15, 324, 196, 53, "apps/runner", ["Harness agent + normal MCP checks"])
    box(d, 285, 324, 205, 53, "apps/api", ["New MCP facade + lifecycle adapter"])
    arrow(d, [(211, 350), (285, 350)], TEAL)
    label(d, 248, 360, "MCP", 7, TEAL)
    d.add(Rect(0, 0, WIDTH, 282, rx=8, fillColor=color("F4F7FA"), strokeColor=color("BCD0E3")))
    label(d, 286, 263, "REMOTE LINUX MACHINE", 9, bold=True, anchor="start")
    box(d, 15, 203, 205, 46, "OpenShell gateway", ["Control plane + Docker driver"], fill="EAF0FF", stroke=BLUE)
    arrow(d, [(330, 324), (330, 301), (82, 301), (82, 249)], BLUE)
    label(d, 151, 306, "1  SDK lifecycle", 7.5, BLUE)
    arrow(d, [(440, 324), (440, 288), (185, 288), (185, 249)], TEAL)
    label(d, 320, 291, "2  HTTPS MCP service URL", 7.5, TEAL)
    box(d, 15, 103, 205, 67, "OpenShell supervisor", ["Separate trusted container", "Policy / credentials / network proxy"], fill="FFF6EC", stroke=ORANGE)
    arrow(d, [(65, 170), (65, 203)], BLUE)
    label(d, 76, 183, "Outbound control session", 7, BLUE, anchor="start")
    arrow(d, [(206, 203), (206, 170)], TEAL)
    d.add(Rect(286, 95, 205, 150, rx=8, fillColor=color("EAF7F5"), strokeColor=color(TEAL), strokeWidth=1.6))
    label(d, 388, 228, "ISOLATED WORKLOAD", 9, TEAL, True)
    box(d, 298, 169, 181, 46, "openshell-sandbox", ["Landlock + seccomp / process owner"])
    box(d, 298, 109, 181, 43, "Remote agent + MCP server", ["Non-root / workspace / local port"])
    arrow(d, [(388, 169), (388, 152)], BLUE)
    arrow(d, [(220, 151), (286, 151)], TEAL)
    label(d, 253, 163, "Relay", 7, TEAL)
    arrow(d, [(286, 119), (220, 119)], ORANGE)
    label(d, 253, 106, "Egress", 7, ORANGE)
    label(d, 389, 80, "No direct external network", 7.5, TEAL, True)
    box(d, 15, 13, 205, 48, "Approved destinations", ["Model / remote MCP / APIs"], fill="FFF6EC", stroke=ORANGE)
    arrow(d, [(118, 103), (118, 61)], ORANGE)
    label(d, 130, 80, "3  Authorize + inject", 7, ORANGE, anchor="start")
    label(d, 383, 45, "Device connector path coexists", 8, MUTED)
    label(d, 383, 31, "through the separate device gateway", 7.5, MUTED)
    return d


def sequence():
    d = Drawing(WIDTH, 333)
    xs = [49, 181, 316, 453]
    titles = ["Runner", "API facade", "OpenShell", "Remote agent"]
    subtitles = ["normal MCP checks", "lifecycle + ledger", "gateway / supervisor", "MCP service"]
    for x, title, sub in zip(xs, titles, subtitles):
        box(d, x - 48, 291, 96, 40, title, [sub])
        d.add(Line(x, 12, x, 289, strokeColor=color("BDCAD6"), strokeDashArray=[3, 3]))

    def msg(a, b, y, t, c=TEAL, dashed=False):
        arrow(d, [(xs[a], y), (xs[b], y)], c, dashed)
        label(d, (xs[a] + xs[b]) / 2, y + 7, t, 7.3, c)

    label(d, xs[0], 275, "Guardrail + approval", 7.3, NAVY, True)
    msg(0, 1, 251, "1  delegate_task")
    label(d, xs[1], 233, "Verify context; reserve", 7.3, NAVY, True)
    msg(1, 0, 211, "Delegation ID", TEAL, True)
    msg(1, 2, 183, "2  Create / policy / ready", BLUE)
    msg(2, 1, 155, "Service URL + identity", BLUE, True)
    msg(1, 3, 127, "3  MCP initialize + task (relayed through OpenShell)")
    label(d, xs[3], 109, "Confined execution", 7.1, ORANGE, True)
    msg(0, 1, 94, "4  task_status")
    msg(3, 1, 70, "Result + reported usage", TEAL, True)
    msg(2, 1, 49, "Trusted policy evidence", ORANGE, True)
    msg(1, 2, 28, "5  Delete + confirm", BLUE)
    msg(1, 0, 7, "Guarded result", TEAL, True)
    return d


def table(rows):
    data = [[Paragraph(inline(c), STYLES["cell"]) for c in row] for row in rows]
    first = WIDTH * (0.33 if len(rows) < 8 else 0.37)
    result = Table(data, colWidths=[first, WIDTH - first], hAlign="LEFT")
    result.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), color("DDEBF0")),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [color("F4F7FA"), colors.white]),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("LINEBELOW", (0, 0), (-1, 0), 0.7, color("A7C1CF")),
    ]))
    return [result, Spacer(1, 10)]


def parse_page(text):
    lines = text.strip().splitlines()
    result = []
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if not line:
            i += 1
            continue
        if line.startswith("| "):
            rows = []
            while i < len(lines) and lines[i].startswith("|"):
                row = [s.strip() for s in lines[i].strip().strip("|").split("|")]
                if not all(re.fullmatch(r"[-: ]+", s) for s in row):
                    rows.append(row)
                i += 1
            result.extend(table(rows))
            continue
        if line.startswith("!["):
            key = re.search(r"\(([^)]+)\)", line).group(1)
            result.extend([{"deployment": deployment, "sequence": sequence}[key](), Spacer(1, 12)])
        elif line.startswith("# "):
            result.append(Paragraph(inline(line[2:]), STYLES["h1"]))
        elif line.startswith("## "):
            result.append(Paragraph(inline(line[3:]), STYLES["h2"]))
        elif line.startswith("- "):
            result.append(Paragraph("• " + inline(line[2:]), STYLES["bullet"]))
        else:
            para = [line]
            while i + 1 < len(lines) and lines[i + 1].strip() and not re.match(r"^(#|\||!\[|- |\d+\. )", lines[i + 1]):
                i += 1
                para.append(lines[i].strip())
            result.append(Paragraph(inline(" ".join(para)), STYLES["body"]))
        i += 1
    return result


def chrome(canvas, doc):
    canvas.setTitle("OpenHarness + NVIDIA OpenShell — Integration Design")
    canvas.setAuthor("OpenHarness")
    canvas.setSubject("Proposed remote-agent confinement architecture for issue #67; OpenShell v0.1.2")
    canvas.setStrokeColor(color(TEAL))
    canvas.setLineWidth(2)
    canvas.line(MARGIN, H - 34, W - MARGIN, H - 34)
    canvas.setFont("Design", 7.2)
    canvas.setFillColor(color(MUTED))
    canvas.drawString(MARGIN, 25, "OPENHARNESS / OPENSHELL     •     DESIGN PROPOSAL     •     28 SEP 2026")
    canvas.drawRightString(W - MARGIN, 25, f"{doc.page} / 9")


def main():
    pages = (HERE / "design.md").read_text().split("---page---")
    story = []
    for i, page in enumerate(pages):
        if i:
            story.append(PageBreak())
        story.extend(parse_page(page))
    doc = SimpleDocTemplate(str(OUT), pagesize=(W, H), rightMargin=MARGIN,
                            leftMargin=MARGIN, topMargin=50, bottomMargin=45,
                            pageCompression=1, invariant=1)
    doc.build(story, onFirstPage=chrome, onLaterPages=chrome)
    pdf = fitz.open(OUT)
    assert len(pdf) == len(pages) == 9, f"Unexpected page overflow: {len(pdf)} pages"
    REVIEW.mkdir(parents=True, exist_ok=True)
    for i, page in enumerate(pdf):
        assert len(page.get_text()) > 400, f"Page {i + 1} unexpectedly sparse"
        for word in page.get_text("words"):
            assert 15 <= word[0] <= word[2] <= W - 15, (i + 1, word)
            assert 15 <= word[1] <= word[3] <= H - 15, (i + 1, word)
        page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5)).save(REVIEW / f"page-{i + 1:02d}.png")
    assert sum(len(page.get_links()) for page in pdf) >= 15, "Expected clickable references"
    print(f"Built {OUT.relative_to(ROOT)}: {len(pdf)} pages; text bounds and links checked")


if __name__ == "__main__":
    main()
