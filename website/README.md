# Trivor product site

Self-contained static landing page (`index.html`, `styles.css`, `main.js`, `assets/`). No build step. Release metadata is checked against the app's `package.json` version.

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
Publishing an app release or tag alone does not deploy this page.

Site URL: https://imboni.github.io/trivor/

Wait for **Deploy website** to succeed for the website commit, then verify the
live version, both languages, release notes and download link. A manual redeploy
is available with `gh workflow run pages.yml --ref main`. If old content remains,
check the served HTML and JavaScript with the browser cache disabled.

## Release updates

For every app release:

1. Update `copy.en` and `copy.zh` in [main.js](./main.js), including new features, supported content and relevant limits. Keep the English HTML fallback and description/OG metadata in [index.html](./index.html) aligned.
2. Set the HTML root's `data-site-version` to the app's package version. Update the HTML link marked `data-href="release-notes"` and `RELEASE_NOTES_URL` in `main.js` to `https://github.com/imboni/trivor/releases/tag/v{version}`. Update the HTML resource URLs to `main.js?v={version}` and `styles.css?v={version}` so a new release does not reuse an older release's cached script or stylesheet. Keep the download destination on `/releases/latest`.
3. From the repository root, run `node scripts/check-website-release.mjs`. This dependency-free check runs before dependency installation in release CI and rejects mismatched version markers, release notes URLs or JavaScript/CSS version queries. It does not validate the meaning of the release copy or the live deployment.
4. Preview both languages and themes at desktop and mobile widths. Check links, local image loading and browser errors, then push to `main` and verify Pages as above.

The full app release checklist is in [docs/RELEASE.md](../docs/RELEASE.md).

## Customize

- Copy: `copy.en` / `copy.zh` in [main.js](./main.js)
- Links: constants at the top of [main.js](./main.js)
- Visual tokens: [styles.css](./styles.css)
