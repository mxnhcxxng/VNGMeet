"use client";

// Unlisted minigame menu — reachable only by its /minigame link, not from the
// sidebar. Static routes win over the [[...slug]] catch-all, so the main app
// shell never sees /minigame/*.

import type { ComponentType, SVGProps } from "react";
import Link from "next/link";
import { ArrowRight, Bulb, Clock, MapPin, Picture } from "@gravity-ui/icons";
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
  { href: "/minigame/guess", icon: Picture, title: "game.title", desc: "game.menu.guessDesc" },
  { href: "/minigame/recall", icon: Bulb, title: "game.recall.title", desc: "game.menu.recallDesc" },
  { href: "/minigame/quiz", icon: MapPin, title: "game.quiz.title", desc: "game.menu.quizDesc" },
];

export default function MinigameMenuPage() {
  const t = useT();
  return (
    <div className="min-h-[100dvh] bg-[#f0f0f1] dark:bg-[#13161b]">
      <main className="mx-auto flex w-full max-w-[1080px] flex-col gap-6 px-4 py-8 sm:px-6 sm:py-12">
        <header className="flex items-center gap-3">
          <BrandIcon size={36} />
          <div>
            <h1 className="text-xl font-semibold text-[#181d27] dark:text-[#f7f7f7]">
              {t("game.menu.title")}
            </h1>
            <p className="text-sm text-[#71717a] dark:text-[#94979c]">{t("game.menu.subtitle")}</p>
          </div>
        </header>

        <ul className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {GAMES.map(({ href, icon: Icon, title, desc }) => (
            <li key={href}>
              <Link
                href={href}
                className="group flex h-full flex-col gap-5 rounded-2xl border border-transparent bg-white p-5 shadow-sm transition-colors hover:border-[#f97316] dark:bg-[#0c0e12]"
              >
                <Icon width={28} height={28} className="text-[#f97316]" />
                <span className="flex flex-1 flex-col gap-1.5">
                  <span className="text-base font-semibold text-[#181d27] dark:text-[#f7f7f7]">
                    {t(title)}
                  </span>
                  <span className="text-sm leading-relaxed text-[#71717a] dark:text-[#94979c]">
                    {t(desc)}
                  </span>
                </span>
                <span className="flex items-center justify-between border-t border-[color:var(--separator)] pt-4 text-sm text-[#71717a] dark:text-[#94979c]">
                  <span className="inline-flex items-center gap-1.5">
                    <Clock width={14} height={14} />
                    {t("game.menu.duration", { seconds: GAME_SECONDS })}
                  </span>
                  <ArrowRight
                    width={16}
                    height={16}
                    className="text-[#a4a7ae] transition-[color,transform] group-hover:translate-x-0.5 group-hover:text-[#f97316]"
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
