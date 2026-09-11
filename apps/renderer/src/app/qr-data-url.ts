import QRCode from 'qrcode';

/** Encode text as a PNG data URL for inline QR display. */
export async function qrDataUrl(text: string, size = 96): Promise<string> {
  const value = String(text || '').trim();
  if (!value) return '';
  return QRCode.toDataURL(value, {
    width: size,
    margin: 1,
    errorCorrectionLevel: 'M',
    color: { dark: '#111111', light: '#ffffff' },
  });
}
