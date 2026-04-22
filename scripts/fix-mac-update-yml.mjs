import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const watcherDir = path.resolve(__dirname, "..");
const packagePath = path.join(watcherDir, "package.json");
const updateYmlPath = path.join(watcherDir, "dist", "latest-mac.yml");

const packageJson = JSON.parse(await fs.readFile(packagePath, "utf8"));
const version = packageJson.version;
const expectedName = `AoE2DEWarWagers Watcher-${version}-arm64.dmg`;
const sanitizedName = `AoE2DEWarWagers-Watcher-${version}-arm64.dmg`;

let updateYml = await fs.readFile(updateYmlPath, "utf8");
updateYml = updateYml.replaceAll(sanitizedName, expectedName);

await fs.writeFile(updateYmlPath, updateYml);
process.stdout.write(`Normalized latest-mac.yml -> ${expectedName}\n`);
