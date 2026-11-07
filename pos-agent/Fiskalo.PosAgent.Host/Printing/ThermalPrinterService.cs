using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;

namespace Fiskalo.PosAgent.Host.Printing;

public sealed record InstalledPrinter(string Name, bool IsDefault, bool IsNetwork);

public static class ThermalPrinterService
{
    private const uint PrinterEnumLocal = 0x00000002;
    private const uint PrinterEnumConnections = 0x00000004;

    public static IReadOnlyList<InstalledPrinter> GetInstalledPrinters()
    {
        if (!OperatingSystem.IsWindows())
            throw new PlatformNotSupportedException("Windows printer enumeration is only available on Windows.");

        EnumPrinters(PrinterEnumLocal | PrinterEnumConnections, null, 4, IntPtr.Zero, 0, out var needed, out _);
        if (needed == 0) return Array.Empty<InstalledPrinter>();

        var buffer = Marshal.AllocHGlobal((int)needed);
        try
        {
            if (!EnumPrinters(PrinterEnumLocal | PrinterEnumConnections, null, 4, buffer, needed, out _, out var returned))
                throw new InvalidOperationException("Windows could not enumerate installed printers.");

            var result = new List<InstalledPrinter>((int)returned);
            var defaultPrinter = GetDefaultPrinterName();
            var size = Marshal.SizeOf<PrinterInfo4>();
            for (var i = 0; i < returned; i++)
            {
                var info = Marshal.PtrToStructure<PrinterInfo4>(IntPtr.Add(buffer, checked((int)i * size)));
                if (string.IsNullOrWhiteSpace(info.PrinterName)) continue;
                result.Add(new InstalledPrinter(info.PrinterName, string.Equals(info.PrinterName, defaultPrinter, StringComparison.OrdinalIgnoreCase), !string.IsNullOrWhiteSpace(info.ServerName)));
            }
            return result.OrderBy(x => x.Name, StringComparer.OrdinalIgnoreCase).ToArray();
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    public static void PrintToWindowsQueue(string printerName, byte[] data)
    {
        if (!OperatingSystem.IsWindows())
            throw new PlatformNotSupportedException("Windows spooler printing is only available on Windows.");
        if (string.IsNullOrWhiteSpace(printerName) || printerName.Length > 256)
            throw new ArgumentException("Choose an installed printer.");
        if (data.Length is < 1 or > 262144)
            throw new ArgumentException("Print data must be between 1 byte and 256 KB.");

        if (!OpenPrinter(printerName, out var printer, IntPtr.Zero))
            throw new InvalidOperationException("Windows could not open the selected printer. Check that it is installed and online.");

        var documentStarted = false;
        var pageStarted = false;
        try
        {
            var document = new DocInfo1 { DocumentName = "Fiskalo receipt", DataType = "RAW" };
            if (StartDocPrinter(printer, 1, ref document) == 0)
                throw new InvalidOperationException("Windows could not start the print job.");
            documentStarted = true;
            if (!StartPagePrinter(printer))
                throw new InvalidOperationException("Windows could not start the receipt page.");
            pageStarted = true;
            if (!WritePrinter(printer, data, data.Length, out var written) || written != data.Length)
                throw new InvalidOperationException("The printer did not accept the complete receipt data.");
        }
        finally
        {
            if (pageStarted) EndPagePrinter(printer);
            if (documentStarted) EndDocPrinter(printer);
            ClosePrinter(printer);
        }
    }

    public static async Task PrintToNetworkPrinterAsync(string host, byte[] data, CancellationToken cancellationToken)
    {
        if (!IPAddress.TryParse(host, out var address) || address.AddressFamily != AddressFamily.InterNetwork || !IsPrivateLanAddress(address))
            throw new ArgumentException("Enter the printer's private IPv4 address (for example 192.168.1.50).");
        if (data.Length is < 1 or > 262144)
            throw new ArgumentException("Print data must be between 1 byte and 256 KB.");

        using var client = new TcpClient(AddressFamily.InterNetwork);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(8));
        await client.ConnectAsync(address, 9100, timeout.Token);
        await using var stream = client.GetStream();
        await stream.WriteAsync(data, timeout.Token);
        await stream.FlushAsync(timeout.Token);
    }

    public static byte[] BuildTestReceipt(int paperWidth)
    {
        if (paperWidth is not (58 or 80)) throw new ArgumentOutOfRangeException(nameof(paperWidth));
        var columns = paperWidth == 58 ? 32 : 48;
        var lines = new[]
        {
            "FISKALO - TEST PRINT",
            new string('-', columns),
            "Printer connection successful",
            $"Paper profile: {paperWidth} mm",
            DateTimeOffset.Now.ToString("yyyy-MM-dd HH:mm:ss"),
            new string('-', columns),
            "This is a printer test only.",
            "Not a fiscal receipt.",
            "",
            ""
        };
        using var output = new MemoryStream();
        output.Write(new byte[] { 0x1B, 0x40 }); // Initialize
        output.Write(new byte[] { 0x1B, 0x61, 0x01 }); // Center
        foreach (var line in lines) WriteAscii(output, line);
        output.Write(new byte[] { 0x1B, 0x61, 0x01 }); // Center QR
        WriteAscii(output, "QR command test:");
        var qr = Encoding.ASCII.GetBytes("FISKALO-PRINTER-TEST");
        output.Write(new byte[] { 0x1D, 0x28, 0x6B, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00 }); // QR model 2
        output.Write(new byte[] { 0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x43, 0x06 }); // Module size
        output.Write(new byte[] { 0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x45, 0x31 }); // Error correction M
        var qrLength = qr.Length + 3;
        output.Write(new byte[] { 0x1D, 0x28, 0x6B, (byte)(qrLength & 0xFF), (byte)((qrLength >> 8) & 0xFF), 0x31, 0x50, 0x30 });
        output.Write(qr);
        output.Write(new byte[] { 0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x51, 0x30 });
        WriteAscii(output, "QR TEST ONLY");
        output.Write(new byte[] { 0x1B, 0x61, 0x00 }); // Left
        output.Write(new byte[] { 0x1D, 0x56, 0x00 }); // Full cut
        return output.ToArray();
    }

    private static void WriteAscii(Stream stream, string value)
    {
        var bytes = Encoding.ASCII.GetBytes(value);
        stream.Write(bytes);
        stream.WriteByte(0x0A);
    }

    private static bool IsPrivateLanAddress(IPAddress ip)
    {
        var b = ip.GetAddressBytes();
        return b[0] == 10 ||
               (b[0] == 172 && b[1] >= 16 && b[1] <= 31) ||
               (b[0] == 192 && b[1] == 168) ||
               (b[0] == 169 && b[1] == 254);
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PrinterInfo4
    {
        [MarshalAs(UnmanagedType.LPWStr)] public string PrinterName;
        [MarshalAs(UnmanagedType.LPWStr)] public string ServerName;
        public uint Attributes;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct DocInfo1
    {
        [MarshalAs(UnmanagedType.LPWStr)] public string DocumentName;
        [MarshalAs(UnmanagedType.LPWStr)] public string? OutputFile;
        [MarshalAs(UnmanagedType.LPWStr)] public string DataType;
    }

    private static string? GetDefaultPrinterName()
    {
        uint required = 0;
        _ = GetDefaultPrinter(null, ref required);
        if (required == 0) return null;
        var buffer = new StringBuilder((int)required);
        return GetDefaultPrinter(buffer, ref required) ? buffer.ToString() : null;
    }

    [DllImport("winspool.drv", EntryPoint = "GetDefaultPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetDefaultPrinter(StringBuilder? printerName, ref uint bufferSize);

    [DllImport("winspool.drv", EntryPoint = "EnumPrintersW", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumPrinters(uint flags, string? name, uint level, IntPtr buffer, uint bufferSize, out uint needed, out uint returned);
    [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenPrinter(string printerName, out IntPtr printer, IntPtr defaults);
    [DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern uint StartDocPrinter(IntPtr printer, uint level, ref DocInfo1 document);
    [DllImport("winspool.drv", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool StartPagePrinter(IntPtr printer);
    [DllImport("winspool.drv", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WritePrinter(IntPtr printer, byte[] data, int count, out int written);
    [DllImport("winspool.drv", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EndPagePrinter(IntPtr printer);
    [DllImport("winspool.drv", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EndDocPrinter(IntPtr printer);
    [DllImport("winspool.drv", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ClosePrinter(IntPtr printer);
}
