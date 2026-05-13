// Self-signed CA + per-host leaf cert issuance.
//
// At boot we generate a fresh CA per pod lifetime, write the cert (public) to
// /lap-shared/ca.crt so the harness container can trust it. The private key
// stays in this process's memory only.
//
// For each new outbound host the agent calls, we mint a leaf cert signed by
// our CA, cached in-memory keyed by host.

import { promises as fs } from "node:fs";
import { Crypto } from "@peculiar/webcrypto";
import * as x509 from "@peculiar/x509";
import path from "node:path";

const crypto = new Crypto();
x509.cryptoProvider.set(crypto);

export interface CA {
  certPem: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

export interface Leaf {
  cert: string; // PEM
  key: string;  // PEM
}

const leafCache = new Map<string, Leaf>();

const ALG: RsaHashedKeyGenParams = {
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
};

async function exportPkcs8(key: CryptoKey): Promise<string> {
  const buf = await crypto.subtle.exportKey("pkcs8", key);
  return toPem(Buffer.from(buf), "PRIVATE KEY");
}

function toPem(der: Buffer, label: string): string {
  const b64 = der.toString("base64").match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

export async function bootstrapCa(sharedDir: string): Promise<CA> {
  const keys = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
  const ca = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "CN=lap-vault, O=LiteLLM",
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 7 * 24 * 3600_000), // 7 days
    keys,
    signingAlgorithm: ALG,
    extensions: [
      new x509.BasicConstraintsExtension(true, 1, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.digitalSignature,
        true,
      ),
    ],
  });

  const certPem = ca.toString("pem");
  await fs.mkdir(sharedDir, { recursive: true });
  await fs.writeFile(path.join(sharedDir, "ca.crt"), certPem, { mode: 0o644 });

  return { certPem, privateKey: keys.privateKey, publicKey: keys.publicKey };
}

export async function issueLeaf(ca: CA, host: string): Promise<Leaf> {
  const cached = leafCache.get(host);
  if (cached) return cached;

  const keys = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);

  // Parse the CA cert so we can use it as issuer.
  const caCert = new x509.X509Certificate(ca.certPem);

  const leaf = await x509.X509CertificateGenerator.create({
    serialNumber: Math.floor(Math.random() * 1e10).toString(),
    subject: `CN=${host}`,
    issuer: caCert.subject,
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 24 * 3600_000),
    signingKey: ca.privateKey,
    publicKey: keys.publicKey,
    signingAlgorithm: ALG,
    extensions: [
      new x509.BasicConstraintsExtension(false, 0, true),
      new x509.ExtendedKeyUsageExtension(["1.3.6.1.5.5.7.3.1"], true),
      new x509.SubjectAlternativeNameExtension([{ type: "dns", value: host }]),
    ],
  });

  const out: Leaf = {
    cert: leaf.toString("pem"),
    key: await exportPkcs8(keys.privateKey),
  };
  leafCache.set(host, out);
  return out;
}
