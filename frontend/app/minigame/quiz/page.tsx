"use client";

// Minigame 3: see a room, pick its floor / building / directions from 4 options.

import { Button } from "@heroui/react";
import {
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
import { roomFlag } from "@/lib/roomFlags";
import type { MinigameQuestion } from "@/lib/api";
import type { TFunction } from "@/lib/i18n";

function optionLabel(t: TFunction, q: MinigameQuestion, value: string): string {
  return q.kind === "floor" ? t("game.quiz.floor", { value }) : value;
}

function questionLabel(t: TFunction, q: MinigameQuestion): string {
  const name = q.roomName ?? "";
  if (q.kind === "floor") return t("game.quiz.q.floor", { name });
  if (q.kind === "building") return t("game.quiz.q.building", { name });
  return t("game.quiz.q.direction", { name });
}

function feedbackLabel(t: TFunction, f: GameFeedback): string {
  if (f.result === "correct") return t("game.correct", { points: f.points ?? 0 });
  const q = f.answered;
  const right = q?.options && f.correctIndex != null ? q.options[f.correctIndex] : null;
  const answer = q && right ? optionLabel(t, q, right) : "";
  return f.result === "skipped"
    ? t("game.quiz.skipped", { answer })
    : t("game.quiz.wrong", { answer });
}

export default function QuizGamePage() {
  const t = useT();
  const state = useMinigame("quiz");
  const { question, feedback } = state;
  const flag = roomFlag(question?.roomName);

  return (
    <GameShell
      title={t("game.quiz.title")}
      subtitle={t("game.quiz.subtitle", { seconds: GAME_SECONDS })}
      state={state}
    >
      {state.phase === "playing" && question ? (
        <div className="flex flex-col gap-3">
          <TimerBar state={state} />
          <RoomPhoto
            question={question}
            showLocation={false}
            className="aspect-[16/9] sm:aspect-[21/9]"
            overlay={
              <p className="text-center text-xl font-bold text-white sm:text-2xl">
                {flag && <span className="mr-2">{flag}</span>}
                {question.roomName}
              </p>
            }
          />
          <p className="text-base font-semibold text-[#181d27] dark:text-[#f7f7f7]">
            {questionLabel(t, question)}
          </p>
          <div
            className={`grid gap-2 ${
              question.kind === "direction" ? "grid-cols-1" : "grid-cols-2"
            }`}
          >
            {(question.options ?? []).map((option, i) => (
              <Button
                key={`${question.index}-${i}`}
                variant="secondary"
                className={`h-auto min-h-12 w-full justify-start whitespace-normal rounded-xl px-4 py-3 text-left ${
                  question.kind === "direction" ? "text-sm" : "text-base"
                }`}
                isDisabled={state.submitting}
                onPress={() => void state.submit(String(i))}
              >
                <span className="mr-2 font-semibold text-[#f97316]">
                  {String.fromCharCode(65 + i)}.
                </span>
                {optionLabel(t, question, option)}
              </Button>
            ))}
          </div>
          <div className="flex min-h-7 items-center justify-between gap-3">
            {feedback?.result ? (
              <FeedbackChip label={feedbackLabel(t, feedback)} result={feedback.result} />
            ) : (
              <span />
            )}
            <Button
              size="sm"
              variant="ghost"
              isDisabled={state.submitting}
              onPress={() => void state.submit("")}
            >
              {t("game.quiz.skip")}
            </Button>
          </div>
          {state.error && <p className="text-sm text-danger">{state.error}</p>}
        </div>
      ) : state.phase === "idle" || state.phase === "over" ? (
        <GameLobby
          state={state}
          rules={t("game.quiz.rules", { points: 100 })}
          stats={t("game.quiz.stats", {
            correct: state.summary.correct,
            attempted: state.summary.attempted,
          })}
        >
          {feedback?.result && (
            <FeedbackChip label={feedbackLabel(t, feedback)} result={feedback.result} />
          )}
        </GameLobby>
      ) : null}
    </GameShell>
  );
}
