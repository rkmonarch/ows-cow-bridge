/**
 * tools/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Central export of all LangGraph-compatible tools.
 * Import this array and pass it to the agent node.
 */

export { getBalancesTool, createWalletTool, loadWalletTool, listWalletsTool, setPoliciesTool } from "./wallet.js";
export { getSwapQuoteTool, executeSwapTool } from "./swap.js";
export { getBridgeQuoteTool, executeBridgeTool } from "./bridge.js";
export { fundWithFiatTool, getFiatQuoteTool } from "./fiat.js";

import { getBalancesTool, createWalletTool, loadWalletTool, listWalletsTool, setPoliciesTool } from "./wallet.js";
import { getSwapQuoteTool, executeSwapTool } from "./swap.js";
import { getBridgeQuoteTool, executeBridgeTool } from "./bridge.js";
import { fundWithFiatTool, getFiatQuoteTool } from "./fiat.js";

/** All tools exposed to the LangGraph agent */
export const ALL_TOOLS = [
  // Wallet management
  getBalancesTool,
  createWalletTool,
  loadWalletTool,
  listWalletsTool,
  setPoliciesTool,
  // Swapping
  getSwapQuoteTool,
  executeSwapTool,
  // Bridging
  getBridgeQuoteTool,
  executeBridgeTool,
  // Fiat on-ramp
  fundWithFiatTool,
  getFiatQuoteTool,
] as const;

export type AllTools = typeof ALL_TOOLS;
