# Legacy Windows POS Agent — Deprecated

This folder is retained only as a historical implementation reference and for protocol comparison tests. **The current Fiskalo web application does not use this agent, does not call localhost, and must not require a Windows companion process.**

The supported runtime is the Cloudflare-hosted web application:
- Browser-held non-exportable POS key in IndexedDB
- Browser CSR and ATK TEST certificate matching
- Same-origin Cloudflare ATK TEST gateway
- Supabase fiscal journal and server-side acceptance controls
- Separate Cloudflare scheduled recovery Worker

Do not install or pair this legacy agent for the current web application. Its loopback API and DPAPI storage are not part of the supported Fiskalo deployment. See [Cloudflare ATK web runtime](../docs/CLOUDFLARE-ATK-WEB-RUNTIME.md).

The old C# source may be used as a protocol reference while comparing Protobuf and signature formats. It is not evidence of current ATK TEST acceptance or certification.
