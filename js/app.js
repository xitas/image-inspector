/*!
 * PixelPeek – app.js
 * UI controller: file intake, validation, preview, rendering, copy & export.
 * Images never leave the browser – there is no network code in this app,
 * and the page's Content-Security-Policy blocks outgoing connections.
 */
(function () {
  'use strict';

  const MD = window.PixelPeekMetadata;

  const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB
  const LARGE_FILE_SIZE = 25 * 1024 * 1024;
  const ACCEPTED_EXTENSIONS = ['jpg', 'jpeg', 'jpe', 'jfif', 'png', 'apng', 'webp', 'gif', 'tif', 'tiff'];
  const ACCEPTED_MIME = ['image/jpeg', 'image/pjpeg', 'image/png', 'image/apng', 'image/webp', 'image/gif', 'image/tiff', 'image/tiff-fx'];
  const PREVIEW_TIMEOUT = 15000;
  const ANALYSIS_MAX_SIDE = 256;

  /* ------------------------------------------------------------------ *
   * Icons (static, trusted markup)
   * ------------------------------------------------------------------ */
  const svg = (paths) =>
    `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;

  const ICONS = {
    copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>'),
    check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
    file: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'),
    layers: svg('<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>'),
    aperture: svg('<circle cx="12" cy="12" r="9"/><path d="M14.3 3.3L9 12.5M20.6 9.5H10M18 19l-5.3-9.2M9.7 20.7L15 11.5M3.4 14.5H14M6 5l5.3 9.2"/>'),
    camera: svg('<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.5"/>'),
    pin: svg('<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>'),
    tag: svg('<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9-9-9z"/><circle cx="7.5" cy="7.5" r="1.5"/>'),
    text: svg('<path d="M4 6h16M4 12h16M4 18h10"/>'),
    summary: svg('<path d="M9 11l2 2 4-4"/><rect x="4" y="4" width="16" height="16" rx="3"/>'),
    ok: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
    none: svg('<path d="M6 12h12"/>'),
    warn: svg('<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.5v.01"/>'),
    info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.01"/>'),
  };

  /* ------------------------------------------------------------------ *
   * DOM helpers
   * ------------------------------------------------------------------ */
  const $ = (sel) => document.querySelector(sel);

  /** Build an element. Untrusted strings are only ever set via textContent. */
  function h(tag, props, ...children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'icon') node.innerHTML = ICONS[v] || '';
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : String(child));
    }
    return node;
  }

  const els = {
    uploadSection: $('#upload-section'),
    dropzone: $('#dropzone'),
    fileInput: $('#file-input'),
    browseBtn: $('#browse-btn'),
    uploadError: $('#upload-error'),
    uploadErrorText: $('#upload-error-text'),
    errorDismiss: $('#error-dismiss'),
    intro: $('#intro'),
    results: $('#results'),
    resultsTitle: $('#results-title'),
    resultsMeta: $('#results-meta'),
    replaceBtn: $('#replace-btn'),
    removeBtn: $('#remove-btn'),
    previewFrame: $('#preview-frame'),
    previewImg: $('#preview-img'),
    previewFallback: $('#preview-fallback'),
    previewBadges: $('#preview-badges'),
    summaryBody: $('#summary-body'),
    warnings: $('#warnings'),
    cards: $('#cards'),
    copyJsonBtn: $('#copy-json-btn'),
    downloadJsonBtn: $('#download-json-btn'),
    loading: $('#loading'),
    loadingText: $('#loading-text'),
    dragOverlay: $('#drag-overlay'),
    toast: $('#toast'),
    live: $('#live-region'),
  };

  const state = {
    token: 0,
    file: null,
    objectUrl: null,
    exportData: null,
    busy: false,
  };

  /* ------------------------------------------------------------------ *
   * Formatting helpers
   * ------------------------------------------------------------------ */
  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return null;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  function gcd(a, b) {
    while (b) [a, b] = [b, a % b];
    return a;
  }

  const COMMON_RATIOS = [[1, 1], [5, 4], [4, 3], [3, 2], [16, 10], [16, 9], [2, 1], [21, 9], [32, 9], [3, 1]];

  function aspectRatio(w, h) {
    if (!(w > 0 && h > 0)) return null;
    const g = gcd(w, h);
    const a = w / g;
    const b = h / g;
    if (a === 8 && b === 5) return '16:10';
    if (a === 5 && b === 8) return '10:16';
    if (a <= 50 && b <= 50) return `${a}:${b}`;
    const ratio = w / h;
    let near = null;
    for (const [x, y] of COMMON_RATIOS) {
      if (Math.abs(ratio - x / y) / (x / y) < 0.01) near = `${x}:${y}`;
      else if (Math.abs(ratio - y / x) / (y / x) < 0.01) near = `${y}:${x}`;
    }
    const dec = ratio >= 1 ? `${ratio.toFixed(3).replace(/\.?0+$/, '')}:1` : `1:${(1 / ratio).toFixed(3).replace(/\.?0+$/, '')}`;
    return near ? `${dec} (≈ ${near})` : dec;
  }

  function formatDuration(ms) {
    if (!Number.isFinite(ms)) return null;
    if (ms < 1000) return `${ms} ms`;
    return `${(ms / 1000).toFixed(2).replace(/\.?0+$/, '')} s`;
  }

  function formatDate(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return null;
    const d = new Date(ms);
    try {
      return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(d);
    } catch (err) {
      return d.toLocaleString();
    }
  }

  function extensionOf(name) {
    const m = /\.([a-z0-9]+)$/i.exec(name || '');
    return m ? m[1].toLowerCase() : '';
  }

  function toHex(r, g, b) {
    return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  }

  const isOrientationRotated = (o) => o >= 5 && o <= 8;

  /* ------------------------------------------------------------------ *
   * Feedback: toast, live region, loading, errors
   * ------------------------------------------------------------------ */
  let toastTimer = null;
  function toast(message, tone = 'default') {
    els.toast.textContent = message;
    els.toast.dataset.tone = tone;
    els.toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('is-visible'), 2200);
  }

  function announce(message) {
    els.live.textContent = '';
    requestAnimationFrame(() => {
      els.live.textContent = message;
    });
  }

  function setLoading(on, text) {
    state.busy = on;
    els.loading.hidden = !on;
    document.body.setAttribute('aria-busy', on ? 'true' : 'false');
    if (text) els.loadingText.textContent = text;
  }

  function showError(message) {
    els.uploadErrorText.textContent = message;
    els.uploadError.hidden = false;
    announce(message);
  }

  function clearError() {
    els.uploadError.hidden = true;
    els.uploadErrorText.textContent = '';
  }

  /* ------------------------------------------------------------------ *
   * Clipboard & download
   * ------------------------------------------------------------------ */
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (err) {
      /* fall through to legacy path */
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (err) {
      ok = false;
    }
    ta.remove();
    return ok;
  }

  function flashCopied(btn) {
    btn.classList.add('is-copied');
    btn.innerHTML = ICONS.check;
    clearTimeout(btn._timer);
    btn._timer = setTimeout(() => {
      btn.classList.remove('is-copied');
      btn.innerHTML = ICONS.copy;
    }, 1500);
  }

  function copyButton(label, value) {
    const btn = h('button', {
      type: 'button',
      class: 'icon-btn copy-btn',
      'aria-label': `Copy ${label}`,
      title: 'Copy value',
      icon: 'copy',
    });
    btn.addEventListener('click', async () => {
      const ok = await copyText(value);
      if (ok) {
        flashCopied(btn);
        toast(`Copied ${label}`);
        announce(`${label} copied to clipboard`);
      } else {
        toast('Copy failed – your browser blocked clipboard access', 'error');
      }
    });
    return btn;
  }

  function downloadJson(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* ------------------------------------------------------------------ *
   * Card building blocks
   * ------------------------------------------------------------------ */
  function card({ id, title, icon, subtitle, badge, wide, children }) {
    return h(
      'article',
      { class: `card${wide ? ' card-wide' : ''}`, id, 'aria-labelledby': `${id}-title` },
      h(
        'header',
        { class: 'card-header' },
        h('span', { class: 'card-icon', icon }),
        h('div', { class: 'card-heading' }, h('h3', { id: `${id}-title`, text: title }), subtitle && h('p', { class: 'card-subtitle', text: subtitle })),
        badge && h('span', { class: `badge badge-${badge.tone || 'neutral'}`, text: badge.text }),
      ),
      children,
    );
  }

  const hasValue = (v) => v !== null && v !== undefined && v !== '';

  function kvRow({ label, value, empty, swatch, mono = true }) {
    const present = hasValue(value);
    const text = present ? String(value) : empty || 'Not available';
    return h(
      'div',
      { class: 'kv-row' },
      h('dt', { text: label }),
      h(
        'dd',
        { class: present ? (mono ? 'mono' : '') : 'na' },
        swatch && h('span', { class: 'swatch', style: `background:${swatch}`, 'aria-hidden': 'true' }),
        h('span', { class: 'kv-value', text }),
      ),
      present ? copyButton(label, text) : h('span', { class: 'copy-spacer', 'aria-hidden': 'true' }),
    );
  }

  const kvList = (rows) => h('dl', { class: 'kv' }, rows.map(kvRow));

  function emptyState(title, body) {
    return h('div', { class: 'empty-state' }, h('span', { class: 'empty-icon', icon: 'info' }), h('div', {}, h('p', { class: 'empty-title', text: title }), h('p', { class: 'empty-body', text: body })));
  }

  function notice(tone, text) {
    return h('div', { class: `notice notice-${tone}`, role: tone === 'warn' ? 'note' : null }, h('span', { class: 'notice-icon', icon: tone === 'warn' ? 'warn' : 'info' }), h('p', { text }));
  }

  /* ------------------------------------------------------------------ *
   * Section models (shared by the UI and the JSON export)
   * ------------------------------------------------------------------ */
  function buildModel(file, result, preview, pixels) {
    const w = result.width || (preview.ok ? preview.width : null);
    const hgt = result.height || (preview.ok ? preview.height : null);
    const exif = result.exif ? result.exif.fields : {};
    const pixelCount = w && hgt ? w * hgt : null;
    const rotated = result.exif && isOrientationRotated(result.exif.orientation);

    const basic = [
      { key: 'fileName', label: 'File name', value: file.name, mono: false },
      { key: 'format', label: 'Format', value: `${result.format}${file.name && extensionOf(file.name) ? ` (.${extensionOf(file.name)})` : ''}` },
      { key: 'mimeType', label: 'MIME type', value: result.mime + (file.type && file.type !== result.mime ? ` (browser reported ${file.type})` : '') },
      { key: 'fileSize', label: 'File size', value: `${formatBytes(file.size)} (${file.size.toLocaleString()} bytes)` },
      { key: 'dimensions', label: 'Dimensions', value: w && hgt ? `${w} × ${hgt} px` : null },
      { key: 'aspectRatio', label: 'Aspect ratio', value: aspectRatio(w, hgt) },
      { key: 'lastModified', label: 'Last modified', value: formatDate(file.lastModified), mono: false, empty: 'Not reported by browser' },
      { key: 'colorDepth', label: 'Color depth', value: result.colorDepth },
    ];

    const additional = [
      { key: 'pixelCount', label: 'Pixel count', value: pixelCount ? `${pixelCount.toLocaleString()} pixels` : null },
      { key: 'megapixels', label: 'Megapixels', value: pixelCount ? `${(pixelCount / 1e6).toFixed(2)} MP` : null },
      rotated && w && hgt ? { key: 'displayDimensions', label: 'Displayed as', value: `${hgt} × ${w} px (after EXIF rotation)` } : null,
      { key: 'colorModel', label: 'Color model', value: result.colorModel },
      { key: 'bitsPerPixel', label: 'Bits per pixel', value: result.bitsPerPixel ? String(result.bitsPerPixel) : null },
      { key: 'alpha', label: 'Alpha / transparency', value: result.alphaDetail || (result.alpha === null ? null : result.alpha ? 'Yes' : 'No') },
      { key: 'resolution', label: 'Resolution', value: result.resolution, empty: 'Not specified' },
      {
        key: 'colorProfile',
        label: 'Color profile',
        value: result.icc
          ? [result.icc.description || 'Embedded ICC profile', [result.icc.colorSpace, result.icc.version && `ICC v${result.icc.version}`].filter(Boolean).join(', ')].filter(Boolean).join(' · ')
          : null,
        empty: 'None embedded',
      },
      result.animation
        ? {
            key: 'animation',
            label: 'Animation',
            value: [`${result.animation.frames} frames`, result.animation.durationMs ? formatDuration(result.animation.durationMs) : null, result.animation.loop ? `loop: ${result.animation.loop}` : null].filter(Boolean).join(' · '),
          }
        : null,
      ...result.encoding.map(([label, value]) => ({ key: label, label, value })),
    ].filter(Boolean);

    const analysis = pixels
      ? [
          { key: 'transparentPixels', label: 'Transparent pixels', value: pixels.transparent ? 'Yes – some pixels are not fully opaque' : 'No – fully opaque', mono: false },
          { key: 'averageColor', label: 'Average color', value: pixels.average, swatch: pixels.average },
          { key: 'grayscale', label: 'Grayscale content', value: pixels.grayscale ? 'Yes' : 'No', mono: false },
        ]
      : null;

    const camera = [
      { key: 'make', label: 'Manufacturer', value: exif.make },
      { key: 'model', label: 'Model', value: exif.model },
      { key: 'lensMake', label: 'Lens make', value: exif.lensMake },
      { key: 'lensModel', label: 'Lens model', value: exif.lensModel },
      { key: 'lensSpecification', label: 'Lens specification', value: exif.lensSpecification },
      { key: 'bodySerialNumber', label: 'Body serial number', value: exif.bodySerialNumber },
      { key: 'lensSerialNumber', label: 'Lens serial number', value: exif.lensSerialNumber },
      { key: 'cameraOwner', label: 'Camera owner', value: exif.cameraOwner },
    ];
    const hasCamera = ['make', 'model', 'lensMake', 'lensModel'].some((k) => hasValue(exif[k]));

    const exifRows = [
      { key: 'dateTaken', label: 'Date taken', value: exif.dateTaken },
      { key: 'iso', label: 'ISO', value: exif.iso },
      { key: 'shutterSpeed', label: 'Shutter speed', value: exif.shutterSpeed },
      { key: 'aperture', label: 'Aperture', value: exif.aperture },
      { key: 'focalLength', label: 'Focal length', value: exif.focalLength },
      { key: 'orientation', label: 'Orientation', value: exif.orientation },
      { key: 'software', label: 'Software', value: exif.software },
      { key: 'exposureCompensation', label: 'Exposure compensation', value: exif.exposureCompensation },
      { key: 'exposureProgram', label: 'Exposure program', value: exif.exposureProgram },
      { key: 'exposureMode', label: 'Exposure mode', value: exif.exposureMode },
      { key: 'meteringMode', label: 'Metering mode', value: exif.meteringMode },
      { key: 'flash', label: 'Flash', value: exif.flash },
      { key: 'whiteBalance', label: 'White balance', value: exif.whiteBalance },
      { key: 'sceneType', label: 'Scene type', value: exif.sceneType },
      { key: 'digitalZoom', label: 'Digital zoom', value: exif.digitalZoom },
      { key: 'colorSpace', label: 'Color space (EXIF)', value: exif.colorSpace },
      { key: 'dateDigitized', label: 'Date digitized', value: exif.dateDigitized },
      { key: 'dateModified', label: 'Date modified (EXIF)', value: exif.dateModified },
      { key: 'artist', label: 'Artist', value: exif.artist },
      { key: 'copyright', label: 'Copyright', value: exif.copyright },
      { key: 'description', label: 'Description', value: exif.description },
      { key: 'keywords', label: 'Keywords', value: exif.keywords },
      { key: 'userComment', label: 'User comment', value: exif.userComment },
      { key: 'hostComputer', label: 'Host computer', value: exif.hostComputer },
      { key: 'uniqueId', label: 'Image unique ID', value: exif.uniqueId },
      { key: 'exifVersion', label: 'EXIF version', value: exif.exifVersion },
    ];
    // Always show the core fields; only show secondary fields when present.
    const CORE = new Set(['dateTaken', 'iso', 'shutterSpeed', 'aperture', 'focalLength', 'orientation', 'software']);
    const exifVisible = exifRows.filter((r) => CORE.has(r.key) || hasValue(r.value));

    const gps = result.gps
      ? [
          { key: 'coordinates', label: 'Coordinates (decimal)', value: result.gps.coordinates, empty: 'No coordinates recorded' },
          { key: 'latitude', label: 'Latitude', value: result.gps.latitudeDms },
          { key: 'longitude', label: 'Longitude', value: result.gps.longitudeDms },
          { key: 'altitude', label: 'Altitude', value: result.gps.altitude },
          { key: 'timestamp', label: 'GPS timestamp', value: result.gps.timestamp },
          { key: 'direction', label: 'Image direction', value: result.gps.direction },
          { key: 'speed', label: 'Speed', value: result.gps.speed },
          { key: 'horizontalError', label: 'Horizontal error', value: result.gps.horizontalError },
          { key: 'dop', label: 'Dilution of precision', value: result.gps.dop },
          { key: 'satellites', label: 'Satellites', value: result.gps.satellites },
          { key: 'mapDatum', label: 'Map datum', value: result.gps.mapDatum },
          { key: 'processingMethod', label: 'Processing method', value: result.gps.processingMethod },
        ].filter((r) => r.key === 'coordinates' || hasValue(r.value))
      : null;

    return { w, h: hgt, pixelCount, basic, additional, analysis, camera, hasCamera, exifRows, exifVisible, gps };
  }

  function rowsToObject(rows) {
    const out = {};
    for (const r of rows || []) out[r.key] = hasValue(r.value) ? r.value : null;
    return out;
  }

  function buildExport(file, result, model, pixels) {
    return {
      generator: 'PixelPeek',
      generatedAt: new Date().toISOString(),
      note: 'Generated locally in the browser. Absent values were not present in the file.',
      file: {
        name: file.name,
        sizeBytes: file.size,
        size: formatBytes(file.size),
        browserMimeType: file.type || null,
        lastModified: file.lastModified ? new Date(file.lastModified).toISOString() : null,
      },
      image: {
        format: result.format,
        mimeType: result.mime,
        width: model.w,
        height: model.h,
        aspectRatio: aspectRatio(model.w, model.h),
        pixelCount: model.pixelCount,
        megapixels: model.pixelCount ? Number((model.pixelCount / 1e6).toFixed(2)) : null,
        colorDepth: result.colorDepth,
        bitsPerPixel: result.bitsPerPixel,
        colorModel: result.colorModel,
        alpha: result.alpha,
        resolution: result.resolution,
      },
      encoding: Object.fromEntries(result.encoding),
      colorProfile: result.icc,
      animation: result.animation,
      camera: model.hasCamera ? rowsToObject(model.camera) : null,
      exif: result.exif ? rowsToObject(model.exifRows) : null,
      gps: result.gps,
      xmp: result.xmp && result.xmp.fields.length ? Object.fromEntries(result.xmp.fields.map((f) => [f.key, f.value])) : null,
      embeddedText: result.text.length ? result.text : null,
      rawTags: result.exif
        ? Object.fromEntries(result.exif.groups.map((g) => [g.name, Object.fromEntries(g.tags.map((t) => [`${t.name} (${t.id})`, t.value]))]))
        : null,
      pixelAnalysis: pixels ? { sampledAt: pixels.sampleSize, transparentPixels: pixels.transparent, averageColor: pixels.average, grayscale: pixels.grayscale } : null,
      warnings: result.warnings.length ? result.warnings : null,
    };
  }

  /* ------------------------------------------------------------------ *
   * Rendering
   * ------------------------------------------------------------------ */
  function renderSummary(file, result, model) {
    const items = [];
    const exif = result.exif;
    const f = exif ? exif.fields : {};

    items.push(
      exif
        ? { status: 'ok', label: 'EXIF metadata', detail: `${exif.tagCount} tag${exif.tagCount === 1 ? '' : 's'} found` }
        : { status: 'none', label: 'EXIF metadata', detail: 'None found' },
    );
    const cam = [f.make, f.model].filter(Boolean).join(' ');
    const camLabel = cam && f.make && f.model && f.model.toLowerCase().startsWith(f.make.toLowerCase()) ? f.model : cam;
    items.push(camLabel ? { status: 'ok', label: 'Camera', detail: camLabel } : { status: 'none', label: 'Camera', detail: 'Not recorded' });
    items.push(f.dateTaken ? { status: 'ok', label: 'Capture date', detail: f.dateTaken } : { status: 'none', label: 'Capture date', detail: 'Not recorded' });
    if (result.gps && result.gps.coordinates) items.push({ status: 'warn', label: 'GPS location', detail: 'Present – reveals where the photo was taken' });
    else if (result.gps) items.push({ status: 'ok', label: 'GPS data', detail: 'Present, without coordinates' });
    else items.push({ status: 'none', label: 'GPS location', detail: 'Not present' });
    items.push(result.icc ? { status: 'ok', label: 'Color profile', detail: result.icc.description || 'Embedded' } : { status: 'none', label: 'Color profile', detail: 'None embedded' });
    items.push(result.xmp ? { status: 'ok', label: 'XMP packet', detail: `${result.xmp.fields.length} recognized field${result.xmp.fields.length === 1 ? '' : 's'}` } : { status: 'none', label: 'XMP packet', detail: 'Not present' });
    if (result.text.length) items.push({ status: 'ok', label: 'Embedded text', detail: `${result.text.length} entr${result.text.length === 1 ? 'y' : 'ies'}` });
    if (result.animation) items.push({ status: 'ok', label: 'Animation', detail: `${result.animation.frames} frames` });

    const headline = [result.format, model.w && model.h ? `${model.w} × ${model.h}` : null, model.pixelCount ? `${(model.pixelCount / 1e6).toFixed(1)} MP` : null, formatBytes(file.size)].filter(Boolean).join(' · ');

    els.summaryBody.replaceChildren(
      h('p', { class: 'summary-headline mono', text: headline }),
      h(
        'ul',
        { class: 'checklist' },
        items.map((it) =>
          h(
            'li',
            { class: `check check-${it.status}` },
            h('span', { class: 'check-icon', icon: it.status === 'ok' ? 'ok' : it.status === 'warn' ? 'warn' : 'none' }),
            h('span', { class: 'check-label', text: it.label }),
            h('span', { class: 'check-detail', text: it.detail }),
          ),
        ),
      ),
    );
  }

  function rawTagsDetails(exif) {
    return h(
      'details',
      { class: 'raw-tags' },
      h('summary', {}, h('span', { text: `Show all ${exif.tagCount} raw tags` })),
      exif.groups.map((g) =>
        h(
          'div',
          { class: 'raw-group' },
          h('h4', { text: `${g.name} · ${g.tags.length}` }),
          h(
            'div',
            { class: 'table-scroll' },
            h(
              'table',
              { class: 'raw-table' },
              h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: 'Tag' }), h('th', { scope: 'col', text: 'Value' }), h('th', { scope: 'col' }, h('span', { class: 'visually-hidden', text: 'Copy' })))),
              h(
                'tbody',
                {},
                g.tags.map((t) =>
                  h(
                    'tr',
                    {},
                    h('th', { scope: 'row' }, h('span', { class: 'tag-name', text: t.name }), h('span', { class: 'tag-id mono', text: t.id })),
                    h('td', { class: 'mono', text: t.value }),
                    h('td', { class: 'td-copy' }, copyButton(t.name, t.value)),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  function renderCards(file, result, model, pixels) {
    const cards = [];

    cards.push(card({ id: 'card-basic', title: 'Basic information', icon: 'file', subtitle: 'File and image properties', children: kvList(model.basic) }));

    const extraChildren = [kvList(model.additional)];
    if (model.analysis) {
      extraChildren.push(
        h('div', { class: 'subsection' }, h('h4', { class: 'subsection-title', text: 'Pixel analysis' }), h('p', { class: 'subsection-note', text: `Computed with the Canvas API from a ${pixels.sampleSize} sample${result.animation ? ' of the first frame' : ''}.` })),
        kvList(model.analysis),
      );
    }
    cards.push(card({ id: 'card-encoding', title: 'File type & encoding', icon: 'layers', subtitle: 'Read directly from the file headers', children: extraChildren }));

    // EXIF
    let exifChildren;
    if (result.exif) {
      const rows = model.exifVisible.slice();
      if (!model.hasCamera) {
        rows.unshift(
          { label: 'Camera manufacturer', value: null, empty: 'Not recorded' },
          { label: 'Camera model', value: null, empty: 'Not recorded' },
          { label: 'Lens model', value: null, empty: 'Not recorded' },
        );
      }
      if (!result.gps) rows.push({ label: 'GPS coordinates', value: null, empty: 'Not present' });
      exifChildren = [kvList(rows)];
      if (result.exif.tagCount) exifChildren.push(rawTagsDetails(result.exif));
    } else {
      exifChildren = [
        emptyState(
          'No EXIF metadata found',
          'Camera, exposure, capture date and GPS details are unavailable for this file. Many apps, social networks, messaging services and editors strip EXIF data on export or upload, and screenshots or generated graphics usually never had any.',
        ),
      ];
    }
    cards.push(
      card({
        id: 'card-exif',
        title: 'EXIF metadata',
        icon: 'aperture',
        subtitle: result.kind === 'tiff' ? 'TIFF / EXIF tags' : 'Capture and processing details',
        badge: result.exif ? { tone: 'accent', text: `${result.exif.tagCount} tags` } : { tone: 'neutral', text: 'Not found' },
        wide: true,
        children: exifChildren,
      }),
    );

    if (model.hasCamera) {
      cards.push(card({ id: 'card-camera', title: 'Camera information', icon: 'camera', subtitle: 'Device and lens', children: kvList(model.camera.filter((r) => hasValue(r.value) || ['make', 'model', 'lensModel'].includes(r.key))) }));
    }

    if (model.gps) {
      cards.push(
        card({
          id: 'card-gps',
          title: 'GPS information',
          icon: 'pin',
          subtitle: 'Location embedded in the file',
          badge: result.gps.coordinates ? { tone: 'warn', text: 'Location data' } : null,
          children: [
            result.gps.coordinates ? notice('warn', 'This image reveals where it was taken. Consider removing location data before sharing it publicly. Coordinates are shown here only – they are never sent anywhere.') : null,
            kvList(model.gps),
          ],
        }),
      );
    }

    if (result.xmp) {
      cards.push(
        card({
          id: 'card-xmp',
          title: 'XMP metadata',
          icon: 'tag',
          subtitle: `Selected fields · ${formatBytes(result.xmp.size)} packet`,
          children: result.xmp.fields.length
            ? kvList(result.xmp.fields.map((f) => ({ label: f.label, value: f.value })))
            : emptyState('No common fields recognized', 'An XMP packet is present, but it does not contain any of the common fields PixelPeek reads (creator tool, dates, title, creator, rights…).'),
        }),
      );
    }

    if (result.text.length) {
      cards.push(
        card({
          id: 'card-text',
          title: 'Embedded text',
          icon: 'text',
          subtitle: result.kind === 'png' ? 'PNG text chunks' : 'Comments stored in the file',
          children: kvList(result.text.map((t) => ({ label: t.key, value: t.value }))),
        }),
      );
    }

    els.cards.replaceChildren(...cards);
  }

  function renderPreviewBadges(result, model, file) {
    const badges = [result.format, model.w && model.h ? `${model.w} × ${model.h}` : null, formatBytes(file.size)].filter(Boolean);
    els.previewBadges.replaceChildren(...badges.map((b) => h('span', { class: 'pill', text: b })));
  }

  function renderWarnings(result, file) {
    const list = result.warnings.slice();
    if (file.size > LARGE_FILE_SIZE) list.unshift(`Large file (${formatBytes(file.size)}). Everything was still processed locally.`);
    els.warnings.replaceChildren(...list.map((w) => notice('warn', w)));
    els.warnings.hidden = list.length === 0;
  }

  /* ------------------------------------------------------------------ *
   * Preview & pixel analysis
   * ------------------------------------------------------------------ */
  function loadPreview(url) {
    return new Promise((resolve) => {
      const img = els.previewImg;
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        img.onload = img.onerror = null;
        resolve({ ok, width: ok ? img.naturalWidth : null, height: ok ? img.naturalHeight : null });
      };
      const timer = setTimeout(() => finish(false), PREVIEW_TIMEOUT);
      img.onload = () => finish(img.naturalWidth > 0);
      img.onerror = () => finish(false);
      img.src = url;
    });
  }

  function analyzePixels(img) {
    try {
      const w = img.naturalWidth;
      const hgt = img.naturalHeight;
      if (!w || !hgt) return null;
      const scale = Math.min(1, ANALYSIS_MAX_SIDE / Math.max(w, hgt));
      const cw = Math.max(1, Math.round(w * scale));
      const ch = Math.max(1, Math.round(hgt * scale));
      const canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(img, 0, 0, cw, ch);
      const data = ctx.getImageData(0, 0, cw, ch).data;
      let r = 0, g = 0, b = 0, a = 0;
      let transparent = false;
      let grayscale = true;
      for (let i = 0; i < data.length; i += 4) {
        const alpha = data[i + 3];
        if (alpha < 255) transparent = true;
        if (alpha > 0) {
          const wgt = alpha / 255;
          r += data[i] * wgt;
          g += data[i + 1] * wgt;
          b += data[i + 2] * wgt;
          a += wgt;
          if (grayscale && (Math.abs(data[i] - data[i + 1]) > 3 || Math.abs(data[i + 1] - data[i + 2]) > 3)) grayscale = false;
        }
      }
      canvas.width = canvas.height = 0; // release memory
      return {
        sampleSize: `${cw} × ${ch} px`,
        transparent,
        grayscale,
        average: a > 0 ? toHex(r / a, g / a, b / a) : null,
      };
    } catch (err) {
      return null;
    }
  }

  /* ------------------------------------------------------------------ *
   * File intake
   * ------------------------------------------------------------------ */
  function validateFile(file) {
    if (!file) return 'No file was selected.';
    if (file.size === 0) return `"${file.name}" is empty (0 bytes).`;
    if (file.size > MAX_FILE_SIZE) return `"${file.name}" is ${formatBytes(file.size)}. The maximum supported size is ${formatBytes(MAX_FILE_SIZE)}.`;
    const ext = extensionOf(file.name);
    const type = (file.type || '').toLowerCase();
    const extOk = ACCEPTED_EXTENSIONS.includes(ext);
    const mimeOk = ACCEPTED_MIME.includes(type);
    if (!extOk && !mimeOk) {
      const what = type || (ext ? `.${ext}` : 'unknown type');
      return `"${file.name}" (${what}) isn't a supported format. Please choose a JPEG, PNG, WebP, GIF or TIFF image.`;
    }
    return null;
  }

  function releasePreview() {
    if (state.objectUrl) {
      URL.revokeObjectURL(state.objectUrl);
      state.objectUrl = null;
    }
    els.previewImg.removeAttribute('src');
  }

  async function handleFile(file) {
    clearError();
    const problem = validateFile(file);
    if (problem) {
      showError(problem);
      return;
    }

    const token = ++state.token;
    setLoading(true, `Reading metadata from ${file.name}…`);
    // Let the loading indicator paint before heavy work starts.
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

    let result;
    try {
      const buffer = await file.arrayBuffer();
      if (token !== state.token) return;
      result = await MD.analyze(buffer);
    } catch (err) {
      if (token !== state.token) return;
      setLoading(false);
      const message = err instanceof MD.UnsupportedFormatError ? err.message : `Couldn't read "${file.name}": ${err && err.message ? err.message : 'unknown error'}.`;
      if (state.file) toast(message, 'error');
      showError(message);
      return;
    }
    if (token !== state.token) return;

    releasePreview();
    state.objectUrl = URL.createObjectURL(file);
    els.previewFrame.hidden = false;
    els.previewFallback.hidden = true;
    const preview = await loadPreview(state.objectUrl);
    if (token !== state.token) return;

    const pixels = preview.ok ? analyzePixels(els.previewImg) : null;
    if (!preview.ok) {
      els.previewFrame.hidden = true;
      els.previewFallback.hidden = false;
    }
    els.previewImg.alt = `Preview of ${file.name}`;

    const model = buildModel(file, result, preview, pixels);
    state.file = file;
    state.exportData = buildExport(file, result, model, pixels);

    els.resultsTitle.textContent = file.name;
    els.resultsMeta.textContent = `${result.format} image · processed locally`;
    renderPreviewBadges(result, model, file);
    renderSummary(file, result, model);
    renderWarnings(result, file);
    renderCards(file, result, model, pixels);

    els.uploadSection.hidden = true;
    els.intro.hidden = true;
    els.results.hidden = false;
    setLoading(false);
    els.fileInput.value = '';
    els.resultsTitle.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'smooth' });
    announce(`Metadata loaded for ${file.name}. ${result.exif ? `${result.exif.tagCount} EXIF tags found.` : 'No EXIF metadata found.'}`);
  }

  function reset() {
    state.token++;
    state.file = null;
    state.exportData = null;
    releasePreview();
    els.cards.replaceChildren();
    els.summaryBody.replaceChildren();
    els.warnings.replaceChildren();
    els.results.hidden = true;
    els.uploadSection.hidden = false;
    els.intro.hidden = false;
    els.fileInput.value = '';
    clearError();
    setLoading(false);
    els.browseBtn.focus();
    announce('Image removed. You can upload another image.');
  }

  function openPicker() {
    if (!state.busy) els.fileInput.click();
  }

  /* ------------------------------------------------------------------ *
   * Event wiring
   * ------------------------------------------------------------------ */
  function hasFiles(e) {
    return e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  }

  function init() {
    els.browseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openPicker();
    });
    els.dropzone.addEventListener('click', (e) => {
      if (e.target === els.fileInput || e.target.closest('button, a')) return;
      openPicker();
    });
    els.fileInput.addEventListener('change', () => {
      const file = els.fileInput.files && els.fileInput.files[0];
      if (file) handleFile(file);
    });
    els.replaceBtn.addEventListener('click', openPicker);
    els.removeBtn.addEventListener('click', reset);
    els.errorDismiss.addEventListener('click', clearError);

    els.copyJsonBtn.addEventListener('click', async () => {
      if (!state.exportData) return;
      const ok = await copyText(JSON.stringify(state.exportData, null, 2));
      if (ok) {
        flashCopied(els.copyJsonBtn.querySelector('.btn-icon') ? els.copyJsonBtn.querySelector('.btn-icon') : els.copyJsonBtn);
        toast('All metadata copied as JSON');
        announce('All metadata copied to clipboard as JSON');
      } else {
        toast('Copy failed – your browser blocked clipboard access', 'error');
      }
    });

    els.downloadJsonBtn.addEventListener('click', () => {
      if (!state.exportData || !state.file) return;
      const base = state.file.name.replace(/\.[^.]+$/, '').replace(/[^\w.\-]+/g, '_') || 'image';
      downloadJson(state.exportData, `${base}-metadata.json`);
      toast('Metadata JSON downloaded');
    });

    // Window-wide drag & drop (works on the landing page and the results view).
    let dragDepth = 0;
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth++;
      els.dragOverlay.hidden = false;
      els.dropzone.classList.add('is-dragover');
    });
    window.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) {
        els.dragOverlay.hidden = true;
        els.dropzone.classList.remove('is-dragover');
      }
    });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      els.dragOverlay.hidden = true;
      els.dropzone.classList.remove('is-dragover');
      const files = e.dataTransfer.files;
      if (files.length > 1) toast('Multiple files dropped – inspecting the first one');
      if (files.length) handleFile(files[0]);
    });

    // Paste an image from the clipboard (Ctrl/Cmd + V).
    document.addEventListener('paste', (e) => {
      const items = e.clipboardData ? Array.from(e.clipboardData.files || []) : [];
      const img = items.find((f) => f.type.startsWith('image/'));
      if (img) {
        e.preventDefault();
        handleFile(img);
      }
    });
  }

  if (!MD) {
    showError('The metadata module failed to load. Make sure js/metadata.js is present next to js/app.js.');
    return;
  }
  init();
})();
