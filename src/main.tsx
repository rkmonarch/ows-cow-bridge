/**
 * main.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Terminal UI for TerminalSwap.
 *
 * Uses Node.js readline for input (no raw-mode / TTY requirement — works in
 * VS Code integrated terminal, bun, piped environments, etc.) and chalk +
 * ANSI escape codes for coloured output.
 *
 * The Ink approach was dropped because bun's process.stdin does not expose
 * setRawMode, which prevented any keystrokes from being captured.
 */

import "dotenv/config";
import readline from "node:readline";
import chalk from "chalk";
import type { BaseMessage } from "@langchain/core/messages";
import { buildAgentGraph, runAgentTurn, type AgentGraph } from "./agent.js";
import {
  bus,
  type LogEntry,
  type LogLevel,
} from "./utils.js";
import { hasActiveWallet, getActiveWallet } from "./wallet/index.js";
import { ENV } from "./config.js";

// ── ANSI helpers ──────────────────────────────────────────────────────────────

const RESET  = "\x1b[0m";
const BOLD   = "\x1b[1m";
const DIM    = "\x1b[2m";
const CYAN   = "\x1b[36m";
const GREEN  = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED    = "\x1b[31m";
const GRAY   = "\x1b[90m";
const BGREEN = "\x1b[92m";
const BWHITE = "\x1b[97m";
const MAG    = "\x1b[35m";

function c(color: string, text: string) { return `${color}${text}${RESET}`; }

const LEVEL_COLOR: Record<LogLevel, string> = {
  info:    CYAN,
  success: GREEN,
  warn:    YELLOW,
  error:   RED,
  debug:   GRAY,
};

// ── Print helpers ─────────────────────────────────────────────────────────────

function ts(): string {
  return new Date().toTimeString().slice(0, 8);
}

function printHeader() {
  const walletInfo = hasActiveWallet()
    ? `${c(CYAN, "wallet:")} ${c(BWHITE, getActiveWallet().name)}  ${c(GRAY, "│")}  ${c(CYAN, "acct:")} ${c(MAG, (getActiveWallet().accounts[0]?.address?.slice(0, 6) ?? "") + "…" + (getActiveWallet().accounts[0]?.address?.slice(-4) ?? "none"))}`
    : c(GRAY, "no wallet loaded");

  const w = process.stdout.columns ?? 90;
  const line = "─".repeat(w);

  process.stdout.write(
    `\n${c(BOLD + BGREEN, "┌" + line + "┐")}\n` +
    `${c(BGREEN, "│")}  ${c(BOLD + BGREEN, "TerminalSwap")} ${c(GRAY, "v1.0")}  ${c(GRAY, "│")}  ${walletInfo}  ${c(GRAY, "│")}  ${c(YELLOW, "model: " + ENV.LLM_MODEL)}${c(BGREEN, "│")}\n` +
    `${c(BOLD + BGREEN, "└" + line + "┘")}\n\n`,
  );
}

function printWelcome() {
  printHeader();
  const lines = [
    c(YELLOW, "⚙ system") + c(GRAY, ` ${ts()}`),
    "  Welcome to TerminalSwap! Type a command, e.g.:",
    c(GRAY, "    • swap 0.5 ETH to USDC on Base"),
    c(GRAY, "    • bridge 100 USDC from Arbitrum to Ethereum"),
    c(GRAY, "    • buy $200 of ETH with card"),
    c(GRAY, "    • show my balances on Base and Arbitrum"),
    c(GRAY, "    • create-wallet myWallet    (first-time setup)"),
    c(GRAY, "    • load-wallet myWallet      (unlock existing)"),
    "",
    `  ${c(CYAN, "LLM:")} ${ENV.LLM_MODEL}  ${c(CYAN, "Keys:")} ${ENV.OPENAI_API_KEY ? c(GREEN, "✓") : c(RED, "✗ set OPENAI_API_KEY")}`,
    "",
    c(GRAY, "  Type 'exit' to quit."),
    "",
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

function printLog(entry: LogEntry) {
  const color = LEVEL_COLOR[entry.level];
  const prefix = entry.level === "debug" ? c(GRAY, "  [dbg]") : c(color, `  [${entry.level}]`);
  process.stdout.write(`${c(GRAY, ts())} ${prefix} ${c(color, entry.message)}\n`);
}

function printUserMessage(text: string) {
  process.stdout.write(`\n${c(BGREEN, "▶ you")} ${c(GRAY, ts())}\n  ${c(BWHITE, text)}\n\n`);
}

function printAssistantMessage(text: string) {
  process.stdout.write(`${c(CYAN, "◆ agent")} ${c(GRAY, ts())}\n`);
  // Word-wrap at terminal width, indented 2 spaces
  const width = (process.stdout.columns ?? 90) - 4;
  const words = text.split(" ");
  let line = "  ";
  for (const word of words) {
    // Handle newlines in the agent response
    if (word.includes("\n")) {
      const parts = word.split("\n");
      for (let i = 0; i < parts.length; i++) {
        if (i === 0) {
          line += parts[i] + " ";
        } else {
          process.stdout.write(line.trimEnd() + "\n");
          line = "  " + (parts[i] ? parts[i] + " " : "");
        }
      }
    } else if ((line + word).length > width) {
      process.stdout.write(line.trimEnd() + "\n");
      line = "  " + word + " ";
    } else {
      line += word + " ";
    }
  }
  if (line.trim()) process.stdout.write(line.trimEnd() + "\n");
  process.stdout.write("\n");
}

function printSystemMessage(text: string) {
  process.stdout.write(`${c(YELLOW, "⚙ system")} ${c(GRAY, ts())}\n  ${c(YELLOW, text)}\n\n`);
}

function printSeparator() {
  const w = process.stdout.columns ?? 90;
  process.stdout.write(c(GRAY, "─".repeat(w)) + "\n");
}

function printPrompt() {
  // Re-print wallet info above prompt if wallet changed
  const prompt =
    `\n${c(BGREEN, "▶")} `;
  process.stdout.write(prompt);
}

// ── Confirmation flow ─────────────────────────────────────────────────────────

let _confirmResolver: ((approved: boolean) => void) | null = null;
let _inConfirmMode = false;

bus.on("confirm:request", (data: { prompt: string; txId: string }) => {
  _inConfirmMode = true;
  process.stdout.write("\n");
  printSeparator();
  process.stdout.write(c(YELLOW + BOLD, "⚠  CONFIRMATION REQUIRED\n\n"));
  // Print each line of the confirmation prompt
  for (const line of data.prompt.split("\n")) {
    process.stdout.write(c(YELLOW, "  " + line) + "\n");
  }
  process.stdout.write("\n" + c(YELLOW + BOLD, "  Type YES to approve, anything else to cancel: "));
});

// Called by readline when user presses Enter during confirm mode
function handleConfirmInput(line: string) {
  _inConfirmMode = false;
  const approved = line.trim().toUpperCase() === "YES";
  printSeparator();
  printSystemMessage(approved ? "✅ Confirmed — signing…" : "❌ Cancelled.");
  if (_confirmResolver) {
    _confirmResolver(approved);
    _confirmResolver = null;
  }
}

// Patch bus.awaitConfirmation to wire into our readline flow
// (overrides the Promise-based version in utils.ts for this runtime)
import { awaitConfirmation as _origAwait } from "./utils.js";
// Re-export a readline-compatible version
export async function awaitConfirmationCLI(
  prompt: string,
  txId: string,
  timeoutMs = 120_000,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      _inConfirmMode = false;
      _confirmResolver = null;
      reject(new Error("Confirmation timed out"));
    }, timeoutMs);

    _confirmResolver = (approved) => {
      clearTimeout(timer);
      resolve(approved);
    };

    bus.requestConfirmation(prompt, txId);
  });
}

// Monkey-patch the utils module's awaitConfirmation via the bus
// The tools call bus.requestConfirmation + listen on confirm:response,
// so we just need to make sure handleConfirmInput fires bus.confirmationResponse.
// That's already wired: handleConfirmInput → bus.confirmationResponse (below).

// ── Main readline loop ────────────────────────────────────────────────────────

async function main() {
  // Validate API key
  if (!ENV.OPENAI_API_KEY && !ENV.ANTHROPIC_API_KEY) {
    process.stderr.write(
      c(RED, "\n⚠  No LLM API key found!\n") +
      "   Set OPENAI_API_KEY in your .env file. See .env.example.\n\n",
    );
    process.exit(1);
  }

  // Subscribe to log events and print them in real-time
  bus.on("log", (entry: LogEntry) => {
    // Don't print debug logs unless DEBUG=1
    if (entry.level === "debug" && !process.env["DEBUG"]) return;
    printLog(entry);
  });

  // Build agent (lazy — first query initialises it)
  let agentGraph: AgentGraph | null = null;
  const conversationHistory: BaseMessage[] = [];

  function getGraph(): AgentGraph {
    if (!agentGraph) {
      agentGraph = buildAgentGraph();
    }
    return agentGraph;
  }

  // Print welcome screen
  printWelcome();

  // Set up readline
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    prompt: "",
  });

  // Keep the process alive
  rl.on("close", () => {
    process.stdout.write(c(GRAY, "\nBye!\n"));
    process.exit(0);
  });

  let isProcessing = false;

  printPrompt();

  rl.on("line", async (rawLine) => {
    const line = rawLine.trim();

    // ── Confirmation mode: route to confirm handler ─────────────────────────
    if (_inConfirmMode) {
      const approved = line.toUpperCase() === "YES";
      bus.confirmationResponse("pending", approved);
      handleConfirmInput(line);
      if (!isProcessing) printPrompt();
      return;
    }

    if (!line) {
      printPrompt();
      return;
    }

    // ── Local commands ──────────────────────────────────────────────────────
    if (line === "exit" || line === "quit" || line === "/exit") {
      process.stdout.write(c(GRAY, "Bye!\n"));
      process.exit(0);
    }

    if (line === "clear" || line === "/clear") {
      process.stdout.write("\x1b[2J\x1b[H"); // clear screen
      printWelcome();
      printPrompt();
      return;
    }

    if (line === "header" || line === "/header") {
      printHeader();
      printPrompt();
      return;
    }

    if (isProcessing) {
      process.stdout.write(c(YELLOW, "  Agent is busy, please wait…\n"));
      printPrompt();
      return;
    }

    // ── Send to agent ───────────────────────────────────────────────────────
    printUserMessage(line);
    isProcessing = true;

    try {
      const graph = getGraph();
      const { response, updatedHistory } = await runAgentTurn(
        graph,
        conversationHistory,
        line,
      );

      // Update history in-place
      conversationHistory.length = 0;
      conversationHistory.push(...updatedHistory);

      if (response) {
        printAssistantMessage(response);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      bus.log("error", `Agent error: ${msg}`);
      printAssistantMessage(`⚠️  Error: ${msg}`);
    } finally {
      isProcessing = false;
      printPrompt();
    }
  });
}

main().catch((err) => {
  process.stderr.write(chalk.red(`Fatal: ${err.message}\n`));
  process.exit(1);
});
