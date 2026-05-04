import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const FILES = ["main.js", "styles.css"];

const checksums = Object.fromEntries(
  FILES.map((f) => [f, createHash("sha256").update(readFileSync(f)).digest("hex")])
);

writeFileSync("checksums.json", JSON.stringify(checksums, null, 2) + "\n");

for (const [f, h] of Object.entries(checksums)) {
  console.log(`  ${f}: ${h}`);
}
console.log("checksums.json updated.");
