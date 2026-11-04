import { MAX_PAGE_TEXT_LENGTH } from "./curator-store.mjs";

const API_ROOT = "https://generativelanguage.googleapis.com/v1beta/models";
const profiles = {
  personal: "GEMINI_API_KEY_PERSONAL",
  professional: "GEMINI_API_KEY_PROFESSIONAL",
};

export function availableGeminiProfiles(environment = process.env) {
  return Object.fromEntries(
    Object.entries(profiles).map(([profile, keyName]) => [profile, Boolean(environment[keyName])]),
  );
}

export function getGeminiKey(profile, environment = process.env) {
  const keyName = profiles[profile];
  if (!keyName) throw new Error("Choose either the personal or professional Gemini API key.");
  const key = environment[keyName];
  if (!key) throw new Error(`${keyName} is not set in the environment where the curation app was launched.`);
  return key;
}

export async function generateFacilityProposals({
  host,
  pages,
  facilities,
  taxonomy,
  profile,
  model = process.env.GEMINI_MODEL || "gemini-2.5-flash",
  environment = process.env,
  fetchImpl = fetch,
}) {
  const apiKey = getGeminiKey(profile, environment);
  const request = {
    contents: [{
      role: "user",
      parts: [{ text: createPrompt(host, pages, facilities, taxonomy) }],
    }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: responseSchema,
      temperature: 0.1,
    },
  };
  const url = `${API_ROOT}/${encodeURIComponent(model)}:generateContent`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gemini request failed (HTTP ${response.status}): ${body.slice(0, 900)}`);
  }

  const payload = await response.json();
  const responseText = payload.candidates?.[0]?.content?.parts
    ?.map(({ text }) => text ?? "")
    .join("");
  if (!responseText) {
    const reason = payload.promptFeedback?.blockReason ?? "no candidate response";
    throw new Error(`Gemini returned no proposal content (${reason}).`);
  }

  let parsed;
  try {
    parsed = JSON.parse(responseText);
  } catch (error) {
    throw new Error(`Gemini response was not valid JSON: ${error.message}`);
  }
  return validateModelResponse(parsed, pages, taxonomy, facilities);
}

function createPrompt(host, pages, facilities, taxonomy) {
  const pagePacket = pages.map((page) => ({
    pageId: page.pageId,
    savedFile: page.savedFile,
    sourceUrl: page.sourceUrl,
    title: page.title,
    description: page.description,
    headings: page.headings,
    emails: page.emails,
    links: page.links,
    imageCandidates: page.imageCandidates,
    text: String(page.text ?? "").slice(0, MAX_PAGE_TEXT_LENGTH),
  }));
  const existing = facilities.map(({ id, name, institution, location, sources }) => ({
    id,
    name,
    institution,
    city: location?.city,
    region: location?.region,
    sourceUrls: (sources ?? []).map(({ url }) => url),
  }));

  return [
    "You are preparing proposals for a human-curated UK microscopy facilities directory.",
    "The input pages have already been downloaded locally. Do not fetch URLs or claim that you verified the live pages.",
    `The host ${host} is only a batching hint. One institution/domain may contain multiple distinct facilities.`,
    "Infer distinct facility identities from page titles, content, and internal links. A facility may span multiple supplied pages or sites. Do not merge distinct facilities just because they share an institution, domain, staff, or campus.",
    "Return one facilityGroups item per plausible facility. If boundaries are unclear, return a separate uncertain group and explain why; do not guess a definitive facility name.",
    "Only include details supported by supplied page evidence. Do not fill missing facts from memory or inference. Use empty strings or empty arrays when unknown; mark uncertainty.",
    "Technique values must be taxonomy IDs from the supplied list. Instrument type must be a supplied type ID or 'unknown'.",
    "Each evidence quote must be a short exact excerpt from the cited page, with its pageId and sourceUrl. Cite evidence for facility identity, location, email, logo, techniques, and instruments where available.",
    "For an existing record, set matchFacilityId only when the evidence strongly supports the match. Otherwise use an empty string. recommendedAction is 'update' or 'add'; uncertain cases should use 'needs-review'.",
    "For images, only propose a URL found in the supplied imageCandidates. Permission is not established by the HTML, so use an empty permission note and mark rights as uncertain.",
    "Every returned pageId must be one of the supplied page IDs. Include pages that you could not confidently assign in unassignedPageIds.",
    "",
    `Taxonomy: ${JSON.stringify({
      techniques: taxonomy.techniques,
      instrumentTypes: taxonomy.instrumentTypes,
    })}`,
    `Existing facility summaries: ${JSON.stringify(existing)}`,
    `Downloaded page evidence: ${JSON.stringify(pagePacket)}`,
  ].join("\n");
}

function validateModelResponse(result, pages, taxonomy, facilities) {
  if (!result || !Array.isArray(result.facilityGroups)) {
    throw new Error("Gemini response must include a facilityGroups array.");
  }
  const pageIds = new Set(pages.map(({ pageId }) => pageId));
  const facilityIds = new Set(facilities.map(({ id }) => id));
  const techniqueIds = new Set(taxonomy.techniques.map(({ id }) => id));
  const instrumentTypes = new Set(taxonomy.instrumentTypes.map(({ id }) => id));
  const assignedPageIds = new Set();

  for (const [index, group] of result.facilityGroups.entries()) {
    if (!Array.isArray(group.pageIds) || !group.pageIds.length) {
      throw new Error(`Gemini facility group ${index + 1} has no page IDs.`);
    }
    if (group.pageIds.some((id) => !pageIds.has(id))) {
      throw new Error(`Gemini facility group ${index + 1} references an unknown page ID.`);
    }
    if (new Set(group.pageIds).size !== group.pageIds.length) {
      throw new Error(`Gemini facility group ${index + 1} contains a duplicate page ID.`);
    }
    if (group.pageIds.some((id) => assignedPageIds.has(id))) {
      throw new Error(`Gemini assigned a page to more than one facility group.`);
    }
    for (const id of group.pageIds) assignedPageIds.add(id);
    if (!["add", "update", "needs-review"].includes(group.recommendedAction)) {
      throw new Error(`Gemini facility group ${index + 1} has an invalid recommended action.`);
    }
    if (group.matchFacilityId && !facilityIds.has(group.matchFacilityId)) {
      throw new Error(`Gemini matched ${group.matchFacilityId}, which is not an existing record.`);
    }

    const record = group.record;
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error(`Gemini facility group ${index + 1} has no proposed record.`);
    }
    if (!Array.isArray(record.techniques) || record.techniques.some((id) => !techniqueIds.has(id))) {
      throw new Error(`Gemini proposed an unknown technique in facility group ${index + 1}.`);
    }
    if (!Array.isArray(record.instruments)) {
      throw new Error(`Gemini instruments must be a list in facility group ${index + 1}.`);
    }
    for (const instrument of record.instruments) {
      if (instrument.type && instrument.type !== "unknown" && !instrumentTypes.has(instrument.type)) {
        throw new Error(`Gemini proposed an unknown instrument type: ${instrument.type}.`);
      }
      if ((instrument.techniques ?? []).some((id) => !techniqueIds.has(id))) {
        throw new Error(`Gemini proposed an unknown instrument technique in facility group ${index + 1}.`);
      }
    }
    for (const evidence of group.evidence ?? []) {
      if (!pageIds.has(evidence.pageId)) {
        throw new Error(`Gemini evidence references an unknown page ID in facility group ${index + 1}.`);
      }
      const page = pages.find(({ pageId }) => pageId === evidence.pageId);
      if (evidence.sourceUrl !== page.sourceUrl) {
        throw new Error(`Gemini evidence cites a URL not associated with page ${evidence.pageId}.`);
      }
      if (evidence.quote && !normalizeEvidence(page.text).includes(normalizeEvidence(evidence.quote))) {
        throw new Error(`Gemini supplied a quote not found in page ${evidence.pageId}.`);
      }
    }
  }

  if (!Array.isArray(result.unassignedPageIds ?? [])) {
    throw new Error("Gemini unassignedPageIds must be an array.");
  }
  if ((result.unassignedPageIds ?? []).some((id) => !pageIds.has(id))) {
    throw new Error("Gemini unassignedPageIds contains an unknown page ID.");
  }
  if ((result.unassignedPageIds ?? []).some((id) => assignedPageIds.has(id))) {
    throw new Error("Gemini assigned a page as both unassigned and part of a facility group.");
  }
  if (new Set(result.unassignedPageIds ?? []).size !== (result.unassignedPageIds ?? []).length) {
    throw new Error("Gemini returned a duplicate unassigned page ID.");
  }
  return result;
}

function normalizeEvidence(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

const responseSchema = {
  type: "OBJECT",
  properties: {
    facilityGroups: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          facilityName: { type: "STRING" },
          institution: { type: "STRING" },
          pageIds: { type: "ARRAY", items: { type: "STRING" } },
          rationale: { type: "STRING" },
          recommendedAction: { type: "STRING", enum: ["add", "update", "needs-review"] },
          matchFacilityId: { type: "STRING" },
          record: {
            type: "OBJECT",
            properties: {
              name: { type: "STRING" },
              institution: { type: "STRING" },
              city: { type: "STRING" },
              region: { type: "STRING" },
              country: { type: "STRING" },
              addresses: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: {
                    site: { type: "STRING" },
                    building: { type: "STRING" },
                    address: { type: "STRING" },
                  },
                  required: ["site", "building", "address"],
                },
              },
              accessStatus: { type: "STRING", enum: ["external-and-internal", "collaborative", "public", "unknown"] },
              accessEvidence: { type: "STRING" },
              contactEmail: { type: "STRING" },
              contactName: { type: "STRING" },
              imageUrl: { type: "STRING" },
              imageAlt: { type: "STRING" },
              techniques: { type: "ARRAY", items: { type: "STRING" } },
              instruments: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: {
                    name: { type: "STRING" },
                    manufacturer: { type: "STRING" },
                    model: { type: "STRING" },
                    type: { type: "STRING" },
                    techniques: { type: "ARRAY", items: { type: "STRING" } },
                    locationDetails: { type: "STRING" },
                    status: { type: "STRING" },
                    evidence: { type: "STRING" },
                    source: { type: "STRING" },
                  },
                  required: ["name", "manufacturer", "model", "type", "techniques", "locationDetails", "status", "evidence", "source"],
                },
              },
            },
            required: ["name", "institution", "city", "region", "country", "addresses", "accessStatus", "accessEvidence", "contactEmail", "contactName", "imageUrl", "imageAlt", "techniques", "instruments"],
          },
          evidence: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                field: { type: "STRING" },
                pageId: { type: "STRING" },
                sourceUrl: { type: "STRING" },
                quote: { type: "STRING" },
              },
              required: ["field", "pageId", "sourceUrl", "quote"],
            },
          },
          uncertainties: { type: "ARRAY", items: { type: "STRING" } },
        },
        required: ["facilityName", "institution", "pageIds", "rationale", "recommendedAction", "matchFacilityId", "record", "evidence", "uncertainties"],
      },
    },
    unassignedPageIds: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["facilityGroups", "unassignedPageIds"],
};
