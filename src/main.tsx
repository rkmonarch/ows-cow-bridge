/**
 * main.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Ink (React-in-terminal) entry point for TerminalSwap.
 *
 * Layout (auto-sized to terminal width):
 * ┌────────────────────────────────────────────────────────────────────────┐
 * │  TerminalSwap  v1.0  │  wallet: my-wallet  │  acct: 0x1234…abcd      │
 * ├────────────────┬───────────────────────────────────────────────────────┤
 * │  Chat          │  Balances / Pending Txs / Logs (tabbed side panel)   │
 * │  [messages]    │                                                       │
 * │                │                                                       │
 * ├────────────────┴───────────────────────────────────────────────────────┤
 * │  > Type your command…  [ENTER to send]  [TAB to switch panel]         │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * Keyboard shortcuts:
 *  Enter        → Send message / confirm YES
 *  Ctrl+C       → Exit
 *  Tab          → Cycle side panel tabs
 *  Ctrl+L       → Clear chat
 */

import "dotenv/config";
import React, { useState, useEffect, useCallback, useRef } from "react";
import { render, Box, Text, useInput, useApp, Static } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import type { BaseMessage } from "@langchain/core/messages";
import { buildAgentGraph, runAgentTurn, type AgentGraph } from "./agent.js";
import { bus, type LogEntry, type PendingTx, type LogLevel } from "./utils.js";
import { hasActiveWallet, getActiveWallet } from "./wallet/index.js";
import { ENV } from "./config.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  ts: Date;
}

interface ConfirmRequest {
  txId: string;
  prompt: string;
}

type SidePanel = "logs" | "txs";

// ── Color helpers ─────────────────────────────────────────────────────────────

const LEVEL_COLOR: Record<LogLevel, string> = {
  info:    "cyan",
  success: "green",
  warn:    "yellow",
  error:   "red",
  debug:   "gray",
};

// ── Sub-components ────────────────────────────────────────────────────────────

/** Single chat bubble */
const ChatBubble: React.FC<{ msg: ChatMessage }> = ({ msg }) => {
  const isUser = msg.role === "user";
  const isSystem = msg.role === "system";
  const timeStr = msg.ts.toTimeString().slice(0, 8);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text
          color={isSystem ? "yellow" : isUser ? "greenBright" : "cyanBright"}
          bold
        >
          {isSystem ? "⚙ system" : isUser ? "▶ you" : "◆ agent"}
        </Text>
        <Text color="gray" dimColor>
          {" "}
          {timeStr}
        </Text>
      </Box>
      <Box paddingLeft={2}>
        <Text
          color={isSystem ? "yellow" : isUser ? "white" : "white"}
          wrap="wrap"
        >
          {msg.content}
        </Text>
      </Box>
    </Box>
  );
};

/** Log line */
const LogLine: React.FC<{ entry: LogEntry }> = ({ entry }) => {
  const timeStr = entry.ts.toTimeString().slice(0, 8);
  return (
    <Box>
      <Text color="gray">{timeStr} </Text>
      <Text
        color={LEVEL_COLOR[entry.level] as Parameters<typeof Text>[0]["color"]}
      >
        {entry.message}
      </Text>
    </Box>
  );
};

/** Pending transaction row */
const TxRow: React.FC<{ tx: PendingTx }> = ({ tx }) => {
  const statusColor =
    tx.status === "confirmed" ? "green" :
    tx.status === "failed"    ? "red"   : "yellow";
  const statusIcon =
    tx.status === "confirmed" ? "✓" :
    tx.status === "failed"    ? "✗" : "…";

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={statusColor} bold>{statusIcon} </Text>
        <Text wrap="wrap">{tx.label}</Text>
      </Box>
      {tx.hash && (
        <Box paddingLeft={2}>
          <Text color="gray" dimColor>
            {tx.hash.slice(0, 10)}…{tx.hash.slice(-8)}
          </Text>
        </Box>
      )}
    </Box>
  );
};

// ── Main App ──────────────────────────────────────────────────────────────────

const App: React.FC = () => {
  const { exit } = useApp();

  // Chat history shown in the main pane
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "system",
      content:
        "Welcome to TerminalSwap! Type a command like:\n" +
        "  • swap 0.5 ETH to USDC on Base\n" +
        "  • bridge 100 USDC from Arbitrum to Ethereum\n" +
        "  • buy $200 of ETH with card\n" +
        "  • show my balances on Base and Arbitrum\n" +
        "  • create-wallet myWallet    (first-time setup)\n" +
        "  • load-wallet myWallet      (unlock existing)\n\n" +
        `LLM: ${ENV.LLM_MODEL} | Keys: ${ENV.OPENAI_API_KEY ? "✓" : "✗ (set OPENAI_API_KEY)"}`,
      ts: new Date(),
    },
  ]);

  // LangGraph conversation state (for multi-turn memory)
  const conversationHistory = useRef<BaseMessage[]>([]);

  // LangGraph agent (lazy-init on first use)
  const agentGraph = useRef<AgentGraph | null>(null);

  // Input state
  const [inputValue, setInputValue] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [activePanel, setActivePanel] = useState<SidePanel>("logs");

  // Confirmation state
  const [pendingConfirm, setPendingConfirm] = useState<ConfirmRequest | null>(null);
  const [confirmInput, setConfirmInput] = useState("");

  // Side panel data
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [pendingTxs, setPendingTxs] = useState<PendingTx[]>([]);

  // Wallet display
  const [walletName, setWalletName] = useState<string>("-");
  const [walletAddr, setWalletAddr] = useState<string>("-");

  // ── Event bus subscriptions ─────────────────────────────────────────────────

  useEffect(() => {
    const handleLog = (entry: LogEntry) => {
      setLogs((prev) => [...prev.slice(-199), entry]); // keep last 200
    };

    const handleTxUpdate = (tx: PendingTx) => {
      setPendingTxs((prev) => {
        const idx = prev.findIndex((t) => t.id === tx.id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = tx;
          return next;
        }
        return [...prev, tx];
      });
    };

    const handleConfirmRequest = (data: { prompt: string; txId: string }) => {
      setPendingConfirm(data);
      setConfirmInput("");
    };

    bus.on("log", handleLog);
    bus.on("tx:update", handleTxUpdate);
    bus.on("confirm:request", handleConfirmRequest);

    return () => {
      bus.off("log", handleLog);
      bus.off("tx:update", handleTxUpdate);
      bus.off("confirm:request", handleConfirmRequest);
    };
  }, []);

  // Refresh wallet display when wallet changes
  useEffect(() => {
    const id = setInterval(() => {
      if (hasActiveWallet()) {
        const w = getActiveWallet();
        setWalletName(w.name);
        setWalletAddr(w.accounts[0]?.address ?? "-");
      }
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // ── Keyboard shortcuts ──────────────────────────────────────────────────────

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      exit();
      process.exit(0);
    }
    if (key.tab && !isProcessing && !pendingConfirm) {
      setActivePanel((p) => (p === "logs" ? "txs" : "logs"));
    }
    if (key.ctrl && input === "l") {
      setChatMessages([]);
    }
  });

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function pushChat(role: ChatMessage["role"], content: string) {
    setChatMessages((prev) => [
      ...prev,
      { id: `${Date.now()}-${Math.random()}`, role, content, ts: new Date() },
    ]);
  }

  function getOrCreateGraph(): AgentGraph {
    if (!agentGraph.current) {
      agentGraph.current = buildAgentGraph();
    }
    return agentGraph.current;
  }

  // ── Handle confirmation input ────────────────────────────────────────────────

  const handleConfirmSubmit = useCallback(
    (value: string) => {
      if (!pendingConfirm) return;
      const approved = value.trim().toUpperCase() === "YES";
      bus.confirmationResponse(pendingConfirm.txId, approved);
      setPendingConfirm(null);
      setConfirmInput("");
      pushChat("system", approved ? "✅ Confirmed — signing…" : "❌ Cancelled.");
    },
    [pendingConfirm],
  );

  // ── Handle normal chat input ─────────────────────────────────────────────────

  const handleSubmit = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return;
      setInputValue("");

      // Intercept local commands that don't need the LLM
      if (trimmed === "clear" || trimmed === "/clear") {
        setChatMessages([]);
        return;
      }
      if (trimmed === "exit" || trimmed === "/exit") {
        exit();
        process.exit(0);
      }

      pushChat("user", trimmed);
      setIsProcessing(true);
      bus.log("info", `User: ${trimmed.slice(0, 60)}${trimmed.length > 60 ? "…" : ""}`);

      try {
        const graph = getOrCreateGraph();
        const { response, updatedHistory } = await runAgentTurn(
          graph,
          conversationHistory.current,
          trimmed,
        );
        conversationHistory.current = updatedHistory;

        if (response) {
          pushChat("assistant", response);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        bus.log("error", `Agent error: ${msg}`);
        pushChat("assistant", `⚠️  Error: ${msg}`);
      } finally {
        setIsProcessing(false);
      }
    },
    [],
  );

  // ── Render ───────────────────────────────────────────────────────────────────

  const termWidth = process.stdout.columns ?? 120;
  const chatWidth = Math.floor(termWidth * 0.62);
  const panelWidth = termWidth - chatWidth - 3;

  return (
    <Box flexDirection="column" width={termWidth}>
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <Box
        borderStyle="round"
        borderColor="greenBright"
        paddingX={1}
        width={termWidth}
      >
        <Text color="greenBright" bold>
          TerminalSwap
        </Text>
        <Text color="gray"> v1.0  │  </Text>
        <Text color="cyan">wallet: </Text>
        <Text color="white">{walletName}</Text>
        <Text color="gray">  │  </Text>
        <Text color="cyan">acct: </Text>
        <Text color="magenta">
          {walletAddr !== "-"
            ? `${walletAddr.slice(0, 6)}…${walletAddr.slice(-4)}`
            : "no wallet loaded"}
        </Text>
        <Text color="gray">  │  </Text>
        <Text color="yellow">model: {ENV.LLM_MODEL}</Text>
      </Box>

      {/* ── Main area ──────────────────────────────────────────────────────── */}
      <Box flexDirection="row" width={termWidth}>
        {/* Chat pane */}
        <Box
          flexDirection="column"
          width={chatWidth}
          borderStyle="single"
          borderColor="gray"
          paddingX={1}
          height={24}
          overflow="hidden"
        >
          <Text color="gray" bold>
            Chat  [Ctrl+L clear]
          </Text>
          <Box flexDirection="column" overflow="hidden">
            {chatMessages.slice(-14).map((msg) => (
              <ChatBubble key={msg.id} msg={msg} />
            ))}
          </Box>
        </Box>

        {/* Side panel */}
        <Box
          flexDirection="column"
          width={panelWidth}
          borderStyle="single"
          borderColor="gray"
          paddingX={1}
          height={24}
          overflow="hidden"
        >
          {/* Tab bar */}
          <Box>
            <Text
              bold
              color={activePanel === "logs" ? "greenBright" : "gray"}
              underline={activePanel === "logs"}
            >
              Logs
            </Text>
            <Text color="gray">  </Text>
            <Text
              bold
              color={activePanel === "txs" ? "greenBright" : "gray"}
              underline={activePanel === "txs"}
            >
              Txs ({pendingTxs.length})
            </Text>
            <Text color="gray">  [TAB switch]</Text>
          </Box>

          {/* Panel content */}
          {activePanel === "logs" ? (
            <Box flexDirection="column" overflow="hidden">
              {logs.slice(-16).map((entry, i) => (
                <LogLine key={i} entry={entry} />
              ))}
            </Box>
          ) : (
            <Box flexDirection="column" overflow="hidden">
              {pendingTxs.length === 0 ? (
                <Text color="gray" dimColor>
                  No transactions yet.
                </Text>
              ) : (
                pendingTxs.slice(-8).map((tx) => (
                  <TxRow key={tx.id} tx={tx} />
                ))
              )}
            </Box>
          )}
        </Box>
      </Box>

      {/* ── Confirmation overlay ────────────────────────────────────────────── */}
      {pendingConfirm && (
        <Box
          flexDirection="column"
          borderStyle="double"
          borderColor="yellow"
          paddingX={2}
          paddingY={1}
          width={termWidth}
        >
          <Text color="yellow" bold>
            ⚠  CONFIRMATION REQUIRED
          </Text>
          <Text color="white" wrap="wrap">
            {pendingConfirm.prompt.split("\n").slice(0, 10).join("\n")}
          </Text>
          <Box marginTop={1}>
            <Text color="yellow" bold>
              Type YES to approve, or anything else to cancel:{" "}
            </Text>
            <TextInput
              value={confirmInput}
              onChange={setConfirmInput}
              onSubmit={handleConfirmSubmit}
              placeholder="YES / no"
            />
          </Box>
        </Box>
      )}

      {/* ── Input bar ──────────────────────────────────────────────────────── */}
      {!pendingConfirm && (
        <Box
          borderStyle="single"
          borderColor={isProcessing ? "yellow" : "greenBright"}
          paddingX={1}
          width={termWidth}
        >
          {isProcessing ? (
            <Box>
              <Text color="yellow">
                <Spinner type="dots" />
              </Text>
              <Text color="yellow"> Agent thinking…</Text>
            </Box>
          ) : (
            <Box>
              <Text color="greenBright" bold>
                ▶{" "}
              </Text>
              <TextInput
                value={inputValue}
                onChange={setInputValue}
                onSubmit={handleSubmit}
                placeholder="swap 0.5 ETH to USDC on Base  |  Ctrl+C exit  |  TAB panel"
              />
            </Box>
          )}
        </Box>
      )}

      {/* ── Help hint ──────────────────────────────────────────────────────── */}
      <Box>
        <Text color="gray" dimColor>
          Examples: "show balances on base"  •  "bridge 100 USDC arb→eth"  •  "buy $50 ETH with card"  •  "swap 1 WETH to DAI on mainnet"
        </Text>
      </Box>
    </Box>
  );
};

// ── Entry point ───────────────────────────────────────────────────────────────

// Validate essential environment
if (!ENV.OPENAI_API_KEY && !ENV.ANTHROPIC_API_KEY) {
  console.error(
    "\n⚠  No LLM API key found!\n" +
    "   Set OPENAI_API_KEY (or ANTHROPIC_API_KEY) in your .env file.\n" +
    "   See .env.example for reference.\n",
  );
  process.exit(1);
}

render(<App />);
