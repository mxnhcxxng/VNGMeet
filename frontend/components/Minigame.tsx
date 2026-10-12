"use client";

// Shared pieces of the unlisted /minigame pages: the round lifecycle (auth check,
// start, 60s countdown, answer, finish), the page shell, timer bar, room photo
// and per-game leaderboard. Scoring lives on the backend (backend/app/minigame.py).

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button, Chip, InputGroup, Spinner, TextField } from "@heroui/react";
import { ArrowLeft, Clock, Cup, MapPin, Persons } from "@gravity-ui/icons";
import {
  api,
  type MinigameAnswerResult,
  type MinigameKind,
  type MinigameLeaderboard,
  type MinigameQuestion,
  type MinigameSummary,
} from "@/lib/api";
import { BrandIcon } from "@/components/BrandIcon";
import { useT } from "@/app/providers";

export const GAME_SECONDS = 60;

export type GamePhase = "loading" | "unauthenticated" | "idle" | "playing" | "over";

// The answer that was just scored, plus the question it answered (the quiz
// needs it to spell out the right option).
export type GameFeedback = MinigameAnswerResult & { answered: MinigameQuestion | null };

const EMPTY_SUMMARY: MinigameSummary = { score: 0, correct: 0, close: 0, attempted: 0 };

export const FEEDBACK_COLOR = {
  correct: "success",
  close: "warning",
  wrong: "danger",
  skipped: "default",
  duplicate: "default",
} as const;

export function useMinigame(game: MinigameKind) {
  const t = useT();
  const [phase, setPhase] = useState<GamePhase>("loading");
  const [gameId, setGameId] = useState<string | null>(null);
  const [question, setQuestion] = useState<MinigameQuestion | null>(null);
  const [summary, setSummary] = useState<MinigameSummary>(EMPTY_SUMMARY);
  const [feedback, setFeedback] = useState<GameFeedback | null>(null);
  const [finalResult, setFinalResult] = useState<MinigameAnswerResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [starting, setStarting] = useState(false);
  const [endsAt, setEndsAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [board, setBoard] = useState<MinigameLeaderboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const finishingRef = useRef(false);

  const loadBoard = useCallback(async () => {
    try {
      setBoard(await api.minigameLeaderboard(game));
    } catch {
      /* the board is a side panel; the game still works without it */
    }
  }, [game]);

  useEffect(() => {
    api
      .me()
      .then((me) => {
        if (!me.authenticated) {
          setPhase("unauthenticated");
          return;
        }
        setPhase("idle");
        void loadBoard();
      })
      .catch(() => setPhase("unauthenticated"));
  }, [loadBoard]);

  const handleError = (e: unknown) => {
    if (e instanceof Error && e.message === "UNAUTHENTICATED") {
      setPhase("unauthenticated");
      return;
    }
    setError(t("game.error"));
  };

  const endGame = useCallback(
    async (id: string) => {
      if (finishingRef.current) return;
      finishingRef.current = true;
      try {
        const res = await api.minigameFinish(id);
        setSummary(res);
        setFinalResult(res);
      } catch {
        /* keep the last known score on screen */
      }
      setPhase("over");
      setQuestion(null);
      void loadBoard();
    },
    [loadBoard],
  );

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const res = await api.minigameStart(game);
      finishingRef.current = false;
      setGameId(res.gameId);
      setQuestion(res.question);
      setSummary(EMPTY_SUMMARY);
      setFeedback(null);
      setFinalResult(null);
      setEndsAt(Date.now() + res.durationSeconds * 1000);
      setNow(Date.now());
      setPhase("playing");
    } catch (e) {
      handleError(e);
    } finally {
      setStarting(false);
    }
  };

  // Countdown tick; the server holds the authoritative deadline.
  useEffect(() => {
    if (phase !== "playing") return;
    const timer = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(timer);
  }, [phase]);

  const remainingMs = Math.max(0, endsAt - now);
  useEffect(() => {
    if (phase === "playing" && remainingMs === 0 && gameId) void endGame(gameId);
  }, [phase, remainingMs, gameId, endGame]);

  /** Score one answer; resolves to the server's verdict, or null if not sent. */
  const submit = async (answer: string): Promise<MinigameAnswerResult | null> => {
    if (!gameId || submitting || phase !== "playing") return null;
    setSubmitting(true);
    try {
      const res = await api.minigameAnswer(gameId, answer);
      setSummary(res);
      if (res.result) setFeedback({ ...res, answered: question });
      if (res.finished) {
        await endGame(gameId);
      } else if (res.question) {
        setQuestion(res.question);
      }
      return res;
    } catch (e) {
      handleError(e);
      return null;
    } finally {
      setSubmitting(false);
    }
  };

  return {
    phase,
    question,
    summary,
    feedback,
    finalResult,
    submitting,
    starting,
    remainingMs,
    board,
    error,
    start,
    submit,
  };
}

export type MinigameState = ReturnType<typeof useMinigame>;

/** Page frame: back link, title, the game body and the leaderboard beside it. */
export function GameShell({
  title,
  subtitle,
  state,
  children,
}: {
  title: string;
  subtitle: string;
  state: MinigameState;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <div className="min-h-[100dvh] bg-[#f0f0f1] p-3 dark:bg-[#13161b] sm:p-4 lg:p-6">
      <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-3 lg:flex-row lg:items-start lg:gap-4">
        <main className="flex min-w-0 flex-1 flex-col gap-4 rounded-2xl bg-white p-4 shadow-sm dark:bg-[#0c0e12] sm:p-6">
          <Link
            href="/minigame"
            className="inline-flex w-fit items-center gap-1 text-sm text-[#71717a] hover:text-[#f97316] dark:text-[#94979c]"
          >
            <ArrowLeft width={14} height={14} />
            {t("game.back")}
          </Link>
          <header className="flex items-center gap-3">
            <BrandIcon size={36} />
            <div className="min-w-0">
              <h1 className="text-lg font-semibold text-[#181d27] dark:text-[#f7f7f7]">{title}</h1>
              <p className="text-sm text-[#71717a] dark:text-[#94979c]">{subtitle}</p>
            </div>
          </header>

          {state.phase === "loading" && (
            <div className="flex h-[360px] items-center justify-center">
              <Spinner />
            </div>
          )}
          {state.phase === "unauthenticated" && <LoginPrompt />}
          {(state.phase === "playing" || state.phase === "idle" || state.phase === "over") &&
            children}
        </main>

        {state.phase !== "unauthenticated" && state.phase !== "loading" && (
          <Leaderboard board={state.board} />
        )}
      </div>
    </div>
  );
}

export function LoginPrompt() {
  const t = useT();
  return (
    <div className="flex h-[360px] flex-col items-center justify-center gap-2 text-center">
      <p className="text-base font-semibold text-[#181d27] dark:text-[#f7f7f7]">
        {t("game.loginRequired")}
      </p>
      <p className="text-sm text-[#71717a] dark:text-[#94979c]">{t("game.loginHint")}</p>
      <Button className="mt-4 rounded-full" onPress={() => window.location.assign("/")}>
        {t("game.goLogin")}
      </Button>
    </div>
  );
}

/** Idle (rules + start) and game-over (score + play again) screen. */
export function GameLobby({
  state,
  rules,
  stats,
  children,
}: {
  state: MinigameState;
  rules: string;
  stats: string;
  children?: ReactNode;
}) {
  const t = useT();
  const over = state.phase === "over";
  return (
    <div className="flex min-h-[360px] flex-col items-center justify-center gap-3 text-center">
      {over ? (
        <>
          <Cup width={40} height={40} className="text-[#f97316]" />
          <p className="text-sm font-medium text-[#71717a] dark:text-[#94979c]">{t("game.over")}</p>
          <p className="text-3xl font-bold text-[#181d27] dark:text-[#f7f7f7]">
            {t("game.finalScore", { score: state.summary.score })}
          </p>
          <p className="text-sm text-[#71717a] dark:text-[#94979c]">{stats}</p>
          {children}
        </>
      ) : (
        <p className="max-w-[420px] text-sm text-[#71717a] dark:text-[#94979c]">{rules}</p>
      )}
      <Button className="mt-2 rounded-full px-8" onPress={state.start} isPending={state.starting}>
        {over ? t("game.playAgain") : t("game.start")}
      </Button>
      {state.error && <p className="text-sm text-danger">{state.error}</p>}
    </div>
  );
}

/** Countdown chip, running score and the shrinking progress bar. */
export function TimerBar({ state, extra }: { state: MinigameState; extra?: ReactNode }) {
  const t = useT();
  const seconds = Math.ceil(state.remainingMs / 1000);
  const urgent = seconds <= 10;
  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <Chip size="md" variant="soft" color={urgent ? "danger" : "accent"}>
          <span className="inline-flex items-center gap-1 tabular-nums">
            <Clock width={14} height={14} />
            {t("game.timeLeft")}: {seconds}s
          </span>
        </Chip>
        <span className="flex items-center gap-3 text-sm font-semibold tabular-nums text-[#181d27] dark:text-[#f7f7f7]">
          {extra}
          <span>
            {t("game.score")}: {state.summary.score}
          </span>
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-default">
        <div
          className={`h-full rounded-full transition-[width] duration-200 ease-linear ${
            urgent ? "bg-danger" : "bg-[#f97316]"
          }`}
          style={{ width: `${(state.remainingMs / (GAME_SECONDS * 1000)) * 100}%` }}
        />
      </div>
    </>
  );
}

/** Room photo with a dark bottom fade; `overlay` sits on top of the fade. */
export function RoomPhoto({
  question,
  overlay,
  showLocation = true,
  className = "aspect-[4/3] sm:aspect-[16/9]",
}: {
  question: MinigameQuestion;
  overlay?: ReactNode;
  showLocation?: boolean;
  className?: string;
}) {
  const t = useT();
  const location = [question.office, question.building, question.floor && `F${question.floor}`]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className={`relative w-full overflow-hidden rounded-2xl bg-default-100 ${className}`}>
      {question.image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={question.index}
          src={question.image}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-[#71717a] dark:text-[#94979c]">
          {t("game.noPhoto")}
        </div>
      )}
      <div className="absolute inset-0 bg-gradient-to-b from-transparent from-40% to-black/80" />
      <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-2 p-4">
        {overlay}
        {showLocation && (
          <div className="flex flex-wrap items-center justify-center gap-1">
            {location && (
              <Chip size="sm" color="accent" variant="soft" className="backdrop-blur-sm">
                <span className="inline-flex items-center gap-1">
                  <MapPin width={12} height={12} />
                  {location}
                </span>
              </Chip>
            )}
            {question.capacity ? (
              <Chip size="sm" color="accent" variant="soft" className="backdrop-blur-sm">
                <span className="inline-flex items-center gap-1">
                  <Persons width={12} height={12} />
                  {question.capacity}
                </span>
              </Chip>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

export function FeedbackChip({ label, result }: { label: string; result: keyof typeof FEEDBACK_COLOR }) {
  return (
    <Chip size="md" variant="soft" color={FEEDBACK_COLOR[result]}>
      {label}
    </Chip>
  );
}

const MEDALS = ["🥇", "🥈", "🥉"];

export function Leaderboard({ board }: { board: MinigameLeaderboard | null }) {
  const t = useT();
  const meOutsideTop = board?.me && !board.entries.some((e) => e.isMe) ? board.me : null;
  return (
    <aside className="flex w-full flex-col gap-3 rounded-2xl bg-white p-4 shadow-sm dark:bg-[#0c0e12] lg:w-[340px] lg:shrink-0">
      <div className="flex items-center gap-2">
        <Cup width={18} height={18} className="text-[#f97316]" />
        <h2 className="text-base font-semibold text-[#181d27] dark:text-[#f7f7f7]">
          {t("game.leaderboard")}
        </h2>
      </div>
      {!board ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-10 animate-pulse rounded-xl bg-default" />
          ))}
        </div>
      ) : board.entries.length === 0 ? (
        <p className="py-6 text-center text-sm text-[#71717a] dark:text-[#94979c]">
          {t("game.leaderboardEmpty")}
        </p>
      ) : (
        <ol className="flex flex-col gap-1">
          {board.entries.map((e) => (
            <li
              key={e.rank}
              className={`flex items-center gap-3 rounded-xl px-3 py-2 ${
                e.isMe ? "bg-[#FEEAE2] dark:bg-[#3B1202]" : "odd:bg-[#fafafa] dark:odd:bg-[#13161b]"
              }`}
            >
              <span className="w-6 shrink-0 text-center text-sm font-semibold tabular-nums text-[#71717a] dark:text-[#94979c]">
                {MEDALS[e.rank - 1] ?? e.rank}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-[#181d27] dark:text-[#f7f7f7]">
                {e.name}
                {e.isMe && <span className="ml-1.5 text-xs text-[#f97316]">({t("game.you")})</span>}
              </span>
              <span className="shrink-0 text-sm font-semibold tabular-nums text-[#181d27] dark:text-[#f7f7f7]">
                {e.score}{" "}
                <span className="text-xs font-normal text-[#71717a] dark:text-[#94979c]">
                  {t("game.pts")}
                </span>
              </span>
            </li>
          ))}
        </ol>
      )}
      {meOutsideTop && (
        <p className="border-t border-[color:var(--separator)] pt-3 text-sm text-[#71717a] dark:text-[#94979c]">
          {t("game.yourBest", { rank: meOutsideTop.rank, score: meOutsideTop.score })}
        </p>
      )}
    </aside>
  );
}

/** Text answer box: Enter submits, then it clears and keeps focus. */
export function AnswerInput({
  state,
  placeholder,
  focusKey,
}: {
  state: MinigameState;
  placeholder: string;
  focusKey?: unknown;
}) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, [focusKey]);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        // Keep what was typed rather than drop it while the last answer is in flight.
        if (state.submitting) return;
        const answer = value;
        setValue("");
        void state.submit(answer);
        inputRef.current?.focus();
      }}
    >
      <TextField fullWidth aria-label={placeholder}>
        <InputGroup variant="secondary">
          <InputGroup.Input
            ref={inputRef}
            placeholder={placeholder}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </InputGroup>
      </TextField>
    </form>
  );
}
