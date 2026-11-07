# Fiskalo Windows POS Agent

The first ATK device runtime for Fiskalo Basic. This agent runs on the Windows register and keeps the POS private key and encrypted fiscal journal on that machine.

## Build and test

```powershell
dotnet test pos-agent/Fiskalo.PosAgent.Tests/Fiskalo.PosAgent.Tests.csproj -c Release
dotnet build pos-agent/Fiskalo.PosAgent.Host/Fiskalo.PosAgent.Host.csproj -c Release
```

## Install

Run PowerShell as the Windows user that will operate the POS:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\pos-agent\windows\Install-FiskaloPosAgent.ps1
```

Use the printed one-time pairing code to pair the browser dashboard with the local agent. Keep the code private. The agent binds only to loopback and checks allowed browser origins.

## Security model

- POS private key, installation profile and queue are stored locally.
- DPAPI protects the private key, installation profile and queued fiscal records for the current Windows user/machine context.
- ATK TEST endpoints only; no production endpoint or production credential switch is exposed by this runtime.
- Ambiguous submissions require reconciliation; do not retry blindly.
- Local endpoint: `http://127.0.0.1:17843`.

## Current limitations

- Requires Windows; no Android/iOS agent in this MVP.
- The web checkout-to-agent paid-sale handoff still needs integration.
- Physical Windows device testing, real printer testing, and ATK TEST Sale/Cancel/Return acceptance are still required.
- A passing CI build is not ATK certification.
