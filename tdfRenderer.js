// tdfRenderer.js v1.10 (Optimized layout metrics lookup)
// TheDraw Font (.TDF) text rendering library for HTML Canvas
// Uses preprocessed BINARY font bundle.
// Copyright (C) 2012-2025 Ori Livneh & Contributors
// Licensed under the MIT and GPL licenses

((global) => {
  // --- Constants ---

  const CharWidth = 8; // Standard width of a CP437 character cell in pixels.
  const CharHeight = 16; // Standard height of a CP437 character cell in pixels.

  const DefaultMinSpaceWidth = 3; // Default minimum width for a space char (in char units).

  const BinNewlineCode = 0x0d; // Byte code for newline in TDF glyph stream.
  const BinGlyphTerminator = 0x00; // Byte code terminating a TDF glyph stream.
  const NewlineCode = -1; // Internal representation for a newline.

  // Standard CGA/EGA/VGA 16-color palette (RGBA format).
  const TdfColors = [
    [0, 0, 0, 255],
    [0, 0, 170, 255],
    [0, 170, 0, 255],
    [0, 170, 170, 255],
    [170, 0, 0, 255],
    [170, 0, 170, 255],
    [170, 85, 0, 255],
    [170, 170, 170, 255],
    [85, 85, 85, 255],
    [85, 85, 255, 255],
    [85, 255, 85, 255],
    [85, 255, 255, 255],
    [255, 85, 85, 255],
    [255, 85, 255, 255],
    [255, 255, 85, 255],
    [255, 255, 255, 255],
  ];

  // --- CP437 Font Data ---

  /**
   * Retrieves pre-loaded CP437 font data.
   * Expects `globalThis.cp437font` to be an array of 256 bitmaps.
   * @returns {Array<Array<number>>} The CP437 font data or a dummy array.
   */
  function getCp437FontData() {
    if (
      typeof globalThis !== "undefined" &&
      Array.isArray(globalThis.cp437font) &&
      globalThis.cp437font.length >= 256
    ) {
      return globalThis.cp437font;
    }
    console.error("tdfRenderer Error: globalThis.cp437font not found or invalid. CP437 rendering may fail.");
    return new Array(256).fill([]); // Dummy data to prevent downstream errors.
  }
  const cp437FontData = getCp437FontData();

  // --- Internal State ---

  let _bundleBuffer = null; // ArrayBuffer of the TDF font bundle.
  let _bundleView = null; // DataView for accessing _bundleBuffer.
  let _fontIndex = new Map(); // Maps font unique key (string) to its data offset (number).
  let _stringPoolOffset = 0; // Start offset of the string pool in the bundle.
  let _fontDataPoolOffset = 0; // Start offset of the font data pool in the bundle.
  let _isInitialized = false; // True if init() has successfully completed.

  // --- Utilities: File I/O & String Parsing ---

  /**
   * Fetches binary data from a URL.
   * @param {string} url - The URL to fetch.
   * @returns {Promise<ArrayBuffer>} A promise resolving with the ArrayBuffer.
   * @throws {Error} If fetching fails.
   */
  async function fetchBinary(url) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP error! Status: ${response.status} fetching ${url}`);
      }
      return await response.arrayBuffer();
    } catch (error) {
      console.error(`tdfRenderer: Error fetching binary data from ${url}:`, error);
      throw error; // Re-throw for caller handling.
    }
  }

  /**
   * Reads a null-terminated UTF-8 string from a DataView.
   * @param {DataView} dataView - The DataView to read from.
   * @param {number} startOffset - The offset where the string begins.
   * @returns {string} The decoded string, or an empty string on failure.
   */
  function readNullTerminatedString(dataView, startOffset) {
    let endOffset = startOffset;
    while (endOffset < dataView.byteLength && dataView.getUint8(endOffset) !== 0) {
      endOffset++;
    }

    if (endOffset === startOffset) {
      return "";
    }

    const stringBytes = new Uint8Array(dataView.buffer, dataView.byteOffset + startOffset, endOffset - startOffset);

    try {
      return new TextDecoder().decode(stringBytes);
    } catch {
      // Fallback for older environments or specific TextDecoder issues.
      // Note: String.fromCharCode can have issues with large strings or non-BMP chars,
      // but likely acceptable for font keys.
      try {
        return String.fromCharCode.apply(null, stringBytes);
      } catch (decodeError) {
        console.warn("tdfRenderer: String decoding failed with TextDecoder and fallback:", decodeError);
        return "";
      }
    }
  }

  // --- Utilities: CP437 Character Rendering ---

  /**
   * Fills an ImageData object with a specified color.
   * @param {ImageData} imageData - The ImageData object to fill.
   * @param {Array<number>} colorRgba - The RGBA color array [r, g, b, a].
   */
  function _fillImageData(imageData, colorRgba) {
    const data = imageData.data;
    const [r, g, b, a] = colorRgba;
    for (let i = 0; i < data.length; i += 4) {
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }

  /**
   * Draws a single CP437 character onto a canvas context.
   * @param {CanvasRenderingContext2D} context - The 2D rendering context.
   * @param {number} charCode - The CP437 character code (0-255).
   * @param {number} canvasX - The x-coordinate on the canvas.
   * @param {number} canvasY - The y-coordinate on the canvas.
   * @param {Array<number>} fgColorRgba - Foreground RGBA color.
   * @param {Array<number>} bgColorRgba - Background RGBA color.
   */
  function drawCp437Char(context, charCode, canvasX, canvasY, fgColorRgba, bgColorRgba) {
    if (typeof context.createImageData !== "function") {
      return; // Environment doesn't support ImageData.
    }

    let imageData;
    try {
      imageData = context.createImageData(CharWidth, CharHeight);
    } catch (e) {
      console.warn("tdfRenderer: context.createImageData failed.", e);
      return;
    }

    const data = imageData.data;
    const code = charCode & 0xff; // Ensure 0-255 range.
    const bitmap = cp437FontData[code];

    if (!bitmap || bitmap.length < CharHeight) {
      // Undefined or invalid character bitmap.
      // Fill with background color. If background is fully transparent, use transparent black.
      const fillColor = bgColorRgba[3] > 0 ? bgColorRgba : [0, 0, 0, 0];
      _fillImageData(imageData, fillColor);
    } else {
      // Valid character bitmap: render pixels.
      for (let row = 0; row < CharHeight; row++) {
        const rowBits = bitmap[row] || 0x00; // Default to empty row.
        for (let col = 0; col < CharWidth; col++) {
          const offset = (row * CharWidth + col) * 4;
          const isForeground = (rowBits >> (7 - col)) & 1;
          const [r, g, b, a] = isForeground ? fgColorRgba : bgColorRgba;

          data[offset] = r;
          data[offset + 1] = g;
          data[offset + 2] = b;
          data[offset + 3] = a;
        }
      }
    }
    // Use Math.floor for canvas coordinates to ensure pixel-perfect alignment.
    context.putImageData(imageData, Math.floor(canvasX), Math.floor(canvasY));
  }

  // --- Utilities: TDF Glyph Parsing & Metrics ---

  /**
   * Performs binary search in a font's Glyph Lookup Table (GLT) for a char's data offset.
   * GLT entries: [Char Code (1 byte), Relative Data Offset (2 bytes, LE)].
   * Assumes _bundleView is initialized.
   * @param {number} lookupTableOffset - Start offset of the GLT in _bundleView.
   * @param {number} glyphCount - Number of glyphs/entries in the GLT.
   * @param {number} charCode - Character code to find.
   * @returns {number} Relative offset of glyph data if found, else -1.
   */
  function _findGlyphOffsetInLookupTable(lookupTableOffset, glyphCount, charCode) {
    let low = 0;
    let high = glyphCount - 1;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const entryOffset = lookupTableOffset + mid * 3; // Each entry is 3 bytes.

      if (entryOffset + 3 > _bundleView.byteLength) {
        return -1; // Safety: entry out of bounds.
      }

      const entryCharCode = _bundleView.getUint8(entryOffset);

      if (entryCharCode === charCode) {
        return _bundleView.getUint16(entryOffset + 1, true); // Found: return 2-byte offset (LE).
      }

      if (charCode < entryCharCode) {
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
    return -1; // Not found.
  }

  /**
   * Parses a raw TDF glyph byte stream into a compact array.
   * Compact data: [Char Code, Attribute Byte] pairs, or NEWLINE_CODE.
   * Assumes _bundleView is initialized.
   * @param {number} glyphStreamStartOffset - Offset where the glyph stream begins.
   * @returns {Array<number>} Array of glyph drawing instructions.
   */
  function _parseGlyphByteStream(glyphStreamStartOffset) {
    const compactData = [];
    let currentOffset = glyphStreamStartOffset;
    let byteValue;

    while (currentOffset < _bundleView.byteLength) {
      byteValue = _bundleView.getUint8(currentOffset++);
      if (byteValue === BinGlyphTerminator) {
        break;
      }

      if (byteValue === BinNewlineCode) {
        compactData.push(NewlineCode);
      } else {
        const charCodeByte = byteValue;
        if (currentOffset >= _bundleView.byteLength) {
          console.warn("tdfRenderer: Glyph stream ended prematurely (missing attribute byte).");
          break;
        }
        const attrByte = _bundleView.getUint8(currentOffset++);
        compactData.push(charCodeByte, attrByte);
      }
    }
    return compactData;
  }

  /**
   * Reads basic font properties (glyph count, table offsets) from the font-specific data block.
   * Assumes _bundleView is initialized.
   * @param {number} fontPoolBase - Starting offset of the entire font data pool.
   * @param {number} fontDataOffsetInPool - Offset of this specific font's data within the pool.
   * @returns {{glyphCount: number, lookupTableStart: number, glyphDataTableBase: number} | null}
   *          Font properties or null on error (e.g., insufficient data for header).
   */
  function _getFontInternalHeader(fontPoolBase, fontDataOffsetInPool) {
    const fontBase = fontPoolBase + fontDataOffsetInPool;
    // Font Data Structure: [Spacing (1B), Glyph Count (1B), GLT (...), Glyph Data Table (...)]
    if (fontBase + 2 > _bundleView.byteLength) {
      return null; // Need at least Spacing + Glyph Count.
    }

    const glyphCount = _bundleView.getUint8(fontBase + 1);
    const lookupTableStart = fontBase + 2;
    const glyphDataTableBase = lookupTableStart + glyphCount * 3; // Glyphs start after GLT.

    return { glyphCount, lookupTableStart, glyphDataTableBase };
  }

  /**
   * Locates the absolute start offset of a glyph's metadata (width, height, stream offset).
   * @param {number} fontPoolBase - Start offset of the font data pool.
   * @param {number} fontDataOffsetInPool - Offset of this font's data in the pool.
   * @param {number} charCode - Character code of the glyph.
   * @returns {number | null} Absolute offset to glyph's width/height/stream, or null if not found.
   */
  function _locateGlyphEntryAbsoluteOffset(fontPoolBase, fontDataOffsetInPool, charCode) {
    const fontHeader = _getFontInternalHeader(fontPoolBase, fontDataOffsetInPool);
    if (!fontHeader) {
      return null;
    }

    const { glyphCount, lookupTableStart, glyphDataTableBase } = fontHeader;
    if (glyphCount === 0) {
      return null; // No glyphs in this font.
    }

    const relativeOffset = _findGlyphOffsetInLookupTable(lookupTableStart, glyphCount, charCode);
    if (relativeOffset === -1) {
      return null; // Glyph not defined.
    }

    const absoluteGlyphDataOffset = glyphDataTableBase + relativeOffset;

    // Ensure at least width and height can be read.
    if (absoluteGlyphDataOffset + 2 > _bundleView.byteLength) {
      return null;
    }

    return absoluteGlyphDataOffset;
  }

  /**
   * Gets a glyph's precalculated width and height for layout purposes (no stream parsing).
   * Assumes _bundleView is initialized and relevant offsets are valid.
   * @param {number} fontPoolBase - Start offset of the font data pool.
   * @param {number} fontDataOffsetInPool - Offset of this font's data in the pool.
   * @param {number} charCode - Character code of the glyph.
   * @returns {{width: number, height: number} | null} Width (char cells) & height (lines), or null.
   */
  function _getGlyphLayoutMetricsOnly(fontPoolBase, fontDataOffsetInPool, charCode) {
    const glyphDataStart = _locateGlyphEntryAbsoluteOffset(fontPoolBase, fontDataOffsetInPool, charCode);
    if (glyphDataStart === null) {
      return null;
    }

    // Bounds for width & height are implicitly checked by _locateGlyphEntryAbsoluteOffset
    const width = _bundleView.getUint8(glyphDataStart);
    const height = _bundleView.getUint8(glyphDataStart + 1);
    return { width, height };
  }

  /**
   * Parses a TDF glyph's full data (width, height, stream) for rendering.
   * @param {number} fontPoolBase - Start offset of the font data pool.
   * @param {number} fontDataOffsetInPool - Offset of this font's data in the pool.
   * @param {number} charCode - Character code of the glyph.
   * @returns {Array<number> | null} [width, height_lines, ...streamData], or null on error.
   */
  function parseGlyphDataOnDemand(fontPoolBase, fontDataOffsetInPool, charCode) {
    const glyphDataStart = _locateGlyphEntryAbsoluteOffset(fontPoolBase, fontDataOffsetInPool, charCode);
    if (glyphDataStart === null) {
      return null;
    }

    try {
      const width = _bundleView.getUint8(glyphDataStart);
      const height = _bundleView.getUint8(glyphDataStart + 1);
      const streamStart = glyphDataStart + 2; // Stream follows width & height.

      const streamData = _parseGlyphByteStream(streamStart);
      return [width, height, ...streamData];
    } catch (e) {
      // Catch errors during getUint8 or _parseGlyphByteStream if preconditions failed.
      console.error(`tdfRenderer: Error parsing full glyph data for char ${charCode}:`, e);
      return null;
    }
  }

  // --- Utilities: Text Layout Calculation ---

  /**
   * Calculates layout metrics (pixel width, pixel height) for a single character.
   * @param {number} fontDataOffsetInPool - Offset of the font's data.
   * @param {string} char - The character to measure.
   * @param {number} minSpaceWidthChars - Min width for a space (char units).
   * @returns {{widthPx: number, heightPx: number, isDefined: boolean}} Layout metrics.
   */
  function _getCharLayoutMetrics(fontDataOffsetInPool, char, minSpaceWidthChars) {
    const charCode = char.charCodeAt(0);
    let widthPx = 0;
    let heightPx = CharHeight; // Default line height.
    let isDefined = false;

    let glyphMetrics = null; // TDF-defined { width, height }

    if (char === " ") {
      glyphMetrics = _getGlyphLayoutMetricsOnly(_fontDataPoolOffset, fontDataOffsetInPool, 32);
      if (glyphMetrics) {
        widthPx = glyphMetrics.width * CharWidth;
        heightPx = Math.max(1, glyphMetrics.height) * CharHeight; // Min 1 line.
      } else {
        widthPx = minSpaceWidthChars * CharWidth; // Use default for undefined space.
      }
      isDefined = true; // Space is always "defined" for layout.
    } else {
      glyphMetrics = _getGlyphLayoutMetricsOnly(_fontDataPoolOffset, fontDataOffsetInPool, charCode);
      if (glyphMetrics) {
        widthPx = glyphMetrics.width * CharWidth;
        heightPx = Math.max(1, glyphMetrics.height) * CharHeight;
        isDefined = true;
      }
      // Else: Undefined non-space char: widthPx = 0, heightPx = CHAR_HEIGHT, isDefined = false.
    }
    return { widthPx, heightPx, isDefined };
  }

  /**
   * Calculates total pixel width and maximum pixel height for a single line of text.
   * @param {number} fontDataOffsetInPool - Offset of the font's data.
   * @param {number} fontSpacingChars - Inter-character spacing (char units).
   * @param {string} textLine - The line of text to measure.
   * @param {number} minSpaceWidthChars - Min width for space characters.
   * @returns {{width: number, height: number}} Calculated width and height in pixels.
   */
  function _calculateSingleLineLayout(fontDataOffsetInPool, fontSpacingChars, textLine, minSpaceWidthChars) {
    if (!textLine) {
      return { width: 0, height: CharHeight }; // Empty line.
    }

    let lineWidthPx = 0;
    let maxLineHeightPx = 0;
    let glyphsOnLine = 0; // Count of glyphs contributing to width.

    for (let i = 0; i < textLine.length; i++) {
      const metrics = _getCharLayoutMetrics(fontDataOffsetInPool, textLine[i], minSpaceWidthChars);
      lineWidthPx += metrics.widthPx;
      maxLineHeightPx = Math.max(maxLineHeightPx, metrics.heightPx);

      if (metrics.widthPx > 0 || textLine[i] === " ") {
        glyphsOnLine++;
      }
    }

    if (glyphsOnLine > 1) {
      lineWidthPx += (glyphsOnLine - 1) * (fontSpacingChars * CharWidth);
    }

    // Ensure minimum dimensions for the line.
    return {
      width: Math.max(lineWidthPx, textLine.length > 0 ? CharWidth : 0), // Min width of one cell if content.
      height: Math.max(maxLineHeightPx, CharHeight), // Min height of one cell.
    };
  }

  // --- Utilities: Text Rendering on Canvas ---

  /**
   * Renders a single TDF glyph (which can span multiple cells/lines) onto the canvas.
   * @param {CanvasRenderingContext2D} context - The canvas rendering context.
   * @param {Array<number>} glyphCompactData - Parsed glyph: [width, height, ...stream].
   * @param {number} baseX - Starting X on canvas for this TDF glyph.
   * @param {number} baseY - Starting Y on canvas for this TDF glyph.
   */
  function _renderTdfGlyphOnCanvas(context, glyphCompactData, baseX, baseY) {
    // compactData: [glyphWidthChars, glyphHeightLines, char1, attr1, ..., NEWLINE_CODE, ...]
    if (!glyphCompactData || glyphCompactData.length <= 2) {
      return; // No stream data.
    }

    let currentGlyphX = 0; // X offset within TDF glyph (char cells).
    let currentGlyphY = 0; // Y offset within TDF glyph (lines).

    for (let k = 2; k < glyphCompactData.length; k++) {
      // Start after width/height.
      const item = glyphCompactData[k];

      if (item === NewlineCode) {
        currentGlyphY++;
        currentGlyphX = 0;
      } else {
        const cp437CharCode = item;
        k++; // Move to attribute byte.
        if (k >= glyphCompactData.length) {
          break; // Should not happen with valid data.
        }

        const attrByte = glyphCompactData[k];
        const canvasX = baseX + currentGlyphX * CharWidth;
        const canvasY = baseY + currentGlyphY * CharHeight;

        const bgIndex = (attrByte >> 4) & 0x07; // TDF: 3 bits for BG (0-7).
        const fgIndex = attrByte & 0x0f; // TDF: 4 bits for FG (0-15).

        const bgColor = TdfColors[bgIndex] || TdfColors[0]; // Default: black.
        const fgColor = TdfColors[fgIndex] || TdfColors[7]; // Default: light grey.

        drawCp437Char(context, cp437CharCode, canvasX, canvasY, fgColor, bgColor);
        currentGlyphX++;
      }
    }
  }

  /**
   * Renders a single line of text onto the canvas at a specified X, Y.
   * @param {CanvasRenderingContext2D} context - The canvas rendering context.
   * @param {string} lineText - The text for the current line.
   * @param {number} lineBaseY - Y coordinate on canvas for the top of this line.
   * @param {number} lineStartX - X coordinate on canvas where this line begins.
   * @param {number} fontDataOffsetInPool - Offset of the font's data.
   * @param {number} fontSpacingChars - Inter-character spacing (char units).
   * @param {number} minSpaceWidthChars - Min width for space characters.
   */
  function _renderLine(
    context,
    lineText,
    lineBaseY,
    lineStartX,
    fontDataOffsetInPool,
    fontSpacingChars,
    minSpaceWidthChars,
  ) {
    let currentX = lineStartX;

    for (let i = 0; i < lineText.length; i++) {
      const char = lineText[i];
      const charCode = char.charCodeAt(0);
      let glyphRenderWidthPx = 0;

      // Fetch glyph data for rendering (if not space) or metrics (for space).
      const glyphCompactData =
        char === " " ? null : parseGlyphDataOnDemand(_fontDataPoolOffset, fontDataOffsetInPool, charCode);

      if (char === " ") {
        const spaceMetrics = _getGlyphLayoutMetricsOnly(_fontDataPoolOffset, fontDataOffsetInPool, 32);
        glyphRenderWidthPx = spaceMetrics ? spaceMetrics.width * CharWidth : minSpaceWidthChars * CharWidth;
      } else if (glyphCompactData) {
        glyphRenderWidthPx = glyphCompactData[0] * CharWidth; // compactData[0] is width.
      }
      // If glyphCompactData is null for non-space, width remains 0 (undefined char).

      if (glyphCompactData && glyphCompactData.length > 2) {
        // Has renderable stream.
        _renderTdfGlyphOnCanvas(context, glyphCompactData, currentX, lineBaseY);
      }

      currentX += glyphRenderWidthPx;
      if (i < lineText.length - 1 && glyphRenderWidthPx > 0) {
        currentX += fontSpacingChars * CharWidth; // Add inter-char spacing.
      }
    }
  }

  /**
   * Renders a line of text with specified alignment within a text block.
   * @returns {number} The pixel height of the rendered line.
   */
  function _renderLineWithAlignment(
    context,
    lineText,
    lineBaseY,
    textBlockStartX,
    textBlockWidthPx,
    textAlign,
    fontDataOffsetInPool,
    fontSpacingChars,
    minSpaceWidthChars,
  ) {
    const lineLayout = _calculateSingleLineLayout(fontDataOffsetInPool, fontSpacingChars, lineText, minSpaceWidthChars);
    const currentLineWidthPx = lineLayout.width;
    const currentLineHeightPx = lineLayout.height;

    let lineIndentPx = 0; // Indentation of this line within the text block.
    if (textAlign === "center") {
      lineIndentPx = Math.floor((textBlockWidthPx - currentLineWidthPx) / 2);
    } else if (textAlign === "right") {
      lineIndentPx = textBlockWidthPx - currentLineWidthPx;
    }

    const lineRenderStartXOnCanvas = textBlockStartX + lineIndentPx;

    _renderLine(
      context,
      lineText,
      lineBaseY,
      lineRenderStartXOnCanvas,
      fontDataOffsetInPool,
      fontSpacingChars,
      minSpaceWidthChars,
    );
    return currentLineHeightPx;
  }

  // --- Utilities: Bundle Parsing ---

  const BundleHeaderSize = 21; // Magic(4) + Ver(1) + Counts/Offsets(4*4)
  const FontIndexEntrySize = 8; // KeyOffset(4) + DataOffset(4)

  /**
   * Parses and validates the TDF Bundle header.
   * @param {DataView} bundleView - DataView of the bundle.
   * @returns {object} Header information or throws error.
   */
  function _parseBundleHeader(bundleView) {
    if (bundleView.byteLength < BundleHeaderSize) {
      throw new Error("tdfRenderer: Bundle too small for header.");
    }

    const magicBytes = new Uint8Array(bundleView.buffer, bundleView.byteOffset, 4);
    const magic = new TextDecoder().decode(magicBytes);
    if (magic !== "TDFB") {
      throw new Error(`tdfRenderer: Invalid magic string. Expected "TDFB", got "${magic}".`);
    }

    const version = bundleView.getUint8(4);
    if (version !== 1) {
      throw new Error(`tdfRenderer: Unsupported bundle version: ${version}. Expected 1.`);
    }

    const fontCount = bundleView.getUint32(5, true);
    const indexTableOffset = bundleView.getUint32(9, true);
    const stringPoolOffset = bundleView.getUint32(13, true);
    const fontDataPoolOffset = bundleView.getUint32(17, true);

    // Validate offsets
    const maxIndexTableEnd = indexTableOffset + fontCount * FontIndexEntrySize;
    if (
      indexTableOffset >= bundleView.byteLength ||
      stringPoolOffset >= bundleView.byteLength ||
      fontDataPoolOffset >= bundleView.byteLength ||
      maxIndexTableEnd > bundleView.byteLength
    ) {
      throw new Error("tdfRenderer: Invalid offsets in bundle header (out of bounds).");
    }

    return { fontCount, indexTableOffset, stringPoolOffset, fontDataPoolOffset };
  }

  /**
   * Parses the Font Index Table from the bundle.
   * @param {DataView} bundleView - DataView of the bundle.
   * @param {object} headerInfo - Parsed header information.
   * @returns {Map<string, number>} Map of font keys to their data offsets.
   */
  function _parseFontIndex(bundleView, headerInfo) {
    const { fontCount, indexTableOffset, stringPoolOffset } = headerInfo;
    const newFontIndex = new Map();

    for (let i = 0; i < fontCount; i++) {
      const entryAbsOffset = indexTableOffset + i * FontIndexEntrySize;

      const keyStrRelOffset = bundleView.getUint32(entryAbsOffset, true);
      const fontDataRelOffset = bundleView.getUint32(entryAbsOffset + 4, true);

      const key = readNullTerminatedString(bundleView, stringPoolOffset + keyStrRelOffset);
      if (key) {
        newFontIndex.set(key, fontDataRelOffset); // Store offset relative to font data pool start.
      } else {
        console.warn(`tdfRenderer: Empty font key at index ${i} in bundle.`);
      }
    }
    return newFontIndex;
  }

  // --- Public API Object ---

  const tdfRenderer = {};

  /**
   * Initializes the renderer by fetching and parsing the TDF binary font bundle.
   * Must be called before rendering or layout calculations.
   * @param {string} bundleUrl - URL of the `tdf-fonts.bin` file.
   * @returns {Promise<string[]>} Promise resolving with sorted available font keys.
   * @throws {Error} If initialization fails.
   */
  tdfRenderer.init = async (bundleUrl) => {
    if (_isInitialized) {
      return tdfRenderer.getAvailableFonts();
    }

    _bundleBuffer = await fetchBinary(bundleUrl); // Throws on fetch error
    _bundleView = new DataView(_bundleBuffer);

    const headerInfo = _parseBundleHeader(_bundleView); // Throws on header error
    _stringPoolOffset = headerInfo.stringPoolOffset;
    _fontDataPoolOffset = headerInfo.fontDataPoolOffset;

    _fontIndex = _parseFontIndex(_bundleView, headerInfo);

    _isInitialized = true;
    return tdfRenderer.getAvailableFonts();
  };

  /**
   * Checks if the renderer has been successfully initialized.
   * @returns {boolean} True if initialized, false otherwise.
   */
  tdfRenderer.isInitialized = () => _isInitialized;

  /**
   * Returns a sorted array of unique font keys available in the loaded bundle.
   * @returns {string[]} Sorted array of font keys, or empty if not initialized.
   */
  tdfRenderer.getAvailableFonts = () => {
    if (!_isInitialized) {
      return [];
    }

    return Array.from(_fontIndex.keys()).sort();
  };

  /**
   * Calculates overall layout dimensions (width, height in pixels) for text.
   * Handles multiline text ('\n').
   * @param {string} uniqueFontKey - The font key.
   * @param {string} text - Text string (can include '\n').
   * @param {number} [minSpaceWidthChars=DEFAULT_MIN_SPACE_WIDTH] - Min width for space char.
   * @returns {{width: number, height: number} | null} Dimensions or null on error.
   */
  tdfRenderer.calculateLayout = (uniqueFontKey, text, minSpaceWidthChars = DefaultMinSpaceWidth) => {
    if (!_isInitialized) {
      // No _bundleView check needed here, _isInitialized covers it.
      console.error("tdfRenderer.calculateLayout: Not initialized.");
      return null;
    }
    if (!text) {
      return { width: CharWidth, height: CharHeight }; // Minimal layout for empty text.
    }

    const fontDataOffsetInPool = _fontIndex.get(uniqueFontKey);
    if (typeof fontDataOffsetInPool === "undefined") {
      console.error(`tdfRenderer.calculateLayout: Font key "${uniqueFontKey}" not found.`);
      return null;
    }

    // Font Spacing is the first byte of the font-specific data.
    const fontBase = _fontDataPoolOffset + fontDataOffsetInPool;
    const fontSpacingChars = _bundleView.getUint8(fontBase);

    const lines = text.split("\n");
    let overallMaxWidthPx = 0;
    let totalHeightPx = 0;

    for (const line of lines) {
      const lineLayout = _calculateSingleLineLayout(fontDataOffsetInPool, fontSpacingChars, line, minSpaceWidthChars);
      overallMaxWidthPx = Math.max(overallMaxWidthPx, lineLayout.width);
      totalHeightPx += lineLayout.height;
    }

    return {
      width: Math.max(overallMaxWidthPx, CharWidth), // Ensure min 1 char width if content.
      height: Math.max(totalHeightPx, CharHeight), // Ensure min 1 char height.
    };
  };

  /**
   * Filters available TDF fonts to those supporting all TDF-renderable characters in the text.
   * @param {string} text - Text to check character support against.
   * @returns {string[]} Sorted array of compatible font keys.
   */
  tdfRenderer.filterFontsByText = (text) => {
    if (!_isInitialized) {
      console.warn("tdfRenderer.filterFontsByText: Not initialized.");
      return [];
    }
    if (!text) {
      return tdfRenderer.getAvailableFonts(); // All fonts compatible with empty text.
    }

    const requiredChars = [...new Set(text.split(""))].filter((char) => {
      if (char === " " || char === "\n") {
        return false;
      }
      const charCode = char.charCodeAt(0);
      // ASCII 33 ('!') to 126 ('~') are generally the TDF-renderable characters.
      return charCode >= 33 && charCode <= 126;
    });

    if (requiredChars.length === 0) {
      // Text has only spaces, newlines, or unsupported chars (outside 33-126).
      return tdfRenderer.getAvailableFonts();
    }

    return Array.from(_fontIndex.entries())
      .filter(([/*key*/ , fontDataOffsetInPool]) =>
        requiredChars.every(
          (char) => _getGlyphLayoutMetricsOnly(_fontDataPoolOffset, fontDataOffsetInPool, char.charCodeAt(0)) !== null,
        ),
      )
      .map(([key]) => key)
      .sort();
  };

  /**
   * Prepares canvas: creates/resizes, gets context, clears with background.
   * @private
   */
  function _prepareCanvasAndContext(options, layout, bgColorRgba) {
    let targetCanvas = options.canvas;
    const canCreate = typeof document !== "undefined" && typeof document.createElement === "function";

    if (!targetCanvas) {
      if (!canCreate) {
        throw new Error("tdfRenderer: options.canvas required in non-browser env.");
      }
      targetCanvas = document.createElement("canvas");
    }

    targetCanvas.width = Math.max(options.targetWidth || 0, layout.width, CharWidth);
    targetCanvas.height = Math.max(layout.height, CharHeight);

    const context = targetCanvas.getContext("2d");
    if (!context) {
      throw new Error("tdfRenderer: Failed to get 2D context from canvas.");
    }

    context.fillStyle = `rgba(${bgColorRgba.join(",")})`;
    context.fillRect(0, 0, targetCanvas.width, targetCanvas.height);

    return { canvas: targetCanvas, context: context };
  }

  /**
   * Renders text using a TDF font onto a canvas.
   * Auto-creates canvas in browser if not provided.
   *
   * @param {object} options - Rendering configuration.
   * @param {string} options.uniqueFontKey - Font key.
   * @param {string} options.text - Text to render (can include '\n').
   * @param {HTMLCanvasElement} [options.canvas] - Optional target canvas.
   * @param {number} [options.targetWidth] - Optional minimum canvas width.
   * @param {string} [options.textAlign='left'] - Alignment ('left', 'center', 'right').
   * @param {Array<number>} [options.bgColor] - BG RGBA color [r,g,b,a]; default: opaque black.
   * @param {number} [options.minSpaceWidth] - Min width for space char (char units).
   * @returns {Promise<{canvas: HTMLCanvasElement}>} Promise with the canvas.
   * @throws {Error} If rendering fails.
   */
  tdfRenderer.render = async (options) => {
    if (!_isInitialized) {
      throw new Error("tdfRenderer.render: Not initialized. Call init() first.");
    }
    if (!options || !options.uniqueFontKey || typeof options.text === "undefined") {
      throw new Error("tdfRenderer.render: Missing 'uniqueFontKey' or 'text' in options.");
    }

    const { uniqueFontKey, text } = options;
    const fontDataOffsetInPool = _fontIndex.get(uniqueFontKey);
    if (typeof fontDataOffsetInPool === "undefined") {
      throw new Error(`tdfRenderer.render: Font key "${uniqueFontKey}" not found.`);
    }

    const fontBase = _fontDataPoolOffset + fontDataOffsetInPool;
    const fontSpacingChars = _bundleView.getUint8(fontBase);

    const minSpaceWidthChars =
      typeof options.minSpaceWidth === "number" && options.minSpaceWidth >= 0
        ? options.minSpaceWidth
        : DefaultMinSpaceWidth;
    const textAlign = ["left", "center", "right"].includes(options.textAlign) ? options.textAlign : "left";
    const bgColorRgba =
      Array.isArray(options.bgColor) && options.bgColor.length === 4 ? options.bgColor : [0, 0, 0, 255]; // Default: opaque black.

    try {
      const layout = tdfRenderer.calculateLayout(uniqueFontKey, text, minSpaceWidthChars);
      if (!layout) {
        throw new Error("tdfRenderer.render: Failed to calculate text layout."); // Should be caught by calculateLayout returning null
      }

      const overallTextMaxWidthPx = layout.width;
      const { canvas: targetCanvas, context } = _prepareCanvasAndContext(options, layout, bgColorRgba);

      // Center the entire text block on the canvas if canvas is wider.
      const blockStartX = Math.floor((targetCanvas.width - overallTextMaxWidthPx) / 2);

      const lines = text.split("\n");
      let currentY = 0;

      for (const line of lines) {
        const lineHeightPx = _renderLineWithAlignment(
          context,
          line,
          currentY,
          blockStartX,
          overallTextMaxWidthPx,
          textAlign,
          fontDataOffsetInPool,
          fontSpacingChars,
          minSpaceWidthChars,
        );
        currentY += lineHeightPx;
      }

      return { canvas: targetCanvas };
    } catch (error) {
      console.error(`tdfRenderer: Error during rendering for font "${uniqueFontKey}":`, error);
      throw error; // Re-throw for caller handling.
    }
  };

  // --- Expose Public API ---
  global.tdfRenderer = tdfRenderer;
})(typeof globalThis !== "undefined" ? globalThis : this);
