/**
 * app-info MCP tool — read parsed apps.yaml metadata.
 */

import type { AppConfig } from "../config/apps-schema.js";
import type { McpToolImplementation } from "../agent/mcp-manager.js";

export function createAppInfoTool(apps: AppConfig[]): McpToolImplementation {
  return {
    id: "app-info",
    name: "App Info",
    description:
      "Read app metadata from apps.yaml. Call with no arguments to list all apps, " +
      "or pass an app ID to get detailed config for a specific app. " +
      "Returns: id, name, platforms, store IDs, keywords, competitors, locale, features.",
    inputSchema: {
      type: "object",
      properties: {
        app: {
          type: "string",
          description: "App ID to look up. Omit to list all apps.",
        },
      },
    },
    handler: (input: unknown): Promise<unknown> => {
      const obj = (input ?? {}) as Record<string, unknown>;
      const appId = typeof obj["app"] === "string" ? obj["app"].toLowerCase() : undefined;

      if (!appId) {
        return Promise.resolve({
          appCount: apps.length,
          apps: apps.map((a) => ({
            id: a.id,
            name: a.name,
            platform: a.platform,
            active: a.active,
          })),
        });
      }

      const app = apps.find((a) => a.id.toLowerCase() === appId);
      if (!app) {
        return Promise.resolve({ error: `App "${appId}" not found. Available: ${apps.map((a) => a.id).join(", ")}` });
      }

      return Promise.resolve({
        id: app.id,
        name: app.name,
        platform: app.platform,
        appStoreId: app.appStoreId,
        playStorePackage: app.playStorePackage,
        primaryKeywords: app.primaryKeywords,
        competitors: app.competitors,
        locale: app.locale,
        features: app.features,
        active: app.active,
      });
    },
  };
}
