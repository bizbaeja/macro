import cors from "cors";
import express from "express";
import detectPort from "detect-port";
import { randomUUID } from "node:crypto";
import { pino } from "pino";
import { z } from "zod";
import { runCatchTableAutomation } from "./automation/catchtable-runner.js";

type AutomationStatus = "idle" | "scheduled" | "running" | "completed" | "error";
type WaitingState =
  | "idle"
  | "scheduled"
  | "searching"
  | "button-missing"
  | "button-disabled"
  | "button-ready"
  | "button-clicked"
  | "timeout"
  | "completed"
  | "cancelled";
type WaitingType = "eat-in" | "takeout";

interface ReservationSettings {
  startDate: string;
  startTime: string;
  captureCancellation: boolean;
  retryAfterFailure: boolean;
  targetUrl?: string;
  waitingType?: WaitingType;
  partySize?: number;
  autoConfirmDeposit?: boolean;
}

interface AutomationSnapshot {
  status: AutomationStatus;
  scheduledAt?: string;
  lastRunAt?: string;
  message?: string;
  logs?: string[];
  targetUrl?: string;
  waitingType?: WaitingType;
  partySize?: number;
  autoConfirmDeposit?: boolean;
  waitingState?: WaitingState;
  waitingMessage?: string;
}

const settingsSchema = z.object({
  startDate: z
    .string()
    .refine((value) => !Number.isNaN(Date.parse(value)), "올바른 날짜 형식이 아닙니다."),
  startTime: z
    .string()
    .regex(/^\d{2}:\d{2}$/u, "시간 형식은 HH:MM 이어야 합니다."),
  captureCancellation: z.boolean(),
  retryAfterFailure: z.boolean(),
  targetUrl: z
    .string()
    .url("올바른 CatchTable URL을 입력하세요.")
    .optional()
    .or(z.literal("")),
  waitingType: z.enum(["eat-in", "takeout"]).optional(),
  partySize: z
    .number({ invalid_type_error: "인원 수는 숫자여야 합니다." })
    .int("인원 수는 정수여야 합니다.")
    .positive("인원 수는 1 이상이어야 합니다.")
    .optional(),
  autoConfirmDeposit: z.boolean().optional(),
});

const DEFAULT_PORT = Number(process.env.PORT ?? 4310);
const DEFAULT_TARGET_URL =
  process.env.CATCHTABLE_URL ??
  "https://app.catchtable.co.kr/ct/shop/101do_?type=WAITING&currentSuggestionType=SHOP_NAME";

const logger = pino({
  transport: {
    target: "pino-pretty",
    options: { colorize: true },
  },
});

type NormalizedSettings = ReservationSettings & { targetUrl: string };

class AutomationManager {
  private status: AutomationStatus = "idle";
  private scheduledAt: Date | undefined;
  private lastRunAt: Date | undefined;
  private timer: NodeJS.Timeout | undefined;
  private controller: AbortController | undefined;
  private currentSettings: NormalizedSettings | undefined;
  private logs: string[] = [];
  private waitingState: WaitingState = "idle";
  private waitingMessage: string | undefined;

  schedule(settings: ReservationSettings) {
    this.clearSchedule();

    const scheduledDate = buildTimestamp(settings.startDate, settings.startTime);
    this.scheduledAt = scheduledDate;
    const targetUrl = normalizeTargetUrl(settings.targetUrl);
    const normalizedSettings: NormalizedSettings = {
      ...settings,
      targetUrl,
    };
    this.currentSettings = normalizedSettings;
    const delayMs = Math.max(0, scheduledDate.getTime() - Date.now());
    this.status = delayMs > 0 ? "scheduled" : "running";
    this.updateWaitingState("scheduled", "예약 시각을 기다리는 중입니다.");

    this.pushLog(
      `자동화를 ${scheduledDate.toLocaleString("ko-KR")}에 실행하도록 예약했습니다. (대기 ${Math.round(
        delayMs / 1000
      )}초)`
    );
    this.pushLog(`대상 URL: ${targetUrl}`);

    if (delayMs === 0) {
      void this.execute(normalizedSettings);
    } else {
      this.timer = setTimeout(() => void this.execute(normalizedSettings), delayMs);
    }

    return this.snapshot();
  }

  stop(reason = "사용자 요청") {
    this.clearSchedule();
    if (this.controller) {
      this.controller.abort(new Error(reason));
    }
    this.status = "idle";
    this.pushLog(`자동화를 중지했습니다. (${reason})`);
    this.updateWaitingState("cancelled", "감시가 중단되었습니다.");
    return this.snapshot();
  }

  snapshot(): AutomationSnapshot {
    return {
      status: this.status,
      scheduledAt: this.scheduledAt?.toISOString(),
      lastRunAt: this.lastRunAt?.toISOString(),
      message: this.logs.at(-1),
      logs: this.logs.slice(-200),
      targetUrl: this.currentSettings?.targetUrl ?? DEFAULT_TARGET_URL,
      waitingType: this.currentSettings?.waitingType,
      partySize: this.currentSettings?.partySize,
      autoConfirmDeposit: this.currentSettings?.autoConfirmDeposit,
      waitingState: this.waitingState,
      waitingMessage: this.waitingMessage,
    };
  }

  getCurrentSettings() {
    return this.currentSettings;
  }

  private async execute(settings: NormalizedSettings) {
    this.status = "running";
    this.lastRunAt = new Date();
    this.controller = new AbortController();
    const runId = randomUUID();
    this.pushLog(`자동화 실행을 시작합니다. (runId: ${runId})`);
    logger.info({ runId }, "CatchTable automation started");
    this.updateWaitingState("searching", "웨이팅 버튼 감시를 시작합니다.");

    try {
      const result = await runCatchTableAutomation({
        ...settings,
        onLog: (line: string) => this.pushLog(line),
        signal: this.controller?.signal,
      });

      switch (result.status) {
        case "success":
          this.pushLog("자동화가 성공적으로 완료되었습니다.");
          this.status = "completed";
          this.updateWaitingState("completed", "자동화가 정상적으로 완료되었습니다.");
          break;
        case "cancelled":
          this.pushLog(`자동화가 중단되었습니다: ${result.details ?? "취소"}`);
          this.status = "idle";
          this.updateWaitingState("cancelled", result.details ?? "감시가 중단되었습니다.");
          break;
        case "failure":
        default:
          this.pushLog(`자동화가 실패했습니다: ${result.details ?? "알 수 없는 오류"}`);
          this.status = "error";
          this.updateWaitingState("timeout", result.details ?? "자동화 실패");
          break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.pushLog(`자동화 실행 중 예외가 발생했습니다: ${message}`);
      this.status = "error";
      this.updateWaitingState("timeout", message);
    } finally {
      logger.info({ runId, status: this.status }, "CatchTable automation completed");
      this.controller = undefined;
      this.clearSchedule();
      if (this.status === "idle") {
        this.updateWaitingState("idle");
      }
    }
  }

  private clearSchedule() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.scheduledAt = undefined;
  }

  private pushLog(message: string) {
    const line = message.trim();
    this.logs.push(line);
    if (this.logs.length > 500) {
      this.logs = this.logs.slice(-400);
    }
    logger.info(line);
  }

  private updateWaitingState(state: WaitingState, message?: string) {
    if (this.waitingState === state && this.waitingMessage === message) {
      return;
    }
    this.waitingState = state;
    this.waitingMessage = message;
    if (message) {
      this.pushLog(`[웨이팅 감시] ${message}`);
    }
  }
}

function buildTimestamp(date: string, time: string) {
  return new Date(`${date}T${time}:00`);
}

function normalizeTargetUrl(candidate: string | undefined) {
  if (!candidate) return DEFAULT_TARGET_URL;
  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_TARGET_URL;
}

const manager = new AutomationManager();

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/automation/status", (_req, res) => {
  res.json(manager.snapshot());
});

app.post("/automation/start", async (req, res) => {
  try {
    const parsed: ReservationSettings = settingsSchema.parse(req.body);
    const snapshot = manager.schedule(parsed);
    res.json(snapshot);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ message: error.issues.at(0)?.message ?? "유효하지 않은 입력" });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ message });
  }
});

app.post("/automation/stop", (_req, res) => {
  const snapshot = manager.stop();
  res.json(snapshot);
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : String(error);
  logger.error(message);
  res.status(500).json({ message: "서버 내부 오류" });
});

async function startServer() {
  const port = await detectPort(DEFAULT_PORT);
  if (port !== DEFAULT_PORT) {
    logger.warn(
      `포트 ${DEFAULT_PORT}이(가) 사용 중입니다. 사용 가능한 포트 ${port}로 서버를 시작합니다.`
    );
  }

  app.listen(port, () => {
    logger.info(`CatchTable automation 서버가 포트 ${port}에서 실행 중입니다.`);
    logger.info(`기본 대상 URL: ${DEFAULT_TARGET_URL}`);
  });
}

void startServer();

