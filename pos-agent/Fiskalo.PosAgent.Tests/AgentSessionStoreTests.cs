using Fiskalo.PosAgent.Core.Security;
using Xunit;

namespace Fiskalo.PosAgent.Tests;

public sealed class AgentSessionStoreTests
{
    [Fact]
    public void ProtectedPairingTokenSurvivesAgentRestart()
    {
        if(!OperatingSystem.IsWindows())return;
        var directory=Path.Combine(Path.GetTempPath(),"fiskalo-agent-session-tests-"+Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var path=Path.Combine(directory,"session.dpapi");
        try
        {
            const string token="abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
            new WindowsDpapiAgentSessionStore(path).Save(token);
            Assert.Equal(token,new WindowsDpapiAgentSessionStore(path).Load());
        }
        finally{if(Directory.Exists(directory))Directory.Delete(directory,true);}
    }
}
