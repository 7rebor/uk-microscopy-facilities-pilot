const pendingList = document.querySelector("#pending-list");
const reviewContent = document.querySelector("#review-content");
const notice = document.querySelector("#notice");
const pendingCount = document.querySelector("#pending-count");
const scanButton = document.querySelector("#scan-button");
const keyProfile = document.querySelector("#key-profile");

const state = {
  pending: [],
  facilities: [],
  taxonomy: { techniques: [], instrumentTypes: [] },
  selectedId: null,
  comparisonFacilityId: "",
};

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function safeLink(url, label) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return node("span", "muted", label || url || "No source URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return node("span", "muted", label || url);
  }
  const link = node("a", "", label || url);
  link.href = parsed.href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

function showNotice(message, isError = false) {
  notice.hidden = false;
  notice.classList.toggle("error", isError);
  notice.textContent = message;
}

function clearNotice() {
  notice.hidden = true;
  notice.textContent = "";
  notice.classList.remove("error");
}

async function requestJson(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`The local app returned an invalid response (HTTP ${response.status}).`);
  }
  if (!response.ok) throw new Error(data.error || `Request failed (HTTP ${response.status}).`);
  return data;
}

async function refreshState({ keepSelection = true } = {}) {
  const previous = state.selectedId;
  const data = await requestJson("/api/state");
  state.pending = data.pending;
  state.facilities = data.facilities;
  state.taxonomy = data.taxonomy;
  keyProfile.value = data.profile;
  for (const option of keyProfile.options) {
    option.disabled = !data.profiles[option.value];
  }

  if (keepSelection && state.pending.some(({ id }) => id === previous)) {
    state.selectedId = previous;
  } else {
    state.selectedId = state.pending[0]?.id ?? null;
  }
  renderPending();
  renderSelection();
}

function renderPending() {
  pendingCount.textContent = String(state.pending.length);
  pendingList.replaceChildren();

  if (!state.pending.length) {
    pendingList.append(node("li", "list-empty", "No unreviewed pages. Scan a new batch when ready."));
    return;
  }

  for (const item of state.pending) {
    const listItem = node("li", `pending-entry${item.id === state.selectedId ? " selected" : ""}`);
    const button = node("button");
    button.type = "button";
    button.setAttribute("aria-current", item.id === state.selectedId ? "true" : "false");
    button.append(
      node("span", "pending-name", item.facilityName || "Unnamed facility proposal"),
      node("span", "pending-info", `${item.pages.length} page(s) · ${item.host}`),
      node("span", "pending-info", actionLabel(item.recommendedAction)),
    );
    button.addEventListener("click", () => {
      state.selectedId = item.id;
      renderPending();
      renderSelection();
    });
    listItem.append(button);
    pendingList.append(listItem);
  }
}

function renderSelection() {
  reviewContent.replaceChildren();
  const item = state.pending.find(({ id }) => id === state.selectedId);
  if (!item) {
    const empty = node("div", "empty-state");
    empty.append(
      node("h2", "", "Nothing selected"),
      node("p", "", "Scan your downloaded pages or select a pending proposal to begin."),
    );
    reviewContent.append(empty);
    return;
  }
  state.comparisonFacilityId = state.facilities.some(({ id }) => id === item.matchFacilityId)
    ? item.matchFacilityId
    : "";

  const heading = node("div", "candidate-heading");
  const titleBlock = node("div");
  titleBlock.append(
    node("p", "eyebrow", `${item.institution || item.host || "Unassigned pages"} · ${item.pages.length} page(s)`),
    node("h2", "", item.facilityName || "Facility boundary unclear"),
  );
  const badge = node(
    "span",
    `recommendation${item.recommendedAction === "needs-review" ? " uncertain" : ""}`,
    actionLabel(item.recommendedAction),
  );
  heading.append(titleBlock, badge);
  reviewContent.append(heading);

  const rationale = node("div", "rationale");
  rationale.append(node("strong", "", "Gemini grouping rationale: "), document.createTextNode(item.rationale || "No rationale supplied."));
  reviewContent.append(rationale);

  if (item.uncertainties?.length) {
    const uncertainty = node("div", "ambiguity");
    uncertainty.append(node("strong", "", "Check carefully: "));
    uncertainty.append(document.createTextNode(item.uncertainties.join(" ")));
    reviewContent.append(uncertainty);
  }

  const pagesHeading = node("h3", "subheading", "Downloaded evidence");
  reviewContent.append(pagesHeading);
  const pageList = node("div", "page-list");
  for (const page of item.pages) {
    const card = node("article", "page-card");
    card.append(
      node("h4", "", page.title || page.savedFile || "Untitled page"),
      node("p", "", page.savedFile || "Saved HTML"),
    );
    const sourceRow = node("p");
    sourceRow.append(safeLink(page.sourceUrl || page.canonicalUrl, page.sourceUrl || page.canonicalUrl || "Source URL not found"));
    card.append(sourceRow);
    if (page.headings?.length) {
      card.append(node("p", "", `Headings: ${page.headings.slice(0, 10).join(" · ")}`));
    }
    if (page.emails?.length) {
      card.append(node("p", "", `Emails found: ${page.emails.join(", ")}`));
    }
    if (page.links?.length) {
      const links = node("p");
      links.append(document.createTextNode("Linked pages: "));
      page.links.slice(0, 10).forEach((link, index) => {
        if (index) links.append(document.createTextNode(" · "));
        links.append(safeLink(link.url, link.text || link.url));
      });
      card.append(links);
    }
    const details = node("details");
    details.append(node("summary", "", "Read extracted page text"));
    details.append(node("div", "page-excerpt", page.text || "No text could be extracted."));
    card.append(details);
    pageList.append(card);
  }
  reviewContent.append(pageList);

  const evidenceHeading = node("h3", "subheading", "Field-level evidence");
  reviewContent.append(evidenceHeading);
  const evidenceList = node("div", "evidence-list");
  if (item.evidence?.length) {
    for (const evidence of item.evidence) {
      const row = node("div", "evidence-row");
      row.append(
        node("span", "evidence-field", evidence.field || "Evidence"),
        safeLink(evidence.sourceUrl, "Open cited page"),
        node("blockquote", "", evidence.quote || "No exact quote supplied."),
      );
      evidenceList.append(row);
    }
  } else {
    evidenceList.append(node("p", "muted small", "No field-level quotations were returned. Confirm details directly against the page evidence."));
  }
  reviewContent.append(evidenceList);

  const editHeading = node("h3", "subheading", "Proposed facility record");
  reviewContent.append(editHeading);
  const form = node("form", "edit-card");
  form.addEventListener("submit", (event) => event.preventDefault());
  buildRecordEditor(form, item);
  const comparison = node("div", "comparison-grid");
  const proposedComparison = node("section", "comparison-card");
  proposedComparison.append(node("h4", "", "Proposed record"));
  const proposedSummary = node("div", "comparison-summary");
  renderComparisonRecord(proposedSummary, collectRecord(form));
  proposedComparison.append(proposedSummary);

  const existingComparison = node("section", "comparison-card");
  const existingHeading = node("h4", "", "Existing directory record");
  const existingSelectLabel = node("label", "", "Compare with");
  existingSelectLabel.htmlFor = "comparison-facility";
  const existingSelect = node("select");
  existingSelect.id = "comparison-facility";
  addOption(existingSelect, "", "Select an existing facility…");
  for (const facility of state.facilities) {
    addOption(existingSelect, facility.id, `${facility.name} — ${facility.institution}`);
  }
  existingSelect.value = state.comparisonFacilityId;
  const existingSummary = node("div", "comparison-summary");
  renderExistingComparison(existingSummary, existingSelect.value);
  existingSelect.addEventListener("change", () => {
    state.comparisonFacilityId = existingSelect.value;
    renderExistingComparison(existingSummary, existingSelect.value);
    const target = document.querySelector("#target-facility");
    if (target) target.value = existingSelect.value;
  });
  existingComparison.append(existingHeading, existingSelectLabel, existingSelect, existingSummary);
  comparison.append(proposedComparison, existingComparison);
  form.addEventListener("input", () => renderComparisonRecord(proposedSummary, collectRecord(form)));
  reviewContent.append(comparison);
  reviewContent.append(form);

  const actionHeading = node("h3", "subheading", "How should this proposal be handled?");
  reviewContent.append(actionHeading);
  const decision = node("div", "edit-card");
  buildDecisionControls(decision, item);
  reviewContent.append(decision);
}

function buildRecordEditor(form, item) {
  const record = item.record ?? {};
  const location = record.location ?? {};
  appendTextField(form, "Record ID", "record-id", record.id || "", "text");
  appendTextField(form, "Facility name", "record-name", record.name || item.facilityName || "", "text");
  appendTextField(form, "Institution", "record-institution", record.institution || item.institution || "", "text");
  appendTextField(form, "City", "record-city", location.city || "", "text");
  appendTextField(form, "Region / nation", "record-region", location.region || "", "text");
  appendTextField(form, "Country", "record-country", location.country || "United Kingdom", "text");
  appendTextField(form, "Access status", "record-access-status", record.access?.status || "unknown", "select", [
    ["unknown", "Unknown / verify"],
    ["external-and-internal", "Internal and external"],
    ["collaborative", "Collaborative"],
    ["public", "Public"],
  ]);
  appendTextField(form, "Access evidence", "record-access-evidence", record.access?.evidence || "", "text", null, true);

  const accessSource = record.access?.source || item.pages[0]?.sourceUrl || "";
  appendTextField(form, "Access source URL", "record-access-source", accessSource, "url", null, true);
  appendTextField(form, "Contact email", "record-contact-email", record.contact?.email || "", "email");
  appendTextField(form, "Contact name", "record-contact-name", record.contact?.name || "", "text");
  appendTextField(form, "Contact source URL", "record-contact-source", record.contact?.source || accessSource, "url");

  appendTextField(form, "Logo / image URL", "record-image-url", record.image?.url || "", "url", null, true);
  appendTextField(form, "Image alt text", "record-image-alt", record.image?.alt || "", "text");
  appendTextField(form, "Image permission note", "record-image-permission", record.image?.permission || "", "text");
  appendTextField(form, "Image source URL", "record-image-source", record.image?.source || accessSource, "url", null, true);

  const addressesSection = node("div", "form-field wide");
  const addressesLabel = node("label", "subsection-label", "Site addresses");
  addressesLabel.htmlFor = "addresses-list";
  const addresses = node("div", "address-list");
  addresses.id = "addresses-list";
  (location.addresses?.length ? location.addresses : [{ site: "", building: "", address: "" }])
    .forEach((address) => addresses.append(createAddressRow(address)));
  const addAddress = node("button", "secondary-button", "Add site address");
  addAddress.type = "button";
  addAddress.addEventListener("click", () => addresses.append(createAddressRow({ site: "", building: "", address: "" })));
  addressesSection.append(addressesLabel, addresses, addAddress);
  form.append(addressesSection);

  const techniquesSection = node("div", "form-field wide");
  const techniquesLabel = node("p", "subsection-label", "Techniques");
  const techniquesList = node("div", "taxonomy-list");
  techniquesList.dataset.field = "techniques";
  const selectedTechniques = new Set(record.techniques ?? []);
  for (const technique of state.taxonomy.techniques) {
    techniquesList.append(createTaxonomyCheckbox(technique.id, technique.label, selectedTechniques.has(technique.id)));
  }
  techniquesSection.append(techniquesLabel, techniquesList);
  form.append(techniquesSection);

  const instrumentsSection = node("div", "form-field wide");
  const instrumentsLabel = node("p", "subsection-label", "Instruments");
  const instruments = node("div", "instrument-list");
  instruments.dataset.field = "instruments";
  const initialInstruments = record.instruments?.length ? record.instruments : [];
  initialInstruments.forEach((instrument) => instruments.append(createInstrumentRow(instrument)));
  const addInstrument = node("button", "secondary-button", "Add instrument");
  addInstrument.type = "button";
  addInstrument.addEventListener("click", () => instruments.append(createInstrumentRow({})));
  instrumentsSection.append(instrumentsLabel, instruments, addInstrument);
  form.append(instrumentsSection);

  const sourcesSection = node("div", "form-field wide");
  const sourcesLabel = node("label", "subsection-label", "Source URLs (one per line)");
  sourcesLabel.htmlFor = "record-sources";
  const sources = node("textarea");
  sources.id = "record-sources";
  sources.dataset.field = "sources";
  sources.value = (record.sources ?? []).map(({ url }) => url).join("\n");
  sourcesSection.append(sourcesLabel, sources);
  form.append(sourcesSection);
}

function appendTextField(container, label, id, value, type, options = null, wide = false) {
  const field = node("div", `form-field${wide ? " wide" : ""}`);
  const elementLabel = node("label", "", label);
  elementLabel.htmlFor = id;
  let input;
  if (type === "select") {
    input = node("select");
    for (const [optionValue, optionLabel] of options ?? []) {
      const option = node("option", "", optionLabel);
      option.value = optionValue;
      option.selected = optionValue === value;
      input.append(option);
    }
  } else {
    input = node("input");
    input.type = type;
    input.value = value;
  }
  input.id = id;
  input.dataset.field = id.replace(/^record-/, "");
  field.append(elementLabel, input);
  container.append(field);
  return input;
}

function createAddressRow(address) {
  const row = node("div", "address-row");
  row.dataset.rowType = "address";
  const grid = node("div", "address-row-grid");
  grid.append(
    rowInput("Site label", "site", address.site || ""),
    rowInput("Building", "building", address.building || ""),
    rowInput("Full address", "address", address.address || "", true),
  );
  const actions = node("div", "row-actions");
  actions.append(removeRowButton(row, "Remove address"));
  row.append(grid, actions);
  return row;
}

function createInstrumentRow(instrument) {
  const row = node("div", "instrument-row");
  row.dataset.rowType = "instrument";
  const fields = node("div", "instrument-fields");
  fields.append(
    rowInput("Instrument name", "name", instrument.name || ""),
    rowInput("Manufacturer", "manufacturer", instrument.manufacturer || ""),
    rowInput("Model", "model", instrument.model || ""),
  );
  const typeField = node("div", "form-field");
  typeField.append(node("label", "", "Instrument type"));
  const typeSelect = node("select");
  typeSelect.dataset.key = "type";
  addOption(typeSelect, "unknown", "Unknown");
  for (const type of state.taxonomy.instrumentTypes) addOption(typeSelect, type.id, type.label);
  typeSelect.value = instrument.type || "unknown";
  typeField.append(typeSelect);
  fields.append(typeField);

  const statusField = node("div", "form-field");
  statusField.append(node("label", "", "Status"));
  const statusSelect = node("select");
  statusSelect.dataset.key = "status";
  addOption(statusSelect, "", "Unknown");
  addOption(statusSelect, "active", "Active");
  addOption(statusSelect, "planned", "Planned");
  addOption(statusSelect, "retired", "Retired");
  statusSelect.value = instrument.status || "";
  statusField.append(statusSelect);
  fields.append(statusField);

  const techniqueField = node("div", "form-field wide");
  techniqueField.append(node("label", "", "Instrument techniques"));
  const selected = new Set(instrument.techniques ?? []);
  const checks = node("div", "taxonomy-list");
  checks.dataset.field = "instrument-techniques";
  for (const technique of state.taxonomy.techniques) {
    checks.append(createTaxonomyCheckbox(technique.id, technique.label, selected.has(technique.id), "techniques"));
  }
  techniqueField.append(checks);
  fields.append(techniqueField);

  fields.append(rowInput("Where located", "locationDetails", instrument.locationDetails || "", true));
  fields.append(rowInput("Evidence note", "evidence", instrument.evidence || "", true));
  fields.append(rowInput("Instrument source URL", "source", instrument.source || "", true, "url"));
  const actions = node("div", "row-actions");
  actions.append(removeRowButton(row, "Remove instrument"));
  row.append(fields, actions);
  return row;
}

function rowInput(label, key, value, wide = false, type = "text") {
  const field = node("div", `form-field${wide ? " wide" : ""}`);
  field.append(node("label", "", label));
  const input = node("input");
  input.type = type;
  input.value = value;
  input.dataset.key = key;
  field.append(input);
  return field;
}

function createTaxonomyCheckbox(id, label, checked, field = "techniques") {
  const wrapper = node("label", "taxonomy-option");
  const input = node("input");
  input.type = "checkbox";
  input.value = id;
  input.checked = checked;
  input.dataset.field = field;
  wrapper.append(input, document.createTextNode(label));
  return wrapper;
}

function removeRowButton(row, text) {
  const button = node("button", "remove-row", text);
  button.type = "button";
  button.addEventListener("click", () => row.remove());
  return button;
}

function addOption(select, value, label) {
  const option = node("option", "", label);
  option.value = value;
  select.append(option);
}

function buildDecisionControls(container, item) {
  const formGrid = node("div", "form-grid");
  const actionField = node("div", "form-field");
  const actionLabelElement = node("label", "", "Apply proposal as");
  actionLabelElement.htmlFor = "decision-action";
  const action = node("select");
  action.id = "decision-action";
  addOption(action, "add", "Add a new facility");
  addOption(action, "update", "Merge into an existing facility");
  action.value = item.matchFacilityId ? "update" : item.recommendedAction === "update" ? "update" : "add";
  actionField.append(actionLabelElement, action);

  const targetField = node("div", "form-field");
  const targetLabel = node("label", "", "Existing facility");
  targetLabel.htmlFor = "target-facility";
  const target = node("select");
  target.id = "target-facility";
  addOption(target, "", "Select existing facility…");
  for (const facility of state.facilities) {
    addOption(target, facility.id, `${facility.name} — ${facility.institution}`);
  }
  target.value = state.comparisonFacilityId;
  target.addEventListener("change", () => {
    state.comparisonFacilityId = target.value;
    const comparisonSelect = document.querySelector("#comparison-facility");
    if (comparisonSelect) {
      comparisonSelect.value = target.value;
      const summary = comparisonSelect.parentElement.querySelector(".comparison-summary");
      renderExistingComparison(summary, target.value);
    }
  });
  targetField.append(targetLabel, target);
  action.addEventListener("change", () => {
    targetField.hidden = action.value !== "update";
  });
  targetField.hidden = action.value !== "update";
  formGrid.append(actionField, targetField);

  const noteLabel = node("label", "form-field wide");
  noteLabel.htmlFor = "decline-note";
  noteLabel.append(node("span", "subsection-label", "Decision note (optional)"));
  const note = node("textarea");
  note.id = "decline-note";
  note.placeholder = "Why is this being declined or deferred?";
  noteLabel.append(note);
  formGrid.append(noteLabel);

  const actions = node("div", "actions");
  const accept = node("button", "accept-button", "Accept and write to facilities.json");
  accept.type = "button";
  accept.addEventListener("click", async () => {
    const targetFacilityId = target.value;
    if (action.value === "update" && !targetFacilityId) {
      showNotice("Select the existing facility to merge this proposal into.", true);
      target.focus();
      return;
    }
    accept.disabled = true;
    try {
      const result = await requestJson(`/api/items/${item.id}/decision`, {
        method: "POST",
        body: JSON.stringify({
          decision: "accept",
          action: action.value,
          targetFacilityId,
          record: collectRecord(container.closest(".review-panel")),
        }),
      });
      showNotice(result.message);
      await refreshState({ keepSelection: false });
    } catch (error) {
      showNotice(error.message, true);
    } finally {
      accept.disabled = false;
    }
  });

  const decline = node("button", "decline-button", "Decline / mark checked");
  decline.type = "button";
  decline.addEventListener("click", async () => {
    if (!window.confirm("Decline this proposal and move it out of the pending queue?")) return;
    decline.disabled = true;
    try {
      const result = await requestJson(`/api/items/${item.id}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: "decline", note: note.value }),
      });
      showNotice(result.message);
      await refreshState({ keepSelection: false });
    } catch (error) {
      showNotice(error.message, true);
    } finally {
      decline.disabled = false;
    }
  });

  actions.append(accept, decline);
  container.append(formGrid, actions);
}

function renderExistingComparison(container, facilityId) {
  const facility = state.facilities.find(({ id }) => id === facilityId);
  renderComparisonRecord(container, facility);
}

function renderComparisonRecord(container, record) {
  container.replaceChildren();
  if (!record) {
    container.append(node("p", "muted small", "Select an existing facility to compare, or choose Add a new facility below."));
    return;
  }

  const location = record.location ?? {};
  const addresses = (location.addresses ?? [])
    .map(({ site, address }) => [site, address].filter(Boolean).join(": "))
    .filter(Boolean);
  const instruments = (record.instruments ?? [])
    .map(({ name, model }) => [name, model].filter(Boolean).join(" — "))
    .filter(Boolean);
  const sources = (record.sources ?? []).map(({ url }) => url).filter(Boolean);
  const fields = [
    ["Facility name", record.name],
    ["Institution", record.institution],
    ["Location", [location.city, location.region, location.country].filter(Boolean).join(", ")],
    ["Site addresses", addresses.join("; ")],
    ["Access", record.access?.status],
    ["Contact", record.contact?.email],
    ["Techniques", (record.techniques ?? []).map((id) =>
      state.taxonomy.techniques.find((technique) => technique.id === id)?.label ?? id).join(", ")],
    ["Instruments", instruments.join(", ")],
    ["Sources", sources.join("\n")],
  ];
  for (const [label, value] of fields) {
    if (!value) continue;
    const row = node("div", "comparison-row");
    row.append(node("strong", "", `${label}:`), node("span", "", value));
    container.append(row);
  }
}

function collectRecord(container) {
  const value = (id) => container.querySelector(`#${id}`)?.value.trim() ?? "";
  const addresses = [...container.querySelectorAll(".address-row")].map((row) => ({
    site: row.querySelector('[data-key="site"]').value.trim(),
    building: row.querySelector('[data-key="building"]').value.trim(),
    address: row.querySelector('[data-key="address"]').value.trim(),
  })).filter((address) => address.site || address.address);

  const instruments = [...container.querySelectorAll(".instrument-row")].map((row) => {
    const instrument = {};
    for (const input of row.querySelectorAll("[data-key]")) {
      instrument[input.dataset.key] = input.value.trim();
    }
    instrument.techniques = [...row.querySelectorAll('input[data-field="techniques"]:checked')].map(({ value: id }) => id);
    if (!instrument.manufacturer) instrument.manufacturer = null;
    if (!instrument.model) instrument.model = null;
    if (!instrument.locationDetails) delete instrument.locationDetails;
    if (!instrument.status) delete instrument.status;
    return instrument;
  }).filter((instrument) => instrument.name || instrument.model);

  const techniques = [...container.querySelectorAll('.taxonomy-list[data-field="techniques"] input:checked')].map(({ value: id }) => id);
  const sourceUrls = [...new Set(value("record-sources").split(/\r?\n/).map((url) => url.trim()).filter(Boolean))];
  const sourceChecked = new Date().toISOString().slice(0, 10);
  const record = {
    id: value("record-id"),
    name: value("record-name"),
    institution: value("record-institution"),
    location: {
      city: value("record-city"),
      region: value("record-region"),
      country: value("record-country"),
      addresses,
    },
    access: {
      status: value("record-access-status"),
      evidence: value("record-access-evidence"),
      source: value("record-access-source"),
    },
    techniques,
    instruments,
    sources: sourceUrls.map((url) => ({ url, checked: sourceChecked, notes: "" })),
    lastChecked: sourceChecked,
  };

  const email = value("record-contact-email");
  if (email) {
    record.contact = {
      email,
      name: value("record-contact-name") || null,
      source: value("record-contact-source"),
    };
  }
  const imageUrl = value("record-image-url");
  if (imageUrl) {
    record.image = {
      url: imageUrl,
      alt: value("record-image-alt"),
      permission: value("record-image-permission"),
      source: value("record-image-source"),
    };
  }
  return record;
}

function actionLabel(action) {
  if (action === "update") return "Possible update / merge";
  if (action === "add") return "Possible new facility";
  return "Needs curator decision";
}

scanButton.addEventListener("click", async () => {
  scanButton.disabled = true;
  scanButton.textContent = "Scanning…";
  clearNotice();
  try {
    const result = await requestJson("/api/scan", {
      method: "POST",
      body: JSON.stringify({}),
    });
    showNotice(result.message);
    await refreshState({ keepSelection: false });
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    scanButton.disabled = false;
    scanButton.textContent = "Scan downloaded HTML";
  }
});

keyProfile.addEventListener("change", async () => {
  try {
    await requestJson("/api/profile", {
      method: "POST",
      body: JSON.stringify({ profile: keyProfile.value }),
    });
    showNotice(`Using the ${keyProfile.value} Gemini key.`);
  } catch (error) {
    showNotice(error.message, true);
  }
});

refreshState().catch((error) => {
  showNotice(error.message, true);
});
