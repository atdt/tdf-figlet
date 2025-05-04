// tdfRenderer.js v1.9 (Optimized layout calculation)
// TheDraw Font (.TDF) text rendering library for HTML Canvas
// Uses preprocessed BINARY font bundle.
// Copyright (C) 2012-2024 Ori Livneh & Contributors
// Licensed under the MIT and GPL licenses

(function (global) {
    "use strict";

    // --- Constants ---
    const CHAR_WIDTH = 8;
    const CHAR_HEIGHT = 16;
    const DEFAULT_MIN_SPACE_WIDTH = 3;
    const BIN_NEWLINE_CODE = 0x0D;
    const BIN_GLYPH_TERMINATOR = 0x00;
    const NEWLINE_CODE = -1; // Internal representation

    const TDF_COLORS = [ /* Colors 0-15 */
        [  0,   0,   0, 255], [  0,   0, 170, 255], [  0, 170,   0, 255], [  0, 170, 170, 255],
        [170,   0,   0, 255], [170,   0, 170, 255], [170,  85,   0, 255], [170, 170, 170, 255],
        [ 85,  85,  85, 255], [ 85,  85, 255, 255], [ 85, 255,  85, 255], [ 85, 255, 255, 255],
        [255,  85,  85, 255], [255,  85, 255, 255], [255, 255,  85, 255], [255, 255, 255, 255]
    ];
    const SUPPORTED_CHAR_LIST = "!\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~"; // ASCII 33-126


    // --- CP437 Font Data ---
    // Attempts to load standard CP437 font data from a global variable.
    function getCp437FontData() {
        if (typeof globalThis !== 'undefined' && Array.isArray(globalThis.cp437font) && globalThis.cp437font.length >= 256) {
            return globalThis.cp437font;
        } else {
            console.error("tdfRenderer Error: globalThis.cp437font not found or invalid. CP437 rendering will fail.");
            return Array(256).fill([]); // Dummy array to prevent downstream errors
        }
    }
    const font = getCp437FontData(); // Load font data immediately

    // --- Internal State ---
    let _bundleBuffer = null; let _bundleView = null;
    let _fontIndex = new Map(); // Map of key: string to dataOffset: number
    let _stringPoolOffset = 0; let _fontDataPoolOffset = 0;
    let _isInitialized = false;

    // --- Utilities ---

    /** Fetches binary data using fetch API */
    async function fetchBinary(url) {
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP error! Status: ${response.status} fetching ${url}`);
            return await response.arrayBuffer();
        } catch (error) { console.error(`Fetch binary error from ${url}:`, error); throw error; }
    }

    /** Draws a single CP437 character */
    function drawCp437Char(context, charCode, canvasX, canvasY, fgColorRgba, bgColorRgba) {
        // Font data check removed, handled by getCp437FontData()
        const code = charCode & 0xFF;
        const bitmap = font[code]; // Use font loaded at init

        if (typeof context.createImageData !== 'function') { return; } // Requires browser context
        let imageData; try { imageData = context.createImageData(CHAR_WIDTH, CHAR_HEIGHT); } catch(e) { return; }
        const data = imageData.data;
        const [fgR, fgG, fgB, fgA] = fgColorRgba; const [bgR, bgG, bgB, bgA] = bgColorRgba;

        if (!bitmap || bitmap.length < CHAR_HEIGHT) { // Undefined/invalid char bitmap: Fill background
             if (bgA > 0) { for(let i=0; i<data.length; i+=4){ data[i]=bgR; data[i+1]=bgG; data[i+2]=bgB; data[i+3]=bgA; } }
             else { for(let i=3; i<data.length; i+=4) data[i]=0; }
        } else { // Defined char: render pixels
            for (let row = 0; row < CHAR_HEIGHT; row++) {
                const rowBits = bitmap[row] || 0x00;
                for (let col = 0; col < CHAR_WIDTH; col++) {
                    const offset = (row * CHAR_WIDTH + col) * 4; const isForeground = (rowBits >> (7 - col)) & 1;
                    const colorToUse = isForeground ? fgColorRgba : bgColorRgba;
                    data[offset]=colorToUse[0]; data[offset+1]=colorToUse[1]; data[offset+2]=colorToUse[2]; data[offset+3]=colorToUse[3];
                }
            }
        }
        context.putImageData(imageData, Math.floor(canvasX), Math.floor(canvasY));
    }

    /** Reads a null-terminated UTF-8 string from DataView */
    function readNullTerminatedString(dataView, startOffset) {
        let endOffset = startOffset;
        while (endOffset < dataView.byteLength && dataView.getUint8(endOffset) !== 0) { endOffset++; }
        if (endOffset === startOffset) return "";
        const stringBytes = new Uint8Array(dataView.buffer, dataView.byteOffset + startOffset, endOffset - startOffset);
        try { return new TextDecoder().decode(stringBytes); }
        catch (e) { try { return String.fromCharCode.apply(null, stringBytes); } catch { return ""; } } // Fallback
    }

    /** Binary search within a font's Glyph Lookup Table */
    function _findGlyphOffsetInTable(lookupTableOffset, glyphCount, charCode) {
        if (!_bundleView) return -1; let low = 0; let high = glyphCount - 1;
        while(low <= high) {
             const mid = Math.floor((low + high) / 2); const entryOffset = lookupTableOffset + mid * 3;
             const entryCharCode = _bundleView.getUint8(entryOffset);
             if (entryCharCode === charCode) { return _bundleView.getUint16(entryOffset + 1, true); } // Found offset
             if (charCode < entryCharCode) { high = mid - 1; } else { low = mid + 1; }
        }
        return -1; // Not found
    }

     /** Parses the raw byte stream for a single glyph into the compact array */
    function _parseGlyphByteStream(glyphStreamStartOffset) {
         if (!_bundleView) return [];
         const compactData = []; let currentReadOffset = glyphStreamStartOffset; let byteValue = 0;
         while (currentReadOffset < _bundleView.byteLength && (byteValue = _bundleView.getUint8(currentReadOffset++)) !== BIN_GLYPH_TERMINATOR) {
             if (byteValue === BIN_NEWLINE_CODE) { compactData.push(NEWLINE_CODE); }
             else {
                 const charCodeByte = byteValue; if (currentReadOffset >= _bundleView.byteLength) break;
                 const attrByte = _bundleView.getUint8(currentReadOffset++); compactData.push(charCodeByte, attrByte);
             }
         }
         return compactData;
    }

    /** Parses glyph W/H and data stream on demand */
    function parseGlyphDataOnDemand(fontDataPoolOffset, fontDataOffsetInPool, charCode) {
        if (!_bundleView) return null;
        const baseFontDataOffset = fontDataPoolOffset + fontDataOffsetInPool;
        try {
            const glyphCount = _bundleView.getUint8(baseFontDataOffset + 1); if (glyphCount === 0) return null;
            const lookupTableOffset = baseFontDataOffset + 2; const glyphDataTableOffset = lookupTableOffset + glyphCount * 3;
            const glyphDataRelativeOffset = _findGlyphOffsetInTable(lookupTableOffset, glyphCount, charCode);
            if (glyphDataRelativeOffset === -1) return null; // Glyph not defined
            const absoluteGlyphDataOffset = glyphDataTableOffset + glyphDataRelativeOffset;
            if (absoluteGlyphDataOffset + 2 > _bundleView.byteLength) return null; // Bounds check
            const width = _bundleView.getUint8(absoluteGlyphDataOffset); // Precalculated Width
            const height = _bundleView.getUint8(absoluteGlyphDataOffset + 1); // Precalculated Height (in lines)
            const streamStartOffset = absoluteGlyphDataOffset + 2;
            const streamData = _parseGlyphByteStream(streamStartOffset);
            // Return format: [width, height_lines, ...streamData]
            return [width, height, ...streamData];
        } catch (e) { console.error(`Glyph parse error char ${charCode} font offset ${fontDataOffsetInPool}:`, e); return null; }
    }

    /** Calculates layout metrics for a single character using precalculated height */
    function _getCharLayoutMetrics(fontDataOffset, char, minSpaceWidth) {
        let charWidthPx = 0;
        let charHeightPx = CHAR_HEIGHT; // Default canvas cell height
        let isDefined = false;
        const charCode = char.charCodeAt(0);
        let glyphData = null; // Holds [width, height_lines, ...stream]

        if (char === ' ') {
            // Attempt to get data for space char (ASCII 32)
            glyphData = parseGlyphDataOnDemand(_fontDataPoolOffset, fontDataOffset, 32);
            if (glyphData) { // Space glyph is defined
                charWidthPx = glyphData[0] * CHAR_WIDTH; // Use precalculated width
                // Use precalculated height (lines) * CHAR_HEIGHT for pixel height
                charHeightPx = Math.max(1, glyphData[1]) * CHAR_HEIGHT; // Ensure min 1 line height
            } else { // Space glyph not defined, use minimum width
                charWidthPx = minSpaceWidth * CHAR_WIDTH;
                // Height remains default CHAR_HEIGHT
            }
            isDefined = true; // Treat space as always defined for layout purposes
        } else {
            // Attempt to get data for non-space character
            glyphData = parseGlyphDataOnDemand(_fontDataPoolOffset, fontDataOffset, charCode);
            if (glyphData) { // Character is defined
                charWidthPx = glyphData[0] * CHAR_WIDTH; // Use precalculated width
                // Use precalculated height (lines) * CHAR_HEIGHT for pixel height
                charHeightPx = Math.max(1, glyphData[1]) * CHAR_HEIGHT; // Ensure min 1 line height
                isDefined = true;
            }
            // Else: Undefined non-space char (width is 0, height is CHAR_HEIGHT)
        }

        return { widthPx: charWidthPx, heightPx: charHeightPx, isDefined: isDefined };
    }

    /** Calculates layout metrics for a single line of text */
    function _calculateSingleLineLayout(fontDataOffset, fontSpacing, textLine, minSpaceWidth) {
         if (!textLine) return { width: 0, height: CHAR_HEIGHT };
         let lineWidthPx = 0; let maxLineHeightPx = 0; let glyphCountOnLine = 0;
         for (let i = 0; i < textLine.length; i++) {
             const metrics = _getCharLayoutMetrics(fontDataOffset, textLine[i], minSpaceWidth);
             lineWidthPx += metrics.widthPx;
             maxLineHeightPx = Math.max(maxLineHeightPx, metrics.heightPx);
             if (metrics.widthPx > 0 || textLine[i] === ' ') { glyphCountOnLine++; } // Count chars/spaces that take width
         }
         if (glyphCountOnLine > 1) { lineWidthPx += (glyphCountOnLine - 1) * (fontSpacing * CHAR_WIDTH); }
         // Ensure minimum dimensions for the line
         return { width: lineWidthPx > 0 ? lineWidthPx : CHAR_WIDTH, height: maxLineHeightPx > 0 ? maxLineHeightPx : CHAR_HEIGHT };
    }

    /** Renders a single line of text onto the canvas */
    function _renderLine(context, lineText, startY, lineStartX, fontDataOffset, fontSpacing, minSpaceWidth) {
        let currentX = lineStartX;
        for (let i = 0; i < lineText.length; i++) {
            const char = lineText[i];
            const charCode = char.charCodeAt(0);
            const glyphCompactData = parseGlyphDataOnDemand(_fontDataPoolOffset, fontDataOffset, charCode);
            let glyphRenderWidthPx = 0;

            // Determine width to advance cursor
            if (char === ' ') {
                 const spaceGlyph = parseGlyphDataOnDemand(_fontDataPoolOffset, fontDataOffset, 32);
                 glyphRenderWidthPx = (spaceGlyph) ? spaceGlyph[0] * CHAR_WIDTH : minSpaceWidth * CHAR_WIDTH;
            } else if (glyphCompactData) { glyphRenderWidthPx = glyphCompactData[0] * CHAR_WIDTH; }

            // Render the glyph's content if it exists
            if (glyphCompactData && glyphCompactData.length > 2) { // Check stream data exists
                let glyphX = 0, glyphY = 0;
                for (let k = 2; k < glyphCompactData.length; k++) { // Start from index 2 for data
                    const item = glyphCompactData[k];
                    if (item === NEWLINE_CODE) { glyphY++; glyphX = 0; }
                    else {
                         const glyphCharCode = item; k++; if (k >= glyphCompactData.length) break; const attrByte = glyphCompactData[k];
                         const canvasX = currentX + glyphX * CHAR_WIDTH, canvasY = startY + glyphY * CHAR_HEIGHT;
                         const bgIndex = (attrByte >> 4) & 0x07, fgIndex = attrByte & 0x0F;
                         const bgColorRgba = TDF_COLORS[bgIndex] || TDF_COLORS[0];
                         const fgColorRgba = TDF_COLORS[fgIndex] || TDF_COLORS[7];
                         drawCp437Char(context, glyphCharCode, canvasX, canvasY, fgColorRgba, bgColorRgba);
                         glyphX++;
                    }
                }
            }
            // Advance cursor X position
            currentX += glyphRenderWidthPx;
            if (i < lineText.length - 1 && glyphRenderWidthPx > 0) { // Add spacing only if char had width
                 currentX += fontSpacing * CHAR_WIDTH;
            }
        }
    }


    // --- Public API Object ---
    const tdfRenderer = {};

    /**
     * Initializes the renderer by loading the BINARY font bundle.
     * @param {string} bundleUrl - URL of the preprocessed tdf_bundle.bin file.
     * @returns {Promise<string[]>} Promise resolving with an array of available unique font keys.
     */
    tdfRenderer.init = async function(bundleUrl) {
        if (_isInitialized) { return tdfRenderer.getAvailableFonts(); } // Return keys if already done
        _bundleBuffer = await fetchBinary(bundleUrl);
        _bundleView = new DataView(_bundleBuffer);
        // Validate Header
        if (_bundleBuffer.byteLength < 21) throw new Error("Binary bundle invalid: Header too small.");
        const magic = readNullTerminatedString(_bundleView, 0).substring(0, 4); if (magic !== 'TDFB') throw new Error(`Invalid magic string: ${magic}`);
        const version = _bundleView.getUint8(4); if (version !== 1) throw new Error(`Unsupported bundle version: ${version}`);
        const fontCount = _bundleView.getUint32(5, true); const indexOffset = _bundleView.getUint32(9, true);
        _stringPoolOffset = _bundleView.getUint32(13, true); _fontDataPoolOffset = _bundleView.getUint32(17, true);
        if (indexOffset >= _bundleBuffer.byteLength || _stringPoolOffset >= _bundleBuffer.byteLength || _fontDataPoolOffset >= _bundleBuffer.byteLength) throw new Error("Invalid offsets in bundle header.");
        // Parse Font Index Table and store with keys
        _fontIndex = new Map();
        for (let i = 0; i < fontCount; i++) {
            const entryOffset = indexOffset + i * 8; if (entryOffset + 8 > _bundleBuffer.byteLength) throw new Error("Index table truncated.");
            const keyOffset = _bundleView.getUint32(entryOffset, true); const dataOffset = _bundleView.getUint32(entryOffset + 4, true);
            const key = readNullTerminatedString(_bundleView, _stringPoolOffset + keyOffset);
            if (key) { // Ensure key is valid before adding
                 _fontIndex.set(key, dataOffset);
            } else { console.warn(`Empty key found at index ${i}`); }
        }
        _isInitialized = true;
        return tdfRenderer.getAvailableFonts();
    };

    /** Checks if the renderer has been initialized. */
    tdfRenderer.isInitialized = function() { return _isInitialized; };

    /** Returns a sorted array of unique font keys available in the loaded bundle. */
    tdfRenderer.getAvailableFonts = function() {
        // Keys are already sorted during init
        return _isInitialized ? Array.from(_fontIndex.keys()) : [];
    };

    /** Calculates overall layout dimensions for potentially multiline TDF text. */
    tdfRenderer.calculateLayout = function(uniqueFontKey, text, minSpaceWidth = DEFAULT_MIN_SPACE_WIDTH) {
         if (!_isInitialized || !_bundleView) { console.error("tdfRenderer not initialized."); return null; }
         if (!text) return { width: CHAR_WIDTH, height: CHAR_HEIGHT };
         const fontDataOffset = _fontIndex.get(uniqueFontKey);
         if (typeof fontDataOffset === "undefined") { console.error(`Font key not found: ${uniqueFontKey}`); return null; }

         const fontSpacing = _bundleView.getUint8(_fontDataPoolOffset + fontDataOffset);

         const lines = text.split('\n'); let overallMaxWidth = 0; let totalHeight = 0;
         lines.forEach(line => {
             const lineLayout = _calculateSingleLineLayout(fontDataOffset, fontSpacing, line, minSpaceWidth); // Uses optimized _getCharLayoutMetrics
             overallMaxWidth = Math.max(overallMaxWidth, lineLayout.width);
             totalHeight += lineLayout.height;
         });
         // Ensure final dimensions are at least one character cell
         return {
             width: overallMaxWidth > 0 ? overallMaxWidth : CHAR_WIDTH,
             height: totalHeight > 0 ? totalHeight : CHAR_HEIGHT
         };
    };

     /** Filters available fonts based on whether they support all non-space, supported characters in the input text. */
     tdfRenderer.filterFontsByText = function(text) {
         if (!_isInitialized || !_bundleView) { console.warn("tdfRenderer not initialized for filter."); return []; }
         if (!text) return Array.from(_fontIndex.keys());

         // Filter required chars to only those potentially supported by TDF
         const requiredChars = [...new Set(text.split(''))]
                               .filter(char => char !== ' ' && char !== '\n' && SUPPORTED_CHAR_LIST.includes(char));

         if (requiredChars.length === 0) return Array.from(_fontIndex.keys()); // Return all if only spaces/newlines/unsupported chars

         const filteredKeys = [];
         for (const [key, fontDataOffset] of _fontIndex.entries()) {
             // Check if all required characters have a defined glyph
             const supportsAllChars = requiredChars.every(char => {
                 // parseGlyphDataOnDemand returns null if char not found
                 return parseGlyphDataOnDemand(_fontDataPoolOffset, fontDataOffset, char.charCodeAt(0)) !== null;
             });
             if (supportsAllChars) {
                 filteredKeys.push(key);
             }
         }
         return filteredKeys;
     };

    /**
     * Renders text using a loaded TDF font onto a canvas. Auto-creates canvas if needed.
     * @param {object} options - Configuration options.
     * @param {string} options.uniqueFontKey - The unique key identifying the font in the bundle.
     * @param {string} options.text - The text string to render (can include '\n').
     * @param {HTMLCanvasElement} [options.canvas] - Optional: Target canvas. If omitted, a new one is created.
     * @param {number} [options.targetWidth] - Optional: Min width for a *provided* canvas.
     * @param {string} [options.textAlign='left'] - Optional: Text alignment ('left', 'center', 'right').
     * @param {Array<number>} [options.bgColor] - Optional: Background RGBA [r,g,b,a]. Defaults to opaque black.
     * @param {number} [options.minSpaceWidth] - Optional: Min width (chars) for space if glyph missing. Defaults to 3.
     * @returns {Promise<{canvas: HTMLCanvasElement}>} Promise resolving with the canvas element used/created.
     */
    tdfRenderer.render = async function(options) {
        if (!_isInitialized || !_bundleView) throw new Error("tdfRenderer.render called before init().");
        if (!options || !options.uniqueFontKey || typeof options.text === 'undefined') throw new Error("Missing options: uniqueFontKey, text");
        const canCreateCanvas = typeof document !== 'undefined' && typeof document.createElement === 'function';
        if (!options.canvas && !canCreateCanvas) throw new Error("options.canvas required in non-browser.");

        const fontDataOffset = _fontIndex.get(options.uniqueFontKey);
        if (typeof fontDataOffset === "undefined") throw new Error(`Font key not found: ${options.uniqueFontKey}`);

        const fontSpacing = _bundleView.getUint8(_fontDataPoolOffset + fontDataOffset);

        const minSpaceWidth = (options.minSpaceWidth >= 0) ? options.minSpaceWidth : DEFAULT_MIN_SPACE_WIDTH;
        const textAlign = ['left', 'center', 'right'].includes(options.textAlign) ? options.textAlign : 'left';
        const bgColor = Array.isArray(options.bgColor) && options.bgColor.length === 4 ? options.bgColor : [0, 0, 0, 255];

        let targetCanvas = options.canvas;

        try {
             // Calculate Overall Layout first
             const layout = tdfRenderer.calculateLayout(options.uniqueFontKey, options.text, minSpaceWidth);
             if (!layout) throw new Error("Failed to calculate layout.");
             const overallMaxWidthPx = layout.width;
             const totalHeightPx = layout.height;

            // Prepare Canvas
            if (!targetCanvas) { // Auto-create canvas
                targetCanvas = document.createElement('canvas');
                targetCanvas.width = overallMaxWidthPx > 0 ? overallMaxWidthPx : CHAR_WIDTH;
                targetCanvas.height = totalHeightPx > 0 ? totalHeightPx : CHAR_HEIGHT;
            } else { // Resize provided canvas
                 const finalCanvasWidth = Math.max(options.targetWidth || 0, overallMaxWidthPx, CHAR_WIDTH);
                 targetCanvas.width = finalCanvasWidth;
                 targetCanvas.height = totalHeightPx > 0 ? totalHeightPx : CHAR_HEIGHT;
            }

            const context = targetCanvas.getContext('2d');
            if (!context) throw new Error("Failed to get 2D context.");

            // Clear canvas
            context.fillStyle = `rgba(${bgColor.join(',')})`;
            context.fillRect(0, 0, targetCanvas.width, targetCanvas.height);

            // Calculate block start X (for overall centering relative to canvas width)
            const blockStartX = Math.floor((targetCanvas.width - overallMaxWidthPx) / 2);

            // Render line by line
            const lines = options.text.split('\n');
            let currentY = 0;
            lines.forEach(line => {
                // Calculate metrics for *this* line
                const lineLayout = _calculateSingleLineLayout(fontDataOffset, fontSpacing, line, minSpaceWidth);
                const lineWidthPx = lineLayout.width;
                const lineHeightPx = lineLayout.height; // This is the max height of chars on the line

                // Calculate starting X for *this line* based on alignment
                let lineOffsetX = 0;
                if (textAlign === 'center') lineOffsetX = Math.floor((overallMaxWidthPx - lineWidthPx) / 2);
                else if (textAlign === 'right') lineOffsetX = overallMaxWidthPx - lineWidthPx;
                const lineStartX = blockStartX + lineOffsetX;

                // Render the line content using the helper
                _renderLine(context, line, currentY, lineStartX, fontDataOffset, fontSpacing, minSpaceWidth);

                currentY += lineHeightPx; // Move Y down by the calculated max height of this line
            });

            return { canvas: targetCanvas }; // Resolve promise

        } catch (error) {
            console.error(`Error during TDF rendering for font ${options.uniqueFontKey}:`, error);
            throw error; // Re-throw to reject the promise
        }
    };

    // --- Expose Public API ---
    global.tdfRenderer = tdfRenderer;

})(typeof globalThis !== 'undefined' ? globalThis : this); // Use globalThis or fallback
