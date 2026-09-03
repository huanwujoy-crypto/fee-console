// Local use-time guard, not proof of remote Gist authority or freshness.
// The caller must still acquire/re-read the authorized source revision remotely.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertLegacyCopyAuthenticity } from "./fee-econ-v3-copy.mjs";

const MAX_BYTES = 5 * 1024 * 1024;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fail = () => { throw new Error("legacy source is unavailable, changed, or unsupported"); };

/** Authenticates the copy and returns a required pre-output recheck. No writes. */
export function guardLegacySourceFile(economicInput, key, sourcePath = process.env.FEE_ECON_V3_FILE) {
  assertLegacyCopyAuthenticity(economicInput, key);
  const provenance = economicInput?.legacyV3Copy;
  if (!provenance || provenance.schema !== "fee-console.economic-v3-copy.v2") return () => {};
  if (typeof sourcePath !== "string" || !path.isAbsolute(sourcePath)) fail();
  const expected = Buffer.from(provenance.sourceEnvelopeBase64, "base64");
  let originalPath;
  const verify = () => {
    try {
      const target = fs.realpathSync(sourcePath);
      const relative = path.relative(repoRoot, target);
      if (relative !== ".." && !relative.startsWith(".." + path.sep)) fail();
      if (originalPath && target !== originalPath) fail();
      const stat = fs.statSync(target);
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_BYTES) fail();
      const first = fs.readFileSync(target), second = fs.readFileSync(target);
      if (!first.equals(second) || !first.equals(expected)) fail();
      originalPath = target;
    } catch { fail(); }
  };
  verify();
  return verify;
}
