// Encrypts Meta access tokens before they are stored in Supabase.
// AES-256-GCM. Key comes from META_TOKEN_ENC_KEY (preferred); falls back to a
// key derived from JWT_SECRET so nothing breaks, with a one-time warning.
const crypto = require("crypto");

const PREFIX = "enc:v1:";
let warned = false;

function getKey() {
  if (process.env.META_TOKEN_ENC_KEY) {
    return crypto.createHash("sha256").update(process.env.META_TOKEN_ENC_KEY).digest();
  }
  if (!process.env.JWT_SECRET) {
    throw new Error("META_TOKEN_ENC_KEY or JWT_SECRET must be set");
  }
  if (!warned) {
    warned = true;
    console.warn("META_TOKEN_ENC_KEY not set - deriving token encryption key from JWT_SECRET. Set a dedicated META_TOKEN_ENC_KEY.");
  }
  return crypto.createHmac("sha256", process.env.JWT_SECRET).update("aqsetu-meta-token-key").digest();
}

function encryptToken(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv, tag, enc].map(b => b.toString("base64")).join(":");
}

// Rows written before encryption existed hold plaintext; return them as-is.
function decryptToken(stored) {
  if (!stored || !String(stored).startsWith(PREFIX)) return stored;
  const [iv, tag, enc] = String(stored).slice(PREFIX.length).split(":").map(s => Buffer.from(s, "base64"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

module.exports = { encryptToken, decryptToken };
