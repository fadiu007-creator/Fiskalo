import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptPath = fileURLToPath(new URL("../scripts/provision-atk-heartbeat-key.mjs", import.meta.url));

test("heartbeat key provisioning pins a self-tested pair and refuses to overwrite the private key", () => {
  const root = mkdtempSync(join(tmpdir(), "fiskalo-heartbeat-key-"));
  try {
    mkdirSync(join(root, "src/lib/pos"), { recursive: true });
    mkdirSync(join(root, "pos-agent/Fiskalo.PosAgent.Core/Atk"), { recursive: true });
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "src/lib/pos/server-heartbeat.ts"),
      'const PINNED_HEARTBEAT_PUBLIC_KEY_SPKI_BASE64 = "old-server-key";\n');
    writeFileSync(join(root, "src/lib/pos/browser-outbox.ts"),
      'const HEARTBEAT_PUBLIC_KEY_SPKI_BASE64 = "old-browser-key";\n');
    writeFileSync(join(root, "pos-agent/Fiskalo.PosAgent.Core/Atk/ServerHeartbeatVerifier.cs"),
      'private const string TestPublicKeyBase64 =\n        "old-agent-key";\n');
    writeFileSync(join(root, "docs/ATK-ARTICLE-44.md"),
      'SHA-256 SPKI fingerprint is `' + "0".repeat(64) + '`\n');

    const firstRun = spawnSync(process.execPath, [scriptPath], { cwd: root, encoding: "utf8" });
    assert.equal(firstRun.status, 0, firstRun.stderr || firstRun.stdout);
    const privatePath = join(root, ".secrets/atk-heartbeat-private-key.pem");
    const privatePem = readFileSync(privatePath, "utf8");
    const privateKey = createPrivateKey(privatePem);
    const publicDer = createPublicKey(privateKey).export({ type: "spki", format: "der" });
    const publicBase64 = publicDer.toString("base64");
    const fingerprint = createHash("sha256").update(publicDer).digest("hex");

    assert.match(readFileSync(join(root, "src/lib/pos/server-heartbeat.ts"), "utf8"), new RegExp(publicBase64));
    assert.match(readFileSync(join(root, "src/lib/pos/browser-outbox.ts"), "utf8"), new RegExp(publicBase64));
    assert.match(readFileSync(join(root, "pos-agent/Fiskalo.PosAgent.Core/Atk/ServerHeartbeatVerifier.cs"), "utf8"), new RegExp(publicBase64));
    assert.match(readFileSync(join(root, "docs/ATK-ARTICLE-44.md"), "utf8"), new RegExp(fingerprint));
    assert.match(firstRun.stdout, /self-verified a P-256 heartbeat key pair/);

    const secondRun = spawnSync(process.execPath, [scriptPath], { cwd: root, encoding: "utf8" });
    assert.notEqual(secondRun.status, 0);
    assert.match(secondRun.stderr, /refusing to overwrite it/);
    assert.equal(readFileSync(privatePath, "utf8"), privatePem);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
