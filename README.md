# Synthetiq Custom Sources

This repository contains source modules for the Synthetiq Books runtime.

## NovelNeko Web-Novels

The `novelneko-web` module uses NovelNeko's public Web-Novels catalog, detail pages, reader pages, and plain-text chapter files. It returns text chapters only, validates all returned URLs against `novelneko.fr`, and excludes entries with adult, paid, locked, or incomplete safety metadata.

Run the local checks with:

```sh
npm test
npm run check
```

The module package is described by `index.json` and `modules/novelneko/manifest.json`; their SHA-256 values must match the checked-in files before import.
