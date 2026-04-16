import { describe, expect, it } from "vitest";

import {
  ALL_LABELS,
  renderPlistForTest,
} from "../../src/cli/start.js";

describe("renderPlist — ADARIA_DRY_RUN injection", () => {
  it.each(ALL_LABELS)(
    "%s: omits ADARIA_DRY_RUN when --dry-run is not set",
    async (label) => {
      const xml = await renderPlistForTest(label);
      expect(xml).not.toContain("ADARIA_DRY_RUN");
      // Sanity — the existing ADARIA_HOME anchor is intact.
      expect(xml).toContain("<key>ADARIA_HOME</key>");
    },
  );

  it.each(ALL_LABELS)(
    "%s: injects ADARIA_DRY_RUN=1 in EnvironmentVariables when --dry-run is set",
    async (label) => {
      const xml = await renderPlistForTest(label, { dryRun: true });
      expect(xml).toContain("<key>ADARIA_DRY_RUN</key>");
      expect(xml).toMatch(
        /<key>ADARIA_DRY_RUN<\/key>\s*<string>1<\/string>/,
      );
      // Injection lands inside the EnvironmentVariables block, not at
      // the top level — both keys belong to the same parent <dict>.
      const envIdx = xml.indexOf("<key>EnvironmentVariables</key>");
      const dryRunIdx = xml.indexOf("<key>ADARIA_DRY_RUN</key>");
      const homeIdx = xml.indexOf("<key>ADARIA_HOME</key>");
      expect(envIdx).toBeGreaterThan(-1);
      expect(dryRunIdx).toBeGreaterThan(envIdx);
      expect(homeIdx).toBeGreaterThan(dryRunIdx);
    },
  );

  it("substitutes the standard placeholders even with dry-run", async () => {
    const xml = await renderPlistForTest("com.adaria-ai.daemon", {
      dryRun: true,
    });
    expect(xml).not.toContain("__NODE_BIN__");
    expect(xml).not.toContain("__SCRIPT_PATH__");
    expect(xml).not.toContain("__ADARIA_HOME__");
    expect(xml).not.toContain("__LOG_DIR__");
    expect(xml).not.toContain("__PATH__");
  });
});
