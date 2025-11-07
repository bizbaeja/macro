import puppeteer from "puppeteer";
const WAIT_BUTTON_TEXTS = ["웨이팅 등록하기", "웨이팅이 어려워요", "웨이팅하기", "웨이팅"];
const FAILURE_KEYWORDS = ["실패", "다시 시도", "마감", "불가"];
const CANCELLATION_KEYWORDS = ["취소", "웨이팅", "티업"];
const DEFAULT_URL = "https://app.catchtable.co.kr/";
const WAIT_UNTIL_OPTIONS = "networkidle2";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function runCatchTableAutomation(settings) {
    const { onLog = () => undefined, signal } = settings;
    let browser;
    const log = (message) => {
        const timestamp = new Date().toISOString();
        onLog(`[${timestamp}] ${message}`);
    };
    const checkAbort = () => {
        if (signal?.aborted) {
            throw new AbortError(signal.reason instanceof Error ? signal.reason.message : undefined);
        }
    };
    try {
        checkAbort();
        log("Puppeteer 브라우저를 준비합니다.");
        browser = await puppeteer.launch({
            headless: true,
            defaultViewport: {
                width: 1280,
                height: 720,
            },
        });
        const page = await browser.newPage();
        const target = settings.targetUrl ?? DEFAULT_URL;
        log(`캐치테이블 페이지 접속: ${target}`);
        await page.goto(target, { waitUntil: WAIT_UNTIL_OPTIONS, timeout: 45_000 });
        checkAbort();
        const reservedDirectly = await attemptDirectReservation(page, { log, signal });
        if (reservedDirectly) {
            log("직접 예약 플로우를 통해 '예약하기' 버튼을 눌렀습니다.");
            return { status: "success" };
        }
        const waitButtonClicked = await clickFirstMatchingButton(page, WAIT_BUTTON_TEXTS);
        if (!waitButtonClicked) {
            log("'웨이팅' 버튼을 찾지 못했습니다.");
            return { status: "failure", details: "웨이팅 버튼을 찾지 못했습니다." };
        }
        log("웨이팅 버튼을 클릭했습니다. 응답을 대기합니다.");
        await delay(2000);
        checkAbort();
        // 웨이팅 유형 선택 (먹고 갈게요 / 포장 갈게요)
        const waitingType = settings.waitingType || "eat-in";
        const waitingTypeText = waitingType === "eat-in" ? "먹고 갈게요" : "포장 갈게요";
        const typeSelected = await clickButtonByText(page, waitingTypeText);
        if (typeSelected) {
            log(`웨이팅 유형 '${waitingTypeText}'를 선택했습니다.`);
            await delay(1000);
        }
        else {
            log(`웨이팅 유형 선택 화면이 나타나지 않거나 버튼을 찾지 못했습니다.`);
        }
        // 인원수 설정
        const partySize = settings.partySize || 2;
        if (partySize > 2) {
            log(`인원수를 ${partySize}명으로 설정합니다.`);
            for (let i = 2; i < partySize; i++) {
                const plusClicked = await page.evaluate(() => {
                    const buttons = Array.from(document.querySelectorAll("button"));
                    const plusButton = buttons.find((btn) => {
                        const text = btn.innerText?.trim();
                        return text === "+" || text === "＋";
                    });
                    if (plusButton) {
                        plusButton.click();
                        return true;
                    }
                    return false;
                });
                if (plusClicked) {
                    await delay(200);
                }
                else {
                    log(`+ 버튼을 찾지 못했습니다.`);
                    break;
                }
            }
        }
        else if (partySize < 2) {
            const minusClicked = await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll("button"));
                const minusButton = buttons.find((btn) => {
                    const text = btn.innerText?.trim();
                    return text === "-" || text === "－";
                });
                if (minusButton) {
                    minusButton.click();
                    return true;
                }
                return false;
            });
            if (minusClicked) {
                log(`인원수를 ${partySize}명으로 설정했습니다.`);
                await delay(200);
            }
        }
        // 다음 버튼 클릭
        const nextButtonClicked = await clickButtonByText(page, "다음");
        if (nextButtonClicked) {
            log("다음 버튼을 클릭했습니다.");
            await delay(1500);
        }
        else {
            log("다음 버튼을 찾지 못했습니다.");
        }
        checkAbort();
        const failed = await detectKeywordInPage(page, FAILURE_KEYWORDS);
        if (failed) {
            log("예약 실패 문구를 감지했습니다.");
            if (settings.retryAfterFailure) {
                log("예약 실패 감지 → 취소 티업 모드 실행");
                await attemptCancellationFlow(page, { log, signal });
            }
        }
        else {
            log("예약 실패 문구가 감지되지 않았습니다. 성공 또는 추가 조치를 확인하세요.");
        }
        if (settings.captureCancellation) {
            await monitorCancellationSlots(page, { log, signal });
        }
        log("자동화 시나리오를 완료했습니다.");
        return { status: "success" };
    }
    catch (error) {
        if (error instanceof AbortError) {
            log(`사용자 중지: ${error.message ?? "취소"}`);
            return { status: "cancelled", details: error.message };
        }
        const message = error instanceof Error ? error.message : String(error);
        log(`자동화 오류: ${message}`);
        return { status: "failure", details: message };
    }
    finally {
        if (browser) {
            await browser.close();
            log("브라우저 세션을 종료했습니다.");
        }
    }
}
async function clickFirstMatchingButton(page, keywords) {
    for (const keyword of keywords) {
        const clicked = await clickButtonByText(page, keyword);
        if (clicked) {
            return true;
        }
    }
    return false;
}
async function clickButtonByText(page, keyword) {
    return page.evaluate((text) => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
            acceptNode(node) {
                if (node.nodeType !== Node.ELEMENT_NODE)
                    return NodeFilter.FILTER_SKIP;
                const element = node;
                const label = element.innerText?.trim();
                if (!label)
                    return NodeFilter.FILTER_SKIP;
                const isButton = element.tagName === "BUTTON" ||
                    element.getAttribute("role") === "button" ||
                    element.tabIndex >= 0;
                if (!isButton)
                    return NodeFilter.FILTER_SKIP;
                if (label.includes(text)) {
                    element.click();
                    return NodeFilter.FILTER_ACCEPT;
                }
                return NodeFilter.FILTER_SKIP;
            },
        });
        while (walker.nextNode()) {
            return true;
        }
        return false;
    }, keyword);
}
async function detectKeywordInPage(page, keywords) {
    const content = await page.content();
    return keywords.some((keyword) => content.includes(keyword));
}
async function attemptDirectReservation(page, { log, signal, }) {
    log("직접 예약 가능 여부를 점검합니다.");
    const slotSelected = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll("button"));
        const slot = buttons.find((button) => {
            const label = button.innerText?.trim();
            if (!label)
                return false;
            const isTimeButton = /오전|오후/.test(label) && /\d{1,2}:\d{2}/.test(label);
            const htmlButton = button;
            const isEnabled = !htmlButton.disabled && button.getAttribute("aria-disabled") !== "true";
            const isVisible = !!button.offsetParent;
            return isTimeButton && isEnabled && isVisible;
        });
        if (!slot)
            return false;
        slot.click();
        return true;
    });
    if (!slotSelected) {
        log("선택 가능한 예약 시간 버튼이 없어 직접 예약을 진행하지 않습니다.");
        return false;
    }
    log("예약 시간 버튼을 선택했습니다.");
    await delay(600);
    if (signal?.aborted) {
        throw new AbortError(signal.reason instanceof Error ? signal.reason.message : undefined);
    }
    const reservationClicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll("button"));
        const reserveButton = buttons.find((button) => {
            const label = button.innerText?.trim();
            if (!label)
                return false;
            const matches = label.includes("예약하기");
            const htmlButton = button;
            const disabled = htmlButton.disabled || button.getAttribute("aria-disabled") === "true";
            return matches && !disabled;
        });
        if (!reserveButton)
            return false;
        reserveButton.click();
        return true;
    });
    if (!reservationClicked) {
        log("활성화된 '예약하기' 버튼을 찾지 못했습니다.");
        return false;
    }
    log("'예약하기' 버튼을 클릭했습니다. 서버 응답을 기다립니다.");
    await delay(1500);
    return true;
}
async function monitorCancellationSlots(page, { log, signal, pollInterval = 4000, maxCycles = 45, }) {
    log("취소 슬롯 모니터링을 시작합니다.");
    for (let attempt = 1; attempt <= maxCycles; attempt += 1) {
        if (signal?.aborted) {
            throw new AbortError(signal.reason instanceof Error ? signal.reason.message : undefined);
        }
        const clicked = await clickButtonByText(page, "취소");
        if (clicked) {
            log("취소 슬롯을 발견해 클릭했습니다. 결과를 확인하세요.");
            await delay(2000);
            if (!(await detectKeywordInPage(page, FAILURE_KEYWORDS))) {
                log("취소 슬롯 확보에 성공한 것으로 보입니다.");
                return;
            }
            log("취소 슬롯 클릭 후 실패 문구가 계속됩니다. 계속 모니터링합니다.");
        }
        else {
            log(`취소 슬롯 없음 (시도 ${attempt}/${maxCycles})`);
        }
        await delay(pollInterval);
    }
    log("취소 슬롯 모니터링이 종료되었습니다 (최대 반복 도달).");
}
async function attemptCancellationFlow(page, { log, signal, }) {
    log("취소 티업 버튼을 탐색합니다.");
    const clicked = await clickFirstMatchingButton(page, CANCELLATION_KEYWORDS);
    if (!clicked) {
        log("취소 티업 관련 버튼을 찾지 못했습니다.");
        return;
    }
    log("취소 티업 버튼을 클릭했습니다. 결과를 확인합니다.");
    await delay(2000);
    if (signal?.aborted) {
        throw new AbortError(signal.reason instanceof Error ? signal.reason.message : undefined);
    }
    const failure = await detectKeywordInPage(page, FAILURE_KEYWORDS);
    if (failure) {
        log("취소 티업에서도 실패 문구가 나타났습니다. 계속 감시합니다.");
    }
    else {
        log("취소 티업이 성공한 것으로 보입니다.");
    }
}
class AbortError extends Error {
    constructor(message) {
        super(message ?? "사용자에 의해 중단되었습니다.");
        this.name = "AbortError";
    }
}
