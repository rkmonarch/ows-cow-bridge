# TerminalSwap

A production-ready terminal AI agent for DeFi — natural language swaps and cross-chain bridges, right from your shell.

```
┌───────────────────────────────────────────────────────────────────────────┐
│  TerminalSwap v1.0  │  wallet: my-wallet  │  acct: 0x1234…abcd           │
├────────────────────────────┬──────────────────────────────────────────────┤
│  ▶ you  12:34:01           │  Logs  Txs (1)  [TAB switch]                │
│  swap 0.5 ETH to USDC      │  12:34:02 Requesting CoW quote…             │
│  on Base                   │  12:34:03 Quote: 0.5 ETH → 1842.50 USDC    │
│                            │  12:34:04 Order submitted! ID: 0xabc…       │
│  ◆ agent  12:34:05         │                                             │
│  ✅ CoW swap order          │                                             │
│  submitted!                │                                             │
│  Order ID: 0xabc123…       │                                             │
├────────────────────────────┴──────────────────────────────────────────────┤
│  ▶ swap 0.5 ETH to USDC on Base    [ENTER send]  [TAB panel]  [Ctrl+C exit]│
└───────────────────────────────────────────────────────────────────────────┘
```

## Stack

| Layer | Library |
|---|---|
| Wallet & signing | `@open-wallet-standard/core` + `viem` (HD wallet, AES-256-GCM encrypted keystore) |
| Same-chain swaps | `@cowprotocol/cow-sdk` (CoW Protocol — MEV-protected, off-chain signed orders) |
| Cross-chain bridge | `@across-protocol/app-sdk` (Across Protocol — fast, capital-efficient) |
| Agent / LLM | `@langchain/langgraph` + `@langchain/openai` (GPT-4o ReAct agent) |
| Terminal UI | `ink` (React-in-terminal) |
| Chain interactions | `viem` (public clients, ABI encoding) |
| Validation | `zod` |

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env:
#   OPENAI_API_KEY=sk-...
#   OWS_VAULT_PASSWORD=your_passphrase
#   ETH_RPC_URL=https://eth.llamarpc.com   (or your own RPC)
```

### 3. Run

```bash
npm run dev
```

### 4. First-time setup

Once the terminal UI opens, create a wallet:

```
▶ create-wallet my-wallet
```

The agent will:
1. Generate a 24-word BIP-39 mnemonic
2. Encrypt the keystore with your password (AES-256-GCM)
3. Save to `~/.ows/wallets/my-wallet.json`
4. Apply default spending policies (max $10k/tx, $50k/day)

**Back up your mnemonic phrase immediately** — it is shown only once.

## Example Commands

```
# Balance check
show my balances on Base and Arbitrum

# Same-chain swap (CoW Protocol)
swap 0.5 ETH to USDC on Base
swap 100 USDC to WETH on Arbitrum

# Cross-chain bridge (Across Protocol)
bridge 100 USDC from Arbitrum to Ethereum
bridge 0.1 ETH from Base to Optimism

# Fiat on-ramp (MoonPay)
buy $200 of ETH with card
what's the rate if I buy $500 of USDC?

# Combined: buy and swap
buy $200 USDC on Base then swap half to WETH

# Wallet management
load-wallet my-wallet
set max transaction limit to $5000
allow only ETH and USDC trades
```

## Project Structure

```
src/
├── main.tsx          # Ink TUI app (React components, keyboard handling)
├── agent.ts          # LangGraph ReAct agent + GPT-4o wiring
├── config.ts         # Chain configs, token maps, environment
├── utils.ts          # Shared utilities, event bus, viem helpers
├── tools/
│   ├── index.ts      # All tools exported as an array
│   ├── wallet.ts     # getBalances, createWallet, loadWallet, setPolicies
│   ├── swap.ts       # getSwapQuote, executeSwap (CoW Protocol)
│   ├── bridge.ts     # getBridgeQuote, executeBridge (Across Protocol)
│   └── fiat.ts       # fundWithFiat, getFiatQuote (MoonPay)
└── wallet/
    ├── index.ts      # OWS wallet: create, load, sign (private keys never exposed)
    └── policies.ts   # Spending policies: maxAmount, allowedChains, dailyLimit
```

## Security Architecture

### Private Key Management
- Private keys are derived **in memory only** during signing — never persisted
- Keystores on disk are encrypted with **AES-256-GCM** + PBKDF2 (210,000 iterations)
- Key file permissions are set to `0600` (owner read/write only)

### OWS Spending Policies
Policies are checked before every signing operation:

```typescript
// Example: custom policies
set max transaction to $1000
allow only Base and Arbitrum
allow only ETH and USDC
set daily volume limit to $5000
```

### Confirmation Flow
Every transaction goes through explicit user confirmation:
1. Agent fetches a quote and displays full details (amounts, fees, chain, slippage)
2. A confirmation dialog appears: **Type YES to sign with OWS wallet**
3. Only after `YES` is typed does the signing occur
4. The private key is derived, used to sign, then immediately released

## Supported Networks

| Chain | Swap (CoW) | Bridge (Across) | Chain ID |
|---|---|---|---|
| Ethereum | ✓ | ✓ | 1 |
| Base | ✓ | ✓ | 8453 |
| Arbitrum One | ✓ | ✓ | 42161 |
| Optimism | ✓ | ✓ | 10 |
| Polygon | ✓ | ✓ | 137 |
| Gnosis Chain | ✓ | – | 100 |

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `Enter` | Send message / confirm |
| `Tab` | Switch side panel (Logs ↔ Txs) |
| `Ctrl+C` | Exit |
| `Ctrl+L` | Clear chat history |

## Adding New Chains

1. Add the chain config to `src/config.ts`:
```typescript
// In CHAIN_CONFIGS:
84532: {
  chain: baseSepolia,
  rpcUrl: "https://sepolia.base.org",
  name: "Base Sepolia",
  shortName: "base-sep",
  nativeCurrency: "ETH",
  explorerUrl: "https://sepolia.basescan.org",
  cowProtocolSupported: false,
  acrossSupported: true,
},
```

2. Add token addresses for the new chain in `TOKEN_ADDRESSES`.
3. Add the chain to the `CHAIN_NAME_TO_ID` alias map.

## Adding New Tools

Create a file in `src/tools/`, export a `tool()` from `@langchain/core/tools`, and add it to `ALL_TOOLS` in `src/tools/index.ts`. The agent will automatically have access to it.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | ✓ | GPT-4o API key |
| `OWS_VAULT_PASSWORD` | ✓ | Wallet encryption password |
| `ETH_RPC_URL` | – | Ethereum RPC (defaults to llamarpc) |
| `BASE_RPC_URL` | – | Base RPC |
| `ARB_RPC_URL` | – | Arbitrum RPC |
| `OP_RPC_URL` | – | Optimism RPC |
| `POLYGON_RPC_URL` | – | Polygon RPC |
| `MOONPAY_PUBLISHABLE_KEY` | – | For fiat on-ramp |
| `MOONPAY_SECRET_KEY` | – | For signed MoonPay URLs |
| `COINGECKO_API_KEY` | – | For price lookups (free tier works) |
| `LLM_MODEL` | – | LLM model ID (default: `gpt-4o`) |

## License

MIT
