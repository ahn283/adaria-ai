import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { deriveServicePrefix } from "../../src/config/keychain.js";

describe("deriveServicePrefix", () => {
  it("returns the default prefix for the canonical production home", () => {
    expect(deriveServicePrefix(path.join(os.homedir(), ".adaria"))).toBe(
      "adaria-ai"
    );
  });

  it("namespaces a dev profile to adaria-ai-dev", () => {
    expect(deriveServicePrefix(path.join(os.homedir(), ".adaria-dev"))).toBe(
      "adaria-ai-dev"
    );
  });

  it("namespaces a staging profile", () => {
    expect(
      deriveServicePrefix(path.join(os.homedir(), ".adaria-staging"))
    ).toBe("adaria-ai-staging");
  });

  it("handles a custom, non-dot-prefixed home", () => {
    expect(deriveServicePrefix("/tmp/project-sandbox")).toBe(
      "adaria-ai-project-sandbox"
    );
  });

  it("collapses redundant `adaria` prefixes in the user's home name", () => {
    // `~/adaria-ai` → trimming `adaria-` leaves `ai` which we reject,
    // so we stay on the default prefix.
    expect(deriveServicePrefix(path.join(os.homedir(), "adaria-ai"))).toBe(
      "adaria-ai"
    );
    expect(deriveServicePrefix(path.join(os.homedir(), "adaria_test"))).toBe(
      "adaria-ai-test"
    );
  });

  it("slugifies unusual characters in the basename", () => {
    expect(deriveServicePrefix("/tmp/My Adaria Test!")).toBe(
      "adaria-ai-my-adaria-test-"
    );
  });

  it("falls back to the default prefix when the slug is empty", () => {
    expect(deriveServicePrefix("/")).toBe("adaria-ai");
  });
});
