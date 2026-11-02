// tdfRenderer.js (Supports TDF Bundle Format v6)
// TheDraw Font (.TDF) text rendering library for HTML Canvas.
// Uses a preprocessed binary font bundle with local pair palettes.
// Copyright (C) 2012-2025 Ori Livneh & Contributors
// Licensed under the MIT and GPL licenses

((global) => {
  // --- Constants ---

  // Standard dimensions for rendering CP437 characters.
  const CharWidth = 8; // Pixels
  const CharHeight = 16; // Pixels

  // Default layout parameters.
  const DefaultMinSpaceWidth = 3; // In character cell units.
  const DefaultAdditionalLineSpacingPx = 0; // Extra pixels between text lines.

  // Standard CGA/EGA/VGA 16-color palette in RGBA format.
  const TdfColors = [
    [0, 0, 0, 255], // 0 Black
    [0, 0, 170, 255], // 1 Blue
    [0, 170, 0, 255], // 2 Green
    [0, 170, 170, 255], // 3 Cyan
    [170, 0, 0, 255], // 4 Red
    [170, 0, 170, 255], // 5 Magenta
    [170, 85, 0, 255], // 6 Brown
    [170, 170, 170, 255], // 7 Light Gray
    [85, 85, 85, 255], // 8 Dark Gray
    [85, 85, 255, 255], // 9 Light Blue
    [85, 255, 85, 255], // 10 Light Green
    [85, 255, 255, 255], // 11 Light Cyan
    [255, 85, 85, 255], // 12 Light Red
    [255, 85, 255, 255], // 13 Light Magenta
    [255, 255, 85, 255], // 14 Yellow
    [255, 255, 255, 255], // 15 White
  ];
  // TdfColors as pixels for a Uint32Array view of ImageData, which assumes a little-endian
  // platform: byte order R, G, B, A.
  const TdfPixels = TdfColors.map(([r, g, b, a]) => ((a << 24) | (b << 16) | (g << 8) | r) >>> 0);

  // --- CP437 Font Data ---

  /**
   * Retrieves pre-loaded CP437 font data, expected to be on the global object.
   * This data provides the pixel patterns for rendering CP437 characters.
   * @returns {Array<Array<number>>} The CP437 font data (array of 256 bitmaps) or a dummy array if not found.
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
    // Provide a dummy structure to prevent immediate crashes if cp437font is missing.
    return new Array(256).fill([]);
  }
  const cp437FontData = getCp437FontData();

  // --- Internal State ---

  let _fontIndex = new Map(); // Maps uniqueFontKey (string) to fontRecordIndex (number).
  let _fontRecords = []; // Parsed records: { spacing, pairPalette, glyphs }.
  let _cellPool = null; // Uint8Array of pair palette indices for all glyphs.
  let _isInitialized = false; // Flag indicating if init() has successfully completed.
  const EXPECTED_BUNDLE_FORMAT_VERSION = 6; // This renderer is built for Bundle Format v6.
  let _actualBundleFormatVersion = 0; // Stores the version read from the loaded bundle.

  // --- Utilities: File I/O ---

  /**
   * Asynchronously fetches binary data (ArrayBuffer) from a given URL.
   * @param {string} url - The URL from which to fetch the binary data.
   * @returns {Promise<ArrayBuffer>} A promise that resolves with the ArrayBuffer.
   * @throws {Error} If the network request fails or the response is not OK.
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
      throw error; // Re-throw to allow the caller to handle it.
    }
  }

  // --- Utilities: CP437 Character Rendering ---

  /**
   * Draws a single CP437 character into a pixel buffer using preloaded bitmap data.
   * @param {Uint32Array} pixels - The pixel buffer, one RGBA pixel per element (see TdfPixels).
   * @param {number} width - Width of the pixel buffer in pixels.
   * @param {number} charCode - The CP437 character code (0-255).
   * @param {number} pixelX - X-coordinate of the character's top-left pixel within the buffer.
   * @param {number} pixelY - Y-coordinate of the character's top-left pixel within the buffer.
   * @param {number} fgPixel - Foreground color, an element of TdfPixels.
   * @param {number} bgPixel - Background color, an element of TdfPixels.
   */
  function drawCp437Char(pixels, width, charCode, pixelX, pixelY, fgPixel, bgPixel) {
    const bitmap = cp437FontData[charCode & 0xff];
    // A missing or incomplete bitmap fills the cell with the background color.
    const isBlank = !bitmap || bitmap.length < CharHeight;
    for (let row = 0; row < CharHeight; row++) {
      const rowBits = isBlank ? 0 : bitmap[row] || 0;
      let offset = (pixelY + row) * width + pixelX;
      for (let col = 0; col < CharWidth; col++, offset++) {
        pixels[offset] = (rowBits >> (7 - col)) & 1 ? fgPixel : bgPixel;
      }
    }
  }

  // --- Utilities: TDF Glyph Lookup (for Bundle v6) ---

  /**
   * Returns the parsed record for a font.
   * @param {number} fontRecordIndex - Index of the font's record in the bundle.
   * @returns {{spacing: number, pairPalette: Uint8Array, glyphs: Map<number, {width: number, height: number, cellOffset: number}>} | null}
   */
  function _getFontRecord(fontRecordIndex) {
    return _fontRecords[fontRecordIndex] ?? null;
  }

  /**
   * Retrieves a glyph's declared width and actual height for layout calculations.
   * @param {number} fontRecordIndex - Index of the font's record in the bundle.
   * @param {number} charCode - The ASCII character code of the glyph.
   * @returns {{width: number, height: number} | null} Object with `width` (in cells) and `height` (in lines), or null if not found.
   */
  function _getGlyphLayoutMetricsOnly(fontRecordIndex, charCode) {
    return _getFontRecord(fontRecordIndex)?.glyphs.get(charCode) ?? null;
  }

  /**
   * Builds a glyph's cell data by mapping its palette indices to (char, attr) pairs.
   * The returned array is flat: [width, height, char1, attr1, char2, attr2, ...].
   * @param {number} fontRecordIndex - Index of the font's record in the bundle.
   * @param {number} charCode - The ASCII character code of the glyph.
   * @returns {Array<number> | null} Glyph data, or null if the glyph is not defined.
   */
  function parseGlyphDataOnDemand(fontRecordIndex, charCode) {
    const record = _getFontRecord(fontRecordIndex);
    const glyph = record?.glyphs.get(charCode);
    if (!glyph) return null;

    const { width, height, cellOffset } = glyph;
    const { pairPalette } = record;
    const glyphData = [width, height];
    for (let i = 0; i < width * height; i++) {
      const pairIndex = _cellPool[cellOffset + i];
      glyphData.push(pairPalette[pairIndex * 2], pairPalette[pairIndex * 2 + 1]);
    }
    return glyphData;
  }

  // --- Utilities: Text Layout Calculation ---

  /**
   * Calculates layout metrics (pixel width, pixel height) for a single character.
   * @param {number} fontRecordIndex - Index of the font's record in the bundle.
   * @param {string} char - The character to measure.
   * @param {number} minSpaceWidthChars - Minimum width for a space character, in character cell units.
   * @returns {{widthPx: number, heightPx: number, isDefined: boolean}} Layout metrics.
   */
  function _getCharLayoutMetrics(fontRecordIndex, char, minSpaceWidthChars) {
    const charCode = char.charCodeAt(0);
    let widthPx = 0;
    let heightPx = CharHeight; // Default line height.
    let isDefined = false;
    const glyphMetrics = _getGlyphLayoutMetricsOnly(fontRecordIndex, charCode);

    if (char === " ") {
      // For space, attempt to use its defined metrics if available and it has positive width.
      // Otherwise, fall back to the configurable minimum space width.
      const spaceMetrics = _getGlyphLayoutMetricsOnly(fontRecordIndex, 32); // ASCII 32 for space.
      if (spaceMetrics && spaceMetrics.width > 0) {
        widthPx = spaceMetrics.width * CharWidth;
        heightPx = Math.max(1, spaceMetrics.height) * CharHeight; // Ensure height is at least 1 line.
      } else {
        widthPx = minSpaceWidthChars * CharWidth;
        // heightPx remains CharHeight for default spaces.
      }
      isDefined = true; // Space is always considered "defined" for layout purposes.
    } else if (glyphMetrics) {
      // For non-space characters with defined metrics.
      widthPx = glyphMetrics.width * CharWidth;
      heightPx = Math.max(1, glyphMetrics.height) * CharHeight; // Ensure height is at least 1 line.
      isDefined = true;
    }
    // If a non-space character is undefined (glyphMetrics is null),
    // widthPx remains 0, heightPx is CharHeight, and isDefined is false.
    // Such characters will not contribute to layout width.
    return { widthPx, heightPx, isDefined };
  }

  /**
   * Calculates total pixel width and maximum pixel height for a single line of text.
   * @param {number} fontRecordIndex - Index of the font's record in the bundle.
   * @param {number} fontSpacingChars - Inter-character spacing (in character cell units), obtained from font details.
   * @param {string} textLine - The line of text to measure.
   * @param {number} minSpaceWidthChars - Minimum width for space characters (in character cell units).
   * @returns {{width: number, height: number}} Calculated width and height of the line in pixels.
   */
  function _calculateSingleLineLayout(fontRecordIndex, fontSpacingChars, textLine, minSpaceWidthChars) {
    if (!textLine) {
      return { width: 0, height: CharHeight }; // An empty line still occupies default character height.
    }

    let lineWidthPx = 0;
    let maxLineHeightPx = 0;
    let glyphsContributingToSpacing = 0; // Count of glyphs that affect inter-character spacing.

    for (let i = 0; i < textLine.length; i++) {
      const metrics = _getCharLayoutMetrics(fontRecordIndex, textLine[i], minSpaceWidthChars);
      lineWidthPx += metrics.widthPx;
      maxLineHeightPx = Math.max(maxLineHeightPx, metrics.heightPx);

      // A glyph contributes to inter-glyph spacing if it has positive width or is a space
      // (even if the space's defined width is 0, it still acts as a separator).
      if (metrics.widthPx > 0 || textLine[i] === " ") {
        glyphsContributingToSpacing++;
      }
    }

    // Add inter-character spacing if more than one such glyph exists on the line.
    if (glyphsContributingToSpacing > 1) {
      lineWidthPx += (glyphsContributingToSpacing - 1) * (fontSpacingChars * CharWidth);
    }

    // Ensure the line has at least a minimal width/height if it contained any characters.
    return {
      width: Math.max(lineWidthPx, textLine.length > 0 ? CharWidth : 0), // Min width of one cell if content.
      height: Math.max(maxLineHeightPx, CharHeight), // Min height of one cell.
    };
  }

  // --- Utilities: Text Rendering on Canvas ---

  /**
   * Renders a single TDF glyph (represented as a dense grid of cells) onto the canvas.
   * The input `glyphCompactData` is a flat array: [width, height, char1, attr1, char2, attr2, ...].
   * The cells tile the glyph's rectangle, so the glyph is drawn into one ImageData and placed
   * with one putImageData call.
   * @param {CanvasRenderingContext2D} context - The canvas rendering context.
   * @param {Array<number>} glyphCompactData - Parsed glyph data.
   * @param {number} baseX - Starting X coordinate on canvas for the top-left of this TDF glyph.
   * @param {number} baseY - Starting Y coordinate on canvas for the top-left of this TDF glyph.
   */
  function _renderTdfGlyphOnCanvas(context, glyphCompactData, baseX, baseY) {
    const glyphWidthChars = glyphCompactData[0];
    const glyphHeightLines = glyphCompactData[1];
    const cellCount = glyphWidthChars * glyphHeightLines;
    if (cellCount === 0) return;

    const imageData = context.createImageData(glyphWidthChars * CharWidth, glyphHeightLines * CharHeight);
    const { data, width } = imageData;
    const pixels = new Uint32Array(data.buffer, data.byteOffset, data.length / 4);
    for (let i = 0; i < cellCount; i++) {
      const charByte = glyphCompactData[2 + i * 2];
      const attrByte = glyphCompactData[3 + i * 2];
      const bgPixel = TdfPixels[(attrByte >> 4) & 0x07]; // 3 bits of background.
      const fgPixel = TdfPixels[attrByte & 0x0f]; // 4 bits of foreground.
      const pixelX = (i % glyphWidthChars) * CharWidth;
      const pixelY = Math.floor(i / glyphWidthChars) * CharHeight;
      drawCp437Char(pixels, width, charByte, pixelX, pixelY, fgPixel, bgPixel);
    }
    context.putImageData(imageData, Math.floor(baseX), Math.floor(baseY));
  }

  /**
   * Renders a single line of text onto the canvas at a specified X, Y.
   */
  function _renderLine(
    context,
    lineText,
    lineBaseY,
    lineStartX,
    fontRecordIndex,
    fontSpacingChars,
    minSpaceWidthChars,
  ) {
    let currentX = lineStartX; // Current X position on the canvas for drawing.

    for (let i = 0; i < lineText.length; i++) {
      const char = lineText[i];
      const charCode = char.charCodeAt(0);
      let glyphRenderWidthPx = 0; // Pixel width of the current character's glyph.
      let glyphCompactData = null;

      // Fetch glyph data unless it's a space (which might be handled differently).
      glyphCompactData = char === " " ? null : parseGlyphDataOnDemand(fontRecordIndex, charCode);

      if (char === " ") {
        const spaceMetrics = _getGlyphLayoutMetricsOnly(fontRecordIndex, 32); // ASCII 32 for space.
        glyphRenderWidthPx =
          spaceMetrics && spaceMetrics.width > 0
            ? spaceMetrics.width * CharWidth // Use defined width if space has one.
            : minSpaceWidthChars * CharWidth; // Otherwise, use default minimum.

        // If the space character has a specific glyph defined (rare, but possible), render it.
        // Also ensure it has a positive width to be rendered.
        if (glyphCompactData && glyphCompactData.length > 2 && spaceMetrics && spaceMetrics.width > 0) {
          _renderTdfGlyphOnCanvas(context, glyphCompactData, currentX, lineBaseY);
        } else if (glyphRenderWidthPx > 0) {
          // For default spaces or spaces without complex glyphs, just fill the background.
          const fontRecord = _getFontRecord(fontRecordIndex);
          const defaultBgColor = fontRecord
            ? TdfColors[(_spaceFillAttr(fontRecord.pairPalette) >> 4) & 0x07]
            : TdfColors[0];
          context.fillStyle = `rgba(${defaultBgColor.join(",")})`;
          context.fillRect(Math.floor(currentX), Math.floor(lineBaseY), Math.ceil(glyphRenderWidthPx), CharHeight);
        }
      } else if (glyphCompactData) {
        // For non-space characters with successfully parsed glyph data.
        glyphRenderWidthPx = glyphCompactData[0] * CharWidth; // First element is width.
        if (glyphCompactData.length > 2) {
          // Check if there's actual cell data beyond width/height.
          _renderTdfGlyphOnCanvas(context, glyphCompactData, currentX, lineBaseY);
        }
      }
      // If glyphCompactData is null for a non-space char, it means the character is not defined
      // in the font. glyphRenderWidthPx remains 0, and it contributes nothing to the line's width.

      currentX += glyphRenderWidthPx; // Advance X position.

      // Add inter-character spacing if not the last character on the line
      // and the current character contributed some width.
      if (i < lineText.length - 1 && glyphRenderWidthPx > 0) {
        currentX += fontSpacingChars * CharWidth;
      }
    }
  }

  /**
   * Renders a line of text with specified alignment within a text block of a given width.
   * @returns {number} The pixel height of the rendered line (max height of glyphs in it).
   */
  function _renderLineWithAlignment(
    context,
    lineText,
    lineBaseY, // Y-coordinate for the top of this line.
    textBlockStartX, // X-coordinate for the start of the overall text block (for alignment).
    textBlockWidthPx, // Total width available for this line's alignment.
    textAlign,
    fontRecordIndex,
    fontSpacingChars,
    minSpaceWidthChars,
  ) {
    // Calculate the natural layout of this specific line.
    const lineLayout = _calculateSingleLineLayout(fontRecordIndex, fontSpacingChars, lineText, minSpaceWidthChars);
    const currentLineWidthPx = lineLayout.width;
    const currentLineHeightPx = lineLayout.height; // This is the max height of glyphs in this line.

    let lineIndentPx = 0; // Horizontal indentation of this line within the text block.
    if (textAlign === "center") {
      lineIndentPx = Math.max(0, Math.floor((textBlockWidthPx - currentLineWidthPx) / 2));
    } else if (textAlign === "right") {
      lineIndentPx = Math.max(0, textBlockWidthPx - currentLineWidthPx);
    }
    // For 'left' alignment, lineIndentPx remains 0.

    const lineRenderStartXOnCanvas = textBlockStartX + lineIndentPx;

    _renderLine(
      context,
      lineText,
      lineBaseY,
      lineRenderStartXOnCanvas,
      fontRecordIndex,
      fontSpacingChars,
      minSpaceWidthChars,
    );
    // Return the calculated height of this line, used by the caller to advance the Y position.
    return currentLineHeightPx;
  }

  // --- Utilities: Bundle Parsing ---

  const BundleHeaderSize = 17; // Magic(4) + Version(1) + FontCount(4) + BaseCount(4) + DerivedCount(4)

  /**
   * Returns the attribute used to fill a space for which a font defines no glyph: that of
   * the lowest (char, attr) pair, which was the first palette entry in v4 bundles.
   * @param {Uint8Array} pairPalette - Interleaved (char, attr) bytes.
   * @returns {number}
   */
  function _spaceFillAttr(pairPalette) {
    let lowestPairKey = 0xffff;
    for (let i = 0; i < pairPalette.length; i += 2) {
      lowestPairKey = Math.min(lowestPairKey, (pairPalette[i] << 8) | pairPalette[i + 1]);
    }
    return pairPalette.length > 0 ? lowestPairKey & 0xff : 0;
  }

  /**
   * Parses a v6 bundle: the header, the font index, the base and derived record tables, and
   * the cell pool.
   *
   * Every record is parsed up front, because a base record's glyphs may refer to the cells of
   * the preceding base record's glyphs, and each glyph's position in the cell pool is known
   * only after the sizes of all earlier glyphs have been summed.
   *
   * @param {ArrayBuffer} bundleBuffer - The bundle.
   * @returns {{version: number, fontIndex: Map<string, number>, fontRecords: Array<object>, cellPool: Uint8Array}}
   * @throws {Error} If the bundle is malformed or of an unsupported version.
   */
  function _parseBundle(bundleBuffer) {
    const bytes = new Uint8Array(bundleBuffer);
    const view = new DataView(bundleBuffer);
    let offset = 0;
    const require = (length, what) => {
      if (offset + length > bytes.length) {
        throw new Error(`tdfRenderer: Bundle ended while reading ${what} at offset ${offset}.`);
      }
    };

    require(BundleHeaderSize, "the header");
    const magic = String.fromCharCode(...bytes.subarray(0, 4));
    if (magic !== "TDFB") {
      throw new Error(`tdfRenderer: Invalid magic string. Expected "TDFB", got "${magic}".`);
    }
    const version = bytes[4];
    if (version !== EXPECTED_BUNDLE_FORMAT_VERSION) {
      throw new Error(
        `tdfRenderer: Unsupported bundle version: ${version}. This renderer expects version ${EXPECTED_BUNDLE_FORMAT_VERSION}.`,
      );
    }
    const fontCount = view.getUint32(5, true);
    const baseCount = view.getUint32(9, true);
    const derivedCount = view.getUint32(13, true);
    const recordCount = baseCount + derivedCount;
    offset = BundleHeaderSize;

    const fontIndex = new Map();
    const textDecoder = new TextDecoder();
    for (let i = 0; i < fontCount; i++) {
      const keyEnd = bytes.indexOf(0, offset);
      if (keyEnd === -1) throw new Error(`tdfRenderer: Font key ${i} is not terminated.`);
      const key = textDecoder.decode(bytes.subarray(offset, keyEnd));
      offset = keyEnd + 1;
      require(2, `the record index of font "${key}"`);
      const recordIndex = view.getUint16(offset, true);
      offset += 2;
      if (recordIndex >= recordCount) {
        throw new Error(`tdfRenderer: Font "${key}" refers to record ${recordIndex} of ${recordCount}.`);
      }
      fontIndex.set(key, recordIndex);
    }

    const fontRecords = [];
    let previousGlyphs = new Map();
    let cellPoolSize = 0; // Running total; cell offsets are relative to the start of the cell pool.
    for (let r = 0; r < baseCount; r++) {
      require(2, `record ${r}`);
      const spacing = bytes[offset++];
      const nPairs = bytes[offset++];
      require(nPairs * 2 + 1, `the palette of record ${r}`);
      const pairPalette = bytes.slice(offset, offset + nPairs * 2);
      offset += nPairs * 2;
      const glyphCount = bytes[offset++];
      require(glyphCount * 4, `the glyph table of record ${r}`);

      const glyphs = new Map();
      for (let g = 0; g < glyphCount; g++) {
        const charCode = bytes[offset];
        const width = bytes[offset + 1];
        const height = bytes[offset + 2];
        const isShared = bytes[offset + 3] !== 0;
        offset += 4;

        let cellOffset;
        if (isShared) {
          const previous = previousGlyphs.get(charCode);
          if (!previous || previous.width !== width || previous.height !== height) {
            throw new Error(`tdfRenderer: Record ${r} shares glyph ${charCode}, which record ${r - 1} lacks.`);
          }
          cellOffset = previous.cellOffset;
        } else {
          cellOffset = cellPoolSize;
          cellPoolSize += width * height;
        }
        glyphs.set(charCode, { width, height, cellOffset });
      }
      fontRecords.push({ spacing, pairPalette, glyphs });
      previousGlyphs = glyphs;
    }

    // A derived record reuses its base record's glyphs and reads them through its own palette:
    // the base palette with attributes substituted, and then individual entries replaced.
    const attrMap = new Uint8Array(256);
    for (let r = baseCount; r < recordCount; r++) {
      require(4, `record ${r}`);
      const baseIndex = view.getUint16(offset, true);
      if (baseIndex >= baseCount)
        throw new Error(`tdfRenderer: Record ${r} derives from non-base record ${baseIndex}.`);
      const base = fontRecords[baseIndex];
      const spacing = bytes[offset + 2];
      const attrMapSize = bytes[offset + 3];
      offset += 4;
      require(attrMapSize * 2 + 1, `the attribute map of record ${r}`);
      for (let attr = 0; attr < 256; attr++) attrMap[attr] = attr;
      for (let i = 0; i < attrMapSize; i++, offset += 2) attrMap[bytes[offset]] = bytes[offset + 1];
      const overrideCount = bytes[offset++];
      require(overrideCount * 3, `the palette overrides of record ${r}`);

      const pairPalette = base.pairPalette.slice();
      for (let i = 1; i < pairPalette.length; i += 2) pairPalette[i] = attrMap[pairPalette[i]];
      for (let i = 0; i < overrideCount; i++, offset += 3) {
        const pairIndex = bytes[offset];
        if (pairIndex * 2 >= pairPalette.length) {
          throw new Error(`tdfRenderer: Record ${r} overrides pair ${pairIndex} of ${pairPalette.length / 2}.`);
        }
        pairPalette[pairIndex * 2] = bytes[offset + 1];
        pairPalette[pairIndex * 2 + 1] = bytes[offset + 2];
      }
      fontRecords.push({ spacing, pairPalette, glyphs: base.glyphs });
    }

    require(cellPoolSize, "the cell pool");
    const cellPool = bytes.subarray(offset, offset + cellPoolSize);

    return { version, fontIndex, fontRecords, cellPool };
  }

  // --- Public API Object ---

  const tdfRenderer = {};

  /**
   * Initializes the renderer by fetching and parsing the TDF binary font bundle.
   * This method must be called successfully before any rendering or layout calculations can be performed.
   * @param {string} bundleUrl - URL of the TDF font bundle file (e.g., `font_bundle.bin`).
   * @returns {Promise<string[]>} A promise that resolves with a sorted array of available font keys
   * upon successful initialization.
   * @throws {Error} If initialization fails (e.g., network error, invalid bundle format).
   */
  tdfRenderer.init = async (bundleUrl) => {
    if (_isInitialized) {
      console.warn("tdfRenderer: Already initialized. Returning list of available fonts.");
      return tdfRenderer.getAvailableFonts();
    }

    const bundleBuffer = await fetchBinary(bundleUrl); // May throw if fetch fails.
    const bundle = _parseBundle(bundleBuffer); // May throw if the bundle is invalid.
    _actualBundleFormatVersion = bundle.version;
    _fontIndex = bundle.fontIndex;
    _fontRecords = bundle.fontRecords;
    _cellPool = bundle.cellPool;

    _isInitialized = true;
    console.log(
      `tdfRenderer initialized. Bundle Format Version: ${_actualBundleFormatVersion}. Fonts available: ${_fontIndex.size}`,
    );
    return tdfRenderer.getAvailableFonts();
  };

  /**
   * Checks if the renderer has been successfully initialized.
   * @returns {boolean} True if initialized, false otherwise.
   */
  tdfRenderer.isInitialized = () => _isInitialized;

  /**
   * Returns a sorted array of unique font keys available in the loaded bundle.
   * @returns {string[]} A sorted array of available font keys, or an empty array if not initialized.
   */
  tdfRenderer.getAvailableFonts = () => {
    if (!_isInitialized) {
      return [];
    }
    return Array.from(_fontIndex.keys()).sort(); // Ensure consistent order for UI.
  };

  /**
   * Calculates overall layout dimensions (width and height in pixels) for the given text
   * using the specified TDF font. Handles multiline text (lines separated by '\n').
   * @param {string} uniqueFontKey - The unique key of the TDF font to use for measurement.
   * @param {string} text - The text string to measure. Can include '\n' for multiple lines.
   * @param {number} [minSpaceWidthChars=DefaultMinSpaceWidth] - Minimum width for a space character,
   * specified in character cell units. Used if a space has no defined width in the font.
   * @param {number} [additionalLineSpacingPx=DefaultAdditionalLineSpacingPx] - Additional pixels of
   * vertical spacing to add between lines of text.
   * @returns {{width: number, height: number} | null} An object with `width` and `height` in pixels,
   * or null if the font key is not found or another error occurs during layout calculation.
   */
  tdfRenderer.calculateLayout = (
    uniqueFontKey,
    text,
    minSpaceWidthChars = DefaultMinSpaceWidth,
    additionalLineSpacingPx = DefaultAdditionalLineSpacingPx,
  ) => {
    if (!_isInitialized) {
      console.error("tdfRenderer.calculateLayout: Not initialized. Call init() first.");
      return null;
    }
    if (!text) {
      // For empty or null text, return minimal dimensions (e.g., for a single empty line).
      return { width: CharWidth, height: CharHeight };
    }

    const fontRecordIndex = _fontIndex.get(uniqueFontKey);
    if (typeof fontRecordIndex === "undefined") {
      console.error(`tdfRenderer.calculateLayout: Font key "${uniqueFontKey}" not found.`);
      return null;
    }

    // Retrieve font-specific details, including character spacing, required for accurate layout.
    const fontDetails = _getFontRecord(fontRecordIndex);
    if (!fontDetails) {
      console.error(`tdfRenderer.calculateLayout: Could not parse details for font "${uniqueFontKey}".`);
      return null;
    }
    const fontSpacingChars = fontDetails.spacing;

    const lines = text.split("\n");
    let overallMaxWidthPx = 0; // Tracks the maximum width encountered across all lines.
    let totalHeightPx = 0; // Accumulates the total height of all lines plus spacing.
    const numLines = lines.length;

    for (let i = 0; i < numLines; i++) {
      const line = lines[i];
      const lineLayout = _calculateSingleLineLayout(fontRecordIndex, fontSpacingChars, line, minSpaceWidthChars);
      overallMaxWidthPx = Math.max(overallMaxWidthPx, lineLayout.width);
      totalHeightPx += lineLayout.height;
      if (i < numLines - 1) {
        // Add additional line spacing if it's not the last line.
        totalHeightPx += additionalLineSpacingPx;
      }
    }

    // Ensure the calculated layout has at least minimal dimensions.
    return {
      width: Math.max(overallMaxWidthPx, CharWidth), // Min width of one character cell if there was content.
      height: Math.max(totalHeightPx, CharHeight), // Min height of one character cell.
    };
  };

  /**
   * Filters the list of available TDF fonts to only those that support all
   * TDF-renderable characters present in the given text string.
   * TDF-renderable characters are typically ASCII 33 ('!') to 126 ('~').
   * @param {string} text - The text string to check character support against.
   * @returns {string[]} A sorted array of unique font keys that support all relevant characters in the text.
   * Returns all available fonts if the text is empty or contains no characters within the TDF renderable range.
   * Returns an empty array if the renderer is not initialized.
   */
  tdfRenderer.filterFontsByText = (text) => {
    if (!_isInitialized) {
      console.warn("tdfRenderer.filterFontsByText: Not initialized.");
      return [];
    }
    if (!text) {
      return tdfRenderer.getAvailableFonts(); // All fonts are compatible with empty text.
    }

    // Extract unique, TDF-renderable characters from the input text.
    // Spaces and newlines do not require specific glyph definitions for this check.
    const requiredChars = [...new Set(text.split(""))].filter((char) => {
      if (char === " " || char === "\n") return false;
      const charCode = char.charCodeAt(0);
      return charCode >= 33 && charCode <= 126; // Standard TDF printable ASCII range.
    });

    if (requiredChars.length === 0) {
      // If text contains only spaces, newlines, or non-TDF characters, all fonts are considered compatible.
      return tdfRenderer.getAvailableFonts();
    }

    // Filter fonts by checking if each required character has defined layout metrics (i.e., is defined in the font).
    return Array.from(_fontIndex.entries())
      .filter(([/*uniqueFontKey*/ , fontRecordIndex]) =>
        requiredChars.every((char) => _getGlyphLayoutMetricsOnly(fontRecordIndex, char.charCodeAt(0)) !== null),
      )
      .map(([key]) => key) // Extract only the font keys from the filtered entries.
      .sort(); // Return the list of compatible font keys, sorted alphabetically.
  };

  /**
   * Prepares a canvas for rendering. If a canvas is provided in options, it's used;
   * otherwise, a new canvas is created (in browser environments).
   * The canvas is sized appropriately and cleared with the background color.
   * @private
   * @param {object} options - Rendering options, potentially including `options.canvas` and `options.targetWidth`.
   * @param {{width: number, height: number}} layout - Calculated layout dimensions for the text.
   * @param {Array<number>} bgColorRgba - Background RGBA color array [r,g,b,a].
   * @returns {{canvas: HTMLCanvasElement, context: CanvasRenderingContext2D}} An object containing the prepared canvas and its 2D context.
   * @throws {Error} If a canvas cannot be obtained or its context cannot be retrieved.
   */
  function _prepareCanvasAndContext(options, layout, bgColorRgba) {
    let targetCanvas = options.canvas;
    const canCreateCanvas = typeof document !== "undefined" && typeof document.createElement === "function";

    if (!targetCanvas) {
      if (!canCreateCanvas) {
        throw new Error(
          "tdfRenderer: options.canvas is required in a non-browser environment or if document.createElement is unavailable.",
        );
      }
      targetCanvas = document.createElement("canvas");
    }

    // Set canvas dimensions. Ensure it's large enough for the text and any specified target width.
    // Also ensure it's at least one character cell in size.
    targetCanvas.width = Math.max(options.targetWidth || 0, layout.width, CharWidth);
    targetCanvas.height = Math.max(layout.height, CharHeight);

    const context = targetCanvas.getContext("2d");
    if (!context) {
      throw new Error("tdfRenderer: Failed to get 2D rendering context from the canvas.");
    }

    // Clear the canvas with the specified background color.
    context.fillStyle = `rgba(${bgColorRgba.join(",")})`;
    context.fillRect(0, 0, targetCanvas.width, targetCanvas.height);

    return { canvas: targetCanvas, context: context };
  }

  /**
   * Renders text using a specified TDF font onto a canvas.
   * If no canvas is provided in options, a new canvas element is created (in browser environments).
   *
   * @param {object} options - Rendering configuration options.
   * @param {string} options.uniqueFontKey - The unique key of the TDF font to use.
   * @param {string} options.text - The text string to render (can include '\n' for multiple lines).
   * @param {HTMLCanvasElement} [options.canvas] - An optional HTMLCanvasElement to render onto.
   * If not provided, a new one is created.
   * @param {number} [options.targetWidth] - An optional minimum width for the target/created canvas.
   * The canvas will be at least this wide, or wide enough for the text.
   * @param {string} [options.textAlign='left'] - Text alignment within the calculated text block width.
   * Supported values: 'left', 'center', 'right'.
   * @param {Array<number>} [options.bgColor=[0,0,0,255]] - Background RGBA color [r,g,b,a]. Defaults to opaque black.
   * @param {number} [options.minSpaceWidth=DefaultMinSpaceWidth] - Minimum width for a space character, in character cell units.
   * @param {number} [options.additionalLineSpacingPx=DefaultAdditionalLineSpacingPx] - Additional pixels between lines.
   * @returns {Promise<{canvas: HTMLCanvasElement}>} A promise that resolves with an object containing the canvas element
   * (either the one passed in or the newly created one).
   * @throws {Error} If initialization has not been performed, or if rendering fails for other reasons.
   */
  tdfRenderer.render = async (options) => {
    if (!_isInitialized) {
      throw new Error("tdfRenderer.render: Not initialized. Call init() first.");
    }
    if (!options || !options.uniqueFontKey || typeof options.text === "undefined") {
      throw new Error("tdfRenderer.render: Missing 'uniqueFontKey' or 'text' in options.");
    }

    const { uniqueFontKey, text } = options;
    const fontRecordIndex = _fontIndex.get(uniqueFontKey);
    if (typeof fontRecordIndex === "undefined") {
      throw new Error(`tdfRenderer.render: Font key "${uniqueFontKey}" not found.`);
    }

    // Fetch font-specific details, including character spacing.
    const fontDetails = _getFontRecord(fontRecordIndex);
    if (!fontDetails) {
      throw new Error(`tdfRenderer.render: Could not parse details for font "${uniqueFontKey}".`);
    }
    const fontSpacingChars = fontDetails.spacing;

    // Consolidate option defaults for rendering parameters.
    const minSpaceWidthChars =
      typeof options.minSpaceWidth === "number" && options.minSpaceWidth >= 0
        ? options.minSpaceWidth
        : DefaultMinSpaceWidth;
    const additionalLineSpacingPx =
      typeof options.additionalLineSpacingPx === "number" && options.additionalLineSpacingPx >= 0
        ? options.additionalLineSpacingPx
        : DefaultAdditionalLineSpacingPx;
    const textAlign = ["left", "center", "right"].includes(options.textAlign) ? options.textAlign : "left";
    const bgColorRgba =
      Array.isArray(options.bgColor) && options.bgColor.length === 4 ? options.bgColor : [0, 0, 0, 255]; // Default: opaque black.

    try {
      // Calculate the overall layout dimensions for the text.
      const layout = tdfRenderer.calculateLayout(uniqueFontKey, text, minSpaceWidthChars, additionalLineSpacingPx);
      if (!layout) {
        throw new Error("tdfRenderer.render: Failed to calculate text layout.");
      }

      const overallTextMaxWidthPx = layout.width; // Max width of any line in the text.
      const { canvas: targetCanvas, context } = _prepareCanvasAndContext(options, layout, bgColorRgba);

      // Calculate starting X for the entire text block to center it on the canvas if the canvas is wider.
      const blockStartX = Math.max(0, Math.floor((targetCanvas.width - overallTextMaxWidthPx) / 2));

      const lines = text.split("\n");
      let currentY = 0; // Y-coordinate for the top of the current line being rendered.
      const numLines = lines.length;

      for (let i = 0; i < numLines; i++) {
        const line = lines[i];
        // Render the current line with appropriate alignment and get its height.
        const lineHeightPx = _renderLineWithAlignment(
          context,
          line,
          currentY,
          blockStartX, // Start X of the entire text block.
          overallTextMaxWidthPx, // Width of the text block for alignment calculations.
          textAlign,
          fontRecordIndex,
          fontSpacingChars,
          minSpaceWidthChars,
        );
        currentY += lineHeightPx; // Advance Y position by the height of the rendered line.
        if (i < numLines - 1) {
          // If it's not the last line, add the additional inter-line spacing.
          currentY += additionalLineSpacingPx;
        }
      }

      return { canvas: targetCanvas };
    } catch (error) {
      // Catch errors from layout calculation, canvas preparation, or the rendering loop.
      console.error(`tdfRenderer: Error during rendering for font "${uniqueFontKey}":`, error.message, error.stack);
      throw error; // Re-throw to allow the caller to handle it.
    }
  };

  // --- Expose Public API ---
  // Attaches the tdfRenderer object to the global object (e.g., window in browsers, or global in Node.js).
  global.tdfRenderer = tdfRenderer;
})(typeof globalThis !== "undefined" ? globalThis : this);
