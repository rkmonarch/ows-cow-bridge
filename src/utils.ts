/**
 * utils.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared utility functions used across the application:
 *  - BigInt / decimal formatting helpers
 *  - Transaction status polling
 *  - Pretty-print formatters for terminal output
 *  - Viem public client factory
 *  - Simple in-memory event bus for cross-component communication
 */

import { createPublicClient, http, formatUnits, parseUnits, type PublicClient } from "viem";
import chalk from "chalk";
import { CHAIN_CONFIGS, getTokenDecimals, type Address } from "./config.js";
// Use Node.js built-in EventEmitter — zero-dep, works in all module modes
import { EventEmitter } from "node:events";

// ── Shared event bus ──────────────────────────────────────────────────────────
// Used to push log lines and status updates from tools → UI without prop-drilling.

export type LogLevel = "info" | "success" | "warn" | "error" | "debug";

export interface LogEntry {
  ts: Date;
  level: LogLevel;
  message: string;
}

export interface PendingTx {
  id: string;         // internal UUID
  hash?: string;      // on-chain tx hash once broadcast
  label: string;      // e.g. "Swap 1 ETH → USDC on Base"
  chainId: number;
  status: "pending" | "confirmed" | "failed";
  createdAt: Date;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyListener = (...args: any[]) => void;

/**
 * Typed event bus using Node's built-in EventEmitter.
 * Uses `any` for listeners so callers can pass strongly-typed handlers
 * without fighting contra-variance on function parameters.
 */
class AppEventBus {
  private _ee = new EventEmitter();

  constructor() {
    this._ee.setMaxListeners(50);
  }

  on(event: string, listener: AnyListener): this {
    this._ee.on(event, listener);
    return this;
  }

  off(event: string, listener: AnyListener): this {
    this._ee.off(event, listener);
    return this;
  }

  once(event: string, listener: AnyListener): this {
    this._ee.once(event, listener);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    this._ee.emit(event, ...args);
  }

  removeAllListeners(event?: string): this {
    this._ee.removeAllListeners(event);
    return this;
  }

  log(level: LogLevel, message: string): void {
    const entry: LogEntry = { ts: new Date(), level, message };
    this._ee.emit("log", entry);
  }

  pushTx(tx: PendingTx): void {
    this._ee.emit("tx:update", tx);
  }

  requestConfirmation(prompt: string, txId: string): void {
    this._ee.emit("confirm:request", { prompt, txId });
  }

  confirmationResponse(txId: string, approved: boolean): void {
    this._ee.emit("confirm:response", { txId, approved });
  }
}

export const bus = new AppEventBus();

// ── Viem public client cache ───────────────────────────────────────────────────

const clientCache = new Map<number, PublicClient>();

export function getPublicClient(chainId: number): PublicClient {
  if (clientCache.has(chainId)) return clientCache.get(chainId)!;
  const cfg = CHAIN_CONFIGS[chainId];
  if (!cfg) throw new Error(`No chain config for chainId ${chainId}`);
  const client = createPublicClient({
    chain: cfg.chain,
    transport: http(cfg.rpcUrl),
  });
  clientCache.set(chainId, client);
  return client;
}

// ── BigInt / decimal helpers ───────────────────────────────────────────────────

/**
 * Convert a human-readable amount (e.g. "1.5") to the raw integer with
 * the correct number of decimals for the token.
 */
export function toTokenUnits(amount: string, symbol: string): bigint {
  const decimals = getTokenDecimals(symbol);
  return parseUnits(amount, decimals);
}

/**
 * Convert raw integer units back to a human-readable string.
 */
export function fromTokenUnits(raw: bigint, symbol: string, precision = 6): string {
  const decimals = getTokenDecimals(symbol);
  const full = formatUnits(raw, decimals);
  // Trim to `precision` decimal places without scientific notation
  const [int, frac = ""] = full.split(".");
  return `${int}.${frac.slice(0, precision).padEnd(precision, "0")}`;
}

/**
 * Format a USD value with 2 decimal places and $ prefix.
 */
export function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

// ── Address helpers ────────────────────────────────────────────────────────────

export function shortAddr(addr: Address | string): string {
  if (addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function explorerTxUrl(chainId: number, hash: string): string {
  const cfg = CHAIN_CONFIGS[chainId];
  if (!cfg) return hash;
  return `${cfg.explorerUrl}/tx/${hash}`;
}

// ── Terminal color helpers ─────────────────────────────────────────────────────

export const color = {
  info:    (s: string) => chalk.cyan(s),
  success: (s: string) => chalk.green(s),
  warn:    (s: string) => chalk.yellow(s),
  error:   (s: string) => chalk.red(s),
  debug:   (s: string) => chalk.gray(s),
  bold:    (s: string) => chalk.bold(s),
  dim:     (s: string) => chalk.dim(s),
  addr:    (s: string) => chalk.magenta(s),
  token:   (s: string) => chalk.blueBright(s),
  chain:   (s: string) => chalk.greenBright(s),
  amount:  (s: string) => chalk.whiteBright(s),
};

export function levelColor(level: LogLevel, msg: string): string {
  switch (level) {
    case "info":    return color.info(msg);
    case "success": return color.success(msg);
    case "warn":    return color.warn(msg);
    case "error":   return color.error(msg);
    case "debug":   return color.debug(msg);
  }
}

// ── Transaction polling ────────────────────────────────────────────────────────

/**
 * Poll the chain for a transaction receipt, with retries and backoff.
 * Resolves when the tx is mined or rejects after `maxWaitMs`.
 */
export async function waitForTx(
  chainId: number,
  hash: `0x${string}`,
  maxWaitMs = 120_000,
  pollIntervalMs = 3_000,
): Promise<{ status: "success" | "reverted"; blockNumber: bigint }> {
  const client = getPublicClient(chainId);
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    try {
      const receipt = await client.getTransactionReceipt({ hash });
      if (receipt) {
        return {
          status: receipt.status,
          blockNumber: receipt.blockNumber,
        };
      }
    } catch {
      // receipt not yet available
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`Transaction ${hash} not confirmed within ${maxWaitMs / 1000}s`);
}

// ── Misc ───────────────────────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function nowIso(): string {
  return new Date().toISOString().slice(11, 19); // HH:MM:SS
}

/**
 * Wrap any async fn with retries (exponential backoff).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 500,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < maxAttempts - 1) await sleep(baseDelayMs * 2 ** i);
    }
  }
  throw lastErr;
}

/**
 * Prompt-style confirmation gate: waits for the bus to emit a
 * `confirm:response` for the given txId.
 * The UI listens on `confirm:request` and should call bus.confirmationResponse().
 */
export function awaitConfirmation(
  prompt: string,
  txId: string,
  timeoutMs = 120_000,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      bus.removeAllListeners(`confirm:response:${txId}`);
      reject(new Error("Confirmation timed out"));
    }, timeoutMs);

    // Request confirmation from the UI
    bus.requestConfirmation(prompt, txId);

    // Listen for the one-shot response
    bus.once("confirm:response", (data: { txId: string; approved: boolean }) => {
      if (data.txId === txId) {
        clearTimeout(timer);
        resolve(data.approved);
      }
    });
  });
}

/**
 * Truncate a string in the middle for display, e.g. long calldata.
 */
export function truncateMiddle(s: string, maxLen = 40): string {
  if (s.length <= maxLen) return s;
  const half = Math.floor((maxLen - 3) / 2);
  return `${s.slice(0, half)}...${s.slice(-half)}`;
}
