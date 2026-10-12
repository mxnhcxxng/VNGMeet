"use client";

// Unlisted minigame menu — reachable only by its /minigame link, not from the
// sidebar. Static routes win over the [[...slug]] catch-all, so the main app
// shell never sees /minigame/*.

import type { ComponentType, SVGProps } from "react";
import Link from "next/link";
import { Bulb, ChevronRight, MapPin, Picture } from "@gravity-ui/icons";
import { BrandIcon } from "@/components/BrandIcon";
import { GAME_SECONDS } from "@/components/Minigame";
import { useT } from "@/app/providers";
import type { TranslationKey } from "@/lib/i18n";

const GAMES: {
  href: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  title: TranslationKey;
  desc: TranslationKey;
}[] = [
  { href: "/minigame/guess", icon: Picture, title: "game.title", desc: "game.subtitle" },
  { href: "/minigame/recall", icon: Bulb, title: "game.recall.title", desc: "game.recall.subtitle" },
  { href: "/minigame/quiz", icon: MapPin, title: "game.quiz.title", desc: "game.quiz.subtitle" },
];

export default function MinigameMenuPage() {
  const t = useT();
  return (
    <div className="min-h-[100dvh] bg-[#f0f0f1] p-3 dark:bg-[#13161b] sm:p-4 lg:p-6">
      <main className="mx-auto flex w-full max-w-[720px] flex-col gap-5 rounded-2xl bg-white p-4 shadow-sm dark:bg-[#0c0e12] sm:p-6">
        <header className="flex items-center gap-3">
          <BrandIcon size={36} />
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-[#181d27] dark:text-[#f7f7f7]">
              {t("game.menu.title")}
            </h1>
            <p className="text-sm text-[#71717a] dark:text-[#94979c]">{t("game.menu.subtitle")}</p>
          </div>
        </header>

        <ul className="flex flex-col gap-2">
          {GAMES.map(({ href, icon: Icon, title, desc }, i) => (
            <li key={href}>
              <Link
                href={href}
                className="group flex items-center gap-4 rounded-2xl border border-[color:var(--separator)] p-4 transition-colors hover:border-[#f97316] hover:bg-[#FFF7F3] dark:hover:bg-[#1f1209]"
              >
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-[#FEEAE2] text-[#f97316] dark:bg-[#3B1202]">
                  <Icon width={22} height={22} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-xs font-medium text-[#a4a7ae] dark:text-[#94979c]">
                    {t("game.menu.number", { n: i + 1 })}
                  </span>
                  <span className="text-base font-semibold text-[#181d27] dark:text-[#f7f7f7]">
                    {t(title)}
                  </span>
                  <span className="text-sm text-[#71717a] dark:text-[#94979c]">
                    {t(desc, { seconds: GAME_SECONDS })}
                  </span>
                </span>
                <ChevronRight
                  width={18}
                  height={18}
                  className="shrink-0 text-[#a4a7ae] transition-transform group-hover:translate-x-0.5 group-hover:text-[#f97316]"
                />
              </Link>
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}
