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
  tone: string;
  title: TranslationKey;
  desc: TranslationKey;
}[] = [
  { href: "/minigame/guess", icon: Picture, tone: "tile-accent", title: "game.title", desc: "game.subtitle" },
  { href: "/minigame/recall", icon: Bulb, tone: "tile-blue", title: "game.recall.title", desc: "game.recall.subtitle" },
  { href: "/minigame/quiz", icon: MapPin, tone: "tile-success", title: "game.quiz.title", desc: "game.quiz.subtitle" },
];

export default function MinigameMenuPage() {
  const t = useT();
  return (
    <div className="min-h-[100dvh] bg-[#f0f0f1] dark:bg-[#13161b]">
      <main className="mx-auto flex w-full max-w-[960px] flex-col gap-8 p-3 py-10 sm:p-4 sm:py-16">
        <header className="flex flex-col items-center gap-2 text-center">
          <BrandIcon size={48} />
          <h1 className="text-3xl font-bold text-[#181d27] dark:text-[#f7f7f7] sm:text-4xl">
            {t("game.menu.title")}
          </h1>
          <p className="max-w-[480px] text-sm text-[#71717a] dark:text-[#94979c]">
            {t("game.menu.subtitle")}
          </p>
        </header>

        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {GAMES.map(({ href, icon: Icon, tone, title, desc }, i) => (
            <li key={href}>
              <Link
                href={href}
                className={`game-tile ${tone} group flex h-full flex-col gap-4 rounded-2xl p-5 transition-transform hover:-translate-y-0.5`}
              >
                <span className="flex items-center justify-between">
                  <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-white text-[color:var(--tile)] shadow-sm dark:bg-[#0c0e12]">
                    <Icon width={22} height={22} />
                  </span>
                  <span className="text-xs font-medium text-[#71717a] dark:text-[#94979c]">
                    {t("game.menu.number", { n: i + 1 })}
                  </span>
                </span>
                <span className="flex flex-1 flex-col gap-1">
                  <span className="text-lg font-bold text-[#181d27] dark:text-[#f7f7f7]">{t(title)}</span>
                  <span className="text-sm text-[#71717a] dark:text-[#94979c]">
                    {t(desc, { seconds: GAME_SECONDS })}
                  </span>
                </span>
                <span className="inline-flex items-center gap-1 text-sm font-semibold text-[color:var(--tile)]">
                  {t("game.menu.play")}
                  <ChevronRight
                    width={16}
                    height={16}
                    className="transition-transform group-hover:translate-x-0.5"
                  />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}
