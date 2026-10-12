"use client";

// Minigame 2: type every meeting room name you can remember in 60 seconds.

import { useEffect, useState } from "react";
import { Chip } from "@heroui/react";
import {
  AnswerInput,
  FeedbackChip,
  GAME_SECONDS,
  GameLobby,
  GameShell,
  type GameFeedback,
  TimerBar,
  useMinigame,
} from "@/components/Minigame";
import { useT } from "@/app/providers";
import { roomFlag } from "@/lib/roomFlags";
import type { TFunction } from "@/lib/i18n";

function feedbackLabel(t: TFunction, f: GameFeedback): string {
  const vars = { name: f.roomName ?? "", points: f.points ?? 0 };
  switch (f.result) {
    case "correct":
      return t("game.recall.correct", vars);
    case "close":
      return t("game.recall.close", vars);
    case "duplicate":
      return t("game.recall.duplicate", vars);
    default:
      return t("game.recall.wrong");
  }
}

function RoomTag({ name, tone }: { name: string; tone: "found" | "missed" }) {
  const flag = roomFlag(name);
  return (
    <Chip size="sm" variant="soft" color={tone === "found" ? "success" : "default"}>
      {flag && <span className="mr-1">{flag}</span>}
      {name}
    </Chip>
  );
}

export default function RecallGamePage() {
  const t = useT();
  const state = useMinigame("recall");
  const { feedback, finalResult } = state;
  // Rooms named this round, newest first.
  const [found, setFound] = useState<string[]>([]);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    if (state.phase === "playing" && state.summary.attempted === 0) {
      setFound([]);
      setTotal(0);
    }
  }, [state.phase, state.summary.attempted]);

  useEffect(() => {
    if (!feedback) return;
    if (feedback.totalRooms) setTotal(feedback.totalRooms);
    const name = feedback.roomName;
    if ((feedback.result === "correct" || feedback.result === "close") && name) {
      setFound((prev) => (prev.includes(name) ? prev : [name, ...prev]));
    }
  }, [feedback]);

  const counter = total ? t("game.recall.found", { found: found.length, total }) : null;

  return (
    <GameShell
      title={t("game.recall.title")}
      subtitle={t("game.recall.subtitle", { seconds: GAME_SECONDS })}
      state={state}
    >
      {state.phase === "playing" ? (
        <div className="flex flex-col gap-3">
          <TimerBar
            state={state}
            extra={
              counter && (
                <span className="font-normal text-[#71717a] dark:text-[#94979c]">{counter}</span>
              )
            }
          />
          <AnswerInput state={state} placeholder={t("game.recall.placeholder")} />
          <div className="flex min-h-7 items-center">
            {feedback?.result && feedback.result !== "skipped" && (
              <FeedbackChip label={feedbackLabel(t, feedback)} result={feedback.result} />
            )}
          </div>
          <div className="flex min-h-[240px] flex-wrap content-start gap-1.5 rounded-2xl bg-[#fafafa] p-3 dark:bg-[#13161b]">
            {found.map((name) => (
              <RoomTag key={name} name={name} tone="found" />
            ))}
          </div>
          {state.error && <p className="text-sm text-danger">{state.error}</p>}
        </div>
      ) : state.phase === "idle" || state.phase === "over" ? (
        <GameLobby
          state={state}
          rules={t("game.recall.rules", { exact: 100, close: 50 })}
          stats={t("game.recall.stats", {
            found: found.length,
            total: total || found.length + (finalResult?.missed?.length ?? 0),
          })}
        >
          {found.length > 0 && (
            <div className="flex w-full max-w-[560px] flex-col gap-2 text-left">
              <p className="text-sm font-medium text-[#181d27] dark:text-[#f7f7f7]">
                {t("game.recall.foundList")}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {found.map((name) => (
                  <RoomTag key={name} name={name} tone="found" />
                ))}
              </div>
            </div>
          )}
          {finalResult?.missed && finalResult.missed.length > 0 && (
            <div className="flex w-full max-w-[560px] flex-col gap-2 text-left">
              <p className="text-sm font-medium text-[#181d27] dark:text-[#f7f7f7]">
                {t("game.recall.missed", { count: finalResult.missed.length })}
              </p>
              <div className="flex max-h-[200px] flex-wrap gap-1.5 overflow-y-auto">
                {finalResult.missed.map((name) => (
                  <RoomTag key={name} name={name} tone="missed" />
                ))}
              </div>
            </div>
          )}
        </GameLobby>
      ) : null}
    </GameShell>
  );
}
