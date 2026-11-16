import type { Metadata } from "next";
import "./globals.css";
import { ServiceWorkerRegister } from "@/components/service-worker-register";
export const metadata: Metadata = {
  title: "Fiskalo — Fiscal POS",
  description: "Simple fiscal point of sale for Kosovo businesses.",
  manifest: "/manifest.webmanifest",
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="sq"><body><ServiceWorkerRegister />{children}</body></html>;
}
