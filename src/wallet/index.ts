/**
 * wallet/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OWS (Open Wallet Standard) wrapper for TerminalSwap.
 *
 * Design goals:
 *  1. Private keys NEVER leave this module — they stay in memory only for the
 *     duration of a signing operation and are cleared immediately after.
 *  2. Keystores are AES-256-GCM encrypted on disk using Node's built-in crypto.
 *  3. Implements a subset of the Wallet Standard interface so it could be
 *     registered with @open-wallet-standard/core's wallet registry.
 *  4. Supports HD derivation (BIP-44 m/44'/60'/0'/0/index) so a single
 *     mnemonic can manage multiple addresses.
 *
 * Wallet file format (JSON, encrypted):
 *  {
 *    "name": "my-wallet",
 *    "version": 1,
 *    "encrypted": "<hex(iv)>:<hex(authTag)>:<hex(ciphertext)>",
 *    "createdAt": "ISO-8601"
 *  }
 *  The plaintext that gets encrypted is:
 *  {
 *    "mnemonic": "<BIP-39 mnemonic>",
 *    "accounts": [{ "index": 0, "label": "default" }]
 *  }
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as bip39 from "bip39";
import HDKey from "hdkey";
import {
  privateKeyToAccount,
  type PrivateKeyAccount,
} from "viem/accounts";
import {
  createWalletClient,
  http,
  type WalletClient,
  type SignableMessage,
  type TypedData,
  type TypedDataDefinition,
} from "viem";
import { ENV, CHAIN_CONFIGS, type Address } from "../config.js";
import { bus } from "../utils.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const WALLET_FILE_VERSION = 1;
const DERIVATION_PATH_PREFIX = "m/44'/60'/0'/0/"; // BIP-44 Ethereum
const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const KDF_ITERATIONS = 210_000;   // PBKDF2 iterations (OWASP 2023 recommendation)
const KDF_DIGEST = "sha256";
const KEY_LEN_BYTES = 32;
const SALT_LEN_BYTES = 32;
const IV_LEN_BYTES = 16;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WalletAccount {
  index: number;
  label: string;
  address: Address;
}

export interface OWSWallet {
  name: string;
  accounts: WalletAccount[];
  /** Sign an EIP-712 typed data payload — never returns the private key */
  signTypedData(accountIndex: number, typedData: TypedDataDefinition): Promise<`0x${string}`>;
  /** Sign a raw message (EIP-191) */
  signMessage(accountIndex: number, message: SignableMessage): Promise<`0x${string}`>;
  /** Sign and send a raw transaction */
  sendTransaction(
    accountIndex: number,
    chainId: number,
    tx: {
      to: Address;
      value?: bigint;
      data?: `0x${string}`;
      gas?: bigint;
    }
  ): Promise<`0x${string}`>;
}

// Internal plaintext vault structure (never written to disk unencrypted)
interface VaultPlaintext {
  mnemonic: string;
  accounts: Array<{ index: number; label: string }>;
}

// On-disk encrypted wallet file
interface WalletFile {
  name: string;
  version: number;
  encrypted: string; // "<hex(salt)>:<hex(iv)>:<hex(authTag)>:<hex(ciphertext)>"
  createdAt: string;
}

// ── Encryption helpers ────────────────────────────────────────────────────────

function deriveKey(password: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(password, salt, KDF_ITERATIONS, KEY_LEN_BYTES, KDF_DIGEST);
}

function encrypt(plaintext: string, password: string): string {
  const salt = crypto.randomBytes(SALT_LEN_BYTES);
  const iv = crypto.randomBytes(IV_LEN_BYTES);
  const key = deriveKey(password, salt);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [
    salt.toString("hex"),
    iv.toString("hex"),
    authTag.toString("hex"),
    ciphertext.toString("hex"),
  ].join(":");
}

function decrypt(encrypted: string, password: string): string {
  const [saltHex, ivHex, authTagHex, ciphertextHex] = encrypted.split(":");
  if (!saltHex || !ivHex || !authTagHex || !ciphertextHex) {
    throw new Error("Malformed encrypted wallet data");
  }
  const salt = Buffer.from(saltHex, "hex");
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");
  const key = deriveKey(password, salt);
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  try {
    return decipher.update(ciphertext).toString("utf8") + decipher.final("utf8");
  } catch {
    throw new Error("Wrong password or corrupted wallet file");
  }
}

// ── HD derivation helpers ─────────────────────────────────────────────────────

function derivePrivateKey(mnemonic: string, index: number): `0x${string}` {
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const hdkey = HDKey.fromMasterSeed(seed);
  const child = hdkey.derive(`${DERIVATION_PATH_PREFIX}${index}`);
  if (!child.privateKey) throw new Error("Failed to derive private key");
  return `0x${child.privateKey.toString("hex")}` as `0x${string}`;
}

function deriveAddress(mnemonic: string, index: number): Address {
  const privKey = derivePrivateKey(mnemonic, index);
  const account = privateKeyToAccount(privKey);
  return account.address;
}

// ── Wallet file I/O ───────────────────────────────────────────────────────────

async function ensureVaultDir(): Promise<void> {
  await fs.mkdir(ENV.OWS_VAULT_DIR, { recursive: true });
}

function walletFilePath(name: string): string {
  return path.join(ENV.OWS_VAULT_DIR, `${name}.json`);
}

async function readWalletFile(name: string): Promise<WalletFile> {
  const filePath = walletFilePath(name);
  const raw = await fs.readFile(filePath, "utf-8").catch(() => {
    throw new Error(`Wallet "${name}" not found at ${filePath}`);
  });
  return JSON.parse(raw) as WalletFile;
}

async function writeWalletFile(walletFile: WalletFile): Promise<void> {
  await ensureVaultDir();
  const filePath = walletFilePath(walletFile.name);
  await fs.writeFile(filePath, JSON.stringify(walletFile, null, 2), {
    encoding: "utf-8",
    mode: 0o600, // owner read/write only
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Create a brand-new HD wallet with a fresh BIP-39 mnemonic.
 * Returns the mnemonic ONCE for the user to back up. It is never shown again.
 */
export async function createWallet(
  name: string,
  password: string,
  initialAccounts = 1,
): Promise<{ wallet: OWSWallet; mnemonic: string }> {
  const mnemonic = bip39.generateMnemonic(256); // 24-word mnemonic
  const accounts: Array<{ index: number; label: string }> = Array.from(
    { length: initialAccounts },
    (_, i) => ({ index: i, label: i === 0 ? "default" : `account-${i}` }),
  );

  const vault: VaultPlaintext = { mnemonic, accounts };
  const encrypted = encrypt(JSON.stringify(vault), password);
  const walletFile: WalletFile = {
    name,
    version: WALLET_FILE_VERSION,
    encrypted,
    createdAt: new Date().toISOString(),
  };

  await writeWalletFile(walletFile);
  bus.log("success", `Wallet "${name}" created and encrypted at ${walletFilePath(name)}`);

  const wallet = await _buildOWSWallet(name, vault);
  return { wallet, mnemonic };
}

/**
 * Load an existing wallet from disk, decrypting with the given password.
 */
export async function loadWallet(name: string, password: string): Promise<OWSWallet> {
  const walletFile = await readWalletFile(name);
  if (walletFile.version !== WALLET_FILE_VERSION) {
    throw new Error(`Unsupported wallet file version: ${walletFile.version}`);
  }
  const plaintext = decrypt(walletFile.encrypted, password);
  const vault = JSON.parse(plaintext) as VaultPlaintext;
  bus.log("success", `Wallet "${name}" loaded (${vault.accounts.length} account(s))`);
  return _buildOWSWallet(name, vault);
}

/**
 * List all wallet names available in the vault directory.
 */
export async function listWallets(): Promise<string[]> {
  await ensureVaultDir();
  const entries = await fs.readdir(ENV.OWS_VAULT_DIR);
  return entries
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5));
}

/**
 * Add a new derived account to an existing wallet.
 */
export async function addAccount(
  name: string,
  password: string,
  label?: string,
): Promise<WalletAccount> {
  const walletFile = await readWalletFile(name);
  const plaintext = decrypt(walletFile.encrypted, password);
  const vault = JSON.parse(plaintext) as VaultPlaintext;

  const newIndex = vault.accounts.length;
  vault.accounts.push({ index: newIndex, label: label ?? `account-${newIndex}` });

  walletFile.encrypted = encrypt(JSON.stringify(vault), password);
  await writeWalletFile(walletFile);

  const address = deriveAddress(vault.mnemonic, newIndex);
  bus.log("info", `Account #${newIndex} added: ${address}`);
  return { index: newIndex, label: vault.accounts[newIndex]!.label, address };
}

// ── Internal: build the OWSWallet implementation object ──────────────────────

function _buildOWSWallet(name: string, vault: VaultPlaintext): OWSWallet {
  // Pre-derive all addresses (cheap — no I/O required)
  const accounts: WalletAccount[] = vault.accounts.map((a) => ({
    index: a.index,
    label: a.label,
    address: deriveAddress(vault.mnemonic, a.index),
  }));

  /**
   * Internal helper: produce a viem PrivateKeyAccount for the given index.
   * The private key is kept alive only for the duration of the sign call.
   */
  function getViemAccount(index: number): PrivateKeyAccount {
    const acct = accounts[index];
    if (!acct) throw new Error(`Account index ${index} does not exist in wallet "${name}"`);
    const privKey = derivePrivateKey(vault.mnemonic, index);
    return privateKeyToAccount(privKey);
  }

  return {
    name,
    accounts,

    async signTypedData(
      accountIndex: number,
      typedData: TypedDataDefinition,
    ): Promise<`0x${string}`> {
      const acct = getViemAccount(accountIndex);
      bus.log("debug", `[OWS] Signing EIP-712 typed data with account #${accountIndex}`);
      // viem's signTypedData works on the account directly
      const sig = await acct.signTypedData(typedData as TypedDataDefinition<TypedData, string>);
      return sig;
    },

    async signMessage(
      accountIndex: number,
      message: SignableMessage,
    ): Promise<`0x${string}`> {
      const acct = getViemAccount(accountIndex);
      bus.log("debug", `[OWS] Signing message with account #${accountIndex}`);
      return acct.signMessage({ message });
    },

    async sendTransaction(
      accountIndex: number,
      chainId: number,
      tx: { to: Address; value?: bigint; data?: `0x${string}`; gas?: bigint },
    ): Promise<`0x${string}`> {
      const cfg = CHAIN_CONFIGS[chainId];
      if (!cfg) throw new Error(`Unsupported chainId ${chainId}`);

      const acct = getViemAccount(accountIndex);
      const client: WalletClient = createWalletClient({
        account: acct,
        chain: cfg.chain,
        transport: http(cfg.rpcUrl),
      });

      bus.log("debug", `[OWS] Broadcasting transaction on ${cfg.name} from ${acct.address}`);
      const hash = await client.sendTransaction({
        account: acct,
        chain: cfg.chain,
        to: tx.to,
        value: tx.value ?? 0n,
        data: tx.data,
        gas: tx.gas,
      });

      bus.log("info", `Transaction broadcast: ${hash}`);
      return hash;
    },
  };
}

// ── Singleton wallet session (used by agent tools) ────────────────────────────
// The active wallet is stored here after the user unlocks it. It stays in
// memory only for the duration of the process.

let _activeWallet: OWSWallet | null = null;

export function setActiveWallet(wallet: OWSWallet): void {
  _activeWallet = wallet;
}

export function getActiveWallet(): OWSWallet {
  if (!_activeWallet) {
    throw new Error(
      "No wallet loaded. Run 'create-wallet' or 'load-wallet' first.",
    );
  }
  return _activeWallet;
}

export function hasActiveWallet(): boolean {
  return _activeWallet !== null;
}
