# Peel Gallery

Infinite horizontal gallery: cards warp through a custom WebGL **shelf peel** — a three-shelf scale field with constant-gap packing after the warp. Drag, wheel, or click a card to center it. Tune the scale map live (top right).

Vanilla WebGL and GSAP — no Three.js. The fragment shader inverts the scale field so the curve is pixel-accurate; photo tiles bake to textures while index and caption stay as transparent DOM text you can select (highlight rebakes onto the canvas).

**Live:** [intredd.github.io/peel-gallery](https://intredd.github.io/peel-gallery/)

<p align="center">
  <img
    src="./assets/git-hero.webp"
    alt="Peel Gallery — infinite strip, shelf peel warp, live scale map"
    width="960"
  />
</p>

## Setup

```bash
npm install
npm run dev
```

Open the URL Vite prints (default [http://localhost:5202](http://localhost:5202)).

```bash
npm run build    # production bundle → dist/
npm run preview  # preview the build
```

Append `?stage` for a fullscreen strip with saved shelf field and no chrome.

## Stack

- Vite + TypeScript
- GSAP (scroll / snap)
- WebGL (fragment shelf warp)

## License

MIT License

Copyright (c) 2026 intredd

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
