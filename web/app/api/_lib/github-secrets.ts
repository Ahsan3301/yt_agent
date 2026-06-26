/**
 * GitHub Actions Secrets writer.
 *
 * GitHub's API requires Actions secrets to be encrypted with the repo's
 * libsodium sealed-box public key before submission. Implementation uses
 * tweetnacl-sealedbox-js (pure-JS, ~5KB, no native deps, no bundling
 * issues under Turbopack).
 *
 * Used by /api/github/callback after the user grants `repo` scope so we
 * can push HF_TOKEN and RENDER_TRIGGER_KEY without them ever opening
 * the GitHub Settings UI.
 */
import sealedbox from "tweetnacl-sealedbox-js";

const GITHUB_API = "https://api.github.com";

type PublicKey = { key_id: string; key: string };

async function _getRepoPublicKey(
  accessToken: string,
  owner: string,
  repo: string,
): Promise<PublicKey> {
  const r = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/actions/secrets/public-key`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!r.ok) {
    throw new Error(`fetch public key: ${r.status} ${await r.text()}`);
  }
  return (await r.json()) as PublicKey;
}

function _sealSecret(value: string, publicKeyB64: string): string {
  // Buffer is available in Node runtime (this route declares runtime = nodejs).
  const pk = Uint8Array.from(Buffer.from(publicKeyB64, "base64"));
  const msg = new TextEncoder().encode(value);
  const sealed = sealedbox.seal(msg, pk);
  return Buffer.from(sealed).toString("base64");
}

/** Write one secret. Idempotent (overwrites). */
export async function setRepoSecret(
  accessToken: string,
  owner: string,
  repo: string,
  name: string,
  value: string,
): Promise<void> {
  const pk = await _getRepoPublicKey(accessToken, owner, repo);
  const encrypted_value = _sealSecret(value, pk.key);
  const r = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/actions/secrets/${name}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ encrypted_value, key_id: pk.key_id }),
    },
  );
  if (!r.ok) {
    throw new Error(`set secret ${name}: ${r.status} ${await r.text()}`);
  }
}

/** List existing secrets (just names; values aren't returned). */
export async function listRepoSecrets(
  accessToken: string,
  owner: string,
  repo: string,
): Promise<string[]> {
  const r = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/actions/secrets`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!r.ok) return [];
  const d = (await r.json()) as { secrets?: Array<{ name: string }> };
  return (d.secrets || []).map((s) => s.name);
}

/** Parse "owner/repo" or full URL. */
export function parseRepoFullName(input: string): { owner: string; repo: string } | null {
  if (!input) return null;
  const cleaned = input
    .trim()
    .replace(/\.git$/, "")
    .replace(/^https?:\/\/github\.com\//, "");
  const parts = cleaned.split("/");
  if (parts.length < 2) return null;
  return { owner: parts[0], repo: parts[1] };
}
