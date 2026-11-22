"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";

export default function LegacyATKTestPage() {
  const { organizationId } = useParams<{ organizationId: string }>();
  const router = useRouter();
  useEffect(() => {
    router.replace("/app/" + organizationId + "/pos");
  }, [organizationId, router]);
  return <main style={{ maxWidth: 720, margin: "40px auto", padding: 24 }}>
    <h1>Fiskalizimi automatik</h1>
    <p>Kuponët nuk krijohen më manualisht. Çdo faturë dërgohet automatikisht në ATK TEST pasi të regjistrohet pagesa.</p>
    <Link href={"/app/" + organizationId + "/pos"}>Kthehu te arka</Link>
  </main>;
}
