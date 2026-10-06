import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ploot · Scheduler demo",
  description: "Ventana al backend del scheduler",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
