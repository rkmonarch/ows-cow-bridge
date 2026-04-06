/**
 * agent.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * LangGraph ReAct agent wiring.
 *
 * Architecture:
 *  ┌─────────────┐       ┌──────────────┐       ┌──────────────┐
 *  │  User Input │──────▶│  LLM (GPT-4o)│──────▶│  Tool Nodes  │
 *  └─────────────┘       │  + Tool Calls│◀──────│ (swap/bridge)│
 *                        └──────────────┘       └──────────────┘
 *
 * State: a growing list of BaseMessages (MessagesAnnotation).
 * The graph loops: LLM → tools → LLM → … until the LLM emits no tool calls.
 */

import { ChatOpenAI } from "@langchain/openai";
import {
  BaseMessage,
  HumanMessage,
  SystemMessage,
  type AIMessage,
} from "@langchain/core/messages";
import { StateGraph, MessagesAnnotation, END } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import type { DynamicStructuredTool } from "@langchain/core/tools";
import { ALL_TOOLS } from "./tools/index.js";
import { ENV, MAX_AGENT_ITERATIONS } from "./config.js";
import { bus } from "./utils.js";

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are TerminalSwap, an expert DeFi assistant that helps users:
- Swap tokens on the same chain using CoW Protocol (best price, MEV protection)
- Bridge tokens across chains using Across Protocol (fast, capital-efficient)
- Check wallet balances across multiple EVM chains
- Buy crypto with fiat via MoonPay
- Manage spending policies on their OWS wallet

## Your personality
- Concise and technical but friendly
- Always confirm you understand the user's intent before executing
- State the chain, amounts, and fees clearly in your responses
- Use the tools provided — don't make up transactions or balances

## Safety rules (NON-NEGOTIABLE)
1. ALWAYS call getSwapQuote or getBridgeQuote BEFORE executing any trade
2. The execution tools (executeSwap, executeBridge) will automatically request
   user confirmation. You do not need to ask for confirmation in text — the
   tool does it.
3. If a user asks you to skip confirmation, politely decline
4. If a policy violation occurs, explain it clearly and suggest alternatives
5. Never suggest workarounds to bypass OWS policies

## Chain names you recognize
ethereum / eth / mainnet → chainId 1
base → chainId 8453
arbitrum / arb → chainId 42161
optimism / op → chainId 10
polygon / matic → chainId 137

## Token symbols you know
ETH, WETH, USDC, USDT, DAI, WBTC, OP, ARB, MATIC

## Workflow for swap requests
1. Call getSwapQuote to get live pricing
2. Present the quote clearly
3. Call executeSwap (it handles confirmation internally)
4. Report the outcome with the CoW order ID

## Workflow for bridge requests
1. Call getBridgeQuote for fees and time estimate
2. Present the quote clearly
3. Call executeBridge (it handles confirmation internally)
4. Report deposit and fill tx hashes

## Workflow for "buy with card and swap"
1. Call getFiatQuote to show pricing
2. Call fundWithFiat to open MoonPay
3. Inform the user to complete the purchase then return
4. Optionally set up the swap for after the tokens arrive

## If the user hasn't loaded a wallet
Suggest they run "create-wallet my-wallet" or "load-wallet my-wallet" first.`;

// ── LLM + tools binding ───────────────────────────────────────────────────────

type BoundLLM = ReturnType<ChatOpenAI["bindTools"]>;

export function createLLM(): BoundLLM {
  if (!ENV.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY not set in .env");
  }
  const llm = new ChatOpenAI({
    model: ENV.LLM_MODEL,
    temperature: 0,
    streaming: true,
    openAIApiKey: ENV.OPENAI_API_KEY,
  });
  // bindTools returns a Runnable — we type it explicitly so addNode accepts it
  return llm.bindTools([...ALL_TOOLS] as DynamicStructuredTool[]);
}

// ── Graph definition ───────────────────────────────────────────────────────────

type AgentState = typeof MessagesAnnotation.State;

/**
 * LLM node: prepend the system prompt on the first call, then invoke the model.
 */
function makeLLMNode(llm: BoundLLM) {
  return async function llmNode(state: AgentState): Promise<Partial<AgentState>> {
    const messages = state.messages;

    const withSystem: BaseMessage[] =
      messages.length > 0 && messages[0] instanceof SystemMessage
        ? messages
        : [new SystemMessage(SYSTEM_PROMPT), ...messages];

    bus.log("debug", `[Agent] LLM call (${withSystem.length} msgs)`);
    const response = await llm.invoke(withSystem);
    return { messages: [response] };
  };
}

/**
 * Conditional router: after LLM, go to tools if there are tool_calls, else END.
 */
function routeAfterLLM(state: AgentState): "tools" | typeof END {
  const last = state.messages.at(-1) as AIMessage | undefined;
  if (!last) return END;

  const toolCalls = last.tool_calls ?? [];
  if (toolCalls.length > 0) {
    bus.log("debug", `[Agent] Routing to tools: ${toolCalls.map((t) => t.name).join(", ")}`);
    return "tools";
  }
  return END;
}

// ── Build and compile the graph ────────────────────────────────────────────────

export function buildAgentGraph() {
  const llm = createLLM();
  const toolNode = new ToolNode([...ALL_TOOLS] as DynamicStructuredTool[]);
  const llmNodeFn = makeLLMNode(llm);

  const graph = new StateGraph(MessagesAnnotation)
    .addNode("llm", llmNodeFn)
    .addNode("tools", toolNode)
    .addEdge("__start__", "llm")
    .addConditionalEdges("llm", routeAfterLLM, {
      tools: "tools",
      [END]: END,
    })
    .addEdge("tools", "llm");

  return graph.compile();
}

export type AgentGraph = ReturnType<typeof buildAgentGraph>;

// ── Agent runner ───────────────────────────────────────────────────────────────

/**
 * Run one conversational turn. Returns the final assistant text and the
 * updated message history for the next turn.
 */
export async function runAgentTurn(
  graph: AgentGraph,
  conversationHistory: BaseMessage[],
  userInput: string,
): Promise<{ response: string; updatedHistory: BaseMessage[] }> {
  const newHistory = [...conversationHistory, new HumanMessage(userInput)];
  const updatedHistory: BaseMessage[] = [...newHistory];
  let finalResponse = "";

  bus.log("debug", `[Agent] Turn: "${userInput.slice(0, 60)}"`);

  const stream = await graph.stream(
    { messages: newHistory },
    { recursionLimit: MAX_AGENT_ITERATIONS },
  );

  for await (const chunk of stream) {
    // Each chunk is a Record<nodeName, {messages: BaseMessage[]}>
    for (const nodeOutput of Object.values(chunk)) {
      const output = nodeOutput as { messages?: BaseMessage[] } | undefined;
      if (!output?.messages) continue;

      for (const msg of output.messages) {
        updatedHistory.push(msg);

        const msgType = msg.getType();
        if (msgType !== "ai") continue;

        const aiMsg = msg as AIMessage;
        const hasToolCalls = (aiMsg.tool_calls?.length ?? 0) > 0;
        if (hasToolCalls) continue; // intermediate step

        // Collect final text
        if (typeof aiMsg.content === "string") {
          finalResponse = aiMsg.content;
        } else if (Array.isArray(aiMsg.content)) {
          for (const part of aiMsg.content) {
            if (typeof part === "object" && "type" in part && part.type === "text") {
              finalResponse += (part as { text: string }).text;
            }
          }
        }
      }
    }
  }

  return { response: finalResponse, updatedHistory };
}
