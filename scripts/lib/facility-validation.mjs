import { URL } from "node:url";

export function validateFacilityCollection(facilities, taxonomy) {
  if (!Array.isArray(facilities) || facilities.length === 0) {
    throw new Error("The published directory must contain at least one facility record.");
  }

  const techniqueIds = new Set(taxonomy.techniques.map(({ id }) => id));
  const instrumentTypes = new Set(taxonomy.instrumentTypes.map(({ id }) => id));
  const facilityIds = new Set();

  for (const facility of facilities) {
    if (!facility.id || facilityIds.has(facility.id)) {
      throw new Error(`Facility id must be unique: ${facility.id ?? "(empty)"}`);
    }
    facilityIds.add(facility.id);

    if (facility.reviewStatus !== "verified") {
      throw new Error(`${facility.id} must be human verified.`);
    }
    if (!facility.name || !facility.institution) {
      throw new Error(`${facility.id} needs a name and institution.`);
    }
    if (!facility.location?.city || !facility.location?.country) {
      throw new Error(`${facility.id} needs a location.`);
    }
    if (!Array.isArray(facility.location.addresses) || !facility.location.addresses.length) {
      throw new Error(`${facility.id} needs at least one site address.`);
    }
    for (const address of facility.location.addresses) {
      if (!address.address || !address.site) {
        throw new Error(`${facility.id} has an address without a site label.`);
      }
      if (address.coordinates && !(
        Number.isFinite(address.coordinates.lat)
        && address.coordinates.lat >= -90
        && address.coordinates.lat <= 90
        && Number.isFinite(address.coordinates.lng)
        && address.coordinates.lng >= -180
        && address.coordinates.lng <= 180
      )) {
        throw new Error(`${facility.id} has invalid coordinates.`);
      }
    }

    if (!["external-and-internal", "collaborative", "public", "unknown"].includes(facility.access?.status)) {
      throw new Error(`${facility.id} has an invalid access status.`);
    }
    if (!facility.access?.source) {
      throw new Error(`${facility.id} needs an access evidence source.`);
    }
    if (!Array.isArray(facility.techniques) || facility.techniques.some((id) => !techniqueIds.has(id))) {
      throw new Error(`${facility.id} has an unknown technique.`);
    }
    if (!Array.isArray(facility.instruments) || facility.instruments.some((instrument) =>
      (instrument.type !== "unknown" && !instrumentTypes.has(instrument.type))
        || !(instrument.name || instrument.model)
        || (instrument.techniques ?? []).some((id) => !techniqueIds.has(id)),
    )) {
      throw new Error(`${facility.id} has an invalid instrument type, name, or technique.`);
    }
    if (facility.instruments.some((instrument) =>
      instrument.status !== undefined && !["active", "planned", "retired"].includes(instrument.status),
    )) {
      throw new Error(`${facility.id} has an invalid instrument status.`);
    }
    if (!Array.isArray(facility.sources) || !facility.sources.length) {
      throw new Error(`${facility.id} needs at least one source.`);
    }
    if (!facility.lastChecked) {
      throw new Error(`${facility.id} needs a lastChecked date.`);
    }
    if (facility.contact?.email) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(facility.contact.email)) {
        throw new Error(`${facility.id} has an invalid email.`);
      }
      if (!facility.contact.source) {
        throw new Error(`${facility.id} contact email needs a source.`);
      }
    }
    if (facility.image && !(facility.image.url && facility.image.source && facility.image.permission)) {
      throw new Error(`${facility.id} image needs source and permission details.`);
    }
    for (const source of facility.sources) {
      let url;
      try {
        url = new URL(source.url);
      } catch {
        throw new Error(`${facility.id} has an invalid source URL: ${source.url ?? "(empty)"}.`);
      }
      if (!["http:", "https:"].includes(url.protocol)) {
        throw new Error(`${facility.id} has a non-web source URL.`);
      }
    }
  }
  return true;
}
