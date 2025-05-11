// tdfRenderer.js (Supports TDF Bundle Format v4.0)
// TheDraw Font (.TDF) text rendering library for HTML Canvas.
// Uses a preprocessed binary font bundle with local pair palettes and RLE.
// Copyright (C) 2012-2025 Ori Livneh & Contributors
// Licensed under the MIT and GPL licenses

((global) => {
  // --- Constants ---

  const CharWidth = 8; // Standard width of a CP437 character cell in pixels.
  const CharHeight = 16; // Standard height of a CP437 character cell in pixels.

  const DefaultMinSpaceWidth = 3; // Default minimum width for a space char (in char units).
  const DefaultAdditionalLineSpacingPx = 0; // Default additional pixels between lines.

  // RLE constants for Bundle v4.0
  const RLE_ESCAPE_BYTE = 0xff;
  const RLE_MIN_RUN_LENGTH = 3; // Smallest actual run length to encode with RLE.

  // Standard CGA/EGA/VGA 16-color palette (RGBA format).
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
  const EXPECTED_BUNDLE_FORMAT_VERSION = 4; // This renderer supports Bundle Format v4.0.

  // Cache for parsed font details (pair palettes, GLT offsets, etc.)
  // Key: fontDataOffsetInPool (number), Value: object with parsed details.
  const _parsedFontDetailsCache = new Map();

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
    if (endOffset === startOffset) return ""; // Empty string.
    const stringBytes = new Uint8Array(dataView.buffer, dataView.byteOffset + startOffset, endOffset - startOffset);
    try {
      return new TextDecoder().decode(stringBytes);
    } catch {
      // Fallback for older environments or specific TextDecoder issues.
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
      console.warn("tdfRenderer: context.createImageData is not available. Cannot draw CP437 char.");
      return;
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
      // Undefined or invalid character bitmap. Fill with background.
      const fillColor = bgColorRgba[3] > 0 ? bgColorRgba : [0, 0, 0, 0]; // Use transparent black if BG is transparent
      _fillImageData(imageData, fillColor);
    } else {
      // Valid character bitmap: render pixels.
      for (let row = 0; row < CharHeight; row++) {
        const rowBits = bitmap[row] || 0x00; // Default to empty row if somehow undefined.
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

  // --- Utilities: TDF Glyph Parsing & Metrics (for Bundle v4.0) ---

  /**
   * Parses font-specific details (pair palette, GLT offset, etc.) from the bundle.
   * Caches the result in _parsedFontDetailsCache.
   * @param {number} fontDataOffsetInPool - Offset of this font's data within the font data pool.
   * @returns {object | null} Font details object or null on error.
   */
  function _getOrParseFontDetails(fontDataOffsetInPool) {
    if (_parsedFontDetailsCache.has(fontDataOffsetInPool)) {
      return _parsedFontDetailsCache.get(fontDataOffsetInPool);
    }

    const fontBaseAbsOffset = _fontDataPoolOffset + fontDataOffsetInPool;
    let currentParseOffset = fontBaseAbsOffset;
    const details = {}; // Object to store parsed details for caching.

    try {
      // 1. Font Spacing (Uint8, 1 byte)
      if (currentParseOffset + 1 > _bundleView.byteLength) throw new Error("EOF reading font spacing");
      details.spacing = _bundleView.getUint8(currentParseOffset);
      currentParseOffset += 1;

      // 2. Number of Pairs (nPairs, Uint8, 1 byte)
      if (currentParseOffset + 1 > _bundleView.byteLength) throw new Error("EOF reading nPairs");
      const nPairs = _bundleView.getUint8(currentParseOffset);
      details.nPairs = nPairs;
      currentParseOffset += 1;

      // 3. Pair Palette Data (nPairs * 2 bytes)
      details.pairPalette = []; // Array of {char: number, attr: number}
      if (currentParseOffset + nPairs * 2 > _bundleView.byteLength) throw new Error("EOF reading pairPalette data");
      for (let i = 0; i < nPairs; i++) {
        const charByte = _bundleView.getUint8(currentParseOffset++);
        const attrByte = _bundleView.getUint8(currentParseOffset++);
        details.pairPalette.push({ char: charByte, attr: attrByte });
      }

      // 4. Glyph Count (G, Uint8, 1 byte)
      if (currentParseOffset + 1 > _bundleView.byteLength) throw new Error("EOF reading glyphCount");
      details.glyphCount = _bundleView.getUint8(currentParseOffset);
      currentParseOffset += 1;

      // 5. Glyph Lookup Table (GLT) starts at the current offset
      details.gltAbsOffset = currentParseOffset;

      // 6. Glyph Data Table (GDT) starts immediately after the GLT
      details.gdtBaseAbsOffset = details.gltAbsOffset + details.glyphCount * 3; // Each GLT entry is 3 bytes

      // Basic validation: GDT base offset should not exceed bundle length if there are glyphs.
      if (details.gdtBaseAbsOffset > _bundleView.byteLength && details.glyphCount > 0) {
        throw new Error("Calculated GDT base offset is out of bundle bounds.");
      }

      _parsedFontDetailsCache.set(fontDataOffsetInPool, details); // Cache successfully parsed details.
      return details;
    } catch (e) {
      console.error(
        `tdfRenderer: Error parsing font details for font at data pool offset ${fontDataOffsetInPool}:`,
        e.message,
      );
      return null; // Return null on any parsing error.
    }
  }

  /**
   * Performs binary search in a font's Glyph Lookup Table (GLT) for a char's data offset.
   * @param {number} gltAbsOffset - Absolute start offset of the GLT in _bundleView.
   * @param {number} glyphCount - Number of glyphs/entries in the GLT.
   * @param {number} charCode - Character code to find.
   * @returns {number} Relative offset of glyph data (from GDT base) if found, else -1.
   */
  function _findGlyphOffsetInLookupTable(gltAbsOffset, glyphCount, charCode) {
    let low = 0;
    let high = glyphCount - 1;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const entryOffset = gltAbsOffset + mid * 3; // Each GLT entry is 3 bytes.

      // Safety check: ensure the entry is within bundle bounds.
      if (entryOffset + 3 > _bundleView.byteLength) {
        console.warn(`tdfRenderer: GLT entry for charCode ${charCode} search is out of bounds.`);
        return -1;
      }

      const entryCharCode = _bundleView.getUint8(entryOffset);
      if (entryCharCode === charCode) {
        return _bundleView.getUint16(entryOffset + 1, true); // Found: return 2-byte relative offset (Little Endian).
      }
      if (charCode < entryCharCode) {
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
    return -1; // Character code not found in GLT.
  }

  /**
   * Decodes an RLE stream of pair palette indices into a flat array of indices.
   * @param {number} rleStreamAbsOffset - Absolute offset in _bundleView where the RLE stream begins.
   * @param {number} expectedNumCells - Total number of cells (width * height) to decode.
   * @returns {Array<number> | null} Array of pair palette indices, or null on error.
   */
  function _decodeRLEStreamToPairIndices(rleStreamAbsOffset, expectedNumCells) {
    const decodedIndices = [];
    let currentOffset = rleStreamAbsOffset;
    let cellsDecoded = 0;

    while (cellsDecoded < expectedNumCells) {
      if (currentOffset >= _bundleView.byteLength) {
        console.warn("tdfRenderer: RLE stream ended prematurely before all cells were decoded.");
        return null; // Stream ended before expected number of cells.
      }
      const byteValue = _bundleView.getUint8(currentOffset++);

      if (byteValue === RLE_ESCAPE_BYTE) {
        // RLE sequence
        if (currentOffset + 2 > _bundleView.byteLength) {
          // Need 2 more bytes for run_length & index
          console.warn("tdfRenderer: RLE stream ended prematurely during an escape sequence.");
          return null;
        }
        const runLengthByte = _bundleView.getUint8(currentOffset++);
        const indexToRepeat = _bundleView.getUint8(currentOffset++);
        const actualRunLength = runLengthByte + RLE_MIN_RUN_LENGTH;

        for (let k = 0; k < actualRunLength; k++) {
          if (cellsDecoded + k < expectedNumCells) {
            // Ensure we don't overflow expectedNumCells
            decodedIndices.push(indexToRepeat);
          } else {
            // This case should ideally not be hit if RLE stream is correct for expectedNumCells
            console.warn("tdfRenderer: RLE run exceeds expected cell count.");
            break;
          }
        }
        cellsDecoded += actualRunLength;
      } else {
        // Literal pair palette index
        decodedIndices.push(byteValue);
        cellsDecoded++;
      }
    }

    // Final validation and adjustment if counts mismatch.
    if (decodedIndices.length !== expectedNumCells) {
      console.warn(
        `tdfRenderer: RLE decoded cells count (${decodedIndices.length}) does not match expected count (${expectedNumCells}). Stream may be corrupt or have an issue.`,
      );
      // Truncate or pad to meet expectedNumCells for consistency in rendering.
      const result = new Array(expectedNumCells);
      for (let i = 0; i < expectedNumCells; ++i) {
        result[i] = decodedIndices[i] !== undefined ? decodedIndices[i] : 0; // Pad with index 0 if too short
      }
      return result;
    }
    return decodedIndices;
  }

  /**
   * Gets a glyph's precalculated width and height for layout purposes (no stream parsing).
   * @param {number} fontDataOffsetInPool - Offset of this font's data in the pool.
   * @param {number} charCode - Character code of the glyph.
   * @returns {{width: number, height: number} | null} Width (in char cells) & height (in lines), or null if not found/error.
   */
  function _getGlyphLayoutMetricsOnly(fontDataOffsetInPool, charCode) {
    const fontDetails = _getOrParseFontDetails(fontDataOffsetInPool);
    if (!fontDetails) return null; // Error parsing font details.

    const { glyphCount, gltAbsOffset, gdtBaseAbsOffset } = fontDetails;
    if (glyphCount === 0) return null; // Font has no glyphs defined.

    const glyphDataRelOffset = _findGlyphOffsetInLookupTable(gltAbsOffset, glyphCount, charCode);
    if (glyphDataRelOffset === -1) return null; // Glyph not defined for this charCode.

    const glyphSpecificDataAbsOffset = gdtBaseAbsOffset + glyphDataRelOffset;
    // Check if width and height bytes are readable.
    if (glyphSpecificDataAbsOffset + 2 > _bundleView.byteLength) {
      console.warn(
        `tdfRenderer: Insufficient data for glyph metrics (char ${charCode}) at GDT offset ${glyphSpecificDataAbsOffset}.`,
      );
      return null;
    }

    const width = _bundleView.getUint8(glyphSpecificDataAbsOffset);
    const height = _bundleView.getUint8(glyphSpecificDataAbsOffset + 1);
    return { width, height };
  }

  /**
   * Parses a TDF glyph's full data (width, height, and actual char/attr cell data) for rendering.
   * This involves RLE decoding and mapping indices to (char, attr) pairs.
   * @param {number} fontDataOffsetInPool - Offset of this font's data in the pool.
   * @param {number} charCode - Character code of the glyph.
   * @returns {Array<number> | null} An array: [width, height_lines, char1, attr1, char2, attr2, ...], or null on error.
   */
  function parseGlyphDataOnDemand(fontDataOffsetInPool, charCode) {
    const fontDetails = _getOrParseFontDetails(fontDataOffsetInPool);
    if (!fontDetails) {
      console.error(`tdfRenderer: Failed to get font details for font offset ${fontDataOffsetInPool}.`);
      return null;
    }

    const { glyphCount, gltAbsOffset, gdtBaseAbsOffset, pairPalette } = fontDetails;
    if (glyphCount === 0) return null; // No glyphs in this font.

    const glyphDataRelOffset = _findGlyphOffsetInLookupTable(gltAbsOffset, glyphCount, charCode);
    if (glyphDataRelOffset === -1) return null; // Glyph not defined in this font for this charCode.

    const glyphSpecificDataAbsOffset = gdtBaseAbsOffset + glyphDataRelOffset;

    try {
      // Read Width and Height for the glyph
      if (glyphSpecificDataAbsOffset + 2 > _bundleView.byteLength) throw new Error("EOF reading glyph width/height");
      const width = _bundleView.getUint8(glyphSpecificDataAbsOffset);
      const height = _bundleView.getUint8(glyphSpecificDataAbsOffset + 1);
      const rleStreamAbsOffset = glyphSpecificDataAbsOffset + 2; // RLE stream follows width & height
      const expectedNumCells = width * height;

      if (expectedNumCells === 0) {
        // Glyph has no cells (e.g., width or height is 0).
        return [width, height]; // Return dimensions, empty cell stream.
      }

      const decodedIndices = _decodeRLEStreamToPairIndices(rleStreamAbsOffset, expectedNumCells);
      if (!decodedIndices) {
        // Error during RLE decoding
        throw new Error(`Failed to decode RLE stream for char ${charCode}`);
      }

      // Map decoded indices back to [char, attr] pairs
      const cellData = []; // Will store [char1, attr1, char2, attr2, ...]
      for (const index of decodedIndices) {
        if (index >= pairPalette.length) {
          // This indicates an invalid index, possibly due to corrupt data or RLE error.
          console.warn(
            `tdfRenderer: Invalid pair palette index ${index} (palette size ${pairPalette.length}) encountered for char ${charCode}. Using default cell (space, light grey/black).`,
          );
          cellData.push(0x20, 0x07); // Default to space, light grey on black
          continue;
        }
        const pair = pairPalette[index];
        cellData.push(pair.char, pair.attr);
      }
      return [width, height, ...cellData]; // Prepend width & height to the cell data stream.
    } catch (e) {
      console.error(
        `tdfRenderer: Error parsing full glyph data for char ${charCode} (font offset ${fontDataOffsetInPool}):`,
        e.message,
        e.stack,
      );
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
    const glyphMetrics = _getGlyphLayoutMetricsOnly(fontDataOffsetInPool, charCode);

    if (char === " ") {
      // For space, try to get its defined metrics, otherwise use minSpaceWidthChars
      const spaceMetrics = _getGlyphLayoutMetricsOnly(fontDataOffsetInPool, 32); // ASCII for space
      if (spaceMetrics && spaceMetrics.width > 0) {
        // Use defined space if it has width
        widthPx = spaceMetrics.width * CharWidth;
        heightPx = Math.max(1, spaceMetrics.height) * CharHeight;
      } else {
        // Undefined or zero-width space, use default
        widthPx = minSpaceWidthChars * CharWidth;
      }
      isDefined = true; // Space is always "defined" for layout purposes.
    } else if (glyphMetrics) {
      // For non-space characters
      widthPx = glyphMetrics.width * CharWidth;
      heightPx = Math.max(1, glyphMetrics.height) * CharHeight; // Ensure min 1 line height
      isDefined = true;
    }
    // Else (undefined non-space char): widthPx = 0, heightPx = CharHeight, isDefined = false.
    return { widthPx, heightPx, isDefined };
  }

  /**
   * Calculates total pixel width and maximum pixel height for a single line of text.
   * @param {number} fontDataOffsetInPool - Offset of the font's data.
   * @param {number} fontSpacingChars - Inter-character spacing (char units), read from font details.
   * @param {string} textLine - The line of text to measure.
   * @param {number} minSpaceWidthChars - Min width for space characters.
   * @returns {{width: number, height: number}} Calculated width and height in pixels.
   */
  function _calculateSingleLineLayout(fontDataOffsetInPool, fontSpacingChars, textLine, minSpaceWidthChars) {
    if (!textLine) {
      return { width: 0, height: CharHeight }; // Empty line still has default height.
    }

    let lineWidthPx = 0;
    let maxLineHeightPx = 0;
    let glyphsOnLine = 0; // Count of glyphs contributing to width (for spacing calculation).

    for (let i = 0; i < textLine.length; i++) {
      const metrics = _getCharLayoutMetrics(fontDataOffsetInPool, textLine[i], minSpaceWidthChars);
      lineWidthPx += metrics.widthPx;
      maxLineHeightPx = Math.max(maxLineHeightPx, metrics.heightPx);

      // A glyph contributes to inter-glyph spacing if it has width or is a space.
      if (metrics.widthPx > 0 || textLine[i] === " ") {
        glyphsOnLine++;
      }
    }

    // Add inter-character spacing if more than one glyph on the line.
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
   * Renders a single TDF glyph (which is a dense grid of cells) onto the canvas.
   * glyphCompactData is [width, height, char1, attr1, char2, attr2, ...].
   * @param {CanvasRenderingContext2D} context - The canvas rendering context.
   * @param {Array<number>} glyphCompactData - Parsed glyph data: [width, height, cell_data...].
   * @param {number} baseX - Starting X coordinate on canvas for this TDF glyph.
   * @param {number} baseY - Starting Y coordinate on canvas for this TDF glyph.
   */
  function _renderTdfGlyphOnCanvas(context, glyphCompactData, baseX, baseY) {
    if (!glyphCompactData || glyphCompactData.length < 2) {
      // Must have at least width, height
      console.warn("tdfRenderer: Attempted to render glyph with insufficient compact data (missing width/height).");
      return;
    }

    const glyphWidthChars = glyphCompactData[0];
    const glyphHeightLines = glyphCompactData[1];
    const expectedCells = glyphWidthChars * glyphHeightLines;

    // Cell data starts at index 2. Each cell is represented by 2 items (char, attr).
    if (glyphCompactData.length < 2 + expectedCells * 2 && expectedCells > 0) {
      console.warn(
        `tdfRenderer: Glyph compact data stream is shorter (${glyphCompactData.length - 2} items) than expected by width*height (${expectedCells * 2} items). Glyph may be truncated.`,
      );
      // Render what's available, up to the shorter length.
    }

    for (let i = 0; i < expectedCells; i++) {
      const dataIndex = 2 + i * 2;
      if (dataIndex + 1 >= glyphCompactData.length) break; // Stop if we run out of data for a pair

      const charByte = glyphCompactData[dataIndex];
      const attrByte = glyphCompactData[dataIndex + 1];

      // Calculate cell position within the glyph grid
      const currentGlyphCellX = i % glyphWidthChars;
      const currentGlyphCellY = Math.floor(i / glyphWidthChars);

      // Calculate canvas position for this cell
      const canvasX = baseX + currentGlyphCellX * CharWidth;
      const canvasY = baseY + currentGlyphCellY * CharHeight;

      // Determine foreground and background colors from attribute byte
      const bgIndex = (attrByte >> 4) & 0x07; // TDF uses 3 bits for BG (0-7).
      const fgIndex = attrByte & 0x0f; // TDF uses 4 bits for FG (0-15).

      const bgColor = TdfColors[bgIndex] || TdfColors[0]; // Default to black if index out of bounds.
      const fgColor = TdfColors[fgIndex] || TdfColors[7]; // Default to light grey if index out of bounds.

      drawCp437Char(context, charByte, canvasX, canvasY, fgColor, bgColor);
    }
  }

  /**
   * Renders a single line of text onto the canvas at a specified X, Y.
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
      let glyphCompactData = null;

      glyphCompactData = char === " " ? null : parseGlyphDataOnDemand(fontDataOffsetInPool, charCode);

      if (char === " ") {
        const spaceMetrics = _getGlyphLayoutMetricsOnly(fontDataOffsetInPool, 32); // ASCII 32 for space
        glyphRenderWidthPx =
          spaceMetrics && spaceMetrics.width > 0 ? spaceMetrics.width * CharWidth : minSpaceWidthChars * CharWidth;
        // For space, usually no complex glyph is rendered, but background might be filled.
        // If a space *does* have a defined glyph (e.g. a shaded block), render it.
        if (glyphCompactData && glyphCompactData.length > 2 && spaceMetrics && spaceMetrics.width > 0) {
          _renderTdfGlyphOnCanvas(context, glyphCompactData, currentX, lineBaseY);
        } else if (glyphRenderWidthPx > 0) {
          // Fill background for default space
          const fontDetails = _getOrParseFontDetails(fontDataOffsetInPool);
          // Determine a suitable background color for the space.
          // Using the background of the first color pair in the font's palette, or black.
          const defaultBgColor =
            fontDetails && fontDetails.pairPalette.length > 0
              ? TdfColors[(fontDetails.pairPalette[0].attr >> 4) & 0x07]
              : TdfColors[0]; // Fallback to black
          context.fillStyle = `rgba(${defaultBgColor.join(",")})`;
          context.fillRect(Math.floor(currentX), Math.floor(lineBaseY), Math.ceil(glyphRenderWidthPx), CharHeight);
        }
      } else if (glyphCompactData) {
        // Non-space character with data
        glyphRenderWidthPx = glyphCompactData[0] * CharWidth; // compactData[0] is width.
        if (glyphCompactData.length > 2) {
          // Has renderable cell data
          _renderTdfGlyphOnCanvas(context, glyphCompactData, currentX, lineBaseY);
        }
      }
      // If glyphCompactData is null for a non-space char, it's undefined; width remains 0.

      currentX += glyphRenderWidthPx;
      // Add inter-character spacing if not the last character and current char contributed width
      if (i < lineText.length - 1 && glyphRenderWidthPx > 0) {
        currentX += fontSpacingChars * CharWidth;
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
    const currentLineHeightPx = lineLayout.height; // This is max height of glyphs in line

    let lineIndentPx = 0; // Indentation of this line within the text block.
    if (textAlign === "center") {
      lineIndentPx = Math.max(0, Math.floor((textBlockWidthPx - currentLineWidthPx) / 2));
    } else if (textAlign === "right") {
      lineIndentPx = Math.max(0, textBlockWidthPx - currentLineWidthPx);
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
    // The height returned is the layout height of the line, for advancing Y.
    return currentLineHeightPx;
  }

  // --- Utilities: Bundle Parsing ---

  const BundleHeaderSize = 21; // Magic(4) + Ver(1) + FontCount(4) + IndexOffset(4) + StringOffset(4) + DataOffset(4)
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
    if (version !== EXPECTED_BUNDLE_FORMAT_VERSION) {
      throw new Error(
        `tdfRenderer: Unsupported bundle version: ${version}. Expected ${EXPECTED_BUNDLE_FORMAT_VERSION}.`,
      );
    }
    // _bundleFormatVersion = version; // Set in init after this check

    const fontCount = bundleView.getUint32(5, true);
    const indexTableOffset = bundleView.getUint32(9, true);
    const stringPoolOffset = bundleView.getUint32(13, true);
    const fontDataPoolOffset = bundleView.getUint32(17, true);

    // Validate offsets to ensure they are within reasonable bounds of the file.
    const maxIndexTableEnd = indexTableOffset + fontCount * FontIndexEntrySize;
    if (
      indexTableOffset >= bundleView.byteLength ||
      stringPoolOffset >= bundleView.byteLength ||
      fontDataPoolOffset >= bundleView.byteLength ||
      maxIndexTableEnd > bundleView.byteLength // Index table itself shouldn't go out of bounds
    ) {
      throw new Error("tdfRenderer: Invalid offsets in bundle header (out of bounds).");
    }

    return { version, fontCount, indexTableOffset, stringPoolOffset, fontDataPoolOffset };
  }

  /**
   * Parses the Font Index Table from the bundle.
   * @param {DataView} bundleView - DataView of the bundle.
   * @param {object} headerInfo - Parsed header information.
   * @returns {Map<string, number>} Map of font keys to their data offsets relative to font data pool start.
   */
  function _parseFontIndex(bundleView, headerInfo) {
    const { fontCount, indexTableOffset, stringPoolOffset } = headerInfo;
    const newFontIndex = new Map();

    for (let i = 0; i < fontCount; i++) {
      const entryAbsOffset = indexTableOffset + i * FontIndexEntrySize;

      // Ensure entry is readable
      if (entryAbsOffset + FontIndexEntrySize > bundleView.byteLength) {
        console.warn(`tdfRenderer: Font index entry ${i} is out of bounds.`);
        continue;
      }

      const keyStrRelOffset = bundleView.getUint32(entryAbsOffset, true);
      const fontDataRelOffset = bundleView.getUint32(entryAbsOffset + 4, true);

      // Ensure string key is readable
      if (stringPoolOffset + keyStrRelOffset >= bundleView.byteLength) {
        console.warn(`tdfRenderer: String pool offset for key in index entry ${i} is out of bounds.`);
        continue;
      }

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
   * @param {string} bundleUrl - URL of the TDF font bundle file (e.g., `font_bundle.bin`).
   * @returns {Promise<string[]>} Promise resolving with a sorted array of available font keys.
   * @throws {Error} If initialization fails (e.g., network error, invalid bundle).
   */
  tdfRenderer.init = async (bundleUrl) => {
    if (_isInitialized) {
      // Prevent re-initialization
      console.warn("tdfRenderer: Already initialized. Returning available fonts.");
      return tdfRenderer.getAvailableFonts();
    }

    _bundleBuffer = await fetchBinary(bundleUrl); // Can throw if fetch fails
    _bundleView = new DataView(_bundleBuffer);
    _parsedFontDetailsCache.clear(); // Clear cache from any previous (failed) init

    const headerInfo = _parseBundleHeader(_bundleView); // Can throw if header is invalid
    _bundleFormatVersion = headerInfo.version; // Store the validated version
    _stringPoolOffset = headerInfo.stringPoolOffset;
    _fontDataPoolOffset = headerInfo.fontDataPoolOffset;

    _fontIndex = _parseFontIndex(_bundleView, headerInfo);

    _isInitialized = true;
    console.log(
      `tdfRenderer initialized. Bundle Format Version: ${_bundleFormatVersion}. Fonts available: ${_fontIndex.size}`,
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
   * @returns {string[]} Sorted array of font keys, or an empty array if not initialized.
   */
  tdfRenderer.getAvailableFonts = () => {
    if (!_isInitialized) {
      return [];
    }
    return Array.from(_fontIndex.keys()).sort();
  };

  /**
   * Calculates overall layout dimensions (width, height in pixels) for the given text
   * using the specified TDF font. Handles multiline text ('\n').
   * @param {string} uniqueFontKey - The unique key of the font to use.
   * @param {string} text - The text string to measure (can include '\n' for multiple lines).
   * @param {number} [minSpaceWidthChars=DefaultMinSpaceWidth] - Minimum width for a space character, in character cell units.
   * @param {number} [additionalLineSpacingPx=DefaultAdditionalLineSpacingPx] - Additional pixels between lines.
   * @returns {{width: number, height: number} | null} Object with `width` and `height` in pixels, or null if font not found or error.
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
      // Handle empty or null text gracefully
      return { width: CharWidth, height: CharHeight }; // Minimal layout for effectively empty text.
    }

    const fontDataOffsetInPool = _fontIndex.get(uniqueFontKey);
    if (typeof fontDataOffsetInPool === "undefined") {
      console.error(`tdfRenderer.calculateLayout: Font key "${uniqueFontKey}" not found.`);
      return null;
    }

    // Get font-specific details, including spacing, required for layout.
    const fontDetails = _getOrParseFontDetails(fontDataOffsetInPool);
    if (!fontDetails) {
      console.error(`tdfRenderer.calculateLayout: Could not parse details for font "${uniqueFontKey}".`);
      return null;
    }
    const fontSpacingChars = fontDetails.spacing;

    const lines = text.split("\n");
    let overallMaxWidthPx = 0;
    let totalHeightPx = 0;
    const numLines = lines.length;

    for (let i = 0; i < numLines; i++) {
      const line = lines[i];
      const lineLayout = _calculateSingleLineLayout(fontDataOffsetInPool, fontSpacingChars, line, minSpaceWidthChars);
      overallMaxWidthPx = Math.max(overallMaxWidthPx, lineLayout.width);
      totalHeightPx += lineLayout.height;
      if (i < numLines - 1) {
        // Add additional spacing if not the last line
        totalHeightPx += additionalLineSpacingPx;
      }
    }

    return {
      width: Math.max(overallMaxWidthPx, CharWidth), // Ensure at least 1 char width if there was content.
      height: Math.max(totalHeightPx, CharHeight), // Ensure at least 1 char height.
    };
  };

  /**
   * Filters available TDF fonts to those supporting all TDF-renderable characters in the given text.
   * TDF-renderable characters are typically ASCII 33 ('!') to 126 ('~').
   * @param {string} text - The text string to check character support against.
   * @returns {string[]} A sorted array of unique font keys that support all characters in the text.
   * Returns all available fonts if text is empty or contains no TDF-renderable characters.
   * Returns an empty array if not initialized.
   */
  tdfRenderer.filterFontsByText = (text) => {
    if (!_isInitialized) {
      console.warn("tdfRenderer.filterFontsByText: Not initialized.");
      return [];
    }
    if (!text) {
      return tdfRenderer.getAvailableFonts(); // All fonts compatible with empty text.
    }

    // Extract unique, TDF-renderable characters from the input text.
    const requiredChars = [...new Set(text.split(""))].filter((char) => {
      if (char === " " || char === "\n") return false; // Spaces and newlines don't need specific glyphs.
      const charCode = char.charCodeAt(0);
      return charCode >= 33 && charCode <= 126; // Standard TDF printable range.
    });

    if (requiredChars.length === 0) {
      // Text has only spaces, newlines, or characters outside the TDF renderable range.
      return tdfRenderer.getAvailableFonts();
    }

    // Filter fonts: check if each required character has defined metrics.
    return Array.from(_fontIndex.entries())
      .filter(([/*key*/ , fontDataOffsetInPool]) =>
        requiredChars.every((char) => _getGlyphLayoutMetricsOnly(fontDataOffsetInPool, char.charCodeAt(0)) !== null),
      )
      .map(([key]) => key) // Get only the font keys.
      .sort(); // Sort the resulting list of keys.
  };

  /**
   * Prepares a canvas for rendering: creates if not provided, sets dimensions,
   * gets 2D context, and clears with a background color.
   * @private
   * @param {object} options - Rendering options, may contain `options.canvas` and `options.targetWidth`.
   * @param {{width: number, height: number}} layout - Calculated layout dimensions for the text.
   * @param {Array<number>} bgColorRgba - Background RGBA color.
   * @returns {{canvas: HTMLCanvasElement, context: CanvasRenderingContext2D}}
   * @throws {Error} If canvas or context cannot be prepared.
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

    // Set canvas dimensions based on layout and optional targetWidth.
    targetCanvas.width = Math.max(options.targetWidth || 0, layout.width, CharWidth);
    targetCanvas.height = Math.max(layout.height, CharHeight); // Ensure min height for at least one line.

    const context = targetCanvas.getContext("2d");
    if (!context) {
      throw new Error("tdfRenderer: Failed to get 2D rendering context from the canvas.");
    }

    // Clear canvas with background color.
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
    const fontDataOffsetInPool = _fontIndex.get(uniqueFontKey);
    if (typeof fontDataOffsetInPool === "undefined") {
      throw new Error(`tdfRenderer.render: Font key "${uniqueFontKey}" not found.`);
    }

    // Fetch font-specific details, including spacing.
    const fontDetails = _getOrParseFontDetails(fontDataOffsetInPool);
    if (!fontDetails) {
      throw new Error(`tdfRenderer.render: Could not parse details for font "${uniqueFontKey}".`);
    }
    const fontSpacingChars = fontDetails.spacing;

    // Consolidate option defaults
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
      const layout = tdfRenderer.calculateLayout(uniqueFontKey, text, minSpaceWidthChars, additionalLineSpacingPx);
      if (!layout) {
        // Should be caught by calculateLayout if font key is invalid, but double check.
        throw new Error("tdfRenderer.render: Failed to calculate text layout.");
      }

      const overallTextMaxWidthPx = layout.width; // Max width of any line in the text.
      const { canvas: targetCanvas, context } = _prepareCanvasAndContext(options, layout, bgColorRgba);

      // Calculate starting X for the text block to center it on the canvas if canvas is wider.
      const blockStartX = Math.max(0, Math.floor((targetCanvas.width - overallTextMaxWidthPx) / 2));

      const lines = text.split("\n");
      let currentY = 0; // Y-coordinate for the top of the current line.
      const numLines = lines.length;

      for (let i = 0; i < numLines; i++) {
        const line = lines[i];
        const lineHeightPx = _renderLineWithAlignment(
          context,
          line,
          currentY,
          blockStartX,
          overallTextMaxWidthPx, // Pass the width of the text block for alignment.
          textAlign,
          fontDataOffsetInPool,
          fontSpacingChars,
          minSpaceWidthChars,
          // additionalLineSpacingPx is not passed here, as _renderLineWithAlignment returns line's own height
        );
        currentY += lineHeightPx;
        if (i < numLines - 1) {
          // If it's not the last line, add the additional spacing
          currentY += additionalLineSpacingPx;
        }
      }

      return { canvas: targetCanvas };
    } catch (error) {
      // Catch errors from layout, canvas prep, or rendering loop.
      console.error(`tdfRenderer: Error during rendering for font "${uniqueFontKey}":`, error.message, error.stack);
      throw error; // Re-throw for caller handling.
    }
  };

  // --- Expose Public API ---
  // Attaches the tdfRenderer object to the global object (window in browsers, global in Node.js).
  global.tdfRenderer = tdfRenderer;
})(typeof globalThis !== "undefined" ? globalThis : this);
