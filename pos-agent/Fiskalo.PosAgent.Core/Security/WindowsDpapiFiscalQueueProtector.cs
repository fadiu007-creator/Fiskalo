using System.Security.Cryptography;
using System.Text;

namespace Fiskalo.PosAgent.Core.Security;

/// <summary>
/// Windows CurrentUser DPAPI protector for local fiscal queue snapshots.
/// It intentionally fails on non-Windows systems; there is no plaintext fallback.
/// </summary>
public sealed class WindowsDpapiFiscalQueueProtector : Queue.IFiscalQueueProtector
{
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("Fiskalo.PosAgent.FiscalQueue.v1");

    public byte[] Protect(byte[] plaintext)
    {
        ArgumentNullException.ThrowIfNull(plaintext);
        EnsureWindows();
        return ProtectedData.Protect(plaintext, Entropy, DataProtectionScope.CurrentUser);
    }

    public byte[] Unprotect(byte[] protectedData)
    {
        ArgumentNullException.ThrowIfNull(protectedData);
        EnsureWindows();
        return ProtectedData.Unprotect(protectedData, Entropy, DataProtectionScope.CurrentUser);
    }

    private static void EnsureWindows()
    {
        if (!OperatingSystem.IsWindows())
            throw new PlatformNotSupportedException("Fiskalo local DPAPI protection is currently supported on Windows only.");
    }
}
