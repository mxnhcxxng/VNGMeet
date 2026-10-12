"use client";

// Minigame 3: see a room, pick its floor / building / directions from 4 options.

import { Button } from "@heroui/react";
import {
  AnswerTiles,
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
  const { question, feedback, summary } = state;
  const flag = roomFlag(question?.roomName);

  return (
    <GameShell
      title={t("game.quiz.title")}
      subtitle={t("game.quiz.subtitle", { seconds: GAME_SECONDS })}
      rules={t("game.quiz.rules", { points: 100 })}
      state={state}
      results={
        <p className="text-sm text-[#71717a] dark:text-[#94979c]">
          {t("game.quiz.stats", { correct: summary.correct, attempted: summary.attempted })}
        </p>
      }
    >
      {question && (
        <>
          <QuestionBar>{questionLabel(t, question)}</QuestionBar>
          <Stage
            state={state}
            side={<StatBubble value={summary.attempted} label={t("game.quiz.answered")} />}
          >
            <RoomPhoto
              question={question}
              showLocation={false}
              className="aspect-[16/9] sm:aspect-[21/9]"
              overlay={
                <p className="text-center text-2xl font-bold text-white">
                  {flag && <span className="mr-2">{flag}</span>}
                  {question.roomName}
                </p>
              }
            />
          </Stage>
          {feedback?.result && (
            <FeedbackBanner result={feedback.result} label={feedbackLabel(t, feedback)} />
          )}
          <AnswerTiles
            key={question.index}
            options={(question.options ?? []).map((o) => optionLabel(t, question, o))}
            singleColumn={question.kind === "direction"}
            disabled={state.submitting}
            onPick={(i) => void state.submit(String(i))}
          />
          <div className="flex justify-end">
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
        </>
      )}
    </GameShell>
  );
}
