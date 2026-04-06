/**
 * tools/wallet.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * LangGraph / LangChain tools for wallet management:
 *   - getBalances   : fetch ETH + ERC-20 balances across one or more chains
 *   - createWallet  : provision a new OWS wallet
 *   - loadWallet    : unlock an existing wallet
 *   - listWallets   : enumerate saved wallets
 *   - setPolicies   : update spending-policy rules
 *
 * Each function is also exported as a raw async fn so the Ink UI can
 * call them directly outside the agent loop.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  createPublicClient,
  http,
  formatUnits,
  getContract,
} from "viem";
import {
  createWallet as owsCreate,
  loadWallet as owsLoad,
  listWallets as owsList,
  setActiveWallet,
  getActiveWallet,
  hasActiveWallet,
} from "../wallet/index.js";
import {
  setPolicies as owsSetPolicies,
  defaultPolicies,
  type Policy,
} from "../wallet/policies.js";
import {
  CHAIN_CONFIGS,
  TOKEN_ADDRESSES,
  TOKEN_DECIMALS,
  ENV,
  type Address,
} from "../config.js";
import { bus, shortAddr, fromTokenUnits } from "../utils.js";

// ── Minimal ERC-20 ABI (only balanceOf + decimals needed) ────────────────────
const ERC20_ABI = [
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "decimals",
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "symbol",
    outputs: [{ name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// ── getBalances ───────────────────────────────────────────────────────────────

export interface BalanceResult {
  chain: string;
  chainId: number;
  address: Address;
  balances: Array<{ symbol: string; amount: string; raw: string }>;
  error?: string;
}

/**
 * Fetch native + token balances for a wallet address on the given chains.
 */
export async function getBalancesRaw(
  address: Address,
  chainIds: number[],
  tokenSymbols: string[] = Object.keys(TOKEN_ADDRESSES),
): Promise<BalanceResult[]> {
  const results: BalanceResult[] = [];

  for (const chainId of chainIds) {
    const cfg = CHAIN_CONFIGS[chainId];
    if (!cfg) {
      results.push({ chain: "unknown", chainId, address, balances: [], error: `Chain ${chainId} not configured` });
      continue;
    }

    const client = createPublicClient({ chain: cfg.chain, transport: http(cfg.rpcUrl) });
    const balances: BalanceResult["balances"] = [];

    try {
      // Native balance (ETH / MATIC / AVAX)
      const nativeRaw = await client.getBalance({ address });
      balances.push({
        symbol: cfg.nativeCurrency,
        amount: formatUnits(nativeRaw, 18),
        raw: nativeRaw.toString(),
      });

      // ERC-20 balances
      for (const sym of tokenSymbols) {
        const upper = sym.toUpperCase();
        // Skip if it's the native currency (already fetched above) or not on this chain
        if (upper === cfg.nativeCurrency.toUpperCase()) continue;
        const addr = TOKEN_ADDRESSES[upper]?.[chainId];
        if (!addr) continue;
        if (addr.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee") continue;

        try {
          const contract = getContract({ address: addr, abi: ERC20_ABI, client });
          const [raw, decimals] = await Promise.all([
            contract.read.balanceOf([address]),
            contract.read.decimals(),
          ]);
          if (raw > 0n) {
            balances.push({
              symbol: upper,
              amount: formatUnits(raw, decimals),
              raw: raw.toString(),
            });
          }
        } catch {
          // Silently skip tokens that fail (often just not deployed on this chain)
        }
      }

      results.push({ chain: cfg.name, chainId, address, balances });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ chain: cfg.name, chainId, address, balances, error: msg });
    }
  }

  return results;
}

export const getBalancesTool = tool(
  async ({ chains, accountIndex }) => {
    const wallet = getActiveWallet();
    const acct = wallet.accounts[accountIndex ?? 0];
    if (!acct) return `Account index ${accountIndex} not found in wallet`;

    const chainIds = chains
      ? chains.map((c: string) => {
          const id = parseInt(c, 10);
          if (!isNaN(id)) return id;
          const lower = c.toLowerCase();
          const found = Object.entries(CHAIN_CONFIGS).find(
            ([, cfg]) => cfg.shortName === lower || cfg.name.toLowerCase() === lower,
          );
          return found ? parseInt(found[0], 10) : null;
        }).filter(Boolean) as number[]
      : Object.keys(CHAIN_CONFIGS).map(Number);

    bus.log("info", `Fetching balances for ${shortAddr(acct.address)} on ${chainIds.length} chain(s)…`);
    const results = await getBalancesRaw(acct.address, chainIds);

    let output = `Balances for ${acct.label} (${acct.address}):\n`;
    for (const r of results) {
      if (r.error) {
        output += `  ${r.chain}: ERROR — ${r.error}\n`;
        continue;
      }
      const nonZero = r.balances.filter((b) => parseFloat(b.amount) > 0.000001);
      if (nonZero.length === 0) {
        output += `  ${r.chain}: (no balances)\n`;
      } else {
        output += `  ${r.chain}:\n`;
        for (const b of nonZero) {
          output += `    ${b.symbol}: ${parseFloat(b.amount).toFixed(6)}\n`;
        }
      }
    }
    return output;
  },
  {
    name: "getBalances",
    description:
      "Get token balances for the active wallet across one or more EVM chains. " +
      "Returns native currency + ERC-20 balances.",
    schema: z.object({
      chains: z
        .array(z.string())
        .optional()
        .describe(
          "Chain names or IDs to query, e.g. ['ethereum', 'base', 'arbitrum']. " +
          "Omit to query all supported chains.",
        ),
      accountIndex: z
        .number()
        .int()
        .min(0)
        .optional()
        .default(0)
        .describe("Wallet account index (0-based). Defaults to the first account."),
    }),
  },
);

// ── createWallet ──────────────────────────────────────────────────────────────

export const createWalletTool = tool(
  async ({ name, password }) => {
    if (!password && !ENV.OWS_VAULT_PASSWORD) {
      return "Please provide a password for the new wallet (or set OWS_VAULT_PASSWORD in .env)";
    }
    const pw = password ?? ENV.OWS_VAULT_PASSWORD;
    const { wallet, mnemonic } = await owsCreate(name, pw);
    setActiveWallet(wallet);

    // Apply conservative defaults
    owsSetPolicies(name, defaultPolicies());

    const accountList = wallet.accounts
      .map((a) => `  #${a.index} (${a.label}): ${a.address}`)
      .join("\n");

    return (
      `✅ Wallet "${name}" created and encrypted to disk.\n\n` +
      `⚠️  BACK UP YOUR MNEMONIC NOW — it will NOT be shown again:\n\n` +
      `  ${mnemonic}\n\n` +
      `Accounts:\n${accountList}\n\n` +
      `Default policies applied (max $10,000 per tx, max $50,000/day).`
    );
  },
  {
    name: "createWallet",
    description:
      "Create a new OWS HD wallet encrypted on disk. " +
      "Returns the mnemonic phrase ONCE — user must back it up. " +
      "The wallet is immediately set as the active wallet.",
    schema: z.object({
      name: z.string().min(1).describe("Unique name for this wallet, e.g. 'my-wallet'"),
      password: z
        .string()
        .optional()
        .describe("Encryption password. Falls back to OWS_VAULT_PASSWORD env var."),
    }),
  },
);

// ── loadWallet ────────────────────────────────────────────────────────────────

export const loadWalletTool = tool(
  async ({ name, password }) => {
    const pw = password ?? ENV.OWS_VAULT_PASSWORD;
    if (!pw) return "Please provide the wallet password.";
    const wallet = await owsLoad(name, pw);
    setActiveWallet(wallet);
    const accountList = wallet.accounts
      .map((a) => `  #${a.index} (${a.label}): ${a.address}`)
      .join("\n");
    return `✅ Wallet "${name}" loaded.\nAccounts:\n${accountList}`;
  },
  {
    name: "loadWallet",
    description: "Load and decrypt an existing OWS wallet from disk, making it the active wallet.",
    schema: z.object({
      name: z.string().describe("Name of the wallet to load"),
      password: z.string().optional().describe("Decryption password. Falls back to OWS_VAULT_PASSWORD."),
    }),
  },
);

// ── listWallets ───────────────────────────────────────────────────────────────

export const listWalletsTool = tool(
  async () => {
    const wallets = await owsList();
    if (wallets.length === 0) return "No wallets found. Run createWallet to create one.";
    return `Available wallets:\n${wallets.map((w, i) => `  ${i + 1}. ${w}`).join("\n")}`;
  },
  {
    name: "listWallets",
    description: "List all wallet names saved in the OWS vault directory.",
    schema: z.object({}),
  },
);

// ── setPolicies ───────────────────────────────────────────────────────────────

export const setPoliciesTool = tool(
  async ({ maxAmountUsd, allowedChainIds, allowedTokens, maxDailyVolumeUsd }) => {
    if (!hasActiveWallet()) return "No wallet loaded.";
    const wallet = getActiveWallet();
    const policies: Policy[] = [];

    if (maxAmountUsd !== undefined)
      policies.push({ type: "maxAmountUsd", limitUsd: maxAmountUsd });
    if (allowedChainIds)
      policies.push({ type: "allowedChainIds", chainIds: allowedChainIds });
    if (allowedTokens)
      policies.push({ type: "allowedTokens", symbols: allowedTokens });
    if (maxDailyVolumeUsd !== undefined)
      policies.push({ type: "maxDailyVolumeUsd", limitUsd: maxDailyVolumeUsd });

    owsSetPolicies(wallet.name, policies);
    return `Policies updated for "${wallet.name}":\n${policies.map((p) => `  - ${JSON.stringify(p)}`).join("\n")}`;
  },
  {
    name: "setPolicies",
    description:
      "Update OWS spending policies for the active wallet. " +
      "All parameters are optional — only provided ones are applied.",
    schema: z.object({
      maxAmountUsd: z.number().positive().optional().describe("Max USD per single transaction"),
      allowedChainIds: z.array(z.number().int()).optional().describe("Allowed EIP-155 chain IDs"),
      allowedTokens: z.array(z.string()).optional().describe("Allowed token symbols (uppercase)"),
      maxDailyVolumeUsd: z.number().positive().optional().describe("Max cumulative USD per day"),
    }),
  },
);
