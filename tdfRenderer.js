// tdfRenderer.js (Supports TDF Bundle Format v4.0)
// TheDraw Font (.TDF) text rendering library for HTML Canvas.
// Uses a preprocessed binary font bundle with local pair palettes and RLE.
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

  // RLE constants specific to the Bundle Format v4.0.
  const RLE_ESCAPE_BYTE = 0xff; // Byte value indicating an RLE sequence.
  const RLE_MIN_RUN_LENGTH = 3; // Smallest actual run length to be RLE encoded.
  // Shorter runs are stored as literal indices.

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

  let _bundleBuffer = null; // ArrayBuffer holding the entire TDF font bundle.
  let _bundleView = null; // DataView for accessing _bundleBuffer.
  let _fontIndex = new Map(); // Maps uniqueFontKey (string) to fontDataOffsetInPool (number).
  let _stringPoolOffset = 0; // Absolute offset of the string pool within the bundle.
  let _fontDataPoolOffset = 0; // Absolute offset of the font data pool within the bundle.
  let _isInitialized = false; // Flag indicating if init() has successfully completed.
  const EXPECTED_BUNDLE_FORMAT_VERSION = 4; // This renderer is built for Bundle Format v4.0.
  let _actualBundleFormatVersion = 0; // Stores the version read from the loaded bundle.

  // Cache for parsed font-specific details (pair palettes, GLT offsets, etc.)
  // Key: fontDataOffsetInPool (number), Value: Object containing { spacing, nPairs, pairPalette, glyphCount, gltAbsOffset, gdtBaseAbsOffset }
  const _parsedFontDetailsCache = new Map();

  // --- Utilities: File I/O & String Parsing ---

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

  /**
   * Reads a null-terminated UTF-8 string from a DataView starting at a given offset.
   * @param {DataView} dataView - The DataView to read from.
   * @param {number} startOffset - The absolute offset within the DataView's buffer where the string begins.
   * @returns {string} The decoded string. Returns an empty string if reading fails or the string is empty.
   */
  function readNullTerminatedString(dataView, startOffset) {
    let endOffset = startOffset;
    // Find the null terminator or end of buffer.
    while (endOffset < dataView.byteLength && dataView.getUint8(endOffset) !== 0) {
      endOffset++;
    }
    if (endOffset === startOffset) return ""; // Empty string.

    // Extract bytes and decode.
    const stringBytes = new Uint8Array(dataView.buffer, dataView.byteOffset + startOffset, endOffset - startOffset);
    try {
      return new TextDecoder().decode(stringBytes); // Modern browsers.
    } catch {
      // Fallback for environments without TextDecoder or for specific character sets if needed.
      try {
        return String.fromCharCode.apply(null, stringBytes);
      } catch (decodeError) {
        console.warn(
          "tdfRenderer: String decoding failed with TextDecoder and String.fromCharCode fallback:",
          decodeError,
        );
        return ""; // Return empty on failure.
      }
    }
  }

  // --- Utilities: CP437 Character Rendering ---

  /**
   * Fills an ImageData object with a specified RGBA color.
   * @param {ImageData} imageData - The ImageData object to fill.
   * @param {Array<number>} colorRgba - An array [r, g, b, a] representing the color.
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
   * Draws a single CP437 character onto a canvas context using preloaded bitmap data.
   * @param {CanvasRenderingContext2D} context - The 2D rendering context of the canvas.
   * @param {number} charCode - The CP437 character code (0-255).
   * @param {number} canvasX - The target X-coordinate on the canvas (top-left of character).
   * @param {number} canvasY - The target Y-coordinate on the canvas (top-left of character).
   * @param {Array<number>} fgColorRgba - Foreground color as [r, g, b, a].
   * @param {Array<number>} bgColorRgba - Background color as [r, g, b, a].
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
      console.warn("tdfRenderer: context.createImageData failed. Cannot draw CP437 char.", e);
      return;
    }

    const data = imageData.data;
    const code = charCode & 0xff; // Ensure charCode is within 0-255 range.
    const bitmap = cp437FontData[code]; // Get pixel data from preloaded CP437 font.

    if (!bitmap || bitmap.length < CharHeight) {
      // If character bitmap is undefined or incomplete, fill the cell with background color.
      // Use transparent black if the provided background color is itself transparent.
      const fillColor = bgColorRgba[3] > 0 ? bgColorRgba : [0, 0, 0, 0];
      _fillImageData(imageData, fillColor);
    } else {
      // Render the character using its bitmap data.
      for (let row = 0; row < CharHeight; row++) {
        const rowBits = bitmap[row] || 0x00; // Default to an empty row if bitmap data is sparse.
        for (let col = 0; col < CharWidth; col++) {
          const offset = (row * CharWidth + col) * 4; // Calculate pixel offset in ImageData.
          const isForegroundPixel = (rowBits >> (7 - col)) & 1; // Check if current pixel is foreground.
          const [r, g, b, a] = isForegroundPixel ? fgColorRgba : bgColorRgba;

          data[offset] = r;
          data[offset + 1] = g;
          data[offset + 2] = b;
          data[offset + 3] = a;
        }
      }
    }
    // Place the rendered character onto the canvas. Floor coordinates for pixel-perfect drawing.
    context.putImageData(imageData, Math.floor(canvasX), Math.floor(canvasY));
  }

  // --- Utilities: TDF Glyph Parsing & Metrics (for Bundle v4.0) ---

  /**
   * Parses and caches detailed information for a specific font from the bundle.
   * This includes its pair palette, spacing, glyph count, and table offsets.
   * @param {number} fontDataOffsetInPool - The font's data block offset relative to the start of the Font Data Pool.
   * @returns {object | null} An object containing font details, or null if parsing fails.
   */
  function _getOrParseFontDetails(fontDataOffsetInPool) {
    if (_parsedFontDetailsCache.has(fontDataOffsetInPool)) {
      return _parsedFontDetailsCache.get(fontDataOffsetInPool);
    }

    const fontBaseAbsOffset = _fontDataPoolOffset + fontDataOffsetInPool;
    let currentParseOffset = fontBaseAbsOffset;
    const details = {};

    try {
      // 1. Font Spacing (Uint8)
      if (currentParseOffset + 1 > _bundleView.byteLength) throw new Error("EOF reading font spacing.");
      details.spacing = _bundleView.getUint8(currentParseOffset);
      currentParseOffset += 1;

      // 2. Number of (Character, Attribute) Pairs in local palette (Uint8)
      if (currentParseOffset + 1 > _bundleView.byteLength) throw new Error("EOF reading nPairs.");
      const nPairs = _bundleView.getUint8(currentParseOffset);
      details.nPairs = nPairs;
      currentParseOffset += 1;

      // 3. Pair Palette Data (nPairs * 2 bytes)
      details.pairPalette = []; // Stores {char: number, attr: number} objects
      const pairPaletteDataSize = nPairs * 2;
      if (currentParseOffset + pairPaletteDataSize > _bundleView.byteLength)
        throw new Error("EOF reading pairPalette data.");
      for (let i = 0; i < nPairs; i++) {
        const charByte = _bundleView.getUint8(currentParseOffset++);
        const attrByte = _bundleView.getUint8(currentParseOffset++);
        details.pairPalette.push({ char: charByte, attr: attrByte });
      }

      // 4. Glyph Count (Uint8)
      if (currentParseOffset + 1 > _bundleView.byteLength) throw new Error("EOF reading glyphCount.");
      details.glyphCount = _bundleView.getUint8(currentParseOffset);
      currentParseOffset += 1;

      // 5. Glyph Lookup Table (GLT) starts at the current offset.
      details.gltAbsOffset = currentParseOffset;

      // 6. Glyph Data Table (GDT) starts immediately after the GLT.
      const gltSize = details.glyphCount * 3; // Each GLT entry is 3 bytes.
      details.gdtBaseAbsOffset = details.gltAbsOffset + gltSize;

      // Basic validation: GDT base offset should be within bundle bounds if glyphs exist.
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
      return null;
    }
  }

  /**
   * Finds a glyph's data offset within its font's Glyph Data Table (GDT)
   * using a binary search on the Glyph Lookup Table (GLT).
   * @param {number} gltAbsOffset - Absolute start offset of the GLT in _bundleView.
   * @param {number} glyphCount - Number of entries in the GLT.
   * @param {number} charCode - The ASCII character code to search for.
   * @returns {number} The glyph's data offset relative to its GDT base, or -1 if not found.
   */
  function _findGlyphOffsetInLookupTable(gltAbsOffset, glyphCount, charCode) {
    let low = 0;
    let high = glyphCount - 1;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const entryAbsOffset = gltAbsOffset + mid * 3; // Each GLT entry is 3 bytes.

      // Safety check: ensure the GLT entry being accessed is within bundle bounds.
      if (entryAbsOffset + 3 > _bundleView.byteLength) {
        console.warn(`tdfRenderer: GLT entry search for charCode ${charCode} went out of bounds.`);
        return -1; // Should not happen with valid GLT and glyphCount.
      }

      const entryCharCode = _bundleView.getUint8(entryAbsOffset);
      if (entryCharCode === charCode) {
        return _bundleView.getUint16(entryAbsOffset + 1, true); // Found: return 2-byte relative offset (Little Endian).
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
   * Decodes an RLE (Run-Length Encoded) stream of pair palette indices.
   * @param {number} rleStreamAbsOffset - Absolute offset in _bundleView where the RLE stream begins.
   * @param {number} expectedNumCells - The total number of cells (width * height) expected to be decoded.
   * @returns {Array<number> | null} An array of pair palette indices, or null if a critical error occurs.
   */
  function _decodeRLEStreamToPairIndices(rleStreamAbsOffset, expectedNumCells) {
    const decodedIndices = [];
    let currentOffset = rleStreamAbsOffset;
    let cellsDecoded = 0;

    while (cellsDecoded < expectedNumCells) {
      if (currentOffset >= _bundleView.byteLength) {
        console.warn("tdfRenderer: RLE stream ended prematurely before all cells were decoded.");
        break; // Break and handle potential mismatch below.
      }
      const byteValue = _bundleView.getUint8(currentOffset++);

      if (byteValue === RLE_ESCAPE_BYTE) {
        // RLE sequence follows.
        if (currentOffset + 2 > _bundleView.byteLength) {
          // Need 2 more bytes for run_length_byte & index_to_repeat.
          console.warn("tdfRenderer: RLE stream ended prematurely during an escape sequence.");
          break;
        }
        const runLengthByte = _bundleView.getUint8(currentOffset++);
        const indexToRepeat = _bundleView.getUint8(currentOffset++);
        const actualRunLength = runLengthByte + RLE_MIN_RUN_LENGTH;

        for (let k = 0; k < actualRunLength; k++) {
          if (cellsDecoded + k < expectedNumCells) {
            // Ensure we don't write past the expected number of cells.
            decodedIndices.push(indexToRepeat);
          } else {
            // This indicates the RLE run would overflow the expected cell count.
            console.warn("tdfRenderer: RLE run exceeds expected cell count. Truncating run.");
            break; // Stop this run.
          }
        }
        cellsDecoded += actualRunLength;
      } else {
        // Literal pair palette index.
        decodedIndices.push(byteValue);
        cellsDecoded++;
      }
    }

    // If the number of decoded cells doesn't match, adjust for robustness.
    if (decodedIndices.length !== expectedNumCells) {
      console.warn(
        `tdfRenderer: RLE decoded cells count (${decodedIndices.length}) does not match expected count (${expectedNumCells}). Stream may be corrupt or have an issue. Adjusting to expected length.`,
      );
      // Create an array of the correct size, filling with decoded data or padding.
      const result = new Array(expectedNumCells);
      for (let i = 0; i < expectedNumCells; ++i) {
        result[i] = decodedIndices[i] !== undefined ? decodedIndices[i] : 0; // Pad with index 0 (first pair) if too short.
      }
      return result;
    }
    return decodedIndices;
  }

  /**
   * Retrieves a glyph's declared width and actual height for layout calculations.
   * This does not parse the full cell stream.
   * @param {number} fontDataOffsetInPool - Offset of the font's data in the Font Data Pool.
   * @param {number} charCode - The ASCII character code of the glyph.
   * @returns {{width: number, height: number} | null} Object with `width` (in cells) and `height` (in lines), or null if not found or error.
   */
  function _getGlyphLayoutMetricsOnly(fontDataOffsetInPool, charCode) {
    const fontDetails = _getOrParseFontDetails(fontDataOffsetInPool);
    if (!fontDetails) return null;

    const { glyphCount, gltAbsOffset, gdtBaseAbsOffset } = fontDetails;
    if (glyphCount === 0) return null; // Font has no glyphs.

    const glyphDataRelOffset = _findGlyphOffsetInLookupTable(gltAbsOffset, glyphCount, charCode);
    if (glyphDataRelOffset === -1) return null; // Glyph not defined.

    const glyphSpecificDataAbsOffset = gdtBaseAbsOffset + glyphDataRelOffset;
    // Ensure width and height bytes are readable from the GDT.
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
   * Parses a TDF glyph's full data, including RLE decoding and mapping indices to (char, attr) pairs.
   * The returned array is flat: [width, height, char1, attr1, char2, attr2, ...].
   * @param {number} fontDataOffsetInPool - Offset of the font's data in the Font Data Pool.
   * @param {number} charCode - The ASCII character code of the glyph.
   * @returns {Array<number> | null} Parsed glyph data, or null on error.
   */
  function parseGlyphDataOnDemand(fontDataOffsetInPool, charCode) {
    const fontDetails = _getOrParseFontDetails(fontDataOffsetInPool);
    if (!fontDetails) {
      console.error(
        `tdfRenderer: Failed to get font details for font offset ${fontDataOffsetInPool} when parsing glyph.`,
      );
      return null;
    }

    const { glyphCount, gltAbsOffset, gdtBaseAbsOffset, pairPalette } = fontDetails;
    if (glyphCount === 0) return null; // Font contains no glyph definitions.

    const glyphDataRelOffset = _findGlyphOffsetInLookupTable(gltAbsOffset, glyphCount, charCode);
    if (glyphDataRelOffset === -1) return null; // Glyph for this charCode is not defined in this font.

    const glyphSpecificDataAbsOffset = gdtBaseAbsOffset + glyphDataRelOffset;

    try {
      // Read Width and Height for the glyph.
      if (glyphSpecificDataAbsOffset + 2 > _bundleView.byteLength) throw new Error("EOF reading glyph width/height.");
      const width = _bundleView.getUint8(glyphSpecificDataAbsOffset);
      const height = _bundleView.getUint8(glyphSpecificDataAbsOffset + 1);
      const rleStreamAbsOffset = glyphSpecificDataAbsOffset + 2; // RLE stream follows width & height.
      const expectedNumCells = width * height;

      if (expectedNumCells === 0) {
        // Glyph has no cells (e.g., width or height is 0). This is valid.
        return [width, height]; // Return dimensions with an empty cell stream.
      }

      const decodedIndices = _decodeRLEStreamToPairIndices(rleStreamAbsOffset, expectedNumCells);
      if (!decodedIndices) {
        throw new Error(`Failed to decode RLE stream for char ${charCode}.`);
      }

      // Map decoded pair palette indices back to [char, attr] pairs.
      const cellData = []; // Will store [char1, attr1, char2, attr2, ...]
      for (const index of decodedIndices) {
        if (index >= pairPalette.length) {
          // This indicates an invalid index, possibly due to corrupt data or an RLE decoding error.
          console.warn(
            `tdfRenderer: Invalid pair palette index ${index} (palette size ${pairPalette.length}) encountered for char ${charCode}. Using default cell (space, light grey/black).`,
          );
          cellData.push(0x20, 0x07); // Default to space, light grey on black, as a fallback.
          continue;
        }
        const pair = pairPalette[index];
        cellData.push(pair.char, pair.attr);
      }
      // Prepend width & height to the flat cell data stream.
      return [width, height, ...cellData];
    } catch (e) {
      console.error(
        `tdfRenderer: Error parsing full glyph data for char ${charCode} (font offset ${fontDataOffsetInPool}):`,
        e.message,
        e.stack, // Include stack for better debugging if available.
      );
      return null;
    }
  }

  // --- Utilities: Text Layout Calculation ---

  /**
   * Calculates layout metrics (pixel width, pixel height) for a single character.
   * @param {number} fontDataOffsetInPool - Offset of the font's data.
   * @param {string} char - The character to measure.
   * @param {number} minSpaceWidthChars - Minimum width for a space character, in character cell units.
   * @returns {{widthPx: number, heightPx: number, isDefined: boolean}} Layout metrics.
   */
  function _getCharLayoutMetrics(fontDataOffsetInPool, char, minSpaceWidthChars) {
    const charCode = char.charCodeAt(0);
    let widthPx = 0;
    let heightPx = CharHeight; // Default line height.
    let isDefined = false;
    const glyphMetrics = _getGlyphLayoutMetricsOnly(fontDataOffsetInPool, charCode);

    if (char === " ") {
      // For space, attempt to use its defined metrics if available and it has positive width.
      // Otherwise, fall back to the configurable minimum space width.
      const spaceMetrics = _getGlyphLayoutMetricsOnly(fontDataOffsetInPool, 32); // ASCII 32 for space.
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
   * @param {number} fontDataOffsetInPool - Offset of the font's data.
   * @param {number} fontSpacingChars - Inter-character spacing (in character cell units), obtained from font details.
   * @param {string} textLine - The line of text to measure.
   * @param {number} minSpaceWidthChars - Minimum width for space characters (in character cell units).
   * @returns {{width: number, height: number}} Calculated width and height of the line in pixels.
   */
  function _calculateSingleLineLayout(fontDataOffsetInPool, fontSpacingChars, textLine, minSpaceWidthChars) {
    if (!textLine) {
      return { width: 0, height: CharHeight }; // An empty line still occupies default character height.
    }

    let lineWidthPx = 0;
    let maxLineHeightPx = 0;
    let glyphsContributingToSpacing = 0; // Count of glyphs that affect inter-character spacing.

    for (let i = 0; i < textLine.length; i++) {
      const metrics = _getCharLayoutMetrics(fontDataOffsetInPool, textLine[i], minSpaceWidthChars);
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
   * @param {CanvasRenderingContext2D} context - The canvas rendering context.
   * @param {Array<number>} glyphCompactData - Parsed glyph data.
   * @param {number} baseX - Starting X coordinate on canvas for the top-left of this TDF glyph.
   * @param {number} baseY - Starting Y coordinate on canvas for the top-left of this TDF glyph.
   */
  function _renderTdfGlyphOnCanvas(context, glyphCompactData, baseX, baseY) {
    if (!glyphCompactData || glyphCompactData.length < 2) {
      console.warn("tdfRenderer: Attempted to render glyph with insufficient compact data (missing width/height).");
      return;
    }

    const glyphWidthChars = glyphCompactData[0];
    const glyphHeightLines = glyphCompactData[1];
    const expectedCells = glyphWidthChars * glyphHeightLines;

    // Cell data starts at index 2 of glyphCompactData. Each cell uses 2 array items (char, attr).
    if (glyphCompactData.length < 2 + expectedCells * 2 && expectedCells > 0) {
      console.warn(
        `tdfRenderer: Glyph compact data stream is shorter (${glyphCompactData.length - 2} items) than expected by width*height (${expectedCells * 2} items). Glyph rendering may be truncated.`,
      );
      // Proceed to render what's available, up to the shorter length.
    }

    for (let i = 0; i < expectedCells; i++) {
      const dataIndex = 2 + i * 2;
      // Ensure we don't read past the end of available cell data.
      if (dataIndex + 1 >= glyphCompactData.length) break;

      const charByte = glyphCompactData[dataIndex];
      const attrByte = glyphCompactData[dataIndex + 1];

      // Calculate cell's position within the glyph's own grid.
      const currentGlyphCellX = i % glyphWidthChars;
      const currentGlyphCellY = Math.floor(i / glyphWidthChars);

      // Calculate the absolute canvas position for this cell.
      const canvasX = baseX + currentGlyphCellX * CharWidth;
      const canvasY = baseY + currentGlyphCellY * CharHeight;

      // Decode color attribute byte.
      const bgIndex = (attrByte >> 4) & 0x07; // TDF uses 3 bits for Background (0-7).
      const fgIndex = attrByte & 0x0f; // TDF uses 4 bits for Foreground (0-15).

      // Get RGBA colors from pre-defined TdfColors palette.
      const bgColor = TdfColors[bgIndex] || TdfColors[0]; // Default to black if index is out of bounds.
      const fgColor = TdfColors[fgIndex] || TdfColors[7]; // Default to light grey if index is out of bounds.

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
    let currentX = lineStartX; // Current X position on the canvas for drawing.

    for (let i = 0; i < lineText.length; i++) {
      const char = lineText[i];
      const charCode = char.charCodeAt(0);
      let glyphRenderWidthPx = 0; // Pixel width of the current character's glyph.
      let glyphCompactData = null;

      // Fetch glyph data unless it's a space (which might be handled differently).
      glyphCompactData = char === " " ? null : parseGlyphDataOnDemand(fontDataOffsetInPool, charCode);

      if (char === " ") {
        const spaceMetrics = _getGlyphLayoutMetricsOnly(fontDataOffsetInPool, 32); // ASCII 32 for space.
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
          const fontDetails = _getOrParseFontDetails(fontDataOffsetInPool);
          // Determine a suitable background color. Use the background of the first color pair
          // in the font's palette as a heuristic, or default to black.
          const defaultBgColor =
            fontDetails && fontDetails.pairPalette.length > 0
              ? TdfColors[(fontDetails.pairPalette[0].attr >> 4) & 0x07]
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
    fontDataOffsetInPool,
    fontSpacingChars,
    minSpaceWidthChars,
  ) {
    // Calculate the natural layout of this specific line.
    const lineLayout = _calculateSingleLineLayout(fontDataOffsetInPool, fontSpacingChars, lineText, minSpaceWidthChars);
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
      fontDataOffsetInPool,
      fontSpacingChars,
      minSpaceWidthChars,
    );
    // Return the calculated height of this line, used by the caller to advance the Y position.
    return currentLineHeightPx;
  }

  // --- Utilities: Bundle Parsing ---

  const BundleHeaderSize = 21; // Magic(4) + Ver(1) + FontCount(4) + IndexOffset(4) + StringOffset(4) + DataOffset(4)
  const FontIndexEntrySize = 8; // KeyOffset(4) + DataOffset(4)

  /**
   * Parses and validates the TDF Bundle header.
   * @param {DataView} bundleView - DataView of the bundle.
   * @returns {object} An object containing { version, fontCount, indexTableOffset, stringPoolOffset, fontDataPoolOffset }.
   * @throws {Error} If the header is invalid or bundle version is unsupported.
   */
  function _parseBundleHeader(bundleView) {
    if (bundleView.byteLength < BundleHeaderSize) {
      throw new Error("tdfRenderer: Bundle is too small to contain a valid header.");
    }

    // Read and verify Magic String.
    const magicBytes = new Uint8Array(bundleView.buffer, bundleView.byteOffset, 4);
    const magic = new TextDecoder().decode(magicBytes); // Assumes UTF-8 for "TDFB".
    if (magic !== "TDFB") {
      throw new Error(`tdfRenderer: Invalid magic string. Expected "TDFB", got "${magic}".`);
    }

    // Read and verify Bundle Version.
    const version = bundleView.getUint8(4);
    if (version !== EXPECTED_BUNDLE_FORMAT_VERSION) {
      throw new Error(
        `tdfRenderer: Unsupported bundle version: ${version}. This renderer expects version ${EXPECTED_BUNDLE_FORMAT_VERSION}.`,
      );
    }

    // Read structural offsets and counts.
    const fontCount = bundleView.getUint32(5, true); // True for Little Endian.
    const indexTableOffset = bundleView.getUint32(9, true);
    const stringPoolOffset = bundleView.getUint32(13, true);
    const fontDataPoolOffset = bundleView.getUint32(17, true);

    // Basic validation of offsets to ensure they are within the bundle's bounds.
    const maxIndexTableEnd = indexTableOffset + fontCount * FontIndexEntrySize;
    if (
      indexTableOffset >= bundleView.byteLength ||
      stringPoolOffset >= bundleView.byteLength ||
      fontDataPoolOffset >= bundleView.byteLength ||
      maxIndexTableEnd > bundleView.byteLength // Index table itself shouldn't extend beyond buffer.
    ) {
      throw new Error("tdfRenderer: Invalid offsets in bundle header (they point outside the bundle).");
    }

    return { version, fontCount, indexTableOffset, stringPoolOffset, fontDataPoolOffset };
  }

  /**
   * Parses the Font Index Table from the bundle, creating a map of font keys to their data offsets.
   * @param {DataView} bundleView - DataView of the bundle.
   * @param {object} headerInfo - Parsed header information containing offsets and counts.
   * @returns {Map<string, number>} A Map where keys are font uniqueKeys (strings) and values are
   * their data offsets relative to the start of the Font Data Pool.
   */
  function _parseFontIndex(bundleView, headerInfo) {
    const { fontCount, indexTableOffset, stringPoolOffset } = headerInfo;
    const newFontIndex = new Map();

    for (let i = 0; i < fontCount; i++) {
      const entryAbsOffset = indexTableOffset + i * FontIndexEntrySize;

      // Ensure the current index entry itself is readable.
      if (entryAbsOffset + FontIndexEntrySize > bundleView.byteLength) {
        console.warn(`tdfRenderer: Font index entry ${i} is out of bundle bounds. Skipping.`);
        continue;
      }

      const keyStrRelOffset = bundleView.getUint32(entryAbsOffset, true);
      const fontDataRelOffset = bundleView.getUint32(entryAbsOffset + 4, true);

      // Ensure the string key pointed to is within the string pool bounds.
      if (stringPoolOffset + keyStrRelOffset >= bundleView.byteLength) {
        console.warn(`tdfRenderer: String pool offset for key in index entry ${i} is out of bounds. Skipping.`);
        continue;
      }

      const key = readNullTerminatedString(bundleView, stringPoolOffset + keyStrRelOffset);
      if (key) {
        newFontIndex.set(key, fontDataRelOffset); // Store offset relative to font data pool start.
      } else {
        // This might happen if a string is empty or reading failed.
        console.warn(`tdfRenderer: Encountered an empty or unreadable font key at index ${i} in bundle.`);
      }
    }
    return newFontIndex;
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

    _bundleBuffer = await fetchBinary(bundleUrl); // May throw if fetch fails.
    _bundleView = new DataView(_bundleBuffer);
    _parsedFontDetailsCache.clear(); // Clear cache from any previous or failed initialization.

    const headerInfo = _parseBundleHeader(_bundleView); // May throw if header is invalid.
    _actualBundleFormatVersion = headerInfo.version; // Store the validated version.
    _stringPoolOffset = headerInfo.stringPoolOffset;
    _fontDataPoolOffset = headerInfo.fontDataPoolOffset;

    _fontIndex = _parseFontIndex(_bundleView, headerInfo);

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

    const fontDataOffsetInPool = _fontIndex.get(uniqueFontKey);
    if (typeof fontDataOffsetInPool === "undefined") {
      console.error(`tdfRenderer.calculateLayout: Font key "${uniqueFontKey}" not found.`);
      return null;
    }

    // Retrieve font-specific details, including character spacing, required for accurate layout.
    const fontDetails = _getOrParseFontDetails(fontDataOffsetInPool);
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
      const lineLayout = _calculateSingleLineLayout(fontDataOffsetInPool, fontSpacingChars, line, minSpaceWidthChars);
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
      .filter(([/*uniqueFontKey*/ , fontDataOffsetInPool]) =>
        requiredChars.every((char) => _getGlyphLayoutMetricsOnly(fontDataOffsetInPool, char.charCodeAt(0)) !== null),
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
    const fontDataOffsetInPool = _fontIndex.get(uniqueFontKey);
    if (typeof fontDataOffsetInPool === "undefined") {
      throw new Error(`tdfRenderer.render: Font key "${uniqueFontKey}" not found.`);
    }

    // Fetch font-specific details, including character spacing.
    const fontDetails = _getOrParseFontDetails(fontDataOffsetInPool);
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
          fontDataOffsetInPool,
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
