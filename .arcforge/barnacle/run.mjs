// Entry point for this repository-owned Barnacle workflow: load Arc Forge config, apply
// the caller repo's optional .github/barnacle.json on top, then run upstream
// Barnacle unchanged apart from the config patch.
import { readFileSync } from "node:fs";
import { configureBarnacle, runBarnacleAutoResponse } from "../vendor/openclaw/scripts/github/barnacle-auto-response.mjs";
import { applyPrCap } from "./pr-cap.mjs";

const ORG_CONFIG = new URL("./config.json", import.meta.url);

// Repo overrides replace top-level keys; `rules`, `candidateActionRules` and
// `labels` merge by label so a repo can flip one rule without copying all.
export function mergeConfig(base, override = {}) {
  const merged = { ...base, ...override };
  for (const key of ["rules", "candidateActionRules"]) {
    if (!override[key]) continue;
    const byLabel = new Map((base[key] ?? []).map((rule) => [rule.label, rule]));
    for (const rule of override[key]) byLabel.set(rule.label, { ...byLabel.get(rule.label), ...rule });
    merged[key] = [...byLabel.values()];
  }
  if (override.labels) merged.labels = { ...base.labels, ...override.labels };
  return merged;
}

async function repoOverride(github, context, core) {
  try {
    const { data } = await github.rest.repos.getContent({
      owner: context.repo.owner,
      repo: context.repo.repo,
      path: ".github/barnacle.json",
      ref: context.payload.repository?.default_branch,
    });
    return JSON.parse(Buffer.from(data.content, "base64").toString("utf8"));
  } catch (error) {
    if (error?.status === 404) return {};
    core.warning(`Ignoring .github/barnacle.json: ${error.message}`);
    return {};
  }
}

async function loadConfig(github, context, core) {
  const base = JSON.parse(readFileSync(ORG_CONFIG, "utf8"));
  const config = mergeConfig(base, await repoOverride(github, context, core));
  if (config.enabled === false) core.info("Barnacle is disabled for this repository by .github/barnacle.json.");
  return config;
}

// The PR cap labels authors over the limit; Barnacle's `r: too-many-prs` rule
// then closes on the resulting `labeled` event, as upstream's two workflows do.
export async function runPrCap({ github, context, core }) {
  const config = await loadConfig(github, context, core);
  if (config.enabled === false || config.activePrLimit === 0) return;
  await applyPrCap({ github, context, core }, config);
}

export async function run({ github, context, core }) {
  const config = await loadConfig(github, context, core);
  if (config.enabled === false) return;
  configureBarnacle({ linkedReferenceRepo: `${context.repo.owner}/${context.repo.repo}`, ...config });
  await runBarnacleAutoResponse({ github, context, core });
}
