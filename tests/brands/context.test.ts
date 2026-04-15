import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveBrandContextForApp } from "../../src/brands/context.js";
import { preparePrompt } from "../../src/prompts/loader.js";

let tempHome: string;
const originalHome = process.env["ADARIA_HOME"];

beforeEach(async () => {
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "adaria-brand-ctx-"));
  process.env["ADARIA_HOME"] = tempHome;
});

afterEach(async () => {
  await fs.rm(tempHome, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env["ADARIA_HOME"];
  else process.env["ADARIA_HOME"] = originalHome;
});

describe("resolveBrandContextForApp", () => {
  it("returns empty string when no brand.yaml exists", async () => {
    const ctx = await resolveBrandContextForApp("ghost-app");
    expect(ctx).toBe("");
  });

  it("renders identity/voice/audience when brand.yaml present", async () => {
    const dir = path.join(tempHome, "brands", "fridgify");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "brand.yaml"),
      `
_meta:
  serviceType: app
  generatedAt: "2026-04-15T00:00:00Z"
identity:
  tagline: Never waste food
  positioning: Simplest fridge tracker
voice:
  tone: friendly, casual
audience:
  primary: Young professionals
competitors:
  differentiation: Photo-based entry
`,
    );
    const ctx = await resolveBrandContextForApp("fridgify");
    expect(ctx).toContain("Tagline: Never waste food");
    expect(ctx).toContain("Tone: friendly, casual");
    expect(ctx).toContain("Differentiation: Photo-based entry");
  });

  it("swallows invalid brand.yaml and returns empty string", async () => {
    const dir = path.join(tempHome, "brands", "bad");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "brand.yaml"), "not: valid: yaml: {[");
    const ctx = await resolveBrandContextForApp("bad");
    expect(ctx).toBe("");
  });
});

describe("preparePrompt — brand context threading", () => {
  it("falls back to empty string when brandContext is missing", () => {
    const rendered = preparePrompt("review-sentiment", {
      reviewsBlock: "<review index=\"1\" rating=\"4\">nice</review>",
    });
    // The appended brand context section exists but renders empty.
    expect(rendered).toContain("## Brand context");
    expect(rendered).not.toContain("{{brandContext}}");
  });

  it("substitutes provided brandContext", () => {
    const rendered = preparePrompt("review-sentiment", {
      reviewsBlock: "<review index=\"1\" rating=\"4\">nice</review>",
      brandContext: "Identity:\n  Tagline: Never waste food",
    });
    expect(rendered).toContain("Tagline: Never waste food");
    expect(rendered).not.toContain("{{brandContext}}");
  });
});
