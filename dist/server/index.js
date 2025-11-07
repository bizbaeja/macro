import cors from "cors";
import express from "express";
import detectPort from "detect-port";
import { randomUUID } from "node:crypto";
import { pino } from "pino";
import { z } from "zod";
import { runCatchTableAutomation } from "./automation/catchtable-runner.js";
const settingsSchema = z.object({
    startDate: z
        .string()
        .refine((value) => !Number.isNaN(Date.parse(value)), "올바른 날짜 형식이 아닙니다."),
    startTime: z
        .string()
        .regex(/^\d{2}:\d{2}$/u, "시간 형식은 HH:MM 이어야 합니다."),
    captureCancellation: z.boolean(),
    retryAfterFailure: z.boolean(),
});
const DEFAULT_PORT = Number(process.env.PORT ?? 4310);
const TARGET_URL = process.env.CATCHTABLE_URL ??
    "https://app.catchtable.co.kr/ct/shop/101do_?type=WAITING&currentSuggestionType=SHOP_NAME";
const logger = pino({
    transport: {
        target: "pino-pretty",
        options: { colorize: true },
    },
});
class AutomationManager {
    status = "idle";
    scheduledAt;
    lastRunAt;
    timer;
    controller;
    currentSettings;
    logs = [];
    schedule(settings) {
        this.clearSchedule();
        const scheduledDate = buildTimestamp(settings.startDate, settings.startTime);
        this.scheduledAt = scheduledDate;
        this.currentSettings = settings;
        const delayMs = Math.max(0, scheduledDate.getTime() - Date.now());
        this.status = delayMs > 0 ? "scheduled" : "running";
        this.pushLog(`자동화를 ${scheduledDate.toLocaleString("ko-KR")}에 실행하도록 예약했습니다. (대기 ${Math.round(delayMs / 1000)}초)`);
        if (delayMs === 0) {
            void this.execute(settings);
        }
        else {
            this.timer = setTimeout(() => void this.execute(settings), delayMs);
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
        return this.snapshot();
    }
    snapshot() {
        return {
            status: this.status,
            scheduledAt: this.scheduledAt?.toISOString(),
            lastRunAt: this.lastRunAt?.toISOString(),
            message: this.logs.at(-1),
            logs: this.logs.slice(-200),
        };
    }
    getCurrentSettings() {
        return this.currentSettings;
    }
    async execute(settings) {
        this.status = "running";
        this.lastRunAt = new Date();
        this.controller = new AbortController();
        const runId = randomUUID();
        this.pushLog(`자동화 실행을 시작합니다. (runId: ${runId})`);
        logger.info({ runId }, "CatchTable automation started");
        try {
            const result = await runCatchTableAutomation({
                ...settings,
                targetUrl: TARGET_URL,
                onLog: (line) => this.pushLog(line),
                signal: this.controller?.signal,
            });
            switch (result.status) {
                case "success":
                    this.pushLog("자동화가 성공적으로 완료되었습니다.");
                    this.status = "completed";
                    break;
                case "cancelled":
                    this.pushLog(`자동화가 중단되었습니다: ${result.details ?? "취소"}`);
                    this.status = "idle";
                    break;
                case "failure":
                default:
                    this.pushLog(`자동화가 실패했습니다: ${result.details ?? "알 수 없는 오류"}`);
                    this.status = "error";
                    break;
            }
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.pushLog(`자동화 실행 중 예외가 발생했습니다: ${message}`);
            this.status = "error";
        }
        finally {
            logger.info({ runId, status: this.status }, "CatchTable automation completed");
            this.controller = undefined;
            this.clearSchedule();
        }
    }
    clearSchedule() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        this.scheduledAt = undefined;
    }
    pushLog(message) {
        const line = message.trim();
        this.logs.push(line);
        if (this.logs.length > 500) {
            this.logs = this.logs.slice(-400);
        }
        logger.info(line);
    }
}
function buildTimestamp(date, time) {
    return new Date(`${date}T${time}:00`);
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
        const parsed = settingsSchema.parse(req.body);
        const snapshot = manager.schedule(parsed);
        res.json(snapshot);
    }
    catch (error) {
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
app.use((error, _req, res, _next) => {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(message);
    res.status(500).json({ message: "서버 내부 오류" });
});
async function startServer() {
    const port = await detectPort(DEFAULT_PORT);
    if (port !== DEFAULT_PORT) {
        logger.warn(`포트 ${DEFAULT_PORT}이(가) 사용 중입니다. 사용 가능한 포트 ${port}로 서버를 시작합니다.`);
    }
    app.listen(port, () => {
        logger.info(`CatchTable automation 서버가 포트 ${port}에서 실행 중입니다.`);
        logger.info(`대상 URL: ${TARGET_URL}`);
    });
}
void startServer();
