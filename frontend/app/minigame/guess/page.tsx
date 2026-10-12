"use client";

// Minigame 1: see a room's photo, type its name.

import {
  AnswerInput,
  FeedbackBanner,
  GAME_SECONDS,
  GameShell,
  type GameFeedback,
  QuestionBar,
  RoomPhoto,
  Stage,
  StatBubble,
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
  const { question, feedback, summary } = state;

  return (
    <GameShell
      title={t("game.title")}
      subtitle={t("game.subtitle", { seconds: GAME_SECONDS })}
      rules={t("game.rules", { exact: 100, close: 50 })}
      state={state}
      results={<p className="text-sm text-[#71717a] dark:text-[#94979c]">{t("game.stats", { ...summary })}</p>}
    >
      {question && (
        <>
          <QuestionBar>
            <span className="block text-sm font-medium text-[#71717a] dark:text-[#94979c]">
              {t("game.guess.question")}
            </span>
            <span className="font-mono tracking-wider">{question.hint}</span>
          </QuestionBar>
          <Stage
            state={state}
            side={<StatBubble value={summary.correct + summary.close} label={t("game.guess.right")} />}
          >
            <RoomPhoto question={question} />
          </Stage>
          {feedback?.result && (
            <FeedbackBanner result={feedback.result} label={feedbackLabel(t, feedback)} />
          )}
          <AnswerInput state={state} placeholder={t("game.placeholder")} focusKey={question.index} />
          <p className="text-center text-xs text-[#a4a7ae] dark:text-[#94979c]">{t("game.skipHint")}</p>
          {state.error && <p className="text-sm text-danger">{state.error}</p>}
        </>
      )}
    </GameShell>
  );
}
