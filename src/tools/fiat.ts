/**
 * tools/fiat.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * MoonPay fiat on-ramp integration.
 *
 * MoonPay provides a hosted widget URL that opens in the browser. In a
 * terminal context, we generate the signed widget URL and display it so the
 * user can open it manually, OR we attempt to open the system browser.
 *
 * The MoonPay widget handles KYC/card processing server-side — we only
 * generate the signed link and track the transaction via webhook/polling.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import crypto from "node:crypto";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import axios from "axios";
import { ENV } from "../config.js";
import { bus } from "../utils.js";
import { getActiveWallet } from "../wallet/index.js";

const execAsync = promisify(exec);

// ── MoonPay constants ─────────────────────────────────────────────────────────

const MOONPAY_WIDGET_BASE = "https://buy.moonpay.com";
const MOONPAY_API_BASE = "https://api.moonpay.com/v3";

// ── URL signing helper ─────────────────────────────────────────────────────────
// MoonPay requires the widget URL to be HMAC-SHA256 signed with the SECRET key.
// The publishable key is safe to embed in the URL.

function signMoonPayUrl(urlWithParams: string, secretKey: string): string {
  const signature = crypto
    .createHmac("sha256", secretKey)
    .update(new URL(urlWithParams).search)
    .digest("base64url");
  return `${urlWithParams}&signature=${encodeURIComponent(signature)}`;
}

// ── Generate MoonPay widget URL ────────────────────────────────────────────────

export interface FiatOnRampParams {
  amountUsd: number;
  currencyCode: string;  // e.g. "eth", "usdc_base"
  walletAddress: string;
  baseCurrencyCode?: string; // fiat currency, default "usd"
  email?: string;
}

export function buildMoonPayUrl(params: FiatOnRampParams): string {
  const pk = ENV.MOONPAY_PUBLISHABLE_KEY;
  if (!pk || pk === "pk_live_...") {
    throw new Error("MOONPAY_PUBLISHABLE_KEY not set in .env");
  }

  const searchParams = new URLSearchParams({
    apiKey: pk,
    currencyCode: params.currencyCode,
    walletAddress: params.walletAddress,
    baseCurrencyCode: params.baseCurrencyCode ?? "usd",
    baseCurrencyAmount: params.amountUsd.toString(),
    colorCode: "%23059669", // emerald green to match terminal theme
    redirectURL: "terminalswap://moonpay-complete",
    externalTransactionId: `ts-${Date.now()}`,
  });

  if (params.email) searchParams.set("email", params.email);

  const urlWithParams = `${MOONPAY_WIDGET_BASE}?${searchParams.toString()}`;

  // If secret key is configured, sign it
  if (process.env["MOONPAY_SECRET_KEY"]) {
    return signMoonPayUrl(urlWithParams, process.env["MOONPAY_SECRET_KEY"]);
  }

  return urlWithParams;
}

// ── Open URL in system browser ────────────────────────────────────────────────

async function openBrowser(url: string): Promise<void> {
  const platform = process.platform;
  const cmd =
    platform === "darwin" ? `open "${url}"` :
    platform === "win32"  ? `start "" "${url}"` :
    `xdg-open "${url}"`;
  try {
    await execAsync(cmd);
  } catch {
    // Non-fatal: user can copy-paste the URL
  }
}

// ── Map token symbols to MoonPay currency codes ───────────────────────────────

const MOONPAY_CURRENCY_MAP: Record<string, Record<number, string>> = {
  ETH:  { 1: "eth", 8453: "eth_base", 42161: "eth_arbitrum", 10: "eth_optimism" },
  USDC: { 1: "usdc", 8453: "usdc_base", 42161: "usdc_arbitrum", 10: "usdc_optimism", 137: "usdc_polygon" },
  USDT: { 1: "usdt", 137: "usdt_polygon" },
  MATIC:{ 137: "matic_polygon" },
  WBTC: { 1: "wbtc" },
  DAI:  { 1: "dai" },
};

function getMoonPayCurrencyCode(symbol: string, chainId: number): string {
  const upper = symbol.toUpperCase();
  const code = MOONPAY_CURRENCY_MAP[upper]?.[chainId];
  if (!code) {
    throw new Error(
      `MoonPay does not support ${symbol} on chain ${chainId}. ` +
      `Supported: ${JSON.stringify(MOONPAY_CURRENCY_MAP)}`,
    );
  }
  return code;
}

// ── fundWithFiat tool ─────────────────────────────────────────────────────────

export const fundWithFiatTool = tool(
  async ({ amountUsd, token, chain, accountIndex, email }) => {
    const chainId = typeof chain === "number" ? chain : 1; // default to Ethereum
    const wallet = getActiveWallet();
    const acctIdx = accountIndex ?? 0;
    const acct = wallet.accounts[acctIdx];
    if (!acct) return `Account index ${acctIdx} not found.`;

    let currencyCode: string;
    try {
      currencyCode = getMoonPayCurrencyCode(token, chainId);
    } catch (err) {
      return (err as Error).message;
    }

    let url: string;
    try {
      url = buildMoonPayUrl({
        amountUsd,
        currencyCode,
        walletAddress: acct.address,
        email,
      });
    } catch (err) {
      return `Failed to build MoonPay URL: ${(err as Error).message}`;
    }

    bus.log("info", `Opening MoonPay for $${amountUsd} ${token.toUpperCase()}…`);

    // Attempt to open browser automatically
    await openBrowser(url);

    return (
      `💳 MoonPay fiat on-ramp opened!\n\n` +
      `  Amount:  $${amountUsd} USD → ${token.toUpperCase()}\n` +
      `  Wallet:  ${acct.address}\n\n` +
      `If the browser didn't open, visit:\n${url}\n\n` +
      `Once the purchase completes, the tokens will be sent directly to your wallet.\n` +
      `Use getBalances to confirm receipt.`
    );
  },
  {
    name: "fundWithFiat",
    description:
      "Buy crypto with a credit/debit card via MoonPay. " +
      "Opens the MoonPay widget in the system browser. " +
      "Tokens are sent directly to the active wallet address.",
    schema: z.object({
      amountUsd: z.number().positive().describe("Amount in USD to spend"),
      token: z.string().describe("Token to purchase, e.g. 'ETH', 'USDC'"),
      chain: z.union([z.number(), z.string()]).optional().describe("Chain to receive on (default: Ethereum)"),
      accountIndex: z.number().int().min(0).optional(),
      email: z.string().email().optional().describe("Pre-fill email in MoonPay widget"),
    }),
  },
);

// ── getOnRampQuote: show exchange rate before opening widget ──────────────────

export const getFiatQuoteTool = tool(
  async ({ amountUsd, token }) => {
    try {
      const upper = token.toUpperCase();
      const currencyCode = MOONPAY_CURRENCY_MAP[upper]?.[1] ?? upper.toLowerCase();

      const resp = await axios.get(`${MOONPAY_API_BASE}/currencies/${currencyCode}/price`, {
        params: { apiKey: ENV.MOONPAY_PUBLISHABLE_KEY },
        timeout: 5000,
      });

      const priceUsd: number = resp.data?.price_usd ?? resp.data?.priceUsd;
      if (!priceUsd) return `Could not fetch MoonPay price for ${token}.`;

      const tokenAmount = amountUsd / priceUsd;
      const moonpayFee = amountUsd * 0.045; // ~4.5% typical fee
      const netAmount = (amountUsd - moonpayFee) / priceUsd;

      return (
        `MoonPay Quote:\n` +
        `  Spend:     $${amountUsd.toFixed(2)} USD\n` +
        `  Rate:      1 ${upper} = $${priceUsd.toFixed(2)}\n` +
        `  Fee (~4.5%): $${moonpayFee.toFixed(2)}\n` +
        `  Receive:   ~${netAmount.toFixed(6)} ${upper}\n\n` +
        `To purchase, call fundWithFiat.`
      );
    } catch {
      // Fallback if API key not set
      return (
        `MoonPay pricing requires MOONPAY_PUBLISHABLE_KEY in .env.\n` +
        `Call fundWithFiat to open the widget and see live pricing.`
      );
    }
  },
  {
    name: "getFiatQuote",
    description: "Get an estimated quote for buying crypto with USD via MoonPay.",
    schema: z.object({
      amountUsd: z.number().positive().describe("Amount in USD"),
      token: z.string().describe("Token symbol, e.g. 'ETH'"),
    }),
  },
);
