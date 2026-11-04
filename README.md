# UK Microscopy Facilities Pilot

A source-backed working directory of UK microscopy facilities, with a private local curation tool for reviewing downloaded website pages.

## Curate downloaded pages

The curator app uses only HTML pages you have already downloaded; it does not crawl websites. Put `.html` or `.htm` files under `data/html_scrape/` (subfolders are supported), then start the app from the repository root:

```bash
npm run curate
```

Open the local address printed by the command (by default `http://127.0.0.1:4178/`). Keep the server running while you work. The app binds to the loopback interface and is separate from the public directory at `index.html`.

The app requires one of these environment variables to be set in the environment where Node is started:

- `GEMINI_API_KEY_PERSONAL`
- `GEMINI_API_KEY_PROFESSIONAL`

The key selector in the app chooses which variable to use. The key itself is never sent to the browser or written to a project file. Optionally set `GEMINI_MODEL` to use a different model (default: `gemini-2.5-flash`) and `CURATOR_PORT` to choose another local port. Do not put API keys in `.env` files committed to Git.

When you scan, the app extracts evidence from the local HTML and sends the page text, headings, links, contact addresses, image candidates, and existing facility summaries to Gemini. This is a third-party API request to Google; do not scan pages containing information you do not want sent to that service. The initial page host/domain is only a batching hint. Gemini may suggest multiple facilities within the same institution and must explain its grouping with page evidence. Review and edit every proposal before accepting it.

For each pending proposal, the UI shows the contributing pages, quoted evidence, uncertainties, and editable facility fields. A live comparison shows the edited proposal beside a selected existing record, and the same selection is used if you choose to merge. Choose to add a new facility, merge the evidence into an existing facility, or decline it. An accepted proposal is checked against the directory schema and taxonomy, a backup of `data/facilities.json` is created, and only then is the record written. An interrupted write is recorded so a completed update can be recovered without applying it twice. Declined proposals are marked checked. Gemini never writes to the published data directly.

Review state is local and Git-ignored under `data/curation-ledger/`:

- `pending/` contains items still awaiting review and is the only folder shown in the app.
- `merged/` contains accepted items, including the facility ID and backup path.
- `checked/` contains declined items.
- `backups/` contains pre-write copies of `facilities.json`.

Page identity combines the source URL and a hash of the downloaded HTML. Re-scanning an unchanged reviewed page will skip it; changed content can be reviewed as new evidence. These folders are local workflow state, not published directory data. Back them up if you need to preserve the review history.

The curated directory is a source-backed working set, not a ranked UK league table.

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
