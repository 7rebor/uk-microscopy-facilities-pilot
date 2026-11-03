# uk-microscopy-facilities-pilot
Test for making an improved UK microscopy facilities database

Saved browser HTML in `data/html_scrape/` is local-only and excluded from Git. After reviewing a batch, run `npm run archive:scrape` to move its contents into a timestamped folder under `data/html_scrape_archive/`. Each archive batch includes a `manifest.json`; running the command again archives any new files separately.

To extract evidence from saved pages, put the HTML files in `data/html_scrape/` and run `npm run extract:html`. The offline extractor reads the saved page content without making network requests, then writes a timestamped `data/extraction-review-queue-*.json` containing the source URL, page text, headings, contact emails, relevant links, and possible matches against existing facilities. It does not edit `facilities.json`: review the evidence and update existing records or add new records only when claims are supported by the official source. Successfully processed input files are moved into a timestamped archive batch, with the review-queue filename recorded in its manifest. The generated queue and raw/archive HTML are local-only and gitignored.

The curated directory currently contains 15 verified facility records, including the Francis Crick Institute, Durham University, and three King's College London imaging centres. This is a source-backed working set, not a ranked UK league table.

Removing a facility record from the published data

If a facility is not a real instrument-bearing record, or if it is only a network/umbrella page rather than a standalone facility, you can remove it from `data/facilities.json` either by display name or by the internal JSON `id`.

Use Node directly from the repository root:

```bash
node scripts/remove-facility.mjs "Edinburgh Bioimaging"
node scripts/remove-facility.mjs --name "Edinburgh Bioimaging"
node scripts/remove-facility.mjs --id edinburgh-bioimaging
```

Or, if `npm` is available on your PATH, use the package helper:

```bash
npm run remove:facility -- "Edinburgh Bioimaging"
npm run remove:facility -- --id edinburgh-bioimaging
```

If `npm` is not recognized in PowerShell, the usual reason is that the Node installation is not on your PATH. Add the Node folder to PATH, or call the Node executable directly:

```powershell
$env:Path += ";C:\Program Files\nodejs"
# then
npm run remove:facility -- "Edinburgh Bioimaging"
```

or:

```powershell
& "C:\Program Files\nodejs\node.exe" scripts/remove-facility.mjs "Edinburgh Bioimaging"
```

The script is `*.mjs`, so it runs as a Node ES module without needing a package manager. It exits with a clear error and leaves the file unchanged if no matching record is found.
