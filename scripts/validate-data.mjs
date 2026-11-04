import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { validateFacilityCollection } from "./lib/facility-validation.mjs";

const root = new URL("../data/", import.meta.url);
const facilities = JSON.parse((await readFile(new URL("facilities.json", root), "utf8")).replace(/^\uFEFF/, ""));
const taxonomy = JSON.parse((await readFile(new URL("taxonomy.json", root), "utf8")).replace(/^\uFEFF/, ""));

validateFacilityCollection(facilities, taxonomy);
console.log(`Validated ${facilities.length} verified facility records.`);
