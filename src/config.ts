/**
 * config.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Central configuration: supported chains, RPC URLs, token address maps,
 * CoW / Across contract addresses, and environment loading.
 *
 * All chain IDs follow EIP-155 standards.
 * Token addresses are checksummed where possible.
 */

import "dotenv/config";
import {
  mainnet,
  base,
  arbitrum,
  optimism,
  polygon,
  avalanche,
  type Chain,
} from "viem/chains";

// ── Environment ───────────────────────────────────────────────────────────────

export const ENV = {
  OPENAI_API_KEY: process.env["OPENAI_API_KEY"] ?? "",
  ANTHROPIC_API_KEY: process.env["ANTHROPIC_API_KEY"] ?? "",
  LLM_MODEL: process.env["LLM_MODEL"] ?? "gpt-4o",
  OWS_VAULT_DIR: process.env["OWS_VAULT_DIR"] ?? `${process.env["HOME"]}/.ows/wallets`,
  OWS_VAULT_PASSWORD: process.env["OWS_VAULT_PASSWORD"] ?? "",
  ETH_RPC_URL: process.env["ETH_RPC_URL"] ?? "https://eth.llamarpc.com",
  BASE_RPC_URL: process.env["BASE_RPC_URL"] ?? "https://mainnet.base.org",
  ARB_RPC_URL: process.env["ARB_RPC_URL"] ?? "https://arb1.arbitrum.io/rpc",
  OP_RPC_URL: process.env["OP_RPC_URL"] ?? "https://mainnet.optimism.io",
  POLYGON_RPC_URL: process.env["POLYGON_RPC_URL"] ?? "https://polygon-rpc.com",
  AVALANCHE_RPC_URL: process.env["AVALANCHE_RPC_URL"] ?? "https://api.avax.network/ext/bc/C/rpc",
  COINGECKO_API_KEY: process.env["COINGECKO_API_KEY"] ?? "",
  MOONPAY_PUBLISHABLE_KEY: process.env["MOONPAY_PUBLISHABLE_KEY"] ?? "",
} as const;

// ── Supported chains ──────────────────────────────────────────────────────────

export interface ChainConfig {
  chain: Chain;
  rpcUrl: string;
  name: string;
  shortName: string;
  nativeCurrency: string;
  explorerUrl: string;
  cowProtocolSupported: boolean;
  acrossSupported: boolean;
}

export const CHAIN_CONFIGS: Record<number, ChainConfig> = {
  // Ethereum Mainnet (1)
  1: {
    chain: mainnet,
    rpcUrl: ENV.ETH_RPC_URL,
    name: "Ethereum",
    shortName: "eth",
    nativeCurrency: "ETH",
    explorerUrl: "https://etherscan.io",
    cowProtocolSupported: true,
    acrossSupported: true,
  },
  // Base (8453)
  8453: {
    chain: base,
    rpcUrl: ENV.BASE_RPC_URL,
    name: "Base",
    shortName: "base",
    nativeCurrency: "ETH",
    explorerUrl: "https://basescan.org",
    cowProtocolSupported: true,
    acrossSupported: true,
  },
  // Arbitrum One (42161)
  42161: {
    chain: arbitrum,
    rpcUrl: ENV.ARB_RPC_URL,
    name: "Arbitrum",
    shortName: "arb",
    nativeCurrency: "ETH",
    explorerUrl: "https://arbiscan.io",
    cowProtocolSupported: true,
    acrossSupported: true,
  },
  // Optimism (10)
  10: {
    chain: optimism,
    rpcUrl: ENV.OP_RPC_URL,
    name: "Optimism",
    shortName: "op",
    nativeCurrency: "ETH",
    explorerUrl: "https://optimistic.etherscan.io",
    cowProtocolSupported: true,
    acrossSupported: true,
  },
  // Polygon (137)
  137: {
    chain: polygon,
    rpcUrl: ENV.POLYGON_RPC_URL,
    name: "Polygon",
    shortName: "matic",
    nativeCurrency: "MATIC",
    explorerUrl: "https://polygonscan.com",
    cowProtocolSupported: true,
    acrossSupported: true,
  },
  // Avalanche C-Chain (43114)
  43114: {
    chain: avalanche,
    rpcUrl: ENV.AVALANCHE_RPC_URL,
    name: "Avalanche",
    shortName: "avax",
    nativeCurrency: "AVAX",
    explorerUrl: "https://snowtrace.io",
    cowProtocolSupported: false,
    acrossSupported: false,
  },
};

// ── Native ETH sentinel address (used by CoW Protocol) ───────────────────────
export const NATIVE_ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as const;

// ── Token address map: symbol → chainId → address ────────────────────────────
// These are the canonical on-chain addresses for each token per chain.

export type TokenSymbol = string;
export type Address = `0x${string}`;

export const TOKEN_ADDRESSES: Record<TokenSymbol, Partial<Record<number, Address>>> = {
  ETH: {
    1:     NATIVE_ETH,
    8453:  NATIVE_ETH,
    42161: NATIVE_ETH,
    10:    NATIVE_ETH,
    137:   NATIVE_ETH,
  },
  WETH: {
    1:     "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    8453:  "0x4200000000000000000000000000000000000006",
    42161: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    10:    "0x4200000000000000000000000000000000000006",
    137:   "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  },
  USDC: {
    1:     "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    8453:  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    42161: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    10:    "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    137:   "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  },
  USDT: {
    1:     "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    42161: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
    10:    "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58",
    137:   "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  },
  DAI: {
    1:     "0x6B175474E89094C44Da98b954EedeAC495271d0F",
    8453:  "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
    42161: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
    10:    "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
    137:   "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
  },
  WBTC: {
    1:     "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
    42161: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
    10:    "0x68f180fcCe6836688e9084f035309E29Bf0A2095",
    137:   "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6",
  },
  OP: {
    10:    "0x4200000000000000000000000000000000000042",
  },
  ARB: {
    42161: "0x912CE59144191C1204E64559FE8253a0e49E6548",
  },
  MATIC: {
    137:   "0x0000000000000000000000000000000000001010",
    1:     "0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0",
  },
};

// ── Token decimals ────────────────────────────────────────────────────────────

export const TOKEN_DECIMALS: Record<TokenSymbol, number> = {
  ETH: 18,
  WETH: 18,
  USDC: 6,
  USDT: 6,
  DAI: 18,
  WBTC: 8,
  OP: 18,
  ARB: 18,
  MATIC: 18,
};

// ── Chain name aliases (for natural language parsing) ─────────────────────────

export const CHAIN_NAME_TO_ID: Record<string, number> = {
  ethereum: 1,
  eth: 1,
  mainnet: 1,
  base: 8453,
  arbitrum: 42161,
  arb: 42161,
  "arbitrum one": 42161,
  optimism: 10,
  op: 10,
  polygon: 137,
  matic: 137,
  avalanche: 43114,
  avax: 43114,
};

// ── Across Protocol integrator ID (register at https://across.to) ─────────────
export const ACROSS_INTEGRATOR_ID = "0xdead"; // Replace with your registered ID

// ── CoW Protocol app data hash (identifies your app in metadata) ──────────────
export const COW_APP_DATA = {
  appCode: "TerminalSwap",
  environment: "production",
} as const;

// ── Default swap slippage (basis points, 50 = 0.5%) ──────────────────────────
export const DEFAULT_SLIPPAGE_BPS = 50;

// ── Agent loop limits ─────────────────────────────────────────────────────────
export const MAX_AGENT_ITERATIONS = 20;
export const CONFIRMATION_TIMEOUT_MS = 60_000;

// ── Helper: resolve token symbol to address on a chain ───────────────────────
export function resolveTokenAddress(symbol: string, chainId: number): Address {
  const upper = symbol.toUpperCase();
  const chainMap = TOKEN_ADDRESSES[upper];
  if (!chainMap) throw new Error(`Unknown token symbol: ${symbol}`);
  const addr = chainMap[chainId];
  if (!addr) throw new Error(`Token ${symbol} not configured on chain ${chainId}`);
  return addr;
}

// ── Helper: resolve chain name/id to ChainConfig ─────────────────────────────
export function resolveChain(nameOrId: string | number): ChainConfig {
  const id = typeof nameOrId === "number"
    ? nameOrId
    : CHAIN_NAME_TO_ID[String(nameOrId).toLowerCase()];
  if (!id) throw new Error(`Unknown chain: ${nameOrId}`);
  const cfg = CHAIN_CONFIGS[id];
  if (!cfg) throw new Error(`Chain ${nameOrId} (id=${id}) not configured`);
  return cfg;
}

// ── Helper: get token decimals ────────────────────────────────────────────────
export function getTokenDecimals(symbol: string): number {
  const upper = symbol.toUpperCase();
  return TOKEN_DECIMALS[upper] ?? 18; // default to 18 if unknown
}
