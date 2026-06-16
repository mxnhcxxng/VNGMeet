import "./globals.css";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Providers } from "./providers";
import { DEFAULT_LANGUAGE, LANGUAGE_STORAGE_KEY } from "@/lib/i18n";
import type { Language } from "@/lib/api";

export const metadata: Metadata = {
  title: "VNG Meet — Meeting Rooms",
  description: "Meeting room availability grid",
};

// Runs before first paint so the correct theme class is on <html> immediately,
// avoiding a light→dark flash. Mirrors the logic in ThemeProvider.
const themeScript = `(function(){try{var m=localStorage.getItem('vng-theme');if(m!=='light'&&m!=='dark'&&m!=='system')m='system';var d=m==='dark'||(m==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);var r=document.documentElement;r.classList.toggle('dark',d);r.classList.toggle('light',!d);r.style.colorScheme=d?'dark':'light';}catch(e){}})();`;

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Read the language the user last chose from the request cookie so the server
  // renders the page in the right language up-front — no client-side flash and
  // no hydration mismatch (the first client render is seeded with this value).
  const cookieValue = (await cookies()).get(LANGUAGE_STORAGE_KEY)?.value;
  const language: Language =
    cookieValue === "vi" || cookieValue === "en" ? cookieValue : DEFAULT_LANGUAGE;

  return (
    <html lang={language} className="light" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-screen bg-background text-foreground">
        <Providers initialLanguage={language}>{children}</Providers>
      </body>
    </html>
  );
}
