/* QP Cropper — crop PDF margins and combine pages, fully client-side. */
(() => {
  'use strict';

  const PDFJS_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
  pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_BASE + 'pdf.worker.min.js';
  const { PDFDocument, rgb, degrees } = PDFLib;

  const MM = 72 / 25.4;          // points per millimetre
  const DETECT_SCALE = 1.25;     // render scale used for whitespace detection
  const THUMB_W = 260;           // thumbnail width in px
  const SHEETS = {
    a4: [595.28, 841.89],
    a4l: [841.89, 595.28],
    letter: [612, 792],
  };

  const $ = (id) => document.getElementById(id);
  const el = {
    drop: $('drop'), file: $('file'), pick: $('pick'), workspace: $('workspace'),
    fname: $('fname'), finfo: $('finfo'), another: $('another'), notice: $('notice'),
    mode: $('mode'), pad: $('pad'), padVal: $('padVal'), thr: $('thr'), thrVal: $('thrVal'),
    tTop: $('tTop'), tBottom: $('tBottom'), tLeft: $('tLeft'), tRight: $('tRight'),
    range: $('range'), nup1: $('nup1'), nup: $('nup'), dir: $('dir'), size: $('size'),
    mar: $('mar'), marVal: $('marVal'), gap: $('gap'), gapVal: $('gapVal'),
    sameScale: $('sameScale'), divider: $('divider'), dpiWrap: $('dpiWrap'), dpi: $('dpi'),
    go: $('go'), progress: $('progress'), srcGrid: $('srcGrid'), srcCount: $('srcCount'),
    outTab: $('outTab'), outPane: $('outPane'), outInfo: $('outInfo'), outGrid: $('outGrid'),
    download: $('download'),
    pwDialog: $('pwDialog'), pwForm: $('pwForm'), pwMsg: $('pwMsg'), pwInput: $('pwInput'),
    pwShow: $('pwShow'), pwCancel: $('pwCancel'),
  };

  const state = {
    name: '',
    bytes: null,        // original file bytes
    doc: null,          // pdf.js document
    password: null,
    vector: true,       // false when pdf-lib cannot read the file (encrypted) → raster output
    pages: [],          // { w, h, gray, gw, gh, bbox, thumb, card, box }
    nup1: 3,            // pages on the first sheet
    nup: 2,             // pages on every later sheet
    outUrl: null,
  };

  /* ---------------- file loading ---------------- */

  el.pick.addEventListener('click', () => el.file.click());
  el.drop.addEventListener('click', (e) => { if (e.target === el.drop) el.file.click(); });
  el.another.addEventListener('click', () => el.file.click());
  el.file.addEventListener('change', () => { if (el.file.files[0]) openFile(el.file.files[0]); el.file.value = ''; });
  ['dragenter', 'dragover'].forEach((t) => document.addEventListener(t, (e) => { e.preventDefault(); el.drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => document.addEventListener(t, (e) => { e.preventDefault(); el.drop.classList.remove('over'); }));
  document.addEventListener('drop', (e) => {
    const f = [...(e.dataTransfer?.files || [])].find((x) => /pdf$/i.test(x.type) || /\.pdf$/i.test(x.name));
    if (f) openFile(f);
  });

  function askPassword(retry) {
    return new Promise((resolve) => {
      el.pwMsg.textContent = retry
        ? 'Incorrect password. Please try again.'
        : 'This PDF is protected. Enter its password to open it.';
      el.pwMsg.classList.toggle('err', !!retry);
      el.pwInput.value = '';
      el.pwDialog.showModal();
      el.pwInput.focus();
      const done = (val) => {
        el.pwForm.removeEventListener('submit', onSubmit);
        el.pwCancel.removeEventListener('click', onCancel);
        el.pwDialog.removeEventListener('cancel', onCancel);
        el.pwDialog.close();
        resolve(val);
      };
      const onSubmit = (e) => { e.preventDefault(); done(el.pwInput.value); };
      const onCancel = (e) => { e.preventDefault(); done(null); };
      el.pwForm.addEventListener('submit', onSubmit);
      el.pwCancel.addEventListener('click', onCancel);
      el.pwDialog.addEventListener('cancel', onCancel);
    });
  }
  el.pwShow.addEventListener('change', () => { el.pwInput.type = el.pwShow.checked ? 'text' : 'password'; });

  function openPdfjs(bytes) {
    let password = null;
    const task = pdfjsLib.getDocument({
      data: bytes.slice(),   // pdf.js transfers the buffer to its worker
      cMapUrl: PDFJS_BASE + 'cmaps/',
      cMapPacked: true,
      standardFontDataUrl: PDFJS_BASE + 'standard_fonts/',
    });
    task.onPassword = async (update, reason) => {
      const retry = reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD;
      const pw = await askPassword(retry);
      if (pw === null) { task.destroy(); return; }
      password = pw;
      update(pw);
    };
    return task.promise.then((doc) => ({ doc, password }));
  }

  async function openFile(file) {
    resetOutput();
    setProgress('Opening…');
    const bytes = new Uint8Array(await file.arrayBuffer());
    let opened;
    try {
      opened = await openPdfjs(bytes);
    } catch (err) {
      setProgress('');
      if (err?.name === 'PasswordException' || /destroy/i.test(String(err?.message))) {
        alert('The PDF could not be opened without its password.');
      } else {
        alert('Could not open this file as a PDF.\n\n' + (err?.message || err));
      }
      return;
    }

    if (state.doc) state.doc.destroy();
    Object.assign(state, { name: file.name, bytes, doc: opened.doc, password: opened.password, pages: [] });

    // pdf-lib keeps the output vector (sharp text, small file). If it cannot read or
    // decrypt the file, fall back to rebuilding it from high-resolution renders.
    state.vector = true;
    try {
      await loadForEdit();
    } catch (e) {
      console.warn('Vector mode unavailable, using images:', e);
      state.vector = false;
    }

    el.drop.hidden = true;
    el.workspace.hidden = false;
    el.fname.textContent = file.name;
    el.finfo.textContent = `${state.doc.numPages} page${state.doc.numPages > 1 ? 's' : ''} · ${(file.size / 1024 / 1024).toFixed(2)} MB`
      + (state.password !== null ? ' · password protected' : '');
    el.dpiWrap.hidden = state.vector;
    el.notice.hidden = state.vector;
    el.notice.textContent = state.vector ? '' :
      'This PDF uses encryption or a structure that cannot be edited directly, so the result is built from '
      + 'high-resolution page images (text will not be selectable). '
      + 'Choose the image quality in the Combine panel.';
    el.srcCount.textContent = `(${state.doc.numPages})`;
    showTab('src');
    await analyse();
  }

  function loadForEdit() {
    // an empty password also unlocks "owner-only" PDFs (open freely, but editing restricted)
    return PDFDocument.load(state.bytes, { updateMetadata: false, password: state.password ?? '' });
  }

  /* ---------------- whitespace detection ---------------- */

  async function analyse() {
    el.srcGrid.innerHTML = '';
    const n = state.doc.numPages;
    for (let i = 1; i <= n; i++) {
      setProgress(`Analysing page ${i} of ${n}…`);
      const page = await state.doc.getPage(i);
      const vp = page.getViewport({ scale: DETECT_SCALE });
      const c = document.createElement('canvas');
      c.width = Math.ceil(vp.width);
      c.height = Math.ceil(vp.height);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;

      // keep a 1-byte-per-pixel "darkest channel" map so threshold changes are instant
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      const gray = new Uint8Array(c.width * c.height);
      for (let p = 0, q = 0; q < gray.length; p += 4, q++) {
        gray[q] = Math.min(data[p], data[p + 1], data[p + 2]);
      }

      const thumb = document.createElement('canvas');
      thumb.width = THUMB_W;
      thumb.height = Math.round(THUMB_W * c.height / c.width);
      thumb.getContext('2d').drawImage(c, 0, 0, thumb.width, thumb.height);

      const card = document.createElement('div');
      card.className = 'thumb';
      card.innerHTML = '<div class="frame"></div><div class="cap"><span></span><span></span></div>';
      const frame = card.firstChild;
      frame.appendChild(thumb);
      const box = document.createElement('div');
      box.className = 'box';
      frame.appendChild(box);
      card.querySelector('.cap span').textContent = `Page ${i}`;
      el.srcGrid.appendChild(card);

      const vp1 = page.getViewport({ scale: 1 });
      state.pages.push({ w: vp1.width, h: vp1.height, gray, gw: c.width, gh: c.height, bbox: null, card, box });
      page.cleanup();
    }
    setProgress('');
    updateCrops();
  }

  // Bounding box of non-white content, in points (top-left origin, as displayed).
  function detect(p, thr) {
    const { gray, gw, gh } = p;
    const minRun = 2; // ignore rows/columns with fewer dark pixels than this (dust/specks)
    const rows = new Uint32Array(gh);
    const cols = new Uint32Array(gw);
    for (let y = 0; y < gh; y++) {
      const off = y * gw;
      for (let x = 0; x < gw; x++) {
        if (gray[off + x] < thr) { rows[y]++; cols[x]++; }
      }
    }
    let y0 = 0, y1 = gh - 1, x0 = 0, x1 = gw - 1;
    while (y0 < gh && rows[y0] < minRun) y0++;
    if (y0 >= gh) return null; // blank page
    while (y1 > y0 && rows[y1] < minRun) y1--;
    while (x0 < gw && cols[x0] < minRun) x0++;
    while (x1 > x0 && cols[x1] < minRun) x1--;
    const s = 1 / DETECT_SCALE;
    return { x0: x0 * s, y0: y0 * s, x1: (x1 + 1) * s, y1: (y1 + 1) * s };
  }

  function selectedPages() {
    const n = state.pages.length;
    const txt = el.range.value.trim();
    if (!txt) return [...Array(n).keys()];
    const set = new Set();
    for (const part of txt.split(/[,;\s]+/).filter(Boolean)) {
      const m = part.match(/^(\d*)\s*-\s*(\d*)$/);
      if (m) {
        const a = m[1] ? +m[1] : 1;
        const b = m[2] ? +m[2] : n;
        for (let i = Math.max(1, a); i <= Math.min(n, b); i++) set.add(i - 1);
      } else if (/^\d+$/.test(part)) {
        const i = +part;
        if (i >= 1 && i <= n) set.add(i - 1);
      }
    }
    return [...set].sort((a, b) => a - b);
  }

  // Final crop rectangle per page (points, top-left origin) after mode, padding and trims.
  function computeCrops() {
    const thr = +el.thr.value;
    const pad = +el.pad.value * MM;
    const trim = {
      t: (+el.tTop.value || 0) * MM, b: (+el.tBottom.value || 0) * MM,
      l: (+el.tLeft.value || 0) * MM, r: (+el.tRight.value || 0) * MM,
    };
    const sel = selectedPages();
    const boxes = state.pages.map((p) => detect(p, thr));
    const used = sel.map((i) => boxes[i]).filter(Boolean);
    const union = used.length ? {
      x0: Math.min(...used.map((b) => b.x0)), y0: Math.min(...used.map((b) => b.y0)),
      x1: Math.max(...used.map((b) => b.x1)), y1: Math.max(...used.map((b) => b.y1)),
    } : null;

    return state.pages.map((p, i) => {
      let b = boxes[i] || { x0: 0, y0: 0, x1: p.w, y1: p.h };
      if (union && el.mode.value === 'union') b = { ...union };
      if (union && el.mode.value === 'width') b = { ...b, x0: union.x0, x1: union.x1 };
      let x0 = b.x0 - pad + trim.l, x1 = b.x1 + pad - trim.r;
      let y0 = b.y0 - pad + trim.t, y1 = b.y1 + pad - trim.b;
      x0 = clamp(x0, 0, p.w); x1 = clamp(x1, 0, p.w);
      y0 = clamp(y0, 0, p.h); y1 = clamp(y1, 0, p.h);
      if (x1 - x0 < 10) { x0 = 0; x1 = p.w; }
      if (y1 - y0 < 10) { y0 = 0; y1 = p.h; }
      return { x0, y0, x1, y1, blank: !boxes[i] };
    });
  }

  function updateCrops() {
    el.padVal.textContent = `${el.pad.value} mm`;
    el.thrVal.textContent = el.thr.value;
    el.marVal.textContent = `${el.mar.value} mm`;
    el.gapVal.textContent = `${el.gap.value} mm`;
    if (!state.pages.length) return;
    const crops = computeCrops();
    const sel = new Set(selectedPages());
    state.pages.forEach((p, i) => {
      const c = crops[i];
      p.crop = c;
      Object.assign(p.box.style, {
        left: `${(c.x0 / p.w) * 100}%`, top: `${(c.y0 / p.h) * 100}%`,
        width: `${((c.x1 - c.x0) / p.w) * 100}%`, height: `${((c.y1 - c.y0) / p.h) * 100}%`,
      });
      p.card.classList.toggle('off', !sel.has(i));
      const saved = 100 - (((c.x1 - c.x0) * (c.y1 - c.y0)) / (p.w * p.h)) * 100;
      p.card.querySelectorAll('.cap span')[1].textContent = c.blank ? 'blank' : `−${Math.round(saved)}% area`;
    });
  }

  /* ---------------- building the output ---------------- */

  el.go.addEventListener('click', () => build().catch((e) => {
    console.error(e);
    setProgress('');
    el.go.disabled = false;
    alert('Something went wrong while creating the PDF:\n\n' + (e?.message || e));
  }));

  async function build() {
    el.go.disabled = true;
    updateCrops();
    const sel = selectedPages();
    if (!sel.length) throw new Error('No pages selected.');

    const out = await PDFDocument.create();
    const items = state.vector ? await vectorItems(out, sel) : await rasterItems(out, sel);
    layout(out, items);

    setProgress('Saving…');
    const bytes = await out.save();
    showResult(bytes, items.length);
    el.go.disabled = false;
  }

  // Each item: displayed size (w, h in points) and a draw(page, x, y, scale) function.
  async function vectorItems(out, sel) {
    const src = await loadForEdit();
    const boxes = [], rots = [];
    for (const i of sel) {
      const c = state.pages[i].crop;
      const page = await state.doc.getPage(i + 1);
      const vp = page.getViewport({ scale: 1 });
      // convert the on-screen rectangle into the page's own PDF coordinate space
      const [ax, ay] = vp.convertToPdfPoint(c.x0, c.y0);
      const [bx, by] = vp.convertToPdfPoint(c.x1, c.y1);
      boxes.push({ left: Math.min(ax, bx), right: Math.max(ax, bx), bottom: Math.min(ay, by), top: Math.max(ay, by) });
      rots.push((((page.rotate || 0) % 360) + 360) % 360);
    }
    setProgress('Cropping pages…');
    // one embedPages call shares fonts/images between pages instead of copying them per page
    const embs = await out.embedPages(sel.map((i) => src.getPage(i)), boxes);
    return sel.map((i, n) => {
      const c = state.pages[i].crop;
      const box = boxes[n], emb = embs[n], rot = rots[n];
      const ew = box.right - box.left, eh = box.top - box.bottom;
      return {
        w: c.x1 - c.x0,
        h: c.y1 - c.y0,
        draw(pg, x, y, s) {
          // pdf-lib rotates counter-clockwise about (x, y); PDF /Rotate is clockwise
          const W = ew * s, H = eh * s;
          const o = { width: W, height: H, rotate: degrees(-rot) };
          if (rot === 0) Object.assign(o, { x, y });
          else if (rot === 90) Object.assign(o, { x, y: y + W });
          else if (rot === 180) Object.assign(o, { x: x + W, y: y + H });
          else Object.assign(o, { x: x + H, y });
          pg.drawPage(emb, o);
        },
      };
    });
  }

  async function rasterItems(out, sel) {
    const scale = +el.dpi.value / 72;
    const items = [];
    for (const i of sel) {
      setProgress(`Rendering page ${i + 1}…`);
      const c = state.pages[i].crop;
      const page = await state.doc.getPage(i + 1);
      const vp = page.getViewport({ scale });
      const full = document.createElement('canvas');
      full.width = Math.ceil(vp.width);
      full.height = Math.ceil(vp.height);
      const fctx = full.getContext('2d');
      fctx.fillStyle = '#fff';
      fctx.fillRect(0, 0, full.width, full.height);
      await page.render({ canvasContext: fctx, viewport: vp }).promise;

      const cut = document.createElement('canvas');
      cut.width = Math.max(1, Math.round((c.x1 - c.x0) * scale));
      cut.height = Math.max(1, Math.round((c.y1 - c.y0) * scale));
      cut.getContext('2d').drawImage(full, Math.round(c.x0 * scale), Math.round(c.y0 * scale), cut.width, cut.height, 0, 0, cut.width, cut.height);
      const blob = await new Promise((r) => cut.toBlob(r, 'image/jpeg', 0.9));
      const img = await out.embedJpg(await blob.arrayBuffer());
      full.width = full.height = 0;
      page.cleanup();
      items.push({
        w: c.x1 - c.x0,
        h: c.y1 - c.y0,
        draw(pg, x, y, s) { pg.drawImage(img, { x, y, width: this.w * s, height: this.h * s }); },
      });
    }
    return items;
  }

  function layout(out, items) {
    const vertical = el.dir.value === 'v';
    const m = +el.mar.value * MM;
    const g = +el.gap.value * MM;
    // the first sheet holds state.nup1 pages, every later sheet state.nup
    const groups = [], caps = [];
    for (let i = 0; i < items.length;) {
      const k = groups.length ? state.nup : state.nup1;
      groups.push(items.slice(i, i + k));
      caps.push(k);
      i += k;
    }

    // content size of each group at scale 1
    const dims = groups.map((grp) => {
      const gaps = (grp.length - 1) * g;
      return vertical
        ? { cw: Math.max(...grp.map((it) => it.w)), ch: grp.reduce((a, it) => a + it.h, 0) + gaps, gaps }
        : { cw: grp.reduce((a, it) => a + it.w, 0) + gaps, ch: Math.max(...grp.map((it) => it.h)), gaps };
    });

    const fixed = SHEETS[el.size.value];
    let scales;
    if (!fixed) {
      scales = groups.map(() => 1);
    } else {
      const [W, H] = fixed;
      // gaps do not scale, so solve for scale on the content part only
      scales = dims.map((d) => vertical
        ? Math.min((W - 2 * m) / d.cw, (H - 2 * m - d.gaps) / (d.ch - d.gaps))
        : Math.min((W - 2 * m - d.gaps) / (d.cw - d.gaps), (H - 2 * m) / d.ch));
      if (el.sameScale.checked) {
        // use the scale that fits a *full* sheet; a short last sheet must not get bigger text
        const full = scales.filter((_, i) => groups[i].length === caps[i]);
        const s = Math.min(...(full.length ? full : scales));
        scales = scales.map(() => s);
      }
    }

    groups.forEach((grp, gi) => {
      const s = scales[gi];
      const d = dims[gi];
      const contentW = vertical ? d.cw * s : (d.cw - d.gaps) * s + d.gaps;
      const contentH = vertical ? (d.ch - d.gaps) * s + d.gaps : d.ch * s;
      const [W, H] = fixed || [contentW + 2 * m, contentH + 2 * m];
      const pg = out.addPage([W, H]);
      if (vertical) {
        let top = H - m;
        grp.forEach((it, idx) => {
          const w = it.w * s, h = it.h * s;
          it.draw(pg, (W - w) / 2, top - h, s);
          top -= h;
          if (idx < grp.length - 1) {
            if (el.divider.checked) line(pg, (W - contentW) / 2, top - g / 2, (W + contentW) / 2, top - g / 2);
            top -= g;
          }
        });
      } else {
        let left = (W - contentW) / 2;
        const top = H - (fixed ? (H - contentH) / 2 : m);
        grp.forEach((it, idx) => {
          const w = it.w * s, h = it.h * s;
          it.draw(pg, left, top - h, s);
          left += w;
          if (idx < grp.length - 1) {
            if (el.divider.checked) line(pg, left + g / 2, top, left + g / 2, top - contentH);
            left += g;
          }
        });
      }
    });
  }

  function line(pg, x1, y1, x2, y2) {
    pg.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 0.5, color: rgb(0.7, 0.7, 0.7), dashArray: [3, 2] });
  }

  async function showResult(bytes, srcCount) {
    if (state.outUrl) URL.revokeObjectURL(state.outUrl);
    state.outUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    el.download.href = state.outUrl;
    const { nup1, nup } = state;
    const suffix = nup1 !== nup ? `_${nup1}-${nup}up` : nup > 1 ? `_${nup}up` : '_cropped';
    el.download.download = state.name.replace(/\.pdf$/i, '') + suffix + '.pdf';
    el.outTab.disabled = false;
    showTab('out');

    setProgress('Rendering preview…');
    const doc = await pdfjsLib.getDocument({ data: bytes.slice(), cMapUrl: PDFJS_BASE + 'cmaps/', cMapPacked: true }).promise;
    el.outInfo.textContent = `${srcCount} page${srcCount > 1 ? 's' : ''} → ${doc.numPages} sheet${doc.numPages > 1 ? 's' : ''} · ${(bytes.length / 1024 / 1024).toFixed(2)} MB`;
    el.outGrid.innerHTML = '';
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: 520 / base.width });
      const c = document.createElement('canvas');
      c.width = Math.ceil(vp.width);
      c.height = Math.ceil(vp.height);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const card = document.createElement('div');
      card.className = 'thumb';
      card.innerHTML = '<div class="frame"></div><div class="cap"><span></span></div>';
      card.firstChild.appendChild(c);
      card.querySelector('.cap span').textContent = `Sheet ${i}`;
      el.outGrid.appendChild(card);
    }
    doc.destroy();
    setProgress('Done ✓');
  }

  /* ---------------- UI wiring ---------------- */

  function showTab(name) {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === name));
    el.srcGrid.hidden = name !== 'src';
    el.outPane.hidden = name !== 'out';
  }
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => !t.disabled && showTab(t.dataset.tab)));

  function resetOutput() {
    el.outTab.disabled = true;
    el.outGrid.innerHTML = '';
    showTab('src');
  }

  [['nup1', el.nup1], ['nup', el.nup]].forEach(([key, seg]) => seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state[key] = +b.dataset.v;
    seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  }));

  let raf = 0;
  const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(updateCrops); };
  [el.mode, el.pad, el.thr, el.tTop, el.tBottom, el.tLeft, el.tRight, el.range, el.mar, el.gap]
    .forEach((x) => x.addEventListener('input', schedule));

  function setProgress(t) { el.progress.textContent = t; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  updateCrops();
})();
