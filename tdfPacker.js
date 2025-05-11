#!/usr/bin/env node

// tdfPacker.js (Bundle Version: 4.0)
// Preprocesses TheDraw Font (.TDF) files from a directory into a single binary bundle
// according to TDF Font Bundle Specification v4.0.
// This version implements:
// - Implicit glyph structure (encoder pads ragged lines from original TDF).
// - Local palette of (Character Code, Color Attribute) pairs per font.
// - Run-Length Encoding (RLE) for the stream of pair palette indices.
// - Alphabetical sorting of fonts by their uniqueKey within the final bundle.

import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";

// --- TDF Format Constants (from original .TDF file structure) ---
const TDF_COLOR_FONT_TYPE = 2; // Identifier for TDF color fonts.
const TDF_HEADER_SIGNATURE = Buffer.from([0x55, 0xaa, 0x00, 0xff]); // Marks start of a TDF font header.
const TDF_FONT_METADATA_BLOCK_SIZE = 213; // Size in bytes from TDF_HEADER_SIGNATURE to end of char offset table.

// --- Binary Bundle Constants (Output .bin file structure - v4.0) ---
const BIN_MAGIC_STRING = "TDFB"; // Magic string for "TDF Bundle".
const BIN_BUNDLE_VERSION = 4; // Version number of this binary bundle format.

// --- RLE (Run-Length Encoding) Constants ---
const RLE_ESCAPE_BYTE = 0xff; // Byte value used to indicate an RLE sequence.
const RLE_MIN_RUN_LENGTH = 3; // The smallest actual run of identical indices to be RLE encoded.
// Runs shorter than this are stored as literal indices.
const RLE_MAX_RUN_BYTE_VALUE = 255; // Maximum value for the byte that stores (actual_run_length - RLE_MIN_RUN_LENGTH).
const RLE_MAX_ACTUAL_RUN = RLE_MAX_RUN_BYTE_VALUE + RLE_MIN_RUN_LENGTH; // Max encodable run length (255 + 3 = 258).

// --- Padding Pair Definition ---
// Used by the encoder to make ragged TDF glyphs into dense rectangular blocks.
const PADDING_CHAR = 0x20; // Space character (CP437).
const PADDING_ATTR = 0x00; // Black on Black color attribute.

// --- General Constants ---
// Standard list of 94 printable ASCII characters for which TDFs typically store glyphs.
const SUPPORTED_CHAR_LIST =
  "!\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";

/**
 * TDF Parser class.
 * Responsible for reading raw .TDF file data, identifying individual font headers,
 * and extracting metadata and raw glyph cell data for color fonts.
 */
class TdfParser {
  /**
   * @param {Buffer} buffer - The raw buffer data of the TDF file.
   * @param {string} [filePath='unknown'] - Path to the TDF file, used for logging.
   * @throws {Error} If the buffer is invalid or too small to contain TDF data.
   */
  constructor(buffer, filePath = "unknown") {
    if (!buffer || !(buffer instanceof Buffer) || buffer.byteLength < TDF_FONT_METADATA_BLOCK_SIZE) {
      throw new Error(`[${filePath}] Invalid or too small TDF buffer provided.`);
    }
    this.buffer = buffer;
    this.filePath = filePath;
    this.dataView = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
  }

  /**
   * Finds the next occurrence of the TDF_HEADER_SIGNATURE in the buffer.
   * @param {number} searchStartOffset - Offset in the buffer to start searching from.
   * @returns {number} Starting index of the signature, or -1 if not found.
   * @private
   */
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

  /**
   * Extracts metadata for a single font from its TDF header block.
   * @param {number} headerStartIndex - Starting offset of the TDF font header (where TDF_HEADER_SIGNATURE begins).
   * @returns {object | null} An object containing font metadata if a color font is successfully parsed, otherwise null.
   * Metadata includes: uniqueKey, internalName, type, spacing, offsets (map of char to TDF offset), dataBlockStartOffset.
   * @private
   */
  _extractFontMetadataFromHeader(headerStartIndex) {
    // Offsets relative to the start of the TDF_HEADER_SIGNATURE.
    const nameLenOffset = headerStartIndex + 4;
    const nameCharsOffset = headerStartIndex + 5;
    const typeOffset = headerStartIndex + 21; // Font Type (00=Outline, 01=Block, 02=Color)
    const spacingOffset = headerStartIndex + 22; // Letter Spacing
    const charTableOffset = headerStartIndex + 25; // Start of the 94-character offset table

    // Ensure there's enough data for the entire metadata block.
    if (headerStartIndex + TDF_FONT_METADATA_BLOCK_SIZE > this.dataView.byteLength) return null;

    try {
      const fontNameLength = Math.min(this.dataView.getUint8(nameLenOffset), 12); // Name length, max 12.
      let fontName = "";
      for (let i = 0; i < fontNameLength; i++) {
        const charCodeValue = this.dataView.getUint8(nameCharsOffset + i);
        if (charCodeValue === 0) break; // Null terminator for name.
        fontName += String.fromCharCode(charCodeValue);
      }
      fontName = fontName.trim();

      const fontType = this.dataView.getUint8(typeOffset);
      if (fontType !== TDF_COLOR_FONT_TYPE) return null; // This packer only processes color fonts.

      const letterSpacingRaw = this.dataView.getUint8(spacingOffset);
      // TDF spacing is 1-based (1-41 maps to 0-40).
      const spacing = letterSpacingRaw > 0 ? letterSpacingRaw - 1 : 0;

      const charGlyphOffsets = {}; // Map: char -> offset in TDF data block
      for (let i = 0; i < SUPPORTED_CHAR_LIST.length; i++) {
        // Offsets are Uint16LE. 0xFFFF means character not defined.
        const charOffsetInTdf = this.dataView.getUint16(charTableOffset + i * 2, true);
        if (charOffsetInTdf !== 0xffff) {
          charGlyphOffsets[SUPPORTED_CHAR_LIST[i]] = charOffsetInTdf;
        }
      }

      // The actual character cell data starts after the fixed-size metadata block.
      const dataBlockStartOffset = headerStartIndex + TDF_FONT_METADATA_BLOCK_SIZE;

      // Generate a unique key for this font.
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

  /**
   * Parses the entire TDF buffer to find all color font definitions.
   * @returns {Array<object>} An array of font metadata objects for each color font found.
   */
  parseFontHeaders() {
    const fonts = [];
    let currentSearchOffset = 0;
    while (currentSearchOffset < this.buffer.length) {
      const headerStartIndex = this._findNextTdfHeader(currentSearchOffset);
      if (headerStartIndex === -1) break; // No more TDF headers found.
      const fontMetadata = this._extractFontMetadataFromHeader(headerStartIndex);
      if (fontMetadata) {
        // Only add if it's a color font and parsed successfully.
        fonts.push(fontMetadata);
      }
      // Advance search past the signature of the current header to find the next one.
      currentSearchOffset = headerStartIndex + TDF_HEADER_SIGNATURE.length;
    }
    return fonts;
  }

  /**
   * Extracts raw cell data (charByte, attrByte pairs) and calculates dimensions for a single glyph.
   * This function reads the original TDF glyph stream with its explicit newlines (0x0D) and terminator (0x00).
   * @param {object} fontMeta - Metadata of the font containing the glyph.
   * @param {string} charKey - The character (e.g., 'A') whose glyph is to be extracted.
   * @returns {{declaredWidth: number, actualHeight: number, lines: Array<Array<{charByte:number, attrByte:number}>>} | null}
   * An object with the glyph's declared width, its actual height in lines, and an array of lines,
   * where each line is an array of {charByte, attrByte} cells. Returns null if glyph not found or error.
   */
  extractRawGlyphCellsAndDimensions(fontMeta, charKey) {
    const relativeOffset = fontMeta.offsets[charKey];
    if (typeof relativeOffset === "undefined") return null; // Character not defined in this font.

    const absoluteOffset = fontMeta.dataBlockStartOffset + relativeOffset;
    // Each TDF glyph starts with 2 bytes: declaredWidth, tdfDeclaredHeight.
    if (absoluteOffset + 2 > this.buffer.byteLength) return null;

    const declaredWidth = this.dataView.getUint8(absoluteOffset);
    // Note: The TDF's declared height (at absoluteOffset + 1) is often unreliable for determining actual lines.
    // We calculate actualHeight by counting newlines and the final terminator.

    let currentReadOffset = absoluteOffset + 2; // Start reading cell data after width/height.
    const lines = [];
    let currentLine = [];
    let eofReached = false;

    while (!eofReached) {
      if (currentReadOffset >= this.buffer.byteLength) {
        // TDF stream ended unexpectedly without a null terminator.
        console.warn(
          `[${this.filePath}] Glyph for '${charKey}' in font '${fontMeta.uniqueKey}' ended prematurely (missing 0x00 terminator).`,
        );
        eofReached = true; // Force loop termination after this iteration.
      }
      // Read next byte; if forced EOF, simulate a null terminator to finalize line.
      const byte = eofReached ? 0x00 : this.dataView.getUint8(currentReadOffset++);

      if (byte === 0x00) {
        // Null terminator: end of glyph data.
        // Add the last line if it has content, or if it's the very first line (for empty glyphs).
        if (currentLine.length > 0 || lines.length === 0) {
          lines.push(currentLine);
        }
        eofReached = true;
      } else if (byte === 0x0d) {
        // Carriage Return (0x0D): end of current line.
        lines.push(currentLine);
        currentLine = []; // Start a new line.
      } else {
        // Character byte for a cell.
        // Expect an attribute byte to follow.
        if (currentReadOffset >= this.buffer.byteLength) {
          console.warn(
            `[${this.filePath}] Glyph for '${charKey}' in font '${fontMeta.uniqueKey}' stream ended unexpectedly (missing attribute byte for char 0x${byte.toString(16)}).`,
          );
          eofReached = true; // Data is malformed; treat as end.
          if (currentLine.length > 0 || lines.length === 0) lines.push(currentLine); // Add potentially incomplete line.
          break; // Exit loop due to malformed data.
        }
        const attrByte = this.dataView.getUint8(currentReadOffset++);
        currentLine.push({ charByte: byte, attrByte });
      }
    }
    // A glyph, even an empty one (like a space), is considered to have at least one line of height.
    const actualHeight = lines.length > 0 ? lines.length : 1;
    return { declaredWidth, actualHeight, lines };
  }
}

/**
 * Builds a local pair palette for a given font.
 * The palette consists of unique (Character Code, Color Attribute) pairs found in the font's glyphs.
 * If any glyph requires padding, the PADDING_PAIR is added to the palette.
 * The final palette is sorted canonically for deterministic bundle output.
 * @param {Array<Array<Array<{charByte:number, attrByte:number}>>>} allGlyphLinesData - An array where each element
 * is the `lines` array (from `extractRawGlyphCellsAndDimensions`) for one glyph of the font.
 * @param {boolean} fontRequiresPadding - True if any glyph in this font has "ragged" lines
 * that will need padding to meet its declared width.
 * @returns {{pairPalette: Array<{char:number, attr:number}>, nPairs: number} | null}
 * An object with the sorted `pairPalette` and its size `nPairs`,
 * or null if the number of unique pairs exceeds the encodable limit (254).
 */
function buildLocalPairPalette(allGlyphLinesData, fontRequiresPadding) {
  const uniquePairsSet = new Map(); // Use a Map to efficiently store unique pairs (key: "char,attr", value: {char, attr}).

  for (const glyphLines of allGlyphLinesData) {
    // Iterate through each glyph's line data.
    for (const line of glyphLines) {
      // Iterate through lines of a glyph.
      for (const cell of line) {
        // Iterate through cells in a line.
        const pairKey = `${cell.charByte},${cell.attrByte}`;
        if (!uniquePairsSet.has(pairKey)) {
          uniquePairsSet.set(pairKey, { char: cell.charByte, attr: cell.attrByte });
        }
      }
    }
  }

  // If the font requires padding for any of its glyphs, ensure the PADDING_PAIR is in the palette.
  const paddingPairKey = `${PADDING_CHAR},${PADDING_ATTR}`;
  if (fontRequiresPadding && !uniquePairsSet.has(paddingPairKey)) {
    uniquePairsSet.set(paddingPairKey, { char: PADDING_CHAR, attr: PADDING_ATTR });
  }

  const pairPalette = Array.from(uniquePairsSet.values());
  // Sort the palette canonically (first by char code, then by attribute)
  // to ensure deterministic output if the TDFs are processed in a different order.
  pairPalette.sort((a, b) => {
    if (a.char !== b.char) return a.char - b.char;
    return a.attr - b.attr;
  });

  const nPairs = pairPalette.length;
  // The RLE scheme uses 0xFF as an escape byte. Palette indices must be < 0xFF.
  if (nPairs > 254) {
    console.error(
      `Font has ${nPairs} unique (char,attr) pairs, exceeding limit of 254. Cannot encode with current RLE scheme.`,
    );
    return null;
  }
  return { pairPalette, nPairs };
}

/**
 * Encodes a single glyph's cell data into an RLE (Run-Length Encoded) stream of pair palette indices.
 * The input `rawGlyph` provides lines of actual cells. This function first creates a dense
 * `declaredWidth * actualHeight` grid of pair palette indices, padding short lines with the
 * `PADDING_PAIR`'s index, then RLE encodes this flat stream of indices.
 * @param {object} rawGlyph - Object containing `{declaredWidth, actualHeight, lines}` for the glyph.
 * @param {Array<{char:number, attr:number}>} pairPalette - The font's local pair palette.
 * @param {Map<string, number>} pairToIndexMap - Precomputed map ("char,attr" -> index) for fast palette lookups.
 * @returns {Buffer} A Buffer containing the RLE-encoded byte stream for the glyph.
 */
function encodeGlyphToRLEStream(rawGlyph, pairPalette, pairToIndexMap) {
  const { declaredWidth, actualHeight, lines } = rawGlyph;
  const paddingPairIndex = pairToIndexMap.get(`${PADDING_CHAR},${PADDING_ATTR}`);

  // This check is a safeguard. `buildLocalPairPalette` should have ensured paddingPairIndex exists
  // if fontRequiresPadding was true (which would be the case if any line.length < declaredWidth).
  if (typeof paddingPairIndex === "undefined" && lines.some((line) => line.length < declaredWidth)) {
    console.warn(
      "Padding pair index is undefined, but glyph appears to need padding. This may result in errors or incorrect encoding.",
    );
    // This situation implies a logic error in determining `fontRequiresPadding` or in `buildLocalPairPalette`.
  }

  // 1. Create a flat stream of pair palette indices, padding ragged lines.
  const flatIndexStream = [];
  for (let y = 0; y < actualHeight; y++) {
    const line = lines[y] || []; // Use empty array if a line is somehow missing (actualHeight should be accurate).
    for (let x = 0; x < declaredWidth; x++) {
      let pairIndex;
      if (x < line.length) {
        // Cell has data from original TDF.
        const cell = line[x];
        pairIndex = pairToIndexMap.get(`${cell.charByte},${cell.attrByte}`);
      } else {
        // Cell needs padding to fill declaredWidth.
        pairIndex = paddingPairIndex;
      }

      if (typeof pairIndex === "undefined") {
        // This is a critical error if it occurs, meaning a cell pair (either data or padding)
        // was not found in the generated palette.
        console.error(
          `Error: Pair not found in palette during RLE encoding. Cell data: ${x < line.length ? JSON.stringify(line[x]) : "PADDING CELL"}. Using index 0 as fallback.`,
        );
        pairIndex = 0; // Fallback to avoid crashing, but this indicates a serious issue.
      }
      flatIndexStream.push(pairIndex);
    }
  }

  // 2. Apply RLE to the flatIndexStream.
  const rleEncodedStream = [];
  let i = 0;
  while (i < flatIndexStream.length) {
    const currentIndex = flatIndexStream[i];
    let runLength = 1;
    // Count repetitions of the currentIndex.
    while (
      runLength < RLE_MAX_ACTUAL_RUN && // Ensure runLength doesn't exceed max encodable by run_length_byte.
      i + runLength < flatIndexStream.length &&
      flatIndexStream[i + runLength] === currentIndex
    ) {
      runLength++;
    }

    // Decide whether to encode as RLE or literals.
    // An index that is itself the RLE_ESCAPE_BYTE must always be RLE-encoded (even for short runs)
    // to distinguish it from an actual RLE escape sequence.
    if (currentIndex === RLE_ESCAPE_BYTE || runLength >= RLE_MIN_RUN_LENGTH) {
      rleEncodedStream.push(RLE_ESCAPE_BYTE);
      rleEncodedStream.push(runLength - RLE_MIN_RUN_LENGTH); // run_length_byte (0 means actual run of 3).
      rleEncodedStream.push(currentIndex); // The pair palette index being repeated.
      i += runLength;
    } else {
      // Run is too short (1 or 2 cells) and index is not the escape byte. Write as literals.
      for (let j = 0; j < runLength; j++) {
        rleEncodedStream.push(flatIndexStream[i + j]);
      }
      i += runLength;
    }
  }
  return Buffer.from(rleEncodedStream);
}

// --- Bundle Assembly Functions ---

/**
 * Builds the String Pool and a preliminary Font Index Table.
 * The Font Index Table will have correct key offsets but placeholder data offsets.
 * @param {Array<object>} processedFonts - Array of processed font data objects, already sorted.
 * @returns {{fontIndexTableData: Array<object>, stringPoolBuffer: Buffer}}
 */
function _buildStringPoolAndIndexPlaceholders(processedFonts) {
  const fontIndexTableData = []; // Stores { keyOffsetInPool, dataOffsetInPool (placeholder) }
  const stringPoolBuffers = []; // Array of Buffers, one for each null-terminated key.
  let currentStringOffset = 0; // Running offset within the string pool.

  for (const font of processedFonts) {
    const keyBuffer = Buffer.from(`${font.uniqueKey}\0`, "utf8"); // Ensure null termination.
    stringPoolBuffers.push(keyBuffer);
    fontIndexTableData.push({ keyOffsetInPool: currentStringOffset, dataOffsetInPool: 0 /* Placeholder */ });
    currentStringOffset += keyBuffer.length;
  }
  return { fontIndexTableData, stringPoolBuffer: Buffer.concat(stringPoolBuffers) };
}

/**
 * Builds the Font Data Pool by concatenating data for all processed fonts.
 * Updates the `dataOffsetInPool` in `fontIndexTableData` with actual offsets.
 * @param {Array<object>} processedFonts - Array of processed font data, sorted as they will appear in the bundle.
 * @param {Array<object>} fontIndexTableData - Preliminary index table data to be updated.
 * @returns {Buffer} A Buffer containing the complete Font Data Pool.
 */
function _buildFontDataPool(processedFonts, fontIndexTableData) {
  const fontDataPoolBuffers = []; // Array of Buffers, one for each font's complete data block.
  let currentDataPoolOffset = 0; // Running offset within the font data pool.

  for (const [fontArrIndex, fontInfo] of processedFonts.entries()) {
    fontIndexTableData[fontArrIndex].dataOffsetInPool = currentDataPoolOffset; // Set the actual data offset.
    const singleFontBlockBuffers = []; // Buffers for parts of the current font's data block.

    // 1. Font Spacing (1 byte)
    const spacingBuffer = Buffer.alloc(1);
    spacingBuffer.writeUInt8(fontInfo.spacing, 0);
    singleFontBlockBuffers.push(spacingBuffer);

    // 2. Number of Pairs (nPairs) (1 byte)
    const nPairsBuffer = Buffer.alloc(1);
    nPairsBuffer.writeUInt8(fontInfo.nPairs, 0);
    singleFontBlockBuffers.push(nPairsBuffer);

    // 3. Pair Palette Data (nPairs * 2 bytes)
    const paletteDataBuffer = Buffer.alloc(fontInfo.nPairs * 2);
    let paletteWriteOffset = 0;
    for (const pair of fontInfo.pairPalette) {
      // fontInfo.pairPalette is already canonically sorted.
      paletteDataBuffer.writeUInt8(pair.char, paletteWriteOffset++);
      paletteDataBuffer.writeUInt8(pair.attr, paletteWriteOffset++);
    }
    singleFontBlockBuffers.push(paletteDataBuffer);

    // 4. Glyph Count (G) (1 byte)
    const glyphCount = Object.keys(fontInfo.encodedGlyphs).length;
    const glyphCountBuffer = Buffer.alloc(1);
    glyphCountBuffer.writeUInt8(glyphCount, 0);
    singleFontBlockBuffers.push(glyphCountBuffer);

    // 5. Glyph Lookup Table (GLT) (G * 3 bytes)
    // Glyphs for GLT must be sorted by character code for correct lookup.
    const glyphEntries = Object.entries(fontInfo.encodedGlyphs).sort((a, b) => a[0].charCodeAt(0) - b[0].charCodeAt(0));
    const gltBuffer = Buffer.alloc(glyphCount * 3);
    const gdtPartBuffers = []; // Buffers for parts of the Glyph Data Table (GDT) for this font.
    let currentGdtRelativeOffset = 0; // Offset within this font's GDT.

    for (const [entryIndex, [charKey, glyphData]] of glyphEntries.entries()) {
      const gltEntryWriteOffset = entryIndex * 3;
      gltBuffer.writeUInt8(charKey.charCodeAt(0), gltEntryWriteOffset);
      gltBuffer.writeUInt16LE(currentGdtRelativeOffset, gltEntryWriteOffset + 1);

      // Prepare GDT part for this glyph: Width (1B), Height (1B), RLE Stream.
      const glyphHeaderBuffer = Buffer.alloc(2);
      glyphHeaderBuffer.writeUInt8(glyphData.width, 0);
      glyphHeaderBuffer.writeUInt8(glyphData.height, 1);
      gdtPartBuffers.push(glyphHeaderBuffer);
      gdtPartBuffers.push(glyphData.rleStream); // This is already a Buffer.

      currentGdtRelativeOffset += 2 + glyphData.rleStream.length;
    }
    singleFontBlockBuffers.push(gltBuffer);
    singleFontBlockBuffers.push(...gdtPartBuffers); // Concatenate all GDT parts.

    const completeFontDataBlock = Buffer.concat(singleFontBlockBuffers);
    fontDataPoolBuffers.push(completeFontDataBlock);
    currentDataPoolOffset += completeFontDataBlock.length;
  }
  return Buffer.concat(fontDataPoolBuffers);
}

/**
 * Creates the final binary Font Index Table from the populated data.
 * @param {Array<object>} fontIndexTableData - Array of {keyOffsetInPool, dataOffsetInPool} objects.
 * @returns {Buffer} The binary Font Index Table.
 */
function _finalizeFontIndexTable(fontIndexTableData) {
  const numEntries = fontIndexTableData.length;
  const fontIndexTableBuffer = Buffer.alloc(numEntries * 8); // Each entry is 8 bytes.
  for (const [i, entry] of fontIndexTableData.entries()) {
    fontIndexTableBuffer.writeUInt32LE(entry.keyOffsetInPool, i * 8);
    fontIndexTableBuffer.writeUInt32LE(entry.dataOffsetInPool, i * 8 + 4);
  }
  return fontIndexTableBuffer;
}

/**
 * Builds the Main Bundle Header.
 * @param {number} numFonts - Total number of fonts in the bundle.
 * @param {number} indexTableLength - Length in bytes of the Font Index Table.
 * @param {number} stringPoolLength - Length in bytes of the String Pool.
 * @returns {Buffer} The binary Main Bundle Header.
 */
function _buildBundleHeader(numFonts, indexTableLength, stringPoolLength) {
  const headerSize = 21; // As per spec: Magic(4)+Ver(1)+FontCount(4)+IndexOffset(4)+StringOffset(4)+DataOffset(4)
  const headerBuffer = Buffer.alloc(headerSize);
  let offset = 0;

  offset += headerBuffer.write(BIN_MAGIC_STRING, offset, "ascii");
  offset = headerBuffer.writeUInt8(BIN_BUNDLE_VERSION, offset);
  offset = headerBuffer.writeUInt32LE(numFonts, offset);

  // Calculate absolute offsets for the main sections.
  const indexTableAbsoluteOffset = headerSize;
  const stringPoolAbsoluteOffset = indexTableAbsoluteOffset + indexTableLength;
  const fontDataPoolAbsoluteOffset = stringPoolAbsoluteOffset + stringPoolLength;

  offset = headerBuffer.writeUInt32LE(indexTableAbsoluteOffset, offset);
  offset = headerBuffer.writeUInt32LE(stringPoolAbsoluteOffset, offset);
  headerBuffer.writeUInt32LE(fontDataPoolAbsoluteOffset, offset); // Last write, offset not incremented.

  return headerBuffer;
}

// --- Main Function ---

/**
 * Main orchestration function for the packer.
 * Reads TDF files from input directory, processes them, and writes a single binary bundle.
 */
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

  const processedFontsData = []; // Stores data for each font successfully processed.
  let filesScanned = 0;

  try {
    const filesInDir = fs.readdirSync(inputDirectory);
    for (const file of filesInDir) {
      if (path.extname(file).toLowerCase() !== ".tdf") continue; // Skip non-TDF files.
      filesScanned++;
      const fullFilePath = path.join(inputDirectory, file);

      try {
        const tdfFileBuffer = fs.readFileSync(fullFilePath);
        const parser = new TdfParser(tdfFileBuffer, fullFilePath);
        const parsedFontHeaders = parser.parseFontHeaders(); // Returns only color fonts.

        for (const fontMeta of parsedFontHeaders) {
          const allGlyphRawData = {}; // Stores {declaredWidth, actualHeight, lines} for each charKey.
          let fontRequiresPadding = false; // Flag if any glyph in this font is "ragged".
          const allCellPairsForFontPalette = []; // Accumulates all {charByte, attrByte} from all glyphs for palette generation.

          // 1. Extract raw data for all glyphs in the current font.
          for (const charKey of SUPPORTED_CHAR_LIST) {
            const rawGlyph = parser.extractRawGlyphCellsAndDimensions(fontMeta, charKey);
            if (rawGlyph) {
              allGlyphRawData[charKey] = rawGlyph;
              // Check for padding requirement and collect all unique cell pairs for palette.
              for (const line of rawGlyph.lines) {
                if (line.length < rawGlyph.declaredWidth) {
                  fontRequiresPadding = true;
                }
                allCellPairsForFontPalette.push(...line); // Add all cells from this line to the collection.
              }
              // An "empty" glyph (no cells but has dimensions) also implies padding.
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
            continue; // No glyphs to process for this font.
          }

          // 2. Build the local pair palette for this font.
          const paletteResult = buildLocalPairPalette(
            Object.values(allGlyphRawData).map((g) => g.lines), // Pass an array of all glyphs' line data.
            fontRequiresPadding,
          );

          if (!paletteResult) {
            console.warn(
              `Skipping font ${fontMeta.uniqueKey} due to too many unique pairs for its palette (limit 254).`,
            );
            continue; // Cannot encode this font.
          }
          const { pairPalette, nPairs } = paletteResult;

          // Create a map for char/attr pair to palette index for quick lookup during RLE encoding.
          const pairToIndexMap = new Map();
          for (const [index, pair] of pairPalette.entries()) {
            pairToIndexMap.set(`${pair.char},${pair.attr}`, index);
          }

          // 3. Encode each glyph to its RLE stream.
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

          // 4. Store all processed data for this font.
          processedFontsData.push({
            uniqueKey: fontMeta.uniqueKey,
            spacing: fontMeta.spacing,
            nPairs,
            pairPalette, // This is the canonically sorted palette.
            encodedGlyphs,
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

  // Sort fonts alphabetically by uniqueKey for deterministic bundle structure.
  processedFontsData.sort((a, b) => a.uniqueKey.localeCompare(b.uniqueKey));
  console.log("\nFonts sorted alphabetically by uniqueKey for bundle generation.");

  // --- Assemble the final binary bundle ---
  console.log("Building binary bundle components...");
  const { fontIndexTableData, stringPoolBuffer } = _buildStringPoolAndIndexPlaceholders(processedFontsData);
  const fontDataPoolBuffer = _buildFontDataPool(processedFontsData, fontIndexTableData);
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
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true }); // Ensure output directory exists.
    }
    fs.writeFileSync(outputFilePath, finalBundleBuffer);
    console.log(`Binary font bundle created successfully! Bundle Version: ${BIN_BUNDLE_VERSION}`);
    console.log(
      "Consider post-processing the .bin file with Zopfli for potentially better GZip compression:",
      `  zopfli --deflate --i1000 ${outputFilePath}`,
    );
  } catch (writeError) {
    console.error(`Fatal error writing binary file ${outputFilePath}:`, writeError.message);
    process.exit(1);
  }
}

// Script execution starts here.
main();
