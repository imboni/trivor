# Trivor product site

Self-contained static landing page (`index.html`, `styles.css`, `main.js`, `assets/`). No build step. Not coupled to the app source tree.

## Assets

| File | Purpose |
|------|---------|
| `assets/logo.png` | Favicon and brand mark |
| `assets/screenshot-dark.png` | Dark theme screenshot (PNG fallback) |
| `assets/screenshot-dark.webp` | Dark theme screenshot (preferred) |
| `assets/screenshot-light.png` | Light theme screenshot (PNG fallback) |
| `assets/screenshot-light.webp` | Light theme screenshot (preferred) |

Screenshots are 1920px wide (2× for the 960px content column). WebP when supported; PNG as fallback.

## Local preview

```bash
cd website
python3 -m http.server 8080
# open http://localhost:8080
```

## Deploy

Pushes to `main` that touch `website/**` deploy via [.github/workflows/pages.yml](../.github/workflows/pages.yml).

Site URL: https://imboni.github.io/trivor/

## Customize

- Copy: `copy.en` / `copy.zh` in [main.js](./main.js)
- Links: constants at the top of [main.js](./main.js)
- Visual tokens: [styles.css](./styles.css)
