# TDF Figlet - TheDraw Font Renderer Web App

This repository contains a simple web application (`index.html`) that lets you render text using classic TheDraw `.TDF` Color fonts, much like the command-line `figlet` tool does for its own font format.

It uses an underlying JavaScript library (`tdfRenderer.js`) to handle the font loading and canvas rendering from a preprocessed binary font bundle.

[Try it Live!](https://atdt.github.io/tdf-figlet/)

## Origins & Development

The core CP437 character rendering logic was adapted from my earlier library, [escapes.js](https://github.com/atdt/escapes.js).

The TDF-specific parsing (`tdfPacker.js`, `tdfRenderer.js`), the binary data bundling strategy, multi-font handling, and the rendering logic were developed primarily through interaction with an AI assistant (Google's Gemini), based on the TDF specification, examples like `tdfgo`, and specific feature requests during development.

## Features

* Renders text using glyphs from preprocessed TDF Color fonts (Type 2).
* Uses a compact **Binary bundle (`tdf-fonts.bin`)** for efficient font data loading.
* Simple web interface (`index.html`) for text input and font selection.
* Handles multi-line text input (`\n`).
* Configurable text alignment (left, center, right).
* Configurable minimum width for space characters if a font lacks an explicit space glyph.
* "Show All Fonts" mode with virtual rendering (via IntersectionObserver) to handle large font collections.
* Option to filter displayed fonts based on whether they contain all characters in the input text.

## Setup

To run the `index.html` web application, you need to preprocess your `.TDF` font collection into the binary bundle format:

1.  **Gather Fonts:** Place your `.TDF` files into a directory (e.g., `tdf_fonts/`).
2.  **Preprocess:** This project includes `tdfPacker.js`. You'll need Node.js installed. Run the script to generate the necessary `tdf-fonts.bin`:
    ```bash
    # Run the preprocessor script
    node tdfPacker.js path/to/your/tdf_fonts path/to/output/tdf-fonts.bin
    ```
    *(Make sure `tdf-fonts.bin` is saved where `index.html` can fetch it).*
3.  **CP437 Font Data:** The renderer requires CP437 bitmap data. Create a `cp437font.js` file that assigns the font data array to `globalThis.cp437font`. This file must be loaded *before* `tdfRenderer.js`.
    ```javascript
    // Example cp437font.js
    const cp437FontData = [ /*... 256 rows of 16 bytes ...*/ ];
    globalThis.cp437font = cp437FontData;
    ```
4.  **Include Scripts:** Ensure `index.html` correctly loads `cp437font.js` and `tdfRenderer.js`:
    ```html
    <script src="cp437font.js" defer></script>
    <script src="tdfRenderer.js" defer></script>
    ```

## Running the App

After completing the setup:

1.  Make sure `tdf-fonts.bin` and `cp437font.js` are accessible by the HTML file.
2.  Open `index.html` in your web browser.
3.  Type text into the input area.
4.  Select a font from the dropdown.
5.  Use the checkboxes and number input to control filtering, random order (for "Show All"), minimum space width, and text alignment.
6.  Click "Show All Fonts" to view the text rendered in all applicable fonts (scroll down to render them as they enter the viewport).

## Binary Bundle Format (`tdf-fonts.bin`)

The `tdfPacker.js` script generates a binary file containing all necessary data extracted from the TDF Color fonts. The format is structured as follows (all multi-byte values are Little Endian):

1.  **Header** (21 Bytes Total)
    * Magic String: `TDFB` (4 bytes ASCII)
    * Format Version: `1` (1 byte Uint8)
    * Font Count (N): Total number of fonts included (4 bytes Uint32LE)
    * Font Index Offset: Byte offset from start of file to the Font Index Table (4 bytes Uint32LE)
    * String Pool Offset: Byte offset from start of file to the String Pool (4 bytes Uint32LE)
    * Font Data Pool Offset: Byte offset from start of file to the Font Data Pool (4 bytes Uint32LE)

2.  **Font Index Table** (Starts at `Font Index Offset`, Size = N * 8 bytes)
    * Contains `N` entries, sorted alphabetically by the font's unique key.
    * Each entry (8 bytes):
        * Unique Key String Offset: Offset within the String Pool where the null-terminated font key string begins (4 bytes Uint32LE).
        * Font Data Offset: Offset within the Font Data Pool where this font's specific data block begins (4 bytes Uint32LE).

3.  **String Pool** (Starts at `String Pool Offset`, Variable Size)
    * A sequence of all unique font keys (generated as `FILENAME_FontName`), each terminated by a null byte (`\0`). Stored as UTF-8.

4.  **Font Data Pool** (Starts at `Font Data Pool Offset`, Variable Size)
    * Concatenated data blocks for each font, ordered corresponding to the Font Index Table.
    * **Font Data Block** (Variable Size):
        * Spacing: Letter spacing value (1 byte Uint8).
        * Glyph Count (G): Number of defined glyphs for this font (1 byte Uint8, max 94).
        * **Glyph Lookup Table** (Size = G * 3 bytes): Contains `G` entries, sorted by character code.
            * Entry (3 bytes):
                * Char Code: ASCII code (33-126) of the glyph (1 byte Uint8).
                * Glyph Data Offset: Offset within *this font's* subsequent Glyph Data Table where the specific glyph's data begins (2 bytes Uint16LE).
        * **Glyph Data Table (GDT)** (Variable Size): Concatenated data for all `G` glyphs.
            * Glyph Data (Variable Size):
                * Width: Glyph width in character cells (1 byte Uint8).
                * Height: Calculated actual glyph height in lines (1 byte Uint8).
                * Byte Stream: Sequence of bytes representing the glyph cells.
                    * `CharCode` (1 byte Uint8), `AttrByte` (1 byte Uint8): For a standard character cell.
                    * `0x0D` (1 byte): Represents a newline within the glyph.
                    * `0x00` (1 byte): Null terminator, marks the end of this glyph's byte stream.

## Related Links

* **TheDraw Font Specification:** [https://www.roysac.com/thedrawfonts-tdf.html](https://www.roysac.com/thedrawfonts-tdf.html) (by Roy/SAC)
* **Terminal TDF Renderer:** [tdfgo](https://github.com/digitallyserviced/tdfgo)

## License

MIT.
