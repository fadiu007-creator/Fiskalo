using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Fiskalo.PosAgent.Core.Security;

public sealed record AtkTestInstallationProfile(
    ulong Nui,
    string BusinessName,
    string FiscalizationNumber,
    ulong BranchId,
    ulong PosId,
    ulong ApplicationId,
    string VerificationCode,
    DateTimeOffset VerifiedAtUtc,
    string? CertificateThumbprint = null,
    DateTimeOffset? CertificateIssuedAtUtc = null);

/// <summary>
/// Stores the verified ATK test installation binding under Windows CurrentUser DPAPI.
/// The profile contains no private key, but includes the ATK verification code and is protected at rest.
/// </summary>
public sealed class WindowsDpapiInstallationStore
{
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("Fiskalo.PosAgent.AtkInstallation.v1");
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly string _path;

    public WindowsDpapiInstallationStore(string path)
    {
        if (string.IsNullOrWhiteSpace(path)) throw new ArgumentException("Installation profile path is required.", nameof(path));
        _path = Path.GetFullPath(path);
    }

    public AtkTestInstallationProfile? Load()
    {
        EnsureWindows();
        if (!File.Exists(_path)) return null;

        var protectedBytes = File.ReadAllBytes(_path);
        byte[]? plaintext = null;
        try
        {
            plaintext = ProtectedData.Unprotect(protectedBytes, Entropy, DataProtectionScope.CurrentUser);
            return JsonSerializer.Deserialize<AtkTestInstallationProfile>(plaintext, JsonOptions)
                ?? throw new CryptographicException("Protected ATK installation profile is empty.");
        }
        finally
        {
            CryptographicOperations.ZeroMemory(protectedBytes);
            if (plaintext is not null) CryptographicOperations.ZeroMemory(plaintext);
        }
    }

    public void Save(AtkTestInstallationProfile profile)
    {
        ArgumentNullException.ThrowIfNull(profile);
        EnsureWindows();
        var directory = Path.GetDirectoryName(_path)
            ?? throw new InvalidOperationException("Installation profile path must include a directory.");
        Directory.CreateDirectory(directory);

        var plaintext = JsonSerializer.SerializeToUtf8Bytes(profile, JsonOptions);
        byte[]? protectedBytes = null;
        var temporaryPath = _path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            protectedBytes = ProtectedData.Protect(plaintext, Entropy, DataProtectionScope.CurrentUser);
            using (var stream = new FileStream(temporaryPath, FileMode.CreateNew, FileAccess.Write,
                FileShare.None, 4096, FileOptions.WriteThrough))
            {
                stream.Write(protectedBytes);
                stream.Flush(flushToDisk: true);
            }
            File.Move(temporaryPath, _path, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporaryPath)) File.Delete(temporaryPath);
            CryptographicOperations.ZeroMemory(plaintext);
            if (protectedBytes is not null) CryptographicOperations.ZeroMemory(protectedBytes);
        }
    }

    private static void EnsureWindows()
    {
        if (!OperatingSystem.IsWindows())
            throw new PlatformNotSupportedException("ATK installation profiles currently require Windows DPAPI.");
    }
}
