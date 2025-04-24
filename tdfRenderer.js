// tdfRenderer.js v1.7
// TheDraw Font (.TDF) text rendering library for HTML Canvas
// Uses preprocessed BINARY font bundle.
// Copyright (C) 2025 Ori Livneh
// Licensed under the MIT license

(function (global) {
    "use strict";

    // --- Constants ---
    const CHAR_WIDTH = 8;
    const CHAR_HEIGHT = 16;
    const DEFAULT_MIN_SPACE_WIDTH = 3;
    // Binary Format Markers
    const BIN_NEWLINE_CODE = 0x0D;      // Byte value used in binary for newline
    const BIN_GLYPH_TERMINATOR = 0x00;  // Byte value used in binary for glyph end
    // Internal Representation
    const NEWLINE_CODE = -1;            // Internal code representing newline in compactData array

    const TDF_COLORS = [ /* Colors 0-15 */
        [  0,   0,   0, 255], [  0,   0, 170, 255], [  0, 170,   0, 255], [  0, 170, 170, 255],
        [170,   0,   0, 255], [170,   0, 170, 255], [170,  85,   0, 255], [170, 170, 170, 255],
        [ 85,  85,  85, 255], [ 85,  85, 255, 255], [ 85, 255,  85, 255], [ 85, 255, 255, 255],
        [255,  85,  85, 255], [255,  85, 255, 255], [255, 255,  85, 255], [255, 255, 255, 255]
    ];

    // --- CP437 Font Data ---
    let font; // Expects globalThis.cp437font to be defined externally
    if (typeof globalThis !== 'undefined' && globalThis.cp437font) {
        font = globalThis.cp437font;
    } else {
        console.error("tdfRenderer Error: globalThis.cp437font not found. Rendering will likely fail.");
        font = Array(256).fill([]); // Dummy array
    }

    // --- Internal State ---
    let _bundleBuffer = null; // ArrayBuffer
    let _bundleView = null;   // DataView for the bundle
    let _fontIndex = [];      // Array of { key: string, dataOffset: number } - sorted by key
    let _stringPoolOffset = 0;
    let _fontDataPoolOffset = 0;
    let _isInitialized = false;

    // --- Utilities ---

    /** Fetches binary data using fetch API, returns Promise<ArrayBuffer>. */
    async function fetchBinary(url) {
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP error! Status: ${response.status} fetching ${url}`);
            return await response.arrayBuffer();
        } catch (error) {
            console.error(`Fetch binary error from ${url}:`, error);
            throw error; // Re-throw for handling by caller
        }
    }

    /** Draws a single CP437 character using ImageData. */
    function drawCp437Char(context, charCode, canvasX, canvasY, fgColorRgba, bgColorRgba) {
        if (!font || font.length < 256) return;
        const code = charCode & 0xFF;
        const bitmap = font[code];

        if (typeof context.createImageData !== 'function') { console.warn("createImageData not supported"); return; }
        let imageData;
        try { imageData = context.createImageData(CHAR_WIDTH, CHAR_HEIGHT); }
        catch(e) { console.error("createImageData failed:", e); return; }
        const data = imageData.data;

        if (!bitmap) { // Undefined char: Fill background
             if (bgColorRgba[3] > 0) { for(let i=0; i<data.length; i+=4){ data[i]=bgColorRgba[0]; data[i+1]=bgColorRgba[1]; data[i+2]=bgColorRgba[2]; data[i+3]=bgColorRgba[3]; } }
             else { for(let i=3; i<data.length; i+=4) data[i]=0; }
        } else { // Defined char: render pixels
            for (let row = 0; row < CHAR_HEIGHT; row++) {
                const rowBits = bitmap[row] || 0x00;
                for (let col = 0; col < CHAR_WIDTH; col++) {
                    const offset = (row * CHAR_WIDTH + col) * 4;
                    const isForeground = (rowBits >> (7 - col)) & 1;
                    const colorToUse = isForeground ? fgColorRgba : bgColorRgba;
                    data[offset]   = colorToUse[0]; data[offset+1] = colorToUse[1];
                    data[offset+2] = colorToUse[2]; data[offset+3] = colorToUse[3];
                }
            }
        }
        context.putImageData(imageData, Math.floor(canvasX), Math.floor(canvasY));
    }

    /** Reads a null-terminated UTF-8 string from DataView */
    function readNullTerminatedString(dataView, startOffset) {
        let endOffset = startOffset;
        while (endOffset < dataView.byteLength && dataView.getUint8(endOffset) !== 0) { endOffset++; }
        const stringBytes = new Uint8Array(dataView.buffer, dataView.byteOffset + startOffset, endOffset - startOffset);
        try { return new TextDecoder().decode(stringBytes); } // Modern API
        catch (e) { try { return String.fromCharCode.apply(null, stringBytes); } catch { return ""; } } // Fallback
    }

    /** Performs binary search on the _fontIndex */
    function findFontIndexEntry(uniqueFontKey) {
        let low = 0; let high = _fontIndex.length - 1;
        while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            const midKey = _fontIndex[mid].key; // Key is stored directly in index
            const comparison = uniqueFontKey.localeCompare(midKey);
            if (comparison === 0) return _fontIndex[mid];
            if (comparison < 0) high = mid - 1; else low = mid + 1;
        }
        return null; // Not found
    }

     /** Parses glyph data on demand from the binary buffer into compact array format */
    function parseGlyphDataOnDemand(fontDataPoolOffset, fontDataOffsetInPool, charCode) {
        if (!_bundleView) return null;
        const baseFontDataOffset = fontDataPoolOffset + fontDataOffsetInPool;

        try {
            // Read spacing (byte 0, not needed here) and glyph count (byte 1)
            const glyphCount = _bundleView.getUint8(baseFontDataOffset + 1);
            if (glyphCount === 0) return null; // No glyphs defined for font

            const lookupTableOffset = baseFontDataOffset + 2; // After spacing & count
            const glyphDataTableOffset = lookupTableOffset + glyphCount * 3; // After lookup table

            // Binary search the Glyph Lookup Table for the charCode
            let glyphDataRelativeOffset = -1;
            let low = 0, high = glyphCount - 1;
            while(low <= high) {
                 const mid = Math.floor((low + high) / 2);
                 const entryOffset = lookupTableOffset + mid * 3;
                 const entryCharCode = _bundleView.getUint8(entryOffset);
                 if (entryCharCode === charCode) {
                     glyphDataRelativeOffset = _bundleView.getUint16(entryOffset + 1, true); // Found offset (LE)
                     break;
                 }
                 if (charCode < entryCharCode) high = mid - 1; else low = mid + 1;
            }

            if (glyphDataRelativeOffset === -1) return null; // Glyph not defined for this char

            const absoluteGlyphDataOffset = glyphDataTableOffset + glyphDataRelativeOffset;

            // Basic bounds check before reading W/H
            if (absoluteGlyphDataOffset + 2 > _bundleView.byteLength) {
                 console.warn(`Glyph data offset ${absoluteGlyphDataOffset} out of bounds.`); return null;
            }

            // Read width and height
            const width = _bundleView.getUint8(absoluteGlyphDataOffset);
            const height = _bundleView.getUint8(absoluteGlyphDataOffset + 1);
            const compactData = [width, height]; // Start building compact array
            let currentReadOffset = absoluteGlyphDataOffset + 2;
            let byteValue = 0;

            // Read byte stream until null terminator
            while (currentReadOffset < _bundleView.byteLength && (byteValue = _bundleView.getUint8(currentReadOffset++)) !== BIN_GLYPH_TERMINATOR) {
                if (byteValue === BIN_NEWLINE_CODE) { // Is it the binary newline marker (0x0D)?
                    compactData.push(NEWLINE_CODE);   // ** FIX: Push the internal representation (-1) **
                } else { // Character code byte
                    const charCodeByte = byteValue;
                    if (currentReadOffset >= _bundleView.byteLength) break; // Bounds check for attribute
                    const attrByte = _bundleView.getUint8(currentReadOffset++);
                    compactData.push(charCodeByte, attrByte); // Push char, then attr
                }
            }
            return compactData; // Return [w, h, c1, a1, -1, c2, a2, ...] format

        } catch (e) {
             console.error(`Error parsing glyph data on demand for char ${charCode} at font offset ${fontDataOffsetInPool}:`, e);
             return null;
        }
    }

    /** Calculates actual height from parsed compact glyph data array */
    function getGlyphActualHeight(glyphCompactData) {
        if (!glyphCompactData || glyphCompactData.length < 2) return 1; // Min height 1 if exists
        let heightInLines = 0; let currentLineHasChars = false;
        for (let k = 2; k < glyphCompactData.length; k++) {
            if (glyphCompactData[k] === NEWLINE_CODE) { heightInLines++; currentLineHasChars = false; }
            else { k++; currentLineHasChars = true; } // skip attribute
        }
        if (currentLineHasChars) heightInLines++; // Count last line
        return heightInLines > 0 ? heightInLines : 1; // Return calculated height or min 1
    }

    /** Internal helper to calculate layout metrics for a single line */
    function _calculateSingleLineLayout(fontDataOffset, fontSpacing, textLine, minSpaceWidth) {
         if (!textLine) return { width: 0, height: CHAR_HEIGHT };
         let lineWidthPx = 0; let maxLineHeightPx = 0; let glyphCountOnLine = 0;

         for (let i = 0; i < textLine.length; i++) {
             const char = textLine[i];
             let charWidthPx = 0; let charHeightPx = 0;
             let glyphCompactData = null;

             if (char !== ' ') { glyphCompactData = parseGlyphDataOnDemand(fontDataOffset, 0, char.charCodeAt(0)); } // Offset 0 within font data block
             else { glyphCompactData = parseGlyphDataOnDemand(fontDataOffset, 0, 32); } // Check space def

             if (char === ' ') {
                 charWidthPx = (glyphCompactData) ? glyphCompactData[0] * CHAR_WIDTH : minSpaceWidth * CHAR_WIDTH;
                 charHeightPx = (glyphCompactData) ? getGlyphActualHeight(glyphCompactData) * CHAR_HEIGHT : CHAR_HEIGHT;
                 glyphCountOnLine++;
             } else if (glyphCompactData) {
                 charWidthPx = glyphCompactData[0] * CHAR_WIDTH;
                 charHeightPx = getGlyphActualHeight(glyphCompactData) * CHAR_HEIGHT;
                 glyphCountOnLine++;
             } else { charHeightPx = CHAR_HEIGHT; } // Undefined non-space char

             lineWidthPx += charWidthPx; maxLineHeightPx = Math.max(maxLineHeightPx, charHeightPx);
         }
         if (glyphCountOnLine > 1) lineWidthPx += (glyphCountOnLine - 1) * (fontSpacing * CHAR_WIDTH);
         return { width: lineWidthPx > 0 ? lineWidthPx : CHAR_WIDTH, height: maxLineHeightPx > 0 ? maxLineHeightPx : CHAR_HEIGHT };
    }


    // --- Internal Renderer Class --- (Simplified: No longer needed)
    // The rendering logic is now directly inside tdfRenderer.render


    // --- Public API Object ---
    const tdfRenderer = {};

    /** Initializes the renderer by loading the BINARY font bundle. */
    tdfRenderer.init = async function(bundleUrl) {
        if (_isInitialized) return tdfRenderer.getAvailableFonts();
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
        _fontIndex = [];
        for (let i = 0; i < fontCount; i++) {
            const entryOffset = indexOffset + i * 8; if (entryOffset + 8 > _bundleBuffer.byteLength) throw new Error("Index table truncated.");
            const keyOffset = _bundleView.getUint32(entryOffset, true); const dataOffset = _bundleView.getUint32(entryOffset + 4, true);
            const key = readNullTerminatedString(_bundleView, _stringPoolOffset + keyOffset);
            _fontIndex.push({ key: key, dataOffset: dataOffset }); // Store key directly
        }
        _fontIndex.sort((a, b) => a.key.localeCompare(b.key)); // Ensure sorted
        _isInitialized = true;
        return tdfRenderer.getAvailableFonts();
    };

    /** Checks if the renderer has been initialized. */
    tdfRenderer.isInitialized = function() { return _isInitialized; };

    /** Returns an array of unique font keys available in the loaded bundle. */
    tdfRenderer.getAvailableFonts = function() { return _isInitialized ? _fontIndex.map(entry => entry.key) : []; };

    /** Calculates overall layout dimensions for potentially multiline TDF text. */
    tdfRenderer.calculateLayout = function(uniqueFontKey, text, minSpaceWidth = DEFAULT_MIN_SPACE_WIDTH) {
         if (!_isInitialized || !_bundleView) { console.error("tdfRenderer not initialized."); return null; }
         if (!text) return { width: CHAR_WIDTH, height: CHAR_HEIGHT };
         const fontIndexEntry = findFontIndexEntry(uniqueFontKey); if (!fontIndexEntry) { console.error(`Font key not found: ${uniqueFontKey}`); return null; }
         const fontDataOffset = _fontDataPoolOffset + fontIndexEntry.dataOffset; // Base offset for this font's data in the pool
         const fontSpacing = _bundleView.getUint8(fontDataOffset); // Read spacing byte

         const lines = text.split('\n'); let overallMaxWidth = 0; let totalHeight = 0;
         lines.forEach(line => {
             // Call the shared private helper function
             const lineLayout = _calculateSingleLineLayout(fontDataOffset, fontSpacing, line, minSpaceWidth);
             overallMaxWidth = Math.max(overallMaxWidth, lineLayout.width);
             totalHeight += lineLayout.height;
         });
         return { width: overallMaxWidth > 0 ? overallMaxWidth : CHAR_WIDTH, height: totalHeight > 0 ? totalHeight : CHAR_HEIGHT };
    };

     /** Filters available fonts based on character support (parses glyph lookups on demand). */
     tdfRenderer.filterFontsByText = function(text) {
         if (!_isInitialized || !_bundleView) { console.warn("tdfRenderer not initialized for filter."); return []; }
         if (!text) return tdfRenderer.getAvailableFonts();
         const required = [...new Set(text.split(''))].filter(c => c !== ' ');
         if (required.length === 0) return tdfRenderer.getAvailableFonts();

         return _fontIndex.filter(entry => {
             const fontDataOffset = _fontDataPoolOffset + entry.dataOffset;
             return required.every(char => {
                 // Check if glyph exists by trying to parse it (returns null if not found/error)
                 return parseGlyphDataOnDemand(fontDataOffset, 0, char.charCodeAt(0)) !== null;
             });
         }).map(entry => entry.key);
     };

    /** Renders text using a loaded TDF font onto a canvas. */
    tdfRenderer.render = async function(options) { // Keep async for API consistency
        if (!_isInitialized || !_bundleView) throw new Error("tdfRenderer.render called before init().");
        if (!options || !options.uniqueFontKey || typeof options.text === 'undefined') throw new Error("Missing options: uniqueFontKey, text");
        const canCreateCanvas = typeof document !== 'undefined' && typeof document.createElement === 'function';
        if (!options.canvas && !canCreateCanvas) throw new Error("options.canvas required in non-browser.");

        const fontIndexEntry = findFontIndexEntry(options.uniqueFontKey);
        if (!fontIndexEntry) throw new Error(`Font key not found: ${options.uniqueFontKey}`);
        const fontDataOffset = _fontDataPoolOffset + fontIndexEntry.dataOffset;
        const fontSpacing = _bundleView.getUint8(fontDataOffset);

        const minSpaceWidth = (options.minSpaceWidth >= 0) ? options.minSpaceWidth : DEFAULT_MIN_SPACE_WIDTH;
        const textAlign = ['left', 'center', 'right'].includes(options.textAlign) ? options.textAlign : 'left';
        const bgColor = Array.isArray(options.bgColor) && options.bgColor.length === 4 ? options.bgColor : [0, 0, 0, 255];

        let targetCanvas = options.canvas;

        try {
             // Calculate Layout first
             const layout = tdfRenderer.calculateLayout(options.uniqueFontKey, options.text, minSpaceWidth);
             if (!layout) throw new Error("Failed to calculate layout.");
             const overallMaxWidthPx = layout.width;
             const totalHeightPx = layout.height;

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

            // Calculate block start X (overall centering relative to canvas)
            const blockStartX = Math.floor((targetCanvas.width - overallMaxWidthPx) / 2);

            const lines = options.text.split('\n');
            let currentY = 0;

            lines.forEach(line => {
                // Recalculate line metrics needed for alignment and advancing Y
                // (Could optimize by storing this from the initial layout pass)
                const lineLayout = _calculateSingleLineLayout(fontDataOffset, fontSpacing, line, minSpaceWidth);
                const lineWidthPx = lineLayout.width;
                const lineHeightPx = lineLayout.height;

                let lineOffsetX = 0; // Per-line alignment offset
                if (textAlign === 'center') lineOffsetX = Math.floor((overallMaxWidthPx - lineWidthPx) / 2);
                else if (textAlign === 'right') lineOffsetX = overallMaxWidthPx - lineWidthPx;
                let currentX = blockStartX + lineOffsetX; // Final starting X for this line

                // Render characters for the line
                for (let i = 0; i < line.length; i++) {
                    const char = line[i];
                    const glyphCompactData = parseGlyphDataOnDemand(fontDataOffset, 0, char.charCodeAt(0));
                    let glyphRenderWidthPx = 0;

                    if (char === ' ') { glyphRenderWidthPx = glyphCompactData ? glyphCompactData[0]*CHAR_WIDTH : minSpaceWidth*CHAR_WIDTH; }
                    else if (glyphCompactData) { glyphRenderWidthPx = glyphCompactData[0]*CHAR_WIDTH; }

                    if (glyphCompactData) { // Render if glyph data exists
                        let glyphX = 0, glyphY = 0;
                        for (let k = 2; k < glyphCompactData.length; k++) { // Start from index 2
                            const item = glyphCompactData[k];
                            if (item === NEWLINE_CODE) { glyphY++; glyphX = 0; }
                            else {
                                const charCode=item; k++; if(k>=glyphCompactData.length) break; const attr=glyphCompactData[k];
                                const cX=currentX+glyphX*CHAR_WIDTH, cY=currentY+glyphY*CHAR_HEIGHT;
                                const bg=(attr>>4)&0x07, fg=attr&0x0F; const bgRGBA=TDF_COLORS[bg]||TDF_COLORS[0], fgRGBA=TDF_COLORS[fg]||TDF_COLORS[7];
                                drawCp437Char(context, charCode, cX, cY, fgRGBA, bgRGBA); glyphX++;
                            }
                        }
                    }
                    currentX += glyphRenderWidthPx;
                    if (i < line.length - 1) currentX += fontSpacing * CHAR_WIDTH;
                }
                currentY += lineHeightPx; // Move Y down for next line
            });
            return { canvas: targetCanvas }; // Resolve promise

        } catch (error) { console.error("Error during TDF rendering:", error); throw error; }
    };

    // Expose the tdfRenderer object globally
    global.tdfRenderer = tdfRenderer;

})(typeof globalThis !== 'undefined' ? globalThis : this);
