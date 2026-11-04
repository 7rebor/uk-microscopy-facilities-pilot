import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  chunkPages,
  clearProposalApplying,
  decideProposal,
  groupPagesByHost,
  makeProposalId,
  markProposalApplying,
  mergeFacility,
  pageIdentity,
  persistPendingProposal,
  validateProposal,
  writeApprovedFacilities,
} from "../scripts/lib/curator-store.mjs";
import { validateFacilityCollection } from "../scripts/lib/facility-validation.mjs";
import { generateFacilityProposals } from "../scripts/lib/gemini-proposals.mjs";

const taxonomy = {
  techniques: [{ id: "confocal", label: "Confocal microscopy" }],
  instrumentTypes: [{ id: "confocal-microscope", label: "Confocal microscope" }],
};

const validProposal = {
  id: "sample-facility",
  name: "Sample Imaging Facility",
  institution: "Sample University",
  location: {
    city: "London",
    region: "England",
    country: "United Kingdom",
    addresses: [{ site: "Main campus", building: "", address: "1 Example Road" }],
  },
  access: { status: "unknown", evidence: "", source: "https://example.ac.uk/facility" },
  techniques: ["confocal"],
  instruments: [{
    name: "Sample confocal",
    manufacturer: "Example",
    model: "C1",
    type: "confocal-microscope",
    techniques: ["confocal"],
    evidence: "Listed on the equipment page.",
    source: "https://example.ac.uk/facility/equipment",
  }],
  sources: [{ url: "https://example.ac.uk/facility", checked: "2026-11-04", notes: "" }],
};

test("page identity changes with the source or downloaded content", () => {
  const first = pageIdentity("https://example.ac.uk/a#part", "hash-a");
  assert.equal(first, pageIdentity("https://example.ac.uk/a", "hash-a"));
  assert.notEqual(first, pageIdentity("https://example.ac.uk/a", "hash-b"));
  assert.notEqual(first, pageIdentity("https://example.ac.uk/b", "hash-a"));
});

test("host grouping is only a batching hint and chunks stay bounded", () => {
  const groups = groupPagesByHost([
    { sourceUrl: "https://one.ac.uk/a" },
    { sourceUrl: "https://www.one.ac.uk/b" },
    { sourceUrl: "https://two.ac.uk/a" },
  ]);
  assert.deepEqual(groups.map(({ host, pages }) => [host, pages.length]), [
    ["one.ac.uk", 2],
    ["two.ac.uk", 1],
  ]);

  const pages = Array.from({ length: 7 }, (_, index) => ({ pageId: String(index), text: "page" }));
  assert.deepEqual(chunkPages(pages).map((chunk) => chunk.length), [6, 1]);
});

test("proposal IDs are stable and validation rejects unknown taxonomy values", () => {
  assert.equal(makeProposalId(["b", "a"], "Facility"), makeProposalId(["a", "b"], "Facility"));
  assert.equal(validateProposal(validProposal, taxonomy), true);
  assert.throws(() => validateProposal({ ...validProposal, techniques: ["not-in-taxonomy"] }, taxonomy), /unknown technique/i);
  assert.throws(() => validateProposal({
    ...validProposal,
    location: { ...validProposal.location, city: 12 },
  }, taxonomy), /city and country/i);
});

test("merges preserve existing equipment, sources, confirmed access, and add new details", () => {
  const existing = {
    ...validProposal,
    id: "existing",
    name: "Existing Facility",
    access: { status: "public", evidence: "Public access stated.", source: "https://example.ac.uk/access" },
    instruments: [validProposal.instruments[0]],
    sources: [validProposal.sources[0]],
    location: {
      ...validProposal.location,
      city: "Oxford",
      addresses: [{ site: "Existing", building: "", address: "Old Road" }],
    },
  };
  const proposal = {
    ...structuredClone(validProposal),
    name: "",
    location: {
      ...validProposal.location,
      city: "",
      addresses: [{ site: "New site", building: "", address: "New Road" }],
    },
    access: { status: "unknown", evidence: "", source: "https://example.ac.uk/facility" },
    instruments: [{ ...validProposal.instruments[0], name: "New microscope", model: "C2" }],
    sources: [{ url: "https://example.ac.uk/new", checked: "2026-11-04", notes: "" }],
  };

  const merged = mergeFacility(existing, proposal, taxonomy);
  assert.equal(merged.id, "existing");
  assert.equal(merged.name, "Existing Facility");
  assert.equal(merged.location.city, "Oxford");
  assert.equal(merged.access.status, "public");
  assert.equal(merged.instruments.length, 2);
  assert.equal(merged.sources.length, 2);
  assert.equal(merged.location.addresses.length, 2);
});

test("reviewed ledger items move out of pending into the selected folder", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "microscopy-ledger-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const proposal = { id: "abc123", pages: [{ identity: "page-hash" }], createdAt: new Date().toISOString() };

  assert.equal(await persistPendingProposal(root, proposal), true);
  assert.equal(await persistPendingProposal(root, proposal), false);
  await decideProposal(root, proposal.id, "checked", { action: "declined" });

  const pending = await readdir(path.join(root, "pending"));
  const checked = JSON.parse(await readFile(path.join(root, "checked", "abc123.json"), "utf8"));
  assert.deepEqual(pending, []);
  assert.equal(checked.review.decision, "checked");
  assert.equal(checked.review.action, "declined");
});

test("pending write markers can be cleared or removed when a decision is finalized", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "microscopy-ledger-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const proposal = { id: "recover123", pages: [{ identity: "page-hash" }] };
  await persistPendingProposal(root, proposal);
  await markProposalApplying(root, proposal.id, {
    action: "add",
    facilityId: "sample-facility",
    recordHash: "record-hash",
  });
  await clearProposalApplying(root, proposal.id);
  await markProposalApplying(root, proposal.id, {
    action: "add",
    facilityId: "sample-facility",
    recordHash: "record-hash",
  });
  await decideProposal(root, proposal.id, "merged", { action: "add" });

  const reviewed = JSON.parse(await readFile(path.join(root, "merged", "recover123.json"), "utf8"));
  assert.equal(reviewed.review.applying, undefined);
  assert.equal(reviewed.review.decision, "merged");
});

test("approved JSON writes make a backup before replacing the data file", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "microscopy-facilities-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "facilities.json");
  await writeFile(file, "[{\"before\":true}]\n");

  let observedBackup;
  const backupPath = await writeApprovedFacilities(
    file,
    [{ after: true }],
    (value) => assert.deepEqual(value, [{ after: true }]),
    async (createdBackupPath) => {
      observedBackup = await readFile(createdBackupPath, "utf8");
      assert.deepEqual(JSON.parse(await readFile(file, "utf8")), [{ before: true }]);
    },
  );

  assert.equal(observedBackup, '[{"before":true}]\n');
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), [{ after: true }]);
  assert.deepEqual(JSON.parse(await readFile(backupPath, "utf8")), [{ before: true }]);
});

test("approved record proposal schema aligns with published-data validation", () => {
  const complete = {
    ...structuredClone(validProposal),
    reviewStatus: "verified",
    lastChecked: "2026-11-04",
    contact: { email: "microscopy@example.ac.uk", name: null, source: "https://example.ac.uk/contact" },
  };
  assert.equal(validateFacilityCollection([complete], taxonomy), true);
});

test("Gemini request uses the selected environment key and validates cited evidence", async () => {
  const page = {
    pageId: "page-1",
    savedFile: "facility.html",
    sourceUrl: "https://example.ac.uk/facility",
    title: "Imaging Facility",
    text: "The Sample Imaging Facility offers confocal microscopy.",
    headings: [],
    description: "",
    links: [],
    imageCandidates: [],
    emails: [],
  };
  let observedRequest;
  const fetchImpl = async (_url, options) => {
    observedRequest = options;
    return {
      ok: true,
      json: async () => ({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                facilityGroups: [{
                  facilityName: "Sample Imaging Facility",
                  institution: "Sample University",
                  pageIds: ["page-1"],
                  rationale: "The page identifies this facility.",
                  recommendedAction: "add",
                  matchFacilityId: "",
                  record: {
                    name: "Sample Imaging Facility",
                    institution: "Sample University",
                    city: "London",
                    region: "England",
                    country: "United Kingdom",
                    addresses: [],
                    accessStatus: "unknown",
                    accessEvidence: "",
                    contactEmail: "",
                    contactName: "",
                    imageUrl: "",
                    imageAlt: "",
                    techniques: ["confocal"],
                    instruments: [],
                  },
                  evidence: [{
                    field: "techniques",
                    pageId: "page-1",
                    sourceUrl: page.sourceUrl,
                    quote: "The Sample Imaging Facility offers confocal microscopy.",
                  }],
                  uncertainties: [],
                }],
                unassignedPageIds: [],
              }),
            }],
          },
        }],
      }),
    };
  };

  const result = await generateFacilityProposals({
    host: "example.ac.uk",
    pages: [page],
    facilities: [],
    taxonomy,
    profile: "personal",
    environment: { GEMINI_API_KEY_PERSONAL: "test-key-not-a-real-credential" },
    fetchImpl,
  });
  assert.equal(result.facilityGroups[0].pageIds[0], "page-1");
  assert.equal(observedRequest.headers["x-goog-api-key"], "test-key-not-a-real-credential");
  assert.equal(JSON.parse(observedRequest.body).generationConfig.responseMimeType, "application/json");
});
