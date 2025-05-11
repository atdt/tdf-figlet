### TDF Font Bundle Specification v4.0 (Standalone)

**Document Version:** 1.0
**Bundle Format Version:** 4.0

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

**0.3. Design Rationale for Bundle Format v4.0:**

This specification (v4.0) is the result of analyzing the statistical properties of a large TDF color font collection and incorporating expert advice on data compression. Key observations and motivations include:

* **Implicit Glyph Structure:** Analysis of TDF files revealed that the vast majority of glyphs (over 97% in a sample collection) already fill their declared width on every line containing content. This means glyphs can largely be treated as dense rectangular blocks. The v4.0 format leverages this by removing explicit newline and end-of-glyph markers from the encoded cell stream. The encoder implicitly pads the few "ragged" lines (lines shorter than the glyph's declared width) with a designated "transparent" cell representation. This simplifies the stream structure and reduces the number of non-data marker bytes.
* **Local Palette of (Character, Attribute) Pairs:**
    * Statistical analysis showed that individual fonts typically use a small number of unique Character Codes (average ~10) and an even smaller number of unique Color Attributes (average ~7).
    * Instead of separate palettes for characters and attributes, this format uses a single local palette per font consisting of unique *(Character Code, Color Attribute)* **pairs**.
    * If the number of unique pairs in a font is low (often <= 64, and constrained to be <= 254 for this format), each 2-byte cell from the original TDF can be mapped to a single, smaller index (typically 1 byte) into this local pair palette. This significantly reduces the raw size of the cell data stream.
* **Run-Length Encoding (RLE):**
    * TDF glyphs often contain sequences of identical cells (e.g., spaces, solid blocks of the same character and color).
    * Applying a simple RLE scheme to the stream of *pair palette indices* can efficiently compress these runs. A reserved index value (`0xFF`) is used as an escape code for RLE sequences.
* **Deterministic Sorting for Consistency:**
    * For simplicity and deterministic bundle generation, fonts within the bundle are sorted alphabetically by their `uniqueKey`. This ensures that if the input TDF files are the same, the output bundle is byte-for-byte identical. Previous experiments with content-aware sorting did not yield consistent GZip improvements for this dataset.
* **Optimized for GZip:** The entire scheme is designed to produce an intermediate binary format that is more amenable to subsequent GZip compression. By reducing raw data size, simplifying stream structure, and encoding common patterns (like runs), GZip can often achieve better final compression ratios.
* **Decoder Simplicity:** The design aims to keep the client-side decoding logic reasonably simple and efficient.

---

### I. File Format Structure

**1. Overall Bundle Structure:**

The bundle consists of the following sections in order:

1.  **Main Bundle Header**
2.  **Font Index Table**
3.  **String Pool**
4.  **Font Data Pool**

**2. Main Bundle Header (21 bytes total):**

| Offset | Length (bytes) | Type       | Description                                      |
| :----- | :------------- | :--------- | :----------------------------------------------- |
| 0      | 4              | ASCII      | Magic String: "TDFB"                             |
| 4      | 1              | `Uint8`    | Bundle Version: `4`                              |
| 5      | 4              | `Uint32LE` | Font Count (N): Number of fonts in the bundle.   |
| 9      | 4              | `Uint32LE` | Font Index Table Offset (absolute from file start) |
| 13     | 4              | `Uint32LE` | String Pool Offset (absolute from file start)    |
| 17     | 4              | `Uint32LE` | Font Data Pool Offset (absolute from file start) |

**3. Font Index Table:**

* Starts at `Font Index Table Offset`.
* Contains `N` entries, where `N` is `Font Count`.
* Fonts in this table are sorted **alphabetically by their `uniqueKey` string**.
* **Font Index Table Entry Structure (8 bytes per entry):**
    | Offset Relative to Entry Start | Length (bytes) | Type       | Description                                                           |
    | :----------------------------- | :------------- | :--------- | :-------------------------------------------------------------------- |
    | 0                              | 4              | `Uint32LE` | Unique Key String Offset (relative to the start of the String Pool) |
    | 4                              | 4              | `Uint32LE` | Font Data Offset (relative to the start of the Font Data Pool)      |

**4. String Pool:**

* Starts at `String Pool Offset`.
* A concatenation of null-terminated UTF-8 strings (unique font keys), ordered corresponding to the Font Index Table.

**5. Font Data Pool:**

* Starts at `Font Data Pool Offset`.
* A concatenation of `N` Font Data Blocks, in the same order as the Font Index Table.
* **Font Data Block Structure (variable length, for each font):**
    1.  **Font Spacing (`Uint8`, 1 byte):** Letter spacing value (0-40), as defined in the TDF specification (0 means 1 less than raw TDF value, up to a max of 40).
    2.  **Number of Pairs (`Uint8`, 1 byte):** `nPairs`, the count of unique (char, attr) pairs in this font's local palette. The maximum value is 254 (0xFE), as 0xFF is reserved as an RLE escape byte. Fonts exceeding 254 unique pairs cannot be represented in this version or require simplification by the encoder.
    3.  **Pair Palette Data (`nPairs * 2` bytes):** A sequence of `nPairs` entries. The encoder sorts this palette canonically (e.g., first by `char_byte`, then by `attr_byte`) before writing to ensure deterministic output.
        * Each entry is 2 bytes:
            * `char_byte` (`Uint8`, 1 byte): The CP437 character code.
            * `attr_byte` (`Uint8`, 1 byte): The color attribute.
    4.  **Glyph Count (`Uint8`, 1 byte):** `G`, the number of glyphs defined for this font (typically up to 94, for ASCII 33-126).
    5.  **Glyph Lookup Table (GLT) (`G * 3` bytes):** `G` entries, sorted by the `Character Code` of the glyph.
        * **GLT Entry Structure (3 bytes):**
            * Character Code (`Uint8`, 1 byte): ASCII value of the character (e.g., 33-126).
            * Glyph Data Offset (`Uint16LE`, 2 bytes): Relative offset from the start of this font's "Glyph Data Table (GDT)" (see next section) to this specific glyph's data.
    6.  **Glyph Data Table (GDT) (variable length):** Concatenated data for all `G` glyphs. The encoder typically writes these in the order corresponding to the GLT (i.e., sorted by character code) for simplicity.
        * **Individual Glyph Data Structure (variable length):**
            * Glyph Width (`Uint8`, 1 byte): The declared TDF width of the glyph in cells.
            * Glyph Height (`Uint8`, 1 byte): The actual number of lines in the glyph, as determined by the encoder from the original TDF content (by counting newlines and the final terminator). This defines the height dimension for the `Glyph Width * Glyph Height` cell grid.
            * **RLE-Encoded Cell Stream (variable length):** A stream of bytes representing `Glyph Width * Glyph Height` cells. Each byte is an index into this font's `Pair Palette Data`.
                * If `byte_value < 0xFF`: This is a literal index into the `Pair Palette Data`. The pair at this index defines the cell's character and attribute.
                * If `byte_value == 0xFF` (RLE Escape):
                    * Next byte (`run_length_byte`, `Uint8`): The encoded run length. The actual number of cells this run represents is `run_length_byte + 3`. (This allows encoding runs of 3 to 258 cells).
                    * Next byte (`pair_palette_index_to_repeat`, `Uint8`): The pair palette index that is repeated for the duration of the run. This index *must not* be `0xFF`.

**Padding Pair Convention:**
For handling TDF glyphs where lines are shorter than the `Glyph Width` (ragged glyphs), the encoder must conceptually "pad" these lines with a designated "padding pair" to ensure the RLE-Encoded Cell Stream always contains data for `Glyph Width * Glyph Height` cells. A common default for this padding pair is `(char_byte=0x20, attr_byte=0x00)` (space character, black-on-black color). If a font requires padding and this specific pair is not naturally present in its unique `(char, attr)` combinations, the encoder must add it to the font's `Pair Palette Data`. The encoder ensures the `Pair Palette Data` (including any added padding pair) is sorted canonically before being written.

---
