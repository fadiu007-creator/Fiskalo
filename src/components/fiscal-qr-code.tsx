"use client";

import { useMemo } from "react";
import qrcode from "qrcode-generator";

type Props = {
  payload: string | null | undefined;
  size?: number;
  label?: string;
};

export function FiscalQrCode({ payload, size = 176, label = "Kodi QR i kuponit fiskal" }: Props) {
  const svg = useMemo(() => {
    if (!payload?.trim()) return "";
    try {
      const qr = qrcode(0, "M");
      qr.addData(payload, "Byte");
      qr.make();
      const cellSize = Math.max(2, Math.floor(size / (qr.getModuleCount() + 8)));
      return qr.createSvgTag(cellSize, 4);
    } catch {
      return "";
    }
  }, [payload, size, label]);

  if (!payload?.trim()) return null;
  if (!svg) {
    return <div role="status" aria-label={label} style={{ color: "#9a3412", fontSize: 12 }}>Kodi QR nuk mund të gjenerohet.</div>;
  }

  return (
    <div
      role="img"
      aria-label={label}
      style={{ width: size, height: size, maxWidth: "100%", background: "#fff", padding: 4, borderRadius: 8, flex: "none" }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
