function toHex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function randomHex(byteLength: number) {
  return toHex(crypto.getRandomValues(new Uint8Array(byteLength)));
}

// Mã ghép nối chỉ lưu dạng băm trong DB; Worker băm lại mã người dùng nhập để so khớp.
export async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return toHex(new Uint8Array(digest));
}

// Loại byte >= 250 để 10 chữ số có xác suất như nhau.
export function randomPairingCode() {
  const digits: string[] = [];
  const bytes = new Uint8Array(16);
  while (digits.length < 6) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte < 250 && digits.length < 6) digits.push(String(byte % 10));
    }
  }
  return digits.join('');
}








