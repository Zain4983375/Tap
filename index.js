/**
 * 💎 Official JJH TipBot — Modern UI Edition
 * Same logic, fully restyled outputs: branded embeds, avatars & link buttons.
 * + 🌧️ Tip Rain: plain `!tip` (or `!tip <count>`) rains on random active members.
 * + 🎉 Keyword Giveaway: `!gstart <word> <usd> <minutes>` — type the word to enter.
 * Tips pay out in USDC (SPL) — $1 = 1 USDC. Faucet still pays 0.001 SOL gas money.
 */
require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { Connection, PublicKey, LAMPORTS_PER_SOL, Keypair, SystemProgram, Transaction } = require('@solana/web3.js');
const { getOrCreateAssociatedTokenAccount, createTransferInstruction, getAssociatedTokenAddress } = require('@solana/spl-token');
const sqlite3 = require('sqlite3');
const axios = require('axios');
const fs = require('fs');

// ═══════════════════════════════════════════════════════════
// 🎨 JJH UI KIT — one design language for every output
// ═══════════════════════════════════════════════════════════
const BRAND = {
  primary: 0x8B5CF6, // JJH purple
  success: 0x00E5A0, // mint
  error:   0xFF4D6D, // coral red
  gold:    0xF5C518, // VIP gold
  info:    0x38BDF8, // sky
};
const SOLSCAN_TX = (sig) => `https://solscan.io/tx/${sig}`;
const FOOTER = '💎 Official JJH TipBot • Powered by Solana';

function baseEmbed(color = BRAND.primary) {
  return new EmbedBuilder().setColor(color).setTimestamp().setFooter({ text: FOOTER });
}
function okEmbed(title, description = '') {
  return baseEmbed(BRAND.success).setTitle(`✅ ${title}`).setDescription(description);
}
function errEmbed(description) {
  return baseEmbed(BRAND.error).setTitle('❌ Something went wrong').setDescription(description);
}
function infoEmbed(title, description = '') {
  return baseEmbed(BRAND.info).setTitle(title).setDescription(description);
}
function goldEmbed(title, description = '') {
  return baseEmbed(BRAND.gold).setTitle(title).setDescription(description);
}
/** Clickable "View on Solscan" button row */
function solscanRow(signature) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('🔍 View on Solscan')
      .setStyle(ButtonStyle.Link)
      .setURL(SOLSCAN_TX(signature))
  )];
}
/** Standard error reply (auto-deletes like before) */
async function replyError(message, text, delDelay = 10000) {
  const reply = await message.reply({ embeds: [errEmbed(text)] });
  autoDeleteErrorMessage(reply, delDelay);
  autoDeleteErrorMessage(message, delDelay);
  return reply;
}
/**
 * Dismiss-style delivery for sensitive lists (pending tips): the list
 * posts in the SAME channel the command was used in, then deletes
 * itself (and the command message) after `delDelay` ms — like a
 * dismissable message. No DM. Returns 'reply' | null.
 */
async function sendPrivate(message, payload, delDelay = 30000) {
  try {
    const reply = await message.reply(payload);
    autoDeleteErrorMessage(reply, delDelay);
    autoDeleteErrorMessage(message, delDelay);
    return 'reply';
  } catch {
    return null;
  }
}
const shortAddr = (a) => (a ? `\`${a.slice(0, 4)}…${a.slice(-4)}\`` : '`—`');
const fmtUSD = (n) => `$${Number(n).toFixed(2)}`;
const fmtSOL = (n, d = 4) => `${Number(n).toFixed(d)} SOL`;
const fmtUSDC = (n, d = 2) => `${Number(n).toFixed(d)} USDC`;
const avatarOf = (user) => (user?.displayAvatarURL ? user.displayAvatarURL() : null);
// Who to ping when the vault needs a refill (used by every low-balance message)
const REFILL_ADMINS = '<@637927094319579140> or <@235836165716967424>';

// ═══════════════════════════════════════════════════════════
// 🗄️ DATABASE (unchanged)
// ═══════════════════════════════════════════════════════════
// DATA_DIR: Railway par volume mount point (e.g. /data). Local/Pterodactyl par default.
const DATA_DIR = process.env.DATA_DIR || '/home/container/data';
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new sqlite3.Database(`${DATA_DIR}/bot.db`);
db.run('PRAGMA journal_mode = WAL');
db.run('PRAGMA synchronous = NORMAL');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    discord_id TEXT PRIMARY KEY,
    username TEXT,
    wallet TEXT,
    balance_usd REAL DEFAULT 0,
    total_tipped REAL DEFAULT 0,
    total_received REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id TEXT,
    receiver_id TEXT,
    amount_usd REAL,
    amount_sol REAL,
    signature TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS permissions (
    discord_id TEXT PRIMARY KEY,
    can_tip INTEGER DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS pending_tips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id TEXT,
    receiver_id TEXT,
    amount_usd REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    processed INTEGER DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);

  db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('faucet_enabled', 'true')`);

  // Chat activity tracking — powers the Tip Rain pool (active chatters only)
  db.run(`CREATE TABLE IF NOT EXISTS activity (
    discord_id TEXT,
    guild_id TEXT,
    last_seen INTEGER,
    PRIMARY KEY (discord_id, guild_id)
  )`);

  // Keyword giveaways — one active per guild; entries survive restarts.
  // status: 'active' | 'ended' | 'cancelled'. winner_id/signature set at draw time.
  db.run(`CREATE TABLE IF NOT EXISTS giveaways (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    word TEXT NOT NULL,
    prize_usd REAL NOT NULL,
    ends_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    winner_id TEXT,
    signature TEXT,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS giveaway_entries (
    giveaway_id INTEGER NOT NULL,
    discord_id TEXT NOT NULL,
    PRIMARY KEY (giveaway_id, discord_id)
  )`);

  // DB-level guarantee: at most one ACTIVE giveaway per guild, even if two
  // !gstart commands land at the same moment.
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_giveaway ON giveaways (guild_id) WHERE status = 'active'`);

  db.run(`ALTER TABLE transactions ADD COLUMN amount_sol REAL`, (err) => {
    if (err && err.message.includes('duplicate column name')) {} else if (err) {
      console.error('Error adding amount_sol:', err.message);
    }
  });

  db.run(`ALTER TABLE transactions ADD COLUMN amount_usdc REAL`, (err) => {
    if (err && err.message.includes('duplicate column name')) {} else if (err) {
      console.error('Error adding amount_usdc:', err.message);
    }
  });
});

function dbGet(sql, params) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function dbRun(sql, params) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function dbAll(sql, params) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function autoDeleteReply(interaction, delay = 15000) {
  setTimeout(() => {
    interaction.deleteReply().catch(() => {});
  }, delay);
}

async function autoDeleteErrorMessage(message, delay = 10000) {
  setTimeout(() => {
    message.delete().catch(() => {});
  }, delay);
}

// ═══════════════════════════════════════════════════════════
// ⛓️ SOLANA (unchanged)
// ═══════════════════════════════════════════════════════════
const connection = new Connection(
  process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
  'confirmed'
);

let botKeypair = null;
if (process.env.BOT_WALLET_PRIVATE_KEY) {
  try {
    const privateKeyBytes = Buffer.from(process.env.BOT_WALLET_PRIVATE_KEY, 'base64');
    botKeypair = Keypair.fromSecretKey(privateKeyBytes);
    console.log(`Bot wallet loaded: ${botKeypair.publicKey.toString()}`);
  } catch (error) {
    console.error('Failed to load bot wallet:', error);
  }
}

let cachedPrice = null;
let priceCacheTime = 0;

async function getSolPrice() {
  const now = Date.now();
  if (cachedPrice && (now - priceCacheTime) < 30000) {
    return cachedPrice;
  }

  const sources = [
    { name: 'CoinGecko', url: 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', parse: (data) => data.solana?.usd },
    { name: 'Binance', url: 'https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT', parse: (data) => parseFloat(data.price) },
    { name: 'Coinbase', url: 'https://api.coinbase.com/v2/prices/SOL-USD/spot', parse: (data) => parseFloat(data.data?.amount) },
    { name: 'Kraken', url: 'https://api.kraken.com/0/public/Ticker?pair=SOLUSD', parse: (data) => { const pair = data.result?.SOLUSD; return pair ? parseFloat(pair.c[0]) : null; } }
  ];

  for (const source of sources) {
    try {
      const response = await axios.get(source.url, { timeout: 3000 });
      const price = source.parse(response.data);
      if (price && price > 0) {
        cachedPrice = price;
        priceCacheTime = now;
        console.log(`✅ SOL Price updated from ${source.name}: $${cachedPrice}`);
        return cachedPrice;
      }
    } catch (error) {
      console.log(`❌ Failed to fetch from ${source.name}:`, error.message);
    }
  }

  if (cachedPrice && (now - priceCacheTime) < 300000) {
    console.log(`⚠️ Using cached SOL price: $${cachedPrice}`);
    return cachedPrice;
  }

  const fallbackPrice = 130;
  console.log(`⚠️ Using fallback SOL price: $${fallbackPrice}`);
  return fallbackPrice;
}

// ── USDC (SPL) — tips pay out in USDC, $1 = 1 USDC ──
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const USDC_DECIMALS = 6;
// SOL the vault must always keep for tx fees + token-account rent (~0.002 SOL
// per first-time recipient). Checked before every payout batch.
const MIN_SOL_BUFFER = 0.01;
const RENT_PER_NEW_ATA = 0.0021;
const MAX_SEND_ATTEMPTS = 3; // per transfer, with backoff, on transient RPC errors

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** True for errors worth retrying: rate limits, timeouts, expired blockhashes. */
function isTransientRpcError(error) {
  const msg = String(error?.message || error || '').toLowerCase();
  return (
    msg.includes('429') || msg.includes('too many requests') ||
    msg.includes('timeout') || msg.includes('timed out') ||
    msg.includes('blockhash') || msg.includes('expired') ||
    msg.includes('econnreset') || msg.includes('socket hang up') ||
    msg.includes('failed to get') || msg.includes('network')
  );
}

/**
 * Sends a transaction built fresh on every attempt (fresh blockhash), confirms
 * with the object form ({ signature, blockhash, lastValidBlockHeight }) and
 * retries transient RPC failures up to MAX_SEND_ATTEMPTS with backoff.
 * If confirmation fails after the send went out, the signature status is
 * checked before any retry — so a landed transaction is never sent twice.
 * buildTx: () => Transaction (unsigned; blockhash + feePayer are set here).
 */
async function sendTxWithRetry(buildTx, signers) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
    let signature = null;
    try {
      const tx = buildTx();
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
      tx.feePayer = botKeypair.publicKey;
      signature = await connection.sendTransaction(tx, signers);
      await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
      return { success: true, signature };
    } catch (error) {
      lastError = error;
      // The send may have landed even though confirmation failed — check the
      // signature before retrying, or we risk paying the same tip twice.
      if (signature) {
        try {
          const status = await connection.getSignatureStatus(signature);
          const confirmation = status?.value?.confirmationStatus;
          if (confirmation === 'confirmed' || confirmation === 'finalized') {
            return { success: true, signature };
          }
          // Not seen yet — it may still be propagating. One delayed re-check.
          if (!status?.value) {
            await sleep(2000);
            const retry = await connection.getSignatureStatus(signature);
            const confirmation2 = retry?.value?.confirmationStatus;
            if (confirmation2 === 'confirmed' || confirmation2 === 'finalized') {
              return { success: true, signature };
            }
          }
        } catch { /* fall through to retry logic */ }
      }
      console.error(`Send attempt ${attempt}/${MAX_SEND_ATTEMPTS} failed:`, error?.message || error);
      if (attempt < MAX_SEND_ATTEMPTS && isTransientRpcError(error)) {
        await sleep(1000 * attempt); // 1s, then 2s
        continue;
      }
      break;
    }
  }
  return { success: false, error: lastError, transient: isTransientRpcError(lastError) };
}

async function getBalance(address) {
  try {
    const pubkey = new PublicKey(address);
    const balance = await connection.getBalance(pubkey);
    return balance / LAMPORTS_PER_SOL;
  } catch { return 0; }
}

/** USDC balance of a wallet (0 when it has no USDC token account yet). */
async function getUSDCBalance(address) {
  try {
    const owner = new PublicKey(address);
    const ata = await getAssociatedTokenAddress(USDC_MINT, owner);
    const bal = await connection.getTokenAccountBalance(ata);
    return Number(bal.value.uiAmount || 0);
  } catch { return 0; }
}

/**
 * One-shot vault check before a payout: USDC for the payout itself + SOL for
 * fees and token-account rent. Returns which side is short, if any.
 * recipientCount: worst-case rent assumes every recipient is brand new.
 */
async function checkVaultFunds(requiredUSDC, recipientCount = 1) {
  if (!botKeypair) throw new Error('Bot wallet not configured');
  const botAddress = botKeypair.publicKey.toString();
  const [usdc, sol] = await Promise.all([
    getUSDCBalance(botAddress),
    getBalance(botAddress),
  ]);
  if (usdc < requiredUSDC) return { ok: false, shortOn: 'usdc', usdc, sol };
  const requiredSOL = MIN_SOL_BUFFER + (RENT_PER_NEW_ATA * recipientCount);
  if (sol < requiredSOL) return { ok: false, shortOn: 'sol', usdc, sol };
  return { ok: true, shortOn: null, usdc, sol };
}

/** Plain-language vault message naming exactly which asset is short. */
function vaultShortMessage(shortOn) {
  const botAddress = botKeypair.publicKey.toString();
  if (shortOn === 'usdc') {
    return `**Bot vault is low on USDC!**\nPlease ask ${REFILL_ADMINS} to refill it with USDC.\n${shortAddr(botAddress)}`;
  }
  return `**Bot vault is low on SOL for network fees!**\nPlease ask ${REFILL_ADMINS} to top it up with SOL.\n${shortAddr(botAddress)}`;
}

// Faucet-only SOL sender (tips now pay USDC — see sendUSDC below).
// Errors are reported honestly: insufficient funds vs network trouble are
// different problems and get different messages.
async function sendSOL(toAddress, amountSOL) {
  if (!botKeypair) {
    return { success: false, error: 'Bot wallet not configured' };
  }

  try {
    const toPublicKey = new PublicKey(toAddress);
    if (toPublicKey.toString() === '11111111111111111111111111111111') {
      return { success: false, error: 'Invalid recipient address' };
    }

    const lamports = Math.floor(amountSOL * LAMPORTS_PER_SOL);
    if (lamports < 5000) {
      return { success: false, error: 'Amount too small. Minimum: 0.000005 SOL' };
    }

    const balance = await connection.getBalance(botKeypair.publicKey);
    const feeBuffer = 10000;

    if (balance < lamports + feeBuffer) {
      const botAddress = botKeypair.publicKey.toString();
      return {
        success: false,
        insufficient: true,
        error: `❌ Bot wallet has insufficient SOL!\nPlease ask ${REFILL_ADMINS} to refill the bot wallet.\nBot Address: ${botAddress}`
      };
    }

    const res = await sendTxWithRetry(() => new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: botKeypair.publicKey,
        toPubkey: toPublicKey,
        lamports: lamports,
      })
    ), [botKeypair]);

    if (!res.success) {
      if (res.transient) {
        return { success: false, transient: true, error: `Network hiccup talking to Solana — please try again in a moment. (${res.error?.message || 'RPC error'})` };
      }
      return { success: false, error: `Transfer failed: ${res.error?.message || 'unknown error'}` };
    }

    return { success: true, signature: res.signature, amount: amountSOL };
  } catch (error) {
    console.error('SOL transfer failed:', error);
    return { success: false, error: `Transfer failed: ${error.message}` };
  }
}

/** Resolves (creating if needed) a USDC token account, retrying transient RPC errors. */
async function getOrCreateATAWithRetry(mint, owner) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
    try {
      return await getOrCreateAssociatedTokenAccount(connection, botKeypair, mint, owner);
    } catch (error) {
      lastError = error;
      if (attempt < MAX_SEND_ATTEMPTS && isTransientRpcError(error)) {
        await sleep(1000 * attempt);
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

/**
 * Pays USDC (SPL) to a wallet address. $1 = 1 USDC, no price conversion.
 * The recipient's token account is created on demand — the bot pays the rent
 * (~0.002 SOL) for first-time recipients, the only way a new user can receive.
 * Uses the same modern blockhash/confirm + retry path as sendSOL.
 */
async function sendUSDC(toAddress, amountUSDC) {
  if (!botKeypair) {
    return { success: false, error: 'Bot wallet not configured' };
  }
  if (!amountUSDC || amountUSDC <= 0) {
    return { success: false, error: 'Amount must be greater than 0.' };
  }

  const amountBase = Math.floor(amountUSDC * 10 ** USDC_DECIMALS);
  if (amountBase <= 0) {
    return { success: false, error: 'Amount is too small.' };
  }

  try {
    const toOwner = new PublicKey(toAddress);
    if (toOwner.toString() === '11111111111111111111111111111111') {
      return { success: false, error: 'Invalid recipient address' };
    }

    // Bot's own USDC account (must exist — the vault is funded with USDC).
    const fromAta = await getAssociatedTokenAddress(USDC_MINT, botKeypair.publicKey);
    // Recipient's account — created on demand, bot pays the rent.
    const toTokenAccount = await getOrCreateATAWithRetry(USDC_MINT, toOwner);

    const res = await sendTxWithRetry(() => new Transaction().add(
      createTransferInstruction(fromAta, toTokenAccount.address, botKeypair.publicKey, amountBase)
    ), [botKeypair]);

    if (!res.success) {
      if (res.transient) {
        return { success: false, transient: true, error: `Network hiccup talking to Solana — please try again in a moment. (${res.error?.message || 'RPC error'})` };
      }
      return { success: false, error: `Transfer failed: ${res.error?.message || 'unknown error'}` };
    }

    return { success: true, signature: res.signature, amount: amountUSDC };
  } catch (error) {
    console.error('USDC transfer failed:', error);
    // Account creation failing usually means the bot is out of SOL for rent.
    if (String(error?.message || '').toLowerCase().includes('insufficient')) {
      return {
        success: false,
        insufficient: true,
        error: `Bot wallet is low on SOL for network fees.\nPlease ask ${REFILL_ADMINS} to top it up.\nBot Address: ${botKeypair.publicKey.toString()}`
      };
    }
    return { success: false, error: `Transfer failed: ${error.message}` };
  }
}

const OWNER_ID = process.env.OWNER_ID;

function isOwner(userId) {
  return userId === OWNER_ID;
}

async function hasTipPermission(userId) {
  if (isOwner(userId)) return true;
  const result = await dbGet(`SELECT can_tip FROM permissions WHERE discord_id = ?`, [userId]);
  return result ? result.can_tip === 1 : false;
}

async function giveTipPermission(userId) {
  await dbRun(`INSERT OR REPLACE INTO permissions (discord_id, can_tip) VALUES (?, 1)`, [userId]);
}

async function removeTipPermission(userId) {
  await dbRun(`DELETE FROM permissions WHERE discord_id = ?`, [userId]);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

function getArgs(message) {
  const parts = message.content.trim().split(/ +/);
  return parts.slice(1);
}

async function checkOwner(message) {
  if (!isOwner(message.author.id)) {
    await replyError(message, 'Only the bot owner can use this command!', 8000);
    return false;
  }
  return true;
}

// ═══════════════════════════════════════════════════════════
// 🟢 ACTIVITY TRACKER — remembers who is chatting, per server.
//    Writes at most once per minute per user to keep the DB light.
// ═══════════════════════════════════════════════════════════
const lastActivityWrite = new Map();
async function trackActivity(message) {
  if (!message.guild || message.author.bot) return;
  const key = `${message.guild.id}:${message.author.id}`;
  const now = Date.now();
  if (now - (lastActivityWrite.get(key) || 0) < 60000) return;
  lastActivityWrite.set(key, now);
  try {
    await dbRun(`INSERT OR REPLACE INTO activity (discord_id, guild_id, last_seen) VALUES (?, ?, ?)`,
      [message.author.id, message.guild.id, now]);
  } catch { /* activity is best-effort */ }
}

// ═══════════════════════════════════════════════════════════
// 💬 COMMAND HANDLERS — modern outputs
// ═══════════════════════════════════════════════════════════

// 1. !wallet — view or set wallet
async function handleMessageWallet(message) {
  const args = getArgs(message);
  const userId = message.author.id;
  const username = message.author.username;

  if (args.length === 0) {
    try {
      const user = await dbGet(`SELECT wallet FROM users WHERE discord_id = ?`, [userId]);
      if (user?.wallet) {
        const embed = infoEmbed('🔗 Linked Wallet', `Your wallet on file:\n\`\`\`${user.wallet}\`\`\``)
          .setThumbnail(avatarOf(message.author));
        await message.reply({ embeds: [embed] });
      } else {
        await replyError(message, 'No wallet linked yet.\nUse `!wallet <address>` to link your Solana wallet.');
      }
    } catch (error) {
      await replyError(message, 'Database error. Try again in a moment.', 8000);
    }
    return;
  }

  const address = args[0];

  try {
    new PublicKey(address);
  } catch {
    await replyError(message, 'That doesn\'t look like a valid Solana wallet address.', 8000);
    return;
  }

  // shared: process queued tips after (re)linking
  async function processPendingTips() {
    const pendingTips = await dbAll(`SELECT * FROM pending_tips WHERE receiver_id = ? AND processed = 0`, [userId]);
    if (!pendingTips.length) return null;

    if (!botKeypair) {
      await replyError(message, 'Wallet saved, but a pending tip failed:\nBot wallet isn\'t configured. Contact an admin.', 12000);
      return { failed: true };
    }

    // Vault checked once for the whole batch (USDC + SOL for fees/rent).
    const totalPending = pendingTips.reduce((sum, tip) => sum + tip.amount_usd, 0);
    const vault = await checkVaultFunds(totalPending, 1);
    if (!vault.ok) {
      await replyError(message, `Wallet saved, but a pending tip couldn't be paid:\n${vaultShortMessage(vault.shortOn)}`, 12000);
      return { failed: true };
    }

    let totalProcessed = 0;
    const lines = [];
    let firstSig = null;

    for (const tip of pendingTips) {
      const result = await sendUSDC(address, tip.amount_usd);

      if (!result.success) {
        await replyError(message, `Wallet saved, but a pending tip failed:\n${result.error}`, 12000);
        return { failed: true };
      }

      await dbRun(`INSERT INTO transactions (sender_id, receiver_id, amount_usd, amount_usdc, signature) VALUES (?, ?, ?, ?, ?)`,
        [tip.sender_id, userId, tip.amount_usd, tip.amount_usd, result.signature]);
      await dbRun(`UPDATE users SET balance_usd = balance_usd + ? WHERE discord_id = ?`, [tip.amount_usd, userId]);
      await dbRun(`UPDATE pending_tips SET processed = 1 WHERE id = ?`, [tip.id]);

      totalProcessed += tip.amount_usd;
      if (!firstSig) firstSig = result.signature;
      const sender = await dbGet(`SELECT username FROM users WHERE discord_id = ?`, [tip.sender_id]);
      lines.push(`• ${fmtUSD(tip.amount_usd)} from **${sender?.username || 'Unknown'}**`);
    }
    return { count: pendingTips.length, total: totalProcessed, lines, sig: firstSig };
  }

  try {
    const existingUser = await dbGet(`SELECT wallet FROM users WHERE discord_id = ?`, [userId]);

    if (existingUser?.wallet) {
      await dbRun(`UPDATE users SET wallet = ?, username = ? WHERE discord_id = ?`, [address, username, userId]);
      const res = await processPendingTips();
      if (res?.failed) return;

      const embed = okEmbed('Wallet Updated', `Now pointing at:\n\`\`\`${address}\`\`\``)
        .setThumbnail(avatarOf(message.author));
      if (res) {
        embed.addFields(
          { name: '🎁 Pending tips claimed', value: `${res.count} tips • **${fmtUSD(res.total)}**`, inline: false },
          { name: 'Details', value: res.lines.join('\n').slice(0, 1000), inline: false }
        );
        await message.reply({ embeds: [embed], components: solscanRow(res.sig) });
      } else {
        await message.reply({ embeds: [embed] });
      }
      return;
    }

    await dbRun(`INSERT INTO users (discord_id, username, wallet) VALUES (?, ?, ?)`, [userId, username, address]);
    const res = await processPendingTips();
    if (res?.failed) return;

    const embed = okEmbed('Wallet Linked', `Welcome aboard, **${username}**!\n\`\`\`${address}\`\`\``)
      .setThumbnail(avatarOf(message.author));
    if (res) {
      embed.addFields(
        { name: '🎁 Pending tips claimed', value: `${res.count} tips • **${fmtUSD(res.total)}**`, inline: false },
        { name: 'Details', value: res.lines.join('\n').slice(0, 1000), inline: false }
      );
      await message.reply({ embeds: [embed], components: solscanRow(res.sig) });
    } else {
      await message.reply({ embeds: [embed] });
    }
  } catch (err) {
    console.error('Wallet error:', err);
    await replyError(message, 'Database error. Try again in a moment.', 8000);
  }
}

// 2. !bal — wallet balance
async function handleMessageBalance(message) {
  const userId = message.author.id;

  try {
    const row = await dbGet(`SELECT wallet FROM users WHERE discord_id = ?`, [userId]);

    if (!row?.wallet) {
      await replyError(message, 'No wallet linked yet.\nUse `!wallet <address>` to link one first.');
      return;
    }

    const [sol, usdc] = await Promise.all([
      getBalance(row.wallet),
      getUSDCBalance(row.wallet),
    ]);
    const price = await getSolPrice();
    const usdValue = (sol * price) + usdc;

    const embed = baseEmbed(BRAND.primary)
      .setAuthor({ name: `${message.author.username}'s Wallet`, iconURL: avatarOf(message.author) })
      .setTitle('💰 Balance')
      .setDescription(`\`${row.wallet}\``)
      .addFields(
        { name: '💵 USDC', value: `**${usdc.toFixed(2)}**`, inline: true },
        { name: '◎ SOL', value: `**${sol.toFixed(4)}**`, inline: true },
        { name: '💵 Total USD Value', value: `**${fmtUSD(usdValue)}**`, inline: true },
        { name: '📈 SOL Price', value: `${fmtUSD(price)}`, inline: true }
      )
      .setThumbnail(avatarOf(message.author));

    await message.reply({ embeds: [embed] });
  } catch (error) {
    console.error('Balance error:', error);
    await replyError(message, 'Couldn\'t fetch your balance right now.', 8000);
  }
}

// 3. !faucet — claim free SOL
async function handleMessageFaucet(message) {
  const settings = await dbGet(`SELECT value FROM settings WHERE key = 'faucet_enabled'`);
  if (settings?.value !== 'true') {
    await replyError(message, 'The faucet is currently **OFF**. Check back later!');
    return;
  }

  const userId = message.author.id;
  const amountSOL = 0.001;

  try {
    const user = await dbGet(`SELECT wallet FROM users WHERE discord_id = ?`, [userId]);

    if (!user?.wallet) {
      await replyError(message, 'Link a wallet first with `!wallet <address>`, then come claim!');
      return;
    }

    if (!botKeypair) {
      await replyError(message, 'Bot wallet isn\'t configured. Contact an admin.', 8000);
      return;
    }

    const botBalance = await getBalance(botKeypair.publicKey.toString());
    if (botBalance < amountSOL) {
      await replyError(message, 'Faucet is dry — the bot wallet needs a refill. Ping an admin!');
      return;
    }

    const claimed = await dbGet(`SELECT * FROM transactions WHERE sender_id = 'faucet' AND receiver_id = ?`, [userId]);
    if (claimed) {
      await replyError(message, 'You\'ve already claimed your free SOL! One per user. 💧');
      return;
    }

    const result = await sendSOL(user.wallet, amountSOL);

    if (!result.success) {
      await replyError(message, `Faucet failed:\n${result.error}`, 12000);
      return;
    }

    await dbRun(`INSERT INTO transactions (sender_id, receiver_id, amount_usd, amount_sol, signature) VALUES (?, ?, ?, ?, ?)`,
      ['faucet', userId, 0, amountSOL, result.signature]);

    const embed = goldEmbed('🎁 Faucet Claimed!',
      `**${fmtSOL(amountSOL, 3)}** is on its way to your wallet, ${message.author.username}!`)
      .setThumbnail(avatarOf(message.author))
      .addFields({ name: 'To', value: shortAddr(user.wallet), inline: true });

    await message.reply({ embeds: [embed], components: solscanRow(result.signature) });
  } catch (error) {
    console.error('Faucet error:', error);
    await replyError(message, 'Faucet failed. Try again in a moment.', 8000);
  }
}

// 4. !history — last 10 transactions
async function handleMessageHistory(message) {
  const userId = message.author.id;

  try {
    const rows = await dbAll(`SELECT * FROM transactions WHERE sender_id = ? OR receiver_id = ? ORDER BY created_at DESC LIMIT 10`, [userId, userId]);

    if (!rows?.length) {
      await replyError(message, 'No transactions yet. Go get tipped! 💸');
      return;
    }

    const lines = [];
    for (const r of rows) {
      const isSender = r.sender_id === userId;
      const otherId = isSender ? r.receiver_id : r.sender_id;
      const other = await dbGet(`SELECT username FROM users WHERE discord_id = ?`, [otherId]);
      const icon = r.sender_id === 'faucet' ? '🎁' : r.sender_id === 'giveaway' ? '🎉' : (isSender ? '📤' : '📥');
      const dir = isSender ? 'to' : 'from';
      const otherName = r.sender_id === 'giveaway' && !isSender ? 'Giveaway' : (other?.username || 'Unknown');
      lines.push(`${icon} **${fmtUSD(r.amount_usd || 0)}** ${dir} **${otherName}**`);
    }

    const embed = infoEmbed('📜 Transaction History', lines.join('\n'))
      .setThumbnail(avatarOf(message.author))
      .setFooter({ text: `${FOOTER} • Last ${rows.length}` });

    await message.reply({ embeds: [embed] });
  } catch (error) {
    await replyError(message, 'Couldn\'t fetch your history right now.', 8000);
  }
}

// 5. !help — command center
async function handleMessageHelp(message) {
  const userId = message.author.id;
  const canTip = await hasTipPermission(userId);
  const isOwnerUser = isOwner(userId);

  const embed = baseEmbed(BRAND.primary)
    .setTitle('🤖 JJH TipBot — Command Center')
    .setDescription('Tip USDC across the server in seconds — $1 = 1 USDC.\nAll commands use the `!` prefix.')
    .setThumbnail(avatarOf(client.user))
    .addFields(
      {
        name: '💎 Wallet & Balance',
        value: '`!wallet <address>` — link your Solana wallet\n`!wallet` — view your linked wallet\n`!bal` — check USDC + SOL balance\n`!botbal` — check the bot\'s wallet\n`!faucet` — claim free 0.001 SOL gas money (once)',
        inline: false
      },
      {
        name: '📜 Activity',
        value: '`!history` — your last 10 transactions\n`!vpt` — your pending tips (auto-deletes)\n`!help` — this menu',
        inline: false
      }
    );

  if (canTip) {
    embed.addFields({
      name: '💸 Tipping',
      value: '`!tip @user <usd>` — tip USDC, $1 = 1 USDC\n`!tip @user` — quick-tip $0.10 USDC\n`!tip` — 🌧️ **Tip Rain!** 10 random **active** members (chatted in the last 30 min) get $0.10 USDC each — no wallet? Tip goes pending, auto-pays on link\n`!tip <count>` — 🌧️ Custom Tip Rain: that many people x $0.10 USDC each (e.g. `!tip 3` = 3 people, max 50)',
      inline: false
    });
  }

  if (isOwnerUser) {
    embed.addFields({
      name: '🔧 Admin',
      value: '`!gp @user` / `!rp @user` — give / remove tip permission\n`!lp` — list tippers\n`!last` — last 10 bot transactions\n`!fon` / `!foff` — faucet on / off\n`!vp` — ALL pending tips (auto-deletes)\n`!vp @user` — one user\'s pending tips (auto-deletes)\n`!rpt @user` — clear pending tips + refund',
      inline: false
    });
    embed.addFields({
      name: '🎉 Giveaway',
      value: '`!gstart <word> <usd> <minutes>` — start a keyword giveaway (prize in USDC)\n`!gend` — end early and draw now\n`!gcancel` — cancel, no payout\n`!gstatus` — word, prize, entries, time left',
      inline: false
    });
  }

  embed.addFields({
    name: '💡 Tip',
    value: 'New here? Start with `!wallet <your-address>` — one time, then you\'re set.',
    inline: false
  });

  await message.reply({ embeds: [embed] });
}

// ═══════════════════════════════════════════════════════════
// 🔧 OWNER COMMANDS — modern outputs
// ═══════════════════════════════════════════════════════════

// 6. !gp — give tip permission
async function handleMessageGivePerms(message) {
  if (!await checkOwner(message)) return;

  const args = getArgs(message);

  if (args.length === 0) {
    await replyError(message, 'Usage: `!gp @user`', 8000);
    return;
  }

  const targetUser = message.mentions.users.first();
  if (!targetUser) {
    await replyError(message, 'Mention a user first.\nUsage: `!gp @user`', 8000);
    return;
  }

  if (isOwner(targetUser.id)) {
    await replyError(message, '👑 He\'s the owner — he already has every permission!', 8000);
    return;
  }

  if (await hasTipPermission(targetUser.id)) {
    await replyError(message, `**${targetUser.username}** can already tip!`, 8000);
    return;
  }

  try {
    await giveTipPermission(targetUser.id);
    const embed = okEmbed('Permission Granted', `**${targetUser.username}** can now send tips! 💸`)
      .setThumbnail(avatarOf(targetUser));
    await message.reply({ embeds: [embed] });
  } catch (error) {
    await replyError(message, `Couldn't save that: ${error.message}`, 8000);
  }
}

// 7. !rp — remove tip permission
async function handleMessageRemovePerms(message) {
  if (!await checkOwner(message)) return;

  const args = getArgs(message);

  if (args.length === 0) {
    await replyError(message, 'Usage: `!rp @user`', 8000);
    return;
  }

  const targetUser = message.mentions.users.first();
  if (!targetUser) {
    await replyError(message, 'Mention a user first.\nUsage: `!rp @user`', 8000);
    return;
  }

  if (isOwner(targetUser.id)) {
    await replyError(message, '👑 He\'s the owner — his permissions can\'t be removed!', 8000);
    return;
  }

  if (!await hasTipPermission(targetUser.id)) {
    await replyError(message, `**${targetUser.username}** doesn't have tip permission anyway.`, 8000);
    return;
  }

  try {
    await removeTipPermission(targetUser.id);
    const embed = okEmbed('Permission Removed', `**${targetUser.username}** can no longer send tips.`)
      .setThumbnail(avatarOf(targetUser));
    await message.reply({ embeds: [embed] });
  } catch (error) {
    await replyError(message, `Couldn't save that: ${error.message}`, 8000);
  }
}

// 8. !lp — list tippers
async function handleMessageListPerms(message) {
  if (!await checkOwner(message)) return;

  try {
    const permUsers = await dbAll(`SELECT * FROM permissions WHERE can_tip = 1`);

    if (permUsers.length === 0) {
      await replyError(message, 'Nobody has tip permission yet.\nUse `!gp @user` to add someone.');
      return;
    }

    const lines = [];
    for (let i = 0; i < permUsers.length; i++) {
      const user = await dbGet(`SELECT username FROM users WHERE discord_id = ?`, [permUsers[i].discord_id]);
      lines.push(`**${i + 1}.** <@${permUsers[i].discord_id}> — ${user?.username || 'Unknown'}`);
    }

    const embed = infoEmbed(`💸 Authorized Tippers (${permUsers.length})`, lines.join('\n').slice(0, 3900));
    await message.reply({ embeds: [embed] });
  } catch (error) {
    console.error('List perms error:', error);
    await replyError(message, `Couldn't load the list: ${error.message}`, 8000);
  }
}

// 9. !last — last 10 bot transactions
async function handleMessageLast(message) {
  if (!await checkOwner(message)) return;

  try {
    const rows = await dbAll(`SELECT * FROM transactions ORDER BY created_at DESC LIMIT 10`);

    if (!rows || rows.length === 0) {
      await replyError(message, 'No transactions in the database yet.');
      return;
    }

    const lines = [];
    for (const r of rows) {
      let senderName, receiverName;
      if (r.sender_id === 'faucet') senderName = '🚰 Faucet';
      else if (r.sender_id === 'giveaway') senderName = '🎉 Giveaway';
      else {
        const s = await dbGet(`SELECT username FROM users WHERE discord_id = ?`, [r.sender_id]);
        senderName = s?.username || 'Unknown';
      }
      if (r.receiver_id === 'faucet') receiverName = '🚰 Faucet';
      else {
        const rec = await dbGet(`SELECT username FROM users WHERE discord_id = ?`, [r.receiver_id]);
        receiverName = rec?.username || 'Unknown';
      }
      const icon = r.sender_id === 'faucet' ? '🎁' : r.sender_id === 'giveaway' ? '🎉' : '💸';
      const amt = r.amount_usd ? fmtUSD(r.amount_usd) : fmtSOL(r.amount_sol || 0, 6);
      lines.push(`${icon} **${amt}** — ${senderName} → ${receiverName}`);
    }

    const embed = baseEmbed(BRAND.gold)
      .setTitle('📊 Latest Bot Activity')
      .setDescription(lines.join('\n'))
      .setFooter({ text: `${FOOTER} • Last ${rows.length} transactions` });

    await message.reply({ embeds: [embed] });
  } catch (error) {
    console.error('Last transactions error:', error);
    await replyError(message, `Couldn't load transactions: ${error.message}`, 8000);
  }
}

// 10. !botbal — bot wallet balance (public)
async function handleMessageBotBalance(message) {
  if (!botKeypair) {
    await replyError(message, 'Bot wallet isn\'t configured.', 8000);
    return;
  }

  try {
    const walletAddress = botKeypair.publicKey.toString();
    const [balance, usdc] = await Promise.all([
      getBalance(walletAddress),
      getUSDCBalance(walletAddress),
    ]);
    const price = await getSolPrice();
    const solUsdValue = balance * price;
    const healthy = usdc > 0 && balance > MIN_SOL_BUFFER;

    const embed = baseEmbed(healthy ? BRAND.primary : BRAND.error)
      .setAuthor({ name: 'JJH TipBot Vault', iconURL: avatarOf(client.user) })
      .setTitle(healthy ? '🏦 Bot Vault' : '⚠️ Bot Vault — Low!')
      .setDescription(`\`${walletAddress}\``)
      .addFields(
        { name: '💵 USDC', value: `**${usdc.toFixed(2)}**`, inline: true },
        { name: '◎ SOL (for fees)', value: `**${balance.toFixed(4)}**`, inline: true },
        { name: '💵 SOL Value', value: `**${fmtUSD(solUsdValue)}**`, inline: true },
        { name: '📈 SOL Price', value: `${fmtUSD(price)}`, inline: true }
      )
      .setThumbnail(avatarOf(client.user));

    await message.reply({ embeds: [embed] });
  } catch (error) {
    console.error('Bot balance error:', error);
    await replyError(message, 'Couldn\'t fetch the bot balance right now.', 8000);
  }
}

// 11/12. !fon / !foff — faucet toggle
async function handleMessageFaucetOn(message) {
  if (!await checkOwner(message)) return;
  await dbRun(`UPDATE settings SET value = 'true' WHERE key = 'faucet_enabled'`);
  await message.reply({ embeds: [okEmbed('Faucet ON', 'Users can claim free SOL again! 💧')] });
}

async function handleMessageFaucetOff(message) {
  if (!await checkOwner(message)) return;
  await dbRun(`UPDATE settings SET value = 'false' WHERE key = 'faucet_enabled'`);
  await message.reply({ embeds: [okEmbed('Faucet OFF', 'Claiming is paused for now.')] });
}

// 13. !vp — view pending tips
// 13. !vp — owner-only pending-tips overview, dismiss-style.
//     `!vp` (no mention) → ALL pending tips, grouped by receiver.
//     `!vp @user`        → that one user's pending tips in detail.
//     Both post in the same channel and auto-delete after 30s.
async function handleMessageViewPending(message) {
  if (!await checkOwner(message)) return;

  const targetUser = message.mentions.users.first();

  try {
    // ── No mention: full overview, grouped by receiver ──
    if (!targetUser) {
      const rows = await dbAll(
        `SELECT receiver_id, COUNT(*) AS cnt, SUM(amount_usd) AS total, MIN(created_at) AS oldest
         FROM pending_tips WHERE processed = 0 GROUP BY receiver_id ORDER BY total DESC`
      );

      if (rows.length === 0) {
        await sendPrivate(message, { embeds: [infoEmbed('⏳ Pending Tips', 'No pending tips right now — everything is paid out! ✅')] });
        return;
      }

      let grandTotal = 0;
      let grandCount = 0;
      const lines = [];
      const shown = rows.slice(0, 25);
      for (const r of shown) {
        grandTotal += r.total;
        grandCount += r.cnt;
        const since = r.oldest ? r.oldest.slice(0, 10) : '—';
        lines.push(`• <@${r.receiver_id}> — **${r.cnt}** tip${r.cnt > 1 ? 's' : ''} • **${fmtUSD(r.total)}** • since ${since}`);
      }
      // Totals must cover rows beyond the 25 shown too.
      for (const r of rows.slice(25)) {
        grandTotal += r.total;
        grandCount += r.cnt;
      }
      if (rows.length > 25) {
        lines.push(`…and **${rows.length - 25}** more receiver${rows.length - 25 > 1 ? 's' : ''}`);
      }

      const embed = goldEmbed(`⏳ All Pending Tips (${rows.length} receiver${rows.length > 1 ? 's' : ''})`, lines.join('\n').slice(0, 3900))
        .addFields({ name: 'Total waiting', value: `**${grandCount}** tips • **${fmtUSD(grandTotal)}**`, inline: false });
      await sendPrivate(message, { embeds: [embed] });
      return;
    }

    // ── Mention: one user's pending tips in detail ──
    const pendingTips = await dbAll(
      `SELECT * FROM pending_tips WHERE receiver_id = ? AND processed = 0 ORDER BY created_at ASC`,
      [targetUser.id]
    );

    if (pendingTips.length === 0) {
      await sendPrivate(message, { embeds: [infoEmbed('⏳ Pending Tips', `No pending tips waiting for **${targetUser.username}**.`)] });
      return;
    }

    let total = 0;
    const lines = [];
    for (const tip of pendingTips) {
      let senderName;
      if (tip.sender_id === 'giveaway') senderName = '🎉 Giveaway';
      else if (tip.sender_id === 'faucet') senderName = '🚰 Faucet';
      else {
        const sender = await dbGet(`SELECT username FROM users WHERE discord_id = ?`, [tip.sender_id]);
        senderName = sender?.username || 'Unknown';
      }
      total += tip.amount_usd;
      const when = tip.created_at ? tip.created_at.slice(0, 10) : '—';
      lines.push(`• **${fmtUSD(tip.amount_usd)}** from ${senderName} • ${when}`);
    }

    const embed = goldEmbed(`⏳ Pending Tips — ${targetUser.username}`, lines.join('\n').slice(0, 3500))
      .setThumbnail(avatarOf(targetUser))
      .addFields({ name: 'Total waiting', value: `**${pendingTips.length}** tips • **${fmtUSD(total)}**`, inline: false });

    await sendPrivate(message, { embeds: [embed] });
  } catch (error) {
    await replyError(message, `Couldn't load pending tips: ${error.message}`, 8000);
  }
}

// 13b. !vpt — anyone can view their OWN pending tips.
//      Same delivery as !vp: posts in-channel, auto-deletes after 30s.
async function handleMessageViewMyPending(message) {
  const userId = message.author.id;

  try {
    const pendingTips = await dbAll(
      `SELECT * FROM pending_tips WHERE receiver_id = ? AND processed = 0 ORDER BY created_at ASC`,
      [userId]
    );

    if (pendingTips.length === 0) {
      await sendPrivate(message, { embeds: [infoEmbed('⏳ Your Pending Tips', 'You have no pending tips waiting.')] });
      return;
    }

    let total = 0;
    const lines = [];
    for (const tip of pendingTips) {
      let senderName;
      if (tip.sender_id === 'giveaway') senderName = '🎉 Giveaway';
      else if (tip.sender_id === 'faucet') senderName = '🚰 Faucet';
      else {
        const sender = await dbGet(`SELECT username FROM users WHERE discord_id = ?`, [tip.sender_id]);
        senderName = sender?.username || 'Unknown';
      }
      total += tip.amount_usd;
      const when = tip.created_at ? tip.created_at.slice(0, 10) : '—';
      lines.push(`• **${fmtUSD(tip.amount_usd)}** from ${senderName} • ${when}`);
    }

    const embed = goldEmbed('⏳ Your Pending Tips', lines.join('\n').slice(0, 3500))
      .setThumbnail(avatarOf(message.author))
      .addFields(
        { name: 'Total waiting', value: `**${pendingTips.length}** tips • **${fmtUSD(total)}**`, inline: false },
        { name: 'How to claim', value: 'Run `!wallet <address>` — everything pending auto-sends to your wallet on link! ⚡', inline: false }
      );

    await sendPrivate(message, { embeds: [embed] });
  } catch (error) {
    await replyError(message, `Couldn't load your pending tips: ${error.message}`, 8000);
  }
}

// 14. !rpt — remove pending tips + refund
async function handleMessageRemovePending(message) {
  if (!await checkOwner(message)) return;

  const targetUser = message.mentions.users.first();
  if (!targetUser) {
    await replyError(message, 'Mention a user first.\nUsage: `!rpt @user`', 8000);
    return;
  }

  try {
    const pendingTips = await dbAll(
      `SELECT * FROM pending_tips WHERE receiver_id = ? AND processed = 0`,
      [targetUser.id]
    );

    if (pendingTips.length === 0) {
      await replyError(message, `No pending tips waiting for **${targetUser.username}**.`);
      return;
    }

    let totalRefund = 0;
    for (const tip of pendingTips) {
      await dbRun(`UPDATE users SET balance_usd = balance_usd + ? WHERE discord_id = ?`, [tip.amount_usd, tip.sender_id]);
      totalRefund += tip.amount_usd;
      await dbRun(`DELETE FROM pending_tips WHERE id = ?`, [tip.id]);
    }

    const embed = okEmbed('Pending Tips Cleared',
      `Removed **${pendingTips.length}** tips for **${targetUser.username}**.\nRefunded **${fmtUSD(totalRefund)}** to senders.`)
      .setThumbnail(avatarOf(targetUser));

    await message.reply({ embeds: [embed] });
  } catch (error) {
    await replyError(message, `Couldn't clear those: ${error.message}`, 8000);
  }
}

// ═══════════════════════════════════════════════════════════
// 🌧️ TIP RAIN — `!tip` with no mention rains on random ACTIVE members
//    `!tip`        → 10 random active members x $0.10 USDC each (= $1)
//    `!tip 1`      → 1 random active member x $0.10 USDC
//    `!tip 3`      → 3 random active members x $0.10 USDC each — the number
//                    is the PEOPLE count, per-person amount is the base $0.10
//    Pool: ACTIVE chatters only — chatted in this server in the last
//    30 minutes (sender excluded), wallet or not. Walletless winners
//    get a pending tip that auto-pays when they link a wallet. If the
//    pool has fewer than 10 members, everyone in the pool gets a share.
//    Sends run 4 at a time (not one-by-one) with retries, so big rains
//    no longer time out; the vault balance is checked ONCE up front.
// ═══════════════════════════════════════════════════════════
const RAIN_DEFAULT_RECIPIENTS = 10;  // plain `!tip` rains on 10 people
const RAIN_MAX_RECIPIENTS = 50;      // hard cap per rain
const RAIN_PER_PERSON_USD = 0.1;     // base amount (USDC) every winner gets
const RAIN_ACTIVE_WINDOW_MIN = 30;   // only members who chatted in the last 30 minutes
const RAIN_CONCURRENCY = 4;          // parallel sends per chunk

async function handleMessageTipRain(message, recipientCount) {
  const senderId = message.author.id;

  if (!await hasTipPermission(senderId)) {
    await replyError(message, 'You don\'t have tipping permission yet.\nAsk the owner: `!gp @user`', 12000);
    return;
  }

  if (!botKeypair) {
    await replyError(message, 'Bot wallet isn\'t configured. Contact an admin.');
    return;
  }

  if (!Number.isInteger(recipientCount) || recipientCount <= 0) {
    await replyError(message, 'Tell me how many people.\nExample: `!tip` rains on 10 people, `!tip 3` rains on 3 people — everyone gets $0.10 USDC.', 8000);
    return;
  }

  if (recipientCount > RAIN_MAX_RECIPIENTS) {
    await replyError(message, `Tip Rain is capped at **${RAIN_MAX_RECIPIENTS} people** per rain.\nRun it twice to cover more people — e.g. \`!tip ${RAIN_MAX_RECIPIENTS}\` now, then again.`, 12000);
    return;
  }

  if (!message.guild) {
    await replyError(message, '🌧️ Tip Rain only works inside a server channel — that\'s where the active chatters are!', 8000);
    return;
  }

  try {
    const sender = await dbGet(`SELECT * FROM users WHERE discord_id = ?`, [senderId]);
    if (!sender?.wallet) {
      await replyError(message, 'Link your wallet first: `!wallet <address>`');
      return;
    }

    // Pool = ACTIVE chatters in THIS server within the last
    // RAIN_ACTIVE_WINDOW_MIN minutes — wallet or NO wallet.
    // No wallet (or an invalid one saved) → the tip goes to the pending
    // queue and pays out automatically when they link a wallet, exactly
    // like a normal pending tip. Sender excluded.
    const activeSince = Date.now() - (RAIN_ACTIVE_WINDOW_MIN * 60 * 1000);
    const poolRows = await dbAll(
      `SELECT discord_id FROM activity WHERE guild_id = ? AND last_seen >= ? AND discord_id != ?`,
      [message.guild.id, activeSince, senderId]
    );
    const pool = poolRows.map((r) => r.discord_id);

    if (pool.length === 0) {
      await replyError(message, `No active members to rain on right now.\nRain only hits members who **chatted in this server in the last ${RAIN_ACTIVE_WINDOW_MIN} minutes**.`);
      return;
    }

    // Shuffle (Fisher–Yates) and take the requested number of people.
    // Pool smaller than the count? Everyone in the pool gets it.
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const recipients = pool.slice(0, recipientCount);

    // Every winner gets the fixed base amount, in USDC ($1 = 1 USDC).
    const perUSD = RAIN_PER_PERSON_USD;
    const totalUSDC = perUSD * recipients.length;

    // Vault checked ONCE up front (USDC for the payout + SOL for fees/rent),
    // instead of one balance RPC call per send.
    const vault = await checkVaultFunds(totalUSDC, recipients.length);
    if (!vault.ok) {
      await replyError(message, vaultShortMessage(vault.shortOn), 15000);
      return;
    }

    const statusMsg = await message.reply({
      embeds: [infoEmbed('🌧️ Tip Rain Incoming!',
        `**${message.author.username}** is raining **${fmtUSD(perUSD)}** on **${recipients.length}** random **active** members…`)]
    });

    const results = new Array(recipients.length);
    let doneCount = 0;

    // One recipient: wallet → send USDC now; no wallet → queue a pending tip.
    async function rainOne(rid, idx) {
      const u = await dbGet(`SELECT wallet FROM users WHERE discord_id = ?`, [rid]);
      let wallet = null;
      if (u?.wallet) {
        try {
          const pk = new PublicKey(u.wallet);
          if (pk.toString() !== '11111111111111111111111111111111') wallet = u.wallet;
        } catch { wallet = null; }
      }

      if (!wallet) {
        await dbRun(`INSERT INTO pending_tips (sender_id, receiver_id, amount_usd) VALUES (?, ?, ?)`,
          [senderId, rid, perUSD]);
        results[idx] = { id: rid, status: 'pending' };
      } else {
        const res = await sendUSDC(wallet, perUSD);
        if (res.success) {
          await dbRun(`INSERT INTO transactions (sender_id, receiver_id, amount_usd, amount_usdc, signature) VALUES (?, ?, ?, ?, ?)`,
            [senderId, rid, perUSD, perUSD, res.signature]);
          await dbRun(`UPDATE users SET balance_usd = balance_usd + ?, total_received = total_received + ? WHERE discord_id = ?`,
            [perUSD, perUSD, rid]);
          results[idx] = { id: rid, status: 'sent', sig: res.signature };
        } else {
          console.error(`Rain send failed for ${rid}:`, res.error);
          results[idx] = { id: rid, status: 'failed' };
        }
      }
      doneCount++;
    }

    // Sends run RAIN_CONCURRENCY at a time — fully sequential sends were
    // slow enough to time out on big pools. Progress edits keep it from
    // looking hung on long rains.
    for (let i = 0; i < recipients.length; i += RAIN_CONCURRENCY) {
      const chunk = recipients.slice(i, i + RAIN_CONCURRENCY);
      await Promise.all(chunk.map((rid, j) => rainOne(rid, i + j)));
      if (recipients.length > RAIN_CONCURRENCY) {
        await statusMsg.edit({
          embeds: [infoEmbed('🌧️ Tip Rain Incoming!',
            `**${message.author.username}** is raining **${fmtUSD(perUSD)}** on **${recipients.length}** random **active** members…\n\n⏳ **${doneCount}/${recipients.length}** sent…`)]
        }).catch(() => {});
      }
    }

    const sentResults = results.filter((x) => x.status === 'sent');
    const pendingResults = results.filter((x) => x.status === 'pending');
    const failedResults = results.filter((x) => x.status === 'failed');
    if (sentResults.length > 0) {
      await dbRun(`UPDATE users SET total_tipped = total_tipped + ? WHERE discord_id = ?`,
        [perUSD * sentResults.length, senderId]);
    }

    const lines = results.map((x) => {
      if (x.status === 'sent') return `• <@${x.id}> — **${fmtUSD(perUSD)}** [🔍](${SOLSCAN_TX(x.sig)})`;
      if (x.status === 'pending') return `• <@${x.id}> — **${fmtUSD(perUSD)}** ⏳ pending (auto-pays when they link a wallet)`;
      return `• <@${x.id}> — ⚠️ failed`;
    });

    const delivered = sentResults.length + pendingResults.length;
    const embed = goldEmbed('🌧️ Tip Rain!',
        `**${message.author.username}** made it rain on **${delivered}** active members!`)
      .setThumbnail(avatarOf(message.author))
      .addFields(
        { name: '💸 Per person', value: `**${fmtUSD(perUSD)}** = ${fmtUSDC(perUSD)}`, inline: true },
        { name: '🌧️ Total rained', value: `**${fmtUSD(perUSD * delivered)}**`, inline: true },
        { name: '🎲 Winners', value: lines.join('\n').slice(0, 3500), inline: false }
      );
    if (pendingResults.length > 0) {
      embed.addFields({ name: '⏳ Pending', value: `${pendingResults.length} winner(s) have no wallet linked — their tip is queued and auto-sends as soon as they run \`!wallet <address>\` to link one.`, inline: false });
    }
    if (failedResults.length > 0) {
      embed.addFields({ name: '⚠️ Note', value: `${failedResults.length} transfer(s) failed after retries and were not charged.`, inline: false });
    }

    await statusMsg.edit({ embeds: [embed] });
  } catch (error) {
    console.error('Tip rain error:', error);
    await replyError(message, `Tip rain failed:\n${error.message}`, 12000);
  }
}

// ═══════════════════════════════════════════════════════════
// 💸 !tip HANDLER — modern outputs
// ═══════════════════════════════════════════════════════════
async function handleMessageTip(message) {
  const content = message.content;

  if (!content.toLowerCase().startsWith('!tip')) {
    return false;
  }

  const parts = content.split(' ');

  const receiver = message.mentions.users.first();
  if (!receiver) {
    // 🌧️ No mention → TIP RAIN. `!tip` = 10 people, `!tip 3` = 3 people (x $0.10 each).
    if (parts.length >= 2 && (!Number.isInteger(Number(parts[1])) || Number(parts[1]) <= 0)) {
      await replyError(message, 'Mention someone to tip, or rain on the server!\nExamples: `!tip @John 1` • `!tip` (rain on 10 people) • `!tip 3` (rain on 3 people)');
      return true;
    }
    const recipientCount = parts.length >= 2 ? Number(parts[1]) : RAIN_DEFAULT_RECIPIENTS;
    await handleMessageTipRain(message, recipientCount);
    return true;
  }

  if (receiver.id === message.author.id) {
    await replyError(message, 'You can\'t tip yourself! Nice try though. 😉', 8000);
    return true;
  }

  let amountUSD;
  if (parts.length >= 3) {
    amountUSD = parseFloat(parts[2]);
    if (isNaN(amountUSD) || amountUSD <= 0) {
      await replyError(message, 'Enter a valid amount.\nExample: `!tip @John 1`', 8000);
      return true;
    }
  } else {
    amountUSD = 0.1;
  }

  const MIN_TIP_USD = 0.001;
  if (amountUSD < MIN_TIP_USD) {
    await replyError(message, `Minimum tip is **$${MIN_TIP_USD.toFixed(3)}**.\nTry a slightly bigger amount!`);
    return true;
  }

  const senderId = message.author.id;
  const receiverId = receiver.id;

  if (!await hasTipPermission(senderId)) {
    await replyError(message, 'You don\'t have tipping permission yet.\nAsk the owner: `!gp @user`', 12000);
    return true;
  }

  if (!botKeypair) {
    await replyError(message, 'Bot wallet isn\'t configured. Contact an admin.');
    return true;
  }

  try {
    // Tips pay USDC 1:1 with the USD amount — no price conversion, and no
    // SOL dust floor (USDC has 6 decimals, so any positive amount works).
    const amountUSDC = amountUSD;

    // Vault checked once up front: USDC for the payout + SOL for fees/rent.
    const vault = await checkVaultFunds(amountUSDC, 1);
    if (!vault.ok) {
      await replyError(message, vaultShortMessage(vault.shortOn), 15000);
      return true;
    }

    const [sender, receiverData] = await Promise.all([
      dbGet(`SELECT * FROM users WHERE discord_id = ?`, [senderId]),
      dbGet(`SELECT * FROM users WHERE discord_id = ?`, [receiverId])
    ]);

    if (!sender?.wallet) {
      await replyError(message, 'Link your wallet first: `!wallet <address>`');
      return true;
    }

    // Receiver has no wallet → queue the tip
    if (!receiverData?.wallet) {
      await dbRun(`INSERT INTO pending_tips (sender_id, receiver_id, amount_usd) VALUES (?, ?, ?)`,
        [senderId, receiverId, amountUSD]);

      const embed = goldEmbed('⏳ Tip Queued',
        `**${fmtUSD(amountUSD)}** (${fmtUSDC(amountUSDC)}) is reserved for **${receiver.username}**.`)
        .setThumbnail(avatarOf(receiver))
        .addFields({
          name: 'Next step',
          value: 'They just need to run `!wallet <address>` — the tip auto-sends on link! ⚡',
          inline: false
        });

      await message.reply({ embeds: [embed] });
      return true;
    }

    try {
      new PublicKey(receiverData.wallet);
    } catch {
      await replyError(message, `**${receiver.username}** has an invalid wallet saved.\nAsk them to update it with \`!wallet <address>\`.`, 12000);
      return true;
    }

    const receiverPubkey = new PublicKey(receiverData.wallet);
    if (receiverPubkey.toString() === '11111111111111111111111111111111') {
      await replyError(message, `**${receiver.username}** has an invalid wallet saved.\nAsk them to update it with \`!wallet <address>\`.`, 12000);
      return true;
    }

    const result = await sendUSDC(receiverData.wallet, amountUSDC);

    if (!result.success) {
      await replyError(message, `${result.error}`, 15000);
      return true;
    }

    await Promise.all([
      dbRun(`INSERT INTO transactions (sender_id, receiver_id, amount_usd, amount_usdc, signature) VALUES (?, ?, ?, ?, ?)`,
        [senderId, receiverId, amountUSD, amountUSDC, result.signature]),
      dbRun(`UPDATE users SET balance_usd = balance_usd + ? WHERE discord_id = ?`, [amountUSD, receiverId]),
      dbRun(`UPDATE users SET total_tipped = total_tipped + ? WHERE discord_id = ?`, [amountUSD, senderId]),
      dbRun(`UPDATE users SET total_received = total_received + ? WHERE discord_id = ?`, [amountUSD, receiverId])
    ]);

    const embed = baseEmbed(BRAND.success)
      .setAuthor({ name: `${message.author.username}  →  ${receiver.username}`, iconURL: avatarOf(message.author) })
      .setTitle('💸 Tip Sent!')
      .setDescription(`## ${fmtUSD(amountUSD)}\n**${fmtUSDC(amountUSDC)}**`)
      .addFields(
        { name: '🪙 Token', value: 'USDC — $1 = 1 USDC', inline: true },
        { name: '📬 To', value: shortAddr(receiverData.wallet), inline: true }
      )
      .setThumbnail(avatarOf(receiver));

    await message.reply({ embeds: [embed], components: solscanRow(result.signature) });
  } catch (error) {
    console.error('Tip error:', error);
    await replyError(message, `Transaction failed:\n${error.message}`, 12000);
  }

  return true;
}

// ═══════════════════════════════════════════════════════════
// 🎉 KEYWORD GIVEAWAY — Kickaway style: the owner picks a word,
//    anyone who types it in chat gets 1 entry. One active
//    giveaway per guild. Entries + state live in SQLite so a
//    restart loses nothing; timers re-arm on startup.
//    Prize pays in USDC ($1 = 1 USDC); no wallet → queued as a
//    pending tip that auto-pays when the winner links a wallet.
// ═══════════════════════════════════════════════════════════
const GIVEAWAY_MIN_MINUTES = 1;
const GIVEAWAY_MAX_MINUTES = 1440; // 24h
const GIVEAWAY_SENDER_ID = 'giveaway'; // recorded as the sender in transactions

// In-memory mirrors of the active giveaways (DB is the source of truth).
const activeGiveaways = new Map(); // guildId -> giveaway row (+ _regex)
const giveawayTimers = new Map();  // guildId -> Timeout

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cacheGiveaway(giveaway) {
  // Whole-word match, case-insensitive — the explicit boundary form works
  // for any word (plain \b fails on words starting/ending in symbols).
  giveaway._regex = new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(giveaway.word)}([^A-Za-z0-9_]|$)`, 'i');
  activeGiveaways.set(giveaway.guild_id, giveaway);
}

function uncacheGiveaway(guildId) {
  activeGiveaways.delete(guildId);
  const timer = giveawayTimers.get(guildId);
  if (timer) {
    clearTimeout(timer);
    giveawayTimers.delete(guildId);
  }
}

function armGiveawayTimer(giveaway) {
  const delay = Math.max(0, giveaway.ends_at - Date.now());
  const existing = giveawayTimers.get(giveaway.guild_id);
  if (existing) clearTimeout(existing);
  const timeout = setTimeout(() => {
    drawGiveaway(giveaway.id).catch((error) => console.error(`Giveaway #${giveaway.id} draw failed:`, error));
  }, delay);
  giveawayTimers.set(giveaway.guild_id, timeout);
}

async function getActiveGiveaway(guildId) {
  return dbGet(`SELECT * FROM giveaways WHERE guild_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`, [guildId]);
}

// Silent entry: any non-bot, non-command message in the guild containing the
// word as a whole word (case-insensitive) = 1 entry. Deduped by (giveaway, user).
async function trackGiveawayEntry(message) {
  if (!message.guild || message.author.bot) return;
  if (message.content.startsWith('!')) return; // commands don't count
  const giveaway = activeGiveaways.get(message.guild.id);
  if (!giveaway) return;
  if (!giveaway._regex.test(message.content)) return;
  try {
    await dbRun(`INSERT OR IGNORE INTO giveaway_entries (giveaway_id, discord_id) VALUES (?, ?)`,
      [giveaway.id, message.author.id]);
  } catch { /* entry tracking is best-effort */ }
}

// !gstart <word> <usd> <minutes> — owner only
async function handleMessageGiveawayStart(message) {
  if (!await checkOwner(message)) return;
  if (!message.guild) {
    await replyError(message, 'Giveaways only run inside a server channel.', 8000);
    return;
  }

  const args = getArgs(message);
  if (args.length < 3) {
    await replyError(message, 'Usage: `!gstart <word> <usd> <minutes>`\nExample: `!gstart JJH 5 60` — type **JJH** in chat to enter, $5 USDC prize, ends in 60 minutes.', 12000);
    return;
  }

  const word = args[0];
  const prizeUSD = parseFloat(args[1]);
  const minutes = Number(args[2]);

  if (word.length > 32) {
    await replyError(message, 'The word must be 32 characters or less.', 8000);
    return;
  }
  if (isNaN(prizeUSD) || prizeUSD <= 0) {
    await replyError(message, 'The prize must be a number greater than 0.\nExample: `!gstart JJH 5 60`', 8000);
    return;
  }
  if (!Number.isInteger(minutes) || minutes < GIVEAWAY_MIN_MINUTES || minutes > GIVEAWAY_MAX_MINUTES) {
    await replyError(message, `Duration must be ${GIVEAWAY_MIN_MINUTES}–${GIVEAWAY_MAX_MINUTES} minutes (up to 24 hours).`, 8000);
    return;
  }

  if (!botKeypair) {
    await replyError(message, 'Bot wallet isn\'t configured. Contact an admin.');
    return;
  }

  try {
    const existing = await getActiveGiveaway(message.guild.id);
    if (existing) {
      const endsTs = Math.floor(existing.ends_at / 1000);
      await replyError(message, `A giveaway is already running in this server — word **${existing.word}**, prize **${fmtUSD(existing.prize_usd)}**, ends <t:${endsTs}:R>.\nEnd it with \`!gend\` or cancel it with \`!gcancel\` first.`, 12000);
      return;
    }

    // Prize must be covered by the vault's USDC right now (plus SOL for fees).
    const vault = await checkVaultFunds(prizeUSD, 1);
    if (!vault.ok) {
      await replyError(message, vaultShortMessage(vault.shortOn), 15000);
      return;
    }

    const endsAt = Date.now() + minutes * 60 * 1000;
    const res = await dbRun(
      `INSERT INTO giveaways (guild_id, channel_id, word, prize_usd, ends_at, created_by) VALUES (?, ?, ?, ?, ?, ?)`,
      [message.guild.id, message.channel.id, word, prizeUSD, endsAt, message.author.id]
    );
    const giveaway = {
      id: res.lastID,
      guild_id: message.guild.id,
      channel_id: message.channel.id,
      word,
      prize_usd: prizeUSD,
      ends_at: endsAt,
      status: 'active',
    };
    cacheGiveaway(giveaway);
    armGiveawayTimer(giveaway);

    const endsTs = Math.floor(endsAt / 1000);
    const embed = goldEmbed('🎉 GIVEAWAY STARTED!',
      `Type the word **${word}** in chat to enter!`)
      .setThumbnail(avatarOf(message.author))
      .addFields(
        { name: '🔑 Word', value: `**${word}**`, inline: true },
        { name: '🏆 Prize', value: `**${fmtUSD(prizeUSD)}** (${fmtUSDC(prizeUSD)})`, inline: true },
        { name: '⏰ Ends', value: `<t:${endsTs}:R> (<t:${endsTs}:f>)`, inline: true },
        { name: '📝 How to enter', value: `Just type **${word}** anywhere in this server — one entry per person. Winner is drawn at random when time runs out.`, inline: false }
      );

    await message.reply({ embeds: [embed] });
  } catch (error) {
    console.error('Giveaway start error:', error);
    if (String(error?.message || '').includes('UNIQUE constraint')) {
      await replyError(message, 'A giveaway is already running in this server.\nEnd it with `!gend` or cancel it with `!gcancel` first.', 12000);
      return;
    }
    await replyError(message, `Couldn't start the giveaway:\n${error.message}`, 12000);
  }
}

// !gend — end early and draw now (owner only)
async function handleMessageGiveawayEnd(message) {
  if (!await checkOwner(message)) return;
  if (!message.guild) {
    await replyError(message, 'Giveaways only run inside a server channel.', 8000);
    return;
  }
  try {
    const giveaway = await getActiveGiveaway(message.guild.id);
    if (!giveaway) {
      await replyError(message, 'No giveaway is running in this server.', 8000);
      return;
    }
    await drawGiveaway(giveaway.id);
  } catch (error) {
    console.error('Giveaway end error:', error);
    await replyError(message, `Couldn't end the giveaway:\n${error.message}`, 12000);
  }
}

// !gcancel — cancel, no payout (owner only)
async function handleMessageGiveawayCancel(message) {
  if (!await checkOwner(message)) return;
  if (!message.guild) {
    await replyError(message, 'Giveaways only run inside a server channel.', 8000);
    return;
  }
  try {
    const giveaway = await getActiveGiveaway(message.guild.id);
    if (!giveaway) {
      await replyError(message, 'No giveaway is running in this server.', 8000);
      return;
    }
    uncacheGiveaway(message.guild.id);
    await dbRun(`UPDATE giveaways SET status = 'cancelled' WHERE id = ?`, [giveaway.id]);
    const embed = infoEmbed('🎉 Giveaway Cancelled',
      `The giveaway for **${fmtUSD(giveaway.prize_usd)}** (word **${giveaway.word}**) was cancelled. No payout, no winner.`);
    await message.reply({ embeds: [embed] });
  } catch (error) {
    console.error('Giveaway cancel error:', error);
    await replyError(message, `Couldn't cancel the giveaway:\n${error.message}`, 12000);
  }
}

// !gstatus — word, prize, entries, time left (owner only)
async function handleMessageGiveawayStatus(message) {
  if (!await checkOwner(message)) return;
  if (!message.guild) {
    await replyError(message, 'Giveaways only run inside a server channel.', 8000);
    return;
  }
  try {
    const giveaway = await getActiveGiveaway(message.guild.id);
    if (!giveaway) {
      await replyError(message, 'No giveaway is running in this server.\nStart one with `!gstart <word> <usd> <minutes>`.', 8000);
      return;
    }
    const row = await dbGet(`SELECT COUNT(*) AS c FROM giveaway_entries WHERE giveaway_id = ?`, [giveaway.id]);
    const entries = row?.c || 0;
    const endsTs = Math.floor(giveaway.ends_at / 1000);
    const minsLeft = Math.max(0, Math.round((giveaway.ends_at - Date.now()) / 60000));
    const embed = infoEmbed('🎉 Giveaway Status', `Word **${giveaway.word}** — type it in chat to enter!`)
      .addFields(
        { name: '🏆 Prize', value: `**${fmtUSD(giveaway.prize_usd)}** (${fmtUSDC(giveaway.prize_usd)})`, inline: true },
        { name: '👥 Entries', value: `**${entries}**`, inline: true },
        { name: '⏰ Ends', value: `<t:${endsTs}:R> (~${minsLeft} min left)`, inline: true }
      );
    await message.reply({ embeds: [embed] });
  } catch (error) {
    console.error('Giveaway status error:', error);
    await replyError(message, `Couldn't load the giveaway:\n${error.message}`, 8000);
  }
}

/**
 * Pays a giveaway winner (winner already recorded on the row). Used by the
 * draw and by startup resume after a crash between draw and payout.
 * No wallet / vault short / network failure → queued as a pending tip
 * (sender 'giveaway'), which auto-pays when the winner (re)links a wallet.
 */
async function payGiveawayWinner(giveaway) {
  const winnerId = giveaway.winner_id;
  const prizeUSD = giveaway.prize_usd;

  const winner = await dbGet(`SELECT wallet FROM users WHERE discord_id = ?`, [winnerId]);
  let wallet = null;
  if (winner?.wallet) {
    try {
      const pk = new PublicKey(winner.wallet);
      if (pk.toString() !== '11111111111111111111111111111111') wallet = winner.wallet;
    } catch { wallet = null; }
  }

  async function queuePending(reason) {
    await dbRun(`INSERT INTO pending_tips (sender_id, receiver_id, amount_usd) VALUES (?, ?, ?)`,
      [GIVEAWAY_SENDER_ID, winnerId, prizeUSD]);
    return { outcome: 'queued', reason };
  }

  if (!wallet) return queuePending('no-wallet');

  const vault = await checkVaultFunds(prizeUSD, 1);
  if (!vault.ok) {
    console.error(`Giveaway #${giveaway.id}: vault short on ${vault.shortOn} at draw time — prize queued.`);
    return queuePending('vault-low');
  }

  const res = await sendUSDC(wallet, prizeUSD);
  if (!res.success) {
    console.error(`Giveaway #${giveaway.id}: payout failed, prize queued —`, res.error);
    return queuePending('network');
  }

  await dbRun(`INSERT INTO transactions (sender_id, receiver_id, amount_usd, amount_usdc, signature) VALUES (?, ?, ?, ?, ?)`,
    [GIVEAWAY_SENDER_ID, winnerId, prizeUSD, prizeUSD, res.signature]);
  await dbRun(`UPDATE users SET balance_usd = balance_usd + ?, total_received = total_received + ? WHERE discord_id = ?`,
    [prizeUSD, prizeUSD, winnerId]);
  await dbRun(`UPDATE giveaways SET signature = ? WHERE id = ?`, [res.signature, giveaway.id]);
  return { outcome: 'paid', signature: res.signature };
}

/** Winner announcement in the giveaway channel (gold embed + Solscan button when paid). */
async function announceGiveawayWinner(giveaway, payout) {
  let channel = null;
  try {
    channel = await client.channels.fetch(giveaway.channel_id);
  } catch { channel = null; }
  if (!channel || !channel.isTextBased?.()) {
    console.error(`Giveaway #${giveaway.id}: channel ${giveaway.channel_id} not available for the winner announcement.`);
    return;
  }

  if (payout.outcome === 'paid') {
    const embed = goldEmbed('🎉 GIVEAWAY WINNER!',
      `Congratulations <@${giveaway.winner_id}> — you won **${fmtUSD(giveaway.prize_usd)}**!`)
      .addFields(
        { name: '🏆 Prize', value: `**${fmtUSDC(giveaway.prize_usd)}**`, inline: true },
        { name: '🔑 Word', value: `**${giveaway.word}**`, inline: true }
      );
    await channel.send({ embeds: [embed], components: solscanRow(payout.signature) });
    return;
  }

  const reasonText = {
    'no-wallet': 'has no wallet linked yet — the prize is queued and auto-sends as soon as they run `!wallet <address>` to link one.',
    'vault-low': 'the bot vault is low right now — the prize is queued and auto-pays when they re-link their wallet with `!wallet <address>` after a refill.',
    'network': 'the payout hit a network issue — the prize is queued and auto-pays when they re-link their wallet with `!wallet <address>`.',
  }[payout.reason] || 'the prize is queued.';
  const embed = goldEmbed('🎉 GIVEAWAY WINNER!',
    `Congratulations <@${giveaway.winner_id}> — you won **${fmtUSD(giveaway.prize_usd)}**!\n\n⏳ ${reasonText}`)
    .addFields(
      { name: '🏆 Prize', value: `**${fmtUSDC(giveaway.prize_usd)}**`, inline: true },
      { name: '🔑 Word', value: `**${giveaway.word}**`, inline: true }
    );
  await channel.send({ embeds: [embed] });
}

/**
 * Draws a giveaway: picks one random entrant, records the winner BEFORE
 * paying (so a crash can never double-pay), pays, then announces.
 * Zero entries → announces "no entries" and pays nobody.
 */
async function drawGiveaway(giveawayId) {
  const giveaway = await dbGet(`SELECT * FROM giveaways WHERE id = ?`, [giveawayId]);
  if (!giveaway || giveaway.status !== 'active') return; // already drawn/cancelled

  uncacheGiveaway(giveaway.guild_id);

  const entries = await dbAll(`SELECT discord_id FROM giveaway_entries WHERE giveaway_id = ?`, [giveawayId]);

  let channel = null;
  try {
    channel = await client.channels.fetch(giveaway.channel_id);
  } catch { channel = null; }

  if (entries.length === 0) {
    // Conditional close: if a concurrent draw already ended it, do nothing.
    const closed = await dbRun(`UPDATE giveaways SET status = 'ended' WHERE id = ? AND status = 'active'`, [giveawayId]);
    if (!closed.changes) return;
    if (channel?.isTextBased?.()) {
      const embed = infoEmbed('🎉 Giveaway Ended',
        `The giveaway for **${fmtUSD(giveaway.prize_usd)}** (word **${giveaway.word}**) ended with **no entries** — nobody typed the word, so no prize was paid.`);
      await channel.send({ embeds: [embed] });
    }
    return;
  }

  const winnerId = entries[Math.floor(Math.random() * entries.length)].discord_id;
  // Claim the winner first — a crash after this point resumes the payout
  // on startup instead of drawing (and paying) a second winner. The
  // conditional UPDATE also stops a concurrent draw (timer + !gend at once)
  // from paying twice: if changes is 0, the other draw already claimed it.
  const claimed = await dbRun(
    `UPDATE giveaways SET status = 'ended', winner_id = ? WHERE id = ? AND status = 'active'`,
    [winnerId, giveawayId]
  );
  if (!claimed.changes) return;
  giveaway.winner_id = winnerId;

  const payout = await payGiveawayWinner(giveaway);
  await announceGiveawayWinner(giveaway, payout);
}

/**
 * Startup resume: re-arms timers for giveaways still running, draws any
 * whose end time passed while the bot was offline, and pays out any winner
 * recorded before a crash between draw and payout.
 */
async function resumeGiveaways() {
  try {
    const active = await dbAll(`SELECT * FROM giveaways WHERE status = 'active'`);
    for (const g of active) {
      if (g.ends_at <= Date.now()) {
        console.log(`Giveaway #${g.id} (word "${g.word}") ended while offline — drawing now.`);
        await drawGiveaway(g.id);
      } else {
        cacheGiveaway(g);
        armGiveawayTimer(g);
        console.log(`Giveaway #${g.id} re-armed (word "${g.word}", ends in ${Math.round((g.ends_at - Date.now()) / 60000)} min).`);
      }
    }

    const unpaid = await dbAll(
      `SELECT * FROM giveaways WHERE status = 'ended' AND winner_id IS NOT NULL AND signature IS NULL`
    );
    for (const g of unpaid) {
      const alreadyQueued = await dbGet(
        `SELECT id FROM pending_tips WHERE sender_id = ? AND receiver_id = ? AND processed = 0`,
        [GIVEAWAY_SENDER_ID, g.winner_id]
      );
      if (alreadyQueued) continue; // payout already queued — nothing to do
      console.log(`Giveaway #${g.id} has an unpaid winner — paying now.`);
      const payout = await payGiveawayWinner(g);
      await announceGiveawayWinner(g, payout);
    }
  } catch (error) {
    console.error('Failed to resume giveaways:', error);
  }
}

// ═══════════════════════════════════════════════════════════
// 📨 MESSAGE ROUTER (unchanged logic)
// ═══════════════════════════════════════════════════════════
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  trackActivity(message); // 🟢 feed the Tip Rain active-chatters pool
  trackGiveawayEntry(message); // 🎉 keyword giveaway entry

  const content = message.content.trim();

  if (content.toLowerCase().startsWith('!tip')) {
    await handleMessageTip(message);
    return;
  }

  if (content.startsWith('!')) {
    const args = content.split(' ');
    const command = args[0].toLowerCase();

    try {
      switch (command) {
        case '!wallet':  await handleMessageWallet(message); break;
        case '!bal':     await handleMessageBalance(message); break;
        case '!faucet':  await handleMessageFaucet(message); break;
        case '!history': await handleMessageHistory(message); break;
        case '!help':    await handleMessageHelp(message); break;
        case '!gp':      await handleMessageGivePerms(message); break;
        case '!rp':      await handleMessageRemovePerms(message); break;
        case '!lp':      await handleMessageListPerms(message); break;
        case '!last':    await handleMessageLast(message); break;
        case '!botbal':  await handleMessageBotBalance(message); break;
        case '!fon':     await handleMessageFaucetOn(message); break;
        case '!foff':    await handleMessageFaucetOff(message); break;
        case '!vp':      await handleMessageViewPending(message); break;
        case '!vpt':     await handleMessageViewMyPending(message); break;
        case '!rpt':     await handleMessageRemovePending(message); break;
        case '!gstart':  await handleMessageGiveawayStart(message); break;
        case '!gend':    await handleMessageGiveawayEnd(message); break;
        case '!gcancel': await handleMessageGiveawayCancel(message); break;
        case '!gstatus': await handleMessageGiveawayStatus(message); break;
        default: break; // ignore unknown commands
      }
    } catch (error) {
      console.error(`Error handling ${command}:`, error);
      const reply = await message.reply({ embeds: [errEmbed(`Error: ${error.message}`)] }).catch(() => {});
      if (reply) {
        autoDeleteErrorMessage(reply, 10000);
        autoDeleteErrorMessage(message, 10000);
      }
    }
  }
});

// ═══════════════════════════════════════════════════════════
// 🟢 READY
// ═══════════════════════════════════════════════════════════
client.once('ready', async () => {
  console.log(`Bot online! Logged in as ${client.user.tag}`);
  if (botKeypair) {
    console.log(`Bot wallet: ${botKeypair.publicKey.toString()}`);
  }
  if (OWNER_ID) {
    console.log(`Owner ID: ${OWNER_ID}`);
  }
  console.log('🎨 Modern UI loaded — branded embeds, avatars & Solscan buttons');
  console.log('📝 Commands: !wallet, !bal, !faucet, !history, !vpt, !help, !tip, !botbal');
  console.log('💸 Tips: USDC (SPL) — $1 = 1 USDC');
  console.log('🌧️ Tip Rain: !tip (=10 people) or !tip <count> — $0.10 USDC each to random active members (max 50)');
  console.log('🎉 Giveaway: !gstart <word> <usd> <minutes> • !gend • !gcancel • !gstatus');
  console.log('🔧 Admin: !gp, !rp, !lp, !last, !fon, !foff, !vp, !rpt');

  await resumeGiveaways();

  await client.user.setPresence({
    activities: [{ name: 'Official JJH TipBot', type: 3, state: '💰 Solana Tips' }],
    status: 'online'
  });
});

client.login(process.env.DISCORD_TOKEN);
