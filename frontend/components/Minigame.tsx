"use client";

// Shared pieces of the unlisted /minigame pages. The layout follows Kahoot —
// question bar on top, timer / photo / counter stage in the middle, answers at
// the bottom, a player bar underneath, a join screen before and a podium after —
// but in the app's own colors and HeroUI buttons. Scoring lives on the backend
// (backend/app/minigame.py); this only renders and times the round.

import {
  type ComponentType,
  type ReactNode,
  type SVGProps,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { Button, InputGroup, Spinner, TextField, toast } from "@heroui/react";
import { ArrowLeft, Cup, MapPin, Persons } from "@gravity-ui/icons";
import {
  api,
  type MinigameAnswerResult,
  type MinigameKind,
  type MinigameLeaderboard,
  type MinigameLeaderboardEntry,
  type MinigamePlayer,
  type MinigameQuestion,
  type MinigameSummary,
} from "@/lib/api";
import { BrandIcon } from "@/components/BrandIcon";
import { useT } from "@/app/providers";

export const GAME_SECONDS = 60;

/** One line of a game's "how to play" card. */
export interface GameRule {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  text: string;
  /** Points badge on the right, e.g. "+100". */
  points?: string;
  tone?: "accent" | "success" | "warning" | "danger" | "neutral";
}

export type GamePhase = "loading" | "unauthenticated" | "lobby" | "playing" | "over";
export type GameResult = NonNullable<MinigameAnswerResult["result"]>;

// The answer that was just scored, plus the question it answered (the quiz
// needs it to spell out the right option).
export type GameFeedback = MinigameAnswerResult & { answered: MinigameQuestion | null };

const EMPTY_SUMMARY: MinigameSummary = { score: 0, correct: 0, close: 0, attempted: 0 };

const TEXT = "text-[#181d27] dark:text-[#f7f7f7]";
const MUTED = "text-[#71717a] dark:text-[#94979c]";
const CARD = "rounded-2xl bg-white shadow-sm dark:bg-[#0c0e12]";

// --------------------------------------------------------------------------- //
// Round lifecycle
// --------------------------------------------------------------------------- //
/** Toast copy for a scored answer; each game words its own verdicts ("" = no toast). */
export type FeedbackLabel = (feedback: GameFeedback) => string;

const TOAST_KIND: Record<GameResult, "success" | "warning" | "danger" | null> = {
  correct: "success",
  close: "warning",
  unknown: null,
  wrong: "danger",
  skipped: null,
  duplicate: null,
};

function showResultToast(label: string, result: GameResult, points: number, t: ReturnType<typeof useT>) {
  // One verdict on screen at a time — fast typists would otherwise stack them.
  toast.clear();
  const options = {
    description: points > 0 ? t("game.toastPoints", { points }) : undefined,
    timeout: 1800,
  };
  const kind = TOAST_KIND[result];
  if (kind) toast[kind](label, options);
  else toast(label, options);
}

export function useMinigame(game: MinigameKind, feedbackLabel: FeedbackLabel) {
  const t = useT();
  const [phase, setPhase] = useState<GamePhase>("loading");
  const [player, setPlayer] = useState<MinigamePlayer | null>(null);
  const [domain, setDomain] = useState("");
  const [gameId, setGameId] = useState<string | null>(null);
  const [question, setQuestion] = useState<MinigameQuestion | null>(null);
  const [summary, setSummary] = useState<MinigameSummary>(EMPTY_SUMMARY);
  const [feedback, setFeedback] = useState<GameFeedback | null>(null);
  const [finalResult, setFinalResult] = useState<MinigameAnswerResult | null>(null);
  const [totalRooms, setTotalRooms] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [starting, setStarting] = useState(false);
  const [endsAt, setEndsAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [board, setBoard] = useState<MinigameLeaderboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const finishingRef = useRef(false);

  const loadBoard = useCallback(
    async (attempt?: string | null) => {
      try {
        setBoard(await api.minigameLeaderboard(game, attempt));
      } catch {
        /* the board is a side panel; the game still works without it */
      }
    },
    [game],
  );

  useEffect(() => {
    api
      .minigamePlayer()
      .then((p) => {
        setPlayer(p);
        setPhase("lobby");
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
      toast.clear();
      setPhase("over");
      setQuestion(null);
      void loadBoard(id);
    },
    [loadBoard],
  );

  const start = async (forDomain: string) => {
    setStarting(true);
    setError(null);
    try {
      const res = await api.minigameStart(game, forDomain);
      finishingRef.current = false;
      setGameId(res.gameId);
      setDomain(res.domain);
      setQuestion(res.question);
      setTotalRooms(res.totalRooms);
      setSummary(EMPTY_SUMMARY);
      setFeedback(null);
      setFinalResult(null);
      setEndsAt(Date.now() + res.durationSeconds * 1000);
      setNow(Date.now());
      setPhase("playing");
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("400")) setError(t("game.domainInvalid"));
      else handleError(e);
    } finally {
      setStarting(false);
    }
  };

  const backToLobby = () => {
    setError(null);
    setPhase("lobby");
    void loadBoard();
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
      if (res.result) {
        const scored = { ...res, answered: question };
        setFeedback(scored);
        const label = feedbackLabel(scored);
        if (label) showResultToast(label, res.result, res.points ?? 0, t);
      }
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
    player,
    domain,
    question,
    summary,
    feedback,
    finalResult,
    totalRooms,
    submitting,
    starting,
    remainingMs,
    board,
    error,
    start,
    submit,
    backToLobby,
  };
}

export type MinigameState = ReturnType<typeof useMinigame>;

// --------------------------------------------------------------------------- //
// Page frame
// --------------------------------------------------------------------------- //
/**
 * Full-viewport game page. While playing, `children` is the round (question
 * bar, stage, answers) squeezed into exactly one screen with the player bar
 * underneath; otherwise the shell shows the join screen or the results.
 */
export function GameShell({
  title,
  subtitle,
  rules,
  state,
  results,
  children,
}: {
  title: string;
  subtitle: string;
  rules: GameRule[];
  state: MinigameState;
  results?: ReactNode;
  children: ReactNode;
}) {
  const t = useT();
  const playing = state.phase === "playing";
  return (
    <div
      className={`flex flex-col bg-[#f0f0f1] dark:bg-[#13161b] ${
        playing ? "h-[100dvh] overflow-hidden" : "min-h-[100dvh]"
      }`}
    >
      <div className="flex min-h-0 w-full flex-1 flex-col gap-3 p-3 sm:p-4 lg:px-8">
        <div className="flex shrink-0 items-center justify-between gap-3">
          <Link
            href="/minigame"
            className={`inline-flex items-center gap-1 text-sm ${MUTED} hover:text-[#f97316]`}
          >
            <ArrowLeft width={14} height={14} />
            {t("game.back")}
          </Link>
          <span className={`text-sm font-semibold ${TEXT}`}>{title}</span>
        </div>

        {state.phase === "loading" && (
          <div className="flex flex-1 items-center justify-center">
            <Spinner />
          </div>
        )}
        {state.phase === "unauthenticated" && <LoginPrompt />}
        {state.phase === "lobby" && (
          <Lobby state={state} title={title} subtitle={subtitle} rules={rules} />
        )}
        {playing && (
          <>
            <div className="flex min-h-0 flex-1 flex-col gap-3">{children}</div>
            <PlayerBar state={state} />
          </>
        )}
        {state.phase === "over" && <Results state={state}>{results}</Results>}
      </div>
    </div>
  );
}

function LoginPrompt() {
  const t = useT();
  return (
    <div className="flex flex-1 items-center justify-center">
      <div className={`${CARD} flex w-full max-w-[400px] flex-col items-center gap-2 p-6 text-center`}>
        <BrandIcon size={40} />
        <p className={`mt-2 text-base font-semibold ${TEXT}`}>{t("game.loginRequired")}</p>
        <p className={`text-sm ${MUTED}`}>{t("game.loginHint")}</p>
        <Button className="mt-4 w-full rounded-full" onPress={() => window.location.assign("/")}>
          {t("game.goLogin")}
        </Button>
      </div>
    </div>
  );
}

/** Join screen: who is playing, then go — beside the leaderboard on wide screens. */
function Lobby({
  state,
  title,
  subtitle,
  rules,
}: {
  state: MinigameState;
  title: string;
  subtitle: string;
  rules: GameRule[];
}) {
  const t = useT();
  const isAdmin = Boolean(state.player?.isAdmin);
  const [value, setValue] = useState(isAdmin ? "" : (state.player?.domain ?? ""));
  const canStart = value.trim().length > 0;
  return (
    <div className="grid flex-1 grid-cols-1 items-center gap-6 py-4 lg:grid-cols-2 lg:gap-10">
      <div className="flex flex-col items-center gap-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <BrandIcon size={48} />
          <h1 className={`text-3xl font-bold sm:text-4xl ${TEXT}`}>{title}</h1>
          <p className={`max-w-[480px] text-sm ${MUTED}`}>{subtitle}</p>
        </div>

        <form
          className={`${CARD} flex w-full max-w-[420px] flex-col gap-3 p-5`}
          onSubmit={(e) => {
            e.preventDefault();
            if (canStart) void state.start(value.trim());
          }}
        >
          <TextField fullWidth aria-label={t("game.domain")}>
            <InputGroup variant="secondary">
              <InputGroup.Input
                className="h-12 text-center text-lg font-semibold placeholder:font-normal placeholder:text-[#a4a7ae] dark:placeholder:text-[#61656c]"
                placeholder={t("game.domainPlaceholder")}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                autoFocus={isAdmin}
                readOnly={!isAdmin}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </InputGroup>
          </TextField>
          {!isAdmin && (
            <p className={`text-center text-xs ${MUTED}`}>{t("game.domainUserHint")}</p>
          )}
          <Button
            type="submit"
            className="h-12 w-full rounded-full text-base"
            isPending={state.starting}
            isDisabled={!canStart}
          >
            {t("game.start")}
          </Button>
          {state.error && <p className="text-center text-sm text-danger">{state.error}</p>}
        </form>

        <HowToPlay rules={rules} />
      </div>

      <div className="flex justify-center">
        <Scoreboard board={state.board} />
      </div>
    </div>
  );
}

const RULE_TONE: Record<NonNullable<GameRule["tone"]>, string> = {
  accent: "tile-accent",
  success: "tile-success",
  warning: "tile-warning",
  danger: "tile-danger",
  neutral: "tile-neutral",
};

/** The rules as an icon list, one rule per line. */
function HowToPlay({ rules }: { rules: GameRule[] }) {
  const t = useT();
  return (
    <section className={`${CARD} flex w-full max-w-[420px] flex-col gap-1 p-5`}>
      <h2 className={`mb-2 text-sm font-semibold ${TEXT}`}>{t("game.howToPlay")}</h2>
      <ul className="flex flex-col gap-2.5">
        {rules.map(({ icon: Icon, text, points, tone = "neutral" }) => (
          <li key={text} className="flex items-center gap-3">
            <span
              className={`game-tile ${RULE_TONE[tone]} flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[color:var(--tile)]`}
            >
              <Icon width={16} height={16} />
            </span>
            <span className={`min-w-0 flex-1 text-sm ${TEXT}`}>{text}</span>
            {points && (
              <span
                className={`${RULE_TONE[tone]} shrink-0 text-sm font-bold tabular-nums text-[color:var(--tile)]`}
              >
                {points}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Bottom bar while playing: who is playing and their running score. */
function PlayerBar({ state }: { state: MinigameState }) {
  const t = useT();
  return (
    <div className={`${CARD} flex shrink-0 items-center justify-between gap-3 px-4 py-3`}>
      <span className={`min-w-0 truncate text-base font-semibold ${TEXT}`}>{state.domain}</span>
      <span className="rounded-full bg-[#FEEAE2] px-4 py-1 text-base font-bold tabular-nums text-[#f97316] dark:bg-[#3B1202]">
        {state.summary.score} {t("game.pts")}
      </span>
    </div>
  );
}

/** Game over: confetti, final score, the round's place and the leaderboard. */
function Results({ state, children }: { state: MinigameState; children?: ReactNode }) {
  const t = useT();
  const me = state.board?.me;
  return (
    <div className="grid flex-1 grid-cols-1 items-center gap-6 py-4 lg:grid-cols-2 lg:gap-10">
      {state.summary.score > 0 && <Confetti />}
      <div className="flex justify-center">
        <div className={`${CARD} flex w-full max-w-[560px] flex-col items-center gap-2 p-6 text-center`}>
          <p className={`text-sm font-medium ${MUTED}`}>{t("game.over")}</p>
          <p className={`text-base font-semibold ${TEXT}`}>{state.domain}</p>
          <p className="animate-[game-pop_400ms_ease-out] text-6xl font-bold tabular-nums text-[#f97316]">
            {state.summary.score}
          </p>
          <p className={`text-sm ${MUTED}`}>{t("game.pts")}</p>
          {me && (
            <p className={`text-sm font-semibold ${TEXT}`}>{t("game.yourRank", { rank: me.rank })}</p>
          )}
          {children}
          <div className="mt-3 flex w-full flex-col gap-2 sm:flex-row">
            <Button className="w-full rounded-full" onPress={state.backToLobby}>
              {t("game.playAgain")}
            </Button>
            <Link href="/minigame" className="w-full">
              <Button variant="secondary" className="w-full rounded-full">
                {t("game.back")}
              </Button>
            </Link>
          </div>
        </div>
      </div>
      <div className="flex justify-center">
        <Scoreboard board={state.board} />
      </div>
    </div>
  );
}

const CONFETTI_COLORS = ["#f97316", "#3b82f6", "#facc15", "#22c55e", "#FEEAE2"];

/** One-shot confetti burst over the page — a dependency-free canvas. */
function Confetti() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const dpr = window.devicePixelRatio || 1;
    const resize = () => {
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);
    const w = window.innerWidth;
    // Two cannons from the bottom corners, aimed up and inwards.
    const pieces = Array.from({ length: 180 }, (_, i) => {
      const left = i % 2 === 0;
      const angle = (left ? -60 : -120) * (Math.PI / 180) + (Math.random() - 0.5) * 0.7;
      const speed = 9 + Math.random() * 9;
      return {
        x: left ? 0 : w,
        y: window.innerHeight,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        size: 6 + Math.random() * 6,
        rotation: Math.random() * Math.PI,
        spin: (Math.random() - 0.5) * 0.3,
        color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      };
    });
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const elapsed = now - start;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.globalAlpha = Math.max(0, 1 - Math.max(0, elapsed - 3500) / 1500);
      for (const p of pieces) {
        p.vy += 0.2;
        p.vx *= 0.99;
        p.x += p.vx;
        p.y += p.vy;
        p.rotation += p.spin;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        ctx.restore();
      }
      if (elapsed < 5000) frame = requestAnimationFrame(tick);
      else ctx.clearRect(0, 0, canvas.width, canvas.height);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
    };
  }, []);
  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none fixed inset-0 z-50 h-full w-full"
    />
  );
}

// --------------------------------------------------------------------------- //
// Round pieces
// --------------------------------------------------------------------------- //
/** The big question card at the top of a round. */
export function QuestionBar({ children }: { children: ReactNode }) {
  return (
    <div className={`${CARD} flex min-h-16 shrink-0 items-center justify-center px-4 py-3 text-center`}>
      <div className={`text-xl font-bold sm:text-2xl ${TEXT}`}>{children}</div>
    </div>
  );
}

/** Round timer as a ring that drains, Kahoot-style. */
export function TimerCircle({ state, size = 80 }: { state: MinigameState; size?: number }) {
  const seconds = Math.ceil(state.remainingMs / 1000);
  const fraction = state.remainingMs / (GAME_SECONDS * 1000);
  const r = 15.5;
  const circumference = 2 * Math.PI * r;
  const urgent = seconds <= 10;
  return (
    <div
      className="relative shrink-0 rounded-full bg-white shadow-sm dark:bg-[#0c0e12]"
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 36 36" className="absolute inset-0 -rotate-90">
        <circle cx="18" cy="18" r={r} fill="none" strokeWidth="3" className="stroke-default" />
        <circle
          cx="18"
          cy="18"
          r={r}
          fill="none"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - fraction)}
          className={`transition-[stroke-dashoffset] duration-200 ease-linear ${
            urgent ? "stroke-danger" : "stroke-[#f97316]"
          }`}
        />
      </svg>
      <span
        className={`absolute inset-0 flex items-center justify-center text-xl font-bold tabular-nums ${
          urgent ? "text-danger" : TEXT
        }`}
      >
        {seconds}
      </span>
    </div>
  );
}

/** A big number with a caption — the stage's right-hand counter. */
export function StatBubble({ value, label }: { value: ReactNode; label: string }) {
  return (
    <div className={`${CARD} flex min-w-20 shrink-0 flex-col items-center justify-center px-4 py-3`}>
      <span className={`text-2xl font-bold tabular-nums ${TEXT}`}>{value}</span>
      <span className={`text-xs ${MUTED}`}>{label}</span>
    </div>
  );
}

/**
 * Middle row: timer, the media, and a counter, like Kahoot's question stage.
 * It takes whatever height the question and answers leave over.
 */
export function Stage({
  state,
  side,
  children,
}: {
  state: MinigameState;
  side?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-[140px] flex-1 items-center gap-3">
      <div className="hidden sm:block">
        <TimerCircle state={state} />
      </div>
      <div className="relative h-full min-w-0 flex-1">
        <div className="absolute left-2 top-2 z-10 sm:hidden">
          <TimerCircle state={state} size={52} />
        </div>
        {children}
      </div>
      {side && <div className="hidden sm:block">{side}</div>}
    </div>
  );
}

/** Room photo filling its stage, with a dark bottom fade under `overlay`. */
export function RoomPhoto({
  question,
  overlay,
  showLocation = true,
}: {
  question: MinigameQuestion;
  overlay?: ReactNode;
  showLocation?: boolean;
}) {
  const t = useT();
  const location = [question.office, question.building, question.floor && `F${question.floor}`]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="relative h-full w-full overflow-hidden rounded-2xl bg-default-100">
      {question.image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={question.index}
          src={question.image}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : (
        <div className={`absolute inset-0 flex items-center justify-center text-sm ${MUTED}`}>
          {t("game.noPhoto")}
        </div>
      )}
      <div className="absolute inset-0 bg-gradient-to-b from-transparent from-50% to-black/80" />
      <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-2 p-4">
        {overlay}
        {showLocation && (location || question.capacity) ? (
          <div className="flex flex-wrap items-center justify-center gap-1.5 text-xs font-medium text-white">
            {location && (
              <span className="inline-flex items-center gap-1 rounded-full bg-black/40 px-2.5 py-1 backdrop-blur-sm">
                <MapPin width={12} height={12} />
                {location}
              </span>
            )}
            {question.capacity ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-black/40 px-2.5 py-1 backdrop-blur-sm">
                <Persons width={12} height={12} />
                {question.capacity}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Big text answer box (Kahoot's nickname field): Enter submits and keeps focus. */
export function AnswerInput({
  state,
  placeholder,
  focusKey,
}: {
  state: MinigameState;
  placeholder: string;
  focusKey?: unknown;
}) {
  const t = useT();
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, [focusKey]);
  return (
    <form
      className={`${CARD} flex shrink-0 items-center gap-2 p-2`}
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
            className="h-12 text-lg font-semibold"
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
      <Button type="submit" className="h-12 shrink-0 rounded-full px-6">
        {t("game.submit")}
      </Button>
    </form>
  );
}

// Kahoot's four answer shapes, each tinted with one of the app's status colors.
const TILE_TONES = ["tile-accent", "tile-blue", "tile-warning", "tile-success"] as const;

function TileShape({ index }: { index: number }) {
  const shapes = [
    <polygon key="t" points="12,3 22,21 2,21" />,
    <polygon key="d" points="12,2 22,12 12,22 2,12" />,
    <circle key="c" cx="12" cy="12" r="10" />,
    <rect key="s" x="3" y="3" width="18" height="18" rx="2" />,
  ];
  return (
    <svg viewBox="0 0 24 24" className="game-tile-shape h-6 w-6 shrink-0">
      {shapes[index % shapes.length]}
    </svg>
  );
}

/** The four answer tiles. Long answers wrap instead of overflowing. */
export function AnswerTiles({
  options,
  disabled,
  singleColumn,
  compact,
  onPick,
}: {
  options: string[];
  disabled?: boolean;
  singleColumn?: boolean;
  /** Smaller type for long answers (directions) so the round still fits. */
  compact?: boolean;
  onPick: (index: number) => void;
}) {
  return (
    <div
      // auto-rows-fr: every tile as tall as the tallest, so the grid reads as
      // four even answers however long each one is.
      className={`grid shrink-0 auto-rows-fr gap-2 sm:gap-3 ${singleColumn ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-2"}`}
    >
      {options.map((option, i) => (
        <button
          key={i}
          type="button"
          disabled={disabled}
          onClick={() => onPick(i)}
          className={`game-tile ${TILE_TONES[i % TILE_TONES.length]} flex min-w-0 items-center gap-3 rounded-2xl px-4 text-left font-semibold ${TEXT} transition-[background-color,transform] active:scale-[0.98] disabled:opacity-60 ${
            compact ? "min-h-14 py-2 text-sm" : "min-h-16 py-3 text-base sm:min-h-20 sm:text-lg"
          }`}
        >
          <TileShape index={i} />
          <span className="min-w-0 flex-1 whitespace-pre-line break-words [overflow-wrap:anywhere]">
            {option}
          </span>
        </button>
      ))}
    </div>
  );
}

// --------------------------------------------------------------------------- //
// Leaderboard
// --------------------------------------------------------------------------- //
const PODIUM_ORDER = [1, 0, 2]; // 2nd, 1st, 3rd — winner in the middle
const PODIUM_HEIGHT = ["h-28", "h-20", "h-14"];
const MEDALS = ["🥇", "🥈", "🥉"];

function PodiumColumn({ entry, place }: { entry?: MinigameLeaderboardEntry; place: number }) {
  const t = useT();
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1">
      {entry && (
        <>
          <span className="text-2xl">{MEDALS[place]}</span>
          <span
            className={`max-w-full truncate text-sm font-semibold ${
              entry.isMe ? "text-[#f97316]" : TEXT
            }`}
          >
            {entry.name}
          </span>
          <span className={`text-xs tabular-nums ${MUTED}`}>
            {entry.score} {t("game.pts")}
          </span>
        </>
      )}
      <div
        className={`w-full rounded-t-xl ${PODIUM_HEIGHT[place]} ${
          place === 0 ? "bg-[#f97316]" : "bg-[#FEEAE2] dark:bg-[#3B1202]"
        } flex items-start justify-center pt-2 text-lg font-bold ${
          place === 0 ? "text-white" : "text-[#f97316]"
        }`}
      >
        {place + 1}
      </div>
    </div>
  );
}

/** Hall of fame: podium for the top three, a list for the rest. */
export function Scoreboard({ board }: { board: MinigameLeaderboard | null }) {
  const t = useT();
  const rest = board?.entries.slice(3) ?? [];
  const meOutsideTop = board?.me && !board.entries.some((e) => e.isMe) ? board.me : null;
  return (
    <section className={`${CARD} flex w-full max-w-[560px] flex-col gap-4 p-4 sm:p-5`}>
      <div className="flex items-center gap-2">
        <Cup width={18} height={18} className="text-[#f97316]" />
        <h2 className={`text-base font-semibold ${TEXT}`}>{t("game.leaderboard")}</h2>
      </div>
      {!board ? (
        <div className="h-40 animate-pulse rounded-xl bg-default" />
      ) : board.entries.length === 0 ? (
        <p className={`py-6 text-center text-sm ${MUTED}`}>{t("game.leaderboardEmpty")}</p>
      ) : (
        <>
          <div className="flex items-end gap-2 px-2">
            {PODIUM_ORDER.map((place) => (
              <PodiumColumn key={place} entry={board.entries[place]} place={place} />
            ))}
          </div>
          {rest.length > 0 && (
            <ol className="flex flex-col gap-1">
              {rest.map((e) => (
                <ScoreRow key={e.rank} entry={e} />
              ))}
            </ol>
          )}
        </>
      )}
      {meOutsideTop && (
        <div className="border-t border-[color:var(--separator)] pt-3">
          <ScoreRow entry={meOutsideTop} />
        </div>
      )}
    </section>
  );
}

function ScoreRow({ entry }: { entry: MinigameLeaderboardEntry }) {
  const t = useT();
  return (
    <li
      className={`flex list-none items-center gap-3 rounded-xl px-3 py-2 ${
        entry.isMe ? "bg-[#FEEAE2] dark:bg-[#3B1202]" : "odd:bg-[#fafafa] dark:odd:bg-[#13161b]"
      }`}
    >
      <span className={`w-6 shrink-0 text-center text-sm font-semibold tabular-nums ${MUTED}`}>
        {entry.rank}
      </span>
      <span className={`min-w-0 flex-1 truncate text-sm font-medium ${TEXT}`}>
        {entry.name}
        {entry.isMe && <span className="ml-1.5 text-xs text-[#f97316]">({t("game.thisRound")})</span>}
      </span>
      <span className={`shrink-0 text-sm font-semibold tabular-nums ${TEXT}`}>
        {entry.score} <span className={`text-xs font-normal ${MUTED}`}>{t("game.pts")}</span>
      </span>
    </li>
  );
}
