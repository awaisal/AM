import express from "express";
import { Telegraf } from "telegraf";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("Missing TELEGRAM_BOT_TOKEN env var.");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "1mb" }));

const bot = new Telegraf(token);

// ----------------------
// Config (minimal, sensible defaults)
// ----------------------
const RULES_TEXT =
  "📌 Group Policies:\n" +
  "1) No spam / promo links\n" +
  "2) No scams / phishing\n" +
  "3) Respect everyone\n" +
  "⚠️ Violations = delete + mute/ban";

const SPAM_KEYWORDS = [
  "crypto giveaway",
  "airdrop",
  "double your",
  "investment",
  "forex signals",
  "whatsapp me",
  "dm me",
  "earn daily",
  "100% profit",
  "binance"
];

const LINK_REGEX = /(https?:\/\/|t\.me\/|telegram\.me\/|www\.)/i;

// Flood control: allow N messages per window
const FLOOD_WINDOW_MS = 8000;
const FLOOD_MAX_MSG = 6;
const userMsgTracker = new Map(); // key: chatId:userId -> timestamps array

function key(chatId, userId) {
  return `${chatId}:${userId}`;
}

function now() {
  return Date.now();
}

function trackAndIsFlood(chatId, userId) {
  const k = key(chatId, userId);
  const t = now();
  const arr = userMsgTracker.get(k) || [];
  const filtered = arr.filter((x) => t - x < FLOOD_WINDOW_MS);
  filtered.push(t);
  userMsgTracker.set(k, filtered);
  return filtered.length > FLOOD_MAX_MSG;
}

function mentionOf(user) {
  if (!user) return "member";
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim() || "member";
  // Mention via HTML link to user id (works even if no username)
  return `<a href="tg://user?id=${user.id}">${escapeHtml(name)}</a>`;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function safeDelete(ctx) {
  try {
    if (ctx.message?.message_id) {
      await ctx.deleteMessage(ctx.message.message_id);
      return true;
    }
  } catch {}
  return false;
}

async function warn(ctx, text) {
  try {
    await ctx.reply(text, { parse_mode: "HTML", disable_web_page_preview: true });
  } catch {}
}

async function restrict(ctx, userId, seconds = 300) {
  // mute user for 'seconds'
  try {
    const until = Math.floor(Date.now() / 1000) + seconds;
    await ctx.telegram.restrictChatMember(ctx.chat.id, userId, {
      permissions: {
        can_send_messages: false,
        can_send_audios: false,
        can_send_documents: false,
        can_send_photos: false,
        can_send_videos: false,
        can_send_video_notes: false,
        can_send_voice_notes: false,
        can_send_polls: false,
        can_send_other_messages: false,
        can_add_web_page_previews: false,
        can_change_info: false,
        can_invite_users: true,
        can_pin_messages: false,
        can_manage_topics: false
      },
      until_date: until
    });
    return true;
  } catch {
    return false;
  }
}

function isAdminOrCreator(ctx) {
  // If we can detect message sender is admin, skip moderation
  // (Telegram API needs getChatMember; may fail if bot lacks rights)
  return false;
}

// ----------------------
// Welcome new members
// ----------------------
bot.on("new_chat_members", async (ctx) => {
  const members = ctx.message.new_chat_members || [];
  for (const m of members) {
    // Ignore if the bot itself joined
    if (m.is_bot && m.username && m.username.toLowerCase() === (ctx.botInfo?.username || "").toLowerCase()) continue;

    const text =
      `👋 Welcome ${mentionOf(m)}!\n\n` +
      `${escapeHtml(RULES_TEXT)}\n\n` +
      "✅ Introduce yourself briefly 🙂";
    await ctx.reply(text, { parse_mode: "HTML", disable_web_page_preview: true });
  }
});

// ----------------------
// Moderation: messages
// ----------------------
bot.on("message", async (ctx) => {
  const msg = ctx.message;

  // Only moderate groups/supergroups
  if (!ctx.chat || (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup")) return;

  // Skip admins? (left disabled due to API cost/permissions)
  // if (await isAdminOrCreator(ctx)) return;

  const userId = msg.from?.id;
  const text =
    msg.text ||
    msg.caption ||
    (msg.forward_origin ? "forwarded" : "") ||
    "";

  // Flood
  if (userId && trackAndIsFlood(ctx.chat.id, userId)) {
    const deleted = await safeDelete(ctx);
    // try mute
    const muted = await restrict(ctx, userId, 300);
    await warn(
      ctx,
      `🚫 Flood detected. ${mentionOf(msg.from)} ${muted ? "muted for 5 minutes" : "please slow down"}.`
    );
    return;
  }

  // Forwarded spam (common in groups)
  if (msg.forward_origin) {
    await safeDelete(ctx);
    await warn(ctx, `⚠️ Forwarded messages are not allowed. ${mentionOf(msg.from)}`);
    return;
  }

  // Keyword spam
  const lower = String(text).toLowerCase();
  const hasKeyword = SPAM_KEYWORDS.some((k) => lower.includes(k));
  if (hasKeyword) {
    await safeDelete(ctx);
    const muted = userId ? await restrict(ctx, userId, 600) : false;
    await warn(ctx, `🚫 Spam keywords detected. ${mentionOf(msg.from)} ${muted ? "muted for 10 minutes." : ""}`);
    return;
  }

  // Links
  if (LINK_REGEX.test(lower)) {
    // Allow admins to share links? Not implemented; simplest = block
    await safeDelete(ctx);
    const muted = userId ? await restrict(ctx, userId, 600) : false;
    await warn(ctx, `🔗 Links are blocked here. ${mentionOf(msg.from)} ${muted ? "muted for 10 minutes." : ""}`);
    return;
  }
});

// ----------------------
// Health check
// ----------------------
app.get("/", (req, res) => res.status(200).send("OK"));

// Telegram webhook endpoint
app.post("/telegram", async (req, res) => {
  try {
    await bot.handleUpdate(req.body);
  } catch (e) {
    console.error("handleUpdate error:", e);
  }
  res.sendStatus(200);
});

// ----------------------
// Auto webhook setup (the “only token” magic)
// ----------------------
async function ensureWebhook(publicUrl) {
  const webhookUrl = `${publicUrl.replace(/\/$/, "")}/telegram`;

  try {
    const info = await bot.telegram.getWebhookInfo();
    if (info.url === webhookUrl) {
      console.log("Webhook already set:", webhookUrl);
      return;
    }
  } catch {}

  console.log("Setting webhook:", webhookUrl);
  await bot.telegram.setWebhook(webhookUrl);
}

const PORT = process.env.PORT || 8080;

// Fly gives you FLY_APP_NAME automatically in runtime
function inferPublicUrl() {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL; // optional override (not required)
  const appName = process.env.FLY_APP_NAME;
  if (appName) return `https://${appName}.fly.dev`;
  // Fallback: if running locally
  return null;
}

app.listen(PORT, async () => {
  console.log(`Listening on :${PORT}`);

  const publicUrl = inferPublicUrl();
  if (!publicUrl) {
    console.log("No public URL inferred. Running locally? Skipping webhook auto-setup.");
    return;
  }

  try {
    await ensureWebhook(publicUrl);
    console.log("Webhook ensured ✅");
  } catch (e) {
    console.error("Webhook setup failed:", e?.message || e);
  }
});
