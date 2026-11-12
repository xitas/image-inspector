# PixelPeek – Image Metadata Viewer

Inspect image metadata (basic properties, encoding, EXIF, camera, GPS, ICC, XMP, embedded text) entirely in the browser. Nothing is uploaded or stored.

## Run

Open `index.html` directly in a modern browser, or serve the folder with any static server:

```
npx serve .        # or
python -m http.server
```

No build step, no backend, no external requests.

## Structure

```
index.html        Markup
css/style.css     Styles (responsive, light theme)
js/metadata.js    Dependency-free binary parsers: JPEG, PNG, GIF, WebP, TIFF (+ EXIF/GPS, ICC, XMP)
js/app.js         UI: upload, validation, preview, rendering, copy & JSON export
assets/logo.svg   Logo / favicon
```

## What is read

| Format | Source of data |
| ------ | -------------- |
| JPEG | SOF header (size, precision, components, subsampling), DQT (estimated quality), JFIF, APP1 EXIF + XMP, APP2 ICC, COM comments |
| PNG  | IHDR, PLTE, tRNS, pHYs, gAMA, sRGB, iCCP, tIME, acTL (APNG), eXIf, tEXt / zTXt / iTXt (incl. XMP) |
| GIF  | Logical screen, color tables, frames, delays, loop count, comments, XMP |
| WebP | VP8 / VP8L / VP8X headers, ALPH, ANIM/ANMF, ICCP, EXIF, XMP |
| TIFF | IFD0 tags, EXIF and GPS sub-IFDs, ICC, XMP, page count |

Maker notes, IPTC and HEIC/AVIF aren't decoded. When they're present, PixelPeek says so instead of guessing. A page-level Content-Security-Policy (`connect-src 'none'`) prevents any network transmission.
