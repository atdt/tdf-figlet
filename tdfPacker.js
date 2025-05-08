#!/usr/bin/env node

// tdfPacker.js v1.1
// Preprocesses TheDraw Font (.TDF) files from a directory into a single,
// compact binary bundle (.bin) for use with tdfRenderer.js.
// Handles multi-font TDFs, creates unique font keys, and stores data compactly.

import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";

// --- TDF Format Constants (Input .TDF file structure) ---

const TDF_COLOR_FONT_TYPE = 2; // Expected type identifier for TDF color fonts.
const TDF_HEADER_SIGNATURE = Buffer.from([0x55, 0xaa, 0x00, 0xff]); // Uª.ÿ

/**
 * Size in bytes from TDF_HEADER_SIGNATURE to the end of the character offset table.
 * Components: Signature(4), NameLen(1), Name(12), Reserved(3), Type(1),
 * Space(1), Size(2), OffsetTable(94*2=188). Sum = 212.
 * The value 213 is used, matching observed TDF behavior where glyph data starts after this block.
 */
const TDF_FONT_METADATA_BLOCK_SIZE = 213;

// --- Binary Bundle Constants (Output .bin file structure) ---

const BIN_MAGIC_STRING = "TDFB"; // Magic string "TDFB" (TDF Bundle)
const BIN_BUNDLE_VERSION = 1; // Version number of the binary bundle format.
const BIN_STREAM_NEWLINE_CODE = 0x0d; // Byte code for newline (Carriage Return) in glyph stream.
const BIN_STREAM_GLYPH_TERMINATOR = 0x00; // Byte code terminating a glyph's stream.

// --- General Constants ---

/**
 * List of 94 printable ASCII characters (ASCII 33-126)
 * for which TDF fonts typically store glyph offset information.
 */
const SUPPORTED_CHAR_LIST =
  "!\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";

/**
 * Parses TheDraw Font (.TDF) files.
 * Handles TDF files that may contain multiple font definitions.
 */
class TdfParserNode {
  /**
   * @param {Buffer} buffer - The raw buffer data of the TDF file.
   * @param {string} [filePath='unknown'] - Path to the TDF file, for logging.
   * @throws {Error} If the buffer is invalid or too small.
   */
  constructor(buffer, filePath = "unknown") {
    if (!buffer || !(buffer instanceof Buffer) || buffer.byteLength < TDF_FONT_METADATA_BLOCK_SIZE) {
      throw new Error(`[${filePath}] Invalid or too small TDF buffer provided.`);
    }
    this.buffer = buffer;
    this.filePath = filePath;
    this.dataView = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
    this.fonts = [];
  }

  /**
   * Finds the next occurrence of the TDF_HEADER_SIGNATURE.
   * @param {number} searchStartOffset - Offset to start searching from.
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
   * Extracts metadata for a single font from its TDF header.
   * @param {number} headerStartIndex - Starting offset of the TDF font header.
   * @returns {object | null} Font metadata, or null if parsing fails or not a color font.
   * @private
   */
  _extractFontMetadataFromHeader(headerStartIndex) {
    const nameLenOffset = headerStartIndex + 4;
    const nameCharsOffset = headerStartIndex + 5;
    const typeOffset = headerStartIndex + 21;
    const spacingOffset = headerStartIndex + 22;
    // const blockSizeOffset = headerStartIndex + 23; // Unused by this parser for data start
    const charTableOffset = headerStartIndex + 25;

    if (headerStartIndex + TDF_FONT_METADATA_BLOCK_SIZE > this.dataView.byteLength) {
      return null; // Insufficient data for full header
    }

    try {
      const fontNameLength = Math.min(this.dataView.getUint8(nameLenOffset), 12); // Max 12 chars
      let fontName = "";
      for (let i = 0; i < fontNameLength; i++) {
        const charCode = this.dataView.getUint8(nameCharsOffset + i);
        if (charCode === 0) break; // Null terminator
        fontName += String.fromCharCode(charCode);
      }
      fontName = fontName.trim();

      const fontType = this.dataView.getUint8(typeOffset);
      if (fontType !== TDF_COLOR_FONT_TYPE) {
        return null; // Only process color fonts
      }

      const letterSpacingRaw = this.dataView.getUint8(spacingOffset);
      const letterSpacing = letterSpacingRaw > 0 ? letterSpacingRaw - 1 : 0; // Adjust raw spacing

      const charGlyphOffsets = {};
      for (let i = 0; i < SUPPORTED_CHAR_LIST.length; i++) {
        const charOffsetInTdf = this.dataView.getUint16(charTableOffset + i * 2, true); // Little-endian
        if (charOffsetInTdf !== 0xffff) { // 0xFFFF means char not defined
          charGlyphOffsets[SUPPORTED_CHAR_LIST[i]] = charOffsetInTdf;
        }
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
        spacing: letterSpacing,
        offsets: charGlyphOffsets,
        dataBlockStartOffset, // Where this font's glyph data begins
      };
    } catch (e) {
      console.error(`[${this.filePath}] Error parsing metadata in header at offset ${headerStartIndex}:`, e);
      return null;
    }
  }

  /**
   * Parses the TDF buffer to find all TDF color font definitions.
   * @returns {Array<object>} Array of font metadata objects.
   */
  parse() {
    this.fonts = [];
    let currentSearchOffset = 0;

    while (currentSearchOffset < this.buffer.length) {
      const headerStartIndex = this._findNextTdfHeader(currentSearchOffset);
      if (headerStartIndex === -1) {
        break; // No more headers
      }

      const fontMetadata = this._extractFontMetadataFromHeader(headerStartIndex);
      if (fontMetadata) {
        this.fonts.push(fontMetadata);
      }

      currentSearchOffset = headerStartIndex + TDF_HEADER_SIGNATURE.length; // Move past current header
    }
    return this.fonts;
  }

  /**
   * Extracts glyph data for a character.
   * Returns { width, height, stream: [byte, byte, ...] }.
   * Height is recalculated from newline characters.
   *
   * @param {object} fontMeta - Font metadata object.
   * @param {string} char - Character to extract (e.g., 'A').
   * @returns {{width: number, height: number, stream: Array<number>} | null} Intermediate glyph data or null.
   */
  extractIntermediateGlyphData(fontMeta, char) {
    const relativeOffset = fontMeta.offsets[char];
    if (typeof relativeOffset === "undefined") {
      return null; // Character not defined
    }

    const absoluteOffset = fontMeta.dataBlockStartOffset + relativeOffset;

    if (absoluteOffset + 2 > this.buffer.byteLength) { // Min 2 bytes for width/height
      return null;
    }

    try {
      const glyphWidthInCells = this.dataView.getUint8(absoluteOffset);
      // const _glyphHeightInLinesReported = this.dataView.getUint8(absoluteOffset + 1); // Original TDF height

      const byteStream = [];
      let currentReadOffset = absoluteOffset + 2; // Start after width/height
      let endOfGlyphStream = false;
      let actualHeightInLines = 0;
      let currentLineHasChars = false;

      while (!endOfGlyphStream) {
        if (currentReadOffset >= this.buffer.byteLength) {
          // Unexpected end of buffer
          endOfGlyphStream = true;
          break;
        }

        const charByte = this.dataView.getUint8(currentReadOffset++);

        if (charByte === 0x00) { // Null terminator for TDF glyph stream
          endOfGlyphStream = true;
          if (currentLineHasChars) {
            actualHeightInLines++; // Count last line if it had content
          }
        } else if (charByte === 0x0d) { // Carriage return in TDF
          byteStream.push(BIN_STREAM_NEWLINE_CODE); // Convert to our newline
          actualHeightInLines++;
          currentLineHasChars = false;
        } else { // Character code, expect attribute byte next
          if (currentReadOffset >= this.buffer.byteLength) {
            // Unexpected end of buffer expecting attribute
            endOfGlyphStream = true;
            break;
          }
          const attrByte = this.dataView.getUint8(currentReadOffset++);
          byteStream.push(charByte, attrByte);
          currentLineHasChars = true;
        }
      }

      // Ensure minimum height of 1 if there's any content or structure
      return {
        width: glyphWidthInCells,
        height: actualHeightInLines > 0 ? actualHeightInLines : 1,
        stream: byteStream,
      };
    } catch (e) {
      console.error(
        `[${this.filePath}] Error extracting intermediate glyph for char "${char}", font "${fontMeta.internalName}":`,
        e,
      );
      return null;
    }
  }
} // End TdfParserNode Class

// --- Bundle Building Logic ---

/**
 * Prepares string pool and initial font index table placeholders.
 * @private
 */
function _buildStringPoolAndIndexPlaceholders(allFontsIntermediate) {
  const fontIndexTableData = []; // { keyOffsetInPool, dataOffsetInPool (placeholder) }
  const stringPoolBuffers = [];
  let currentStringOffset = 0;

  for (const fontInfo of allFontsIntermediate) {
    const keyBuffer = Buffer.from(`${fontInfo.uniqueKey}\0`, "utf8"); // Null-terminate key
    stringPoolBuffers.push(keyBuffer);
    fontIndexTableData.push({
      keyOffsetInPool: currentStringOffset,
      dataOffsetInPool: 0, // Placeholder
    });
    currentStringOffset += keyBuffer.length;
  }

  return { fontIndexTableData, stringPoolBuffer: Buffer.concat(stringPoolBuffers) };
}

/**
 * Prepares font data pool and updates dataOffsetInPool in fontIndexTableData.
 * Font data: spacing, glyph count, glyph lookup table (GLT), glyph data streams (GDT).
 * @private
 */
function _buildFontDataPool(allFontsIntermediate, fontIndexTableData) {
  const fontDataPoolBuffers = [];
  let currentDataPoolOffset = 0;

  for (const [fontArrIndex, fontInfo] of allFontsIntermediate.entries()) {
    fontIndexTableData[fontArrIndex].dataOffsetInPool = currentDataPoolOffset; // Update data offset

    const singleFontBlockBuffers = [];

    // 1. Font Spacing (1 byte)
    const spacingBuffer = Buffer.alloc(1);
    spacingBuffer.writeUInt8(fontInfo.spacing, 0);
    singleFontBlockBuffers.push(spacingBuffer);

    // 2. Glyph Count (1 byte)
    const glyphEntries = Object.entries(fontInfo.glyphs).sort((a, b) => a[0].charCodeAt(0) - b[0].charCodeAt(0));
    const glyphCount = glyphEntries.length;
    const glyphCountBuffer = Buffer.alloc(1);
    glyphCountBuffer.writeUInt8(glyphCount, 0);
    singleFontBlockBuffers.push(glyphCountBuffer);

    // 3. Glyph Lookup Table (GLT)
    // Each entry: charCode (1B), offset_in_GDT (UInt16LE, 2B)
    const lookupTableSizeBytes = glyphCount * 3;
    const lookupTableBuffer = Buffer.alloc(lookupTableSizeBytes);
    const glyphDataStreamBuffers = [];
    let currentGlyphDataRelativeOffset = 0; // Relative to start of this font's GDT

    for (const [entryIndex, [char, glyphData]] of glyphEntries.entries()) {
      const lookupTableEntryOffset = entryIndex * 3;
      lookupTableBuffer.writeUInt8(char.charCodeAt(0), lookupTableEntryOffset);
      lookupTableBuffer.writeUInt16LE(currentGlyphDataRelativeOffset, lookupTableEntryOffset + 1);

      // Glyphs: Width (1B), Height (1B), Stream (variable), Terminator (1B)
      const glyphHeaderBuffer = Buffer.alloc(2);
      glyphHeaderBuffer.writeUInt8(glyphData.width, 0);
      glyphHeaderBuffer.writeUInt8(glyphData.height, 1);

      const glyphStreamBuffer = Buffer.from(glyphData.stream);
      const glyphEndTerminatorBuffer = Buffer.alloc(1, BIN_STREAM_GLYPH_TERMINATOR);

      const completeSingleGlyphBuffer = Buffer.concat([
        glyphHeaderBuffer,
        glyphStreamBuffer,
        glyphEndTerminatorBuffer,
      ]);
      glyphDataStreamBuffers.push(completeSingleGlyphBuffer);
      currentGlyphDataRelativeOffset += completeSingleGlyphBuffer.length;
    }

    singleFontBlockBuffers.push(lookupTableBuffer);
    singleFontBlockBuffers.push(...glyphDataStreamBuffers);

    const completeFontDataBlock = Buffer.concat(singleFontBlockBuffers);
    fontDataPoolBuffers.push(completeFontDataBlock);
    currentDataPoolOffset += completeFontDataBlock.length;
  }

  return Buffer.concat(fontDataPoolBuffers);
}

/**
 * Prepares the final Font Index Table buffer.
 * Each entry: keyOffset (UInt32LE), dataOffset (UInt32LE).
 * @private
 */
function _finalizeFontIndexTable(fontIndexTableData, numFonts) {
  const fontIndexTableBuffer = Buffer.alloc(numFonts * 8); // Each entry is 8 bytes
  for (const [i, entry] of fontIndexTableData.entries()) {
    fontIndexTableBuffer.writeUInt32LE(entry.keyOffsetInPool, i * 8);
    fontIndexTableBuffer.writeUInt32LE(entry.dataOffsetInPool, i * 8 + 4);
  }
  return fontIndexTableBuffer;
}

/**
 * Prepares the main header for the binary bundle.
 * Header structure:
 * - Magic String (4 bytes: 'TDFB')
 * - Version (1 byte: UInt8)
 * - Font Count (4 bytes: UInt32LE)
 * - Index Table Offset (4 bytes: UInt32LE)  (from file start)
 * - String Pool Offset (4 bytes: UInt32LE)  (from file start)
 * - Font Data Pool Offset (4 bytes: UInt32LE) (from file start)
 * @private
 */
function _buildBundleHeader(numFonts, finalIndexTableBufferLength, finalStringPoolBufferLength) {
  const headerSize = 4 + 1 + 4 + 4 + 4 + 4; // 21 bytes
  const headerBuffer = Buffer.alloc(headerSize);
  let offset = 0;

  offset += headerBuffer.write(BIN_MAGIC_STRING, offset, "ascii");
  offset = headerBuffer.writeUInt8(BIN_BUNDLE_VERSION, offset);
  offset = headerBuffer.writeUInt32LE(numFonts, offset);

  const indexTableAbsoluteOffset = headerSize;
  const stringPoolAbsoluteOffset = indexTableAbsoluteOffset + finalIndexTableBufferLength;
  const fontDataPoolAbsoluteOffset = stringPoolAbsoluteOffset + finalStringPoolBufferLength;

  offset = headerBuffer.writeUInt32LE(indexTableAbsoluteOffset, offset);
  offset = headerBuffer.writeUInt32LE(stringPoolAbsoluteOffset, offset);
  headerBuffer.writeUInt32LE(fontDataPoolAbsoluteOffset, offset);

  return headerBuffer;
}

/**
 * Main function: reads TDFs, parses, extracts glyphs, and builds a binary bundle.
 */
function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error("Usage: node tdfPacker.js <input_tdf_directory> <output_bin_file_path>");
    console.error("Example: node tdfPacker.js ./my_tdf_fonts ./dist/font_bundle.bin");
    process.exit(1);
  }
  const inputDirectory = args[0];
  const outputFilePath = args[1];

  // { uniqueKey, spacing, glyphs: { char: {w,h,stream} } }
  const allFontsIntermediateData = [];
  let filesSuccessfullyProcessed = 0;

  console.log("Starting TDF preprocessing...");
  console.log(`Input directory: ${path.resolve(inputDirectory)}`);
  console.log(`Output file:     ${path.resolve(outputFilePath)}`);

  // --- Step 1: Read and Parse TDF files ---
  try {
    const filesInDir = fs.readdirSync(inputDirectory);
    for (const file of filesInDir) {
      if (path.extname(file).toLowerCase() !== ".tdf") {
        continue; // Skip non-TDF files
      }
      const fullFilePath = path.join(inputDirectory, file);
      try {
        const tdfFileBuffer = fs.readFileSync(fullFilePath);
        const parser = new TdfParserNode(tdfFileBuffer, fullFilePath);
        const parsedFontsInCurrentFile = parser.parse();

        for (const fontMetadata of parsedFontsInCurrentFile) {
          const extractedGlyphs = {};
          let glyphsFoundInThisFont = 0;
          for (const char of SUPPORTED_CHAR_LIST) {
            const glyphIntermediate = parser.extractIntermediateGlyphData(fontMetadata, char);
            if (glyphIntermediate) {
              extractedGlyphs[char] = glyphIntermediate;
              glyphsFoundInThisFont++;
            }
          }

          if (glyphsFoundInThisFont > 0) {
            allFontsIntermediateData.push({
              uniqueKey: fontMetadata.uniqueKey,
              spacing: fontMetadata.spacing,
              glyphs: extractedGlyphs,
            });
          }
        }
        filesSuccessfullyProcessed++;
      } catch (readOrParseError) {
        console.error(`Error processing file ${fullFilePath}:`, readOrParseError.message);
      }
    }
  } catch (dirAccessError) {
    console.error(`Fatal error accessing input directory ${inputDirectory}:`, dirAccessError.message);
    process.exit(1);
  }

  console.log(`\nSuccessfully processed ${filesSuccessfullyProcessed} TDF files.`);
  console.log(`Found ${allFontsIntermediateData.length} TDF color fonts with extractable glyphs.`);

  if (allFontsIntermediateData.length === 0) {
    console.log("No font data to write to bundle. Exiting.");
    return;
  }

  // --- Step 2: Sort fonts by uniqueKey for consistent index ---
  allFontsIntermediateData.sort((a, b) => a.uniqueKey.localeCompare(b.uniqueKey));

  // --- Step 3: Build Binary Bundle Components ---
  console.log("\nBuilding binary bundle components...");

  const { fontIndexTableData, stringPoolBuffer } = _buildStringPoolAndIndexPlaceholders(allFontsIntermediateData);
  const fontDataPoolBuffer = _buildFontDataPool(allFontsIntermediateData, fontIndexTableData);
  const numFonts = allFontsIntermediateData.length;
  const finalFontIndexTableBuffer = _finalizeFontIndexTable(fontIndexTableData, numFonts);
  const headerBuffer = _buildBundleHeader(numFonts, finalFontIndexTableBuffer.length, stringPoolBuffer.length);

  // --- Step 4: Concatenate all parts ---
  const finalBundleBuffer = Buffer.concat([
    headerBuffer,
    finalFontIndexTableBuffer,
    stringPoolBuffer,
    fontDataPoolBuffer,
  ]);

  // --- Step 5: Write bundle to output file ---
  console.log(`\nWriting binary bundle (${finalBundleBuffer.length} bytes) to: ${outputFilePath}`);
  try {
    const outputDir = path.dirname(outputFilePath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    fs.writeFileSync(outputFilePath, finalBundleBuffer);
    console.log("Binary font bundle created successfully!");
  } catch (writeError) {
    console.error(`Fatal error writing binary file ${outputFilePath}:`, writeError.message);
    process.exit(1);
  }
}

main();
