import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  chunkPages,
  clearProposalApplying,
  decideProposal,
  groupPagesByHost,
  listHtmlFiles,
  markProposalApplying,
  makeProposalId,
  MAX_PAGE_TEXT_LENGTH,
  pageIdentity,
  persistPendingProposal,
  readLedger,
  sha256,
  validateProposal,
  mergeFacility,
  writeApprovedFacilities,
} from "./lib/curator-store.mjs";
import { validateFacilityCollection } from "./lib/facility-validation.mjs";
import {
  availableGeminiProfiles,
  generateFacilityProposals,
} from "./lib/gemini-proposals.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = path.join(projectRoot, "data");
const inputRoot = path.join(dataRoot, "html_scrape");
const ledgerRoot = path.join(dataRoot, "curation-ledger");
const uiRoot = path.join(projectRoot, "curator-ui");
const facilitiesPath = path.join(dataRoot, "facilities.json");
const taxonomyPath = path.join(dataRoot, "taxonomy.json");
const port = Number(process.env.CURATOR_PORT || 4178);
const host = "127.0.0.1";
const maxBodyBytes = 1_000_000;

const configuredProfiles = availableGeminiProfiles();
let selectedProfile = ["personal", "professional"].includes(process.env.GEMINI_KEY_PROFILE)
  && configuredProfiles[process.env.GEMINI_KEY_PROFILE]
  ? process.env.GEMINI_KEY_PROFILE
  : configuredProfiles.personal
    ? "personal"
    : "professional";
let scanInProgress = false;
let decisionInProgress = false;

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

const server = createServer(async (request, response) => {
  try {
    if (!isLocalRequest(request)) {
      sendJson(response, 403, { error: "The curation app only accepts local requests." });
      return;
    }

    const requestUrl = new URL(request.url || "/", `http://${host}:${port}`);
    if (request.method === "GET" && requestUrl.pathname.startsWith("/api/")) {
      await handleGet(requestUrl.pathname, response);
      return;
    }
    if (request.method === "POST") {
      if (!isTrustedPost(request, port)) {
        sendJson(response, 403, { error: "POST requests must come from this local curation UI." });
        return;
      }
      const body = await readJsonBody(request);
      await handlePost(requestUrl.pathname, body, response);
      return;
    }
    if (request.method === "GET" || request.method === "HEAD") {
      await serveUi(requestUrl.pathname, response, request.method === "HEAD");
      return;
    }
    sendJson(response, 405, { error: "Method not allowed." });
  } catch (error) {
    console.error(error);
    if (!response.headersSent) {
      sendJson(response, 400, { error: error.message || "The request failed." });
    } else {
      response.destroy(error);
    }
  }
});

server.listen(port, host, () => {
  console.log(`Private curation app listening at http://${host}:${port}/`);
  console.log("Only locally downloaded HTML is processed; no live crawling is performed.");
});

async function handleGet(pathname, response) {
  if (pathname === "/api/state") {
    const [facilities, taxonomy, ledger] = await Promise.all([
      readJson(facilitiesPath),
      readJson(taxonomyPath),
      readLedger(ledgerRoot),
    ]);
    const pending = ledger
      .filter(({ folder }) => folder === "pending")
      .map(({ record }) => record)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    sendJson(response, 200, {
      pending,
      facilities,
      taxonomy,
      profile: selectedProfile,
      profiles: availableGeminiProfiles(),
      model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
    });
    return;
  }
  if (pathname === "/api/health") {
    sendJson(response, 200, { ok: true, scanInProgress, decisionInProgress });
    return;
  }
  sendJson(response, 404, { error: "Unknown API route." });
}

async function handlePost(pathname, body, response) {
  if (pathname === "/api/profile") {
    if (!["personal", "professional"].includes(body.profile)) {
      sendJson(response, 400, { error: "Profile must be personal or professional." });
      return;
    }
    if (!availableGeminiProfiles()[body.profile]) {
      sendJson(response, 400, { error: `Set GEMINI_API_KEY_${body.profile.toUpperCase()} before selecting this profile.` });
      return;
    }
    selectedProfile = body.profile;
    sendJson(response, 200, { profile: selectedProfile });
    return;
  }

  if (pathname === "/api/scan") {
    if (scanInProgress) {
      sendJson(response, 409, { error: "A scan is already running." });
      return;
    }
    scanInProgress = true;
    try {
      const result = await scanDownloadedHtml();
      sendJson(response, 200, result);
    } finally {
      scanInProgress = false;
    }
    return;
  }

  const decisionMatch = pathname.match(/^\/api\/items\/([a-f0-9]{24})\/decision$/);
  if (decisionMatch) {
    if (decisionInProgress) {
      sendJson(response, 409, { error: "A decision is already being applied." });
      return;
    }
    decisionInProgress = true;
    try {
      const result = await applyDecision(decisionMatch[1], body);
      sendJson(response, 200, result);
    } finally {
      decisionInProgress = false;
    }
    return;
  }

  sendJson(response, 404, { error: "Unknown API route." });
}

async function scanDownloadedHtml() {
  const files = await listHtmlFiles(inputRoot);
  if (!files.length) {
    return {
      message: "No downloaded HTML found. Put saved .html/.htm pages under data/html_scrape/ and scan again.",
      created: 0,
      skipped: 0,
    };
  }

  const [facilities, taxonomy, ledger] = await Promise.all([
    readJson(facilitiesPath),
    readJson(taxonomyPath),
    readLedger(ledgerRoot),
  ]);
  const reviewedPageHashes = new Set(
    ledger.flatMap(({ record }) => record.pages ?? []).map(({ identity }) => identity),
  );
  const pages = await extractPages(files);
  const unseenPages = pages.filter(({ identity }) => !reviewedPageHashes.has(identity));
  if (!unseenPages.length) {
    return {
      message: "All downloaded pages are already represented in the review ledger.",
      created: 0,
      skipped: pages.length,
    };
  }

  let created = 0;
  const hostGroups = groupPagesByHost(unseenPages);
  for (const hostGroup of hostGroups) {
    const chunks = chunkPages(hostGroup.pages);
    for (const pageChunk of chunks) {
      const result = await generateFacilityProposals({
        host: hostGroup.host,
        pages: pageChunk,
        facilities,
        taxonomy,
        profile: selectedProfile,
      });

      const groupPages = new Set();
      for (const group of result.facilityGroups) {
        const proposal = makePendingProposal(group, pageChunk, hostGroup.host);
        for (const pageId of group.pageIds) groupPages.add(pageId);
        if (await persistPendingProposal(ledgerRoot, proposal)) created += 1;
      }

      const unassignedPageIds = new Set(result.unassignedPageIds ?? []);
      for (const page of pageChunk) {
        if (!groupPages.has(page.pageId) && !unassignedPageIds.has(page.pageId)) {
          unassignedPageIds.add(page.pageId);
        }
      }
      if (unassignedPageIds.size) {
        const unassigned = pageChunk.filter(({ pageId }) => unassignedPageIds.has(pageId));
        const proposal = makeUnassignedProposal(unassigned, hostGroup.host);
        if (await persistPendingProposal(ledgerRoot, proposal)) created += 1;
      }
    }
  }

  return {
    message: `Created ${created} pending review item(s) from ${unseenPages.length} new page(s).`,
    created,
    skipped: pages.length - unseenPages.length,
  };
}

async function extractPages(files) {
  await mkdir(inputRoot, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ javaScriptEnabled: false });
  await page.route("**/*", (route) => route.abort());
  const extracted = [];

  try {
    for (const filePath of files) {
      const html = await readFile(filePath, "utf8");
      const rawSourceMatch = html.match(/\burl:\s*(https?:\/\/[^\s"'<>]+)/i);
      let sourceUrl = rawSourceMatch?.[1] ?? null;
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
              href: link.getAttribute("href"),
              text: link.innerText.trim() || link.getAttribute("aria-label") || "",
            }))
            .filter(({ href }) => href)
            .slice(0, 100);
          const images = [...document.querySelectorAll("img[src]")]
            .map((image) => ({
              src: image.getAttribute("src"),
              alt: image.getAttribute("alt") || "",
            }))
            .filter(({ src }) => src)
            .slice(0, 60);
          return {
            title: document.title || null,
            canonicalUrl: document.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? null,
            description: document.querySelector('meta[name="description"]')?.content?.trim() ?? null,
            headings: [...main.querySelectorAll("h1, h2, h3")]
              .map((heading) => heading.textContent.trim())
              .filter(Boolean)
              .slice(0, 60),
            emails: [...main.querySelectorAll('a[href^="mailto:"]')]
              .map((link) => link.getAttribute("href").slice(7).split("?")[0])
              .filter(Boolean),
            links,
            images,
            text: text.slice(0, textLimit),
            textTruncated: text.length > textLimit,
          };
        }, MAX_PAGE_TEXT_LENGTH);
      } catch (error) {
        evidence = {
          title: null,
          canonicalUrl: null,
          description: null,
          headings: [],
          emails: [],
          links: [],
          images: [],
          text: "",
          textTruncated: false,
          extractionError: error.message,
        };
      }

      if (!sourceUrl && evidence.canonicalUrl) {
        try {
          const canonicalUrl = new URL(evidence.canonicalUrl);
          if (["http:", "https:"].includes(canonicalUrl.protocol)) {
            sourceUrl = canonicalUrl.href;
          }
        } catch {
          sourceUrl = null;
        }
      }
      const absoluteLinks = evidence.links.flatMap(({ href, text }) => {
        try {
          const url = new URL(href, sourceUrl);
          if (!["http:", "https:"].includes(url.protocol)) return [];
          return [{ url: url.href, text }];
        } catch {
          return [];
        }
      });
      const imageCandidates = evidence.images.flatMap(({ src, alt }) => {
        try {
          const url = new URL(src, sourceUrl);
          if (!["http:", "https:"].includes(url.protocol)) return [];
          return [{ url: url.href, alt }];
        } catch {
          return [];
        }
      });
      const contentHash = sha256(html);
      const savedFile = path.relative(inputRoot, filePath).split(path.sep).join("/");
      const normalizedSource = sourceUrl ? new URL(sourceUrl).href : "";
      const pageId = pageIdentity(normalizedSource, contentHash);
      extracted.push({
        pageId,
        identity: pageId,
        contentHash,
        savedFile,
        sourceUrl: normalizedSource || null,
        ...evidence,
        links: absoluteLinks,
        imageCandidates,
        text: String(evidence.text ?? "").slice(0, MAX_PAGE_TEXT_LENGTH),
      });
    }
  } finally {
    await browser.close();
  }

  return extracted;
}

function makePendingProposal(group, pages, hostName) {
  const selectedPages = pages.filter(({ pageId }) => group.pageIds.includes(pageId));
  const sourceUrls = selectedPages.map(({ sourceUrl }) => sourceUrl).filter(Boolean);
  const sourceUrl = sourceUrls[0] ?? "";
  const proposalRecord = group.record;
  const name = proposalRecord.name?.trim() || group.facilityName?.trim() || "";
  const locationAddresses = (proposalRecord.addresses ?? []).map((address) => ({
    site: address.site || "",
    building: address.building || "",
    address: address.address || "",
  }));
  const accessSource = group.evidence?.find(({ field }) => /access/i.test(field))?.sourceUrl || sourceUrl;
  const contactEvidence = group.evidence?.find(({ field }) => /contact|email/i.test(field));
  const logoEvidence = group.evidence?.find(({ field }) => /logo|image/i.test(field));
  const imageUrl = (selectedPages.flatMap(({ imageCandidates }) => imageCandidates ?? [])
    .find(({ url }) => url === proposalRecord.imageUrl)?.url) || "";

  const record = {
    id: slugify(name || group.institution || `facility-${group.pageIds[0]}`),
    name,
    institution: proposalRecord.institution || group.institution || "",
    location: {
      city: proposalRecord.city || "",
      region: proposalRecord.region || "",
      country: proposalRecord.country || "United Kingdom",
      addresses: locationAddresses,
    },
    access: {
      status: ["external-and-internal", "collaborative", "public", "unknown"].includes(proposalRecord.accessStatus)
        ? proposalRecord.accessStatus
        : "unknown",
      evidence: proposalRecord.accessEvidence || "",
      source: accessSource,
    },
    techniques: proposalRecord.techniques ?? [],
    instruments: (proposalRecord.instruments ?? []).map((instrument) => ({
      name: instrument.name || "",
      manufacturer: instrument.manufacturer || null,
      model: instrument.model || null,
      type: instrument.type || "unknown",
      techniques: instrument.techniques ?? [],
      locationDetails: instrument.locationDetails || "",
      status: ["active", "planned", "retired"].includes(instrument.status) ? instrument.status : undefined,
      evidence: instrument.evidence || "",
      source: instrument.source || sourceUrl,
    })),
    sources: sourceUrls.map((url) => ({
      url,
      checked: new Date().toISOString().slice(0, 10),
      notes: `Downloaded HTML reviewed as evidence for ${name || "an unconfirmed facility"}.`,
    })),
    lastChecked: new Date().toISOString().slice(0, 10),
  };

  if (proposalRecord.contactEmail) {
    record.contact = {
      email: proposalRecord.contactEmail,
      name: proposalRecord.contactName || null,
      source: contactEvidence?.sourceUrl || sourceUrl,
    };
  }
  if (imageUrl) {
    record.image = {
      url: imageUrl,
      alt: proposalRecord.imageAlt || `${name} logo`,
      source: logoEvidence?.sourceUrl || sourceUrl,
      permission: "",
    };
  }

  return {
    id: makeProposalId(group.pageIds, name),
    host: hostName,
    facilityName: group.facilityName || name || "Facility boundary unclear",
    institution: group.institution || record.institution,
    recommendedAction: group.recommendedAction,
    matchFacilityId: group.matchFacilityId || "",
    rationale: group.rationale || "",
    uncertainties: group.uncertainties ?? [],
    evidence: group.evidence ?? [],
    pages: selectedPages,
    record,
    createdAt: new Date().toISOString(),
  };
}

function makeUnassignedProposal(pages, hostName) {
  const pageIds = pages.map(({ pageId }) => pageId);
  return {
    id: makeProposalId(pageIds, "unassigned"),
    host: hostName,
    facilityName: "Facility boundary unclear",
    institution: "",
    recommendedAction: "needs-review",
    matchFacilityId: "",
    rationale: "Gemini could not confidently assign these page(s) to a facility.",
    uncertainties: ["Assign these pages to one or more facilities, or decline them."],
    evidence: [],
    pages,
    record: blankRecord(pages[0]?.sourceUrl),
    createdAt: new Date().toISOString(),
  };
}

function blankRecord(sourceUrl = "") {
  return {
    id: "",
    name: "",
    institution: "",
    location: {
      city: "",
      region: "",
      country: "United Kingdom",
      addresses: [],
    },
    access: { status: "unknown", evidence: "", source: sourceUrl || "" },
    techniques: [],
    instruments: [],
    sources: sourceUrl ? [{ url: sourceUrl, checked: new Date().toISOString().slice(0, 10), notes: "" }] : [],
    lastChecked: new Date().toISOString().slice(0, 10),
  };
}

async function applyDecision(proposalId, body) {
  const ledger = await readLedger(ledgerRoot);
  const pending = ledger.find(({ folder, record }) => folder === "pending" && record.id === proposalId);
  if (!pending) throw new Error("This review item is no longer pending. Refresh the page.");

  const applying = pending.record.review?.applying;
  if (applying) {
    const facilities = await readJson(facilitiesPath);
    const committed = facilities.find(({ id }) => id === applying.facilityId);
    if (committed && sha256(JSON.stringify(committed)) === applying.recordHash) {
      await decideProposal(ledgerRoot, proposalId, "merged", {
        action: applying.action,
        facilityId: applying.facilityId,
        backup: applying.backup,
        recovered: true,
      });
      return {
        status: "merged",
        facilityId: applying.facilityId,
        message: `Recovered the completed write for ${applying.facilityId}; moved to merged.`,
      };
    }
    await clearProposalApplying(ledgerRoot, proposalId);
  }

  if (body.decision === "decline") {
    await decideProposal(ledgerRoot, proposalId, "checked", {
      action: "declined",
      note: String(body.note ?? "").slice(0, 1000),
    });
    return { status: "checked", message: "Declined and moved to checked." };
  }
  if (body.decision !== "accept") {
    throw new Error("Choose accept or decline.");
  }

  const [facilities, taxonomy] = await Promise.all([
    readJson(facilitiesPath),
    readJson(taxonomyPath),
  ]);
  const proposal = body.record;
  validateProposal(proposal, taxonomy);
  const action = body.action;
  let nextFacilities;
  let appliedFacilityId;
  let appliedRecord;

  if (action === "add") {
    const record = structuredClone(proposal);
    record.id = uniqueFacilityId(record.id || slugify(record.name), facilities);
    record.reviewStatus = "verified";
    record.lastChecked = new Date().toISOString().slice(0, 10);
    nextFacilities = [...facilities, record];
    appliedFacilityId = record.id;
    appliedRecord = record;
  } else if (action === "update") {
    const existing = facilities.find(({ id }) => id === body.targetFacilityId);
    if (!existing) throw new Error("Choose an existing facility to update.");
    nextFacilities = facilities.map((facility) => facility.id === existing.id
      ? mergeFacility(existing, proposal, taxonomy)
      : facility);
    appliedFacilityId = existing.id;
    appliedRecord = nextFacilities.find(({ id }) => id === existing.id);
  } else {
    throw new Error("Action must be add or update.");
  }

  validateFacilityCollection(nextFacilities, taxonomy);
  const backupPath = await writeApprovedFacilities(
    facilitiesPath,
    nextFacilities,
    (candidate) => validateFacilityCollection(candidate, taxonomy),
    async (createdBackupPath) => {
      await markProposalApplying(ledgerRoot, proposalId, {
        action,
        facilityId: appliedFacilityId,
        recordHash: sha256(JSON.stringify(appliedRecord)),
        backup: path.relative(projectRoot, createdBackupPath).split(path.sep).join("/"),
      });
    },
  );
  await decideProposal(ledgerRoot, proposalId, "merged", {
    action,
    facilityId: appliedFacilityId,
    backup: path.relative(projectRoot, backupPath).split(path.sep).join("/"),
  });
  return {
    status: "merged",
    facilityId: appliedFacilityId,
    message: `${action === "add" ? "Added" : "Updated"} ${appliedFacilityId}; moved to merged.`,
  };
}

async function serveUi(pathname, response, headOnly) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const resolved = path.resolve(uiRoot, `.${requested}`);
  if (!resolved.startsWith(`${uiRoot}${path.sep}`)) {
    sendJson(response, 403, { error: "Forbidden." });
    return;
  }
  try {
    const content = await readFile(resolved);
    response.writeHead(200, {
      "content-type": contentTypes.get(path.extname(resolved)) || "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' https:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      "content-length": content.length,
    });
    response.end(headOnly ? undefined : content);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    sendJson(response, 404, { error: "File not found." });
  }
}

async function readJson(filePath) {
  return JSON.parse((await readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
}

async function readJsonBody(request) {
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    throw new Error("Request must use application/json.");
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new Error("Request body exceeds the allowed size.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Request body is not valid JSON.");
  }
}

function isLocalRequest(request) {
  const remoteAddress = request.socket.remoteAddress;
  const isLoopback = remoteAddress === "127.0.0.1"
    || remoteAddress === "::1"
    || remoteAddress === "::ffff:127.0.0.1";
  return isLoopback && request.headers.host === `${host}:${port}`;
}

function isTrustedPost(request, expectedPort) {
  const origin = request.headers.origin;
  const expectedOrigin = `http://${host}:${expectedPort}`;
  return origin === expectedOrigin
    && request.headers["content-type"]?.toLowerCase().startsWith("application/json");
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function slugify(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72) || "new-facility";
}

function uniqueFacilityId(base, facilities) {
  const existing = new Set(facilities.map(({ id }) => id));
  if (!existing.has(base)) return base;
  let suffix = 2;
  while (existing.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}
