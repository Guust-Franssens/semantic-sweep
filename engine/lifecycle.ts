// Dev/test/prod promotion (lifecycle) handling. Ported from semantic_sweep/lifecycle.py.

import type { ModelCard } from "./types";

const ENV_RANK: Record<string, number> = {
  prod: 5, ppe: 4, preprod: 4, staging: 3, test: 3, qa: 3, uat: 3, sit: 3, acc: 3, base: 3, dev: 2, feat: 1,
};

const ENV_ALIASES: Record<string, string> = {
  prod: "prod", prd: "prod", production: "prod", ppe: "ppe", preprod: "preprod", "pre-prod": "preprod",
  staging: "staging", stg: "staging", test: "test", tst: "test", qa: "qa", uat: "uat", sit: "sit",
  acc: "acc", dev: "dev", develop: "dev", development: "dev",
};

const DELIM = "[ _.-]";
const FEAT_RE = new RegExp(`(?:^|${DELIM})(?:feat|feature)(?:${DELIM}|$)`);
const ALIAS_KEYS = Object.keys(ENV_ALIASES).sort((a, b) => b.length - a.length);
const TRAILING_ENV_RE = new RegExp(`${DELIM}(${ALIAS_KEYS.join("|")})$`);

export interface EnvInfo {
  family: string;
  env: string;
  rank: number;
}

function normFamily(text: string): string {
  return text.toLowerCase().replace(/[ _.-]+/g, " ").trim();
}

function stripDelims(text: string): string {
  return text.replace(/^[ _.-]+|[ _.-]+$/g, "");
}

export function normalizedItemName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function classifyWorkspace(workspace: string): EnvInfo {
  const low = workspace.toLowerCase().trim();
  const feat = FEAT_RE.exec(low);
  if (feat) {
    const family = stripDelims(low.slice(0, feat.index)) || low;
    return { family: normFamily(family), env: "feat", rank: ENV_RANK.feat };
  }
  const trailing = TRAILING_ENV_RE.exec(low);
  if (trailing) {
    const family = stripDelims(low.slice(0, trailing.index)) || low;
    const env = ENV_ALIASES[trailing[1]];
    return { family: normFamily(family), env, rank: ENV_RANK[env] ?? 3 };
  }
  return { family: normFamily(low), env: "base", rank: ENV_RANK.base };
}

export function isLifecycleCandidate(a: ModelCard, b: ModelCard): boolean {
  const ea = classifyWorkspace(a.workspace);
  const eb = classifyWorkspace(b.workspace);
  return ea.family === eb.family && ea.env !== eb.env && normalizedItemName(a.name) === normalizedItemName(b.name);
}

export function keepRank(c: ModelCard): number {
  return classifyWorkspace(c.workspace).rank;
}
