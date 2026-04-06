/**
 * tools/bridge.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Cross-chain bridge tool using Across Protocol's app-sdk.
 *
 * Flow:
 *  1. getBridgeQuote  → calls Across API, returns quote with fee/time estimate
 *  2. executeBridge   → builds deposit calldata, confirms with user,
 *                       signs & broadcasts via OWS wallet
 *
 * Across works via SpokePool contracts on each chain. To bridge:
 *  - Call `depositV3()` on the origin chain's SpokePool
 *  - Across relayers pick it up and fill on the destination chain
 *
 * Supported bridging routes: any chain pair where Across has SpokePool deployed.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { AcrossClient } from "@across-protocol/app-sdk";
import {
  mainnet, base, arbitrum, optimism, polygon,
  type Chain,
} from "viem/chains";
import { v4 as uuid } from "uuid";
import {
  CHAIN_CONFIGS,
  CHAIN_NAME_TO_ID,
  resolveTokenAddress,
  resolveChain,
  getTokenDecimals,
  ACROSS_INTEGRATOR_ID,
  type Address,
} from "../config.js";
import {
  bus,
  awaitConfirmation,
  toTokenUnits,
  fromTokenUnits,
  shortAddr,
  explorerTxUrl,
  waitForTx,
  getPublicClient,
} from "../utils.js";
import { getActiveWallet } from "../wallet/index.js";
import { checkPolicies, recordTrade } from "../wallet/policies.js";

// ── Across client singleton ───────────────────────────────────────────────────

let _acrossClient: AcrossClient | null = null;

function getAcrossClient(): AcrossClient {
  if (_acrossClient) return _acrossClient;

  const chains: Chain[] = [mainnet, base, arbitrum, optimism, polygon];

  _acrossClient = AcrossClient.create({
    chains,
    integratorId: ACROSS_INTEGRATOR_ID,
    useTestnet: false,
    logLevel: "ERROR", // suppress verbose SDK logs in terminal
  });

  return _acrossClient;
}

// ── getBridgeQuote ─────────────────────────────────────────────────────────────

export interface BridgeQuote {
  originChainId: number;
  destinationChainId: number;
  originChainName: string;
  destinationChainName: string;
  tokenSymbol: string;
  inputAmount: string;       // raw units
  outputAmount: string;      // raw units (after fees)
  inputAmountHuman: string;
  outputAmountHuman: string;
  lpFeePct: string;          // as a decimal string e.g. "0.0010"
  relayerCapitalFeePct: string;
  totalFeePct: string;
  estimatedFillTimeSeconds: number;
  inputToken: Address;
  outputToken: Address;
  // Raw quote for building the deposit tx
  _rawQuote: unknown;
}

export async function getBridgeQuoteRaw(
  fromChain: string | number,
  toChain: string | number,
  tokenSymbol: string,
  amount: string,
  accountIndex = 0,
): Promise<BridgeQuote> {
  const wallet = getActiveWallet();
  const acct = wallet.accounts[accountIndex];
  if (!acct) throw new Error(`Account index ${accountIndex} not found`);

  const originCfg = resolveChain(fromChain);
  const destCfg = resolveChain(toChain);
  const originChainId = originCfg.chain.id;
  const destChainId = destCfg.chain.id;

  if (!originCfg.acrossSupported) {
    throw new Error(`Across Protocol not supported on ${originCfg.name}`);
  }
  if (!destCfg.acrossSupported) {
    throw new Error(`Across Protocol not supported on ${destCfg.name}`);
  }

  const inputToken = resolveTokenAddress(tokenSymbol, originChainId);
  const outputToken = resolveTokenAddress(tokenSymbol, destChainId);
  const rawAmount = toTokenUnits(amount, tokenSymbol);

  const client = getAcrossClient();

  bus.log("info", `Getting Across quote: ${amount} ${tokenSymbol} ${originCfg.name} → ${destCfg.name}`);

  const quote = await client.getQuote({
    route: {
      originChainId,
      destinationChainId: destChainId,
      inputToken,
      outputToken,
      isNative: inputToken.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    },
    inputAmount: rawAmount,
    recipient: acct.address,
    crossChainMessage: undefined,
  });

  const fees = quote.fees;
  const outputAmount = quote.deposit.outputAmount;

  const decimals = getTokenDecimals(tokenSymbol);

  return {
    originChainId,
    destinationChainId: destChainId,
    originChainName: originCfg.name,
    destinationChainName: destCfg.name,
    tokenSymbol: tokenSymbol.toUpperCase(),
    inputAmount: rawAmount.toString(),
    outputAmount: outputAmount.toString(),
    inputAmountHuman: fromTokenUnits(rawAmount, tokenSymbol),
    outputAmountHuman: fromTokenUnits(outputAmount, tokenSymbol),
    lpFeePct: (Number(fees.lpFee.pct) / 1e18).toFixed(6),
    relayerCapitalFeePct: (Number(fees.relayerCapitalFee.pct) / 1e18).toFixed(6),
    totalFeePct: (Number(fees.totalRelayFee.pct) / 1e18).toFixed(6),
    estimatedFillTimeSeconds: quote.estimatedFillTimeSec,
    inputToken,
    outputToken,
    _rawQuote: quote,
  };
}

export const getBridgeQuoteTool = tool(
  async ({ fromChain, toChain, token, amount, accountIndex }) => {
    const quote = await getBridgeQuoteRaw(fromChain, toChain, token, amount, accountIndex ?? 0);

    const mins = Math.ceil(quote.estimatedFillTimeSeconds / 60);
    return (
      `Across Bridge Quote:\n` +
      `  From:       ${quote.originChainName}\n` +
      `  To:         ${quote.destinationChainName}\n` +
      `  Send:       ${quote.inputAmountHuman} ${quote.tokenSymbol}\n` +
      `  Receive:    ${quote.outputAmountHuman} ${quote.tokenSymbol}\n` +
      `  LP Fee:     ${(parseFloat(quote.lpFeePct) * 100).toFixed(4)}%\n` +
      `  Relay Fee:  ${(parseFloat(quote.relayerCapitalFeePct) * 100).toFixed(4)}%\n` +
      `  Est. time:  ~${mins} min\n\n` +
      `To execute, call executeBridge with the same parameters.`
    );
  },
  {
    name: "getBridgeQuote",
    description:
      "Get a cross-chain bridge quote from Across Protocol. " +
      "Does NOT sign or send anything.",
    schema: z.object({
      fromChain: z.union([z.string(), z.number()]).describe("Origin chain (name or EIP-155 ID)"),
      toChain: z.union([z.string(), z.number()]).describe("Destination chain (name or EIP-155 ID)"),
      token: z.string().describe("Token symbol, e.g. 'USDC' or 'ETH'"),
      amount: z.string().describe("Human-readable amount to bridge"),
      accountIndex: z.number().int().min(0).optional(),
    }),
  },
);

// ── executeBridge ─────────────────────────────────────────────────────────────

export const executeBridgeTool = tool(
  async ({ fromChain, toChain, token, amount, accountIndex }) => {
    const wallet = getActiveWallet();
    const acctIdx = accountIndex ?? 0;
    const acct = wallet.accounts[acctIdx];
    if (!acct) return `Account index ${acctIdx} not found.`;

    // 1. Get fresh quote
    const quote = await getBridgeQuoteRaw(fromChain, toChain, token, amount, acctIdx);

    // 2. Policy check
    const policyResult = checkPolicies(wallet.name, {
      amountUsd: parseFloat(quote.inputAmountHuman) * 2000, // rough estimate
      chainId: quote.originChainId,
      tokenSymbols: [quote.tokenSymbol],
    });
    if (!policyResult.allowed) {
      return `❌ Policy violation(s):\n${policyResult.violations.map((v) => `  - ${v}`).join("\n")}`;
    }

    const mins = Math.ceil(quote.estimatedFillTimeSeconds / 60);

    // 3. Confirmation prompt
    const txId = uuid();
    const confirmText =
      `┌─────────────────────────────────────────┐\n` +
      `│        ACROSS BRIDGE CONFIRMATION       │\n` +
      `├─────────────────────────────────────────┤\n` +
      `│  From:    ${quote.originChainName.padEnd(22)}        │\n` +
      `│  To:      ${quote.destinationChainName.padEnd(22)}        │\n` +
      `│  Send:    ${quote.inputAmountHuman.padEnd(12)} ${quote.tokenSymbol.padEnd(8)}      │\n` +
      `│  Receive: ${quote.outputAmountHuman.padEnd(12)} ${quote.tokenSymbol.padEnd(8)}      │\n` +
      `│  Time:    ~${mins} min                          │\n` +
      `│  Account: ${shortAddr(acct.address).padEnd(22)}        │\n` +
      `└─────────────────────────────────────────┘\n` +
      `Type YES to sign with OWS wallet:`;

    bus.log("warn", confirmText);

    // 4. Wait for confirmation
    const approved = await awaitConfirmation(confirmText, txId);
    if (!approved) return "❌ Bridge cancelled by user.";

    // 5. Build and send the deposit transaction via Across SDK
    bus.log("info", "Building Across deposit transaction…");

    const client = getAcrossClient();
    const rawQuote = quote._rawQuote as Awaited<ReturnType<typeof client.getQuote>>;

    // The Across app-sdk provides executeQuote which handles the deposit tx
    bus.log("info", `Sending deposit on ${quote.originChainName}…`);

    let depositTxHash: `0x${string}` | undefined;
    let fillTxHash: `0x${string}` | undefined;

    await client.executeQuote({
      walletClient: {
        // Shim: provide the methods Across SDK expects
        account: { address: acct.address },
        chain: CHAIN_CONFIGS[quote.originChainId]!.chain,
        sendTransaction: async (tx: {
          to: string;
          value?: bigint;
          data: `0x${string}`;
          gas?: bigint;
          chainId?: number;
        }) => {
          const hash = await wallet.sendTransaction(acctIdx, quote.originChainId, {
            to: tx.to as Address,
            value: tx.value,
            data: tx.data,
            gas: tx.gas,
          });
          depositTxHash = hash;
          bus.log("success", `Deposit tx: ${hash}`);
          bus.log("info", `Track: ${explorerTxUrl(quote.originChainId, hash)}`);
          return hash;
        },
      } as Parameters<typeof client.executeQuote>[0]["walletClient"],
      deposit: rawQuote.deposit,
      onProgress: (progress) => {
        const step = progress.step;
        if (step === "approve") {
          bus.log("info", "Approving token spend…");
          if (progress.status === "txSuccess") {
            bus.log("success", `Approval confirmed: ${progress.txReceipt?.transactionHash}`);
          }
        } else if (step === "deposit") {
          if (progress.status === "txSuccess") {
            bus.log("success", "Deposit confirmed on origin chain. Waiting for fill…");
          }
        } else if (step === "fill") {
          if (progress.status === "txSuccess") {
            fillTxHash = progress.txReceipt?.transactionHash as `0x${string}`;
            bus.log("success", `Bridge filled on ${quote.destinationChainName}!`);
            if (fillTxHash) {
              bus.log("info", `Fill tx: ${explorerTxUrl(quote.destinationChainId, fillTxHash)}`);
            }
          }
        }
      },
    });

    // 6. Record trade for policy
    recordTrade(wallet.name, parseFloat(quote.inputAmountHuman) * 2000);

    return (
      `✅ Bridge complete!\n` +
      `  Bridged:     ${quote.inputAmountHuman} ${quote.tokenSymbol}\n` +
      `  Received:    ${quote.outputAmountHuman} ${quote.tokenSymbol}\n` +
      `  From:        ${quote.originChainName}\n` +
      `  To:          ${quote.destinationChainName}\n` +
      (depositTxHash ? `  Deposit tx:  ${depositTxHash}\n` : "") +
      (fillTxHash    ? `  Fill tx:     ${fillTxHash}\n`    : "")
    );
  },
  {
    name: "executeBridge",
    description:
      "Bridge tokens cross-chain using Across Protocol. Fetches a quote, " +
      "shows preview with fees and time estimate, asks for explicit confirmation, " +
      "then signs the deposit transaction with OWS and broadcasts it.",
    schema: z.object({
      fromChain: z.union([z.string(), z.number()]).describe("Origin chain (name or EIP-155 ID)"),
      toChain: z.union([z.string(), z.number()]).describe("Destination chain"),
      token: z.string().describe("Token symbol to bridge"),
      amount: z.string().describe("Amount to bridge (human-readable)"),
      accountIndex: z.number().int().min(0).optional(),
    }),
  },
);
