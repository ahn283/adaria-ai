import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadApps } from "../../src/config/load-apps.js";
import { ConfigError } from "../../src/utils/errors.js";

async function writeTempFile(content: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "adaria-apps-"));
  const file = path.join(dir, "apps.yaml");
  await fs.writeFile(file, content, "utf-8");
  return file;
}

describe("loadApps", () => {
  let tempFile: string | null = null;

  beforeEach(() => {
    tempFile = null;
  });

  afterEach(async () => {
    if (tempFile) {
      await fs.rm(path.dirname(tempFile), { recursive: true, force: true });
      tempFile = null;
    }
  });

  it("loads a valid apps.yaml and fills defaults", async () => {
    tempFile = await writeTempFile(`
apps:
  - id: fridgify
    name: Fridgify
    platform: [ios, android]
    appStoreId: "123"
    playStorePackage: com.eodin.fridgify
    features:
      fridgifyRecipes: true
`);

    const { apps } = await loadApps({ path: tempFile });
    expect(apps).toHaveLength(1);
    expect(apps[0]?.id).toBe("fridgify");
    expect(apps[0]?.features.fridgifyRecipes).toBe(true);
    // Defaults applied:
    expect(apps[0]?.active).toBe(true);
    expect(apps[0]?.primaryKeywords).toEqual([]);
    expect(apps[0]?.competitors).toEqual([]);
    expect(apps[0]?.locale).toEqual([]);
  });

  it("filters out inactive apps by default", async () => {
    tempFile = await writeTempFile(`
apps:
  - id: live
    name: Live
    platform: [ios]
    active: true
  - id: dead
    name: Dead
    platform: [ios]
    active: false
`);

    const { apps } = await loadApps({ path: tempFile });
    expect(apps.map((a) => a.id)).toEqual(["live"]);
  });

  it("includes inactive apps when requested", async () => {
    tempFile = await writeTempFile(`
apps:
  - id: live
    name: Live
    platform: [ios]
    active: true
  - id: dead
    name: Dead
    platform: [ios]
    active: false
`);

    const { apps } = await loadApps({ path: tempFile, includeInactive: true });
    expect(apps.map((a) => a.id)).toEqual(["live", "dead"]);
  });

  it("throws ConfigError if the file is missing", async () => {
    const missing = path.join(os.tmpdir(), "definitely-not-here.yaml");
    await expect(loadApps({ path: missing })).rejects.toBeInstanceOf(
      ConfigError
    );
  });

  it("throws ConfigError when the apps array is empty", async () => {
    tempFile = await writeTempFile("apps: []\n");
    await expect(loadApps({ path: tempFile })).rejects.toBeInstanceOf(
      ConfigError
    );
  });

  it("rejects an invalid platform", async () => {
    tempFile = await writeTempFile(`
apps:
  - id: bad
    name: Bad
    platform: [windows]
`);
    await expect(loadApps({ path: tempFile })).rejects.toBeInstanceOf(
      ConfigError
    );
  });

  it("rejects an app missing id", async () => {
    tempFile = await writeTempFile(`
apps:
  - name: Nameless
    platform: [ios]
`);
    await expect(loadApps({ path: tempFile })).rejects.toBeInstanceOf(
      ConfigError
    );
  });
});
