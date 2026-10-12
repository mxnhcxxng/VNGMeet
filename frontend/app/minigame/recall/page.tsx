"use client";

// Minigame 2: type every meeting room name you can remember in 60 seconds.

import { useEffect, useState } from "react";
import { Bulb, CircleCheck, Copy, Keyboard, Pencil } from "@gravity-ui/icons";
import {
  AnswerInput,
  GAME_SECONDS,
  GameShell,
  type GameFeedback,
  QuestionBar,
  Stage,
  StatBubble,
  useMinigame,
} from "@/components/Minigame";
import { useT } from "@/app/providers";
import { roomFlag } from "@/lib/roomFlags";
import type { TFunction } from "@/lib/i18n";

const TAG_TONES = ["tile-accent", "tile-blue", "tile-warning", "tile-success"];

function feedbackLabel(t: TFunction, f: GameFeedback): string {
  const vars = { name: f.roomName ?? "", points: f.points ?? 0 };
  switch (f.result) {
    case "correct":
      return t("game.recall.correct", vars);
    case "close":
      return t("game.recall.close", vars);
    case "duplicate":
      return t("game.recall.duplicate", vars);
    case "skipped":
      return "";
    default:
      return t("game.recall.wrong");
  }
}

function RoomTag({ name, index, muted }: { name: string; index: number; muted?: boolean }) {
  const flag = roomFlag(name);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium text-[#181d27] dark:text-[#f7f7f7] ${
        muted ? "bg-default" : `game-tile ${TAG_TONES[index % TAG_TONES.length]}`
      }`}
    >
      {flag && <span>{flag}</span>}
      {name}
    </span>
  );
}

export default function RecallGamePage() {
  const t = useT();
  const state = useMinigame("recall", (f) => feedbackLabel(t, f));
  const { feedback, finalResult, totalRooms, phase } = state;
  // Rooms named this round, newest first.
  const [found, setFound] = useState<string[]>([]);

  useEffect(() => {
    if (phase === "lobby") setFound([]);
  }, [phase]);

  useEffect(() => {
    const name = feedback?.roomName;
    if ((feedback?.result === "correct" || feedback?.result === "close") && name) {
      setFound((prev) => (prev.includes(name) ? prev : [name, ...prev]));
    }
  }, [feedback]);

  const counter = `${found.length}/${totalRooms}`;

  return (
    <GameShell
      title={t("game.recall.title")}
      subtitle={t("game.recall.subtitle", { seconds: GAME_SECONDS })}
      rules={[
        { icon: Bulb, text: t("game.rule.recall.type"), tone: "accent" },
        { icon: CircleCheck, text: t("game.rule.recall.new"), points: "+100", tone: "success" },
        { icon: Pencil, text: t("game.rule.typo"), points: "+50", tone: "warning" },
        { icon: Copy, text: t("game.rule.recall.duplicate"), points: "0" },
        { icon: Keyboard, text: t("game.rule.spaces") },
      ]}
      state={state}
      results={
        <div className="flex w-full flex-col gap-4 text-left">
          <p className="text-center text-sm text-[#71717a] dark:text-[#94979c]">
            {t("game.recall.stats", { found: found.length, total: totalRooms })}
          </p>
          {found.length > 0 && (
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium text-[#181d27] dark:text-[#f7f7f7]">
                {t("game.recall.foundList")}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {found.map((name, i) => (
                  <RoomTag key={name} name={name} index={i} />
                ))}
              </div>
            </div>
          )}
          {finalResult?.missed && finalResult.missed.length > 0 && (
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium text-[#181d27] dark:text-[#f7f7f7]">
                {t("game.recall.missed", { count: finalResult.missed.length })}
              </p>
              <div className="flex max-h-[200px] flex-wrap gap-1.5 overflow-y-auto">
                {finalResult.missed.map((name, i) => (
                  <RoomTag key={name} name={name} index={i} muted />
                ))}
              </div>
            </div>
          )}
        </div>
      }
    >
      <QuestionBar>{t("game.recall.question")}</QuestionBar>
      <Stage state={state} side={<StatBubble value={counter} label={t("game.recall.rooms")} />}>
        <div className="flex h-full flex-col gap-3 overflow-y-auto rounded-2xl bg-white p-4 pt-16 shadow-sm dark:bg-[#0c0e12] sm:pt-4">
          <span className="text-sm font-medium text-[#71717a] dark:text-[#94979c] sm:hidden">
            {t("game.recall.found", { found: found.length, total: totalRooms })}
          </span>
          <div className="flex flex-wrap content-start gap-1.5">
            {found.map((name, i) => (
              <RoomTag key={name} name={name} index={found.length - 1 - i} />
            ))}
          </div>
        </div>
      </Stage>
      <AnswerInput state={state} placeholder={t("game.recall.placeholder")} />
      {state.error && <p className="text-sm text-danger">{state.error}</p>}
    </GameShell>
  );
}
