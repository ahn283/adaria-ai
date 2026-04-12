/**
 * Pre-publish secret scanner.
 *
 * Runs from `prepublishOnly`. Produces the exact tarball `npm publish`
 * would upload, untars it into a temporary directory, and scans every
 * file for patterns that look like real credentials (Slack, Anthropic,
 * Google, GitHub, OpenAI, PEM private key blocks). Exits non-zero if
 * anything matches so the publish is blocked.
 *
 * The patterns intentionally require a credential body — e.g. a PEM
 * block must be followed by base64 content, not just the literal
 * `-----BEGIN PRIVATE KEY-----` string, so validation messages in our
 * own source code don't trigger false positives.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface SecretRule {
  name: string;
  /** Must match somewhere in the file for the rule to trigger. */
  pattern: RegExp;
}

const RULES: SecretRule[] = [
  {
    name: "Slack bot token",
    pattern: /xoxb-[0-9]{5,}-[0-9]{5,}-[A-Za-z0-9]{20,}/,
  },
  {
    name: "Slack app token",
    pattern: /xapp-[0-9]-[A-Z0-9]{5,}-[0-9]{5,}-[A-Za-z0-9]{30,}/,
  },
  {
    name: "Slack user token",
    pattern: /xoxp-[0-9]{5,}-[0-9]{5,}-[0-9]{5,}-[A-Za-z0-9]{20,}/,
  },
  {
    name: "Anthropic API key",
    pattern: /sk-ant-[A-Za-z0-9_-]{20,}/,
  },
  {
    name: "Google API key",
    pattern: /AIza[0-9A-Za-z_-]{35}/,
  },
  {
    name: "OpenAI API key",
    pattern: /sk-[A-Za-z0-9]{32,}/,
  },
  {
    name: "GitHub PAT (classic)",
    pattern: /gh[pousr]_[A-Za-z0-9]{36,}/,
  },
  {
    name: "PEM private key block with body",
    // Require at least one 40+ char base64 line after the BEGIN marker
    // so validation message literals (`-----BEGIN PRIVATE KEY-----`)
    // in our own source code don't trigger.
    pattern:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |)?PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/=\r\n]{40,}/,
  },
];

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".gz",
  ".tgz",
  ".dmg",
  ".wasm",
]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (entry.isFile()) {
      if (!BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        out.push(full);
      }
    }
  }
  return out;
}

function runNpmPack(repoRoot: string): string {
  // `npm pack --silent` prints only the final tarball filename to stdout.
  const result = spawnSync("npm", ["pack", "--silent"], {
    cwd: repoRoot,
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    console.error(`npm pack failed: ${result.stderr}`);
    process.exit(2);
  }
  const filename = result.stdout.trim().split("\n").pop();
  if (!filename) {
    console.error("npm pack produced no tarball");
    process.exit(2);
  }
  return path.join(repoRoot, filename);
}

function scanTarball(tarball: string): {
  hits: { rule: string; file: string; snippet: string }[];
  scanned: number;
} {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "adaria-scan-"));
  try {
    execFileSync("tar", ["-xzf", tarball, "-C", workdir]);
    const files = walk(workdir);
    const hits: { rule: string; file: string; snippet: string }[] = [];

    for (const file of files) {
      let content: string;
      try {
        content = fs.readFileSync(file, "utf-8");
      } catch {
        continue;
      }
      for (const rule of RULES) {
        const match = rule.pattern.exec(content);
        if (match) {
          const redacted = match[0].slice(0, 8) + "…[REDACTED]";
          hits.push({
            rule: rule.name,
            file: path.relative(workdir, file),
            snippet: redacted,
          });
        }
      }
    }
    return { hits, scanned: files.length };
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
}

function main(): void {
  const repoRoot = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    ".."
  );
  const tarball = runNpmPack(repoRoot);
  try {
    const { hits, scanned } = scanTarball(tarball);
    if (hits.length > 0) {
      console.error(
        "check-tarball-secrets: POTENTIAL SECRET FOUND in the npm tarball!"
      );
      console.error("-----");
      for (const hit of hits) {
        console.error(`  [${hit.rule}] ${hit.file}: ${hit.snippet}`);
      }
      console.error("-----");
      console.error(
        "Refusing to publish. Inspect the files above and remove the secret."
      );
      process.exit(1);
    }
    console.log(`check-tarball-secrets: clean (${String(scanned)} files scanned)`);
  } finally {
    try {
      fs.unlinkSync(tarball);
    } catch {
      // best effort
    }
  }
}

main();
