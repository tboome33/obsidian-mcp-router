#!/usr/bin/env python3
"""
render-pdf-images.py — render a local PDF's pages to PNG images.

Companion script to `src/markdownify/pdf-images.mjs`, which shells out to
this via `execFile`. Same spirit as Docling's subprocess wrapper
(scripts live next to the venv that provides them; the Node side talks
pure argv/stdout, no Python embedding).

Uses **pypdfium2** (a Python binding over Google's PDFium — the engine
behind Chrome's PDF viewer) to rasterize pages, and **Pillow** to write
them out as PNG. Both ship inside `.venv-docling` (the Docling opt-in
extra installed by `scripts/install-docling.mjs`) — no extra install
needed once a user has opted into Docling. This is deliberately NOT
poppler/pdftoppm: pypdfium2 is a pure-wheel pip dependency (no system
package required), matching the router's "self-contained venv" story.

CLI:

    python render-pdf-images.py --out <DIR> --scale <FLOAT> \
        --first <INT> --last <INT> -- <PDF_PATH>

The `--` separator is handled by `argparse` itself: everything after the
first bare `--` is treated as positional arguments, even if it starts
with `-`. This closes the same argv-injection hole that
`buildDoclingArgs` guards against on the Node side — a PDF path of
literally `-x.pdf` can never be reinterpreted as a flag.

Output: one `page-%04d.png` file per rendered page, named by its
1-based page number, written into `--out`. On success, the LAST line of
stdout is exactly:

    RENDERED <count>

No other stdout output is produced (the Node caller does not attempt to
parse anything else, but keeping stdout minimal avoids surprises if it
ever does). Errors propagate as a non-zero exit with a Python traceback
on stderr — the Node wrapper inspects stderr for `ModuleNotFoundError` /
`pypdfium2` / `PIL` to distinguish "not installed" from other failures.
"""
import argparse
import os
import sys

import pypdfium2 as pdfium


def build_parser():
    parser = argparse.ArgumentParser(
        description='Render PDF pages to PNG images via pypdfium2 + Pillow.',
    )
    parser.add_argument('--out', required=True, help='Output directory for rendered PNGs.')
    parser.add_argument('--scale', type=float, required=True, help='Render scale factor (~2.0 ≈ 144 DPI).')
    parser.add_argument('--first', type=int, required=True, help='1-based first page to render.')
    parser.add_argument('--last', type=int, required=True, help='1-based last page to render (inclusive).')
    # Positional — the PDF path. Placed after `--` on the command line so a
    # path beginning with `-` can never be swallowed as an option by argparse.
    parser.add_argument('pdf_path', help='Path to the PDF file to render.')
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)

    pdf = pdfium.PdfDocument(args.pdf_path)
    try:
        n_pages = len(pdf)
        # Clamp the requested range to what the PDF actually has. The Node
        # caller cannot know the true page count without opening the file
        # itself, so a request for e.g. pages 1-30 of a 6-page PDF is
        # expected and handled here rather than treated as an error — the
        # Node side detects the shortfall by counting produced files and
        # reports it (no silent truncation, just an honest count).
        first = max(1, args.first)
        last = min(n_pages, args.last)

        os.makedirs(args.out, exist_ok=True)

        count = 0
        for i in range(first, last + 1):
            page = pdf[i - 1]
            try:
                bitmap = page.render(scale=args.scale)
                try:
                    pil = bitmap.to_pil()
                    out_path = os.path.join(args.out, f"page-{i:04d}.png")
                    pil.save(out_path)
                finally:
                    bitmap.close()
            finally:
                page.close()
            count += 1
    finally:
        pdf.close()

    # Sole stdout contract with the Node wrapper: the last line is
    # "RENDERED <count>". Nothing else is printed.
    print(f"RENDERED {count}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
