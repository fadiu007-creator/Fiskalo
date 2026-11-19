import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const secretDirectory = join(root, ".secrets");
const privateKeyPath = join(secretDirectory, "atk-heartbeat-private-key.pem");
if (existsSync(privateKeyPath)) {
  throw new Error("A heartbeat private-key file already exists. Back it up securely; refusing to overwrite it.");
}

const targets = [
  {
    path: "src/lib/pos/server-heartbeat.ts",
    pattern: /(const PINNED_HEARTBEAT_PUBLIC_KEY_SPKI_BASE64 = ")[^"]+(")/,
  },
  {
    path: "src/lib/pos/browser-outbox.ts",
    pattern: /(const HEARTBEAT_PUBLIC_KEY_SPKI_BASE64 = ")[^"]+(")/,
  },
  {
    path: "pos-agent/Fiskalo.PosAgent.Core/Atk/ServerHeartbeatVerifier.cs",
    pattern: /(private const string TestPublicKeyBase64 =\s*")[^"]+(")/,
  },
];

const sourceFiles = targets.map((target) => {
  const filePath = join(root, target.path);
  if (!existsSync(filePath)) throw new Error("Required public-key pin file is missing: " + target.path);
  const content = readFileSync(filePath, "utf8");
  if (!target.pattern.test(content) || content.match(new RegExp(target.pattern.source, "g"))?.length !== 1) {
    throw new Error("Expected exactly one public-key pin in " + target.path);
  }
  return { ...target, filePath, content };
});

const article44Path = join(root, "docs/ATK-ARTICLE-44.md");
const article44 = readFileSync(article44Path, "utf8");
const fingerprintPattern = /(SHA-256 SPKI fingerprint is `)[0-9a-f]{64}(`)/;
if (!fingerprintPattern.test(article44) || article44.match(new RegExp(fingerprintPattern.source, "g"))?.length !== 1) {
  throw new Error("Expected exactly one documented heartbeat public-key fingerprint.");
}

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
const publicDer = publicKey.export({ type: "spki", format: "der" });
const publicKeyBase64 = publicDer.toString("base64");
const fingerprint = createHash("sha256").update(publicDer).digest("hex");
const probe = Buffer.from("fiskalo-atk-heartbeat-key-pair-self-test-v1");
const signature = sign("sha256", probe, privateKey);
if (!verify("sha256", probe, publicKey, signature)) {
  throw new Error("Generated heartbeat key pair failed its cryptographic self-test.");
}

const updatedSources = sourceFiles.map((source) => ({
  ...source,
  content: source.content.replace(source.pattern, (_match, before, after) => before + publicKeyBase64 + after),
}));
const updatedArticle44 = article44.replace(fingerprintPattern, (_match, before, after) => before + fingerprint + after);

mkdirSync(secretDirectory, { recursive: true });
writeFileSync(privateKeyPath, privatePem, { encoding: "utf8", flag: "wx", mode: 0o600 });
try {
  chmodSync(privateKeyPath, 0o600);
} catch {
  // Windows ACLs, rather than POSIX mode bits, protect the generated local secret.
}
for (const source of updatedSources) writeFileSync(source.filePath, source.content, "utf8");
writeFileSync(article44Path, updatedArticle44, "utf8");

console.log("Generated and self-verified a P-256 heartbeat key pair.");
console.log("Updated the server, browser and Windows Agent public-key pins.");
console.log("Updated the documented SPKI SHA-256 fingerprint: " + fingerprint);
console.log("Private key saved locally at .secrets/atk-heartbeat-private-key.pem");
console.log("NEVER commit or share the .secrets directory.");
console.log("Upload the private key to the fiskalo Cloudflare Worker as ATK_HEARTBEAT_PRIVATE_KEY_PEM, then deploy the commit containing the matching public key.");
