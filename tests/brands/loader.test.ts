import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  formatBrandContext,
  loadBrandImages,
  loadBrandProfile,
} from "../../src/brands/loader.js";
import { brandsDir } from "../../src/utils/paths.js";
import { ConfigError } from "../../src/utils/errors.js";

let tempHome: string;
const originalHome = process.env["ADARIA_HOME"];

beforeEach(async () => {
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "adaria-brand-"));
  process.env["ADARIA_HOME"] = tempHome;
});

afterEach(async () => {
  await fs.rm(tempHome, { recursive: true, force: true });
  if (originalHome === undefined) {
    delete process.env["ADARIA_HOME"];
  } else {
    process.env["ADARIA_HOME"] = originalHome;
  }
});

async function writeBrandYaml(
  serviceId: string,
  content: string
): Promise<void> {
  const dir = path.join(tempHome, "brands", serviceId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "brand.yaml"), content, "utf-8");
}

async function writeBrandImage(
  serviceId: string,
  filename: string,
  bytes: Buffer
): Promise<void> {
  const dir = path.join(tempHome, "brands", serviceId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), bytes);
}

describe("brandsDir", () => {
  it("returns the root brands dir under ADARIA_HOME", () => {
    expect(brandsDir()).toBe(path.join(tempHome, "brands"));
  });

  it("joins a safe serviceId under the brands root", () => {
    expect(brandsDir("fridgify")).toBe(
      path.join(tempHome, "brands", "fridgify")
    );
  });

  it("rejects serviceIds containing path separators", () => {
    expect(() => brandsDir("../evil")).toThrow(/invalid serviceId/);
    expect(() => brandsDir("a/b")).toThrow(/invalid serviceId/);
    expect(() => brandsDir("a\\b")).toThrow(/invalid serviceId/);
    expect(() => brandsDir(".")).toThrow(/invalid serviceId/);
    expect(() => brandsDir("..")).toThrow(/invalid serviceId/);
  });

  it("rejects serviceIds with control chars (NUL, newline, tab)", () => {
    expect(() => brandsDir("a\0b")).toThrow(/invalid serviceId/);
    expect(() => brandsDir("a\nb")).toThrow(/invalid serviceId/);
    expect(() => brandsDir("a\tb")).toThrow(/invalid serviceId/);
  });

  it("rejects serviceIds with spaces or unicode", () => {
    expect(() => brandsDir("a b")).toThrow(/invalid serviceId/);
    expect(() => brandsDir("앱")).toThrow(/invalid serviceId/);
  });

  it("rejects an empty serviceId", () => {
    expect(() => brandsDir("")).toThrow();
  });

  it("accepts alphanumeric serviceIds with dot/underscore/hyphen", () => {
    expect(() => brandsDir("fridgify")).not.toThrow();
    expect(() => brandsDir("my-app_v2.0")).not.toThrow();
  });
});

describe("loadBrandProfile", () => {
  it("returns null when brand.yaml does not exist", async () => {
    const profile = await loadBrandProfile("fridgify");
    expect(profile).toBeNull();
  });

  it("loads a valid brand.yaml and fills defaults", async () => {
    await writeBrandYaml(
      "fridgify",
      `
_meta:
  serviceType: app
  generatedAt: "2026-04-15T08:00:00Z"
  sources: [appstore, playstore]
  identifiers:
    appstoreId: "123"
identity:
  tagline: Never waste food again
  category: Food & Drink
voice:
  tone: friendly, casual
  do:
    - use simple language
  dont:
    - be preachy
audience:
  primary: Young professionals
  painPoints: [forgetting food]
`
    );

    const profile = await loadBrandProfile("fridgify");
    expect(profile).not.toBeNull();
    expect(profile?._meta.serviceType).toBe("app");
    expect(profile?._meta.identifiers["appstoreId"]).toBe("123");
    expect(profile?.identity.tagline).toBe("Never waste food again");
    expect(profile?.voice.do).toEqual(["use simple language"]);
    expect(profile?.visual.style).toBe("");
    expect(profile?.goals.keyMetrics).toEqual([]);
  });

  it("throws ConfigError when schema is invalid", async () => {
    await writeBrandYaml(
      "bad",
      `
_meta:
  serviceType: mainframe
  generatedAt: ""
`
    );
    await expect(loadBrandProfile("bad")).rejects.toBeInstanceOf(ConfigError);
  });

  it("throws ConfigError when YAML is malformed", async () => {
    await writeBrandYaml("malformed", "identity:\n  tagline: \"unterminated");
    await expect(loadBrandProfile("malformed")).rejects.toBeInstanceOf(
      ConfigError
    );
  });

  it("throws ConfigError when _meta is missing", async () => {
    await writeBrandYaml(
      "bad",
      `
identity:
  tagline: Hello
`
    );
    await expect(loadBrandProfile("bad")).rejects.toBeInstanceOf(ConfigError);
  });
});

describe("formatBrandContext", () => {
  it("returns empty string for null profile", () => {
    expect(formatBrandContext(null)).toBe("");
  });

  it("renders populated sections only", async () => {
    await writeBrandYaml(
      "fridgify",
      `
_meta:
  serviceType: app
  generatedAt: "2026-04-15T08:00:00Z"
identity:
  tagline: Never waste food again
  positioning: Simple fridge management
voice:
  tone: friendly
  do: [be encouraging]
audience:
  primary: Young professionals
competitors:
  differentiation: Photo-based entry
`
    );
    const profile = await loadBrandProfile("fridgify");
    const out = formatBrandContext(profile);

    expect(out).toContain("Identity:");
    expect(out).toContain("Tagline: Never waste food again");
    expect(out).toContain("Voice:");
    expect(out).toContain("Audience:");
    expect(out).toContain("Competitors:");
    expect(out).toContain("Differentiation: Photo-based entry");
    expect(out).not.toContain("Visual:");
  });

  it("omits sections that are entirely empty", async () => {
    await writeBrandYaml(
      "minimal",
      `
_meta:
  serviceType: web
  generatedAt: "2026-04-15T08:00:00Z"
`
    );
    const profile = await loadBrandProfile("minimal");
    expect(formatBrandContext(profile)).toBe("");
  });
});

describe("loadBrandImages", () => {
  it("returns empty array when directory does not exist", async () => {
    const images = await loadBrandImages("ghost", ["logo"]);
    expect(images).toEqual([]);
  });

  it("loads logo png when present", async () => {
    await writeBrandImage(
      "fridgify",
      "logo.png",
      Buffer.from([0x89, 0x50, 0x4e, 0x47])
    );
    const images = await loadBrandImages("fridgify", ["logo"]);
    expect(images).toHaveLength(1);
    expect(images[0]?.kind).toBe("logo");
    expect(images[0]?.mediaType).toBe("image/png");
    expect(Buffer.from(images[0]!.data, "base64")).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47])
    );
  });

  it.each([
    ["logo.jpg", "image/jpeg"],
    ["logo.jpeg", "image/jpeg"],
    ["logo.webp", "image/webp"],
  ])("recognises %s as %s", async (filename, mime) => {
    await writeBrandImage("fridgify", filename, Buffer.from("x"));
    const [img] = await loadBrandImages("fridgify", ["logo"]);
    expect(img?.mediaType).toBe(mime);
  });

  it("loads logo and design-system together", async () => {
    await writeBrandImage("fridgify", "logo.png", Buffer.from("L"));
    await writeBrandImage("fridgify", "design-system.webp", Buffer.from("D"));
    const images = await loadBrandImages("fridgify", [
      "logo",
      "design-system",
    ]);
    expect(images.map((i) => i.kind)).toEqual(["logo", "design-system"]);
  });

  it("rejects symlinks posing as brand images", async () => {
    const dir = path.join(tempHome, "brands", "fridgify");
    await fs.mkdir(dir, { recursive: true });
    const outside = path.join(tempHome, "secret.png");
    await fs.writeFile(outside, Buffer.from("SECRET"));
    await fs.symlink(outside, path.join(dir, "logo.png"));
    const images = await loadBrandImages("fridgify", ["logo"]);
    expect(images).toEqual([]);
  });

  it("skips images with unsupported extensions", async () => {
    await writeBrandImage("fridgify", "logo.gif", Buffer.from("G"));
    const images = await loadBrandImages("fridgify", ["logo"]);
    expect(images).toEqual([]);
  });

  it("returns only the kinds requested", async () => {
    await writeBrandImage("fridgify", "logo.png", Buffer.from("L"));
    await writeBrandImage("fridgify", "design-system.png", Buffer.from("D"));
    const images = await loadBrandImages("fridgify", ["logo"]);
    expect(images).toHaveLength(1);
    expect(images[0]?.kind).toBe("logo");
  });
});
