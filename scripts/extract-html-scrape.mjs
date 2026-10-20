import { chromium } from "playwright";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { URL } from "node:url";
import { archiveHtmlScrape } from "./archive-html-scrape.mjs";

const dataPath = new URL("../data/", import.meta.url);
const inputPath = new URL("html_scrape/", dataPath);
const facilitiesPath = new URL("facilities.json", dataPath);
const maxTextLength = 30_000;
const entries = await readdir(inputPath, { withFileTypes: true });
const htmlFiles = entries.filter((entry) => entry.isFile() && /\.html?$/i.test(entry.name));

if (htmlFiles.length === 0) {
  console.log("No HTML files found in data/html_scrape/. Nothing was changed.");
} else {
  const facilities = JSON.parse(await readFile(facilitiesPath, "utf8"));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ javaScriptEnabled: false });
  await page.route("**/*", (route) => route.abort());

  let pages;
  try {
    pages = [];
    for (const file of htmlFiles) {
      const html = await readFile(new URL(encodeURIComponent(file.name), inputPath), "utf8");
      const sourceMatch = html.match(/\burl:\s*(https?:\/\/[^\s"'<>]+)/i);
      let sourceUrl = sourceMatch?.[1] ?? null;
      let evidence;

      try {
        await page.setContent(html, { waitUntil: "domcontentloaded" });
        evidence = await page.evaluate((textLimit) => {
          const main = document.querySelector("main, [role=main]") ?? document.body;
          const text = (main?.innerText ?? document.body?.innerText ?? "")
            .replace(/\s+/g, " ")
            .trim();
          const links = [...(main?.querySelectorAll("a[href]") ?? [])]
            .map((link) => ({
              url: link.href,
              text: link.innerText.trim() || link.getAttribute("aria-label") || "",
            }))
            .filter(({ url }) => /^https?:/.test(url))
            .filter((link, index, all) => all.findIndex(({ url }) => url === link.url) === index)
            .slice(0, 100);

          return {
            title: document.title || null,
            canonicalUrl: document.querySelector('link[rel="canonical"]')?.href ?? null,
            description: document.querySelector('meta[name="description"]')?.content?.trim() ?? null,
            headings: [...main.querySelectorAll("h1, h2, h3")]
              .map((heading) => heading.innerText.trim())
              .filter(Boolean)
              .slice(0, 60),
            emails: [...main.querySelectorAll('a[href^="mailto:"]')]
              .map((link) => link.getAttribute("href").slice(7).split("?")[0])
              .filter(Boolean),
            links,
            text: text.slice(0, textLimit),
            textTruncated: text.length > textLimit,
          };
        }, maxTextLength);
        sourceUrl ??= evidence.canonicalUrl;
      } catch (error) {
        evidence = {
          title: null,
          canonicalUrl: null,
          description: null,
          headings: [],
          emails: [],
          links: [],
          text: "",
          textTruncated: false,
          extractionError: error.message,
        };
      }

      const possibleExistingFacilities = findPossibleFacilities(
        facilities,
        sourceUrl,
        evidence.title,
      );
      pages.push({
        savedFile: file.name,
        sourceUrl,
        ...evidence,
        possibleExistingFacilities,
        suggestedAction: !sourceUrl
          ? "verify-source-url-before-recording"
          : possibleExistingFacilities.length
            ? "review-matches-for-existing-record-update"
            : "review-as-possible-new-entry",
        reviewStatus: "needs-human-review",
      });
      if (!sourceUrl) {
        console.warn(`${file.name}: original page URL not found; verify its source before using the evidence.`);
      }
    }
  } finally {
    await browser.close();
  }

  const generatedAt = new Date().toISOString();
  const queue = {
    generatedAt,
    publishedDataUpdated: false,
    instructions: "Review page evidence against facilities.json. Add supported details to matching records or propose new records; do not publish unsupported claims.",
    pages,
  };
  const fileStamp = generatedAt.replace(/[:.]/g, "-");
  let queueName = `extraction-review-queue-${fileStamp}.json`;
  let suffix = 1;
  while (true) {
    try {
      await writeFile(
        new URL(queueName, dataPath),
        `${JSON.stringify(queue, null, 2)}\n`,
        { flag: "wx" },
      );
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      queueName = `extraction-review-queue-${fileStamp}-${suffix}.json`;
      suffix += 1;
    }
  }

  const archiveBatch = await archiveHtmlScrape({
    purpose: "offline-html-evidence-extraction",
    reviewQueue: `data/${queueName}`,
  });
  console.log(`Extracted evidence from ${pages.length} HTML file(s) to data/${queueName}.`);
  if (pages.some(({ extractionError }) => extractionError)) {
    console.error("One or more files could not be parsed; inspect extractionError in the review queue.");
  }
  if (archiveBatch) {
    console.log(`Archived the input files to data/html_scrape_archive/${archiveBatch}/.`);
  }
}

function findPossibleFacilities(facilities, sourceUrl, title) {
  let sourceHost = null;
  if (sourceUrl) {
    try {
      sourceHost = new URL(sourceUrl).hostname.replace(/^www\./, "");
    } catch {
      sourceHost = null;
    }
  }

  const titleTokens = new Set((title ?? "").toLocaleLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
  return facilities.flatMap((facility) => {
    const matchingHosts = new Set(
      (facility.sources ?? []).flatMap(({ url }) => {
        try {
          return [new URL(url).hostname.replace(/^www\./, "")];
        } catch {
          return [];
        }
      }),
    );
    const sameHost = sourceHost && matchingHosts.has(sourceHost);
    const nameTokens = [
      facility.name,
      facility.institution,
    ].flatMap((value) => value.toLocaleLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
    const titleMatches = nameTokens.filter((token) => titleTokens.has(token));
    if (!sameHost && titleMatches.length === 0) return [];
    return [{
      id: facility.id,
      name: facility.name,
      institution: facility.institution,
      matchReason: sameHost ? "source-host-matches-existing-sources" : "title-overlaps-record-name",
      titleMatches,
    }];
  });
}
