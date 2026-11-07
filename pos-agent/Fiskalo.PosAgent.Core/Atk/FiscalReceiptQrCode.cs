using QRCoder;

namespace Fiskalo.PosAgent.Core.Atk;

public static class FiscalReceiptQrCode
{
    public static string CreateSvgData(string citizenQrPayload)
    {
        if (string.IsNullOrWhiteSpace(citizenQrPayload))
            throw new ArgumentException("A signed CitizenCoupon QR payload is required.", nameof(citizenQrPayload));
        using var generator = new QRCodeGenerator();
        using var data = generator.CreateQrCode(citizenQrPayload, QRCodeGenerator.ECCLevel.M);
        var svg = new SvgQRCode(data).GetGraphic(5);
        if (!svg.StartsWith("<svg", StringComparison.Ordinal))
            throw new InvalidOperationException("QR encoder did not return an SVG document.");
        return svg;
    }
}
