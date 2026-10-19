# Tekotek Studio

Turn a product link or a few product photos into a 15-second TikTok promo
video: 9:16, product images with a slow zoom, a price badge, a captioned
voiceover, and the yellow cart popping in at the end with a pointing finger.
Export the finished clip as an MP4 (1080×1920).

## How it works

The whole studio is one screen. Paste a product link and the app reads the
page's title, price and photos, or upload up to five images yourself and
reorder them by removing and re-adding. Describe the product, then
**Generate preview**: the server asks the platform's LLM to write a short
voiceover script ending with a tap-the-cart ask — edit it freely if you'd
rather write your own. The preview plays in a phone frame with a timeline
you can tap to seek, and **Export MP4** renders the real file in the browser
(uses WebCodecs; needs a recent Chrome, Edge or Safari).

The app keeps no data — everything lives in the page until you export.

## Stack

- **Server** — Express. Verifies the platform-issued user token (RS256 JWT),
  proxies the LLM script writer, and reads product pages through a guarded
  fetch (private addresses blocked, size and type limits, 5 s timeouts).
- **Video** — [Remotion](https://remotion.dev). The composition in
  `src/PromoVideo.jsx` drives both the in-page preview (`@remotion/player`)
  and the in-browser MP4 export (`@remotion/web-renderer`), so what you
  preview is exactly what renders.
- **Styling** — Tailwind CSS, precompiled by `npm run build`, in a light and
  a dark look that follow the viewer's Homeroom theme. The app's tokens are
  in `styles/tailwind-input.css`.

## Develop

```sh
npm install
npm run build   # Tailwind CSS + the client bundle
node server.js  # needs the platform env vars; see CLAUDE.md
```

Inside Homeroom, ask the Homeroom bot for changes instead. `CLAUDE.md`
carries the app-specific notes and points at the platform rules.