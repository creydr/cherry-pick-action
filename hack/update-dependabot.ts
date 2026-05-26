import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

interface DependabotUpdate {
  "package-ecosystem": string;
  directory: string;
  schedule: { interval: string };
  "target-branch"?: string;
  "commit-message"?: { prefix: string };
  groups?: Record<string, { patterns: string[] }>;
}

function formatUpdate(update: DependabotUpdate): string {
  const lines: string[] = [];
  lines.push(`  - package-ecosystem: ${update["package-ecosystem"]}`);
  lines.push(`    directory: ${update.directory}`);
  if (update["target-branch"]) {
    lines.push(`    target-branch: ${update["target-branch"]}`);
  }
  lines.push(`    schedule:`);
  lines.push(`      interval: ${update.schedule.interval}`);
  if (update["commit-message"]) {
    lines.push(`    commit-message:`);
    lines.push(`      prefix: "${update["commit-message"].prefix}"`);
  }
  if (update.groups) {
    lines.push(`    groups:`);
    for (const [name, config] of Object.entries(update.groups)) {
      lines.push(`      ${name}:`);
      lines.push(`        patterns:`);
      for (const pattern of config.patterns) {
        lines.push(`          - "${pattern}"`);
      }
    }
  }
  return lines.join("\n");
}

export function generateDependabotYaml(releaseBranches: string[]): string {
  const sorted = [...releaseBranches].sort();

  const updates: DependabotUpdate[] = [
    {
      "package-ecosystem": "npm",
      directory: "/",
      schedule: { interval: "weekly" },
    },
    {
      "package-ecosystem": "github-actions",
      directory: "/",
      schedule: { interval: "weekly" },
      groups: { "github-actions": { patterns: ["*"] } },
    },
  ];

  for (const branch of sorted) {
    updates.push({
      "package-ecosystem": "npm",
      directory: "/",
      "target-branch": branch,
      schedule: { interval: "weekly" },
      "commit-message": { prefix: `[${branch}]` },
      groups: { npm: { patterns: ["*"] } },
    });
    updates.push({
      "package-ecosystem": "github-actions",
      directory: "/",
      "target-branch": branch,
      schedule: { interval: "weekly" },
      "commit-message": { prefix: `[${branch}]` },
      groups: { "github-actions": { patterns: ["*"] } },
    });
  }

  const sections = updates.map(formatUpdate);
  return `version: 2\nupdates:\n${sections.join("\n")}\n`;
}

const scriptPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "update-dependabot.ts",
);
const isMain = process.argv[1] && resolve(process.argv[1]) === scriptPath;

if (isMain) {
  const branches = process.argv.slice(2);
  const yaml = generateDependabotYaml(branches);

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const outputPath = resolve(repoRoot, ".github/dependabot.yml");

  writeFileSync(outputPath, yaml, "utf-8");
  console.log(`Updated ${outputPath}`);
}
