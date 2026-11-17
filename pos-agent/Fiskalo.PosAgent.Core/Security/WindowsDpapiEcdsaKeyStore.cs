using System.Security.Cryptography;
using System.Text;

namespace Fiskalo.PosAgent.Core.Security;

/// <summary>
/// Stores one P-256 signing key as a DPAPI CurrentUser-protected PKCS#8 blob.
/// The plaintext private key exists only briefly in process memory.
/// </summary>
public sealed class WindowsDpapiEcdsaKeyStore
{
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("Fiskalo.PosAgent.SigningKey.v1");
    private static readonly object ProcessLock = new();

    public ECDsa LoadOrCreate(string protectedKeyPath)
    {
        if (string.IsNullOrWhiteSpace(protectedKeyPath))
            throw new ArgumentException("Protected key path is required.", nameof(protectedKeyPath));
        EnsureWindows();

        var path = Path.GetFullPath(protectedKeyPath);
        lock (ProcessLock)
        {
            if (File.Exists(path)) return Load(path);

            using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
            var privateKey = key.ExportPkcs8PrivateKey();
            try
            {
                var protectedKey = ProtectedData.Protect(privateKey, Entropy, DataProtectionScope.CurrentUser);
                WriteAtomically(path, protectedKey);
            }
            finally
            {
                CryptographicOperations.ZeroMemory(privateKey);
            }

            return Load(path);
        }
    }

    public void Delete(string protectedKeyPath)
    {
        if (string.IsNullOrWhiteSpace(protectedKeyPath))
            throw new ArgumentException("Protected key path is required.", nameof(protectedKeyPath));
        EnsureWindows();
        var path = Path.GetFullPath(protectedKeyPath);
        lock (ProcessLock)
        {
            if (File.Exists(path)) File.Delete(path);
        }
    }

    private static ECDsa Load(string path)
    {
        var protectedKey = File.ReadAllBytes(path);
        byte[]? privateKey = null;
        try
        {
            privateKey = ProtectedData.Unprotect(protectedKey, Entropy, DataProtectionScope.CurrentUser);
            var key = ECDsa.Create();
            try
            {
                key.ImportPkcs8PrivateKey(privateKey, out var bytesRead);
                if (bytesRead != privateKey.Length)
                    throw new CryptographicException("Protected signing key contains trailing data.");
                return key;
            }
            catch
            {
                key.Dispose();
                throw;
            }
        }
        finally
        {
            CryptographicOperations.ZeroMemory(protectedKey);
            if (privateKey is not null) CryptographicOperations.ZeroMemory(privateKey);
        }
    }

    private static void WriteAtomically(string path, byte[] protectedKey)
    {
        var directory = Path.GetDirectoryName(path)
            ?? throw new InvalidOperationException("Signing key path must include a directory.");
        Directory.CreateDirectory(directory);
        var temporaryPath = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using (var stream = new FileStream(temporaryPath, FileMode.CreateNew, FileAccess.Write,
                FileShare.None, 4096, FileOptions.WriteThrough))
            {
                stream.Write(protectedKey);
                stream.Flush(flushToDisk: true);
            }
            File.Move(temporaryPath, path, overwrite: false);
        }
        finally
        {
            if (File.Exists(temporaryPath)) File.Delete(temporaryPath);
            CryptographicOperations.ZeroMemory(protectedKey);
        }
    }

    private static void EnsureWindows()
    {
        if (!OperatingSystem.IsWindows())
            throw new PlatformNotSupportedException("Fiskalo local signing-key storage currently requires Windows DPAPI.");
    }
}
