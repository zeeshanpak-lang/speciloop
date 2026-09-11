import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const output = fileURLToPath(new URL("../dist/", import.meta.url));

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(`${projectRoot}index.html`, `${output}index.html`);
await cp(`${projectRoot}demo-labels.html`, `${output}demo-labels.html`);
await cp(`${projectRoot}src`, `${output}src`, {
  recursive: true,
  filter: (source) => !source.endsWith(".test.js"),
});
console.log("Built dependency-free app in dist/");
