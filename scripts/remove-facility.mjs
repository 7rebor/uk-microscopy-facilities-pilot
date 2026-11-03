import { readFile, writeFile } from "node:fs/promises";

const args = process.argv.slice(2);

function parseArgs(argv) {
  const parsed = { id: null, name: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--id") {
      parsed.id = argv[i + 1]?.trim();
      i += 1;
    } else if (arg === "--name") {
      parsed.name = argv[i + 1]?.trim();
      i += 1;
    } else if (!arg.startsWith("-")) {
      if (!parsed.name) parsed.name = arg.trim();
    }
  }
  return parsed;
}

const { id, name } = parseArgs(args);
const target = id || name;

if (!target) {
  console.error("Usage: node scripts/remove-facility.mjs --id <internal-id>");
  console.error("       node scripts/remove-facility.mjs --name \"Facility Name\"");
  console.error("       node scripts/remove-facility.mjs \"Facility Name\"");
  console.error("Example: node scripts/remove-facility.mjs --id edinburgh-bioimaging");
  console.error("Example: node scripts/remove-facility.mjs \"Edinburgh Bioimaging\"");
  process.exit(1);
}

const dataPath = new URL("../data/facilities.json", import.meta.url);
const facilities = JSON.parse(await readFile(dataPath, "utf8"));
const beforeCount = facilities.length;
const nextFacilities = facilities.filter((facility) => {
  if (id) return facility.id !== id;
  return facility.name.toLowerCase() !== target.toLowerCase();
});

if (nextFacilities.length === beforeCount) {
  const selector = id ? `internal ID "${id}"` : `name "${target}"`;
  console.error(`No facility matching ${selector} was found in data/facilities.json.`);
  process.exit(1);
}

await writeFile(dataPath, `${JSON.stringify(nextFacilities, null, 2)}\n`, "utf8");
const removedLabel = id ? `internal ID "${id}"` : `name "${target}"`;
console.log(`Removed facility matching ${removedLabel} from data/facilities.json (${beforeCount - nextFacilities.length} record removed).`);
