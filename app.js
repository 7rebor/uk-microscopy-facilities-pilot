const facilityList = document.querySelector("#facility-list");
const searchInput = document.querySelector("#search");
const locationFilter = document.querySelector("#location-filter");
const techniqueFilter = document.querySelector("#technique-filter");
const instrumentFilter = document.querySelector("#instrument-filter");
const resultCount = document.querySelector("#result-count");
const loadError = document.querySelector("#load-error");

let facilities = [];
let taxonomy = { techniques: [], instrumentTypes: [] };
let facilityMap;
let facilityMarkers;

const techniqueLabels = () => new Map(taxonomy.techniques.map(({ id, label }) => [id, label]));
const instrumentLabels = () => new Map(taxonomy.instrumentTypes.map(({ id, label }) => [id, label]));

function addOptions(select, values) {
  const options = [...new Map(
    values.map((value) => {
      const item = typeof value === "string"
        ? { id: value, label: value }
        : { id: value.id ?? value, label: value.label ?? value.id ?? value };
      return [item.id, item];
    }),
  ).values()].sort((a, b) => a.label.localeCompare(b.label));

  for (const optionData of options) {
    const option = document.createElement("option");
    option.value = optionData.id;
    option.textContent = optionData.label;
    select.append(option);
  }
}

function setFilters() {
  addOptions(locationFilter, facilities.flatMap(({ location }) =>
    [
      location.city,
      location.region,
      ...(location.addresses ?? []).map(({ site }) => site),
    ].filter(Boolean),
  ));
  addOptions(techniqueFilter, taxonomy.techniques);
  addOptions(instrumentFilter, taxonomy.instrumentTypes);
}

function visibleFacilities() {
  const query = searchInput.value.trim().toLocaleLowerCase();
  return facilities.filter((facility) => {
    const searchable = [
      facility.name,
      facility.institution,
      facility.location.city,
      facility.location.region,
      ...(facility.location.addresses ?? []).flatMap(({ site, building, address }) =>
        [site, building, address],
      ),
      ...facility.techniques.map((id) => techniqueLabels().get(id)),
      ...facility.instruments.flatMap(({ name, manufacturer, model, type }) =>
        [name, manufacturer, model, instrumentLabels().get(type)],
      ),
    ].filter(Boolean).join(" ").toLocaleLowerCase();

    const matchesLocation = !locationFilter.value
      || facility.location.city === locationFilter.value
      || facility.location.region === locationFilter.value
      || (facility.location.addresses ?? []).some(({ site }) => site === locationFilter.value);
    const matchesTechnique = !techniqueFilter.value
      || facility.techniques.includes(techniqueFilter.value);
    const matchesInstrument = !instrumentFilter.value
      || facility.instruments.some(({ type }) => type === instrumentFilter.value);
    return (!query || searchable.includes(query))
      && matchesLocation
      && matchesTechnique
      && matchesInstrument;
  });
}

function createTag(text) {
  const tag = document.createElement("span");
  tag.className = "tag";
  tag.textContent = text;
  return tag;
}

function createLink(label, url) {
  const link = document.createElement("a");
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = label;
  return link;
}

function renderFacility(facility) {
  const card = document.createElement("article");
  card.className = "facility-card";

  const top = document.createElement("div");
  top.className = "card-top";
  if (facility.image?.url && facility.image?.permission) {
    const image = document.createElement("img");
    image.className = "facility-image";
    image.src = facility.image.url;
    image.alt = facility.image.alt || `${facility.institution} image`;
    image.loading = "lazy";
    top.append(image);
  } else {
    const placeholder = document.createElement("div");
    placeholder.className = "image-placeholder";
    placeholder.setAttribute("aria-label", "No permitted facility image supplied");
    placeholder.textContent = facility.institution.split(/\s+/).slice(0, 2).map((word) => word[0]).join("").toUpperCase();
    top.append(placeholder);
  }

  const title = document.createElement("div");
  title.className = "facility-title";
  const heading = document.createElement("h2");
  heading.textContent = facility.name;
  const institution = document.createElement("p");
  institution.className = "institution";
  institution.textContent = facility.institution;
  title.append(heading, institution);
  top.append(title);

  const body = document.createElement("div");
  body.className = "facility-body";
  const locations = facility.location.addresses ?? [];
  if (locations.length) {
    const locationLabel = document.createElement("p");
    locationLabel.className = "label";
    locationLabel.textContent = "Site address";
    const addressList = document.createElement("div");
    addressList.className = "address-list";
    for (const site of locations) {
      const address = document.createElement("p");
      address.className = "location";
      address.textContent = [site.site, site.building, site.address]
        .filter(Boolean)
        .filter((value, index, values) => values.indexOf(value) === index)
        .join(" · ");
      addressList.append(address);
    }
    body.append(locationLabel, addressList);
  } else {
    const location = document.createElement("p");
    location.className = "location";
    location.textContent = [facility.location.city, facility.location.region]
      .filter(Boolean).join(" · ");
    body.append(location);
  }

  const techniqueLabel = document.createElement("p");
  techniqueLabel.className = "label";
  techniqueLabel.textContent = "Techniques";
  const techniques = document.createElement("div");
  techniques.className = "tag-group";
  for (const id of facility.techniques) {
    techniques.append(createTag(techniqueLabels().get(id) ?? id));
  }
  body.append(techniqueLabel, techniques);

  const instrumentLabel = document.createElement("p");
  instrumentLabel.className = "label";
  instrumentLabel.textContent = "Instruments and manufacturers";
  const instruments = document.createElement("div");
  instruments.className = "tag-group";
  for (const instrument of facility.instruments) {
    const name = instrument.name || [instrument.manufacturer, instrument.model].filter(Boolean).join(" ");
    const description = [
      name,
      instrumentLabels().get(instrument.type),
      instrument.status,
      instrument.locationDetails,
    ]
      .filter(Boolean).join(" — ");
    if (description) instruments.append(createTag(description));
  }
  body.append(instrumentLabel, instruments);

  const contact = document.createElement("p");
  contact.className = "contact";
  if (facility.contact?.email) {
    const email = document.createElement("a");
    email.href = `mailto:${facility.contact.email}`;
    email.textContent = facility.contact.email;
    contact.append("Contact: ", email);
  } else {
    contact.textContent = "Contact: not listed in the verified sources.";
  }
  body.append(contact);

  const sourceRow = document.createElement("div");
  sourceRow.className = "source-row";
  sourceRow.append(createLink("Official facility page", facility.access.source));
  const checked = document.createElement("span");
  checked.textContent = `Checked ${facility.lastChecked}`;
  sourceRow.append(checked);
  body.append(sourceRow);

  card.append(top, body);
  return card;
}

function renderMap() {
  if (typeof L === "undefined") return;

  if (!facilityMap) {
    facilityMap = L.map("facility-map", { scrollWheelZoom: true }).setView([54.5, -3.5], 5);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
      maxZoom: 19,
    }).addTo(facilityMap);
    facilityMarkers = L.layerGroup().addTo(facilityMap);
  }

  const matches = visibleFacilities();
  facilityMarkers.clearLayers();

  const locations = matches
    .flatMap((facility) => facility.location?.addresses ?? [])
    .filter(({ coordinates }) => coordinates)
    .map(({ coordinates }) => [coordinates.lat, coordinates.lng]);

  if (locations.length === 0) {
    facilityMap.setView([54.5, -3.5], 5);
    return;
  }

  for (const facility of matches) {
    for (const site of facility.location?.addresses ?? []) {
      const { lat, lng } = site.coordinates ?? {};
      if (typeof lat !== "number" || typeof lng !== "number") continue;
      const marker = L.marker([lat, lng]).addTo(facilityMarkers);
      const popup = document.createElement("div");
      const heading = document.createElement("strong");
      heading.textContent = facility.name;
      const siteName = document.createElement("p");
      siteName.textContent = site.site;
      const address = document.createElement("p");
      address.textContent = site.address;
      const accuracy = document.createElement("p");
      accuracy.textContent = `${site.coordinateAccuracy || "approximate"} map point`;
      popup.append(heading, siteName, address, accuracy);
      marker.bindPopup(popup);
    }
  }

  if (locations.length === 1) {
    facilityMap.setView(locations[0], 6);
  } else {
    facilityMap.fitBounds(locations, { padding: [18, 18], maxZoom: 7 });
  }
}

function render() {
  const matches = visibleFacilities();
  resultCount.textContent = `${matches.length} of ${facilities.length} facilities`;
  facilityList.replaceChildren();
  if (matches.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No facilities match these filters.";
    facilityList.append(empty);
  } else {
    facilityList.append(...matches.map(renderFacility));
  }
  renderMap();
}

for (const control of [searchInput, locationFilter, techniqueFilter, instrumentFilter]) {
  control.addEventListener("input", render);
  control.addEventListener("change", render);
}

document.querySelector("#clear-filters").addEventListener("click", () => {
  searchInput.value = "";
  locationFilter.value = "";
  techniqueFilter.value = "";
  instrumentFilter.value = "";
  render();
});

async function loadDirectory() {
  try {
    const [facilityResponse, taxonomyResponse] = await Promise.all([
      fetch("data/facilities.json"),
      fetch("data/taxonomy.json"),
    ]);
    if (!facilityResponse.ok || !taxonomyResponse.ok) {
      throw new Error("Could not load directory data.");
    }
    [facilities, taxonomy] = await Promise.all([
      facilityResponse.json(),
      taxonomyResponse.json(),
    ]);
    setFilters();
    render();
  } catch (error) {
    console.error(error);
    loadError.hidden = false;
    loadError.textContent = "Facility data could not be loaded. Serve this folder over HTTP and check the data files.";
    resultCount.textContent = "Directory unavailable.";
  }
}

loadDirectory();
