import { readdir, readFile, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { URL } from "node:url";

const root = new URL("../data/", import.meta.url);
const facilitiesPath = new URL("facilities.json", root);
const extractedPath = new URL("html_scrape_extracted.json", root);
const archiveRoot = new URL("html_scrape_archive/", root);

async function collectArchiveEntries(dir) {
  const entries = [];
  try {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const child = new URL(`${item.name}${item.isDirectory() ? "/" : ""}`, dir);
      if (item.isDirectory()) {
        entries.push(...await collectArchiveEntries(child));
      } else if (item.isFile() && /\.html?$/i.test(item.name)) {
        const raw = await readFile(child, "utf8");
        const text = raw.replace(/\uFEFF/g, "");
        const titleMatch = text.match(/<title>([\s\S]*?)<\/title>/i);
        const title = titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : "";
        const ogImageMatch = text.match(/(?:property|name)=['\"]og:image['\"][^>]*content=['\"]([^'\"]+)['\"]/i)
          ?? text.match(/content=['\"]([^'\"]+)['\"][^>]*(?:property|name)=['\"]og:image['\"]/i);
        const ogImage = ogImageMatch ? ogImageMatch[1] : "";
        const imgMatches = [...text.matchAll(/<img\b[^>]+src=['\"]([^'\"]+)['\"]/gi)].map((match) => match[1]);
        const logoCandidates = [...new Set([
          ...imgMatches.filter((url) => /logo|brand|header|site-logo|logo-color/i.test(url)),
          ...(ogImage ? [ogImage] : []),
          ...imgMatches,
        ].filter(Boolean))];
        entries.push({
          Title: title,
          OgImage: ogImage,
          ImageCandidates: imgMatches,
          LogoCandidates: logoCandidates,
        });
      }
    }
  } catch {
    // Ignore missing archive folders.
  }
  return entries;
}

const facilities = JSON.parse(await readFile(facilitiesPath, "utf8"));
const extractedPages = [
  ...JSON.parse(await readFile(extractedPath, "utf8")),
  ...(await collectArchiveEntries(archiveRoot)),
];

function normalize(value = "") {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function tokens(value = "") {
  return new Set(normalize(value).split(/\s+/).filter(Boolean));
}

function pickBestCandidate(facility, page) {
  const candidates = [];
  const allChoices = [
    ...(Array.isArray(page.LogoCandidates) ? page.LogoCandidates : []),
    ...(page.OgImage ? [page.OgImage] : []),
    ...(Array.isArray(page.ImageCandidates) ? page.ImageCandidates : []),
  ];
  for (const candidate of allChoices) {
    if (!candidate || !/^https?:\/\//i.test(candidate)) continue;
    candidates.push(candidate);
  }
  if (!candidates.length) return null;

  const facilityTokens = new Set([
    ...tokens(facility.name),
    ...tokens(facility.institution),
    ...tokens(facility.location?.city),
  ]);

  const titleTokens = tokens(page.Title ?? page.title ?? "");
  const overlap = [...facilityTokens].filter((token) => titleTokens.has(token)).length;
  const hostMatches = (() => {
    const facilityHosts = new Set(
      [facility.access?.source, ...(facility.sources ?? []).map(({ url }) => url)]
        .filter(Boolean)
        .map((value) => {
          try {
            return new URL(value).hostname.replace(/^www\./, "").toLowerCase();
          } catch {
            return null;
          }
        })
        .filter(Boolean),
    );
    const candidateHost = (() => {
      try {
        return new URL(candidates[0]).hostname.replace(/^www\./, "").toLowerCase();
      } catch {
        return null;
      }
    })();
    return candidateHost && facilityHosts.has(candidateHost);
  })();

  if (hostMatches && overlap > 0) return candidates[0];
  if (overlap > 0) return candidates[0];
  if (hostMatches) return candidates[0];
  return candidates[0];
}

for (const facility of facilities) {
  const page = extractedPages.find((entry) => {
    const facilityName = normalize(facility.name);
    const institution = normalize(facility.institution);
    const title = normalize(entry.Title ?? "");
    if (!title) return false;
    const nameMatch = facilityName && title.includes(facilityName);
    const institutionMatch = institution && title.includes(institution);
    const hostMatch = (() => {
      const urls = [facility.access?.source, ...(facility.sources ?? []).map(({ url }) => url)].filter(Boolean);
      const hosts = new Set(urls.map((value) => {
        try {
          return new URL(value).hostname.replace(/^www\./, "").toLowerCase();
        } catch {
          return null;
        }
      }).filter(Boolean));
      const sourceUrl = [
        ...(entry.LogoCandidates ?? []),
        entry.OgImage,
        ...(entry.ImageCandidates ?? []),
      ].find((candidate) => /^https?:\/\//i.test(candidate));
      if (!sourceUrl || !hosts.size) return false;
      try {
        return hosts.has(new URL(sourceUrl).hostname.replace(/^www\./, "").toLowerCase());
      } catch {
        return false;
      }
    })();
    return nameMatch || institutionMatch || hostMatch;
  });

  const candidateUrl = page ? pickBestCandidate(facility, page) : null;

  if (candidateUrl) {
    facility.image = {
      url: candidateUrl,
      alt: `${facility.name} logo`,
      source: facility.access?.source ?? facility.sources?.[0]?.url ?? page?.SourceUrl ?? "",
      permission: "official facility logo",
    };
  } else {
    facility.image = null;
  }
}

await writeFile(facilitiesPath, `${JSON.stringify(facilities, null, 2)}\n`, "utf8");
console.log(`Applied logo metadata to ${facilities.length} facility records.`);
