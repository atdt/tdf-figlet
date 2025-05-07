// tdfRenderer.js v1.10 (Optimized layout metrics lookup)
// TheDraw Font (.TDF) text rendering library for HTML Canvas
// Uses preprocessed BINARY font bundle.
// Copyright (C) 2012-2025 Ori Livneh & Contributors
// Licensed under the MIT and GPL licenses

(function (global) {
    "use strict";

    // --- Constants ---

    const CHAR_WIDTH = 8;  // Standard width of a CP437 character cell in pixels.
    const CHAR_HEIGHT = 16; // Standard height of a CP437 character cell in pixels.

    const DEFAULT_MIN_SPACE_WIDTH = 3; // Default minimum width for a space character (in char units) if not defined in font.

    const BIN_NEWLINE_CODE = 0x0D;       // Byte code for newline in the TDF glyph stream.
    const BIN_GLYPH_TERMINATOR = 0x00;   // Byte code that terminates a TDF glyph stream.
    const NEWLINE_CODE = -1;             // Internal representation for a newline within a parsed glyph's compact data.

    // Standard CGA/EGA/VGA 16-color palette (RGBA format).
    const TDF_COLORS = [
        [  0,   0,   0, 255], [  0,   0, 170, 255], [  0, 170,   0, 255], [  0, 170, 170, 255],
        [170,   0,   0, 255], [170,   0, 170, 255], [170,  85,   0, 255], [170, 170, 170, 255],
        [ 85,  85,  85, 255], [ 85,  85, 255, 255], [ 85, 255,  85, 255], [ 85, 255, 255, 255],
        [255,  85,  85, 255], [255,  85, 255, 255], [255, 255,  85, 255], [255, 255, 255, 255]
    ];

    // List of characters supported by TDF glyph definitions (ASCII 33-126).
    // Used by filterFontsByText to check for TDF-renderable characters.
    const SUPPORTED_CHAR_LIST = "!\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";


    // --- CP437 Font Data ---

    /**
     * Attempts to load standard CP437 font data from a global variable `globalThis.cp437font`.
     * This data is expected to be an array of 256 bitmaps, where each bitmap is an array of 16 numbers.
     * @returns {Array<Array<number>>} The CP437 font data or a dummy array if not found.
     */
    function getCp437FontData() {
        if (typeof globalThis !== 'undefined' && Array.isArray(globalThis.cp437font) && globalThis.cp437font.length >= 256) {
            return globalThis.cp437font;
        } else {
            console.error("tdfRenderer Error: globalThis.cp437font not found or invalid. CP437 rendering will fail.");
            return Array(256).fill([]); // Return a dummy array to prevent downstream errors.
        }
    }
    const cp437FontData = getCp437FontData(); // Load CP437 font data immediately at script load.


    // --- Internal State ---

    let _bundleBuffer = null;      // ArrayBuffer holding the loaded TDF font bundle.
    let _bundleView = null;        // DataView for accessing the _bundleBuffer.
    let _fontIndex = new Map();    // Maps font unique keys (string) to their data offset (number) in the _fontDataPool.
    let _stringPoolOffset = 0;     // Starting offset of the string pool in the bundle.
    let _fontDataPoolOffset = 0;   // Starting offset of the font data pool in the bundle.
    let _isInitialized = false;    // Flag indicating if the renderer has been initialized with a bundle.


    // --- Utilities ---

    /**
     * Fetches binary data from a given URL.
     * @param {string} url - The URL to fetch the binary data from.
     * @returns {Promise<ArrayBuffer>} A promise that resolves with the ArrayBuffer.
     * @throws {Error} If the fetch request fails or the response is not ok.
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
            throw error; // Re-throw to allow caller to handle.
        }
    }

    /**
     * Draws a single CP437 character onto a canvas context.
     * @param {CanvasRenderingContext2D} context - The 2D rendering context of the canvas.
     * @param {number} charCode - The CP437 character code (0-255).
     * @param {number} canvasX - The x-coordinate on the canvas to draw the character.
     * @param {number} canvasY - The y-coordinate on the canvas to draw the character.
     * @param {Array<number>} fgColorRgba - The foreground color as an RGBA array [r, g, b, a].
     * @param {Array<number>} bgColorRgba - The background color as an RGBA array [r, g, b, a].
     */
    function drawCp437Char(context, charCode, canvasX, canvasY, fgColorRgba, bgColorRgba) {
        if (typeof context.createImageData !== 'function') {
            // Environment does not support createImageData (e.g., Node.js without a canvas library)
            return;
        }

        let imageData;
        try {
            imageData = context.createImageData(CHAR_WIDTH, CHAR_HEIGHT);
        } catch (e) {
            // Older browsers or environments might fail here.
            console.warn("tdfRenderer: context.createImageData failed.", e);
            return;
        }

        const data = imageData.data;
        const [fgR, fgG, fgB, fgA] = fgColorRgba;
        const [bgR, bgG, bgB, bgA] = bgColorRgba;

        const code = charCode & 0xFF; // Ensure it's within 0-255 range.
        const bitmap = cp437FontData[code];

        if (!bitmap || bitmap.length < CHAR_HEIGHT) {
            // Undefined or invalid character bitmap: fill with background color.
            if (bgColorRgba[3] > 0) { // Only fill if background is not fully transparent.
                for (let i = 0; i < data.length; i += 4) {
                    data[i]     = bgR;
                    data[i + 1] = bgG;
                    data[i + 2] = bgB;
                    data[i + 3] = bgA;
                }
            } else {
                // If background is transparent, ensure all pixels are transparent.
                for (let i = 3; i < data.length; i += 4) {
                    data[i] = 0; // Set alpha to 0.
                }
            }
        } else {
            // Valid character bitmap: render pixels.
            for (let row = 0; row < CHAR_HEIGHT; row++) {
                const rowBits = bitmap[row] || 0x00; // Default to empty row if bitmap is short.
                for (let col = 0; col < CHAR_WIDTH; col++) {
                    const offset = (row * CHAR_WIDTH + col) * 4;
                    const isForeground = (rowBits >> (7 - col)) & 1;
                    const colorToUse = isForeground ? fgColorRgba : bgColorRgba;

                    data[offset]     = colorToUse[0];
                    data[offset + 1] = colorToUse[1];
                    data[offset + 2] = colorToUse[2];
                    data[offset + 3] = colorToUse[3];
                }
            }
        }
        context.putImageData(imageData, Math.floor(canvasX), Math.floor(canvasY));
    }

    /**
     * Reads a null-terminated UTF-8 string from a DataView.
     * @param {DataView} dataView - The DataView to read from.
     * @param {number} startOffset - The offset where the string begins.
     * @returns {string} The decoded string, or an empty string if unable to decode.
     */
    function readNullTerminatedString(dataView, startOffset) {
        let endOffset = startOffset;
        while (endOffset < dataView.byteLength && dataView.getUint8(endOffset) !== 0) {
            endOffset++;
        }

        if (endOffset === startOffset) {
            return ""; // Empty string if null terminator is at the start or offset is at end.
        }

        const stringBytes = new Uint8Array(dataView.buffer, dataView.byteOffset + startOffset, endOffset - startOffset);

        try {
            return new TextDecoder().decode(stringBytes); // Modern approach.
        } catch (e) {
            // Fallback for environments without TextDecoder or for specific error cases.
            try {
                // This fallback can be slow for very long strings and might not handle all UTF-8 correctly.
                return String.fromCharCode.apply(null, stringBytes);
            } catch (decodeError) {
                console.warn("tdfRenderer: Failed to decode string with TextDecoder and String.fromCharCode:", decodeError);
                return ""; // Final fallback.
            }
        }
    }

    /**
     * Performs a binary search within a font's Glyph Lookup Table (GLT) to find a character's data offset.
     * The GLT maps character codes to their relative offsets within the glyph data table.
     * Each entry in GLT is 3 bytes: [Char Code (1 byte), Relative Data Offset (2 bytes, little-endian)].
     * @param {number} lookupTableOffset - The starting offset of the GLT in the _bundleView.
     * @param {number} glyphCount - The number of glyphs in this font, hence entries in the GLT.
     * @param {number} charCode - The character code to search for.
     * @returns {number} The relative offset of the glyph's data if found, otherwise -1.
     */
    function _findGlyphDataRelativeOffsetInTable(lookupTableOffset, glyphCount, charCode) {
        if (!_bundleView) return -1;

        let low = 0;
        let high = glyphCount - 1;

        while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            const entryOffset = lookupTableOffset + mid * 3; // Each entry is 3 bytes.

            // Bounds check for safety, though logically covered by glyphCount if bundle is well-formed.
            if (entryOffset + 3 > _bundleView.byteLength) return -1;

            const entryCharCode = _bundleView.getUint8(entryOffset);

            if (entryCharCode === charCode) {
                return _bundleView.getUint16(entryOffset + 1, true); // Found: return 2-byte offset (little-endian).
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
     * Parses the raw byte stream for a single TDF glyph into a compact array representation.
     * The compact data consists of [Char Code, Attribute Byte] pairs, or NEWLINE_CODE for newlines.
     * @param {number} glyphStreamStartOffset - The offset where the glyph's byte stream begins.
     * @returns {Array<number>} An array representing the glyph's drawing instructions.
     */
    function _parseGlyphByteStream(glyphStreamStartOffset) {
        if (!_bundleView) return [];

        const compactData = [];
        let currentReadOffset = glyphStreamStartOffset;
        let byteValue = 0;

        while (currentReadOffset < _bundleView.byteLength) {
            byteValue = _bundleView.getUint8(currentReadOffset++);
            if (byteValue === BIN_GLYPH_TERMINATOR) {
                break; // End of glyph stream.
            }

            if (byteValue === BIN_NEWLINE_CODE) {
                compactData.push(NEWLINE_CODE);
            } else {
                const charCodeByte = byteValue;
                if (currentReadOffset >= _bundleView.byteLength) {
                    // Premature end of stream after reading char code, before attribute.
                    console.warn("tdfRenderer: Glyph stream ended prematurely.");
                    break;
                }
                const attrByte = _bundleView.getUint8(currentReadOffset++);
                compactData.push(charCodeByte, attrByte);
            }
        }
        return compactData;
    }

    /**
     * Locates the start of a specific glyph's metadata (width, height, stream offset) within the font data.
     * This is a common precursor to getting either layout metrics or full parse data.
     * @param {number} fontDataPoolBaseOffset - Starting offset of the font data pool.
     * @param {number} fontDataOffsetInPool - Offset of the specific font's data within the pool.
     * @param {number} charCode - The character code of the glyph to locate.
     * @returns {number | null} The absolute offset to the glyph's width/height/stream data, or null if not found/error.
     */
    function _locateGlyphEntry(fontDataPoolBaseOffset, fontDataOffsetInPool, charCode) {
        if (!_bundleView) return null;

        const baseFontDataOffset = fontDataPoolBaseOffset + fontDataOffsetInPool;

        // Font Data Header: [Spacing (1 byte), Glyph Count (1 byte), GLT (...), Glyph Data Table (...)]
        // Ensure there's enough space for Spacing and Glyph Count.
        if (baseFontDataOffset + 2 > _bundleView.byteLength) return null;

        const glyphCount = _bundleView.getUint8(baseFontDataOffset + 1);
        if (glyphCount === 0) return null; // No glyphs defined for this font.

        const lookupTableOffset = baseFontDataOffset + 2; // GLT starts after Spacing and Glyph Count.
        const glyphDataTableBaseOffset = lookupTableOffset + glyphCount * 3; // Glyph Data Table starts after GLT.

        const glyphDataRelativeOffset = _findGlyphDataRelativeOffsetInTable(lookupTableOffset, glyphCount, charCode);
        if (glyphDataRelativeOffset === -1) {
            return null; // Glyph not defined in this font.
        }

        const absoluteGlyphDataOffset = glyphDataTableBaseOffset + glyphDataRelativeOffset;

        // Check if the calculated offset is within bounds for reading at least width and height.
        if (absoluteGlyphDataOffset + 2 > _bundleView.byteLength) {
            // console.error(`tdfRenderer: Glyph data offset out of bounds for char ${charCode}.`);
            return null;
        }
        return absoluteGlyphDataOffset;
    }


    /**
     * Gets precalculated glyph width and height WITHOUT parsing the full data stream.
     * Used primarily for layout calculations.
     * @param {number} fontDataPoolBaseOffset - Starting offset of the font data pool.
     * @param {number} fontDataOffsetInPool - Offset of the specific font's data within the pool.
     * @param {number} charCode - The character code of the glyph.
     * @returns {{width: number, height: number} | null} Object with width (in char cells) and height (in lines), or null if not found.
     */
    function _getGlyphLayoutMetricsOnly(fontDataPoolBaseOffset, fontDataOffsetInPool, charCode) {
        const glyphDataStartOffset = _locateGlyphEntry(fontDataPoolBaseOffset, fontDataOffsetInPool, charCode);
        if (glyphDataStartOffset === null) {
            return null;
        }

        try {
            const width = _bundleView.getUint8(glyphDataStartOffset);       // Precalculated Width
            const height = _bundleView.getUint8(glyphDataStartOffset + 1); // Precalculated Height (in lines)
            return { width: width, height: height };
        } catch (e) {
            // This catch is for unexpected errors reading from _bundleView,
            // as bounds are already checked by _locateGlyphEntry.
            // console.error(`tdfRenderer: Layout metrics lookup error char ${charCode} at offset ${glyphDataStartOffset}:`, e);
            return null;
        }
    }

    /**
     * Parses a TDF glyph's width, height, and its character/attribute stream on demand.
     * Used for actual rendering of the glyph.
     * @param {number} fontDataPoolBaseOffset - Starting offset of the font data pool.
     * @param {number} fontDataOffsetInPool - Offset of the specific font's data within the pool.
     * @param {number} charCode - The character code of the glyph.
     * @returns {Array<number> | null} An array: [width, height_lines, ...streamData], or null if not found/error.
     */
    function parseGlyphDataOnDemand(fontDataPoolBaseOffset, fontDataOffsetInPool, charCode) {
        const glyphDataStartOffset = _locateGlyphEntry(fontDataPoolBaseOffset, fontDataOffsetInPool, charCode);
        if (glyphDataStartOffset === null) {
            return null;
        }

        try {
            const width = _bundleView.getUint8(glyphDataStartOffset);
            const height = _bundleView.getUint8(glyphDataStartOffset + 1);
            const streamStartOffset = glyphDataStartOffset + 2; // Stream data follows width and height.

            const streamData = _parseGlyphByteStream(streamStartOffset);
            return [width, height, ...streamData];
        } catch (e) {
            console.error(`tdfRenderer: Glyph parse error for char ${charCode} at offset ${glyphDataStartOffset}:`, e);
            return null;
        }
    }

    /**
     * Calculates layout metrics (pixel width, pixel height) for a single character.
     * Uses the lightweight `_getGlyphLayoutMetricsOnly` for efficiency.
     * @param {number} fontDataOffsetInPool - Offset of the font's data within the font data pool.
     * @param {string} char - The character to measure.
     * @param {number} minSpaceWidthChars - Minimum width for a space character, in character units.
     * @returns {{widthPx: number, heightPx: number, isDefined: boolean}} Layout metrics.
     */
    function _getCharLayoutMetrics(fontDataOffsetInPool, char, minSpaceWidthChars) {
        let charWidthPx = 0;
        let charHeightPx = CHAR_HEIGHT; // Default canvas cell height.
        let isDefined = false;
        const charCode = char.charCodeAt(0);

        let glyphMetrics = null; // Holds { width, height } from TDF font.

        if (char === ' ') {
            // Space character (ASCII 32).
            glyphMetrics = _getGlyphLayoutMetricsOnly(_fontDataPoolOffset, fontDataOffsetInPool, 32);
            if (glyphMetrics) {
                charWidthPx = glyphMetrics.width * CHAR_WIDTH;
                charHeightPx = Math.max(1, glyphMetrics.height) * CHAR_HEIGHT; // Ensure min 1 line height.
            } else {
                // Space glyph not defined in TDF, use minimum specified width.
                charWidthPx = minSpaceWidthChars * CHAR_WIDTH;
                // Height remains default CHAR_HEIGHT for undefined space.
            }
            isDefined = true; // Treat space as always defined for layout purposes.
        } else {
            // Non-space character.
            glyphMetrics = _getGlyphLayoutMetricsOnly(_fontDataPoolOffset, fontDataOffsetInPool, charCode);
            if (glyphMetrics) {
                charWidthPx = glyphMetrics.width * CHAR_WIDTH;
                charHeightPx = Math.max(1, glyphMetrics.height) * CHAR_HEIGHT;
                isDefined = true;
            }
            // Else: Undefined non-space char results in widthPx = 0, heightPx = CHAR_HEIGHT, isDefined = false.
        }

        return { widthPx: charWidthPx, heightPx: charHeightPx, isDefined: isDefined };
    }

    /**
     * Calculates total pixel width and maximum pixel height for a single line of text.
     * @param {number} fontDataOffsetInPool - Offset of the font's data within the font data pool.
     * @param {number} fontSpacingChars - Spacing between characters, in character units.
     * @param {string} textLine - The line of text to measure.
     * @param {number} minSpaceWidthChars - Minimum width for space characters.
     * @returns {{width: number, height: number}} The calculated width and height in pixels.
     */
    function _calculateSingleLineLayout(fontDataOffsetInPool, fontSpacingChars, textLine, minSpaceWidthChars) {
        if (!textLine) {
            return { width: 0, height: CHAR_HEIGHT }; // Empty line has no width, default height.
        }

        let lineWidthPx = 0;
        let maxLineHeightPx = 0;
        let glyphCountOnLine = 0; // Number of glyphs that contribute to width (chars or defined spaces).

        for (let i = 0; i < textLine.length; i++) {
            const metrics = _getCharLayoutMetrics(fontDataOffsetInPool, textLine[i], minSpaceWidthChars);
            lineWidthPx += metrics.widthPx;
            maxLineHeightPx = Math.max(maxLineHeightPx, metrics.heightPx);

            if (metrics.widthPx > 0 || textLine[i] === ' ') {
                // Count characters or spaces that occupy horizontal space.
                glyphCountOnLine++;
            }
        }

        if (glyphCountOnLine > 1) {
            lineWidthPx += (glyphCountOnLine - 1) * (fontSpacingChars * CHAR_WIDTH);
        }

        // Ensure minimum dimensions for the line.
        return {
            width: lineWidthPx > 0 ? lineWidthPx : CHAR_WIDTH,             // Min width of one char cell if content exists.
            height: maxLineHeightPx > 0 ? maxLineHeightPx : CHAR_HEIGHT  // Min height of one char cell.
        };
    }

    /**
     * Renders a single TDF glyph (which can be multi-character/multi-line) onto the canvas.
     * @param {CanvasRenderingContext2D} context - The canvas rendering context.
     * @param {Array<number>} glyphCompactData - The parsed glyph data: [width, height, ...stream].
     * @param {number} baseX - The starting X position on the canvas for this TDF glyph.
     * @param {number} baseY - The starting Y position on the canvas for this TDF glyph.
     */
    function _renderTdfGlyphOnCanvas(context, glyphCompactData, baseX, baseY) {
        // glyphCompactData = [glyphWidthChars, glyphHeightLines, char1, attr1, char2, attr2, NEWLINE_CODE, char3, attr3, ...]
        // We only need the stream part (from index 2 onwards) for rendering.
        if (!glyphCompactData || glyphCompactData.length <= 2) {
            return; // No stream data to render.
        }

        let currentGlyphX = 0; // X offset within the TDF glyph, in character cells.
        let currentGlyphY = 0; // Y offset within the TDF glyph, in lines.

        for (let k = 2; k < glyphCompactData.length; k++) {
            const item = glyphCompactData[k];

            if (item === NEWLINE_CODE) {
                currentGlyphY++;
                currentGlyphX = 0;
            } else {
                const cp437CharCode = item;
                k++; // Move to attribute byte.
                if (k >= glyphCompactData.length) break; // Should not happen with well-formed data.
                const attrByte = glyphCompactData[k];

                const canvasX = baseX + currentGlyphX * CHAR_WIDTH;
                const canvasY = baseY + currentGlyphY * CHAR_HEIGHT;

                const bgIndex = (attrByte >> 4) & 0x07; // TDF uses 3 bits for bg index (0-7).
                const fgIndex = attrByte & 0x0F;       // TDF uses 4 bits for fg index (0-15).

                const bgColorRgba = TDF_COLORS[bgIndex] || TDF_COLORS[0]; // Default to black on invalid index.
                const fgColorRgba = TDF_COLORS[fgIndex] || TDF_COLORS[7]; // Default to light grey on invalid index.

                drawCp437Char(context, cp437CharCode, canvasX, canvasY, fgColorRgba, bgColorRgba);
                currentGlyphX++;
            }
        }
    }

    /**
     * Renders a single line of text onto the canvas.
     * @param {CanvasRenderingContext2D} context - The canvas rendering context.
     * @param {string} lineText - The text for the current line.
     * @param {number} lineBaseY - The Y coordinate on the canvas for the top of this line.
     * @param {number} lineStartX - The X coordinate on the canvas where this line's rendering should begin.
     * @param {number} fontDataOffsetInPool - Offset of the font's data.
     * @param {number} fontSpacingChars - Spacing between characters, in character units.
     * @param {number} minSpaceWidthChars - Minimum width for space characters.
     */
    function _renderLine(context, lineText, lineBaseY, lineStartX, fontDataOffsetInPool, fontSpacingChars, minSpaceWidthChars) {
        let currentX = lineStartX;

        for (let i = 0; i < lineText.length; i++) {
            const char = lineText[i];
            const charCode = char.charCodeAt(0);

            const glyphCompactData = parseGlyphDataOnDemand(_fontDataPoolOffset, fontDataOffsetInPool, charCode);
            let glyphRenderWidthPx = 0;

            if (char === ' ') {
                // For spaces, get width using lightweight metrics, similar to layout.
                const spaceMetrics = _getGlyphLayoutMetricsOnly(_fontDataPoolOffset, fontDataOffsetInPool, 32);
                glyphRenderWidthPx = (spaceMetrics)
                    ? spaceMetrics.width * CHAR_WIDTH
                    : minSpaceWidthChars * CHAR_WIDTH;
            } else if (glyphCompactData) {
                // For defined TDF glyphs, use width from the parsed data.
                glyphRenderWidthPx = glyphCompactData[0] * CHAR_WIDTH; // glyphCompactData[0] is width in char cells.
            }
            // If glyphCompactData is null (for non-space, undefined char), width remains 0.

            // Render the TDF glyph if it's defined and has content.
            if (glyphCompactData && glyphCompactData.length > 2) {
                _renderTdfGlyphOnCanvas(context, glyphCompactData, currentX, lineBaseY);
            }

            // Advance cursor X position.
            currentX += glyphRenderWidthPx;
            if (i < lineText.length - 1 && glyphRenderWidthPx > 0) {
                // Add inter-character spacing if the character had width and it's not the last char.
                currentX += fontSpacingChars * CHAR_WIDTH;
            }
        }
    }


    // --- Public API Object ---

    const tdfRenderer = {};

    /**
     * Initializes the renderer by fetching and parsing the TDF binary font bundle.
     * Must be called before any rendering or layout calculation.
     * @param {string} bundleUrl - URL of the preprocessed `tdf_bundle.bin` file.
     * @returns {Promise<string[]>} A promise resolving with a sorted array of available unique font keys.
     * @throws {Error} If initialization fails (e.g., bundle fetch error, invalid format).
     */
    tdfRenderer.init = async function(bundleUrl) {
        if (_isInitialized) {
            return tdfRenderer.getAvailableFonts(); // Already initialized, return existing keys.
        }

        _bundleBuffer = await fetchBinary(bundleUrl);
        _bundleView = new DataView(_bundleBuffer);

        // --- Validate Bundle Header (21 bytes total) ---
        // Magic (4 bytes: "TDFB")
        // Version (1 byte)
        // Font Count (4 bytes, little-endian)
        // Index Table Offset (4 bytes, little-endian)
        // String Pool Offset (4 bytes, little-endian)
        // Font Data Pool Offset (4 bytes, little-endian)
        const HEADER_SIZE = 21;
        if (_bundleBuffer.byteLength < HEADER_SIZE) {
            throw new Error("tdfRenderer: Binary bundle invalid - header too small.");
        }

        // Read Magic String "TDFB" (4 bytes)
        const magicBytes = new Uint8Array(_bundleView.buffer, _bundleView.byteOffset + 0, 4);
        const magic = new TextDecoder().decode(magicBytes);
        if (magic !== 'TDFB') {
            throw new Error(`tdfRenderer: Invalid magic string in bundle header. Expected "TDFB", got "${magic}".`);
        }

        const version = _bundleView.getUint8(4); // Offset 4: Version
        if (version !== 1) {
            throw new Error(`tdfRenderer: Unsupported bundle version: ${version}. Expected version 1.`);
        }

        const fontCount = _bundleView.getUint32(5, true);          // Offset 5: Font Count (little-endian)
        const indexTableOffset = _bundleView.getUint32(9, true);   // Offset 9: Index Table Offset (little-endian)
        _stringPoolOffset = _bundleView.getUint32(13, true); // Offset 13: String Pool Offset (little-endian)
        _fontDataPoolOffset = _bundleView.getUint32(17, true); // Offset 17: Font Data Pool Offset (little-endian)

        // Validate offsets are within bundle bounds.
        if (indexTableOffset >= _bundleBuffer.byteLength ||
            _stringPoolOffset >= _bundleBuffer.byteLength ||
            _fontDataPoolOffset >= _bundleBuffer.byteLength ||
            indexTableOffset + fontCount * 8 > _bundleBuffer.byteLength // Check full index table size
           ) {
            throw new Error("tdfRenderer: Invalid offsets in bundle header - they point outside the bundle.");
        }

        // --- Parse Font Index Table ---
        // Each entry: [Key String Offset (4 bytes, LE), Font Data Offset (4 bytes, LE)]
        _fontIndex = new Map();
        for (let i = 0; i < fontCount; i++) {
            const entryOffset = indexTableOffset + i * 8; // Each entry is 8 bytes.

            const keyStringRelativeOffset = _bundleView.getUint32(entryOffset, true);
            const fontDataRelativeOffset = _bundleView.getUint32(entryOffset + 4, true);

            const key = readNullTerminatedString(_bundleView, _stringPoolOffset + keyStringRelativeOffset);

            if (key) {
                // Store offset relative to _fontDataPoolOffset for consistency with how it's used later.
                _fontIndex.set(key, fontDataRelativeOffset);
            } else {
                console.warn(`tdfRenderer: Empty font key found at index ${i} in bundle.`);
            }
        }

        _isInitialized = true;
        return tdfRenderer.getAvailableFonts();
    };

    /**
     * Checks if the renderer has been successfully initialized.
     * @returns {boolean} True if initialized, false otherwise.
     */
    tdfRenderer.isInitialized = function() {
        return _isInitialized;
    };

    /**
     * Returns a sorted array of unique font keys available in the loaded bundle.
     * These keys are used to specify fonts for rendering and layout.
     * @returns {string[]} A sorted array of font keys, or an empty array if not initialized.
     */
    tdfRenderer.getAvailableFonts = function() {
        if (!_isInitialized) {
            return [];
        }
        // Map keys are iterated in insertion order. Sorting ensures a consistent, predictable order.
        return Array.from(_fontIndex.keys()).sort();
    };

    /**
     * Calculates the overall layout dimensions (width and height in pixels) for a given text string
     * using a specified TDF font. Handles multiline text.
     * @param {string} uniqueFontKey - The key of the font to use for layout.
     * @param {string} text - The text string (can include '\n' for newlines).
     * @param {number} [minSpaceWidthChars=DEFAULT_MIN_SPACE_WIDTH] - Minimum width for space characters if not defined in font (in char units).
     * @returns {{width: number, height: number} | null} An object with `width` and `height` in pixels, or null if error.
     */
    tdfRenderer.calculateLayout = function(uniqueFontKey, text, minSpaceWidthChars = DEFAULT_MIN_SPACE_WIDTH) {
        if (!_isInitialized || !_bundleView) {
            console.error("tdfRenderer.calculateLayout: Renderer not initialized.");
            return null;
        }
        if (!text) {
            // No text, but still return a minimal valid layout (e.g., for an empty canvas).
            return { width: CHAR_WIDTH, height: CHAR_HEIGHT };
        }

        const fontDataOffsetInPool = _fontIndex.get(uniqueFontKey);
        if (typeof fontDataOffsetInPool === "undefined") {
            console.error(`tdfRenderer.calculateLayout: Font key not found: ${uniqueFontKey}`);
            return null;
        }

        // Font Spacing is the first byte of the font-specific data.
        const fontSpacingChars = _bundleView.getUint8(_fontDataPoolOffset + fontDataOffsetInPool);

        const lines = text.split('\n');
        let overallMaxWidthPx = 0;
        let totalHeightPx = 0;

        lines.forEach(line => {
            const lineLayout = _calculateSingleLineLayout(fontDataOffsetInPool, fontSpacingChars, line, minSpaceWidthChars);
            overallMaxWidthPx = Math.max(overallMaxWidthPx, lineLayout.width);
            totalHeightPx += lineLayout.height;
        });

        // Ensure final dimensions are at least one character cell if there was any content.
        return {
            width: overallMaxWidthPx > 0 ? overallMaxWidthPx : CHAR_WIDTH,
            height: totalHeightPx > 0 ? totalHeightPx : CHAR_HEIGHT
        };
    };

    /**
     * Filters the list of available TDF fonts, returning only those that support all
     * non-space, TDF-renderable characters present in the input text.
     * @param {string} text - The text to check character support against.
     * @returns {string[]} A sorted array of font keys that support all required characters.
     */
    tdfRenderer.filterFontsByText = function(text) {
        if (!_isInitialized || !_bundleView) {
            console.warn("tdfRenderer.filterFontsByText: Renderer not initialized.");
            return [];
        }
        if (!text) {
            return tdfRenderer.getAvailableFonts(); // No text requirements, return all available fonts.
        }

        // Identify unique, non-space, TDF-supported characters in the input text.
        const requiredChars = [...new Set(text.split(''))]
            .filter(char => char !== ' ' && char !== '\n' && SUPPORTED_CHAR_LIST.includes(char));

        if (requiredChars.length === 0) {
            // Text contains only spaces, newlines, or characters not in SUPPORTED_CHAR_LIST.
            // All TDF fonts are considered "compatible" in this case.
            return tdfRenderer.getAvailableFonts();
        }

        const filteredKeys = [];
        for (const [key, fontDataOffsetInPool] of _fontIndex.entries()) {
            const supportsAllChars = requiredChars.every(char => {
                // Use the lightweight metrics function to efficiently check for glyph existence.
                return _getGlyphLayoutMetricsOnly(_fontDataPoolOffset, fontDataOffsetInPool, char.charCodeAt(0)) !== null;
            });

            if (supportsAllChars) {
                filteredKeys.push(key);
            }
        }
        return filteredKeys.sort(); // Return sorted for consistency.
    };

    /**
     * Prepares the canvas for rendering: creates or resizes, gets context, and clears.
     * @private
     */
    function _prepareCanvasAndContext(options, layout, bgColor) {
        let targetCanvas = options.canvas;
        const canCreateCanvas = typeof document !== 'undefined' && typeof document.createElement === 'function';

        if (!targetCanvas) {
            if (!canCreateCanvas) {
                throw new Error("tdfRenderer: options.canvas is required in non-browser environments.");
            }
            targetCanvas = document.createElement('canvas');
        }

        // Determine final canvas dimensions.
        const canvasWidth = Math.max(options.targetWidth || 0, layout.width, CHAR_WIDTH);
        const canvasHeight = Math.max(layout.height, CHAR_HEIGHT);

        targetCanvas.width = canvasWidth;
        targetCanvas.height = canvasHeight;

        const context = targetCanvas.getContext('2d');
        if (!context) {
            throw new Error("tdfRenderer: Failed to get 2D rendering context from canvas.");
        }

        // Clear canvas with the specified background color.
        context.fillStyle = `rgba(${bgColor.join(',')})`;
        context.fillRect(0, 0, targetCanvas.width, targetCanvas.height);

        return { canvas: targetCanvas, context: context };
    }

    /**
     * Renders text using a loaded TDF font onto a canvas.
     * Auto-creates a canvas if one is not provided (in browser environments).
     *
     * @param {object} options - Configuration options for rendering.
     * @param {string} options.uniqueFontKey - The unique key identifying the font in the bundle.
     * @param {string} options.text - The text string to render (can include '\n' for newlines).
     * @param {HTMLCanvasElement} [options.canvas] - Optional: Target canvas element. If omitted, a new one is created.
     * @param {number} [options.targetWidth] - Optional: Minimum width for the canvas. If a canvas is provided,
     *                                          it will be resized to at least this width and the calculated text width.
     *                                          If a canvas is created, it will be at least this width.
     * @param {string} [options.textAlign='left'] - Optional: Text alignment ('left', 'center', 'right')
     *                                              relative to the calculated maximum text block width.
     * @param {Array<number>} [options.bgColor] - Optional: Background RGBA color [r,g,b,a]. Defaults to opaque black [0,0,0,255].
     * @param {number} [options.minSpaceWidth] - Optional: Minimum width (in character cells) for space characters
     *                                           if the space glyph is not defined in the font. Defaults to DEFAULT_MIN_SPACE_WIDTH.
     * @returns {Promise<{canvas: HTMLCanvasElement}>} A promise resolving with an object containing the canvas element used/created.
     * @throws {Error} If rendering fails (e.g., not initialized, font not found, canvas issues).
     */
    tdfRenderer.render = async function(options) {
        if (!_isInitialized || !_bundleView) {
            throw new Error("tdfRenderer.render: Renderer not initialized. Call init() first.");
        }
        if (!options || !options.uniqueFontKey || typeof options.text === 'undefined') {
            throw new Error("tdfRenderer.render: Missing required options. 'uniqueFontKey' and 'text' must be provided.");
        }

        const fontDataOffsetInPool = _fontIndex.get(options.uniqueFontKey);
        if (typeof fontDataOffsetInPool === "undefined") {
            throw new Error(`tdfRenderer.render: Font key not found: ${options.uniqueFontKey}`);
        }

        const fontSpacingChars = _bundleView.getUint8(_fontDataPoolOffset + fontDataOffsetInPool);
        const minSpaceWidthChars = (typeof options.minSpaceWidth === 'number' && options.minSpaceWidth >= 0)
            ? options.minSpaceWidth
            : DEFAULT_MIN_SPACE_WIDTH;
        const textAlign = ['left', 'center', 'right'].includes(options.textAlign) ? options.textAlign : 'left';
        const bgColor = (Array.isArray(options.bgColor) && options.bgColor.length === 4)
            ? options.bgColor
            : [0, 0, 0, 255]; // Default to opaque black.

        try {
            // 1. Calculate Overall Layout
            const layout = tdfRenderer.calculateLayout(options.uniqueFontKey, options.text, minSpaceWidthChars);
            if (!layout) {
                // Should not happen if calculateLayout is robust, but as a safeguard.
                throw new Error("tdfRenderer.render: Failed to calculate text layout.");
            }
            const overallTextMaxWidthPx = layout.width; // Max width of any line in the text block.

            // 2. Prepare Canvas and Context
            const { canvas: targetCanvas, context } = _prepareCanvasAndContext(options, layout, bgColor);

            // 3. Calculate Block Start X for centering the entire text block on the canvas
            //    This ensures that if the canvas is wider than the text, the text block itself can be centered.
            const blockStartX = Math.floor((targetCanvas.width - overallTextMaxWidthPx) / 2);

            // 4. Render Line by Line
            const lines = options.text.split('\n');
            let currentY = 0;

            for (const line of lines) {
                // Calculate metrics for *this specific line* to handle alignment.
                const lineLayout = _calculateSingleLineLayout(fontDataOffsetInPool, fontSpacingChars, line, minSpaceWidthChars);
                const currentLineWidthPx = lineLayout.width;
                const currentLineHeightPx = lineLayout.height; // Max height of characters on this line.

                // Calculate starting X for *this line* based on text alignment within the text block.
                let lineOffsetX = 0; // Relative to the start of the text block.
                if (textAlign === 'center') {
                    lineOffsetX = Math.floor((overallTextMaxWidthPx - currentLineWidthPx) / 2);
                } else if (textAlign === 'right') {
                    lineOffsetX = overallTextMaxWidthPx - currentLineWidthPx;
                }
                // For 'left' alignment, lineOffsetX remains 0.

                const lineRenderStartX = blockStartX + lineOffsetX;

                // Render the actual line content.
                _renderLine(context, line, currentY, lineRenderStartX, fontDataOffsetInPool, fontSpacingChars, minSpaceWidthChars);

                currentY += currentLineHeightPx; // Move Y down by the height of the line just rendered.
            }

            return { canvas: targetCanvas };

        } catch (error) {
            console.error(`tdfRenderer: Error during rendering for font "${options.uniqueFontKey}":`, error);
            throw error; // Re-throw to reject the promise and allow caller handling.
        }
    };

    // --- Expose Public API ---
    // Attaches the tdfRenderer object to the global context (window in browsers, or global/this elsewhere).
    global.tdfRenderer = tdfRenderer;

})(typeof globalThis !== 'undefined' ? globalThis : this);
