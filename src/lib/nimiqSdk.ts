import { init, type NimiqProvider } from '@nimiq/mini-app-sdk';

let providerPromise: Promise<NimiqProvider> | null = null;

/** Lazily waits for Nimiq Pay to inject window.nimiq, then caches the provider. */
export function getNimiqProvider(): Promise<NimiqProvider> {
  if (!providerPromise) providerPromise = init({ timeout: 10_000 });
  return providerPromise;
}

const NIM_ALPHABET = '0123456789ABCDEFGHJKLMNPQRSTUVXY';

/** Validates a user-friendly Nimiq address (NQxx + 32 base32 chars) including its IBAN-style checksum. */
export function isValidNimAddress(input: string): boolean {
  const s = input.replace(/\s/g, '').toUpperCase();
  if (!/^NQ\d{2}/.test(s) || s.length !== 36) return false;
  if ([...s.slice(4)].some((c) => !NIM_ALPHABET.includes(c))) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  const numeric = [...rearranged].map((c) => (/\d/.test(c) ? c : String(c.charCodeAt(0) - 55))).join('');
  let rem = 0;
  for (const d of numeric) rem = (rem * 10 + Number(d)) % 97;
  return rem === 1;
}

/**
 * Sends a NIM tip via the Mini App SDK. 1 NIM = 100000 Luna.
 * The SDK (v0.1.0) only exposes NIM-native transactions — USDT tips go over
 * BNB Chain via the injected EVM provider instead.
 */
export async function sendNimTip(recipientAddress: string, amountNim: number): Promise<string> {
  const nimiq = await getNimiqProvider();
  const result = await nimiq.sendBasicTransaction({
    recipient: recipientAddress.replace(/\s/g, '').toUpperCase().replace(/(.{4})/g, '$1 ').trim(),
    value: Math.round(amountNim * 100_000),
  });
  if (typeof result !== 'string') {
    throw new Error(result?.error?.message ?? 'NIM tip failed.');
  }
  return result;
}
