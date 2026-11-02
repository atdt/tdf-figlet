#!/usr/bin/env node

// tdfPacker.js (Bundle Version: 6)
// Preprocesses TheDraw Font (.TDF) files from a directory into a single binary bundle
// according to the TDF Font Bundle Specification v6 (see tdf-fonts.md).
// The bundle is laid out for compression by the web server's gzip, which sees only
// a 32 KiB window. This version implements:
// - Implicit glyph structure (encoder pads ragged lines from original TDF).
// - Local palette of (Character Code, Color Attribute) pairs per font, ordered by frequency.
// - Glyph cells stored as one byte per cell, with no run-length encoding.
// - All metadata ahead of all cell data.
// - One record per distinct font, shared by every font key with identical content.
// - Records ordered so that fonts with similar glyph shapes are adjacent.
// - Glyphs identical to the same glyph in the preceding record stored by reference.
// - Fonts that differ from another font only in palette stored as that palette alone.

import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";

// --- TDF Format Constants (from original .TDF file structure) ---
const TDF_COLOR_FONT_TYPE = 2; // Identifier for TDF color fonts.
const TDF_HEADER_SIGNATURE = Buffer.from([0x55, 0xaa, 0x00, 0xff]); // Marks start of a TDF font header.
const TDF_FONT_METADATA_BLOCK_SIZE = 213; // Size in bytes from TDF_HEADER_SIGNATURE to end of char offset table.

// --- Binary Bundle Constants (Output bundle structure - v6) ---
const BIN_MAGIC_STRING = "TDFB"; // Magic string for "TDF Bundle".
const BIN_BUNDLE_VERSION = 6; // Version number of this binary bundle format.
const MAX_PALETTE_SIZE = 255; // nPairs is stored in one byte.

// --- Padding Pair Definition ---
// Used by the encoder to make ragged TDF glyphs into dense rectangular blocks.
const PADDING_CHAR = 0x20; // Space character (CP437).
const PADDING_ATTR = 0x00; // Black on Black color attribute.

// Glyphs whose shapes determine the record order (see sortRecordsByShape).
const SHAPE_SIGNATURE_CHARS = "AaHO";

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
 * Converts a raw glyph into a dense row-major grid of (char, attr) pairs,
 * padding short lines with the padding pair and truncating long ones to the declared width.
 * @param {{declaredWidth: number, actualHeight: number, lines: Array<Array<{charByte:number, attrByte:number}>>}} rawGlyph
 * @returns {Array<{char:number, attr:number}>} `declaredWidth * actualHeight` cells.
 */
function toDenseCells(rawGlyph) {
  const { declaredWidth, actualHeight, lines } = rawGlyph;
  const cells = [];
  for (let y = 0; y < actualHeight; y++) {
    const line = lines[y] || [];
    for (let x = 0; x < declaredWidth; x++) {
      cells.push(
        x < line.length
          ? { char: line[x].charByte, attr: line[x].attrByte }
          : { char: PADDING_CHAR, attr: PADDING_ATTR },
      );
    }
  }
  return cells;
}

/**
 * Encodes one font as a record: a pair palette plus, for each glyph, its dimensions and
 * a stream of palette indices.
 *
 * The palette is ordered by descending frequency (ties broken by char, then attr), so that
 * index 0 is usually the font's background cell. This makes the index streams of different
 * fonts statistically alike, which is what lets gzip find matches between them.
 *
 * @param {number} spacing - Letter spacing of the font.
 * @param {Object<string, object>} rawGlyphs - Map of character to raw glyph.
 * @returns {{spacing: number, pairPalette: Array<{char:number, attr:number}>,
 *   glyphs: Array<{charCode:number, width:number, height:number, cells:Buffer}>} | null}
 *   The record, or null if the font uses more than MAX_PALETTE_SIZE distinct pairs.
 */
function encodeFontRecord(spacing, rawGlyphs) {
  const denseGlyphs = Object.entries(rawGlyphs)
    .map(([charKey, rawGlyph]) => ({
      charCode: charKey.charCodeAt(0),
      width: rawGlyph.declaredWidth,
      height: rawGlyph.actualHeight,
      cells: toDenseCells(rawGlyph),
    }))
    .sort((a, b) => a.charCode - b.charCode);

  const pairCounts = new Map(); // Key: (char << 8) | attr.
  for (const glyph of denseGlyphs) {
    for (const cell of glyph.cells) {
      const pairKey = (cell.char << 8) | cell.attr;
      pairCounts.set(pairKey, (pairCounts.get(pairKey) || 0) + 1);
    }
  }
  if (pairCounts.size > MAX_PALETTE_SIZE) return null;

  const paletteKeys = [...pairCounts.keys()].sort((a, b) => pairCounts.get(b) - pairCounts.get(a) || a - b);
  const pairToIndex = new Map(paletteKeys.map((pairKey, index) => [pairKey, index]));

  return {
    spacing,
    pairPalette: paletteKeys.map((pairKey) => ({ char: pairKey >> 8, attr: pairKey & 0xff })),
    glyphs: denseGlyphs.map(({ charCode, width, height, cells }) => ({
      charCode,
      width,
      height,
      cells: Buffer.from(cells.map((cell) => pairToIndex.get((cell.char << 8) | cell.attr))),
    })),
  };
}

/**
 * Serializes a record's content, for detecting fonts that are identical in every respect.
 * @param {object} record - A record from encodeFontRecord.
 * @returns {string}
 */
function recordContentKey(record) {
  const parts = [record.spacing, record.pairPalette.map((p) => `${p.char},${p.attr}`).join(";")];
  for (const glyph of record.glyphs) {
    parts.push(`${glyph.charCode},${glyph.width},${glyph.height},${glyph.cells.toString("hex")}`);
  }
  return parts.join("|");
}

/**
 * Sorts records so that fonts with similar glyph shapes are adjacent.
 *
 * A font collection holds many recolored copies of the same shapes, but alphabetical order
 * scatters them beyond gzip's 32 KiB window. The sort key is the character codes (ignoring
 * attributes) of a few common glyphs, so recolored variants of one design sort together.
 *
 * @param {Array<{uniqueKeys: string[], record: object}>} entries - Entries to sort in place.
 */
function sortRecordsByShape(entries) {
  const signatureOf = (record) => {
    const bytes = [];
    for (const char of SHAPE_SIGNATURE_CHARS) {
      const charCode = char.charCodeAt(0);
      const glyph = record.glyphs.find((g) => g.charCode === charCode);
      if (!glyph) continue;
      bytes.push(glyph.width, glyph.height);
      for (const index of glyph.cells) bytes.push(record.pairPalette[index].char);
    }
    return Buffer.from(bytes);
  };
  for (const entry of entries) entry.signature = signatureOf(entry.record);
  entries.sort((a, b) => Buffer.compare(a.signature, b.signature) || a.uniqueKeys[0].localeCompare(b.uniqueKeys[0]));
}

/**
 * Finds the palette under which `other` has exactly the cells of `base`.
 *
 * If both fonts have the same glyphs with the same dimensions, and every cell where `base` has
 * palette index j holds the same pair in `other`, then `other` is `base`'s index streams read
 * through a palette of its own: entry j of the result. This captures fonts released in several
 * color schemes, and also fonts that swap one shading character for another.
 *
 * @param {object} base - A record from encodeFontRecord.
 * @param {object} other - A record from encodeFontRecord.
 * @returns {Array<{char:number, attr:number}> | null} A palette with one entry per entry of
 *   `base`'s palette, or null if no such palette exists.
 */
function derivePalette(base, other) {
  if (base.glyphs.length !== other.glyphs.length) return null;
  const palette = new Array(base.pairPalette.length);
  for (const [g, baseGlyph] of base.glyphs.entries()) {
    const otherGlyph = other.glyphs[g];
    if (
      otherGlyph.charCode !== baseGlyph.charCode ||
      otherGlyph.width !== baseGlyph.width ||
      otherGlyph.height !== baseGlyph.height
    ) {
      return null;
    }
    for (let i = 0; i < baseGlyph.cells.length; i++) {
      const pair = other.pairPalette[otherGlyph.cells[i]];
      const existing = palette[baseGlyph.cells[i]];
      if (existing === undefined) {
        palette[baseGlyph.cells[i]] = pair;
      } else if (existing !== pair) {
        return null;
      }
    }
  }
  return palette;
}

/**
 * Splits the distinct fonts into base fonts, which are stored with their cells, and derived
 * fonts, which reuse a base font's cells through a palette of their own (see derivePalette).
 *
 * Fonts with the same glyph set and dimensions form a group. Within a group, the encoder
 * repeatedly picks as base the font from which the most remaining fonts can be derived.
 *
 * @param {Array<{uniqueKeys: string[], record: object}>} entries - Distinct font records.
 * @returns {{bases: Array<object>, derived: Array<object>}} Derived entries gain `base` (an
 *   entry of `bases`) and `derivedPalette`.
 */
function factorRecords(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const layoutKey = entry.record.glyphs.map((g) => `${g.charCode},${g.width},${g.height}`).join(";");
    if (!groups.has(layoutKey)) groups.set(layoutKey, []);
    groups.get(layoutKey).push(entry);
  }

  const bases = [];
  const derived = [];
  for (const group of groups.values()) {
    let remaining = group;
    while (remaining.length > 0) {
      const palettes = remaining.map((base) => remaining.map((other) => derivePalette(base.record, other.record)));
      let bestIndex = 0;
      let bestCoverage = -1;
      for (const [i, row] of palettes.entries()) {
        const coverage = row.filter((palette) => palette !== null).length;
        if (coverage > bestCoverage) [bestIndex, bestCoverage] = [i, coverage];
      }
      const base = remaining[bestIndex];
      bases.push(base);
      const notDerived = [];
      for (const [i, entry] of remaining.entries()) {
        if (i === bestIndex) continue;
        const palette = palettes[bestIndex][i];
        if (palette === null) {
          notDerived.push(entry);
        } else {
          derived.push(Object.assign(entry, { base, derivedPalette: palette }));
        }
      }
      remaining = notDerived;
    }
  }
  return { bases, derived };
}

/**
 * Encodes a derived palette relative to its base palette, as an attribute substitution plus
 * a list of entries the substitution gets wrong.
 *
 * Most derived fonts recolor their base: every cell of base attribute A becomes attribute B,
 * and characters are unchanged. The substitution captures that in a few bytes. Entries whose
 * derived pair differs from (base char, substituted attr) are listed explicitly.
 *
 * @param {Array<{char:number, attr:number}>} basePalette
 * @param {Array<{char:number, attr:number}>} derivedPalette - Same length as basePalette.
 * @returns {{attrMap: Map<number, number>, overrides: Array<{pairIndex:number, pair:{char:number, attr:number}}>}}
 *   `attrMap` omits attributes that map to themselves.
 */
function encodeDerivedPalette(basePalette, derivedPalette) {
  const votes = new Map(); // base attr -> Map(derived attr -> count)
  for (const [j, basePair] of basePalette.entries()) {
    if (!votes.has(basePair.attr)) votes.set(basePair.attr, new Map());
    const counts = votes.get(basePair.attr);
    counts.set(derivedPalette[j].attr, (counts.get(derivedPalette[j].attr) || 0) + 1);
  }
  const attrMap = new Map();
  for (const [fromAttr, counts] of votes) {
    const [toAttr] = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
    if (toAttr !== fromAttr) attrMap.set(fromAttr, toAttr);
  }

  const overrides = [];
  for (const [j, basePair] of basePalette.entries()) {
    const pair = derivedPalette[j];
    const substitutedAttr = attrMap.get(basePair.attr) ?? basePair.attr;
    if (pair.char !== basePair.char || pair.attr !== substitutedAttr) overrides.push({ pairIndex: j, pair });
  }
  return { attrMap, overrides };
}

// --- Bundle Assembly ---

/**
 * Builds the complete v6 bundle.
 * @param {Array<{uniqueKeys: string[], record: object}>} bases - Base font records, in bundle order.
 * @param {Array<{uniqueKeys: string[], record: object, base: object, derivedPalette: Array<object>}>} derived -
 *   Derived font records, in bundle order.
 * @returns {Buffer}
 */
function buildBundle(bases, derived) {
  const recordIndexOf = new Map([...bases, ...derived].map((entry, index) => [entry, index]));
  const keyToRecordIndex = [];
  for (const [entry, recordIndex] of recordIndexOf) {
    for (const uniqueKey of entry.uniqueKeys) keyToRecordIndex.push([uniqueKey, recordIndex]);
  }
  keyToRecordIndex.sort((a, b) => a[0].localeCompare(b[0]));

  const header = Buffer.alloc(17);
  header.write(BIN_MAGIC_STRING, 0, "ascii");
  header.writeUInt8(BIN_BUNDLE_VERSION, 4);
  header.writeUInt32LE(keyToRecordIndex.length, 5);
  header.writeUInt32LE(bases.length, 9);
  header.writeUInt32LE(derived.length, 13);

  const fontIndex = [];
  for (const [uniqueKey, recordIndex] of keyToRecordIndex) {
    const entryBuffer = Buffer.alloc(Buffer.byteLength(uniqueKey, "utf8") + 3);
    entryBuffer.write(uniqueKey, 0, "utf8"); // Followed by the zero byte from alloc().
    entryBuffer.writeUInt16LE(recordIndex, entryBuffer.length - 2);
    fontIndex.push(entryBuffer);
  }

  const baseTable = [];
  const cellPool = [];
  let previousGlyphs = new Map(); // charCode -> glyph, for the preceding base record.
  for (const { record } of bases) {
    const { spacing, pairPalette, glyphs } = record;
    const recordBuffer = Buffer.alloc(3 + pairPalette.length * 2 + glyphs.length * 4);
    let offset = 0;
    offset = recordBuffer.writeUInt8(spacing, offset);
    offset = recordBuffer.writeUInt8(pairPalette.length, offset);
    for (const pair of pairPalette) {
      offset = recordBuffer.writeUInt8(pair.char, offset);
      offset = recordBuffer.writeUInt8(pair.attr, offset);
    }
    offset = recordBuffer.writeUInt8(glyphs.length, offset);
    for (const glyph of glyphs) {
      const previous = previousGlyphs.get(glyph.charCode);
      const isShared =
        previous !== undefined &&
        previous.width === glyph.width &&
        previous.height === glyph.height &&
        previous.cells.equals(glyph.cells);
      offset = recordBuffer.writeUInt8(glyph.charCode, offset);
      offset = recordBuffer.writeUInt8(glyph.width, offset);
      offset = recordBuffer.writeUInt8(glyph.height, offset);
      offset = recordBuffer.writeUInt8(isShared ? 1 : 0, offset);
      if (!isShared) cellPool.push(glyph.cells);
    }
    baseTable.push(recordBuffer);
    previousGlyphs = new Map(glyphs.map((glyph) => [glyph.charCode, glyph]));
  }

  const derivedTable = [];
  for (const { record, base, derivedPalette } of derived) {
    const { attrMap, overrides } = encodeDerivedPalette(base.record.pairPalette, derivedPalette);
    const recordBuffer = Buffer.alloc(5 + attrMap.size * 2 + overrides.length * 3);
    let offset = recordBuffer.writeUInt16LE(recordIndexOf.get(base), 0);
    offset = recordBuffer.writeUInt8(record.spacing, offset);
    offset = recordBuffer.writeUInt8(attrMap.size, offset);
    for (const [fromAttr, toAttr] of [...attrMap].sort((a, b) => a[0] - b[0])) {
      offset = recordBuffer.writeUInt8(fromAttr, offset);
      offset = recordBuffer.writeUInt8(toAttr, offset);
    }
    offset = recordBuffer.writeUInt8(overrides.length, offset);
    for (const { pairIndex, pair } of overrides) {
      offset = recordBuffer.writeUInt8(pairIndex, offset);
      offset = recordBuffer.writeUInt8(pair.char, offset);
      offset = recordBuffer.writeUInt8(pair.attr, offset);
    }
    derivedTable.push(recordBuffer);
  }

  return Buffer.concat([header, ...fontIndex, ...baseTable, ...derivedTable, ...cellPool]);
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
  console.log(`Input directory: ${path.resolve(inputDirectory)}`);
  console.log(`Output file:     ${path.resolve(outputFilePath)}`);

  const entriesByContent = new Map(); // recordContentKey -> {uniqueKeys, record}
  let filesScanned = 0;
  let fontCount = 0;

  let filesInDir;
  try {
    filesInDir = fs.readdirSync(inputDirectory);
  } catch (dirAccessError) {
    console.error(`Fatal error accessing input directory ${inputDirectory}:`, dirAccessError.message);
    process.exit(1);
  }

  for (const file of filesInDir) {
    if (path.extname(file).toLowerCase() !== ".tdf") continue;
    filesScanned++;
    const fullFilePath = path.join(inputDirectory, file);

    try {
      const parser = new TdfParser(fs.readFileSync(fullFilePath), fullFilePath);
      const parsedFontHeaders = parser.parseFontHeaders(); // Returns only color fonts.

      for (const fontMeta of parsedFontHeaders) {
        const rawGlyphs = {};
        for (const charKey of SUPPORTED_CHAR_LIST) {
          const rawGlyph = parser.extractRawGlyphCellsAndDimensions(fontMeta, charKey);
          if (rawGlyph) rawGlyphs[charKey] = rawGlyph;
        }
        if (Object.keys(rawGlyphs).length === 0) continue;

        const record = encodeFontRecord(fontMeta.spacing, rawGlyphs);
        if (!record) {
          console.warn(`Skipping font ${fontMeta.uniqueKey}: more than ${MAX_PALETTE_SIZE} distinct pairs.`);
          continue;
        }

        const contentKey = recordContentKey(record);
        const existing = entriesByContent.get(contentKey);
        if (existing) {
          existing.uniqueKeys.push(fontMeta.uniqueKey);
        } else {
          entriesByContent.set(contentKey, { uniqueKeys: [fontMeta.uniqueKey], record });
        }
        fontCount++;
      }
      console.log(`Processed file: ${file} (found ${parsedFontHeaders.length} color fonts)`);
    } catch (readOrParseError) {
      console.error(`Error processing file ${fullFilePath}:`, readOrParseError.message, readOrParseError.stack);
    }
  }

  const entries = [...entriesByContent.values()];
  console.log(`\nProcessed ${filesScanned} TDF files: ${fontCount} color fonts, ${entries.length} distinct.`);
  if (entries.length === 0) {
    console.log("No font data to write to bundle. Exiting.");
    return;
  }
  if (entries.length > 0xffff) {
    console.error(`Fatal: ${entries.length} distinct fonts exceed the limit of 65535 records.`);
    process.exit(1);
  }

  for (const entry of entries) entry.uniqueKeys.sort((a, b) => a.localeCompare(b));
  const { bases, derived } = factorRecords(entries);
  sortRecordsByShape(bases);
  const baseOrder = new Map(bases.map((entry, index) => [entry, index]));
  derived.sort(
    (a, b) => baseOrder.get(a.base) - baseOrder.get(b.base) || a.uniqueKeys[0].localeCompare(b.uniqueKeys[0]),
  );
  console.log(`Stored as ${bases.length} base fonts and ${derived.length} fonts derived from them.`);
  const bundle = buildBundle(bases, derived);

  console.log(`\nWriting binary bundle (${bundle.length} bytes) to: ${outputFilePath}`);
  try {
    fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });
    fs.writeFileSync(outputFilePath, bundle);
  } catch (writeError) {
    console.error(`Fatal error writing binary file ${outputFilePath}:`, writeError.message);
    process.exit(1);
  }
}

main();
