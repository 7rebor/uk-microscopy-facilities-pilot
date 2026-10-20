import { mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { URL } from "node:url";

const sourcePath = new URL("../data/html_scrape/", import.meta.url);
const archiveRoot = new URL("../data/html_scrape_archive/", import.meta.url);

export async function archiveHtmlScrape(metadata = {}) {
  await mkdir(sourcePath, { recursive: true });
  const entries = await readdir(sourcePath, { withFileTypes: true });

  if (entries.length === 0) {
    return null;
  }

  await mkdir(archiveRoot, { recursive: true });

  const archivedAt = new Date().toISOString();
  const batchName = archivedAt.replace(/[:.]/g, "-");
  let batchPath = new URL(`${batchName}/`, archiveRoot);
  let suffix = 1;
  while (true) {
    try {
      await mkdir(batchPath);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      batchPath = new URL(`${batchName}-${suffix}/`, archiveRoot);
      suffix += 1;
    }
  }

  const archivedItems = [];
  for (const entry of entries) {
    await rename(
      new URL(encodeURIComponent(entry.name), sourcePath),
      new URL(encodeURIComponent(entry.name), batchPath),
    );
    archivedItems.push({
      name: entry.name,
      type: entry.isDirectory() ? "directory" : "file",
    });
  }

  await writeFile(
    new URL("manifest.json", batchPath),
    `${JSON.stringify({ archivedAt, ...metadata, items: archivedItems }, null, 2)}\n`,
  );
  console.log(`Archived ${archivedItems.length} items to data/html_scrape_archive/${batchName}/`);
  return batchName;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const batchName = await archiveHtmlScrape();
  if (!batchName) {
    console.log("No saved HTML scrape data to archive.");
  }
}
