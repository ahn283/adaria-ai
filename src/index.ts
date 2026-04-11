#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { PACKAGE_JSON_PATH } from "./utils/paths.js";

interface PackageJson {
  version: string;
  description?: string;
}

const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf-8")) as PackageJson;

const program = new Command();

program
  .name("adaria-ai")
  .description(
    pkg.description ??
      "Marketing operations agent for the Adaria.ai app portfolio"
  )
  .version(pkg.version);

program.parse();
