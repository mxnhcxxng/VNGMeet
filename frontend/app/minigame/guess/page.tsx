"use client";

// Minigame 1: see a room's photo, type its name.

import {
  AnswerInput,
  FeedbackChip,
  GAME_SECONDS,
  GameLobby,
  GameShell,
  type GameFeedback,
  RoomPhoto,
  TimerBar,
  useMinigame,
} from "@/components/Minigame";
import { useT } from "@/app/providers";
import type { TFunction } from "@/lib/i18n";

function feedbackLabel(t: TFunction, f: GameFeedback): string {
  const vars = { name: f.roomName ?? "", points: f.points ?? 0 };
  switch (f.result) {
    case "correct":
      return t("game.correct", vars);
    case "close":
      return t("game.close", vars);
    case "skipped":
      return t("game.skipped", vars);
    default:
      return t("game.wrong", vars);
  }
}

export default function GuessGamePage() {
  const t = useT();
  const state = useMinigame("guess");
  const { question, feedback } = state;

  return (
    <GameShell
      title={t("game.title")}
      subtitle={t("game.subtitle", { seconds: GAME_SECONDS })}
      state={state}
    >
      {state.phase === "playing" && question ? (
        <div className="flex flex-col gap-3">
          <TimerBar state={state} />
          <RoomPhoto
            question={question}
            overlay={
              <p className="font-mono text-xl font-bold tracking-wider text-white sm:text-2xl">
                {question.hint}
              </p>
            }
          />
          <AnswerInput state={state} placeholder={t("game.placeholder")} focusKey={question.index} />
          <div className="flex min-h-7 items-center justify-between gap-3">
            {feedback?.result ? (
              <FeedbackChip label={feedbackLabel(t, feedback)} result={feedback.result} />
            ) : (
              <span />
            )}
            <span className="text-xs text-[#a4a7ae] dark:text-[#94979c]">{t("game.skipHint")}</span>
          </div>
          {state.error && <p className="text-sm text-danger">{state.error}</p>}
        </div>
      ) : state.phase === "idle" || state.phase === "over" ? (
        <GameLobby
          state={state}
          rules={t("game.rules", { exact: 100, close: 50 })}
          stats={t("game.stats", { ...state.summary })}
        >
          {feedback?.result && (
            <FeedbackChip label={feedbackLabel(t, feedback)} result={feedback.result} />
          )}
        </GameLobby>
      ) : null}
    </GameShell>
  );
}
