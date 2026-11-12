/*!
 * PixelPeek – metadata.js
 *
 * Dependency-free metadata parsers for JPEG, PNG, GIF, WebP and TIFF.
 * Everything here operates on an in-memory ArrayBuffer. Nothing in this file
 * performs any network access, and nothing is persisted anywhere.
 *
 * Public API (attached to window.PixelPeekMetadata):
 *   analyze(arrayBuffer) -> Promise<Result>
 *   UnsupportedFormatError
 *   SUPPORTED_FORMATS
 */
(function (global) {
  'use strict';

  /* ================================================================== *
   * Utilities
   * ================================================================== */

  const utf8 = new TextDecoder('utf-8');
  const latin1 = new TextDecoder('iso-8859-1');
  const MAX_TEXT_LENGTH = 20000;
  const MAX_INFLATED_BYTES = 8 * 1024 * 1024;

  function ascii(bytes, start, length) {
    let out = '';
    const end = Math.min(bytes.length, start + length);
    for (let i = start; i < end; i++) out += String.fromCharCode(bytes[i]);
    return out;
  }

  function cleanText(value) {
    return String(value)
      .replace(/\u0000+$/g, '')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .trim();
  }

  function truncate(value, max = MAX_TEXT_LENGTH) {
    return value.length > max ? value.slice(0, max) + '… [truncated]' : value;
  }

  function round(value, digits = 2) {
    const f = Math.pow(10, digits);
    return Math.round(value * f) / f;
  }

  function fmtNum(x) {
    if (!Number.isFinite(x)) return 'Undefined';
    if (Number.isInteger(x)) return String(x);
    return String(Number(x.toPrecision(6)));
  }

  function first(v) {
    return Array.isArray(v) || ArrayBuffer.isView(v) ? v[0] : v;
  }

  function num(v) {
    const n = first(v);
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
  }

  function str(v) {
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function indexOfByte(bytes, value, start, end) {
    for (let i = start; i < end; i++) if (bytes[i] === value) return i;
    return -1;
  }

  function isPrintable(bytes) {
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (b === 0 && i === bytes.length - 1) continue;
      if (b < 0x20 || b > 0x7e) return false;
    }
    return true;
  }

  /** zlib inflate via the browser's native DecompressionStream (size-capped). */
  async function inflate(data) {
    if (typeof DecompressionStream === 'undefined') return null;
    try {
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate'));
      const reader = stream.getReader();
      const chunks = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_INFLATED_BYTES) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
      const out = new Uint8Array(total);
      let o = 0;
      for (const c of chunks) {
        out.set(c, o);
        o += c.length;
      }
      return out;
    } catch (err) {
      return null;
    }
  }

  class UnsupportedFormatError extends Error {
    constructor(message) {
      super(message);
      this.name = 'UnsupportedFormatError';
    }
  }

  /* ================================================================== *
   * Tag dictionaries
   * ================================================================== */

  const IFD0_TAGS = {
    0x00fe: 'NewSubfileType', 0x0100: 'ImageWidth', 0x0101: 'ImageHeight', 0x0102: 'BitsPerSample',
    0x0103: 'Compression', 0x0106: 'PhotometricInterpretation', 0x010d: 'DocumentName',
    0x010e: 'ImageDescription', 0x010f: 'Make', 0x0110: 'Model', 0x0112: 'Orientation',
    0x0115: 'SamplesPerPixel', 0x0116: 'RowsPerStrip', 0x011a: 'XResolution', 0x011b: 'YResolution',
    0x011c: 'PlanarConfiguration', 0x0128: 'ResolutionUnit', 0x0131: 'Software', 0x0132: 'DateTime',
    0x013b: 'Artist', 0x013c: 'HostComputer', 0x013d: 'Predictor', 0x013e: 'WhitePoint',
    0x013f: 'PrimaryChromaticities', 0x0142: 'TileWidth', 0x0143: 'TileLength', 0x0152: 'ExtraSamples',
    0x0153: 'SampleFormat', 0x0211: 'YCbCrCoefficients', 0x0212: 'YCbCrSubSampling',
    0x0213: 'YCbCrPositioning', 0x0214: 'ReferenceBlackWhite', 0x02bc: 'XMLPacket (XMP)',
    0x4746: 'Rating', 0x4749: 'RatingPercent', 0x8298: 'Copyright', 0x83bb: 'IPTC-NAA',
    0x8649: 'PhotoshopSettings', 0x8773: 'InterColorProfile (ICC)', 0x9c9b: 'XPTitle',
    0x9c9c: 'XPComment', 0x9c9d: 'XPAuthor', 0x9c9e: 'XPKeywords', 0x9c9f: 'XPSubject',
  };

  const EXIF_TAGS = {
    0x829a: 'ExposureTime', 0x829d: 'FNumber', 0x8822: 'ExposureProgram', 0x8824: 'SpectralSensitivity',
    0x8827: 'ISOSpeedRatings', 0x8830: 'SensitivityType', 0x8831: 'StandardOutputSensitivity',
    0x8832: 'RecommendedExposureIndex', 0x9000: 'ExifVersion', 0x9003: 'DateTimeOriginal',
    0x9004: 'DateTimeDigitized', 0x9010: 'OffsetTime', 0x9011: 'OffsetTimeOriginal',
    0x9012: 'OffsetTimeDigitized', 0x9101: 'ComponentsConfiguration', 0x9102: 'CompressedBitsPerPixel',
    0x9201: 'ShutterSpeedValue', 0x9202: 'ApertureValue', 0x9203: 'BrightnessValue',
    0x9204: 'ExposureBiasValue', 0x9205: 'MaxApertureValue', 0x9206: 'SubjectDistance',
    0x9207: 'MeteringMode', 0x9208: 'LightSource', 0x9209: 'Flash', 0x920a: 'FocalLength',
    0x9214: 'SubjectArea', 0x927c: 'MakerNote', 0x9286: 'UserComment', 0x9290: 'SubSecTime',
    0x9291: 'SubSecTimeOriginal', 0x9292: 'SubSecTimeDigitized', 0xa000: 'FlashpixVersion',
    0xa001: 'ColorSpace', 0xa002: 'PixelXDimension', 0xa003: 'PixelYDimension',
    0xa20e: 'FocalPlaneXResolution', 0xa20f: 'FocalPlaneYResolution', 0xa210: 'FocalPlaneResolutionUnit',
    0xa215: 'ExposureIndex', 0xa217: 'SensingMethod', 0xa300: 'FileSource', 0xa301: 'SceneType',
    0xa401: 'CustomRendered', 0xa402: 'ExposureMode', 0xa403: 'WhiteBalance', 0xa404: 'DigitalZoomRatio',
    0xa405: 'FocalLengthIn35mmFilm', 0xa406: 'SceneCaptureType', 0xa407: 'GainControl', 0xa408: 'Contrast',
    0xa409: 'Saturation', 0xa40a: 'Sharpness', 0xa40c: 'SubjectDistanceRange', 0xa420: 'ImageUniqueID',
    0xa430: 'CameraOwnerName', 0xa431: 'BodySerialNumber', 0xa432: 'LensSpecification',
    0xa433: 'LensMake', 0xa434: 'LensModel', 0xa435: 'LensSerialNumber', 0xa460: 'CompositeImage',
  };

  const GPS_TAGS = {
    0x00: 'GPSVersionID', 0x01: 'GPSLatitudeRef', 0x02: 'GPSLatitude', 0x03: 'GPSLongitudeRef',
    0x04: 'GPSLongitude', 0x05: 'GPSAltitudeRef', 0x06: 'GPSAltitude', 0x07: 'GPSTimeStamp',
    0x08: 'GPSSatellites', 0x09: 'GPSStatus', 0x0a: 'GPSMeasureMode', 0x0b: 'GPSDOP', 0x0c: 'GPSSpeedRef',
    0x0d: 'GPSSpeed', 0x0e: 'GPSTrackRef', 0x0f: 'GPSTrack', 0x10: 'GPSImgDirectionRef',
    0x11: 'GPSImgDirection', 0x12: 'GPSMapDatum', 0x13: 'GPSDestLatitudeRef', 0x14: 'GPSDestLatitude',
    0x15: 'GPSDestLongitudeRef', 0x16: 'GPSDestLongitude', 0x17: 'GPSDestBearingRef',
    0x18: 'GPSDestBearing', 0x19: 'GPSDestDistanceRef', 0x1a: 'GPSDestDistance',
    0x1b: 'GPSProcessingMethod', 0x1c: 'GPSAreaInformation', 0x1d: 'GPSDateStamp',
    0x1e: 'GPSDifferential', 0x1f: 'GPSHPositioningError',
  };

  /** Structural tags that carry offsets rather than meaningful values. */
  const SKIP_TAGS = new Set([0x8769, 0x8825, 0xa005, 0x0111, 0x0117, 0x0144, 0x0145, 0x0201, 0x0202, 0x014a]);

  const TIFF_COMPRESSION = {
    1: 'Uncompressed', 2: 'CCITT modified Huffman RLE', 3: 'CCITT Group 3 fax', 4: 'CCITT Group 4 fax',
    5: 'LZW', 6: 'JPEG (old-style)', 7: 'JPEG', 8: 'Deflate (Adobe)', 32773: 'PackBits',
    32946: 'Deflate', 34712: 'JPEG 2000', 34887: 'LERC', 34925: 'LZMA', 50000: 'Zstandard', 50001: 'WebP',
  };

  const ENUMS = {
    Orientation: {
      1: 'Horizontal (normal)', 2: 'Mirrored horizontally', 3: 'Rotated 180°', 4: 'Mirrored vertically',
      5: 'Mirrored horizontally, rotated 270° CW', 6: 'Rotated 90° CW',
      7: 'Mirrored horizontally, rotated 90° CW', 8: 'Rotated 270° CW',
    },
    ResolutionUnit: { 1: 'None', 2: 'Inches', 3: 'Centimeters' },
    FocalPlaneResolutionUnit: { 1: 'None', 2: 'Inches', 3: 'Centimeters' },
    Compression: TIFF_COMPRESSION,
    PhotometricInterpretation: {
      0: 'WhiteIsZero', 1: 'BlackIsZero', 2: 'RGB', 3: 'Palette', 4: 'Transparency mask', 5: 'CMYK',
      6: 'YCbCr', 8: 'CIE L*a*b*', 9: 'ICC L*a*b*', 10: 'ITU L*a*b*', 32844: 'LogL', 32845: 'LogLuv',
      34892: 'Linear raw',
    },
    PlanarConfiguration: { 1: 'Chunky (interleaved)', 2: 'Planar' },
    YCbCrPositioning: { 1: 'Centered', 2: 'Co-sited' },
    ExposureProgram: {
      0: 'Not defined', 1: 'Manual', 2: 'Normal program', 3: 'Aperture priority', 4: 'Shutter priority',
      5: 'Creative program', 6: 'Action program', 7: 'Portrait mode', 8: 'Landscape mode',
    },
    MeteringMode: {
      0: 'Unknown', 1: 'Average', 2: 'Center-weighted average', 3: 'Spot', 4: 'Multi-spot',
      5: 'Multi-segment (pattern)', 6: 'Partial', 255: 'Other',
    },
    LightSource: {
      0: 'Unknown', 1: 'Daylight', 2: 'Fluorescent', 3: 'Tungsten (incandescent)', 4: 'Flash',
      9: 'Fine weather', 10: 'Cloudy', 11: 'Shade', 12: 'Daylight fluorescent', 13: 'Day white fluorescent',
      14: 'Cool white fluorescent', 15: 'White fluorescent', 17: 'Standard light A', 18: 'Standard light B',
      19: 'Standard light C', 20: 'D55', 21: 'D65', 22: 'D75', 23: 'D50', 24: 'ISO studio tungsten',
      255: 'Other',
    },
    ColorSpace: { 1: 'sRGB', 2: 'Adobe RGB', 65535: 'Uncalibrated' },
    SensingMethod: {
      1: 'Not defined', 2: 'One-chip color area', 3: 'Two-chip color area', 4: 'Three-chip color area',
      5: 'Color sequential area', 7: 'Trilinear', 8: 'Color sequential linear',
    },
    CustomRendered: { 0: 'Normal process', 1: 'Custom process' },
    ExposureMode: { 0: 'Auto', 1: 'Manual', 2: 'Auto bracket' },
    WhiteBalance: { 0: 'Auto', 1: 'Manual' },
    SceneCaptureType: { 0: 'Standard', 1: 'Landscape', 2: 'Portrait', 3: 'Night scene' },
    GainControl: { 0: 'None', 1: 'Low gain up', 2: 'High gain up', 3: 'Low gain down', 4: 'High gain down' },
    Contrast: { 0: 'Normal', 1: 'Low', 2: 'High' },
    Saturation: { 0: 'Normal', 1: 'Low', 2: 'High' },
    Sharpness: { 0: 'Normal', 1: 'Soft', 2: 'Hard' },
    SubjectDistanceRange: { 0: 'Unknown', 1: 'Macro', 2: 'Close', 3: 'Distant' },
    SensitivityType: {
      0: 'Unknown', 1: 'Standard output sensitivity', 2: 'Recommended exposure index', 3: 'ISO speed',
      4: 'SOS + REI', 5: 'SOS + ISO speed', 6: 'REI + ISO speed', 7: 'SOS + REI + ISO speed',
    },
    CompositeImage: {
      0: 'Unknown', 1: 'Not a composite image', 2: 'General composite image',
      3: 'Composite captured while shooting',
    },
    SampleFormat: { 1: 'Unsigned integer', 2: 'Signed integer', 3: 'Floating point', 4: 'Undefined' },
    Predictor: { 1: 'None', 2: 'Horizontal differencing', 3: 'Floating point' },
    ExtraSamples: { 0: 'Unspecified', 1: 'Associated alpha', 2: 'Unassociated alpha' },
    GPSAltitudeRef: { 0: 'Above sea level', 1: 'Below sea level' },
    GPSDifferential: { 0: 'No correction', 1: 'Differential corrected' },
  };

  /* ================================================================== *
   * TIFF / EXIF structure reader
   * ================================================================== */

  const TYPE_SIZES = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];
  const MAX_IFD_ENTRIES = 1024;
  const MAX_ARRAY_VALUES = 4096;
  const MAX_DIRECTORIES = 512;

  function getTag(ifd, tag) {
    const entry = ifd && ifd.tags.get(tag);
    return entry ? entry.value : undefined;
  }

  /**
   * Parse a TIFF structure (used by TIFF files and by EXIF blocks in
   * JPEG, PNG and WebP). `start`/`length` delimit the TIFF header region.
   */
  function parseTiff(buffer, start, length) {
    const view = new DataView(buffer, start, length);
    const len = view.byteLength;
    if (len < 8) throw new Error('TIFF header is too short');
    const order = view.getUint16(0, false);
    const le = order === 0x4949 ? true : order === 0x4d4d ? false : null;
    if (le === null) throw new Error('invalid TIFF byte order');
    if (view.getUint16(2, le) !== 42) throw new Error('invalid TIFF identifier');

    const u16 = (o) => view.getUint16(o, le);
    const u32 = (o) => view.getUint32(o, le);
    const visited = new Set();

    function readValue(type, count, off) {
      const abs = start + off;
      if (type === 2) {
        const raw = new Uint8Array(buffer, abs, count);
        let end = raw.indexOf(0);
        if (end < 0) end = count;
        return cleanText(utf8.decode(raw.subarray(0, end)));
      }
      if (type === 1 || type === 7) {
        if (count === 1 && type === 1) return view.getUint8(off);
        return new Uint8Array(buffer.slice(abs, abs + count));
      }
      if (count > MAX_ARRAY_VALUES) return { omitted: true, count };
      const size = TYPE_SIZES[type];
      const values = [];
      for (let i = 0; i < count; i++) {
        const p = off + i * size;
        switch (type) {
          case 3: values.push(u16(p)); break;
          case 4:
          case 13: values.push(u32(p)); break;
          case 5: {
            const d = u32(p + 4);
            values.push(d === 0 ? NaN : u32(p) / d);
            break;
          }
          case 6: values.push(view.getInt8(p)); break;
          case 8: values.push(view.getInt16(p, le)); break;
          case 9: values.push(view.getInt32(p, le)); break;
          case 10: {
            const d = view.getInt32(p + 4, le);
            values.push(d === 0 ? NaN : view.getInt32(p, le) / d);
            break;
          }
          case 11: values.push(view.getFloat32(p, le)); break;
          case 12: values.push(view.getFloat64(p, le)); break;
          default: break;
        }
      }
      return count === 1 ? values[0] : values;
    }

    function readIfd(offset) {
      if (!offset || offset < 8 || offset + 2 > len || visited.has(offset)) return null;
      visited.add(offset);
      const count = u16(offset);
      const tags = new Map();
      const limit = Math.min(count, MAX_IFD_ENTRIES);
      for (let i = 0; i < limit; i++) {
        const entry = offset + 2 + i * 12;
        if (entry + 12 > len) break;
        const tag = u16(entry);
        const type = u16(entry + 2);
        const n = u32(entry + 4);
        const size = TYPE_SIZES[type];
        if (!size || !n) continue;
        const total = size * n;
        if (total > len) continue;
        const valueOffset = total <= 4 ? entry + 8 : u32(entry + 8);
        if (valueOffset + total > len) continue;
        try {
          tags.set(tag, { type, count: n, value: readValue(type, n, valueOffset) });
        } catch (err) {
          /* skip unreadable entry */
        }
      }
      const nextPos = offset + 2 + count * 12;
      const next = nextPos + 4 <= len ? u32(nextPos) : 0;
      return { tags, next };
    }

    const ifd0 = readIfd(u32(4));
    if (!ifd0) throw new Error('could not read the primary image directory');
    const pointer = (ifd, tag) => {
      const v = num(getTag(ifd, tag));
      return v && v > 0 ? v : 0;
    };
    const exif = readIfd(pointer(ifd0, 0x8769));
    const gps = readIfd(pointer(ifd0, 0x8825));
    const ifd1 = readIfd(ifd0.next);

    let directoryCount = 1;
    let cursor = ifd1;
    while (cursor && directoryCount < MAX_DIRECTORIES) {
      directoryCount++;
      cursor = readIfd(cursor.next);
    }

    return { littleEndian: le, ifd0, exif, gps, ifd1, directoryCount };
  }

  /* ================================================================== *
   * EXIF value formatting
   * ================================================================== */

  function formatExposureTime(t) {
    if (!(t > 0)) return null;
    if (t >= 1) return `${round(t, 1)} s`;
    const d = 1 / t;
    if (Math.abs(d - Math.round(d)) < 0.05 * d || d > 3) return `1/${Math.round(d)} s`;
    return `${round(t, 2)} s`;
  }

  function formatEv(v) {
    if (v == null || !Number.isFinite(v)) return null;
    if (v === 0) return '0 EV';
    return `${v > 0 ? '+' : '−'}${round(Math.abs(v), 2)} EV`;
  }

  function formatFlash(v) {
    const n = num(v);
    if (n == null) return null;
    if (n & 0x20) return 'No flash function';
    const parts = [n & 1 ? 'Fired' : 'Did not fire'];
    const mode = (n >> 3) & 3;
    if (mode === 1) parts.push('compulsory');
    else if (mode === 2) parts.push('suppressed');
    else if (mode === 3) parts.push('auto mode');
    const ret = (n >> 1) & 3;
    if (ret === 2) parts.push('return not detected');
    else if (ret === 3) parts.push('return detected');
    if (n & 0x40) parts.push('red-eye reduction');
    return parts.join(', ');
  }

  function formatExifDate(dt, subsec, offset) {
    if (typeof dt !== 'string') return null;
    const m = dt.match(/^(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    if (!m) return /^[\s0:\-]*$/.test(dt) ? null : dt.trim();
    if (m[1] === '0000') return null;
    let out = `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
    const ss = str(subsec);
    if (ss && /^\d+$/.test(ss)) out += '.' + ss;
    const off = str(offset);
    if (off && /^[+-]\d{2}:\d{2}$/.test(off)) out += ` (UTC${off})`;
    return out;
  }

  function formatLensSpec(v) {
    if (!Array.isArray(v) || v.length < 2) return null;
    const [minF, maxF, minA, maxA] = v;
    if (!(minF > 0)) return null;
    let out = maxF > 0 && maxF !== minF ? `${round(minF, 1)}–${round(maxF, 1)} mm` : `${round(minF, 1)} mm`;
    if (minA > 0) out += maxA > 0 && maxA !== minA ? ` f/${round(minA, 1)}–${round(maxA, 1)}` : ` f/${round(minA, 1)}`;
    return out;
  }

  function formatVersion(v) {
    if (!(v instanceof Uint8Array) || v.length < 4) return null;
    const s = ascii(v, 0, 4);
    if (!/^\d{4}$/.test(s)) return genericValue(v);
    return `${parseInt(s.slice(0, 2), 10)}.${s.slice(2)}`;
  }

  function formatResolution(x, y, unit) {
    const rx = num(x);
    const ry = num(y);
    if (!(rx > 0)) return null;
    const u = { 2: 'dpi', 3: 'dots/cm' }[num(unit) ?? 2] || '(no unit)';
    if (!(ry > 0) || ry === rx) return `${round(rx, 2)} ${u}`;
    return `${round(rx, 2)} × ${round(ry, 2)} ${u}`;
  }

  function decodeXp(v) {
    if (!(v instanceof Uint8Array)) return null;
    try {
      const text = cleanText(new TextDecoder('utf-16le').decode(v));
      return text || null;
    } catch (err) {
      return null;
    }
  }

  function decodeUserComment(v, littleEndian) {
    if (typeof v === 'string') return str(v);
    if (!(v instanceof Uint8Array) || v.length <= 8) return null;
    const header = ascii(v, 0, 8);
    const body = v.subarray(8);
    let text = null;
    try {
      if (header.startsWith('ASCII')) text = latin1.decode(body);
      else if (header.startsWith('UNICODE')) text = new TextDecoder(littleEndian ? 'utf-16le' : 'utf-16be').decode(body);
      else if (header.startsWith('JIS')) text = null;
      else text = utf8.decode(body);
    } catch (err) {
      text = null;
    }
    text = text ? cleanText(text) : '';
    return text || null;
  }

  function toDecimalDegrees(v, ref, max) {
    let d;
    if (Array.isArray(v)) {
      const [a, b = 0, c = 0] = v;
      if (![a, b, c].every(Number.isFinite)) return null;
      d = a + b / 60 + c / 3600;
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      d = v;
    } else {
      return null;
    }
    const r = str(ref);
    if (r && /^[SW]/i.test(r)) d = -Math.abs(d);
    return Math.abs(d) > max ? null : d;
  }

  function formatDms(decimal, pos, neg) {
    const abs = Math.abs(decimal);
    let deg = Math.floor(abs);
    let min = Math.floor((abs - deg) * 60);
    let sec = (abs - deg - min / 60) * 3600;
    if (sec.toFixed(2) === '60.00') {
      sec = 0;
      min += 1;
    }
    if (min === 60) {
      min = 0;
      deg += 1;
    }
    return `${deg}° ${min}′ ${sec.toFixed(2)}″ ${decimal < 0 ? neg : pos}`;
  }

  function formatDmsArray(v) {
    if (!Array.isArray(v) || v.length < 3 || !v.every(Number.isFinite)) return genericValue(v);
    return `${fmtNum(v[0])}° ${fmtNum(v[1])}′ ${fmtNum(round(v[2], 4))}″`;
  }

  function formatGpsTime(v) {
    if (!Array.isArray(v) || v.length < 3 || !v.every(Number.isFinite)) return null;
    const [h, m, s] = v;
    const secs = Number.isInteger(s) ? pad2(s) : s.toFixed(2).padStart(5, '0');
    return `${pad2(Math.floor(h))}:${pad2(Math.floor(m))}:${secs}`;
  }

  function genericValue(v) {
    if (v && v.omitted) return `${v.count} values (omitted)`;
    if (typeof v === 'string') return v || '(empty)';
    if (typeof v === 'number') return fmtNum(v);
    if (v instanceof Uint8Array) {
      if (v.length <= 64 && isPrintable(v)) return cleanText(ascii(v, 0, v.length)) || '(empty)';
      return v.length <= 16 ? Array.from(v).join(' ') : `${v.length.toLocaleString()} bytes (binary)`;
    }
    if (Array.isArray(v)) {
      const items = v.slice(0, 16).map(fmtNum);
      return items.join(', ') + (v.length > 16 ? `, … (${v.length} values)` : '');
    }
    return String(v);
  }

  function enumText(name, v) {
    const n = num(v);
    if (n == null) return null;
    return (ENUMS[name] && ENUMS[name][n]) || `Unknown (${n})`;
  }

  function formatTagValue(name, entry, le) {
    const v = entry.value;
    if (v && v.omitted) return `${v.count.toLocaleString()} values (omitted)`;
    if (ENUMS[name] && num(v) != null) return enumText(name, v);
    const n = num(v);
    switch (name) {
      case 'ExposureTime':
        return n > 0 ? formatExposureTime(n) : genericValue(v);
      case 'ShutterSpeedValue':
        return n != null ? `${fmtNum(round(n, 3))} APEX (≈ ${formatExposureTime(Math.pow(2, -n))})` : genericValue(v);
      case 'FNumber':
        return n > 0 ? `f/${round(n, 1)}` : genericValue(v);
      case 'ApertureValue':
      case 'MaxApertureValue':
        return n != null ? `${fmtNum(round(n, 3))} APEX (≈ f/${round(Math.pow(Math.SQRT2, n), 1)})` : genericValue(v);
      case 'FocalLength':
        return n != null ? `${fmtNum(round(n, 2))} mm` : genericValue(v);
      case 'FocalLengthIn35mmFilm':
        return n != null ? `${n} mm` : genericValue(v);
      case 'ExposureBiasValue':
        return formatEv(n) || genericValue(v);
      case 'SubjectDistance':
        return n != null ? `${fmtNum(round(n, 2))} m` : genericValue(v);
      case 'Flash':
        return formatFlash(v) || genericValue(v);
      case 'ExifVersion':
      case 'FlashpixVersion':
        return formatVersion(v) || genericValue(v);
      case 'ComponentsConfiguration':
        return v instanceof Uint8Array
          ? Array.from(v).map((c) => ['', 'Y', 'Cb', 'Cr', 'R', 'G', 'B'][c] || '').filter(Boolean).join(', ') || '—'
          : genericValue(v);
      case 'FileSource':
        return n === 3 ? 'Digital still camera' : genericValue(v);
      case 'SceneType':
        return n === 1 ? 'Directly photographed' : genericValue(v);
      case 'UserComment':
      case 'GPSProcessingMethod':
      case 'GPSAreaInformation':
        return decodeUserComment(v, le) || '(empty)';
      case 'XPTitle':
      case 'XPComment':
      case 'XPAuthor':
      case 'XPKeywords':
      case 'XPSubject':
        return decodeXp(v) || '(empty)';
      case 'GPSLatitude':
      case 'GPSLongitude':
      case 'GPSDestLatitude':
      case 'GPSDestLongitude':
        return formatDmsArray(v);
      case 'GPSTimeStamp':
        return (formatGpsTime(v) && `${formatGpsTime(v)} UTC`) || genericValue(v);
      case 'GPSAltitude':
        return n != null ? `${fmtNum(round(n, 2))} m` : genericValue(v);
      case 'GPSVersionID':
        return v instanceof Uint8Array ? Array.from(v).join('.') : genericValue(v);
      case 'LensSpecification':
        return formatLensSpec(v) || genericValue(v);
      case 'MakerNote':
        return `${entry.count.toLocaleString()} bytes (proprietary, not decoded)`;
      default:
        return genericValue(v);
    }
  }

  function listTags(ifd, dict, le) {
    if (!ifd) return [];
    const rows = [];
    for (const [tag, entry] of ifd.tags) {
      if (SKIP_TAGS.has(tag)) continue;
      const name = dict[tag] || `Unknown tag`;
      let value;
      try {
        value = formatTagValue(name, entry, le);
      } catch (err) {
        value = genericValue(entry.value);
      }
      rows.push({ id: '0x' + tag.toString(16).toUpperCase().padStart(4, '0'), name, value: truncate(String(value), 2000) });
    }
    return rows;
  }

  /* ================================================================== *
   * EXIF / GPS interpretation
   * ================================================================== */

  function interpretExif(tiff) {
    const { ifd0, exif, gps, ifd1, littleEndian } = tiff;
    const t0 = (tag) => getTag(ifd0, tag);
    const te = (tag) => getTag(exif, tag);
    const fields = {};
    const set = (key, value) => {
      if (value !== null && value !== undefined && value !== '') fields[key] = value;
    };

    // Camera
    set('make', str(t0(0x010f)));
    set('model', str(t0(0x0110)));
    set('lensMake', str(te(0xa433)));
    set('lensModel', str(te(0xa434)));
    set('lensSpecification', formatLensSpec(te(0xa432)));
    set('bodySerialNumber', str(te(0xa431)));
    set('lensSerialNumber', str(te(0xa435)));
    set('cameraOwner', str(te(0xa430)));

    // Capture
    set('dateTaken', formatExifDate(te(0x9003), te(0x9291), te(0x9011)));
    set('dateDigitized', formatExifDate(te(0x9004), te(0x9292), te(0x9012)));
    set('dateModified', formatExifDate(t0(0x0132), te(0x9290), te(0x9010)));

    const iso = num(te(0x8827)) ?? num(te(0x8832));
    set('iso', iso != null && iso > 0 ? String(iso) : null);

    let exposure = num(te(0x829a));
    if (!(exposure > 0)) {
      const apex = num(te(0x9201));
      if (apex != null) exposure = Math.pow(2, -apex);
    }
    set('shutterSpeed', exposure > 0 ? formatExposureTime(exposure) : null);

    let fnumber = num(te(0x829d));
    if (!(fnumber > 0)) {
      const apex = num(te(0x9202));
      if (apex != null) fnumber = Math.pow(Math.SQRT2, apex);
    }
    set('aperture', fnumber > 0 ? `f/${round(fnumber, 1)}` : null);

    const fl = num(te(0x920a));
    const fl35 = num(te(0xa405));
    if (fl > 0) {
      const equiv = fl35 > 0 && Math.round(fl35) !== Math.round(fl) ? ` (${fl35} mm in 35 mm equiv.)` : '';
      set('focalLength', `${round(fl, 1)} mm${equiv}`);
    } else if (fl35 > 0) {
      set('focalLength', `${fl35} mm (35 mm equiv.)`);
    }

    set('exposureCompensation', formatEv(num(te(0x9204))));
    set('exposureProgram', te(0x8822) != null ? enumText('ExposureProgram', te(0x8822)) : null);
    set('exposureMode', te(0xa402) != null ? enumText('ExposureMode', te(0xa402)) : null);
    set('meteringMode', te(0x9207) != null ? enumText('MeteringMode', te(0x9207)) : null);
    set('flash', formatFlash(te(0x9209)));
    set('whiteBalance', te(0xa403) != null ? enumText('WhiteBalance', te(0xa403)) : null);
    set('sceneType', te(0xa406) != null ? enumText('SceneCaptureType', te(0xa406)) : null);
    set('colorSpace', te(0xa001) != null ? enumText('ColorSpace', te(0xa001)) : null);
    set('digitalZoom', num(te(0xa404)) > 0 ? `${round(num(te(0xa404)), 2)}×` : null);

    const orientation = num(t0(0x0112));
    set('orientation', orientation ? `${ENUMS.Orientation[orientation] || 'Unknown'} (${orientation})` : null);
    set('software', str(t0(0x0131)));
    set('hostComputer', str(t0(0x013c)));
    set('artist', str(t0(0x013b)) || decodeXp(t0(0x9c9d)));
    set('copyright', str(t0(0x8298)));
    set('description', str(t0(0x010e)) || decodeXp(t0(0x9c9b)) || decodeXp(t0(0x9c9c)));
    set('keywords', decodeXp(t0(0x9c9e)));
    set('userComment', decodeUserComment(te(0x9286), littleEndian));
    set('exifVersion', formatVersion(te(0x9000)));
    set('resolution', formatResolution(t0(0x011a), t0(0x011b), t0(0x0128)));
    set('uniqueId', str(te(0xa420)));

    const groups = [
      { name: 'IFD0 · Main image', tags: listTags(ifd0, IFD0_TAGS, littleEndian) },
      { name: 'EXIF sub-IFD', tags: listTags(exif, EXIF_TAGS, littleEndian) },
      { name: 'GPS sub-IFD', tags: listTags(gps, GPS_TAGS, littleEndian) },
    ].filter((g) => g.tags.length);

    const thumbLength = ifd1 ? num(getTag(ifd1, 0x0202)) : null;

    return {
      fields,
      groups,
      tagCount: groups.reduce((n, g) => n + g.tags.length, 0),
      hasExifIfd: !!exif,
      orientation: orientation || null,
      thumbnailBytes: getTag(ifd1, 0x0201) != null && thumbLength ? thumbLength : null,
      hasMakerNote: !!(exif && exif.tags.has(0x927c)),
    };
  }

  function interpretGps(ifd) {
    if (!ifd || !ifd.tags.size) return null;
    const g = (tag) => getTag(ifd, tag);
    const out = {};

    const lat = toDecimalDegrees(g(0x02), g(0x01), 90);
    const lon = toDecimalDegrees(g(0x04), g(0x03), 180);
    if (lat != null && lon != null) {
      out.latitude = round(lat, 6);
      out.longitude = round(lon, 6);
      out.latitudeDms = formatDms(lat, 'N', 'S');
      out.longitudeDms = formatDms(lon, 'E', 'W');
      out.coordinates = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
    }

    const alt = num(g(0x06));
    if (alt != null) {
      const below = num(g(0x05)) === 1;
      out.altitude = `${round(alt, 1)} m ${below ? 'below' : 'above'} sea level`;
    }

    const date = str(g(0x1d));
    const time = formatGpsTime(g(0x07));
    if (date || time) out.timestamp = `${date ? date.replace(/:/g, '-') : ''} ${time || ''}`.trim() + ' UTC';

    const dir = num(g(0x11));
    if (dir != null) out.direction = `${round(dir, 1)}° (${str(g(0x10)) === 'M' ? 'magnetic' : 'true'} north)`;

    const speed = num(g(0x0d));
    if (speed != null) {
      const unit = { K: 'km/h', M: 'mph', N: 'knots' }[str(g(0x0c)) || 'K'] || 'km/h';
      out.speed = `${round(speed, 2)} ${unit}`;
    }

    const err = num(g(0x1f));
    if (err != null) out.horizontalError = `${round(err, 1)} m`;
    const dop = num(g(0x0b));
    if (dop != null) out.dop = String(round(dop, 2));
    const datum = str(g(0x12));
    if (datum) out.mapDatum = datum;
    const sats = str(g(0x08));
    if (sats) out.satellites = sats;
    const method = decodeUserComment(g(0x1b));
    if (method) out.processingMethod = method;

    return Object.keys(out).length ? out : null;
  }

  /* ================================================================== *
   * ICC profiles & XMP packets
   * ================================================================== */

  const ICC_CLASSES = {
    scnr: 'Input device', mntr: 'Display', prtr: 'Output device', link: 'Device link',
    spac: 'Color space', abst: 'Abstract', nmcl: 'Named color',
  };

  function parseIcc(bytes) {
    if (!bytes || bytes.length < 132) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (ascii(bytes, 36, 4) !== 'acsp') return null;
    const profile = {
      colorSpace: ascii(bytes, 16, 4).trim() || null,
      deviceClass: ICC_CLASSES[ascii(bytes, 12, 4)] || null,
      version: `${bytes[8]}.${bytes[9] >> 4}`,
      size: view.getUint32(0),
      description: null,
    };
    try {
      const tagCount = Math.min(view.getUint32(128), 256);
      for (let i = 0; i < tagCount; i++) {
        const base = 132 + i * 12;
        if (base + 12 > bytes.length) break;
        if (ascii(bytes, base, 4) !== 'desc') continue;
        const off = view.getUint32(base + 4);
        const type = ascii(bytes, off, 4);
        if (type === 'desc') {
          const n = view.getUint32(off + 8);
          profile.description = cleanText(ascii(bytes, off + 12, Math.max(0, n - 1)));
        } else if (type === 'mluc') {
          const recSize = view.getUint32(off + 12);
          if (recSize >= 12 && view.getUint32(off + 8) > 0) {
            const strLen = view.getUint32(off + 20);
            const strOff = view.getUint32(off + 24);
            const slice = bytes.subarray(off + strOff, off + strOff + strLen);
            profile.description = cleanText(new TextDecoder('utf-16be').decode(slice));
          }
        }
        break;
      }
    } catch (err) {
      /* description stays null */
    }
    return profile;
  }

  const XMP_PROPS = [
    ['xmp:CreatorTool', 'Creator tool'],
    ['xmp:CreateDate', 'Create date'],
    ['xmp:ModifyDate', 'Modify date'],
    ['xmp:MetadataDate', 'Metadata date'],
    ['photoshop:DateCreated', 'Date created'],
    ['exif:DateTimeOriginal', 'Date taken'],
    ['tiff:Make', 'Camera make'],
    ['tiff:Model', 'Camera model'],
    ['aux:Lens', 'Lens'],
    ['exifEX:LensModel', 'Lens model'],
    ['dc:title', 'Title'],
    ['dc:creator', 'Creator'],
    ['dc:description', 'Description'],
    ['dc:rights', 'Rights'],
    ['dc:subject', 'Keywords'],
    ['photoshop:Credit', 'Credit'],
    ['xmpMM:DocumentID', 'Document ID'],
  ];

  function decodeEntities(s) {
    return s
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
      .replace(/&amp;/g, '&');
  }

  function parseXmp(xml) {
    const result = { size: xml.length, fields: [] };
    for (const [prop, label] of XMP_PROPS) {
      const esc = prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      let value = null;
      const attr = xml.match(new RegExp(`\\s${esc}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`));
      if (attr) {
        value = attr[1] ?? attr[2];
      } else {
        const el = xml.match(new RegExp(`<${esc}(?:\\s[^>]*)?>([\\s\\S]*?)</${esc}>`));
        if (el) {
          const items = [...el[1].matchAll(/<rdf:li(?:\s[^>]*)?>([\s\S]*?)<\/rdf:li>/g)].map((m) => m[1]);
          value = (items.length ? items : [el[1]]).map((s) => s.replace(/<[^>]+>/g, '').trim()).filter(Boolean).join(', ');
        }
      }
      if (value) {
        value = cleanText(decodeEntities(value));
        if (value) result.fields.push({ label, key: prop, value: truncate(value, 1000) });
      }
    }
    return result;
  }

  /* ================================================================== *
   * Format detection
   * ================================================================== */

  function detectFormat(bytes) {
    if (bytes.length < 12) return null;
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
    if (bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG' && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'png';
    const sig = ascii(bytes, 0, 6);
    if (sig === 'GIF87a' || sig === 'GIF89a') return 'gif';
    if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'webp';
    if ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
        (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a)) return 'tiff';
    return null;
  }

  function identifyUnsupported(bytes) {
    const ftyp = ascii(bytes, 4, 4) === 'ftyp' ? ascii(bytes, 8, 4) : '';
    if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(ftyp)) return 'HEIC/HEIF';
    if (/^avi[fs]$/.test(ftyp)) return 'AVIF';
    if (ftyp) return 'This video/ISO-media';
    if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'BMP';
    if (bytes[0] === 0 && bytes[1] === 0 && (bytes[2] === 1 || bytes[2] === 2) && bytes[3] === 0) return 'ICO/CUR';
    if (ascii(bytes, 0, 4) === '8BPS') return 'Photoshop (PSD)';
    if ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2b) || (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[3] === 0x2b)) return 'BigTIFF';
    if (ascii(bytes, 0, 4) === '%PDF') return 'PDF';
    const head = ascii(bytes, 0, 512).trimStart().toLowerCase();
    if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'SVG';
    return null;
  }

  /* ================================================================== *
   * JPEG
   * ================================================================== */

  const JPEG_SOF = {
    0xc0: 'Baseline DCT, Huffman coding', 0xc1: 'Extended sequential DCT, Huffman coding',
    0xc2: 'Progressive DCT, Huffman coding', 0xc3: 'Lossless, Huffman coding',
    0xc5: 'Differential sequential DCT, Huffman', 0xc6: 'Differential progressive DCT, Huffman',
    0xc7: 'Differential lossless, Huffman', 0xc9: 'Extended sequential DCT, arithmetic coding',
    0xca: 'Progressive DCT, arithmetic coding', 0xcb: 'Lossless, arithmetic coding',
    0xcd: 'Differential sequential DCT, arithmetic', 0xce: 'Differential progressive DCT, arithmetic',
    0xcf: 'Differential lossless, arithmetic',
  };

  // IJG reference luminance quantization table (order is irrelevant: only the sum is used).
  const STD_LUMA_SUM = [
    16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56,
    14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92,
    49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
  ].reduce((a, b) => a + b, 0);

  function chromaSubsampling(components) {
    if (components.length !== 3) return null;
    const [y, cb, cr] = components;
    if (cb.h !== cr.h || cb.v !== cr.v || !cb.h || !cb.v) return 'Non-standard';
    const key = `${y.h / cb.h}x${y.v / cb.v}`;
    return {
      '1x1': '4:4:4 (no subsampling)', '2x1': '4:2:2', '2x2': '4:2:0', '1x2': '4:4:0',
      '4x1': '4:1:1', '4x2': '4:1:0',
    }[key] || `Non-standard (${y.h}×${y.v}, ${cb.h}×${cb.v})`;
  }

  async function parseJpeg(buffer, bytes, out) {
    const view = new DataView(buffer);
    const len = bytes.length;
    const icc = [];
    let off = 2;
    let sof = null;
    let jfif = null;
    let adobeTransform = null;
    let lumaQuantSum = null;
    let hasMpf = false;
    let hasIptc = false;

    while (off + 4 <= len) {
      if (bytes[off] !== 0xff) {
        out.warnings.push('Unexpected data in the JPEG marker stream; stopped reading headers early.');
        break;
      }
      const marker = bytes[off + 1];
      if (marker === 0xff) { off += 1; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
      if (marker === 0xd9 || marker === 0xda) break;

      const segLen = view.getUint16(off + 2);
      if (segLen < 2 || off + 2 + segLen > len) {
        out.warnings.push('The JPEG file appears truncated; some header segments could not be read.');
        break;
      }
      const d = off + 4;
      const dLen = segLen - 2;

      if (marker === 0xe0 && ascii(bytes, d, 5) === 'JFIF\0' && dLen >= 12) {
        jfif = {
          version: `${bytes[d + 5]}.${pad2(bytes[d + 6])}`,
          units: bytes[d + 7],
          x: view.getUint16(d + 8),
          y: view.getUint16(d + 10),
        };
      } else if (marker === 0xe1) {
        if (ascii(bytes, d, 6) === 'Exif\0\0' && !out.tiff) {
          try {
            out.tiff = parseTiff(buffer, d + 6, dLen - 6);
          } catch (err) {
            out.warnings.push(`The EXIF block is present but could not be read (${err.message}).`);
          }
        } else if (ascii(bytes, d, 29) === 'http://ns.adobe.com/xap/1.0/\0' && !out.xmpString) {
          out.xmpString = utf8.decode(bytes.subarray(d + 29, d + dLen));
        }
      } else if (marker === 0xe2) {
        if (ascii(bytes, d, 12) === 'ICC_PROFILE\0') {
          icc.push({ seq: bytes[d + 12], data: bytes.subarray(d + 14, d + dLen) });
        } else if (ascii(bytes, d, 4) === 'MPF\0') {
          hasMpf = true;
        }
      } else if (marker === 0xed && ascii(bytes, d, 14) === 'Photoshop 3.0\0') {
        hasIptc = true;
      } else if (marker === 0xee && ascii(bytes, d, 5) === 'Adobe' && dLen >= 12) {
        adobeTransform = bytes[d + 11];
      } else if (marker === 0xfe) {
        const comment = cleanText(utf8.decode(bytes.subarray(d, d + dLen)));
        if (comment) out.text.push({ key: 'JPEG comment', value: truncate(comment) });
      } else if (marker === 0xdb) {
        let p = d;
        const end = d + dLen;
        while (p < end) {
          const pq = bytes[p] >> 4;
          const tq = bytes[p] & 0x0f;
          p += 1;
          let sum = 0;
          for (let i = 0; i < 64 && p < end; i++) {
            sum += pq ? view.getUint16(p) : bytes[p];
            p += pq ? 2 : 1;
          }
          if (tq === 0 && lumaQuantSum === null) lumaQuantSum = sum;
        }
      } else if (JPEG_SOF[marker] && !sof && dLen >= 6) {
        const n = bytes[d + 5];
        const components = [];
        for (let i = 0; i < n && d + 6 + i * 3 + 2 < d + dLen; i++) {
          const c = d + 6 + i * 3;
          components.push({ id: bytes[c], h: bytes[c + 1] >> 4, v: bytes[c + 1] & 0x0f });
        }
        sof = {
          marker,
          precision: bytes[d],
          height: view.getUint16(d + 1),
          width: view.getUint16(d + 3),
          components,
        };
      }
      off += 2 + segLen;
    }

    if (sof) {
      out.width = sof.width;
      out.height = sof.height;
      const n = sof.components.length;
      const ids = sof.components.map((c) => c.id).join(',');
      let model;
      if (n === 1) model = 'Grayscale';
      else if (n === 3) model = adobeTransform === 0 || ids === '82,71,66' ? 'RGB' : 'YCbCr';
      else if (n === 4) model = adobeTransform === 2 ? 'YCCK' : 'CMYK';
      else model = `${n} components`;
      out.colorModel = model;
      out.alpha = false;
      out.bitsPerPixel = sof.precision * n;
      out.colorDepth = n === 1
        ? `${sof.precision}-bit grayscale`
        : `${sof.precision * n}-bit (${sof.precision} bits × ${n} channels)`;
      out.encoding.push(['Compression', JPEG_SOF[sof.marker]]);
      out.encoding.push(['Progressive', sof.marker === 0xc2 || sof.marker === 0xca ? 'Yes' : 'No']);
      out.encoding.push(['Components', `${n} (${model})`]);
      const ss = chromaSubsampling(sof.components);
      if (ss) out.encoding.push(['Chroma subsampling', ss]);
      if (sof.height === 0) out.warnings.push('Image height is defined later in the stream (DNL marker); the reported height may be inaccurate.');
    } else {
      out.warnings.push('No JPEG frame header was found, so dimensions could not be read from the file.');
    }

    if (lumaQuantSum) {
      const scale = (lumaQuantSum * 100) / STD_LUMA_SUM;
      const q = scale <= 100 ? (200 - scale) / 2 : 5000 / scale;
      out.encoding.push(['Estimated quality', `≈ ${Math.max(1, Math.min(100, Math.round(q)))} (from quantization tables)`]);
    }
    if (jfif) {
      out.encoding.push(['JFIF version', jfif.version]);
      if (jfif.units === 1 || jfif.units === 2) {
        const u = jfif.units === 1 ? 'dpi' : 'dots/cm';
        out.jfifResolution = jfif.x === jfif.y ? `${jfif.x} ${u}` : `${jfif.x} × ${jfif.y} ${u}`;
      }
    }
    if (adobeTransform !== null) out.encoding.push(['Adobe APP14 segment', ['None (RGB/CMYK)', 'YCbCr', 'YCCK'][adobeTransform] || `Transform ${adobeTransform}`]);
    if (hasMpf) out.encoding.push(['Multi-Picture Format', 'Yes – file contains additional embedded images']);
    if (hasIptc) out.encoding.push(['IPTC / Photoshop IRB', 'Present (not decoded)']);

    if (icc.length) {
      icc.sort((a, b) => a.seq - b.seq);
      const total = icc.reduce((n, c) => n + c.data.length, 0);
      const joined = new Uint8Array(total);
      let o = 0;
      for (const c of icc) {
        joined.set(c.data, o);
        o += c.data.length;
      }
      out.icc = parseIcc(joined) || { description: null, size: total };
    }
  }

  /* ================================================================== *
   * PNG
   * ================================================================== */

  const PNG_COLOR_TYPES = {
    0: ['Grayscale', 1], 2: ['Truecolor (RGB)', 3], 3: ['Indexed color', 1],
    4: ['Grayscale + alpha', 2], 6: ['Truecolor + alpha (RGBA)', 4],
  };
  const SRGB_INTENTS = ['Perceptual', 'Relative colorimetric', 'Saturation', 'Absolute colorimetric'];

  function decodeRawProfile(text) {
    // ImageMagick-style "Raw profile type …" text: "\n<type>\n<size>\n<hex…>"
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length < 3) return null;
    const hex = lines.slice(2).join('').replace(/[^0-9a-f]/gi, '');
    if (hex.length < 16) return null;
    const out = new Uint8Array(hex.length >> 1);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  function tiffFromBytes(data, out, label) {
    let start = 0;
    if (ascii(data, 0, 6) === 'Exif\0\0') start = 6;
    try {
      const copy = data.slice(start);
      out.tiff = parseTiff(copy.buffer, 0, copy.byteLength);
    } catch (err) {
      out.warnings.push(`${label} is present but could not be read (${err.message}).`);
    }
  }

  async function handlePngText(key, value, out) {
    if (key === 'XML:com.adobe.xmp') {
      out.xmpString = out.xmpString || value;
      return;
    }
    const raw = key.match(/^Raw profile type (exif|APP1|xmp)$/i);
    if (raw) {
      const data = decodeRawProfile(value);
      if (data) {
        if (/xmp/i.test(raw[1])) out.xmpString = out.xmpString || utf8.decode(data);
        else if (!out.tiff) tiffFromBytes(data, out, 'An embedded EXIF profile');
      }
      return;
    }
    if (/^Raw profile type/i.test(key)) {
      out.text.push({ key, value: '(hex-encoded profile, not decoded)' });
      return;
    }
    const clean = cleanText(value);
    if (clean) out.text.push({ key: key || '(no keyword)', value: truncate(clean) });
  }

  async function parsePng(buffer, bytes, out) {
    const view = new DataView(buffer);
    const len = bytes.length;
    const chunkOrder = [];
    let off = 8;
    let ihdr = null;
    let paletteEntries = 0;
    let hasTrns = false;
    let idatCount = 0;
    let sawEnd = false;

    while (off + 12 <= len) {
      const cLen = view.getUint32(off);
      const type = ascii(bytes, off + 4, 4);
      const d = off + 8;
      if (d + cLen + 4 > len) {
        out.warnings.push(`The PNG file appears truncated inside the "${type}" chunk.`);
        break;
      }
      const last = chunkOrder[chunkOrder.length - 1];
      if (last && last.type === type) last.count++;
      else chunkOrder.push({ type, count: 1 });

      const data = bytes.subarray(d, d + cLen);
      switch (type) {
        case 'IHDR':
          if (cLen >= 13) {
            ihdr = {
              width: view.getUint32(d), height: view.getUint32(d + 4), bitDepth: bytes[d + 8],
              colorType: bytes[d + 9], interlace: bytes[d + 12],
            };
          }
          break;
        case 'PLTE': paletteEntries = Math.floor(cLen / 3); break;
        case 'tRNS': hasTrns = true; break;
        case 'IDAT': idatCount++; break;
        case 'gAMA':
          if (cLen >= 4) out.encoding.push(['Gamma (gAMA)', String(round(view.getUint32(d) / 100000, 5))]);
          break;
        case 'sRGB':
          out.encoding.push(['sRGB rendering intent', SRGB_INTENTS[bytes[d]] || `Unknown (${bytes[d]})`]);
          out.icc = out.icc || { description: 'sRGB (sRGB chunk)', colorSpace: 'RGB', version: null };
          break;
        case 'cHRM': out.encoding.push(['Chromaticities (cHRM)', 'Present']); break;
        case 'cICP':
          if (cLen >= 4) out.encoding.push(['Coding-independent code points (cICP)', `Primaries ${bytes[d]}, transfer ${bytes[d + 1]}, matrix ${bytes[d + 2]}`]);
          break;
        case 'iCCP': {
          const nul = indexOfByte(data, 0, 0, Math.min(80, data.length));
          if (nul > 0) {
            const name = cleanText(latin1.decode(data.subarray(0, nul)));
            const inflated = await inflate(data.subarray(nul + 2));
            const parsed = inflated ? parseIcc(inflated) : null;
            out.icc = parsed ? { ...parsed, description: parsed.description || name } : { description: name || null };
          }
          break;
        }
        case 'pHYs':
          if (cLen >= 9 && bytes[d + 8] === 1) {
            const x = Math.round(view.getUint32(d) * 0.0254);
            const y = Math.round(view.getUint32(d + 4) * 0.0254);
            out.pngResolution = x === y ? `${x} dpi` : `${x} × ${y} dpi`;
          } else if (cLen >= 9) {
            out.encoding.push(['Pixel aspect (pHYs)', `${view.getUint32(d)}:${view.getUint32(d + 4)}`]);
          }
          break;
        case 'tIME':
          if (cLen >= 7) {
            const y = view.getUint16(d);
            out.encoding.push(['Last modified (tIME)', `${y}-${pad2(bytes[d + 2])}-${pad2(bytes[d + 3])} ${pad2(bytes[d + 4])}:${pad2(bytes[d + 5])}:${pad2(bytes[d + 6])} UTC`]);
          }
          break;
        case 'acTL':
          if (cLen >= 8) {
            const plays = view.getUint32(d + 4);
            out.animation = { frames: view.getUint32(d), loop: plays === 0 ? 'Infinite' : `${plays} time${plays === 1 ? '' : 's'}`, type: 'APNG' };
          }
          break;
        case 'eXIf':
          if (!out.tiff) tiffFromBytes(data, out, 'The eXIf chunk');
          break;
        case 'tEXt': {
          const nul = indexOfByte(data, 0, 0, data.length);
          if (nul >= 0) await handlePngText(latin1.decode(data.subarray(0, nul)), latin1.decode(data.subarray(nul + 1)), out);
          break;
        }
        case 'zTXt': {
          const nul = indexOfByte(data, 0, 0, data.length);
          if (nul >= 0) {
            const key = latin1.decode(data.subarray(0, nul));
            const inflated = await inflate(data.subarray(nul + 2));
            if (inflated) await handlePngText(key, latin1.decode(inflated), out);
            else out.text.push({ key, value: '(compressed text could not be decoded in this browser)' });
          }
          break;
        }
        case 'iTXt': {
          const nul = indexOfByte(data, 0, 0, data.length);
          if (nul < 0) break;
          const key = latin1.decode(data.subarray(0, nul));
          const compressed = data[nul + 1] === 1;
          const langEnd = indexOfByte(data, 0, nul + 3, data.length);
          if (langEnd < 0) break;
          const transEnd = indexOfByte(data, 0, langEnd + 1, data.length);
          if (transEnd < 0) break;
          let body = data.subarray(transEnd + 1);
          if (compressed) {
            const inflated = await inflate(body);
            if (!inflated) {
              out.text.push({ key, value: '(compressed text could not be decoded in this browser)' });
              break;
            }
            body = inflated;
          }
          await handlePngText(key, utf8.decode(body), out);
          break;
        }
        case 'IEND': sawEnd = true; break;
        default: break;
      }
      if (sawEnd) break;
      off = d + cLen + 4;
    }

    if (!ihdr) throw new Error('missing IHDR header chunk');
    out.width = ihdr.width;
    out.height = ihdr.height;
    const [ctName, channels] = PNG_COLOR_TYPES[ihdr.colorType] || [`Unknown (${ihdr.colorType})`, 1];
    out.colorModel = ctName;
    out.alpha = ihdr.colorType === 4 || ihdr.colorType === 6 || hasTrns;
    out.alphaDetail = ihdr.colorType === 4 || ihdr.colorType === 6 ? 'Yes (alpha channel)' : hasTrns ? 'Yes (tRNS transparency)' : 'No';
    out.bitsPerPixel = ihdr.bitDepth * channels;
    if (ihdr.colorType === 3) {
      out.colorDepth = `${ihdr.bitDepth}-bit indexed (${paletteEntries || 2 ** ihdr.bitDepth}-color palette)`;
    } else if (channels === 1) {
      out.colorDepth = `${ihdr.bitDepth}-bit grayscale`;
    } else {
      out.colorDepth = `${ihdr.bitDepth * channels}-bit (${ihdr.bitDepth} bits × ${channels} channels)`;
    }
    out.encoding.unshift(
      ['Color type', `${ctName} (type ${ihdr.colorType})`],
      ['Bit depth', `${ihdr.bitDepth} bits per sample`],
      ['Compression', 'Deflate (zlib)'],
      ['Interlace', ihdr.interlace === 1 ? 'Adam7 (interlaced)' : 'None'],
    );
    if (ihdr.colorType === 3) out.encoding.push(['Palette (PLTE)', `${paletteEntries} colors`]);
    out.encoding.push(['Image data', `${idatCount} IDAT chunk${idatCount === 1 ? '' : 's'}`]);
    out.encoding.push(['Chunk layout', chunkOrder.map((c) => (c.count > 1 ? `${c.type} ×${c.count}` : c.type)).join(', ')]);
  }

  /* ================================================================== *
   * GIF
   * ================================================================== */

  async function parseGif(buffer, bytes, out) {
    const view = new DataView(buffer);
    const len = bytes.length;
    const version = ascii(bytes, 0, 6);
    out.width = view.getUint16(6, true);
    out.height = view.getUint16(8, true);
    const packed = bytes[10];
    const hasGct = !!(packed & 0x80);
    const colorRes = ((packed >> 4) & 7) + 1;
    const gctBits = (packed & 7) + 1;
    const gctSize = hasGct ? 2 ** gctBits : 0;

    let off = 13 + gctSize * 3;
    let frames = 0;
    let delay = 0;
    let pendingDelay = 0;
    let loop = null;
    let transparent = false;
    let interlaced = null;
    let localTables = 0;
    let complete = false;

    const skipSubBlocks = (p) => {
      while (p < len && bytes[p] !== 0) p += bytes[p] + 1;
      return p + 1;
    };

    while (off < len) {
      const b = bytes[off];
      if (b === 0x3b) { complete = true; break; }
      if (b === 0x21) {
        const label = bytes[off + 1];
        let p = off + 2;
        if (label === 0xf9 && bytes[p] >= 4) {
          const flags = bytes[p + 1];
          pendingDelay = view.getUint16(p + 2, true);
          if (flags & 1) transparent = true;
        } else if (label === 0xff && bytes[p] === 11) {
          const id = ascii(bytes, p + 1, 11);
          const sub = p + 12;
          if ((id === 'NETSCAPE2.0' || id === 'ANIMEXTS1.0') && bytes[sub] >= 3 && bytes[sub + 1] === 1) {
            loop = view.getUint16(sub + 2, true);
          } else if (id === 'XMP DataXMP') {
            // XMP in GIF is stored as raw sub-blocks followed by a "magic trailer".
            const end = skipSubBlocks(sub);
            const raw = latin1.decode(bytes.subarray(sub, Math.max(sub, end - 258)));
            const close = raw.lastIndexOf('<?xpacket end');
            out.xmpString = out.xmpString || (close > 0 ? raw.slice(0, raw.indexOf('>', close) + 1) : raw);
          }
        } else if (label === 0xfe) {
          let text = '';
          let q = p;
          while (q < len && bytes[q] !== 0) {
            text += latin1.decode(bytes.subarray(q + 1, q + 1 + bytes[q]));
            q += bytes[q] + 1;
          }
          text = cleanText(text);
          if (text) out.text.push({ key: 'GIF comment', value: truncate(text) });
        }
        off = skipSubBlocks(p);
      } else if (b === 0x2c) {
        if (off + 10 > len) break;
        frames++;
        delay += pendingDelay;
        pendingDelay = 0;
        const ip = bytes[off + 9];
        if (interlaced === null) interlaced = !!(ip & 0x40);
        const lct = ip & 0x80 ? 2 ** ((ip & 7) + 1) : 0;
        if (lct) localTables++;
        off = skipSubBlocks(off + 10 + lct * 3 + 1);
      } else {
        out.warnings.push('Unexpected data in the GIF block stream; frame count may be incomplete.');
        break;
      }
    }
    if (!complete && off >= len) out.warnings.push('The GIF trailer is missing; the file may be truncated.');

    out.colorModel = 'Indexed color';
    out.alpha = transparent;
    out.alphaDetail = transparent ? 'Yes (1-bit transparency index)' : 'No';
    out.bitsPerPixel = hasGct ? gctBits : null;
    out.colorDepth = hasGct ? `${gctBits}-bit indexed (${gctSize}-color palette)` : 'Indexed (local color tables only)';
    out.encoding.push(['Version', version]);
    out.encoding.push(['Compression', 'LZW']);
    out.encoding.push(['Global color table', hasGct ? `${gctSize} colors` : 'None']);
    out.encoding.push(['Color resolution', `${colorRes} bits per primary`]);
    if (localTables) out.encoding.push(['Local color tables', `${localTables} frame${localTables === 1 ? '' : 's'}`]);
    if (interlaced !== null) out.encoding.push(['Interlaced', interlaced ? 'Yes' : 'No']);
    out.encoding.push(['Frames', String(frames)]);
    if (frames > 1) {
      out.animation = {
        type: 'Animated GIF',
        frames,
        durationMs: delay * 10,
        loop: loop === null ? 'Plays once' : loop === 0 ? 'Infinite' : `${loop} repeat${loop === 1 ? '' : 's'}`,
      };
    }
  }

  /* ================================================================== *
   * WebP
   * ================================================================== */

  async function parseWebp(buffer, bytes, out) {
    const view = new DataView(buffer);
    const len = bytes.length;
    const chunks = [];
    let off = 12;
    let vp8x = null;
    let codec = null;
    let alphaChunk = false;
    let lossless = { alpha: false };
    let frames = 0;
    let duration = 0;
    let loop = null;

    const readCodec = (p, type, size) => {
      if (type === 'VP8 ' && size >= 10 && bytes[p + 3] === 0x9d && bytes[p + 4] === 0x01 && bytes[p + 5] === 0x2a) {
        return { codec: 'VP8', width: view.getUint16(p + 6, true) & 0x3fff, height: view.getUint16(p + 8, true) & 0x3fff };
      }
      if (type === 'VP8L' && size >= 5 && bytes[p] === 0x2f) {
        const bits = view.getUint32(p + 1, true);
        return { codec: 'VP8L', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, alpha: !!((bits >>> 28) & 1) };
      }
      return null;
    };

    while (off + 8 <= len) {
      const type = ascii(bytes, off, 4);
      const size = view.getUint32(off + 4, true);
      const d = off + 8;
      if (d + size > len) {
        out.warnings.push(`The WebP file appears truncated inside the "${type.trim()}" chunk.`);
        break;
      }
      const last = chunks[chunks.length - 1];
      if (last && last.type === type.trim()) last.count++;
      else chunks.push({ type: type.trim(), count: 1 });

      if (type === 'VP8X' && size >= 10) {
        const f = bytes[d];
        vp8x = {
          icc: !!(f & 0x20), alpha: !!(f & 0x10), exif: !!(f & 0x08), xmp: !!(f & 0x04), animation: !!(f & 0x02),
          width: 1 + (bytes[d + 4] | (bytes[d + 5] << 8) | (bytes[d + 6] << 16)),
          height: 1 + (bytes[d + 7] | (bytes[d + 8] << 8) | (bytes[d + 9] << 16)),
        };
      } else if ((type === 'VP8 ' || type === 'VP8L') && !codec) {
        codec = readCodec(d, type, size);
      } else if (type === 'ALPH') {
        alphaChunk = true;
      } else if (type === 'ICCP') {
        out.icc = parseIcc(bytes.slice(d, d + size)) || { description: null };
      } else if (type === 'EXIF') {
        if (!out.tiff) tiffFromBytes(bytes.subarray(d, d + size), out, 'The EXIF chunk');
      } else if (type === 'XMP ') {
        out.xmpString = out.xmpString || utf8.decode(bytes.subarray(d, d + size));
      } else if (type === 'ANIM' && size >= 6) {
        loop = view.getUint16(d + 4, true);
      } else if (type === 'ANMF' && size >= 16) {
        frames++;
        duration += bytes[d + 12] | (bytes[d + 13] << 8) | (bytes[d + 14] << 16);
        if (!codec && size >= 24) {
          const inner = ascii(bytes, d + 16, 4);
          if (inner === 'ALPH') alphaChunk = true;
          // Look for the first frame's image bitstream inside the frame.
          let q = d + 16;
          while (q + 8 <= d + size) {
            const t = ascii(bytes, q, 4);
            const s = view.getUint32(q + 4, true);
            if (t === 'ALPH') alphaChunk = true;
            if (t === 'VP8 ' || t === 'VP8L') {
              codec = readCodec(q + 8, t, s);
              break;
            }
            q += 8 + s + (s & 1);
          }
        }
      }
      off = d + size + (size & 1);
    }

    if (codec && codec.codec === 'VP8L') lossless = { alpha: codec.alpha };
    out.width = vp8x ? vp8x.width : codec ? codec.width : null;
    out.height = vp8x ? vp8x.height : codec ? codec.height : null;
    if (!out.width) throw new Error('no image bitstream header found');

    const isLossless = codec && codec.codec === 'VP8L';
    const hasAlpha = (vp8x && vp8x.alpha) || alphaChunk || lossless.alpha;
    out.alpha = !!hasAlpha;
    out.alphaDetail = hasAlpha ? 'Yes' : 'No';
    out.colorModel = isLossless ? 'ARGB' : 'YUV 4:2:0 (decoded as RGB)';
    out.bitsPerPixel = hasAlpha ? 32 : 24;
    out.colorDepth = hasAlpha ? '32-bit (8 bits × 4 channels, RGBA)' : '24-bit (8 bits × 3 channels)';
    out.encoding.push(['Container', vp8x ? 'Extended (VP8X)' : 'Simple']);
    let compression = 'Unknown';
    if (codec) compression = isLossless ? 'Lossless (VP8L)' : alphaChunk ? 'Lossy (VP8) with alpha (ALPH)' : 'Lossy (VP8)';
    out.encoding.push(['Compression', compression + (frames > 1 ? ' – first frame' : '')]);
    out.encoding.push(['Chunk layout', chunks.map((c) => (c.count > 1 ? `${c.type} ×${c.count}` : c.type)).join(', ')]);
    if (vp8x && vp8x.animation) {
      out.animation = {
        type: 'Animated WebP',
        frames,
        durationMs: duration,
        loop: loop === null ? 'Unknown' : loop === 0 ? 'Infinite' : `${loop} time${loop === 1 ? '' : 's'}`,
      };
    }
  }

  /* ================================================================== *
   * TIFF
   * ================================================================== */

  async function parseTiffFile(buffer, bytes, out) {
    const tiff = parseTiff(buffer, 0, bytes.length);
    out.tiff = tiff;
    const t = (tag) => getTag(tiff.ifd0, tag);
    out.width = num(t(0x0100));
    out.height = num(t(0x0101));
    const bps = t(0x0102);
    const bitsArr = Array.isArray(bps) ? bps : bps != null ? [bps] : [1];
    const spp = num(t(0x0115)) || bitsArr.length || 1;
    const bitsPer = bitsArr[0] || 1;
    const total = Array.isArray(bps) ? bps.reduce((a, b) => a + b, 0) : bitsPer * spp;
    const photometric = num(t(0x0106));
    const extra = t(0x0152);
    const extraArr = extra == null ? [] : Array.isArray(extra) ? extra : [extra];

    out.colorModel = photometric != null ? ENUMS.PhotometricInterpretation[photometric] || `Photometric ${photometric}` : null;
    out.bitsPerPixel = total;
    out.colorDepth = spp === 1 ? `${bitsPer}-bit ${photometric === 3 ? 'indexed' : 'grayscale'}` : `${total}-bit (${bitsPer} bits × ${spp} channels)`;
    out.alpha = extraArr.some((v) => v === 1 || v === 2);
    out.alphaDetail = out.alpha ? `Yes (${ENUMS.ExtraSamples[extraArr.find((v) => v === 1 || v === 2)]})` : extraArr.length ? 'Extra samples (unspecified)' : 'No';

    out.encoding.push(['Byte order', tiff.littleEndian ? 'Little-endian (Intel, "II")' : 'Big-endian (Motorola, "MM")']);
    const comp = num(t(0x0103));
    out.encoding.push(['Compression', comp != null ? TIFF_COMPRESSION[comp] || `Unknown (${comp})` : 'Uncompressed (default)']);
    if (photometric != null) out.encoding.push(['Photometric interpretation', out.colorModel]);
    out.encoding.push(['Samples per pixel', String(spp)]);
    const planar = num(t(0x011c));
    if (planar) out.encoding.push(['Planar configuration', ENUMS.PlanarConfiguration[planar] || String(planar)]);
    const sf = num(t(0x0153));
    if (sf) out.encoding.push(['Sample format', ENUMS.SampleFormat[sf] || String(sf)]);
    const pred = num(t(0x013d));
    if (pred) out.encoding.push(['Predictor', ENUMS.Predictor[pred] || String(pred)]);
    if (t(0x0142) != null) out.encoding.push(['Layout', `Tiled (${num(t(0x0142))} × ${num(t(0x0143))})`]);
    else out.encoding.push(['Layout', 'Strips']);
    out.encoding.push(['Image directories (pages)', String(tiff.directoryCount)]);
    if (getTag(tiff.ifd0, 0x83bb) != null) out.encoding.push(['IPTC-NAA', 'Present (not decoded)']);

    const icc = t(0x8773);
    if (icc instanceof Uint8Array) out.icc = parseIcc(icc) || { description: null };
    const xmp = t(0x02bc);
    if (xmp instanceof Uint8Array) out.xmpString = utf8.decode(xmp);
  }

  /* ================================================================== *
   * Public entry point
   * ================================================================== */

  const FORMATS = {
    jpeg: { name: 'JPEG', mime: 'image/jpeg', parse: parseJpeg },
    png: { name: 'PNG', mime: 'image/png', parse: parsePng },
    gif: { name: 'GIF', mime: 'image/gif', parse: parseGif },
    webp: { name: 'WebP', mime: 'image/webp', parse: parseWebp },
    tiff: { name: 'TIFF', mime: 'image/tiff', parse: parseTiffFile },
  };

  /**
   * Analyze an image file's bytes.
   * @param {ArrayBuffer} buffer
   * @returns {Promise<object>} structured metadata result
   */
  async function analyze(buffer) {
    const bytes = new Uint8Array(buffer);
    const kind = detectFormat(bytes);
    if (!kind) {
      const other = identifyUnsupported(bytes);
      throw new UnsupportedFormatError(
        other
          ? `${other} files aren't supported. PixelPeek can read JPEG, PNG, WebP, GIF and TIFF images.`
          : "This file doesn't look like a supported image. PixelPeek can read JPEG, PNG, WebP, GIF and TIFF images.",
      );
    }

    const fmt = FORMATS[kind];
    const out = {
      kind,
      format: fmt.name,
      mime: fmt.mime,
      width: null,
      height: null,
      colorModel: null,
      colorDepth: null,
      bitsPerPixel: null,
      alpha: null,
      alphaDetail: null,
      encoding: [],
      animation: null,
      icc: null,
      xmp: null,
      text: [],
      exif: null,
      gps: null,
      resolution: null,
      warnings: [],
      tiff: null,
      xmpString: null,
    };

    try {
      await fmt.parse(buffer, bytes, out);
    } catch (err) {
      out.warnings.push(`Part of the ${fmt.name} structure could not be read (${err.message}).`);
    }

    if (out.tiff) {
      try {
        out.exif = interpretExif(out.tiff);
        out.gps = interpretGps(out.tiff.gps);
        if (kind === 'jpeg' && out.exif.thumbnailBytes) {
          out.encoding.push(['Embedded EXIF thumbnail', `Yes (${(out.exif.thumbnailBytes / 1024).toFixed(1)} KB)`]);
        }
        if (out.exif.hasMakerNote) out.encoding.push(['Maker notes', 'Present (proprietary, not decoded)']);
      } catch (err) {
        out.warnings.push(`EXIF data was found but could not be interpreted (${err.message}).`);
      }
    }

    if (out.xmpString) {
      try {
        out.xmp = parseXmp(out.xmpString);
      } catch (err) {
        out.xmp = { size: out.xmpString.length, fields: [] };
      }
    }

    out.resolution = (out.exif && out.exif.fields.resolution) || out.jfifResolution || out.pngResolution || null;

    if (out.width === 0 || out.height === 0) {
      out.width = out.width || null;
      out.height = out.height || null;
    }

    // Internal parse state is not part of the public result.
    delete out.tiff;
    delete out.xmpString;
    delete out.jfifResolution;
    delete out.pngResolution;
    return out;
  }

  global.PixelPeekMetadata = {
    analyze,
    UnsupportedFormatError,
    SUPPORTED_FORMATS: Object.values(FORMATS).map((f) => f.name),
  };
})(typeof window !== 'undefined' ? window : globalThis);
