#!/usr/bin/env node

// Preprocesses TDF files into a single, compact BINARY bundle (.bin).
// Handles multi-font TDFs, creates unique font keys, stores data compactly.

import fs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer'; // Explicit import might be needed

// --- Constants ---
const TDF_COLOR_FONT_TYPE = 2;
const TDF_HEADER_SIGNATURE = Buffer.from([0x55, 0xAA, 0x00, 0xFF]);
const TDF_HEADER_START_OFFSET = 20;
// const TDF_DATA_START_OFFSET = 233; // No longer global
const SUPPORTED_CHAR_LIST = "!\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";
const BIN_NEWLINE_CODE = 0x0D; // Use CR byte for newline marker in binary stream
const BIN_GLYPH_TERMINATOR = 0x00; // Null byte to terminate glyph stream
const HEADER_METADATA_SIZE = 213; // Estimated size from header sig to end of offset table

// Output Binary Format Constants
const BIN_MAGIC = 'TDFB';
const BIN_VERSION = 1;

// --- TDF Parser Logic ---
// (TdfParserNode class remains mostly the same as v1.5, crucially including
// the fix for calculating dataBlockStartOffset per font)
class TdfParserNode {
     constructor(buffer, filePath = 'unknown') { if (!buffer || !(buffer instanceof Buffer) || buffer.byteLength < 233) throw new Error(`Invalid TDF buffer: ${filePath}`); this.buffer = buffer; this.filePath = filePath; this.fonts = []; }
     parse() { /* Parses headers, calculates uniqueKey and correct dataBlockStartOffset for each font. Implementation omitted for brevity - use the corrected version from previous step */
        this.fonts = []; const dataView = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
        const magicString = "TheDraw FONTS file"; if (dataView.byteLength < 20 || dataView.getUint8(0) !== 0x13 || dataView.getUint8(19) !== 0x1A) { console.warn(`[${this.filePath}] TDF header validation failed.`); }
        let currentOffset = 0;
        while (currentOffset <= dataView.byteLength - TDF_HEADER_SIGNATURE.length) {
             let headerStartIndex = -1; for (let searchOffset = currentOffset; searchOffset <= dataView.byteLength - TDF_HEADER_SIGNATURE.length; searchOffset++) { if (this.buffer.compare(TDF_HEADER_SIGNATURE, 0, 4, searchOffset, searchOffset + 4) === 0) { headerStartIndex = searchOffset; break; } } if (headerStartIndex === -1) break;
             try { const nameLenOffset = 4, nameOffset = 5, typeOffset = 21, spaceOffset = 22, sizeOffset = 23, tableOffset = 25; if (headerStartIndex + HEADER_METADATA_SIZE > dataView.byteLength) { currentOffset = headerStartIndex + 1; continue; }
                 const fontNameLength = Math.min(dataView.getUint8(headerStartIndex + nameLenOffset), 12); let fontName = ""; for (let i = 0; i < fontNameLength; i++) { const cc = dataView.getUint8(headerStartIndex + nameOffset + i); if (cc === 0) break; fontName += String.fromCharCode(cc); } fontName = fontName.trim();
                 const fontType = dataView.getUint8(headerStartIndex + typeOffset);
                 if (fontType === TDF_COLOR_FONT_TYPE) {
                     const letterSpacingRaw = dataView.getUint8(headerStartIndex + spaceOffset); const letterSpacing = letterSpacingRaw > 0 ? letterSpacingRaw - 1 : 0;
                     const blockSize = dataView.getUint16(headerStartIndex + sizeOffset, true); const offsets = {};
                     for (let i = 0; i < 94; i++) { const co = dataView.getUint16(headerStartIndex + tableOffset + i * 2, true); if (co !== 0xFFFF) offsets[SUPPORTED_CHAR_LIST[i]] = co; }
                     const dataBlockStartOffset = headerStartIndex + HEADER_METADATA_SIZE; // Calculated start
                     const baseFilename = path.basename(this.filePath, '.tdf'); const sanitizedBase = baseFilename.replace(/[^a-zA-Z0-9]/g, '_'); const sanitizedName = fontName.replace(/[^a-zA-Z0-9]/g, '_'); const uniqueKey = `${sanitizedBase}_${sanitizedName}`;
                     const fontData = { uniqueKey, internalName: fontName, type: fontType, spacing: letterSpacing, blockSize, offsets, dataBlockStartOffset }; this.fonts.push(fontData);
                 } currentOffset = headerStartIndex + TDF_HEADER_SIGNATURE.length;
             } catch (e) { console.error(`[${this.filePath}] Error parsing header at ${headerStartIndex}:`, e); currentOffset = headerStartIndex + 1; }
        } return this.fonts;
      }
     /** Extracts glyph data into intermediate format {w, h, stream: [byte, byte,...]} */
     extractIntermediateGlyphData(fontMeta, char) { // Extracts to intermediate byte stream
        const relativeOffset = fontMeta.offsets[char]; if (typeof relativeOffset === 'undefined') return null;
        const absoluteOffset = fontMeta.dataBlockStartOffset + relativeOffset; if (absoluteOffset + 2 > this.buffer.byteLength) return null;
        const dataView = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
        try {
            const glyphWidth = dataView.getUint8(absoluteOffset);
            const glyphHeight = dataView.getUint8(absoluteOffset + 1); // Reported height
            const byteStream = []; let currentReadOffset = absoluteOffset + 2; let eof = false; let actualHeight = 0; let lineHasChars = false;

            while (!eof) {
                if (currentReadOffset >= this.buffer.byteLength) { eof = true; break; }
                const charByte = dataView.getUint8(currentReadOffset++);
                if (charByte === 0x00) { eof = true; if (lineHasChars) actualHeight++; }
                else if (charByte === 0x0D) { byteStream.push(BIN_NEWLINE_CODE); actualHeight++; lineHasChars = false; }
                else { if (currentReadOffset >= this.buffer.byteLength) { eof = true; break; } const attrByte = dataView.getUint8(currentReadOffset++); byteStream.push(charByte, attrByte); lineHasChars = true; }
            }
            if (actualHeight === 0 && byteStream.length > 0) actualHeight = 1; // Min height 1 if data exists
            return { width: glyphWidth, height: actualHeight > 0 ? actualHeight : 1, stream: byteStream };
        } catch (e) { console.error(`[${this.filePath}] Intermediate glyph extraction error char "${char}" font "${fontMeta.internalName}":`, e); return null; }
     }
} // End TdfParserNode Class


// --- Main Script Logic ---

function main() {
    const args = process.argv.slice(2);
    if (args.length < 2) { console.error("Usage: node preprocess_tdf.js <input_tdf_dir> <output_bin_file>"); process.exit(1); }
    const inputDir = args[0]; const outputFile = args[1];

    const allFontsIntermediate = []; // Array to store { uniqueKey, spacing, glyphs: { char: {w,h,stream} } }
    let filesProcessed = 0;

    console.log(`Processing TDF files in directory: ${inputDir}`);
    try {
        const files = fs.readdirSync(inputDir);
        files.forEach(file => {
            if (path.extname(file).toLowerCase() !== '.tdf') return;
            const filePath = path.join(inputDir, file);
            try {
                const buffer = fs.readFileSync(filePath);
                const parser = new TdfParserNode(buffer, filePath);
                const parsedFontsInFile = parser.parse(); // Gets metadata

                parsedFontsInFile.forEach(fontMeta => {
                    const processedGlyphs = {}; let glyphsInFont = 0;
                    for (const char of SUPPORTED_CHAR_LIST) {
                        const glyphIntermediate = parser.extractIntermediateGlyphData(fontMeta, char);
                        if (glyphIntermediate) { processedGlyphs[char] = glyphIntermediate; glyphsInFont++; }
                    }
                    if (glyphsInFont > 0) {
                        allFontsIntermediate.push({ uniqueKey: fontMeta.uniqueKey, spacing: fontMeta.spacing, glyphs: processedGlyphs });
                    } else { console.warn(`[${filePath}] Font "${fontMeta.internalName}" had no glyphs.`); }
                });
                filesProcessed++;
            } catch (readError) { console.error(`Error processing file ${filePath}:`, readError); }
        });
    } catch (dirError) { console.error(`Error accessing input directory ${inputDir}:`, dirError); process.exit(1); }

    console.log(`Processed ${filesProcessed} TDF files. Found ${allFontsIntermediate.length} Color fonts with glyphs.`);
    if (allFontsIntermediate.length === 0) { console.log("No data to write."); return; }

    // --- Build Binary Bundle ---
    console.log("Building binary bundle...");

    // 1. Sort fonts by uniqueKey for the index
    allFontsIntermediate.sort((a, b) => a.uniqueKey.localeCompare(b.uniqueKey));

    // 2. Prepare String Pool and Font Index data
    const fontIndexTableData = []; // Stores { keyOffset, dataOffset }
    const stringPoolBuffers = [];
    let currentStringOffset = 0;
    allFontsIntermediate.forEach(fontInfo => {
        const keyBuffer = Buffer.from(fontInfo.uniqueKey + '\0', 'utf8'); // Null terminate
        stringPoolBuffers.push(keyBuffer);
        fontIndexTableData.push({ keyOffset: currentStringOffset, dataOffset: 0 }); // Placeholder for data offset
        currentStringOffset += keyBuffer.length;
    });
    const stringPoolBuffer = Buffer.concat(stringPoolBuffers);

    // 3. Prepare Font Data Pool and update data offsets in index
    const fontDataPoolBuffers = [];
    let currentDataOffset = 0;
    allFontsIntermediate.forEach((fontInfo, index) => {
        fontIndexTableData[index].dataOffset = currentDataOffset; // Update data offset for this font

        const fontSpecificBuffers = [];
        // Write spacing
        const spacingBuf = Buffer.alloc(1); spacingBuf.writeUInt8(fontInfo.spacing, 0);
        fontSpecificBuffers.push(spacingBuf);

        // Prepare glyph lookup table and glyph data bytes
        const glyphEntries = Object.entries(fontInfo.glyphs).sort((a, b) => a[0].charCodeAt(0) - b[0].charCodeAt(0)); // Sort by char code
        const glyphCount = glyphEntries.length;
        const glyphCountBuf = Buffer.alloc(1); glyphCountBuf.writeUInt8(glyphCount, 0);
        fontSpecificBuffers.push(glyphCountBuf);

        const lookupTableSize = glyphCount * 3; // 1 byte char, 2 bytes offset
        const lookupTableBuf = Buffer.alloc(lookupTableSize);
        const glyphDataBuffers = [];
        let currentGlyphDataRelativeOffset = 0; // Offset relative to start of GDT for this font

        glyphEntries.forEach(([char, glyph], i) => {
            // Write lookup entry
            const lookupOffset = i * 3;
            lookupTableBuf.writeUInt8(char.charCodeAt(0), lookupOffset);
            lookupTableBuf.writeUInt16LE(currentGlyphDataRelativeOffset, lookupOffset + 1);

            // Prepare glyph data buffer
            const glyphHeaderBuf = Buffer.alloc(2);
            glyphHeaderBuf.writeUInt8(glyph.width, 0);
            glyphHeaderBuf.writeUInt8(glyph.height, 1);
            const glyphStreamBuf = Buffer.from(glyph.stream);
            const glyphEndBuf = Buffer.alloc(1); glyphEndBuf.writeUInt8(BIN_GLYPH_TERMINATOR, 0); // Null terminator

            const singleGlyphBuf = Buffer.concat([glyphHeaderBuf, glyphStreamBuf, glyphEndBuf]);
            glyphDataBuffers.push(singleGlyphBuf);
            currentGlyphDataRelativeOffset += singleGlyphBuf.length;
        });

        fontSpecificBuffers.push(lookupTableBuf);
        fontSpecificBuffers.push(...glyphDataBuffers); // Add all glyph data buffers

        const fontDataBlock = Buffer.concat(fontSpecificBuffers);
        fontDataPoolBuffers.push(fontDataBlock);
        currentDataOffset += fontDataBlock.length;
    });
    const fontDataPoolBuffer = Buffer.concat(fontDataPoolBuffers);

    // 4. Prepare final Font Index Table buffer
    const fontIndexTableBuf = Buffer.alloc(allFontsIntermediate.length * 8); // 4 bytes key offset, 4 bytes data offset
    fontIndexTableData.forEach((entry, i) => {
        fontIndexTableBuf.writeUInt32LE(entry.keyOffset, i * 8);
        fontIndexTableBuf.writeUInt32LE(entry.dataOffset, i * 8 + 4);
    });

    // 5. Prepare Header
    const headerSize = 21; // Magic(4) + Ver(1) + Count(4) + IdxOff(4) + StrOff(4) + DataOff(4)
    const headerBuf = Buffer.alloc(headerSize);
    let offset = 0;
    offset += headerBuf.write(BIN_MAGIC, offset, 'ascii');
    offset = headerBuf.writeUInt8(BIN_VERSION, offset);
    offset = headerBuf.writeUInt32LE(allFontsIntermediate.length, offset); // Font Count
    const indexTableOffset = headerSize;
    const stringPoolOffset = indexTableOffset + fontIndexTableBuf.length;
    const fontDataPoolOffset = stringPoolOffset + stringPoolBuffer.length;
    offset = headerBuf.writeUInt32LE(indexTableOffset, offset);
    offset = headerBuf.writeUInt32LE(stringPoolOffset, offset);
    headerBuf.writeUInt32LE(fontDataPoolOffset, offset);

    // 6. Concatenate all parts
    const finalBuffer = Buffer.concat([
        headerBuf,
        fontIndexTableBuf,
        stringPoolBuffer,
        fontDataPoolBuffer
    ]);

    // 7. Write to file
    console.log(`Writing binary bundle (${finalBuffer.length} bytes) to: ${outputFile}`);
    try {
        fs.writeFileSync(outputFile, finalBuffer);
        console.log("Binary bundle created successfully.");
    } catch (writeError) {
        console.error(`Error writing binary file ${outputFile}:`, writeError);
    }
}

main();