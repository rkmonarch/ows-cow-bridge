/**
 * tools/swap.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * CoW Protocol swap tool.
 *
 * Flow:
 *  1. getSwapQuote  → calls CoW OrderBook API, returns human-readable quote
 *  2. executeSwap   → builds the order, asks for user confirmation via the
 *                     event bus, signs with OWS, submits to CoW orderbook
 *
 * CoW Protocol uses off-chain signed orders (EIP-712) settled by solvers.
 * No gas is needed for the signing step — solvers pay gas and deduct from
 * the buy amount via the fee.
 *
 * Supported chains: Ethereum (1), Gnosis (100), Arbitrum (42161), Base (8453)
 * Note: Optimism is NOT currently in the CoW SDK SupportedChainId enum.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  OrderBookApi,
  OrderQuoteSideKindSell,
  SupportedChainId,
  SigningScheme,
  OrderKind,
  SellTokenSource,
  BuyTokenDestination,
  type OrderCreation,
  type OrderQuoteRequest,
} from "@cowprotocol/cow-sdk";
import { v4 as uuid } from "uuid";
import {
  resolveTokenAddress,
  resolveChain,
  getTokenDecimals,
  DEFAULT_SLIPPAGE_BPS,
  CHAIN_NAME_TO_ID,
  type Address,
} from "../config.js";
import {
  bus,
  awaitConfirmation,
  toTokenUnits,
  fromTokenUnits,
  shortAddr,
} from "../utils.js";
import { getActiveWallet } from "../wallet/index.js";
import { checkPolicies, recordTrade } from "../wallet/policies.js";

// ── CoW-supported chain IDs ────────────────────────────────────────────────────

const COW_CHAIN_IDS: Partial<Record<number, SupportedChainId>> = {
  1:     SupportedChainId.MAINNET,
  8453:  SupportedChainId.BASE,
  42161: SupportedChainId.ARBITRUM_ONE,
  100:   SupportedChainId.GNOSIS_CHAIN,
};

function getCowChainId(chainId: number): SupportedChainId {
  const cowId = COW_CHAIN_IDS[chainId];
  if (cowId === undefined) {
    throw new Error(
      `CoW Protocol not supported on chain ${chainId}. ` +
      `Supported: Ethereum (1), Base (8453), Arbitrum (42161), Gnosis (100).`,
    );
  }
  return cowId;
}

// Deadline: 30 minutes from now (CoW orders expire)
function getDeadline(): number {
  return Math.floor(Date.now() / 1000) + 30 * 60;
}

// ── getSwapQuote ──────────────────────────────────────────────────────────────

export interface SwapQuote {
  sellToken: Address;
  buyToken: Address;
  sellAmount: string;    // raw units
  buyAmount: string;     // raw units (after slippage applied)
  feeAmount: string;     // raw units (CoW fee)
  sellAmountHuman: string;
  buyAmountHuman: string;
  feeAmountHuman: string;
  slippageBps: number;
  chainId: number;
  chainName: string;
  fromSymbol: string;
  toSymbol: string;
  validTo: number;
  appData: string;
  /** Preserve raw quote for signing step */
  _rawOrder: OrderCreation;
}

export async function getSwapQuoteRaw(
  fromSymbol: string,
  toSymbol: string,
  amount: string,
  chainId: number,
  slippageBps: number = DEFAULT_SLIPPAGE_BPS,
  accountIndex = 0,
): Promise<SwapQuote> {
  const wallet = getActiveWallet();
  const acct = wallet.accounts[accountIndex];
  if (!acct) throw new Error(`Account index ${accountIndex} not found`);

  const chainCfg = resolveChain(chainId);
  const cowChainId = getCowChainId(chainId);
  const sellToken = resolveTokenAddress(fromSymbol, chainId);
  const buyToken = resolveTokenAddress(toSymbol, chainId);
  const sellAmountRaw = toTokenUnits(amount, fromSymbol).toString();

  const api = new OrderBookApi({ chainId: cowChainId });

  const quoteRequest: OrderQuoteRequest = {
    sellToken,
    buyToken,
    from: acct.address,
    receiver: acct.address,
    sellAmountBeforeFee: sellAmountRaw,
    kind: OrderQuoteSideKindSell.SELL,
    validTo: getDeadline(),
    sellTokenBalance: SellTokenSource.ERC20,
    buyTokenBalance: BuyTokenDestination.ERC20,
  };

  bus.log("info", `Getting CoW quote: ${amount} ${fromSymbol} → ${toSymbol} on ${chainCfg.name}`);

  const { quote } = await api.getQuote(quoteRequest);

  // Apply slippage: min received = buyAmount * (1 - slippage)
  const buyAmountRaw = BigInt(quote.buyAmount);
  const minBuyAmount = (buyAmountRaw * BigInt(10_000 - slippageBps)) / 10_000n;

  const rawOrder: OrderCreation = {
    sellToken: quote.sellToken as Address,
    buyToken: quote.buyToken as Address,
    sellAmount: quote.sellAmount,
    buyAmount: minBuyAmount.toString(),
    feeAmount: quote.feeAmount,
    validTo: quote.validTo,
    appData: quote.appData,
    partiallyFillable: false,
    receiver: acct.address,
    sellTokenBalance: SellTokenSource.ERC20,
    buyTokenBalance: BuyTokenDestination.ERC20,
    kind: OrderKind.SELL,
    signingScheme: SigningScheme.EIP712,
    signature: "0x" as Address,   // placeholder — filled during sign step
    from: acct.address,
  };

  return {
    sellToken: quote.sellToken as Address,
    buyToken: quote.buyToken as Address,
    sellAmount: quote.sellAmount,
    buyAmount: minBuyAmount.toString(),
    feeAmount: quote.feeAmount,
    sellAmountHuman: fromTokenUnits(BigInt(quote.sellAmount), fromSymbol),
    buyAmountHuman: fromTokenUnits(minBuyAmount, toSymbol),
    feeAmountHuman: fromTokenUnits(BigInt(quote.feeAmount), fromSymbol),
    slippageBps,
    chainId,
    chainName: chainCfg.name,
    fromSymbol: fromSymbol.toUpperCase(),
    toSymbol: toSymbol.toUpperCase(),
    validTo: quote.validTo,
    appData: String(quote.appData),
    _rawOrder: rawOrder,
  };
}

// ── getSwapQuote tool ─────────────────────────────────────────────────────────

export const getSwapQuoteTool = tool(
  async ({ fromToken, toToken, amount, chain, slippageBps, accountIndex }) => {
    const chainId =
      typeof chain === "number"
        ? chain
        : (() => {
            const id = CHAIN_NAME_TO_ID[chain.toLowerCase()];
            if (!id) throw new Error(`Unknown chain: ${chain}`);
            return id;
          })();

    const quote = await getSwapQuoteRaw(
      fromToken, toToken, amount, chainId,
      slippageBps ?? DEFAULT_SLIPPAGE_BPS,
      accountIndex ?? 0,
    );

    return (
      `CoW Swap Quote:\n` +
      `  Sell:     ${quote.sellAmountHuman} ${quote.fromSymbol}\n` +
      `  Buy:      ≥ ${quote.buyAmountHuman} ${quote.toSymbol}\n` +
      `  Fee:      ${quote.feeAmountHuman} ${quote.fromSymbol} (paid to solver)\n` +
      `  Chain:    ${quote.chainName}\n` +
      `  Slippage: ${(quote.slippageBps / 100).toFixed(2)}%\n` +
      `  Expires:  ${new Date(quote.validTo * 1000).toLocaleTimeString()}\n\n` +
      `To execute, call executeSwap with the same parameters.`
    );
  },
  {
    name: "getSwapQuote",
    description:
      "Get a live quote from CoW Protocol to swap one token for another on the same chain. " +
      "Does NOT sign or send anything. Supports chains: Ethereum, Base, Arbitrum, Gnosis.",
    schema: z.object({
      fromToken: z.string().describe("Symbol of the token to sell, e.g. 'ETH' or 'USDC'"),
      toToken: z.string().describe("Symbol of the token to buy"),
      amount: z.string().describe("Human-readable amount to sell, e.g. '0.5' or '100'"),
      chain: z.union([z.string(), z.number()]).describe("Chain name or EIP-155 ID, e.g. 'base' or 8453"),
      slippageBps: z.number().int().min(1).max(5000).optional()
        .describe("Slippage tolerance in basis points (50 = 0.5%). Default: 50"),
      accountIndex: z.number().int().min(0).optional()
        .describe("Wallet account index (0-based). Default: 0"),
    }),
  },
);

// ── executeSwap tool ──────────────────────────────────────────────────────────

// CoW GPv2Settlement contract address (same across all CoW chains)
const COW_SETTLEMENT: Address = "0x9008D19f58AAbD9eD0D60971565AA8510560ab41";

export const executeSwapTool = tool(
  async ({ fromToken, toToken, amount, chain, slippageBps, accountIndex }) => {
    const chainId =
      typeof chain === "number"
        ? chain
        : (() => {
            const id = CHAIN_NAME_TO_ID[chain.toLowerCase()];
            if (!id) throw new Error(`Unknown chain: ${chain}`);
            return id;
          })();

    const wallet = getActiveWallet();
    const acctIdx = accountIndex ?? 0;
    const acct = wallet.accounts[acctIdx];
    if (!acct) return `Account index ${acctIdx} not found.`;

    // 1. Fresh quote
    const quote = await getSwapQuoteRaw(
      fromToken, toToken, amount, chainId,
      slippageBps ?? DEFAULT_SLIPPAGE_BPS, acctIdx,
    );

    // 2. Policy check
    const policyResult = checkPolicies(wallet.name, {
      amountUsd: parseFloat(quote.sellAmountHuman) * 2500, // rough — improve with a price feed
      chainId,
      tokenSymbols: [quote.fromSymbol, quote.toSymbol],
    });
    if (!policyResult.allowed) {
      return `❌ Policy violation(s):\n${policyResult.violations.map((v) => `  - ${v}`).join("\n")}`;
    }

    // 3. Confirmation
    const txId = uuid();
    const confirmText =
      `┌──────────────────────────────────────┐\n` +
      `│       CoW SWAP CONFIRMATION          │\n` +
      `├──────────────────────────────────────┤\n` +
      `│  Sell:  ${quote.sellAmountHuman.padEnd(12)} ${quote.fromSymbol.padEnd(8)}    │\n` +
      `│  Buy:   ≥${quote.buyAmountHuman.padEnd(12)} ${quote.toSymbol.padEnd(8)}    │\n` +
      `│  Fee:   ${quote.feeAmountHuman.padEnd(12)} ${quote.fromSymbol.padEnd(8)}    │\n` +
      `│  Chain: ${quote.chainName.padEnd(28)}    │\n` +
      `│  Slip:  ${((quote.slippageBps / 100)).toFixed(2).padEnd(6)}%                    │\n` +
      `│  Acct:  ${shortAddr(acct.address).padEnd(28)}    │\n` +
      `└──────────────────────────────────────┘`;

    bus.log("warn", confirmText);

    const approved = await awaitConfirmation(confirmText, txId);
    if (!approved) return "❌ Swap cancelled by user.";

    // 4. Sign the CoW order (EIP-712)
    bus.log("info", "Signing CoW order with OWS wallet…");

    const domain = {
      name: "Gnosis Protocol",
      version: "v2",
      chainId: BigInt(chainId),
      verifyingContract: COW_SETTLEMENT,
    };

    const types = {
      Order: [
        { name: "sellToken",         type: "address" },
        { name: "buyToken",          type: "address" },
        { name: "receiver",          type: "address" },
        { name: "sellAmount",        type: "uint256" },
        { name: "buyAmount",         type: "uint256" },
        { name: "validTo",           type: "uint32"  },
        { name: "appData",           type: "bytes32" },
        { name: "feeAmount",         type: "uint256" },
        { name: "kind",              type: "bytes32" },
        { name: "partiallyFillable", type: "bool"    },
        { name: "sellTokenBalance",  type: "bytes32" },
        { name: "buyTokenBalance",   type: "bytes32" },
      ],
    } as const;

    // These keccak256 hashes are the CoW spec constants for kind/balance fields
    const ORDER_KIND_SELL =
      "0xf3b277728b3fee749481eb3e0b3b48980dbbab78658fc419025cb16447bc1892" as `0x${string}`;
    const BALANCE_ERC20 =
      "0x5a28e9363bb942b639270062aa6bb295f434bcdfc42c97267bf003f272060dc9" as `0x${string}`;

    const message = {
      sellToken:         quote.sellToken,
      buyToken:          quote.buyToken,
      receiver:          acct.address,
      sellAmount:        BigInt(quote.sellAmount),
      buyAmount:         BigInt(quote.buyAmount),
      validTo:           quote.validTo,
      appData:           quote.appData as `0x${string}`,
      feeAmount:         BigInt(quote.feeAmount),
      kind:              ORDER_KIND_SELL,
      partiallyFillable: false,
      sellTokenBalance:  BALANCE_ERC20,
      buyTokenBalance:   BALANCE_ERC20,
    };

    const signature = await wallet.signTypedData(acctIdx, {
      domain,
      types,
      primaryType: "Order",
      message,
    });

    // 5. Submit to CoW orderbook
    bus.log("info", "Submitting order to CoW Protocol orderbook…");
    const cowChainId = getCowChainId(chainId);
    const api = new OrderBookApi({ chainId: cowChainId });

    const orderCreation: OrderCreation = {
      ...quote._rawOrder,
      signature,
      signingScheme: SigningScheme.EIP712,
      from: acct.address,
    };

    const orderId = await api.sendOrder(orderCreation);
    bus.log("success", `Order submitted! ID: ${orderId}`);

    // 6. Record for policy tracking
    recordTrade(wallet.name, parseFloat(quote.sellAmountHuman) * 2500);

    return (
      `✅ CoW swap order submitted!\n` +
      `  Order ID: ${orderId}\n` +
      `  Selling:  ${quote.sellAmountHuman} ${quote.fromSymbol}\n` +
      `  Buying:   ≥ ${quote.buyAmountHuman} ${quote.toSymbol}\n` +
      `  Chain:    ${quote.chainName}\n` +
      `  Track at: https://explorer.cow.fi/orders/${orderId}\n\n` +
      `The CoW solver network will fill this order at the best available price.`
    );
  },
  {
    name: "executeSwap",
    description:
      "Execute a token swap on CoW Protocol. Fetches a fresh quote, displays a preview " +
      "with all fees, asks for explicit user confirmation, then signs with the OWS wallet " +
      "and submits the signed order to the CoW orderbook.",
    schema: z.object({
      fromToken: z.string().describe("Token to sell (symbol), e.g. 'ETH'"),
      toToken: z.string().describe("Token to buy (symbol), e.g. 'USDC'"),
      amount: z.string().describe("Amount to sell (human-readable), e.g. '0.5'"),
      chain: z.union([z.string(), z.number()]).describe("Chain name or EIP-155 ID"),
      slippageBps: z.number().int().min(1).max(5000).optional(),
      accountIndex: z.number().int().min(0).optional(),
    }),
  },
);
