/**
 * wallet/policies.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OWS-style spending policies that gate every sign request.
 *
 * Policies are checked synchronously BEFORE the sign call reaches the wallet.
 * If any policy rejects, the operation is cancelled — no signature is produced.
 *
 * Supported policy types:
 *  - maxAmountUsd    : reject if the USD value of the trade exceeds a limit
 *  - allowedChainIds : reject if the destination chain is not in the allow-list
 *  - allowedTokens   : reject if a token symbol is not in the allow-list
 *  - maxDailyVolume  : reject if cumulative daily spend exceeds a USD limit
 */

import { bus } from "../utils.js";

// ── Policy definitions ─────────────────────────────────────────────────────────

export type PolicyType =
  | "maxAmountUsd"
  | "allowedChainIds"
  | "allowedTokens"
  | "maxDailyVolumeUsd";

export interface MaxAmountUsdPolicy {
  type: "maxAmountUsd";
  limitUsd: number;
}

export interface AllowedChainIdsPolicy {
  type: "allowedChainIds";
  chainIds: number[];
}

export interface AllowedTokensPolicy {
  type: "allowedTokens";
  symbols: string[]; // uppercase, e.g. ["ETH", "USDC"]
}

export interface MaxDailyVolumePolicy {
  type: "maxDailyVolumeUsd";
  limitUsd: number;
}

export type Policy =
  | MaxAmountUsdPolicy
  | AllowedChainIdsPolicy
  | AllowedTokensPolicy
  | MaxDailyVolumePolicy;

// ── Policy context (passed to checkPolicies) ───────────────────────────────────

export interface PolicyContext {
  amountUsd: number;        // estimated USD value of this single operation
  chainId: number;          // chain where the operation will execute
  tokenSymbols: string[];   // tokens involved (sell + buy)
}

// ── Policy check result ────────────────────────────────────────────────────────

export interface PolicyResult {
  allowed: boolean;
  violations: string[];
}

// ── Daily volume tracker (in-memory, resets at midnight UTC) ─────────────────

const dailyVolume = new Map<string, { dateUtc: string; totalUsd: number }>();

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function recordVolume(walletName: string, amountUsd: number): void {
  const today = todayUtc();
  const entry = dailyVolume.get(walletName);
  if (!entry || entry.dateUtc !== today) {
    dailyVolume.set(walletName, { dateUtc: today, totalUsd: amountUsd });
  } else {
    entry.totalUsd += amountUsd;
  }
}

function getDailyVolume(walletName: string): number {
  const today = todayUtc();
  const entry = dailyVolume.get(walletName);
  if (!entry || entry.dateUtc !== today) return 0;
  return entry.totalUsd;
}

// ── Policy engine ─────────────────────────────────────────────────────────────

// Active policies per wallet
const walletPolicies = new Map<string, Policy[]>();

export function setPolicies(walletName: string, policies: Policy[]): void {
  walletPolicies.set(walletName, policies);
  bus.log("info", `Policies updated for wallet "${walletName}": ${policies.length} rule(s)`);
}

export function getPolicies(walletName: string): Policy[] {
  return walletPolicies.get(walletName) ?? [];
}

/**
 * Check all active policies for a wallet against a proposed operation.
 * Logs every violation.
 */
export function checkPolicies(
  walletName: string,
  ctx: PolicyContext,
): PolicyResult {
  const policies = getPolicies(walletName);
  const violations: string[] = [];

  for (const policy of policies) {
    switch (policy.type) {
      case "maxAmountUsd": {
        if (ctx.amountUsd > policy.limitUsd) {
          violations.push(
            `maxAmountUsd: ${ctx.amountUsd.toFixed(2)} USD exceeds limit of ${policy.limitUsd} USD`,
          );
        }
        break;
      }
      case "allowedChainIds": {
        if (!policy.chainIds.includes(ctx.chainId)) {
          violations.push(
            `allowedChainIds: chain ${ctx.chainId} is not in the allowed list [${policy.chainIds.join(", ")}]`,
          );
        }
        break;
      }
      case "allowedTokens": {
        const allowed = policy.symbols.map((s) => s.toUpperCase());
        for (const sym of ctx.tokenSymbols) {
          if (!allowed.includes(sym.toUpperCase())) {
            violations.push(
              `allowedTokens: token "${sym}" is not in the allowed list [${policy.symbols.join(", ")}]`,
            );
          }
        }
        break;
      }
      case "maxDailyVolumeUsd": {
        const current = getDailyVolume(walletName);
        if (current + ctx.amountUsd > policy.limitUsd) {
          violations.push(
            `maxDailyVolumeUsd: would bring daily volume to ${(current + ctx.amountUsd).toFixed(2)} USD, limit is ${policy.limitUsd} USD`,
          );
        }
        break;
      }
    }
  }

  const allowed = violations.length === 0;
  if (!allowed) {
    for (const v of violations) {
      bus.log("warn", `[Policy] ${v}`);
    }
  }
  return { allowed, violations };
}

/**
 * Record a completed trade against the daily volume tracker.
 * Call this after a successful sign + broadcast.
 */
export function recordTrade(walletName: string, amountUsd: number): void {
  recordVolume(walletName, amountUsd);
}

// ── Default safe policies ─────────────────────────────────────────────────────

/**
 * Return a sensible default policy set for new wallets.
 * These are CONSERVATIVE — the user should loosen them as needed.
 */
export function defaultPolicies(): Policy[] {
  return [
    { type: "maxAmountUsd", limitUsd: 10_000 },
    {
      type: "allowedChainIds",
      chainIds: [1, 8453, 42161, 10, 137], // ETH, Base, Arb, OP, Polygon
    },
    {
      type: "allowedTokens",
      symbols: ["ETH", "WETH", "USDC", "USDT", "DAI", "WBTC", "OP", "ARB", "MATIC"],
    },
    { type: "maxDailyVolumeUsd", limitUsd: 50_000 },
  ];
}
