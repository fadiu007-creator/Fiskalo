using System.Security.Cryptography;
using System.Text;

namespace Fiskalo.PosAgent.Core.Security;

/// <summary>Persists the paired local-agent bearer token under Windows CurrentUser DPAPI so offline queues survive agent restarts.</summary>
public sealed class WindowsDpapiAgentSessionStore
{
    private static readonly byte[] Entropy=Encoding.UTF8.GetBytes("Fiskalo.PosAgent.Session.v1");
    private readonly string _path;
    public WindowsDpapiAgentSessionStore(string path)
    {
        if(string.IsNullOrWhiteSpace(path))throw new ArgumentException("Session path is required.",nameof(path));
        _path=Path.GetFullPath(path);
    }
    public string? Load()
    {
        EnsureWindows();
        if(!File.Exists(_path))return null;
        var encrypted=File.ReadAllBytes(_path);
        byte[]? plain=null;
        try
        {
            plain=ProtectedData.Unprotect(encrypted,Entropy,DataProtectionScope.CurrentUser);
            var token=Encoding.UTF8.GetString(plain);
            return token.Length>=32?token:null;
        }
        finally
        {
            CryptographicOperations.ZeroMemory(encrypted);
            if(plain is not null)CryptographicOperations.ZeroMemory(plain);
        }
    }
    public void Save(string token)
    {
        if(string.IsNullOrWhiteSpace(token)||token.Length<32)throw new ArgumentException("A strong agent session token is required.",nameof(token));
        EnsureWindows();
        var directory=Path.GetDirectoryName(_path)??throw new InvalidOperationException("Session path must include a directory.");
        Directory.CreateDirectory(directory);
        var plain=Encoding.UTF8.GetBytes(token);
        byte[]? encrypted=null;
        var temporary=_path+"."+Guid.NewGuid().ToString("N")+".tmp";
        try
        {
            encrypted=ProtectedData.Protect(plain,Entropy,DataProtectionScope.CurrentUser);
            using(var stream=new FileStream(temporary,FileMode.CreateNew,FileAccess.Write,FileShare.None,4096,FileOptions.WriteThrough))
            {
                stream.Write(encrypted);
                stream.Flush(flushToDisk:true);
            }
            File.Move(temporary,_path,overwrite:true);
        }
        finally
        {
            if(File.Exists(temporary))File.Delete(temporary);
            CryptographicOperations.ZeroMemory(plain);
            if(encrypted is not null)CryptographicOperations.ZeroMemory(encrypted);
        }
    }
    private static void EnsureWindows()
    {
        if(!OperatingSystem.IsWindows())throw new PlatformNotSupportedException("Persistent local-agent pairing requires Windows DPAPI.");
    }
}
