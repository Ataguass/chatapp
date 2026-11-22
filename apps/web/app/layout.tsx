import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Chatapp — Private messages, made simple",
  description: "A quiet, private place to talk with your people.",
};

export const viewport: Viewport = { themeColor: "#f6f8fb", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
