import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Fiskalo — Fiscal POS",
  description: "Simple fiscal point of sale for Kosovo businesses."
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="sq"><body>{children}</body></html>;
}
