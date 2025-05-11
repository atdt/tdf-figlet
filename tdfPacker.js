#!/usr/bin/env node

// tdfPacker.js v4.0
// Preprocesses TheDraw Font (.TDF) files into a single binary bundle
// according to TDF Font Bundle Specification v4.0.
// Implements:
// - Implicit glyph structure (padding ragged lines)
// - Local palette of (Character, Attribute) pairs per font
// - Run-Length Encoding (RLE) for cell streams
// - Alphabetical sorting of fonts by uniqueKey in the bundle

import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
// No crypto needed for this version as SHA-1 sorting is removed

// --- TDF Format Constants ---
const TDF_COLOR_FONT_TYPE = 2;
const TDF_HEADER_SIGNATURE = Buffer.from([0x55, 0xaa, 0x00, 0xff]);
const TDF_FONT_METADATA_BLOCK_SIZE = 213;

// --- Binary Bundle Constants (v4.0) ---
const BIN_MAGIC_STRING = "TDFB";
const BIN_BUNDLE_VERSION = 4;

// --- RLE Constants ---
const RLE_ESCAPE_BYTE = 0xff;
const RLE_MIN_RUN_LENGTH = 3; // Smallest run to encode (actual length)
const RLE_MAX_RUN_BYTE_VALUE = 255; // Max value for the run_length_byte
const RLE_MAX_ACTUAL_RUN = RLE_MAX_RUN_BYTE_VALUE + RLE_MIN_RUN_LENGTH; // Max encodable run length (258)

// --- Padding Pair Definition ---
const PADDING_CHAR = 0x20; // Space
const PADDING_ATTR = 0x00; // Black on Black

// --- General Constants ---
const SUPPORTED_CHAR_LIST =
  "!\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";

/**
 * TDF Parser class.
 * Extracts font metadata and raw glyph cell data.
 */
class TdfParser {
  constructor(buffer, filePath = "unknown") {
    if (!buffer || !(buffer instanceof Buffer) || buffer.byteLength < TDF_FONT_METADATA_BLOCK_SIZE) {
      throw new Error(`[${filePath}] Invalid or too small TDF buffer.`);
    }
    this.buffer = buffer;
    this.filePath = filePath;
    this.dataView = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
  }

  _findNextTdfHeader(searchStartOffset) {
    for (let offset = searchStartOffset; offset <= this.buffer.length - TDF_HEADER_SIGNATURE.length; offset++) {
      if (
        this.buffer.compare(
          TDF_HEADER_SIGNATURE,
          0,
          TDF_HEADER_SIGNATURE.length,
          offset,
          offset + TDF_HEADER_SIGNATURE.length,
        ) === 0
      ) {
        return offset;
      }
    }
    return -1;
  }

  _extractFontMetadataFromHeader(headerStartIndex) {
    const nameLenOffset = headerStartIndex + 4;
    const nameCharsOffset = headerStartIndex + 5;
    const typeOffset = headerStartIndex + 21;
    const spacingOffset = headerStartIndex + 22;
    const charTableOffset = headerStartIndex + 25;

    if (headerStartIndex + TDF_FONT_METADATA_BLOCK_SIZE > this.dataView.byteLength) return null;

    try {
      const fontNameLength = Math.min(this.dataView.getUint8(nameLenOffset), 12);
      let fontName = "";
      for (let i = 0; i < fontNameLength; i++) {
        const charCodeValue = this.dataView.getUint8(nameCharsOffset + i);
        if (charCodeValue === 0) break;
        fontName += String.fromCharCode(charCodeValue);
      }
      fontName = fontName.trim();
      const fontType = this.dataView.getUint8(typeOffset);

      if (fontType !== TDF_COLOR_FONT_TYPE) return null; // Only process color fonts

      const letterSpacingRaw = this.dataView.getUint8(spacingOffset);
      const spacing = letterSpacingRaw > 0 ? letterSpacingRaw - 1 : 0;
      const charGlyphOffsets = {};
      for (let i = 0; i < SUPPORTED_CHAR_LIST.length; i++) {
        const charOffsetInTdf = this.dataView.getUint16(charTableOffset + i * 2, true);
        if (charOffsetInTdf !== 0xffff) charGlyphOffsets[SUPPORTED_CHAR_LIST[i]] = charOffsetInTdf;
      }
      const dataBlockStartOffset = headerStartIndex + TDF_FONT_METADATA_BLOCK_SIZE;
      const baseFilename = path.basename(this.filePath, ".tdf");
      const sanitizedBase = baseFilename.replace(/[^a-zA-Z0-9_.-]/g, "_");
      const sanitizedName = fontName.replace(/[^a-zA-Z0-9_.-]/g, "_");
      const uniqueKey = `${sanitizedBase}_${sanitizedName || "UnnamedFont"}`;

      return {
        uniqueKey,
        internalName: fontName,
        type: fontType,
        spacing,
        offsets: charGlyphOffsets,
        dataBlockStartOffset,
      };
    } catch (e) {
      console.error(`[${this.filePath}] Error parsing TDF metadata at offset ${headerStartIndex}:`, e);
      return null;
    }
  }

  parseFontHeaders() {
    const fonts = [];
    let currentSearchOffset = 0;
    while (currentSearchOffset < this.buffer.length) {
      const headerStartIndex = this._findNextTdfHeader(currentSearchOffset);
      if (headerStartIndex === -1) break;
      const fontMetadata = this._extractFontMetadataFromHeader(headerStartIndex);
      if (fontMetadata) fonts.push(fontMetadata);
      currentSearchOffset = headerStartIndex + TDF_HEADER_SIGNATURE.length;
    }
    return fonts;
  }

  /**
   * Extracts raw cell data and dimensions for a single glyph.
   * @returns {{declaredWidth: number, actualHeight: number, lines: Array<Array<{charByte:number, attrByte:number}>>} | null}
   */
  extractRawGlyphCellsAndDimensions(fontMeta, charKey) {
    const relativeOffset = fontMeta.offsets[charKey];
    if (typeof relativeOffset === "undefined") return null;

    const absoluteOffset = fontMeta.dataBlockStartOffset + relativeOffset;
    if (absoluteOffset + 2 > this.buffer.byteLength) return null; // Need at least width/height

    const declaredWidth = this.dataView.getUint8(absoluteOffset);
    // const tdfDeclaredHeight = this.dataView.getUint8(absoluteOffset + 1); // Not reliable for actual lines

    let currentReadOffset = absoluteOffset + 2; // Start after width/height
    const lines = [];
    let currentLine = [];
    let eofReached = false;

    while (!eofReached) {
      if (currentReadOffset >= this.buffer.byteLength) {
        // This case means the TDF glyph stream didn't end with a 0x00, which is unusual.
        console.warn(
          `[${this.filePath}] Glyph for '${charKey}' in font '${fontMeta.uniqueKey}' ended prematurely (no 0x00).`,
        );
        eofReached = true; // Force break after this potential partial line
      }
      // Read byte only if not already at EOF from premature end
      const byte = eofReached ? 0x00 : this.dataView.getUint8(currentReadOffset++);

      if (byte === 0x00) {
        // End of glyph
        // Add the last line if it has content, or if it's the very first line (even if empty, for empty glyphs)
        if (currentLine.length > 0 || lines.length === 0) {
          lines.push(currentLine);
        }
        eofReached = true;
      } else if (byte === 0x0d) {
        // Newline
        lines.push(currentLine);
        currentLine = [];
      } else {
        // Character byte
        if (currentReadOffset >= this.buffer.byteLength) {
          // Missing attribute byte
          console.warn(
            `[${this.filePath}] Glyph for '${charKey}' in font '${fontMeta.uniqueKey}' missing attribute byte for char 0x${byte.toString(16)}.`,
          );
          eofReached = true; // Treat as end of glyph
          if (currentLine.length > 0 || lines.length === 0) lines.push(currentLine); // Add potentially incomplete line
          break; // Exit loop as data is malformed
        }
        const attrByte = this.dataView.getUint8(currentReadOffset++);
        currentLine.push({ charByte: byte, attrByte });
      }
    }
    // Ensure at least one line for empty glyphs (e.g. space defined with width/height but no cells before 0x00)
    const actualHeight = lines.length > 0 ? lines.length : 1;
    return { declaredWidth, actualHeight, lines };
  }
}

/**
 * Builds a local pair palette for a font.
 * @param {Array<Array<{charByte:number, attrByte:number}>>} allGlyphLinesData - All lines from all glyphs of the font.
 * @param {boolean} requiresPadding - Whether any glyph in the font needs padding.
 * @returns {{pairPalette: Array<{char:number, attr:number}>, nPairs: number} | null} Palette or null if too many pairs.
 */
function buildLocalPairPalette(allGlyphLinesData, requiresPadding) {
  const uniquePairsSet = new Map(); // Using map to store pair as string key for uniqueness

  for (const glyphLines of allGlyphLinesData) {
    // glyphLines is an array of lines for one glyph
    for (const line of glyphLines) {
      // line is an array of cells
      for (const cell of line) {
        // cell is {charByte, attrByte}
        const pairKey = `${cell.charByte},${cell.attrByte}`;
        if (!uniquePairsSet.has(pairKey)) {
          uniquePairsSet.set(pairKey, { char: cell.charByte, attr: cell.attrByte });
        }
      }
    }
  }

  const paddingPairKey = `${PADDING_CHAR},${PADDING_ATTR}`;
  if (requiresPadding && !uniquePairsSet.has(paddingPairKey)) {
    uniquePairsSet.set(paddingPairKey, { char: PADDING_CHAR, attr: PADDING_ATTR });
  }

  const pairPalette = Array.from(uniquePairsSet.values());
  // Canonical sort for deterministic output (important for consistent bundle generation)
  pairPalette.sort((a, b) => {
    if (a.char !== b.char) return a.char - b.char;
    return a.attr - b.attr;
  });

  const nPairs = pairPalette.length;
  if (nPairs > 254) {
    // 0xFF is RLE_ESCAPE_BYTE
    console.error(
      `Font has ${nPairs} unique (char,attr) pairs, exceeding limit of 254. Cannot encode with current RLE scheme.`,
    );
    return null;
  }
  return { pairPalette, nPairs };
}

/**
 * Encodes a single glyph's cell data into an RLE stream of pair palette indices.
 * @param {object} rawGlyph - {declaredWidth, actualHeight, lines}
 * @param {Array<{char:number, attr:number}>} pairPalette - The font's local pair palette.
 * @param {Map<string, number>} pairToIndexMap - Precomputed map for fast lookups.
 * @returns {Buffer} RLE-encoded byte stream.
 */
function encodeGlyphToRLEStream(rawGlyph, pairPalette, pairToIndexMap) {
  const { declaredWidth, actualHeight, lines } = rawGlyph;
  const paddingPairIndex = pairToIndexMap.get(`${PADDING_CHAR},${PADDING_ATTR}`);

  // This check is important if padding is determined to be needed globally for the font
  if (typeof paddingPairIndex === "undefined" && lines.some((line) => line.length < declaredWidth)) {
    console.warn(
      "Padding pair not found in palette for a glyph that appears to need padding. This could lead to errors if padding is attempted.",
    );
    // Depending on strictness, could throw error or try to proceed without padding that cell.
    // The buildLocalPairPalette should have added it if fontRequiresPadding was true.
  }

  const flatIndexStream = [];
  for (let y = 0; y < actualHeight; y++) {
    const line = lines[y] || []; // Handle case where a line might be missing (though actualHeight should be accurate)
    for (let x = 0; x < declaredWidth; x++) {
      let pairIndex;
      if (x < line.length) {
        const cell = line[x];
        pairIndex = pairToIndexMap.get(`${cell.charByte},${cell.attrByte}`);
      } else {
        // Padding needed for this cell
        pairIndex = paddingPairIndex; // Use the pre-determined padding pair index
      }

      if (typeof pairIndex === "undefined") {
        // This signifies an issue: either the cell pair wasn't in the original data for palette generation,
        // or the padding pair wasn't correctly added/found.
        console.error(
          `Error: Pair not found in palette during RLE encoding. Cell data: ${x < line.length ? JSON.stringify(line[x]) : "PADDING CELL"}. Using index 0 as fallback.`,
        );
        pairIndex = 0; // Fallback to avoid crash, but indicates a data integrity issue.
      }
      flatIndexStream.push(pairIndex);
    }
  }

  const rleEncodedStream = [];
  let i = 0;
  while (i < flatIndexStream.length) {
    const currentIndex = flatIndexStream[i];
    let runLength = 1;
    // Find how long the current index repeats
    while (
      runLength < RLE_MAX_ACTUAL_RUN && // Ensure runLength doesn't exceed max encodable
      i + runLength < flatIndexStream.length &&
      flatIndexStream[i + runLength] === currentIndex
    ) {
      runLength++;
    }

    // Encode the run
    if (currentIndex === RLE_ESCAPE_BYTE || runLength >= RLE_MIN_RUN_LENGTH) {
      // If the literal index is the escape byte OR the run is long enough, use RLE
      rleEncodedStream.push(RLE_ESCAPE_BYTE);
      rleEncodedStream.push(runLength - RLE_MIN_RUN_LENGTH); // run_length_byte (0 means actual run of 3)
      rleEncodedStream.push(currentIndex); // The index being repeated
      i += runLength;
    } else {
      // Literal, runLength is 1 or 2, and currentIndex is not the RLE_ESCAPE_BYTE
      // Write out literals for short runs
      for (let j = 0; j < runLength; j++) {
        rleEncodedStream.push(flatIndexStream[i + j]);
      }
      i += runLength;
    }
  }
  return Buffer.from(rleEncodedStream);
}

// --- Bundle Assembly Functions ---
function _buildStringPoolAndIndexPlaceholders(processedFonts) {
  const fontIndexTableData = [];
  const stringPoolBuffers = [];
  let currentStringOffset = 0;
  for (const font of processedFonts) {
    const keyBuffer = Buffer.from(`${font.uniqueKey}\0`, "utf8");
    stringPoolBuffers.push(keyBuffer);
    fontIndexTableData.push({ keyOffsetInPool: currentStringOffset, dataOffsetInPool: 0 }); // dataOffset is placeholder
    currentStringOffset += keyBuffer.length;
  }
  return { fontIndexTableData, stringPoolBuffer: Buffer.concat(stringPoolBuffers) };
}

function _buildFontDataPool(processedFonts, fontIndexTableData) {
  const fontDataPoolBuffers = [];
  let currentDataPoolOffset = 0;

  for (const [fontArrIndex, fontInfo] of processedFonts.entries()) {
    fontIndexTableData[fontArrIndex].dataOffsetInPool = currentDataPoolOffset; // Update real offset
    const singleFontBlockBuffers = [];

    // 1. Font Spacing
    const spacingBuffer = Buffer.alloc(1);
    spacingBuffer.writeUInt8(fontInfo.spacing, 0);
    singleFontBlockBuffers.push(spacingBuffer);

    // 2. Number of Pairs (nPairs)
    const nPairsBuffer = Buffer.alloc(1);
    nPairsBuffer.writeUInt8(fontInfo.nPairs, 0);
    singleFontBlockBuffers.push(nPairsBuffer);

    // 3. Pair Palette Data
    const paletteDataBuffer = Buffer.alloc(fontInfo.nPairs * 2);
    let paletteOffset = 0;
    for (const pair of fontInfo.pairPalette) {
      // pairPalette is already canonically sorted
      paletteDataBuffer.writeUInt8(pair.char, paletteOffset++);
      paletteDataBuffer.writeUInt8(pair.attr, paletteOffset++);
    }
    singleFontBlockBuffers.push(paletteDataBuffer);

    // 4. Glyph Count (G)
    const glyphCount = Object.keys(fontInfo.encodedGlyphs).length;
    const glyphCountBuffer = Buffer.alloc(1);
    glyphCountBuffer.writeUInt8(glyphCount, 0);
    singleFontBlockBuffers.push(glyphCountBuffer);

    // 5. Glyph Lookup Table (GLT) & 6. Glyph Data Table (GDT)
    // Glyphs for GLT must be sorted by character code
    const glyphEntries = Object.entries(fontInfo.encodedGlyphs).sort((a, b) => a[0].charCodeAt(0) - b[0].charCodeAt(0));
    const gltBuffer = Buffer.alloc(glyphCount * 3);
    const gdtBuffers = [];
    let currentGdtRelativeOffset = 0;

    for (const [entryIndex, [charKey, glyphData]] of glyphEntries.entries()) {
      const gltEntryOffset = entryIndex * 3;
      gltBuffer.writeUInt8(charKey.charCodeAt(0), gltEntryOffset);
      gltBuffer.writeUInt16LE(currentGdtRelativeOffset, gltEntryOffset + 1);

      const glyphHeaderBuffer = Buffer.alloc(2); // Width, Height
      glyphHeaderBuffer.writeUInt8(glyphData.width, 0);
      glyphHeaderBuffer.writeUInt8(glyphData.height, 1);
      gdtBuffers.push(glyphHeaderBuffer);
      gdtBuffers.push(glyphData.rleStream); // The RLE encoded stream

      currentGdtRelativeOffset += 2 + glyphData.rleStream.length;
    }
    singleFontBlockBuffers.push(gltBuffer);
    singleFontBlockBuffers.push(...gdtBuffers);

    const completeFontDataBlock = Buffer.concat(singleFontBlockBuffers);
    fontDataPoolBuffers.push(completeFontDataBlock);
    currentDataPoolOffset += completeFontDataBlock.length;
  }
  return Buffer.concat(fontDataPoolBuffers);
}

function _finalizeFontIndexTable(fontIndexTableData) {
  const fontIndexTableBuffer = Buffer.alloc(fontIndexTableData.length * 8);
  for (const [i, entry] of fontIndexTableData.entries()) {
    fontIndexTableBuffer.writeUInt32LE(entry.keyOffsetInPool, i * 8);
    fontIndexTableBuffer.writeUInt32LE(entry.dataOffsetInPool, i * 8 + 4);
  }
  return fontIndexTableBuffer;
}

function _buildBundleHeader(numFonts, indexTableLength, stringPoolLength) {
  const headerSize = 21; // Magic(4) + Ver(1) + FontCount(4) + IndexOffset(4) + StringOffset(4) + DataOffset(4)
  const headerBuffer = Buffer.alloc(headerSize);
  let offset = 0;
  offset += headerBuffer.write(BIN_MAGIC_STRING, offset, "ascii");
  offset = headerBuffer.writeUInt8(BIN_BUNDLE_VERSION, offset);
  offset = headerBuffer.writeUInt32LE(numFonts, offset);
  const indexTableAbsoluteOffset = headerSize;
  const stringPoolAbsoluteOffset = indexTableAbsoluteOffset + indexTableLength;
  const fontDataPoolAbsoluteOffset = stringPoolAbsoluteOffset + stringPoolLength;
  offset = headerBuffer.writeUInt32LE(indexTableAbsoluteOffset, offset);
  offset = headerBuffer.writeUInt32LE(stringPoolAbsoluteOffset, offset);
  headerBuffer.writeUInt32LE(fontDataPoolAbsoluteOffset, offset);
  return headerBuffer;
}

// --- Main Function ---
function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error("Usage: node tdfPacker.js <input_tdf_directory> <output_bin_file_path>");
    process.exit(1);
  }
  const inputDirectory = args[0];
  const outputFilePath = args[1];

  console.log(`tdfPacker.js (Bundle Version: ${BIN_BUNDLE_VERSION})`);
  console.log("Starting TDF preprocessing...");
  console.log(`Input directory: ${path.resolve(inputDirectory)}`);
  console.log(`Output file:     ${path.resolve(outputFilePath)}`);

  const processedFontsData = [];
  let filesScanned = 0;

  try {
    const filesInDir = fs.readdirSync(inputDirectory);
    for (const file of filesInDir) {
      if (path.extname(file).toLowerCase() !== ".tdf") continue;
      filesScanned++;
      const fullFilePath = path.join(inputDirectory, file);
      try {
        const tdfFileBuffer = fs.readFileSync(fullFilePath);
        const parser = new TdfParser(tdfFileBuffer, fullFilePath);
        const parsedFontHeaders = parser.parseFontHeaders(); // Only returns color fonts

        for (const fontMeta of parsedFontHeaders) {
          const allGlyphRawData = {}; // Stores {declaredWidth, actualHeight, lines} for each charKey
          let fontRequiresPadding = false;
          const allCellPairsForFontPalette = []; // Collects all {charByte, attrByte} for palette generation

          for (const charKey of SUPPORTED_CHAR_LIST) {
            const rawGlyph = parser.extractRawGlyphCellsAndDimensions(fontMeta, charKey);
            if (rawGlyph) {
              allGlyphRawData[charKey] = rawGlyph;
              // Check for padding requirement and collect cells for palette
              for (const line of rawGlyph.lines) {
                if (line.length < rawGlyph.declaredWidth) {
                  fontRequiresPadding = true;
                }
                allCellPairsForFontPalette.push(...line); // Add all cells from this line
              }
              // If a glyph is empty but has dimensions, it implies padding.
              if (
                rawGlyph.lines.every((line) => line.length === 0) &&
                rawGlyph.declaredWidth > 0 &&
                rawGlyph.actualHeight > 0
              ) {
                fontRequiresPadding = true;
              }
            }
          }

          if (Object.keys(allGlyphRawData).length === 0) {
            // console.log(`Skipping font ${fontMeta.uniqueKey} as it has no defined glyphs.`);
            continue;
          }

          const paletteResult = buildLocalPairPalette(
            Object.values(allGlyphRawData).map((g) => g.lines), // Pass array of all lines from all glyphs
            fontRequiresPadding,
          );

          if (!paletteResult) {
            console.warn(`Skipping font ${fontMeta.uniqueKey} due to too many unique pairs for its palette.`);
            continue;
          }
          const { pairPalette, nPairs } = paletteResult;

          // Create pairToIndexMap once for the font for efficient lookups
          const pairToIndexMap = new Map();
          for (const [index, pair] of pairPalette.entries()) {
            pairToIndexMap.set(`${pair.char},${pair.attr}`, index);
          }

          const encodedGlyphs = {};
          for (const charKey of Object.keys(allGlyphRawData)) {
            const rawGlyph = allGlyphRawData[charKey];
            const rleStream = encodeGlyphToRLEStream(rawGlyph, pairPalette, pairToIndexMap);
            encodedGlyphs[charKey] = {
              width: rawGlyph.declaredWidth,
              height: rawGlyph.actualHeight,
              rleStream: rleStream,
            };
          }

          processedFontsData.push({
            uniqueKey: fontMeta.uniqueKey,
            spacing: fontMeta.spacing,
            nPairs,
            pairPalette, // Stored for writing to bundle (already canonically sorted)
            encodedGlyphs,
            // No SHA1 hash needed for this version
          });
        }
        console.log(`Processed file: ${file} (found ${parsedFontHeaders.length} color fonts)`);
      } catch (readOrParseError) {
        console.error(`Error processing file ${fullFilePath}:`, readOrParseError.message, readOrParseError.stack);
      }
    }
  } catch (dirAccessError) {
    console.error(`Fatal error accessing input directory ${inputDirectory}:`, dirAccessError.message);
    process.exit(1);
  }

  console.log(`\nSuccessfully processed data from ${filesScanned} TDF files.`);
  console.log(`Collected ${processedFontsData.length} color fonts for the bundle.`);

  if (processedFontsData.length === 0) {
    console.log("No font data to write to bundle. Exiting.");
    return;
  }

  // Sort fonts alphabetically by uniqueKey
  processedFontsData.sort((a, b) => a.uniqueKey.localeCompare(b.uniqueKey));
  console.log("\nFonts sorted alphabetically by uniqueKey.");

  console.log("Building binary bundle components...");
  const { fontIndexTableData, stringPoolBuffer } = _buildStringPoolAndIndexPlaceholders(processedFontsData);
  const fontDataPoolBuffer = _buildFontDataPool(processedFontsData, fontIndexTableData); // Pass sorted data
  const numFonts = processedFontsData.length;
  const finalFontIndexTableBuffer = _finalizeFontIndexTable(fontIndexTableData);
  const headerBuffer = _buildBundleHeader(numFonts, finalFontIndexTableBuffer.length, stringPoolBuffer.length);

  const finalBundleBuffer = Buffer.concat([
    headerBuffer,
    finalFontIndexTableBuffer,
    stringPoolBuffer,
    fontDataPoolBuffer,
  ]);

  console.log(`\nWriting binary bundle (${finalBundleBuffer.length} bytes) to: ${outputFilePath}`);
  try {
    const outputDir = path.dirname(outputFilePath);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(outputFilePath, finalBundleBuffer);
    console.log(`Binary font bundle created successfully! Bundle Version: ${BIN_BUNDLE_VERSION}`);
    console.log(
      "Consider post-processing with Zopfli for further GZip optimization: zopfli --deflate --i1000 <output_bin_file_path>",
    );
  } catch (writeError) {
    console.error(`Fatal error writing binary file ${outputFilePath}:`, writeError.message);
    process.exit(1);
  }
}

main();
