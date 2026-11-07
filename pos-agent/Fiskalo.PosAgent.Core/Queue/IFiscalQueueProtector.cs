namespace Fiskalo.PosAgent.Core.Queue;

/// <summary>
/// Encrypts and decrypts fiscal queue snapshots with a key protected by the host operating system.
/// Implementations must fail closed when OS key protection is unavailable.
/// </summary>
public interface IFiscalQueueProtector
{
    byte[] Protect(byte[] plaintext);
    byte[] Unprotect(byte[] protectedData);
}
