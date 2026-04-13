/**
 * `adaria-ai service` — manage custom service endpoints.
 *
 *   adaria-ai service add <name> <url> [--description <desc>]
 *   adaria-ai service list
 *   adaria-ai service remove <name>
 *
 * Services are stored in `~/.adaria/config.yaml` under the `services` key.
 */
import { loadRawConfig, saveConfig, configExists } from "../config/store.js";
import type { AdariaConfig } from "../config/schema.js";

interface ServiceEntry {
  baseUrl: string;
  description?: string;
}

type ServicesMap = Record<string, ServiceEntry>;

async function loadServices(): Promise<{ raw: Record<string, unknown>; services: ServicesMap }> {
  if (!(await configExists())) {
    console.error('Config not found. Run "adaria-ai init" first.');
    process.exitCode = 1;
    return { raw: {}, services: {} };
  }
  const raw = await loadRawConfig() as Partial<AdariaConfig> & Record<string, unknown>;
  const services = (raw.services ?? {}) as ServicesMap;
  return { raw, services };
}

export async function serviceAdd(
  name: string,
  url: string,
  description?: string,
): Promise<void> {
  if (!url.startsWith("https://")) {
    console.error("URL must start with https://");
    process.exitCode = 1;
    return;
  }

  const { raw, services } = await loadServices();
  if (process.exitCode) return;

  const key = name.toLowerCase();
  const existed = key in services;
  services[key] = { baseUrl: url, ...(description ? { description } : {}) };
  raw["services"] = services;
  await saveConfig(raw);

  console.log(existed ? `Updated ${key}: ${url}` : `Added ${key}: ${url}`);
}

export async function serviceList(): Promise<void> {
  const { services } = await loadServices();
  if (process.exitCode) return;

  const entries = Object.entries(services);
  if (entries.length === 0) {
    console.log("No services registered. Use `adaria-ai service add <name> <url>` to add one.");
    return;
  }

  console.log("Registered services:\n");
  for (const [name, svc] of entries) {
    const desc = svc.description ? ` — ${svc.description}` : "";
    console.log(`  ${name}: ${svc.baseUrl}${desc}`);
  }
}

export async function serviceRemove(name: string): Promise<void> {
  const { raw, services } = await loadServices();
  if (process.exitCode) return;

  const key = name.toLowerCase();
  if (!(key in services)) {
    console.error(`Service "${key}" not found.`);
    process.exitCode = 1;
    return;
  }

  delete services[key];
  raw["services"] = services;
  await saveConfig(raw);

  console.log(`Removed ${key}`);
}
