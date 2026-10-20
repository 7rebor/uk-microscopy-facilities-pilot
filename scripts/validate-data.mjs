import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";

const root = new URL("../data/", import.meta.url);
const facilities = JSON.parse(await readFile(new URL("facilities.json", root), "utf8"));
const taxonomy = JSON.parse(await readFile(new URL("taxonomy.json", root), "utf8"));
const techniqueIds = new Set(taxonomy.techniques.map(({ id }) => id));
const instrumentTypes = new Set(taxonomy.instrumentTypes.map(({ id }) => id));
const facilityIds = new Set();

assert.ok(Array.isArray(facilities), "facilities.json must contain an array");
assert.ok(facilities.length > 0, "the published directory must contain at least one verified facility");

for (const facility of facilities) {
  assert.ok(facility.id && !facilityIds.has(facility.id), `facility id must be unique: ${facility.id}`);
  facilityIds.add(facility.id);
  assert.equal(facility.reviewStatus, "verified", `${facility.id} must be human verified`);
  assert.ok(facility.name && facility.institution, `${facility.id} needs a name and institution`);
  assert.ok(facility.location?.city && facility.location?.country, `${facility.id} needs a location`);
  assert.ok(
    Array.isArray(facility.location.addresses) && facility.location.addresses.length > 0,
    `${facility.id} needs at least one site address`,
  );
  for (const address of facility.location.addresses) {
    assert.ok(address.address && address.site, `${facility.id} has an address without a site label`);
    if (address.coordinates) {
      assert.ok(
        Number.isFinite(address.coordinates.lat)
          && address.coordinates.lat >= -90
          && address.coordinates.lat <= 90
          && Number.isFinite(address.coordinates.lng)
          && address.coordinates.lng >= -180
          && address.coordinates.lng <= 180,
        `${facility.id} has invalid coordinates`,
      );
    }
  }
  assert.ok(
    ["external-and-internal", "collaborative", "public", "unknown"].includes(facility.access?.status),
    `${facility.id} has an invalid access status`,
  );
  assert.ok(facility.access?.source, `${facility.id} needs an access evidence source`);
  assert.ok(facility.techniques.every((id) => techniqueIds.has(id)), `${facility.id} has an unknown technique`);
  assert.ok(facility.instruments.every((instrument) =>
    (instrument.type === "unknown" || instrumentTypes.has(instrument.type))
      && Boolean(instrument.name || instrument.model)
      && (instrument.techniques || []).every((id) => techniqueIds.has(id)),
  ), `${facility.id} has an invalid instrument type, name, or technique`);
  assert.ok(facility.instruments.every((instrument) =>
    instrument.status === undefined || ["active", "planned", "retired"].includes(instrument.status),
  ), `${facility.id} has an invalid instrument status`);
  assert.ok(facility.sources.length > 0, `${facility.id} needs at least one source`);
  assert.ok(facility.lastChecked, `${facility.id} needs a lastChecked date`);
  if (facility.contact?.email) {
    assert.match(facility.contact.email, /^[^\s@]+@[^\s@]+\.[^\s@]+$/, `${facility.id} has an invalid email`);
    assert.ok(facility.contact.source, `${facility.id} contact email needs a source`);
  }
  if (facility.image) {
    assert.ok(facility.image.url && facility.image.source && facility.image.permission, `${facility.id} image needs source and permission details`);
  }
  for (const source of facility.sources) {
    assert.ok(["http:", "https:"].includes(new URL(source.url).protocol), `${facility.id} has a non-web source URL`);
  }
}

console.log(`Validated ${facilities.length} verified facility records.`);
