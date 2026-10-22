# uk-microscopy-facilities-pilot
Test for making an improved UK microscopy facilities database

Saved browser HTML in `data/html_scrape/` is local-only and excluded from Git. After reviewing a batch, run `npm run archive:scrape` to move its contents into a timestamped folder under `data/html_scrape_archive/`. Each archive batch includes a `manifest.json`; running the command again archives any new files separately.

To extract evidence from saved pages, put the HTML files in `data/html_scrape/` and run `npm run extract:html`. The offline extractor reads the saved page content without making network requests, then writes a timestamped `data/extraction-review-queue-*.json` containing the source URL, page text, headings, contact emails, relevant links, and possible matches against existing facilities. It does not edit `facilities.json`: review the evidence and update existing records or add new records only when claims are supported by the official source. Successfully processed input files are moved into a timestamped archive batch, with the review-queue filename recorded in its manifest. The generated queue and raw/archive HTML are local-only and gitignored.

The curated directory currently contains 15 verified facility records, including the Francis Crick Institute, Durham University, and three King's College London imaging centres. This is a source-backed working set, not a ranked UK league table.
