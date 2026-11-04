import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export const MAX_HTML_FILES_PER_SCAN = 250;
export const MAX_PAGE_TEXT_LENGTH = 8_000;
export const MAX_BATCH_PAGES = 6;
export const MAX_BATCH_TEXT_LENGTH = 32_000;

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function pageIdentity(sourceUrl, contentHash) {
  const normalizedUrl = normalizeSourceUrl(sourceUrl);
  return sha256(`${normalizedUrl}\n${contentHash}`);
}

export function normalizeSourceUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return String(value).trim();
  }
}

export function hostForPage(page) {
  try {
    return new URL(page.sourceUrl || page.canonicalUrl).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "unknown";
  }
}

export function groupPagesByHost(pages) {
  const groups = new Map();
  for (const page of pages) {
    const host = hostForPage(page);
    const group = groups.get(host) ?? [];
    group.push(page);
    groups.set(host, group);
  }
  return [...groups.entries()].map(([host, items]) => ({ host, pages: items }));
}

export function chunkPages(pages) {
  const chunks = [];
  let chunk = [];
  let textLength = 0;

  for (const page of pages) {
    const pageLength = String(page.text ?? "").length;
    if (
      chunk.length
      && (chunk.length >= MAX_BATCH_PAGES || textLength + pageLength > MAX_BATCH_TEXT_LENGTH)
    ) {
      chunks.push(chunk);
      chunk = [];
      textLength = 0;
    }
    chunk.push(page);
    textLength += pageLength;
  }

  if (chunk.length) chunks.push(chunk);
  return chunks;
}

export function makeProposalId(pageIds, facilityName) {
  const seed = [...pageIds].sort().join(":") + `:${facilityName ?? ""}`;
  return sha256(seed).slice(0, 24);
}

export function validateProposal(proposal, taxonomy) {
  if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) {
    throw new Error("The proposed facility record must be a JSON object.");
  }

  const requiredText = ["name", "institution"];
  for (const field of requiredText) {
    if (typeof proposal[field] !== "string" || !proposal[field].trim()) {
      throw new Error(`Facility ${field} is required.`);
    }
  }

  if (!proposal.location || typeof proposal.location !== "object" || Array.isArray(proposal.location)) {
    throw new Error("Facility location is required.");
  }
  if (
    typeof proposal.location.city !== "string"
    || !proposal.location.city.trim()
    || typeof proposal.location.country !== "string"
    || !proposal.location.country.trim()
  ) {
    throw new Error("Facility city and country are required.");
  }
  if (!Array.isArray(proposal.location.addresses) || proposal.location.addresses.length === 0) {
    throw new Error("Add at least one site address.");
  }
  for (const address of proposal.location.addresses) {
    if (
      !address
      || typeof address !== "object"
      || typeof address.site !== "string"
      || !address.site.trim()
      || typeof address.address !== "string"
      || !address.address.trim()
    ) {
      throw new Error("Every address needs a site label and address.");
    }
  }

  const accessStatuses = ["external-and-internal", "collaborative", "public", "unknown"];
  if (!proposal.access || typeof proposal.access !== "object" || Array.isArray(proposal.access)
      || !accessStatuses.includes(proposal.access.status)) {
    throw new Error("Choose a valid access status.");
  }
  if (typeof proposal.access.source !== "string" || !proposal.access.source.trim()) {
    throw new Error("Access evidence needs a source URL.");
  }

  const techniqueIds = new Set(taxonomy.techniques.map(({ id }) => id));
  const instrumentTypes = new Set(taxonomy.instrumentTypes.map(({ id }) => id));
  if (!Array.isArray(proposal.techniques)
      || proposal.techniques.some((id) => typeof id !== "string" || !techniqueIds.has(id))) {
    throw new Error("The facility includes an unknown technique. Select techniques from the taxonomy.");
  }
  if (!Array.isArray(proposal.instruments)) {
    throw new Error("Instruments must be a list.");
  }
  for (const instrument of proposal.instruments) {
    if (!instrument || typeof instrument !== "object" || Array.isArray(instrument)) {
      throw new Error("Every instrument must be a JSON object.");
    }
    if (
      (typeof instrument.name !== "string" || !instrument.name.trim())
      && (typeof instrument.model !== "string" || !instrument.model.trim())
    ) {
      throw new Error("Every instrument needs a name or model.");
    }
    if (instrument.type !== "unknown" && !instrumentTypes.has(instrument.type)) {
      throw new Error(`Unknown instrument type: ${instrument.type}`);
    }
    if (!Array.isArray(instrument.techniques ?? [])
        || (instrument.techniques ?? []).some((id) => typeof id !== "string" || !techniqueIds.has(id))) {
      throw new Error(`Instrument "${instrument.name || instrument.model}" uses an unknown technique.`);
    }
    if (instrument.status !== undefined && !["active", "planned", "retired"].includes(instrument.status)) {
      throw new Error(`Instrument "${instrument.name || instrument.model}" has an invalid status.`);
    }
  }

  if (!Array.isArray(proposal.sources) || proposal.sources.length === 0) {
    throw new Error("Add at least one source URL.");
  }
  for (const source of proposal.sources) {
    if (!source || typeof source !== "object" || Array.isArray(source) || typeof source.url !== "string") {
      throw new Error("Every source must include a URL.");
    }
    let url;
    try {
      url = new URL(source.url);
    } catch {
      throw new Error(`Invalid source URL: ${source.url ?? "(empty)"}`);
    }
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error(`Source URLs must use HTTP or HTTPS: ${source.url}`);
    }
  }

  if (proposal.contact !== undefined && (!proposal.contact || typeof proposal.contact !== "object" || Array.isArray(proposal.contact))) {
    throw new Error("Contact details must be a JSON object.");
  }
  if (proposal.contact?.email) {
    if (typeof proposal.contact.email !== "string") {
      throw new Error("Contact email address is invalid.");
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(proposal.contact.email)) {
      throw new Error("Contact email address is invalid.");
    }
    if (typeof proposal.contact.source !== "string" || !proposal.contact.source.trim()) {
      throw new Error("Contact email needs a source URL.");
    }
  }

  if (proposal.image !== undefined) {
    if (!proposal.image || typeof proposal.image !== "object" || Array.isArray(proposal.image)) {
      throw new Error("Image details must be a JSON object.");
    }
    if (!["url", "source", "permission"].every((field) =>
      typeof proposal.image[field] === "string" && proposal.image[field].trim(),
    )) {
      throw new Error("A logo needs a URL, source, and permission note.");
    }
  }

  return true;
}

export function mergeFacility(existing, proposal, taxonomy) {
  const mergedRecord = {
    ...proposal,
    id: existing.id,
    name: proposal.name || existing.name,
    institution: proposal.institution || existing.institution,
    reviewStatus: "verified",
    lastChecked: new Date().toISOString().slice(0, 10),
    techniques: [...new Set([...(existing.techniques ?? []), ...(proposal.techniques ?? [])])],
    instruments: [...(existing.instruments ?? [])],
    sources: [...(existing.sources ?? [])],
  };

  const instrumentKeys = new Set(mergedRecord.instruments.map(instrumentKey));
  for (const instrument of proposal.instruments ?? []) {
    const key = instrumentKey(instrument);
    if (!instrumentKeys.has(key)) {
      mergedRecord.instruments.push(instrument);
      instrumentKeys.add(key);
    }
  }

  const sourceKeys = new Set(mergedRecord.sources.map(({ url }) => normalizeSourceUrl(url)));
  for (const source of proposal.sources ?? []) {
    const key = normalizeSourceUrl(source.url);
    if (!sourceKeys.has(key)) {
      mergedRecord.sources.push(source);
      sourceKeys.add(key);
    }
  }

  mergedRecord.access = proposal.access?.source ? proposal.access : existing.access;
  if (proposal.access?.status === "unknown" && existing.access?.status !== "unknown") {
    mergedRecord.access = existing.access;
  }
  mergedRecord.contact = proposal.contact?.email ? proposal.contact : existing.contact;
  mergedRecord.image = proposal.image?.url ? proposal.image : existing.image;
  mergedRecord.location = {
    ...existing.location,
    ...proposal.location,
    city: proposal.location?.city || existing.location?.city,
    region: proposal.location?.region || existing.location?.region,
    country: proposal.location?.country || existing.location?.country,
    addresses: mergeUnique(
      existing.location?.addresses ?? [],
      proposal.location?.addresses ?? [],
      (address) => `${address.site}|${address.address}`.toLowerCase(),
    ),
  };
  mergedRecord.techniques = mergedRecord.techniques.filter((id) =>
    taxonomy.techniques.some((technique) => technique.id === id),
  );
  return mergedRecord;
}

export async function listHtmlFiles(inputRoot) {
  const files = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (entry.isFile() && /\.html?$/i.test(entry.name)) {
        files.push(fullPath);
        if (files.length > MAX_HTML_FILES_PER_SCAN) {
          throw new Error(`More than ${MAX_HTML_FILES_PER_SCAN} HTML files found; split the download batch.`);
        }
      }
    }
  }
  await visit(inputRoot);
  return files.sort((left, right) => left.localeCompare(right));
}

export async function readLedger(ledgerRoot) {
  const records = [];
  for (const folder of ["pending", "merged", "checked"]) {
    const directory = path.join(ledgerRoot, folder);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const filePath = path.join(directory, entry.name);
      records.push({ folder, filePath, record: JSON.parse(await readFile(filePath, "utf8")) });
    }
  }
  return records;
}

export async function persistPendingProposal(ledgerRoot, proposal) {
  const directory = path.join(ledgerRoot, "pending");
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `${proposal.id}.json`);
  try {
    await writeFile(filePath, `${JSON.stringify(proposal, null, 2)}\n`, { flag: "wx" });
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
}

export async function markProposalApplying(ledgerRoot, proposalId, applying) {
  const filePath = path.join(ledgerRoot, "pending", `${proposalId}.json`);
  const record = JSON.parse(await readFile(filePath, "utf8"));
  record.review = { ...(record.review ?? {}), applying };
  await replaceJsonFile(filePath, record);
}

export async function clearProposalApplying(ledgerRoot, proposalId) {
  const filePath = path.join(ledgerRoot, "pending", `${proposalId}.json`);
  const record = JSON.parse(await readFile(filePath, "utf8"));
  if (!record.review?.applying) return;
  delete record.review.applying;
  if (!Object.keys(record.review).length) delete record.review;
  await replaceJsonFile(filePath, record);
}

export async function decideProposal(ledgerRoot, proposalId, decision, metadata = {}) {
  if (!["merged", "checked"].includes(decision)) {
    throw new Error("A reviewed proposal must move to either merged or checked.");
  }
  const source = path.join(ledgerRoot, "pending", `${proposalId}.json`);
  const targetDirectory = path.join(ledgerRoot, decision);
  const target = path.join(targetDirectory, `${proposalId}.json`);
  await mkdir(targetDirectory, { recursive: true });

  const record = JSON.parse(await readFile(source, "utf8"));
  record.review = {
    ...(record.review ?? {}),
    ...metadata,
    decision,
    reviewedAt: new Date().toISOString(),
  };
  delete record.review.applying;
  const temporary = `${target}.tmp-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
  await rename(temporary, target);
  await unlink(source);
  return record;
}

export async function writeApprovedFacilities(facilitiesPath, nextFacilities, validator, beforeReplace) {
  const contents = `${JSON.stringify(nextFacilities, null, 2)}\n`;
  validator(JSON.parse(contents));

  const backupDirectory = path.join(path.dirname(facilitiesPath), "curation-ledger", "backups");
  await mkdir(backupDirectory, { recursive: true });
  const backupPath = path.join(backupDirectory, `facilities-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.json`);
  await copyFile(facilitiesPath, backupPath);

  const temporary = `${facilitiesPath}.tmp-${randomUUID()}`;
  await writeFile(temporary, contents, { flag: "wx" });
  try {
    if (beforeReplace) await beforeReplace(backupPath);
    await rename(temporary, facilitiesPath);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return backupPath;
}

function instrumentKey(instrument) {
  return `${instrument.name ?? ""}|${instrument.model ?? ""}`.trim().toLowerCase();
}

async function replaceJsonFile(filePath, value) {
  const temporary = `${filePath}.tmp-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  try {
    await rename(temporary, filePath);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function mergeUnique(existing, additions, keyFor) {
  const result = [...existing];
  const keys = new Set(result.map(keyFor));
  for (const item of additions) {
    const key = keyFor(item);
    if (!keys.has(key)) {
      result.push(item);
      keys.add(key);
    }
  }
  return result;
}
