import QRCode from "qrcode";

/** Creates a self-contained SVG QR for the exact signed ATK CitizenCoupon payload. */
export async function createCitizenQrSvg(payload: string): Promise<string> {
  if (!payload || payload.length > 16_384) throw new Error("Signed CitizenCoupon QR payload is missing or too large.");
  return QRCode.toString(payload, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 1,
    width: 320,
    color: { dark: "#000000", light: "#ffffff" },
  });
}
