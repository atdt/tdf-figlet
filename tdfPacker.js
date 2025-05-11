#!/usr/bin/env node

// tdfPacker.js v2.0
// Preprocesses TheDraw Font (.TDF) files from a directory into a single,
// compact binary bundle (.bin) for use with tdfRenderer.js.
// Handles multi-font TDFs, creates unique font keys, and stores data compactly.
// Implements palette-based encoding for color fonts.

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
const BIN_BUNDLE_VERSION = 2; // Incremented version due to new encoding
const BIN_STREAM_NEWLINE_CODE = 0x0d; // Byte code for newline (Carriage Return) in raw glyph stream.
const BIN_STREAM_GLYPH_TERMINATOR = 0x00; // Byte code terminating a raw glyph's stream.

// --- Constants for New Encoding ---
const BIN_FONT_ENCODING_RAW = 0;
const BIN_FONT_ENCODING_PALETTE_INTERSPERSED = 1;

const PALETTE_PREFIX_DATA = 0; // Indicates (CP_Index, AP_Index) pair follows
const PALETTE_PREFIX_SPECIAL = 1; // Indicates CR or NULL code follows

// After PALETTE_PREFIX_SPECIAL, 1 more bit defines the special code:
const PALETTE_SPECIAL_CODE_CR = 0; //  (effectively 10 after prefix)
const PALETTE_SPECIAL_CODE_NULL = 1; // (effectively 11 after prefix)


// --- General Constants ---

/**
 * List of 94 printable ASCII characters (ASCII 33-126)
 * for which TDF fonts typically store glyph offset information.
 */
const SUPPORTED_CHAR_LIST =
  "!\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";


// --- BitStream Writer Utility ---
class BitStreamWriter {
    constructor() {
        this.bufferArray = []; // Array of bytes
        this.currentByte = 0;
        this.bitPosition = 0; // 0-7, LSB to MSB
    }

    /**
     * Writes bits to the stream.
     * @param {number} value - The integer value to write.
     * @param {number} numBits - The number of bits to write from the value (LSB first).
     */
    write(value, numBits) {
        if (numBits === 0) return;
        for (let i = 0; i < numBits; i++) {
            const bit = (value >> i) & 1;
            if (bit) {
                this.currentByte |= (1 << this.bitPosition);
            }
            this.bitPosition++;
            if (this.bitPosition === 8) {
                this.bufferArray.push(this.currentByte);
                this.currentByte = 0;
                this.bitPosition = 0;
            }
        }
    }

    /**
     * Finalizes the stream, writing any pending bits in the currentByte.
     * @returns {Buffer} The buffer containing all written bits.
     */
    getBuffer() {
        if (this.bitPosition > 0) {
            this.bufferArray.push(this.currentByte);
            // Reset for potential reuse, though typically called once at the end
            this.currentByte = 0;
            this.bitPosition = 0;
        }
        const finalBuffer = Buffer.from(this.bufferArray);
        this.bufferArray = []; // Clear internal array for next glyph
        return finalBuffer;
    }
}


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
    const typeOffset = headerStartIndex + 21; // Relative to TDF_HEADER_SIGNATURE start
    const spacingOffset = headerStartIndex + 22;
    const charTableOffset = headerStartIndex + 25;

    if (headerStartIndex + TDF_FONT_METADATA_BLOCK_SIZE > this.dataView.byteLength) {
      console.warn(`[${this.filePath}] Insufficient data for full TDF header at offset ${headerStartIndex}.`);
      return null;
    }

    try {
      const fontNameLength = Math.min(this.dataView.getUint8(nameLenOffset), 12);
      let fontName = "";
      for (let i = 0; i < fontNameLength; i++) {
        const charCode = this.dataView.getUint8(nameCharsOffset + i);
        if (charCode === 0) break;
        fontName += String.fromCharCode(charCode);
      }
      fontName = fontName.trim();

      const fontType = this.dataView.getUint8(typeOffset);
      if (fontType !== TDF_COLOR_FONT_TYPE) {
        console.log(`[${this.filePath}] Skipping non-color font "${fontName || 'Unnamed'}" (type: ${fontType})`);
        return null; // Only process color fonts for now with new encoding
      }

      const letterSpacingRaw = this.dataView.getUint8(spacingOffset);
      const letterSpacing = letterSpacingRaw > 0 ? letterSpacingRaw - 1 : 0;

      const charGlyphOffsets = {};
      for (let i = 0; i < SUPPORTED_CHAR_LIST.length; i++) {
        const charOffsetInTdf = this.dataView.getUint16(charTableOffset + i * 2, true);
        if (charOffsetInTdf !== 0xffff) {
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
        dataBlockStartOffset,
      };
    } catch (e) {
      console.error(`[${this.filePath}] Error parsing metadata in TDF header at offset ${headerStartIndex}:`, e);
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
        break;
      }

      const fontMetadata = this._extractFontMetadataFromHeader(headerStartIndex);
      if (fontMetadata) {
        this.fonts.push(fontMetadata);
      }
      currentSearchOffset = headerStartIndex + TDF_HEADER_SIGNATURE.length;
    }
    return this.fonts;
  }

  /**
   * Extracts glyph data for a character.
   * If font is color and encoding is enabled, it returns a bit-packed stream.
   *
   * @param {object} fontMeta - Font metadata object.
   * @param {string} char - Character to extract (e.g., 'A').
   * @param {object | null} paletteInfoForEncoding - Optional: { cp, ap, bitsPerCPIndex, bitsPerAPIndex } for encoding.
   * @returns {{width: number, height: number, stream: (Array<number> | Buffer), encodingType: number } | null}
   */
  extractIntermediateGlyphData(fontMeta, char, paletteInfoForEncoding = null) {
    const relativeOffset = fontMeta.offsets[char];
    if (typeof relativeOffset === "undefined") {
      return null;
    }

    const absoluteOffset = fontMeta.dataBlockStartOffset + relativeOffset;
    if (absoluteOffset + 2 > this.buffer.byteLength) {
      console.warn(`[${this.filePath}] Insufficient data for glyph "${char}" header in font "${fontMeta.internalName}".`);
      return null;
    }

    try {
      const glyphWidthInCells = this.dataView.getUint8(absoluteOffset);
      // const _glyphHeightInLinesReported = this.dataView.getUint8(absoluteOffset + 1); // Original TDF height

      let currentReadOffset = absoluteOffset + 2;
      let actualHeightInLines = 0;
      let currentLineHasChars = false;

      if (fontMeta.type === TDF_COLOR_FONT_TYPE && paletteInfoForEncoding) {
        // --- NEW PALETTE-ENCODING PATH ---
        const bitWriter = new BitStreamWriter();
        const { cp, ap, bitsPerCPIndex, bitsPerAPIndex } = paletteInfoForEncoding;

        // eslint-disable-next-line no-constant-condition
        while (true) {
          if (currentReadOffset >= this.buffer.byteLength) {
             console.warn(`[${this.filePath}] Unexpected end of buffer in glyph "${char}", font "${fontMeta.internalName}" during palette encoding.`);
             break;
          }
          const charByte = this.dataView.getUint8(currentReadOffset++);

          if (charByte === 0x00) { // TDF Glyph Terminator
            bitWriter.write(PALETTE_PREFIX_SPECIAL, 1);
            bitWriter.write(PALETTE_SPECIAL_CODE_NULL, 1);
            if (currentLineHasChars) actualHeightInLines++;
            break;
          } else if (charByte === 0x0d) { // TDF Newline
            bitWriter.write(PALETTE_PREFIX_SPECIAL, 1);
            bitWriter.write(PALETTE_SPECIAL_CODE_CR, 1);
            actualHeightInLines++;
            currentLineHasChars = false;
          } else { // Displayable character
            if (currentReadOffset >= this.buffer.byteLength) {
                console.warn(`[${this.filePath}] Unexpected end of buffer expecting attribute for char ${charByte} in glyph "${char}", font "${fontMeta.internalName}".`);
                break;
            }
            const attrByte = this.dataView.getUint8(currentReadOffset++);

            const cpIndex = cp.indexOf(charByte);
            const apIndex = ap.indexOf(attrByte);

            if (cpIndex === -1) {
              console.error(`FATAL: Character ${charByte} (0x${charByte.toString(16)}) not found in CP for font ${fontMeta.internalName}. Palettes might be incomplete.`);
              // This implies a flaw in palette generation logic if it occurs.
              // For robustness, could add it to palette on the fly, but better to ensure comprehensive generation.
              // Or skip, but that corrupts the glyph. For now, error.
              throw new Error(`Character ${charByte} not in CP for font ${fontMeta.internalName}`);
            }
             if (apIndex === -1) {
              console.error(`FATAL: Attribute ${attrByte} (0x${attrByte.toString(16)}) not found in AP for font ${fontMeta.internalName}. Palettes might be incomplete.`);
              throw new Error(`Attribute ${attrByte} not in AP for font ${fontMeta.internalName}`);
            }


            bitWriter.write(PALETTE_PREFIX_DATA, 1);
            if (bitsPerCPIndex > 0) bitWriter.write(cpIndex, bitsPerCPIndex);
            if (bitsPerAPIndex > 0) bitWriter.write(apIndex, bitsPerAPIndex);
            currentLineHasChars = true;
          }
        }
        return {
          width: glyphWidthInCells,
          height: actualHeightInLines > 0 ? actualHeightInLines : (glyphWidthInCells > 0 ? 1 : 0), // Ensure non-empty glyph has height
          stream: bitWriter.getBuffer(),
          encodingType: BIN_FONT_ENCODING_PALETTE_INTERSPERSED,
        };

      } else {
        // --- ORIGINAL RAW BYTE STREAM PATH (for non-color fonts or if encoding disabled) ---
        const byteStream = [];
        // eslint-disable-next-line no-constant-condition
        while (true) {
          if (currentReadOffset >= this.buffer.byteLength) {
            console.warn(`[${this.filePath}] Unexpected end of buffer in raw glyph "${char}", font "${fontMeta.internalName}".`);
            break;
          }
          const charByte = this.dataView.getUint8(currentReadOffset++);

          if (charByte === 0x00) { // TDF Glyph Terminator
            if (currentLineHasChars) actualHeightInLines++;
            // Terminator is added by packer for raw streams later
            break;
          } else if (charByte === 0x0d) { // TDF Newline
            byteStream.push(BIN_STREAM_NEWLINE_CODE);
            actualHeightInLines++;
            currentLineHasChars = false;
          } else { // Displayable character
            if (currentReadOffset >= this.buffer.byteLength) {
                console.warn(`[${this.filePath}] Unexpected end of buffer expecting attribute for char ${charByte} in raw glyph "${char}", font "${fontMeta.internalName}".`);
                break;
            }
            const attrByte = this.dataView.getUint8(currentReadOffset++);
            byteStream.push(charByte, attrByte);
            currentLineHasChars = true;
          }
        }
        return {
          width: glyphWidthInCells,
          height: actualHeightInLines > 0 ? actualHeightInLines : (glyphWidthInCells > 0 || byteStream.length > 0 ? 1: 0),
          stream: byteStream,
          encodingType: BIN_FONT_ENCODING_RAW,
        };
      }
    } catch (e) {
      console.error(
        `[${this.filePath}] Error extracting glyph for char "${char}", font "${fontMeta.internalName}":`,
        e,
      );
      return null;
    }
  }
} // End TdfParserNode Class


/**
 * Generates Character Palette (CP) and Attribute Palette (AP) for a TDF color font's glyphs.
 * @param {Buffer} tdfBuffer - The raw buffer data of the TDF file.
 * @param {DataView} tdfDataView - DataView for the TDF buffer.
 * @param {object} fontMeta - The font metadata object from TdfParserNode.
 * @returns {{ cp: number[], ap: number[], bitsPerCPIndex: number, bitsPerAPIndex: number } | null}
 */
function generatePalettes(tdfBuffer, tdfDataView, fontMeta) {
    if (fontMeta.type !== TDF_COLOR_FONT_TYPE) return null;

    const uniqueCharCodes = new Set();
    const uniqueAttrCodes = new Set();

    // Iterate over all characters defined in the font's offset table
    for (const charKey of Object.keys(fontMeta.offsets)) {
        const relativeOffset = fontMeta.offsets[charKey];
        // No need to check typeof relativeOffset, Object.keys only gives defined ones
        
        const absoluteOffset = fontMeta.dataBlockStartOffset + relativeOffset;
        if (absoluteOffset + 2 > tdfBuffer.byteLength) { // Min 2 bytes for width/height
            // console.warn(`[${fontMeta.filePath || 'TDF'}] Insufficient data for glyph header (char '${charKey}') in palette scan for font "${fontMeta.internalName}".`);
            continue;
        }

        let currentReadOffset = absoluteOffset + 2; // Start after width/height

        // eslint-disable-next-line no-constant-condition
        while (true) {
            if (currentReadOffset >= tdfBuffer.byteLength) break;
            const charByte = tdfDataView.getUint8(currentReadOffset++);

            if (charByte === 0x00) break; // End of this glyph's stream
            if (charByte === 0x0d) continue; // CR, does not have a color byte

            // This is a displayable character, expect an attribute byte next
            if (currentReadOffset >= tdfBuffer.byteLength) {
                // This would mean a corrupted TDF (char without attr before NULL/CR)
                // console.warn(`[${fontMeta.filePath || 'TDF'}] Unexpected end of buffer expecting attribute after char ${charByte} in palette scan for font "${fontMeta.internalName}", char '${charKey}'.`);
                break;
            }
            const attrByte = tdfDataView.getUint8(currentReadOffset++);

            uniqueCharCodes.add(charByte);
            uniqueAttrCodes.add(attrByte);
        }
    }

    const cp = Array.from(uniqueCharCodes).sort((a, b) => a - b);
    const ap = Array.from(uniqueAttrCodes).sort((a, b) => a - b);

    // Calculate bits needed for indices. If length is 0 or 1, 0 bits are needed.
    const bitsPerCPIndex = cp.length > 1 ? Math.ceil(Math.log2(cp.length)) : (cp.length === 1 ? 0 : 0);
    const bitsPerAPIndex = ap.length > 1 ? Math.ceil(Math.log2(ap.length)) : (ap.length === 1 ? 0 : 0);


    return { cp, ap, bitsPerCPIndex, bitsPerAPIndex };
}


// --- Bundle Building Logic ---

/**
 * Prepares string pool and initial font index table placeholders.
 * @private
 */
function _buildStringPoolAndIndexPlaceholders(allFontsIntermediate) {
  const fontIndexTableData = [];
  const stringPoolBuffers = [];
  let currentStringOffset = 0;

  for (const fontInfo of allFontsIntermediate) {
    const keyBuffer = Buffer.from(`${fontInfo.uniqueKey}\0`, "utf8");
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
 * Font data: encodingType, (palettes if encoded), spacing, glyph count,
 * glyph lookup table (GLT), glyph data streams (GDT).
 * @private
 */
function _buildFontDataPool(allFontsIntermediate, fontIndexTableData) {
  const fontDataPoolBuffers = [];
  let currentDataPoolOffset = 0;

  for (const [fontArrIndex, fontInfo] of allFontsIntermediate.entries()) {
    fontIndexTableData[fontArrIndex].dataOffsetInPool = currentDataPoolOffset;

    const singleFontBlockBuffers = [];

    // Determine encoding type for this font (first glyph's type should be representative)
    let representativeEncodingType = BIN_FONT_ENCODING_RAW; // Default
    if (fontInfo.glyphs && Object.keys(fontInfo.glyphs).length > 0) {
        const firstGlyphChar = Object.keys(fontInfo.glyphs)[0];
        if (fontInfo.glyphs[firstGlyphChar]) {
            representativeEncodingType = fontInfo.glyphs[firstGlyphChar].encodingType;
        }
    }


    // 1. Font Encoding Type (1 byte)
    const encodingTypeBuffer = Buffer.alloc(1);
    encodingTypeBuffer.writeUInt8(representativeEncodingType, 0);
    singleFontBlockBuffers.push(encodingTypeBuffer);

    // 2. Palette Data (if encoded)
    if (representativeEncodingType === BIN_FONT_ENCODING_PALETTE_INTERSPERSED && fontInfo.paletteInfo) {
        const { cp, ap, bitsPerCPIndex, bitsPerAPIndex } = fontInfo.paletteInfo;

        // CP Size (1 byte), CP Data (variable)
        const cpSizeBuffer = Buffer.alloc(1);
        cpSizeBuffer.writeUInt8(cp.length, 0);
        singleFontBlockBuffers.push(cpSizeBuffer);
        if (cp.length > 0) {
            singleFontBlockBuffers.push(Buffer.from(cp));
        }

        // AP Size (1 byte), AP Data (variable)
        const apSizeBuffer = Buffer.alloc(1);
        apSizeBuffer.writeUInt8(ap.length, 0);
        singleFontBlockBuffers.push(apSizeBuffer);
        if (ap.length > 0) {
            singleFontBlockBuffers.push(Buffer.from(ap));
        }

        // Bits per Index: CP (1 byte), AP (1 byte)
        const bitsInfoBuffer = Buffer.alloc(2);
        bitsInfoBuffer.writeUInt8(bitsPerCPIndex, 0);
        bitsInfoBuffer.writeUInt8(bitsPerAPIndex, 1);
        singleFontBlockBuffers.push(bitsInfoBuffer);
    } else if (representativeEncodingType === BIN_FONT_ENCODING_PALETTE_INTERSPERSED && !fontInfo.paletteInfo) {
        // This case should ideally not happen if logic is correct.
        // It means we decided to encode but paletteInfo is missing.
        // Write minimal palette data to avoid breaking structure, but log error.
        console.error(`ERROR: Font ${fontInfo.uniqueKey} marked for palette encoding but paletteInfo is missing. Writing empty palettes.`);
        singleFontBlockBuffers.push(Buffer.from([0, 0, 0, 0])); // CPSize=0, APSize=0, BitsCP=0, BitsAP=0
    }


    // 3. Font Spacing (1 byte)
    const spacingBuffer = Buffer.alloc(1);
    spacingBuffer.writeUInt8(fontInfo.spacing, 0);
    singleFontBlockBuffers.push(spacingBuffer);

    // 4. Glyph Count (1 byte)
    const glyphEntries = Object.entries(fontInfo.glyphs).sort((a, b) => a[0].charCodeAt(0) - b[0].charCodeAt(0));
    const glyphCount = glyphEntries.length;
    const glyphCountBuffer = Buffer.alloc(1);
    glyphCountBuffer.writeUInt8(glyphCount, 0);
    singleFontBlockBuffers.push(glyphCountBuffer);

    // 5. Glyph Lookup Table (GLT)
    const lookupTableSizeBytes = glyphCount * 3;
    const lookupTableBuffer = Buffer.alloc(lookupTableSizeBytes);
    const glyphDataStreamBuffers = [];
    let currentGlyphDataRelativeOffset = 0;

    for (const [entryIndex, [char, glyphData]] of glyphEntries.entries()) {
      const lookupTableEntryOffset = entryIndex * 3;
      lookupTableBuffer.writeUInt8(char.charCodeAt(0), lookupTableEntryOffset);
      lookupTableBuffer.writeUInt16LE(currentGlyphDataRelativeOffset, lookupTableEntryOffset + 1);

      const glyphHeaderBuffer = Buffer.alloc(2); // Width (1B), Height (1B)
      glyphHeaderBuffer.writeUInt8(glyphData.width, 0);
      glyphHeaderBuffer.writeUInt8(glyphData.height, 1);

      const glyphStreamBuffer = Buffer.isBuffer(glyphData.stream) ?
          glyphData.stream :
          Buffer.from(glyphData.stream); // Convert Array<number> to Buffer if raw

      let completeSingleGlyphBuffer;
      if (glyphData.encodingType === BIN_FONT_ENCODING_PALETTE_INTERSPERSED) {
          completeSingleGlyphBuffer = Buffer.concat([
              glyphHeaderBuffer,
              glyphStreamBuffer, // Terminator is embedded
          ]);
      } else { // BIN_FONT_ENCODING_RAW
          const glyphEndTerminatorBuffer = Buffer.alloc(1, BIN_STREAM_GLYPH_TERMINATOR);
          completeSingleGlyphBuffer = Buffer.concat([
              glyphHeaderBuffer,
              glyphStreamBuffer,
              glyphEndTerminatorBuffer,
          ]);
      }
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
 * @private
 */
function _finalizeFontIndexTable(fontIndexTableData, numFonts) {
  const fontIndexTableBuffer = Buffer.alloc(numFonts * 8);
  for (const [i, entry] of fontIndexTableData.entries()) {
    fontIndexTableBuffer.writeUInt32LE(entry.keyOffsetInPool, i * 8);
    fontIndexTableBuffer.writeUInt32LE(entry.dataOffsetInPool, i * 8 + 4);
  }
  return fontIndexTableBuffer;
}

/**
 * Prepares the main header for the binary bundle.
 * @private
 */
function _buildBundleHeader(numFonts, finalIndexTableBufferLength, finalStringPoolBufferLength) {
  const headerSize = 4 + 1 + 4 + 4 + 4 + 4; // 21 bytes
  const headerBuffer = Buffer.alloc(headerSize);
  let offset = 0;

  offset += headerBuffer.write(BIN_MAGIC_STRING, offset, "ascii");
  offset = headerBuffer.writeUInt8(BIN_BUNDLE_VERSION, offset); // Updated Version
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

  const allFontsIntermediateData = [];
  let filesSuccessfullyProcessed = 0;

  console.log(`tdfPacker.js v${BIN_BUNDLE_VERSION}.0`);
  console.log("Starting TDF preprocessing...");
  console.log(`Input directory: ${path.resolve(inputDirectory)}`);
  console.log(`Output file:     ${path.resolve(outputFilePath)}`);

  try {
    const filesInDir = fs.readdirSync(inputDirectory);
    for (const file of filesInDir) {
      if (path.extname(file).toLowerCase() !== ".tdf") {
        continue;
      }
      const fullFilePath = path.join(inputDirectory, file);
      try {
        const tdfFileBuffer = fs.readFileSync(fullFilePath);
        const parser = new TdfParserNode(tdfFileBuffer, fullFilePath);
        const parsedFontsInCurrentFile = parser.parse(); // Only returns color fonts

        for (const fontMetadata of parsedFontsInCurrentFile) {
          let paletteInfoForFont = null;
          if (fontMetadata.type === TDF_COLOR_FONT_TYPE) {
            // Pass parser.buffer and parser.dataView to generatePalettes
            paletteInfoForFont = generatePalettes(parser.buffer, parser.dataView, fontMetadata);
          }
          // Store palette info with fontMetadata for _buildFontDataPool
          fontMetadata.paletteInfo = paletteInfoForFont;

          const extractedGlyphs = {};
          let glyphsFoundInThisFont = 0;
          for (const char of SUPPORTED_CHAR_LIST) {
            const glyphIntermediate = parser.extractIntermediateGlyphData(fontMetadata, char, paletteInfoForFont);
            if (glyphIntermediate) {
              extractedGlyphs[char] = glyphIntermediate;
              glyphsFoundInThisFont++;
            }
          }

          if (glyphsFoundInThisFont > 0) {
            allFontsIntermediateData.push({
              uniqueKey: fontMetadata.uniqueKey,
              internalName: fontMetadata.internalName,
              type: fontMetadata.type,
              spacing: fontMetadata.spacing,
              glyphs: extractedGlyphs,
              paletteInfo: paletteInfoForFont, // Crucial for _buildFontDataPool
            });
            console.log(`  Processed font: ${fontMetadata.uniqueKey} (Glyphs: ${glyphsFoundInThisFont}, Encoding: ${paletteInfoForFont ? 'Palette' : 'Raw'})`);
            if(paletteInfoForFont) {
                console.log(`    CP size: ${paletteInfoForFont.cp.length} (${paletteInfoForFont.bitsPerCPIndex} bits), AP size: ${paletteInfoForFont.ap.length} (${paletteInfoForFont.bitsPerAPIndex} bits)`);
            }
          }
        }
        filesSuccessfullyProcessed++;
        console.log(`Processed file: ${file}`);
      } catch (readOrParseError) {
        console.error(`Error processing file ${fullFilePath}:`, readOrParseError.message, readOrParseError.stack);
      }
    }
  } catch (dirAccessError) {
    console.error(`Fatal error accessing input directory ${inputDirectory}:`, dirAccessError.message);
    process.exit(1);
  }

  console.log(`\nSuccessfully processed data from ${filesSuccessfullyProcessed} TDF files.`);
  console.log(`Found ${allFontsIntermediateData.length} TDF color fonts with extractable glyphs to include in bundle.`);

  if (allFontsIntermediateData.length === 0) {
    console.log("No font data to write to bundle. Exiting.");
    return;
  }

  allFontsIntermediateData.sort((a, b) => a.uniqueKey.localeCompare(b.uniqueKey));

  console.log("\nBuilding binary bundle components...");

  const { fontIndexTableData, stringPoolBuffer } = _buildStringPoolAndIndexPlaceholders(allFontsIntermediateData);
  const fontDataPoolBuffer = _buildFontDataPool(allFontsIntermediateData, fontIndexTableData);
  const numFonts = allFontsIntermediateData.length;
  const finalFontIndexTableBuffer = _finalizeFontIndexTable(fontIndexTableData, numFonts);
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
      fs.mkdirSync(outputDir, { recursive: true });
    }
    fs.writeFileSync(outputFilePath, finalBundleBuffer);
    console.log(`Binary font bundle created successfully! Version: ${BIN_BUNDLE_VERSION}`);
  } catch (writeError) {
    console.error(`Fatal error writing binary file ${outputFilePath}:`, writeError.message);
    process.exit(1);
  }
}

main();
