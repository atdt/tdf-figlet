# TDF Figlet - TheDraw Font Renderer Web App

This repository contains a simple web application that lets you render text using classic TheDraw `.TDF` Color fonts, much like the command-line `figlet` tool does for its own font format.

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

## Related Links

* **TheDraw Font Specification:** [https://www.roysac.com/thedrawfonts-tdf.html](https://www.roysac.com/thedrawfonts-tdf.html) (by Roy/SAC)
* **Terminal TDF Renderer:** [tdfgo](https://github.com/digitallyserviced/tdfgo)

## License

MIT.
