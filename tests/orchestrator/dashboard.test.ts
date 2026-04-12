import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { initDatabase } from "../../src/db/schema.js";
import {
  insertReview,
  updateReviewSentiment,
} from "../../src/db/queries.js";
import { Dashboard } from "../../src/orchestrator/dashboard.js";
import type { AppConfig } from "../../src/config/apps-schema.js";

function makeApp(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    id: "fridgify",
    name: "Fridgify",
    platform: ["ios"],
    primaryKeywords: [],
    competitors: [],
    locale: [],
    features: { fridgifyRecipes: false },
    social: { twitter: false, facebook: false, threads: false, tiktok: false, youtube: false, linkedin: false },
    active: true,
    ...overrides,
  };
}

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

describe("Dashboard", () => {
  it("generates metrics for a single app", () => {
    const dashboard = new Dashboard(db);
    const today = new Date().toISOString().slice(0, 10);
    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);

    const result = dashboard.generate([makeApp()], weekAgo, today);
    expect(result.apps).toHaveLength(1);
    expect(result.apps[0]!.name).toBe("Fridgify");
    // No comparison summary for single app
    expect(result.summary).toBe("");
  });

  it("generates cross-app comparison for multiple apps", () => {
    const dashboard = new Dashboard(db);
    const today = new Date().toISOString().slice(0, 10);
    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);

    // Add some review data for both apps
    insertReview(db, { app_id: "fridgify", platform: "ios", review_id: "r1", rating: 5, body: "Great" });
    updateReviewSentiment(db, "r1", "positive");
    insertReview(db, { app_id: "arden", platform: "ios", review_id: "r2", rating: 3, body: "OK" });
    updateReviewSentiment(db, "r2", "neutral");

    const result = dashboard.generate(
      [makeApp(), makeApp({ id: "arden", name: "Arden TTS" })],
      weekAgo,
      today,
    );

    expect(result.apps).toHaveLength(2);
    expect(result.summary).toContain("Cross-app performance");
    expect(result.summary).toContain("Fridgify");
    expect(result.summary).toContain("Arden TTS");
  });

  it("handles empty DB gracefully", () => {
    const dashboard = new Dashboard(db);
    const today = new Date().toISOString().slice(0, 10);
    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);

    const result = dashboard.generate([makeApp()], weekAgo, today);
    expect(result.apps[0]!.keywords.tracked).toBe(0);
    expect(result.apps[0]!.reviews.total).toBe(0);
    expect(result.apps[0]!.funnel.install).toBe(0);
  });
});
