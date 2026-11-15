import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Fiskalo — Full & Basic",
  description: "Business management and ATK TEST fiscalization platform for Kosovo businesses."
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="sq"><body>{children}</body></html>;
}
