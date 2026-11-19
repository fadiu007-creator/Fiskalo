import { handleHeartbeat } from "@/lib/pos/server-heartbeat";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleHeartbeat(request, {
    SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    ATK_HEARTBEAT_PRIVATE_KEY_PEM: process.env.ATK_HEARTBEAT_PRIVATE_KEY_PEM,
  });
}
