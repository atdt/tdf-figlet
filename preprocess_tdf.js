#!/usr/bin/env node

// preprocess_tdf.js v1.1 (Enhanced Readability & Maintainability)
// Preprocesses TheDraw Font (.TDF) files from a directory into a single,
// compact binary bundle (.bin) for use with tdfRenderer.js.
// Handles multi-font TDFs, creates unique font keys, and stores data compactly.

import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer"; // Explicit import for clarity

// --- TDF Format Constants (Input .TDF file structure) ---

/** Expected type identifier for TDF color fonts. */
const TDF_COLOR_FONT_TYPE = 2;
/** Signature bytes indicating the start of a TDF font header block. */
const TDF_HEADER_SIGNATURE = Buffer.from([0x55, 0xaa, 0x00, 0xff]); // Uª.ÿ
/**
 * Estimated size in bytes from the TDF_HEADER_SIGNATURE to the end of
 * the character offset table within a TDF font header.
 * This includes: Signature (4), Name Length (1), Name (12), Reserved (3), Type (1),
 * Space (1), Size (2), Offset Table (94 * 2 = 188).
 * 4 + 1 + 12 + 3 + 1 + 1 + 2 + 188 = 212. Original was 213, likely accounting for an extra byte.
 * The actual data block for glyphs starts *after* this structure.
 */
const TDF_FONT_METADATA_BLOCK_SIZE = 213; // Offset from signature to find start of character data block.

// --- Binary Bundle Constants (Output .bin file structure) ---

/** Magic string "TDFB" (TDF Bundle) to identify the binary bundle format. */
const BIN_MAGIC_STRING = "TDFB";
/** Version number of the binary bundle format. */
const BIN_BUNDLE_VERSION = 1;
/** Byte code for a newline character within a glyph's binary stream. (Carriage Return) */
const BIN_STREAM_NEWLINE_CODE = 0x0d;
/** Byte code that terminates a glyph's character stream in the binary format. (Null terminator) */
const BIN_STREAM_GLYPH_TERMINATOR = 0x00;

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
   * Constructs a TdfParserNode instance.
   * @param {Buffer} buffer - The raw buffer data of the TDF file.
   * @param {string} [filePath='unknown'] - The path to the TDF file, for logging purposes.
   * @throws {Error} If the buffer is invalid or too small to be a TDF file.
   */
  constructor(buffer, filePath = "unknown") {
    if (!buffer || !(buffer instanceof Buffer) || buffer.byteLength < TDF_FONT_METADATA_BLOCK_SIZE) {
      // Minimum sensible size
      throw new Error(`[${filePath}] Invalid or too small TDF buffer provided.`);
    }
    this.buffer = buffer;
    this.filePath = filePath;
    this.dataView = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
    this.fonts = []; // Array to store parsed font metadata objects
  }

  /**
   * Finds the next occurrence of the TDF_HEADER_SIGNATURE.
   * @param {number} searchStartOffset - The offset in the buffer to start searching from.
   * @returns {number} The starting index of the header signature, or -1 if not found.
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
    return -1; // Signature not found
  }

  /**
   * Extracts metadata for a single font from its TDF header.
   * @param {number} headerStartIndex - The starting offset of the TDF font header.
   * @returns {object | null} An object containing font metadata, or null if parsing fails.
   * @private
   */
  _extractFontMetadataFromHeader(headerStartIndex) {
    const nameLenOffset = headerStartIndex + 4; // Offset from start of header to name length byte
    const nameCharsOffset = headerStartIndex + 5; // Offset to actual name characters
    const typeOffset = headerStartIndex + 21; // Offset to font type byte
    const spacingOffset = headerStartIndex + 22; // Offset to letter spacing byte
    const blockSizeOffset = headerStartIndex + 23; // Offset to block size (unused by this parser for data start)
    const charTableOffset = headerStartIndex + 25; // Offset to character offset table

    // Basic boundary check
    if (headerStartIndex + TDF_FONT_METADATA_BLOCK_SIZE > this.dataView.byteLength) {
      // console.warn(`[${this.filePath}] Insufficient data for full header at offset ${headerStartIndex}.`);
      return null;
    }

    try {
      const fontNameLength = Math.min(this.dataView.getUint8(nameLenOffset), 12); // Max 12 chars for name
      let fontName = "";
      for (let i = 0; i < fontNameLength; i++) {
        const charCode = this.dataView.getUint8(nameCharsOffset + i);
        if (charCode === 0) break; // Null terminator for name
        fontName += String.fromCharCode(charCode);
      }
      fontName = fontName.trim();

      const fontType = this.dataView.getUint8(typeOffset);
      if (fontType !== TDF_COLOR_FONT_TYPE) {
        // console.log(`[${this.filePath}] Skipping non-color font "${fontName || 'Unnamed'}" (type: ${fontType}) at offset ${headerStartIndex}.`);
        return null; // Only process color fonts
      }

      const letterSpacingRaw = this.dataView.getUint8(spacingOffset);
      const letterSpacing = letterSpacingRaw > 0 ? letterSpacingRaw - 1 : 0; // Adjust raw spacing

      // const tdfBlockSize = this.dataView.getUint16(blockSizeOffset, true); // Little-endian

      const charGlyphOffsets = {};
      for (let i = 0; i < SUPPORTED_CHAR_LIST.length; i++) {
        // 94 supported characters
        const charOffsetInTdf = this.dataView.getUint16(charTableOffset + i * 2, true); // Little-endian
        if (charOffsetInTdf !== 0xffff) {
          // 0xFFFF indicates character not defined
          charGlyphOffsets[SUPPORTED_CHAR_LIST[i]] = charOffsetInTdf;
        }
      }

      // The actual character data block starts immediately after the full TDF_FONT_METADATA_BLOCK_SIZE
      const dataBlockStartOffset = headerStartIndex + TDF_FONT_METADATA_BLOCK_SIZE;

      const baseFilename = path.basename(this.filePath, ".tdf");
      const sanitizedBase = baseFilename.replace(/[^a-zA-Z0-9_.-]/g, "_"); // Allow more chars in filename part
      const sanitizedName = fontName.replace(/[^a-zA-Z0-9_.-]/g, "_");
      const uniqueKey = `${sanitizedBase}_${sanitizedName || "UnnamedFont"}`;

      return {
        uniqueKey,
        internalName: fontName,
        type: fontType,
        spacing: letterSpacing,
        // blockSize: tdfBlockSize, // Not directly used for data start, but good to have
        offsets: charGlyphOffsets,
        dataBlockStartOffset, // Crucial: where this font's glyph data begins
      };
    } catch (e) {
      console.error(`[${this.filePath}] Error parsing metadata in header at offset ${headerStartIndex}:`, e);
      return null;
    }
  }

  /**
   * Parses the TDF buffer to find all TDF color font definitions.
   * It iterates through the buffer, looking for TDF header signatures,
   * and then extracts metadata for each valid color font found.
   * @returns {Array<object>} An array of font metadata objects. Each object contains
   * `uniqueKey`, `internalName`, `type`, `spacing`, `offsets` (map of char to TDF offset),
   * and `dataBlockStartOffset`.
   */
  parse() {
    this.fonts = [];
    let currentSearchOffset = 0;

    // Basic TDF file structure validation (optional, but good practice)
    // A TDF file typically starts with 0x13 and ends with 0x1A at offset 19 from start.
    // This is a weak check as content might vary.
    if (this.dataView.byteLength < 20 || this.dataView.getUint8(0) !== 0x13 || this.dataView.getUint8(19) !== 0x1a) {
      // console.warn(`[${this.filePath}] TDF file structure validation failed (outer signature). Processing may be unreliable.`);
    }

    while (currentSearchOffset < this.buffer.length) {
      const headerStartIndex = this._findNextTdfHeader(currentSearchOffset);
      if (headerStartIndex === -1) {
        break; // No more headers found
      }

      const fontMetadata = this._extractFontMetadataFromHeader(headerStartIndex);
      if (fontMetadata) {
        this.fonts.push(fontMetadata);
      }

      // Move past the current header to search for the next one
      currentSearchOffset = headerStartIndex + TDF_HEADER_SIGNATURE.length;
    }
    return this.fonts;
  }

  /**
   * Extracts the glyph data for a given character from a specific font definition.
   * The data is returned in an intermediate format: { width, height, stream: [byte, byte, ...] }.
   * The stream contains character codes and attribute bytes, with newlines converted to BIN_STREAM_NEWLINE_CODE.
   * Height is recalculated based on actual newline characters in the stream.
   *
   * @param {object} fontMeta - The metadata object for the font (from `parse()` method).
   * @param {string} char - The character for which to extract glyph data (e.g., 'A', '!', ' ').
   * @returns {{width: number, height: number, stream: Array<number>} | null}
   * The intermediate glyph data, or null if the character is not defined or an error occurs.
   */
  extractIntermediateGlyphData(fontMeta, char) {
    const relativeOffset = fontMeta.offsets[char];
    if (typeof relativeOffset === "undefined") {
      return null; // Character not defined in this font's offset table
    }

    const absoluteOffset = fontMeta.dataBlockStartOffset + relativeOffset;

    // Basic boundary check for reading width and height
    if (absoluteOffset + 2 > this.buffer.byteLength) {
      // console.warn(`[${this.filePath}] Insufficient data for glyph header: char "${char}", font "${fontMeta.internalName}" at offset ${absoluteOffset}.`);
      return null;
    }

    try {
      const glyphWidthInCells = this.dataView.getUint8(absoluteOffset);
      // const _glyphHeightInLinesReported = this.dataView.getUint8(absoluteOffset + 1); // Height reported in TDF

      const byteStream = [];
      let currentReadOffset = absoluteOffset + 2; // Start reading after width and height bytes
      let endOfGlyphStream = false;
      let actualHeightInLines = 0;
      let currentLineHasChars = false;

      while (!endOfGlyphStream) {
        if (currentReadOffset >= this.buffer.byteLength) {
          // console.warn(`[${this.filePath}] Unexpected end of buffer while reading glyph stream: char "${char}", font "${fontMeta.internalName}".`);
          endOfGlyphStream = true; // Treat as end of glyph if buffer ends
          break;
        }

        const charByte = this.dataView.getUint8(currentReadOffset++);

        if (charByte === 0x00) {
          // Null terminator for the glyph stream in TDF
          endOfGlyphStream = true;
          if (currentLineHasChars) {
            // If the last line had content before null terminator
            actualHeightInLines++;
          }
        } else if (charByte === 0x0d) {
          // Carriage return in TDF, represents a newline in the glyph
          byteStream.push(BIN_STREAM_NEWLINE_CODE); // Convert to our binary format's newline
          actualHeightInLines++;
          currentLineHasChars = false;
        } else {
          // This is a character code. The next byte should be its attribute.
          if (currentReadOffset >= this.buffer.byteLength) {
            // Check before reading attribute
            // console.warn(`[${this.filePath}] Unexpected end of buffer expecting attribute byte: char "${char}", font "${fontMeta.internalName}".`);
            endOfGlyphStream = true; // Treat as error/end
            break;
          }
          const attrByte = this.dataView.getUint8(currentReadOffset++);
          byteStream.push(charByte, attrByte);
          currentLineHasChars = true;
        }
      }

      // If stream has content but no newlines were counted (single-line glyph)
      if (actualHeightInLines === 0 && byteStream.length > 0) {
        actualHeightInLines = 1;
      }
      // Ensure minimum height of 1 if any data, even if it's just a newline code (empty line)
      if (actualHeightInLines === 0 && byteStream.some((b) => b === BIN_STREAM_NEWLINE_CODE)) {
        actualHeightInLines = 1;
      }

      return {
        width: glyphWidthInCells,
        height: actualHeightInLines > 0 ? actualHeightInLines : 1, // Ensure minimum height of 1 line
        stream: byteStream,
      };
    } catch (e) {
      console.error(
        `[${this.filePath}] Error during intermediate glyph extraction for char "${char}", font "${fontMeta.internalName}":`,
        e,
      );
      return null;
    }
  }
} // End TdfParserNode Class

// --- Bundle Building Logic ---

/**
 * Prepares the string pool and initial font index table data.
 * @param {Array<object>} allFontsIntermediate - Array of intermediate font data.
 * @returns {{fontIndexTableData: Array<object>, stringPoolBuffer: Buffer}}
 * `fontIndexTableData` contains {keyOffset, dataOffset (placeholder)} entries.
 * `stringPoolBuffer` is the concatenated buffer of null-terminated font keys.
 * @private
 */
function _buildStringPoolAndIndexPlaceholders(allFontsIntermediate) {
  const fontIndexTableData = []; // Stores { keyOffsetInPool, dataOffsetInPool (placeholder) }
  const stringPoolBuffers = [];
  let currentStringOffset = 0;

  for (const fontInfo of allFontsIntermediate) {
    const keyBuffer = Buffer.from(`${fontInfo.uniqueKey}\0`, "utf8"); // Null-terminate the key
    stringPoolBuffers.push(keyBuffer);
    fontIndexTableData.push({
      keyOffsetInPool: currentStringOffset,
      dataOffsetInPool: 0, // Placeholder, will be updated later
    });
    currentStringOffset += keyBuffer.length;
  }

  const stringPoolBuffer = Buffer.concat(stringPoolBuffers);
  return { fontIndexTableData, stringPoolBuffer };
}

/**
 * Prepares the font data pool.
 * Each font's data includes: spacing, glyph count, glyph lookup table, and glyph data streams.
 * Also updates the `dataOffsetInPool` in the `fontIndexTableData` array.
 * @param {Array<object>} allFontsIntermediate - Array of intermediate font data.
 * @param {Array<object>} fontIndexTableData - Array of index entries to be updated.
 * @returns {Buffer} The concatenated buffer of all font data blocks.
 * @private
 */
function _buildFontDataPool(allFontsIntermediate, fontIndexTableData) {
  const fontDataPoolBuffers = [];
  let currentDataPoolOffset = 0;

  for (const [fontArrIndex, fontInfo] of allFontsIntermediate.entries()) {
    fontIndexTableData[fontArrIndex].dataOffsetInPool = currentDataPoolOffset; // Update actual data offset

    const singleFontBlockBuffers = [];

    // 1. Font Spacing (1 byte)
    const spacingBuffer = Buffer.alloc(1);
    spacingBuffer.writeUInt8(fontInfo.spacing, 0);
    singleFontBlockBuffers.push(spacingBuffer);

    // 2. Glyph Count for this font (1 byte)
    const glyphEntries = Object.entries(fontInfo.glyphs).sort((a, b) => a[0].charCodeAt(0) - b[0].charCodeAt(0)); // Sort glyphs by char code for lookup table

    const glyphCount = glyphEntries.length;
    const glyphCountBuffer = Buffer.alloc(1);
    glyphCountBuffer.writeUInt8(glyphCount, 0);
    singleFontBlockBuffers.push(glyphCountBuffer);

    // 3. Glyph Lookup Table (GLT)
    // Each entry: 1 byte charCode, 2 bytes offset (Uint16LE) relative to start of Glyph Data Table (GDT)
    const lookupTableSizeBytes = glyphCount * 3;
    const lookupTableBuffer = Buffer.alloc(lookupTableSizeBytes);
    const glyphDataStreamBuffers = []; // To store actual data for each glyph
    let currentGlyphDataRelativeOffset = 0; // Offset relative to start of this font's GDT

    for (const [entryIndex, [char, glyphData]] of glyphEntries.entries()) {
      const lookupTableEntryOffset = entryIndex * 3;
      lookupTableBuffer.writeUInt8(char.charCodeAt(0), lookupTableEntryOffset);
      lookupTableBuffer.writeUInt16LE(currentGlyphDataRelativeOffset, lookupTableEntryOffset + 1);

      // Prepare this glyph's data: Width (1b), Height (1b), Stream (variable), Terminator (1b)
      const glyphHeaderBuffer = Buffer.alloc(2);
      glyphHeaderBuffer.writeUInt8(glyphData.width, 0); // Precalculated width in cells
      glyphHeaderBuffer.writeUInt8(glyphData.height, 1); // Precalculated height in lines

      const glyphStreamBuffer = Buffer.from(glyphData.stream); // The [charCode, attrByte, ...] sequence

      const glyphEndTerminatorBuffer = Buffer.alloc(1);
      glyphEndTerminatorBuffer.writeUInt8(BIN_STREAM_GLYPH_TERMINATOR, 0);

      const completeSingleGlyphBuffer = Buffer.concat([glyphHeaderBuffer, glyphStreamBuffer, glyphEndTerminatorBuffer]);
      glyphDataStreamBuffers.push(completeSingleGlyphBuffer);
      currentGlyphDataRelativeOffset += completeSingleGlyphBuffer.length;
    }

    singleFontBlockBuffers.push(lookupTableBuffer); // Add the GLT for this font
    singleFontBlockBuffers.push(...glyphDataStreamBuffers); // Add all GDT entries for this font

    const completeFontDataBlock = Buffer.concat(singleFontBlockBuffers);
    fontDataPoolBuffers.push(completeFontDataBlock);
    currentDataPoolOffset += completeFontDataBlock.length;
  }

  return Buffer.concat(fontDataPoolBuffers);
}

/**
 * Prepares the final Font Index Table buffer from the populated data.
 * @param {Array<object>} fontIndexTableData - Array of {keyOffsetInPool, dataOffsetInPool}.
 * @param {number} numFonts - The total number of fonts.
 * @returns {Buffer} The finalized Font Index Table buffer.
 * @private
 */
function _finalizeFontIndexTable(fontIndexTableData, numFonts) {
  // Each entry: 4 bytes keyOffset (UInt32LE), 4 bytes dataOffset (UInt32LE)
  const fontIndexTableBuffer = Buffer.alloc(numFonts * 8);
  for (const [i, entry] of fontIndexTableData.entries()) {
    fontIndexTableBuffer.writeUInt32LE(entry.keyOffsetInPool, i * 8);
    fontIndexTableBuffer.writeUInt32LE(entry.dataOffsetInPool, i * 8 + 4);
  }
  return fontIndexTableBuffer;
}

/**
 * Prepares the main header for the binary bundle.
 * @param {number} numFonts - Total number of fonts in the bundle.
 * @param {number} finalIndexTableBufferLength - Length of the finalized font index table.
 * @param {number} finalStringPoolBufferLength - Length of the finalized string pool.
 * @returns {Buffer} The header buffer.
 * @private
 */
function _buildBundleHeader(numFonts, finalIndexTableBufferLength, finalStringPoolBufferLength) {
  // Header structure:
  // Magic String (4 bytes: 'TDFB')
  // Version (1 byte: UInt8)
  // Font Count (4 bytes: UInt32LE)
  // Index Table Offset (4 bytes: UInt32LE)  -- relative to start of file
  // String Pool Offset (4 bytes: UInt32LE)  -- relative to start of file
  // Font Data Pool Offset (4 bytes: UInt32LE) -- relative to start of file
  const headerSize = 4 + 1 + 4 + 4 + 4 + 4; // 21 bytes
  const headerBuffer = Buffer.alloc(headerSize);
  let currentHeaderOffset = 0;

  currentHeaderOffset += headerBuffer.write(BIN_MAGIC_STRING, currentHeaderOffset, "ascii");
  currentHeaderOffset = headerBuffer.writeUInt8(BIN_BUNDLE_VERSION, currentHeaderOffset);
  currentHeaderOffset = headerBuffer.writeUInt32LE(numFonts, currentHeaderOffset);

  const indexTableAbsoluteOffset = headerSize;
  const stringPoolAbsoluteOffset = indexTableAbsoluteOffset + finalIndexTableBufferLength;
  const fontDataPoolAbsoluteOffset = stringPoolAbsoluteOffset + finalStringPoolBufferLength;

  currentHeaderOffset = headerBuffer.writeUInt32LE(indexTableAbsoluteOffset, currentHeaderOffset);
  currentHeaderOffset = headerBuffer.writeUInt32LE(stringPoolAbsoluteOffset, currentHeaderOffset);
  headerBuffer.writeUInt32LE(fontDataPoolAbsoluteOffset, currentHeaderOffset); // Last write, offset not incremented

  return headerBuffer;
}

/**
 * Main function to drive the TDF preprocessing and bundle creation.
 * Reads TDF files from an input directory, parses them, extracts glyph data,
 * and then constructs a single binary bundle file.
 */
function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error("Usage: node preprocess_tdf.js <input_tdf_directory> <output_bin_file_path>");
    console.error("Example: node preprocess_tdf.js ./my_tdf_fonts ./dist/font_bundle.bin");
    process.exit(1);
  }
  const inputDirectory = args[0];
  const outputFilePath = args[1];

  const allFontsIntermediateData = []; // Stores { uniqueKey, spacing, glyphs: { char: {w,h,stream} } }
  let filesSuccessfullyProcessed = 0;

  console.log("Starting TDF preprocessing...");
  console.log(`Input directory: ${path.resolve(inputDirectory)}`);
  console.log(`Output file:     ${path.resolve(outputFilePath)}`);

  // --- Step 1: Read and Parse TDF files ---
  try {
    const filesInDir = fs.readdirSync(inputDirectory);
    for (const file of filesInDir) {
      if (path.extname(file).toLowerCase() !== ".tdf") {
        return; // Skip non-TDF files
      }
      const fullFilePath = path.join(inputDirectory, file);
      // console.log(`Processing TDF file: ${file}`);
      try {
        const tdfFileBuffer = fs.readFileSync(fullFilePath);
        const parser = new TdfParserNode(tdfFileBuffer, fullFilePath);
        const parsedFontsInCurrentFile = parser.parse(); // Gets metadata for all fonts in this TDF

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
            // console.log(`  Added font: ${fontMetadata.uniqueKey} with ${glyphsFoundInThisFont} glyphs.`);
          } else {
            // console.warn(`[${fullFilePath}] Font "${fontMetadata.internalName}" had no supported glyphs extracted.`);
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
  // console.log("\nFonts sorted for bundle indexing.");

  // --- Step 3: Build Binary Bundle Components ---
  console.log("\nBuilding binary bundle components...");

  // 3a. Prepare String Pool and initial Font Index data (with placeholder data offsets)
  const { fontIndexTableData, stringPoolBuffer } = _buildStringPoolAndIndexPlaceholders(allFontsIntermediateData);
  // console.log(`  String Pool created (${stringPoolBuffer.length} bytes).`);

  // 3b. Prepare Font Data Pool (actual glyph data) and update data offsets in fontIndexTableData
  const fontDataPoolBuffer = _buildFontDataPool(allFontsIntermediateData, fontIndexTableData);
  // console.log(`  Font Data Pool created (${fontDataPoolBuffer.length} bytes).`);

  // 3c. Prepare final Font Index Table buffer (with updated data offsets)
  const numFonts = allFontsIntermediateData.length;
  const finalFontIndexTableBuffer = _finalizeFontIndexTable(fontIndexTableData, numFonts);
  // console.log(`  Font Index Table finalized (${finalFontIndexTableBuffer.length} bytes).`);

  // 3d. Prepare Header
  const headerBuffer = _buildBundleHeader(numFonts, finalFontIndexTableBuffer.length, stringPoolBuffer.length);
  // console.log(`  Bundle Header created (${headerBuffer.length} bytes).`);

  // --- Step 4: Concatenate all parts to form the final bundle ---
  const finalBundleBuffer = Buffer.concat([
    headerBuffer,
    finalFontIndexTableBuffer,
    stringPoolBuffer,
    fontDataPoolBuffer,
  ]);

  // --- Step 5: Write bundle to output file ---
  console.log(`\nWriting binary bundle (${finalBundleBuffer.length} bytes) to: ${outputFilePath}`);
  try {
    // Ensure output directory exists
    const outputDir = path.dirname(outputFilePath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
      // console.log(`  Created output directory: ${outputDir}`);
    }

    fs.writeFileSync(outputFilePath, finalBundleBuffer);
    console.log("Binary font bundle created successfully!");
  } catch (writeError) {
    console.error(`Fatal error writing binary file ${outputFilePath}:`, writeError.message);
    process.exit(1);
  }
}

// Execute the main script function
main();
