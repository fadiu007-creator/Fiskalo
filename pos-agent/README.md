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

## Server-signed heartbeat

The Agent exposes paired-session endpoints `/api/v1/connectivity/challenge` and `/api/v1/connectivity/heartbeat`. The browser obtains a one-time nonce from the Agent, requests a server timestamp from Fiskalo's same-origin Cloudflare API, then returns the signed timestamp to the Agent. The Agent verifies the pinned P-256 public key and stores the monotonic timestamp in its DPAPI-protected connectivity journal. It rejects reused challenges, expired challenges, wrong business/POS identities, invalid signatures and non-increasing timestamps.

A heartbeat gap greater than 90 seconds is stored separately from ATK endpoint probe failures. Existing queued offline documents are re-anchored to the previous signed server heartbeat and their 48-hour recovery deadline is recalculated from that trusted anchor. Normal heartbeat intervals do not create an Internet outage record.

Each Windows Agent is pinned to the first business/POS identity that sends a verified heartbeat; use one Agent installation per physical register. Moving an Agent to a different POS requires settling/exporting its fiscal queue and resetting the local Agent data before pairing the new register.

The browser stores the Agent pairing token encrypted with its non-exportable IndexedDB key. Pair from the Fiskalo Basic POS header using the one-time code printed by the Agent. Set `FISKALO_ALLOWED_ORIGINS` to the exact HTTPS origin of the Fiskalo application before starting the Agent if the default origin list does not include it.

## Current limitations

- Requires Windows; no Android/iOS agent in this MVP.
- The Basic Agent checkout hands the immutable sale snapshot to the paired Windows Agent for local coupon signing/submission; the browser does not receive or export the private key.
- Physical Windows device testing, real printer testing, and ATK TEST Sale/Cancel/Return acceptance are still required.
- A passing CI build is not ATK certification.
