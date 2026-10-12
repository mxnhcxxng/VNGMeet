"use client";

// Minigame 3: see a room, then pick its floor (1/2/3 or "don't know"), its
// building (V1 / V2) or the way there (4 directions, in the player's language).

import { Button } from "@heroui/react";
import { CircleCheck, CircleQuestion, CircleXmark, MapPin } from "@gravity-ui/icons";
import {
  AnswerTiles,
  GAME_SECONDS,
  GameShell,
  type GameFeedback,
  QuestionBar,
  RoomPhoto,
  Stage,
  StatBubble,
  useMinigame,
} from "@/components/Minigame";
import { useLanguage, useT } from "@/app/providers";
import { roomFlag } from "@/lib/roomFlags";
import type { Language, MinigameQuestion } from "@/lib/api";
import type { TFunction } from "@/lib/i18n";

/** Display text for each option; directions come pre-translated. */
function optionLabels(t: TFunction, language: Language, q: MinigameQuestion): string[] {
  const options = q.options ?? [];
  if (q.kind === "direction") {
    return language === "vi" && q.optionsVi?.length === options.length ? q.optionsVi : options;
  }
  if (q.kind === "building") {
    return options.map((b) =>
      b === "V1" ? t("game.quiz.buildingV1") : b === "V2" ? t("game.quiz.buildingV2") : b,
    );
  }
  return options.map((f) =>
    f === "unknown" ? t("game.quiz.dontKnow") : t("game.quiz.floor", { value: f }),
  );
}

function questionLabel(t: TFunction, q: MinigameQuestion): string {
  const name = q.roomName ?? "";
  if (q.kind === "floor") return t("game.quiz.q.floor", { name });
  if (q.kind === "building") return t("game.quiz.q.building", { name });
  return t("game.quiz.q.direction", { name });
}

function feedbackLabel(t: TFunction, language: Language, f: GameFeedback): string {
  if (f.result === "correct") return t("game.quiz.correct");
  if (f.result === "unknown") return t("game.quiz.unknown");
  const q = f.answered;
  const answer = q && f.correctIndex != null ? optionLabels(t, language, q)[f.correctIndex] : "";
  // Directions are too long for a toast; the verdict alone is enough there.
  if (q?.kind === "direction") {
    return f.result === "skipped" ? t("game.quiz.skippedShort") : t("game.quiz.wrongShort");
  }
  return f.result === "skipped"
    ? t("game.quiz.skipped", { answer })
    : t("game.quiz.wrong", { answer });
}

export default function QuizGamePage() {
  const t = useT();
  const { language } = useLanguage();
  const state = useMinigame("quiz", (f) => feedbackLabel(t, language, f));
  const { question, summary } = state;
  const flag = roomFlag(question?.roomName);

  return (
    <GameShell
      title={t("game.quiz.title")}
      subtitle={t("game.quiz.subtitle", { seconds: GAME_SECONDS })}
      rules={[
        { icon: MapPin, text: t("game.rule.quiz.ask"), tone: "accent" },
        { icon: CircleCheck, text: t("game.rule.quiz.right"), points: "+100", tone: "success" },
        { icon: CircleXmark, text: t("game.rule.quiz.wrong"), points: "0", tone: "danger" },
        { icon: CircleQuestion, text: t("game.rule.quiz.dontKnow"), points: "+1" },
      ]}
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
              overlay={
                <p className="text-center text-2xl font-bold text-white">
                  {flag && <span className="mr-2">{flag}</span>}
                  {question.roomName}
                </p>
              }
            />
          </Stage>
          <AnswerTiles
            key={question.index}
            options={optionLabels(t, language, question)}
            singleColumn={question.kind === "direction"}
            compact={question.kind === "direction"}
            disabled={state.submitting}
            onPick={(i) => void state.submit(String(i))}
          />
          <div className="flex shrink-0 justify-end">
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
