"""Development-only actual-PDF extraction/raster evidence; no synthetic PDF output."""
import argparse
import json
import math
from pathlib import Path

import pymupdf


def box(rect):
    values = list(rect)
    if len(values) != 4 or not all(math.isfinite(v) for v in values):
        raise ValueError("Nonfinite PDF rectangle")
    return values


def rgb_at(pix, x, y):
    x = min(pix.width - 1, max(0, round(x)))
    y = min(pix.height - 1, max(0, round(y)))
    return list(pix.pixel(x, y)[:3])


def dark_pixels(pix, rect):
    r = pymupdf.Rect(rect) * 2
    r &= pymupdf.Rect(0, 0, pix.width, pix.height)
    if r.is_empty:
        return 0
    data = pix.samples_mv
    total = 0
    for y in range(int(r.y0), int(r.y1)):
        start = y * pix.stride + int(r.x0)
        total += sum(value < 190 for value in data[start:start + int(r.x1) - int(r.x0)])
    return total


def drawing_ink(pix, drawing):
    visible = any(drawing[color] is not None and drawing[opacity] > 0 and min(drawing[color]) < .95
                  for color, opacity in [("color", "stroke_opacity"), ("fill", "fill_opacity")])
    return dark_pixels(pix, pymupdf.Rect(drawing["rect"]) + (-1.5, -1.5, 1.5, 1.5)) if visible else 0


def inspect(pdf, out):
    out.mkdir(parents=True, exist_ok=False)
    with pymupdf.open(pdf) as doc:
        if doc.is_encrypted or doc.page_count < 1:
            raise ValueError("Empty or encrypted PDF")
        pages = []
        for i, page in enumerate(doc):
            pix = page.get_pixmap(matrix=pymupdf.Matrix(2, 2), colorspace=pymupdf.csRGB, alpha=False)
            # Luminance detects thin antialiased colored ink too: requiring every
            # RGB channel to be dark incorrectly rejects a visible red minus sign.
            gray = pymupdf.Pixmap(pymupdf.csGRAY, pix)
            raster = out / f"page-{i + 1:03}.png"
            pix.save(raster)
            spans = []
            raw = page.get_text("dict", clip=pymupdf.INFINITE_RECT())
            for block in raw["blocks"]:
                if block["type"] != 0:
                    continue
                for line in block["lines"]:
                    for span in line["spans"]:
                        spans.append({"text": span["text"], "bbox": box(span["bbox"]), "size": span["size"],
                                      "color": span["color"], "font": span["font"], "ink": dark_pixels(gray, span["bbox"])})
            images = []
            for image in page.get_image_info(xrefs=True):
                r = pymupdf.Rect(image["bbox"])
                samples = {}
                for name, u, v in [("tl", .05, .025), ("tr", .95, .025), ("bl", .05, .975), ("br", .95, .975),
                                   ("center", .5, .5), ("top", .5, .003), ("bottom", .5, .997),
                                   ("left", .003, .4), ("right", .997, .4), ("white", .25, .25)]:
                    samples[name] = rgb_at(pix, (r.x0 + u * r.width) * 2, (r.y0 + v * r.height) * 2)
                images.append({"bbox": box(r), "width": image["width"], "height": image["height"], "samples": samples})
            drawings = [{"bbox": box(d["rect"]), "type": d["type"], "color": d["color"], "fill": d["fill"],
                         "width": d["width"], "items": len(d["items"]), "dashes": d["dashes"],
                         "ink": drawing_ink(gray, d),
                         "strokeOpacity": d["stroke_opacity"], "fillOpacity": d["fill_opacity"]}
                        for d in page.get_drawings()]
            words = [{"text": w[4], "bbox": box(w[:4]), "block": w[5], "line": w[6], "word": w[7]}
                     for w in page.get_text("words", clip=pymupdf.INFINITE_RECT())]
            pages.append({"index": i, "width": page.rect.width, "height": page.rect.height,
                          "text": page.get_text("text", clip=pymupdf.INFINITE_RECT()), "spans": spans, "words": words,
                          "drawings": drawings, "images": images, "raster": raster.name, "rasterBytes": raster.stat().st_size,
                          "corners": [rgb_at(pix, x, y) for x, y in [(4, 4), (pix.width - 5, 4), (4, pix.height - 5), (pix.width - 5, pix.height - 5)]]})
        if not any(p["spans"] or p["drawings"] or p["images"] for p in pages):
            raise ValueError("No painted PDF evidence")
        report = {"schema": 1, "tool": "PyMuPDF", "version": pymupdf.VersionBind, "dpi": 144,
                  "pdf": str(pdf.resolve()), "pdfBytes": pdf.stat().st_size, "pageCount": len(pages), "pages": pages}
        (out / "inspection.json").write_text(json.dumps(report, ensure_ascii=False), encoding="utf-8")
        print(json.dumps({"inspection": str(out / "inspection.json"), "pages": len(pages), "version": pymupdf.VersionBind}))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdf", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if not args.pdf.is_file() or args.pdf.stat().st_size < 100:
        parser.error("Missing/empty PDF prerequisite")
    inspect(args.pdf, args.out)


if __name__ == "__main__":
    main()
