# QP Cropper

A small web app that crops the empty margins off PDF pages and combines 2, 3 or 4 pages onto a single sheet — handy for printing question papers with less paper.

Everything runs in your browser. The PDF is never uploaded anywhere.

## Features

- **Automatic margin cropping** – detects the printed area of each page and trims the white space around it.
  - *Same width, trim each page's height* (default) – consistent width, no empty space at the bottom of short pages
  - *Each page separately* or *Same box for all pages*
  - Adjustable padding, whiteness threshold, extra per-side trim and page range
- **N-up** – put 1, 2, 3 or 4 cropped pages on one sheet, stacked or side by side, on A4 / A4 landscape / Letter or a fit-to-content sheet, with optional divider lines. The first sheet can hold a different number of pages from the rest (default: 3 on the first sheet, then 2, so a 5-page question paper fits on 2 sheets).
- **Defaults** – 1 mm padding, side by side on A4 landscape, 1 mm sheet margin and 1 mm gap.
- **Password-protected PDFs** – you'll be asked for the password. PDFs that open freely but restrict editing work too.
- **Vector output** – text stays sharp and selectable. If a file can't be edited directly, it falls back to high-resolution images (150–300 DPI).

## Use it

Open the GitHub Pages site, drop a PDF, adjust the settings, click **Create PDF**, then **Download PDF**.

To run locally, serve the folder with any static web server (opening `index.html` directly from disk also works in most browsers):

```bash
npx serve .
```

## Built with

- [pdf.js](https://mozilla.github.io/pdf.js/) – rendering, decryption and whitespace detection
- [@cantoo/pdf-lib](https://github.com/cantoo-scribe/pdf-lib) – a pdf-lib fork that can open encrypted PDFs; used to build the output

Both are loaded from a CDN, so no build step is needed.
