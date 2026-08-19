# Peel Gallery

Infinite horizontal gallery with a WebGL shelf peel (three-shelf scale field + gap packing). Drag, wheel, or click a card to center it. Tune the scale map live (top right).

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

## Deploy (GitHub Pages)

Push to `main` runs [.github/workflows/deploy-pages.yml](.github/workflows/deploy-pages.yml).

One-time in the repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

## Stack

- Vite + TypeScript
- GSAP (scroll / snap)
- WebGL (fragment shelf warp)

## License

Private / educational — adjust as needed.
