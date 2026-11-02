### TDF Font Bundle Specification v6 (Standalone)

**Document Version:** 3.0
**Bundle Format Version:** 6

**Purpose:** This document specifies a binary file format for bundling multiple TheDraw Font (TDF) color font files. The primary goals are to achieve a compact representation suitable for efficient delivery over the web (especially after GZip compression) and to allow for reasonably fast client-side parsing and rendering.

---

### 0. Introduction & Motivations

**0.1. The Nature of TDF Color Fonts:**

TheDraw Fonts (TDF) are a legacy font format originating from the MS-DOS ANSI/ASCII art scene, notably used by "TheDraw" text editor. Unlike modern outline (e.g., TrueType) or vector fonts, TDFs are **character-cell based**. Each font defines glyphs (visual representations for characters like 'A', '!', etc.) as a 2D grid of cells.

For "color" TDFs, which are the focus of this specification:
* Each cell in a glyph's grid is defined by two pieces of 8-bit information:
    1.  **Character Code (1 byte):** A byte value, typically from the CP437 character set. This code determines the pixel pattern for the cell (e.g., a block graphic, a line segment, a shade pattern, or a standard symbol).
    2.  **Color Attribute (1 byte):** A byte specifying the foreground color (from a 16-color palette) and the background color (from an 8-color palette) for that cell.
* The raw data stream for a glyph within a TDF file consists of sequences of these (Character Code, Color Attribute) pairs, interspersed with 1-byte markers for newlines (ASCII 0Dh, Carriage Return) to define rows, and a 1-byte end-of-glyph terminator (ASCII 00h, Null).

**0.2. The Need for Bundling and Compression:**

Web applications requiring access to a large library of TDF fonts (e.g., hundreds or thousands) face challenges with fetching numerous small individual files due to HTTP overhead and latency. A common solution is to preprocess these files into a single binary bundle. This bundle must then be compressed (typically with GZip by the web server) for efficient transmission to the client. The client-side application then parses this bundle to access font data.

**0.3. Design Rationale for Bundle Format v6:**

The bundle is served uncompressed and compressed in transit by the web server with gzip. Gzip finds repeated byte sequences only within the preceding 32 KiB, and then entropy-codes what remains. The format therefore aims to put similar bytes close together and to make the same structure produce the same bytes, rather than to minimize the uncompressed size. Measured on the 3,541 color fonts of Roy/SAC's TDF collection:

| Version | Uncompressed | `gzip -6` | `brotli -q 11` |
| :------ | -----------: | --------: | -------------: |
| v4      | 15,297,139   | 1,836,447 | 1,276,944      |
| v6      | 5,800,438    | 963,995   | 758,322        |


* **Implicit glyph structure.** Most glyphs fill their declared width on every line, so each glyph is stored as a dense `width × height` grid. The encoder pads short lines with a padding pair (see below) and truncates lines longer than the declared width.
* **Local pair palette, ordered by frequency.** Each font has a palette of the distinct (character, attribute) pairs its glyphs use, and each cell is stored as a one-byte index into it. The palette is ordered by descending frequency, so index 0 is usually the font's background cell and low indices are the font's common cells. Two fonts that differ only in color then produce the same index streams, and gzip can match one against the other. (v4 ordered the palette by character code, which gives the same shape different indices in different fonts.)
* **No run-length encoding.** Gzip encodes runs itself. RLE escape sequences break up the index streams that would otherwise match between fonts. Without RLE, a glyph's size is `width × height`, so the format needs no per-glyph offsets.
* **Metadata separated from cell data.** All palettes and glyph dimensions come first, followed by all cells. Each region then has uniform statistics.
* **One record per distinct font.** About 3% of the collection's fonts are byte-for-byte duplicates under different names. Each distinct font is stored once as a *record*, and the font index maps every name to its record.
* **Base records ordered by shape.** Alphabetical order scatters related designs beyond gzip's window. Base records are sorted by the character codes (ignoring attributes) of the glyphs `A`, `a`, `H` and `O`, so related designs sort together.
* **Derived fonts.** Many fonts are released in several color schemes, or swap one shading character for another, while keeping the same glyph shapes. Such a font has the same index streams as some other font, read through a different palette. The 3,421 distinct fonts in the collection reduce to 1,121 *base* records, which store cells, and 2,300 *derived* records, which store only a palette. A derived palette is encoded relative to its base palette, as an attribute substitution plus a list of entries the substitution gets wrong; most derived records need no such entries.
* **Shared glyphs.** A glyph whose dimensions and index stream equal those of the same character in the preceding base record is stored as a flag rather than as cells. The two glyphs may still render differently, because each record maps the indices through its own palette.
* **Determinism.** Given the same input files, the encoder produces a byte-identical bundle.

Alternatives that were measured and rejected: storing raw (character, attribute) pairs instead of palette indices; storing the character and attribute planes as separate streams; column-major cell order; glyph-level deduplication or recoloring with explicit references (the references cost more than the compressor's own matches); and adaptive context-model (PPM) coders over the cells using the neighboring cells and the most similar earlier glyph as context, which compressed glyph shapes worse than brotli does.

---

### I. File Format Structure

All multi-byte integers are little-endian.

**1. Overall Bundle Structure:**

The bundle consists of the following sections in order, with no padding between them:

1.  **Header**
2.  **Font Index**
3.  **Base Record Table**
4.  **Derived Record Table**
5.  **Cell Pool**

**2. Header (17 bytes):**

| Offset | Length (bytes) | Type       | Description                                          |
| :----- | :------------- | :--------- | :--------------------------------------------------- |
| 0      | 4              | ASCII      | Magic String: "TDFB"                                 |
| 4      | 1              | `Uint8`    | Bundle Version: `6`                                  |
| 5      | 4              | `Uint32LE` | Font Count (N): number of entries in the Font Index. |
| 9      | 4              | `Uint32LE` | Base Count (B): number of base records.              |
| 13     | 4              | `Uint32LE` | Derived Count (D): number of derived records.        |

Records are numbered 0 to M−1, where M = B + D ≤ 65535: base records first, then derived records.

**3. Font Index:**

N entries, sorted by key. Each entry is:

* **Key:** the font's unique key, a UTF-8 string terminated by a zero byte. The key is `<file name without extension>_<font name>`, with every character outside `[A-Za-z0-9_.-]` replaced by `_`.
* **Record Index (`Uint16LE`):** the index of the font's record (0 to M−1). Several keys may name the same record.

**4. Base Record Table:**

B records. Each record is:

1.  **Spacing (`Uint8`):** letter spacing in cells (0–40); the TDF value minus 1.
2.  **Number of Pairs (`Uint8`):** `nPairs`, the size of the pair palette (0–255).
3.  **Pair Palette (`nPairs × 2` bytes):** `nPairs` entries of `char_byte` (`Uint8`, a CP437 code) followed by `attr_byte` (`Uint8`, a color attribute). Entries are ordered by descending number of cells that use them; ties are ordered by `char_byte`, then by `attr_byte`.
4.  **Glyph Count (`Uint8`):** `G`, the number of glyphs in the record.
5.  **Glyph Table (`G × 4` bytes):** one entry per glyph, ordered by character code:

    | Offset | Type    | Description                                                                                   |
    | :----- | :------ | :-------------------------------------------------------------------------------------------- |
    | 0      | `Uint8` | Character Code (33–126).                                                                      |
    | 1      | `Uint8` | Width: the glyph's declared TDF width in cells.                                               |
    | 2      | `Uint8` | Height: the number of lines in the original TDF glyph.                                        |
    | 3      | `Uint8` | Shared: `1` if the glyph's cells are those of the same character in the preceding base record; else `0`. |

    A glyph may be marked shared only if the preceding base record has a glyph for the same character with the same width and height. The first base record has no shared glyphs.

**5. Derived Record Table:**

D records. A derived record has the glyphs of a base record, and its own spacing and palette. Each record is:

1.  **Base Index (`Uint16LE`):** the index of a base record (0 to B−1).
2.  **Spacing (`Uint8`):** as for base records.
3.  **Attribute Map Size (`Uint8`):** `A`.
4.  **Attribute Map (`A × 2` bytes):** `A` entries of `from_attr` (`Uint8`) followed by `to_attr` (`Uint8`). Attributes not listed map to themselves.
5.  **Override Count (`Uint8`):** `O`.
6.  **Overrides (`O × 3` bytes):** `O` entries of `pair_index` (`Uint8`), `char_byte` (`Uint8`) and `attr_byte` (`Uint8`).

The derived palette has as many entries as the base palette. Entry j is `(char_byte_j, map(attr_byte_j))`, where `(char_byte_j, attr_byte_j)` is entry j of the base palette, unless an override with `pair_index = j` replaces it with its `(char_byte, attr_byte)`. The encoder chooses, for each base attribute, the derived attribute that most base entries with that attribute take (ties go to the lower attribute); overrides are listed in ascending `pair_index` order.

**6. Cell Pool:**

The cells of every base-record glyph whose Shared flag is `0`, concatenated in record order and, within a record, in Glyph Table order. Each glyph contributes `width × height` bytes in row-major order, and each byte is an index into its record's Pair Palette.

A decoder finds a glyph's cells by keeping a running total: the cells of the first unshared glyph start at offset 0 of the Cell Pool, and each unshared glyph advances the total by `width × height`. A shared glyph uses the cell offset of the same character in the preceding base record, which may itself be shared. A glyph of a derived record uses the cell offset of the same glyph in its base record, and its indices refer to the derived palette.

**Padding Pair Convention:**
For TDF glyphs whose lines are shorter than the declared width, the encoder pads each short line with the pair `(char_byte = 0x20, attr_byte = 0x00)`: a space, black on black. The padding pair is counted, and placed in the palette, like any other pair.

**Space Fill Convention:**
When the renderer draws a space for which the font defines no glyph, it fills the cell with the background color of the palette entry with the lowest `(char_byte, attr_byte)`. This reproduces the v4 behavior, in which that entry was the first in the palette. For a derived record, this is computed from the derived palette.

---
