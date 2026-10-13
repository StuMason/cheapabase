import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "cheapabase docs (Next.js)",
  description: "supabase-js + cheapabase realtime in a Next.js App Router app",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <main>{children}</main>
      </body>
    </html>
  );
}
