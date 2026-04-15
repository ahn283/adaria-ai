import { describe, expect, it } from "vitest";

import {
  __test__,
  nextState,
  startBrandFlow,
  type BrandFlowData,
  type BrandFlowState,
} from "../../src/brands/flow.js";

function advance(
  state: BrandFlowState,
  data: BrandFlowData,
  text: string,
  fileAttached?: boolean
) {
  const ev: { text: string; fileAttached?: boolean } = { text };
  if (fileAttached !== undefined) ev.fileAttached = fileAttached;
  return nextState(state, data, ev);
}

describe("startBrandFlow", () => {
  it("returns ASK_TYPE prompt", () => {
    const t = startBrandFlow();
    expect(t.state).toBe("ASK_TYPE");
    expect(t.terminal).toBe(false);
    expect(t.reply).toContain("app");
  });
});

describe("ASK_TYPE → ASK_IDENTIFIER", () => {
  it.each([
    ["app", "app"],
    ["App", "app"],
    ["앱", "app"],
    ["web", "web"],
    ["웹", "web"],
    ["package", "package"],
    ["npm", "package"],
    ["패키지", "package"],
  ])("parses %s → %s", (input, expected) => {
    const t = advance("ASK_TYPE", {}, input);
    expect(t.state).toBe("ASK_IDENTIFIER");
    expect(t.data.serviceType).toBe(expected);
  });

  it("rejects unknown type", () => {
    const t = advance("ASK_TYPE", {}, "xylophone");
    expect(t.state).toBe("ASK_TYPE");
    expect(t.reply).toContain("app");
  });
});

describe("ASK_IDENTIFIER — app", () => {
  const base: BrandFlowData = { serviceType: "app" };

  it("parses App Store URL", () => {
    const t = advance(
      "ASK_IDENTIFIER",
      base,
      "https://apps.apple.com/us/app/fridgify/id123456789"
    );
    expect(t.state).toBe("ASK_COMPETITORS");
    expect(t.data.appStoreId).toBe("123456789");
    expect(t.data.serviceId).toBeTruthy();
  });

  it("parses numeric-only App Store id", () => {
    const t = advance("ASK_IDENTIFIER", base, "987654321");
    expect(t.data.appStoreId).toBe("987654321");
  });

  it("parses Play Store URL", () => {
    const t = advance(
      "ASK_IDENTIFIER",
      base,
      "https://play.google.com/store/apps/details?id=com.eodin.fridgify"
    );
    expect(t.data.playStorePackage).toBe("com.eodin.fridgify");
  });

  it("parses bare Play Store package", () => {
    const t = advance("ASK_IDENTIFIER", base, "com.eodin.fridgify");
    expect(t.data.playStorePackage).toBe("com.eodin.fridgify");
  });

  it("rejects invalid identifier", () => {
    const t = advance("ASK_IDENTIFIER", base, "???");
    expect(t.state).toBe("ASK_IDENTIFIER");
  });
});

describe("ASK_IDENTIFIER — web", () => {
  const base: BrandFlowData = { serviceType: "web" };

  it("accepts https URL and advances to COLLECTING", () => {
    const t = advance("ASK_IDENTIFIER", base, "https://eodin.app");
    expect(t.state).toBe("COLLECTING");
    expect(t.data.websiteUrl).toBe("https://eodin.app/");
  });

  it("prepends https:// to a bare domain", () => {
    const t = advance("ASK_IDENTIFIER", base, "eodin.app");
    expect(t.data.websiteUrl).toBe("https://eodin.app");
  });

  it("rejects ftp schemes", () => {
    const t = advance("ASK_IDENTIFIER", base, "ftp://bad.example.com");
    expect(t.state).toBe("ASK_IDENTIFIER");
  });
});

describe("ASK_IDENTIFIER — package", () => {
  const base: BrandFlowData = { serviceType: "package" };

  it("accepts scoped npm name", () => {
    const t = advance("ASK_IDENTIFIER", base, "@eodin/analytics-sdk");
    expect(t.state).toBe("COLLECTING");
    expect(t.data.npmName).toBe("@eodin/analytics-sdk");
  });

  it("accepts flat npm name", () => {
    const t = advance("ASK_IDENTIFIER", base, "lodash");
    expect(t.data.npmName).toBe("lodash");
  });

  it("rejects invalid npm name", () => {
    const t = advance("ASK_IDENTIFIER", base, "not a package");
    expect(t.state).toBe("ASK_IDENTIFIER");
  });
});

describe("ASK_COMPETITORS → COLLECTING", () => {
  const base: BrandFlowData = { serviceType: "app", appStoreId: "123" };

  it("parses comma-separated competitors", () => {
    const t = advance("ASK_COMPETITORS", base, "com.a,com.b, com.c");
    expect(t.state).toBe("COLLECTING");
    expect(t.data.competitors).toEqual(["com.a", "com.b", "com.c"]);
  });

  it("handles '없음' as empty list", () => {
    const t = advance("ASK_COMPETITORS", base, "없음");
    expect(t.data.competitors).toEqual([]);
  });

  it("handles skip token", () => {
    const t = advance("ASK_COMPETITORS", base, "건너뛰기");
    expect(t.data.competitors).toEqual([]);
  });
});

describe("PREVIEW", () => {
  const base: BrandFlowData = { serviceType: "app", serviceId: "fridgify" };

  it("advances to ASK_LOGO on save", () => {
    const t = advance("PREVIEW", base, "저장");
    expect(t.state).toBe("ASK_LOGO");
  });

  it("cancels on 'no'", () => {
    const t = advance("PREVIEW", base, "no");
    expect(t.state).toBe("CANCELLED");
    expect(t.terminal).toBe(true);
  });

  it("stays on unknown input", () => {
    const t = advance("PREVIEW", base, "maybe");
    expect(t.state).toBe("PREVIEW");
  });
});

describe("ASK_LOGO and ASK_DESIGN", () => {
  const base: BrandFlowData = { serviceType: "app", serviceId: "fridgify" };

  it("advances on file attachment", () => {
    const t = advance("ASK_LOGO", base, "", true);
    expect(t.state).toBe("ASK_DESIGN");
  });

  it("advances on skip", () => {
    const t = advance("ASK_LOGO", base, "건너뛰기");
    expect(t.state).toBe("ASK_DESIGN");
  });

  it("ASK_DESIGN file → DONE (terminal)", () => {
    const t = advance("ASK_DESIGN", base, "", true);
    expect(t.state).toBe("DONE");
    expect(t.terminal).toBe(true);
  });

  it("ASK_DESIGN skip → DONE", () => {
    const t = advance("ASK_DESIGN", base, "skip");
    expect(t.state).toBe("DONE");
    expect(t.terminal).toBe(true);
  });

  it("ASK_LOGO unknown text stays", () => {
    const t = advance("ASK_LOGO", base, "hmm");
    expect(t.state).toBe("ASK_LOGO");
  });
});

describe("cancel at any state", () => {
  const data: BrandFlowData = { serviceType: "app" };
  it.each<BrandFlowState>([
    "ASK_TYPE",
    "ASK_IDENTIFIER",
    "ASK_COMPETITORS",
    "ASK_LOGO",
    "ASK_DESIGN",
  ])("from %s", (state) => {
    const t = advance(state, data, "취소");
    expect(t.state).toBe("CANCELLED");
    expect(t.terminal).toBe(true);
  });
});

describe("COLLECTING state is inert to user text", () => {
  it("does not change state", () => {
    const data: BrandFlowData = { serviceType: "app", appStoreId: "123" };
    const t = advance("COLLECTING", data, "hello?");
    expect(t.state).toBe("COLLECTING");
  });
});

describe("deriveServiceId", () => {
  it("derives from npm scoped name", () => {
    expect(
      __test__.deriveServiceId({ npmName: "@eodin/analytics-sdk" })
    ).toContain("eodin");
  });

  it("derives from Play package", () => {
    expect(
      __test__.deriveServiceId({ playStorePackage: "com.eodin.fridgify" })
    ).toBe("fridgify");
  });

  it("derives from App Store id", () => {
    expect(__test__.deriveServiceId({ appStoreId: "123" })).toBe("app-123");
  });

  it("derives from website host", () => {
    expect(
      __test__.deriveServiceId({ websiteUrl: "https://www.eodin.app" })
    ).toBe("eodin-app");
  });
});
