
import { Logger } from '@nestjs/common';
import * as Helpers from '../auto_trade/auto_trade.helpers';
import { ITradingServices } from '../auto_trade/auto_trade.helpers';
import { ExchangeName } from '../auto_trade/auto_trade.types';
import { IDetailedPosition } from '../../common/interfaces';

// --- КОНФИГУРАЦИЯ РИСКОВ ---
const TARGET_LEVERAGE = 5;        // Цель (куда возвращаемся)
const WARN_LEVERAGE = 5.3;          // Желтая зона (только уведомление)
const TRIGGER_LEVERAGE = 5.4;       // Красная зона (автоматическая резка)
const ALLOW_UNHEDGED_CLOSE = true;

// --- КОНФИГУРАЦИЯ ADL (Hyperliquid) ---
const ADL_TARGET_PNL_RATIO = 0.5;   // Цель (куда возвращаем PnL)
const ADL_WARN_PNL_RATIO = 0.6;     // Желтая зона ADL (уведомление)
const ADL_TRIGGER_PNL_RATIO = 0.7;  // Красная зона ADL (резка)

// --- ТАЙМЕРЫ ---
const NORMAL_INTERVAL_MS = 30 * 1000;
const EMERGENCY_INTERVAL_MS = 20 * 1000;
const EMERGENCY_COOLDOWN_MS = 5 * 60 * 1000;
const NOTIFICATION_COOLDOWN_MS = 5 * 60 * 1000; // Спамить не чаще раза в 5 мин

export class AutoCloseSession {
    private readonly logger = new Logger(AutoCloseSession.name);

    private isMonitoring = false;
    private isEmergencyMode = false;
    private lastActionTimestamp = 0;
    private monitoringTimeout: NodeJS.Timeout | null = null;
    private notifyCallback: ((msg: string) => Promise<void>) | null = null;

    // Хранилище времени последнего уведомления (Key -> Timestamp)
    private lastNotificationTime = new Map<string, number>();

    constructor(
        public readonly userId: number,
        private readonly services: ITradingServices
    ) { }

    // =========================================================================
    // --- УПРАВЛЕНИЕ МОНИТОРИНГОМ ---
    // =========================================================================

    public start(callback: (msg: string) => Promise<void>) {
        if (this.isMonitoring) {
            callback('⚠️ Мониторинг уже запущен.');
            return;
        }

        this.notifyCallback = callback;
        this.isMonitoring = true;
        this.isEmergencyMode = false;
        this.lastActionTimestamp = 0;
        this.lastNotificationTime.clear();

        this.safeNotify('🛡 <b>Auto-Close + ADL Protection запущен.</b>\nИнтервал проверки: 1 минута.');
        this.logger.log(`[User ${this.userId}] Started Auto-Close monitoring.`);

        this.runMonitoringLoop();
    }

    public stop() {
        this.isMonitoring = false;
        if (this.monitoringTimeout) {
            clearTimeout(this.monitoringTimeout);
            this.monitoringTimeout = null;
        }
        this.logger.log(`[User ${this.userId}] Stopped Auto-Close monitoring.`);
    }

    private safeNotify(msg: string) {
        if (this.notifyCallback) {
            // FIRE-AND-FORGET: Не ждем ответа, чтобы не блокировать цикл мониторинга
            this.notifyCallback(msg).catch(e => {
                this.logger.error(`[User ${this.userId}] Notify failed (bg): ${e}`);
            });
        }
    }

    private async runMonitoringLoop() {
        if (!this.isMonitoring) return;

        try {
            // 1. ПРОВЕРКА РИСКОВ (ЛЕВЕРЕДЖ)
            const { logs: riskLogs, actionTaken: riskAction } = await this.checkAndReduceRisk();

            // 2. ПРОВЕРКА ADL (HYPERLIQUID PNL)
            const { logs: adlLogs, actionTaken: adlAction } = await this.checkAndFixHyperliquidADL();

            // Действие было, если мы что-то реально РЕЗАЛИ (actionTaken = true возвращается только при TRIGGER)
            const actionTaken = riskAction || adlAction;
            const now = Date.now();

            // 3. ЛОГИКА ПЕРЕКЛЮЧЕНИЯ РЕЖИМОВ
            if (actionTaken) {
                this.lastActionTimestamp = now;
                if (!this.isEmergencyMode) {
                    this.isEmergencyMode = true;
                    await this.safeNotify('🚨 <b>ЭКСТРЕННЫЙ РЕЖИМ ВКЛЮЧЕН</b>\nСработал триггер резки. Интервал: <b>20 сек</b>.');
                }
            } else {
                if (this.isEmergencyMode) {
                    if (now - this.lastActionTimestamp > EMERGENCY_COOLDOWN_MS) {
                        this.isEmergencyMode = false;
                        await this.safeNotify('✅ <b>Ситуация стабилизировалась.</b>\nВозврат к интервалу: <b>1 минута</b>.');
                    }
                }
            }

            // 4. ОТПРАВКА ЛОГОВ
            // Объединяем логи (там могут быть и уведомления о WARN, и отчеты о CUT)
            const allLogs = [...riskLogs, ...adlLogs].filter(l => !l.includes('✅ Все биржи в безопасности'));

            if (allLogs.length > 0) {
                await this.safeNotify(allLogs.join('\n'));
            } else if (actionTaken && (riskLogs.length > 0 || adlLogs.length > 0)) {
                await this.safeNotify([...riskLogs, ...adlLogs].join('\n'));
            }

        } catch (e: any) {
            this.logger.error(`[User ${this.userId}] Monitoring Loop Error: ${e.message}`);
            await this.safeNotify(`❌ Ошибка цикла мониторинга: ${e.message}`);
        } finally {
            if (this.isMonitoring) {
                const delay = this.isEmergencyMode ? EMERGENCY_INTERVAL_MS : NORMAL_INTERVAL_MS;
                this.monitoringTimeout = setTimeout(() => this.runMonitoringLoop(), delay);
            }
        }
    }

    // =========================================================================
    // --- ЛОГИКА CHECK & REDUCE (LEVERAGE) ---
    // =========================================================================

    public async checkAndReduceRisk(): Promise<{ logs: string[], actionTaken: boolean }> {
        const logs: string[] = [];
        let actionTaken = false;

        const exchangeServices: Record<ExchangeName, any> = {
            'Binance': this.services.binance,
            'Hyperliquid': this.services.hl,
            'Paradex': this.services.paradex,
            'Lighter': this.services.lighter,
            'Extended': this.services.extended
        };

        const getLeverageData = async (name: ExchangeName) => {
            try {
                const data = await exchangeServices[name].calculateLeverage(this.userId);
                return { name, ...data };
            } catch (e) {
                return { name, leverage: 0, accountEquity: 0, P_MM_keff: 0 };
            }
        };

        const allData = await Promise.all(Object.keys(exchangeServices).map(name => getLeverageData(name as ExchangeName)));

        // Сортируем биржи по убыванию плеча
        const exchanges = allData.sort((a, b) => b.leverage - a.leverage);

        if (exchanges.length === 0) {
            return { logs: [], actionTaken: false };
        }

        const maxLeverage = exchanges[0].leverage;
        if (maxLeverage < WARN_LEVERAGE) {
            // Все спокойно
            return { logs: [], actionTaken: false };
        }

        for (const ex of exchanges) {
            const currentLev = ex.leverage;
            const notifKey = `LEV_${ex.name}`;
            const now = Date.now();

            // --- 1. КРАСНАЯ ЗОНА (РЕЗКА) ---
            if (currentLev >= TRIGGER_LEVERAGE) {
                logs.push(`🚨 <b>TRIGGER: ${ex.name} Leverage: ${currentLev.toFixed(2)}</b> (Limit: ${TRIGGER_LEVERAGE})`);

                // Re-Check перед действием
                const freshData = await getLeverageData(ex.name);
                if (freshData.leverage < TRIGGER_LEVERAGE) {
                    logs.push(`ℹ️ Skipped ${ex.name}: Dropped to ${freshData.leverage.toFixed(2)}.`);
                    continue;
                }

                const L1 = freshData.leverage;
                const L2 = TARGET_LEVERAGE;
                const K = freshData.P_MM_keff || 0;

                let alpha = 0;
                const denominator = L1 * (1 + L2 * K);

                if (denominator !== 0) alpha = (L1 - L2) / denominator;
                else alpha = (L1 - L2) / L1;
                if (alpha > 0.001) {
                    logs.push(`🧮 Reducing by <b>${(alpha * 100).toFixed(2)}%</b> to target ${TARGET_LEVERAGE}`);
                    const report = await this.reducePositionsOnExchange(ex.name, alpha, exchangeServices, allData);
                    logs.push(...report);
                    actionTaken = true; // Триггерим экстренный режим
                }
            }
            // --- 2. ЖЕЛТАЯ ЗОНА (УВЕДОМЛЕНИЕ) ---
            else if (currentLev >= WARN_LEVERAGE) {
                const lastNotif = this.lastNotificationTime.get(notifKey) || 0;

                if (now - lastNotif > NOTIFICATION_COOLDOWN_MS) {
                    logs.push(`⚠️ <b>WARNING: ${ex.name} Leverage: ${currentLev.toFixed(2)}</b>`);
                    logs.push(`(Yellow Zone: ${WARN_LEVERAGE} - ${TRIGGER_LEVERAGE}). Please fix manually.`);
                    this.lastNotificationTime.set(notifKey, now);
                }
            }
        }

        return { logs, actionTaken };
    }

    private async reducePositionsOnExchange(
        exchangeName: ExchangeName,
        alpha: number,
        allServices: Record<ExchangeName, any>,
        allLeverageData: { name: ExchangeName, leverage: number }[]
    ): Promise<string[]> {

        const service = allServices[exchangeName];

        try {
            const positions: IDetailedPosition[] = await service.getSimplePositions(this.userId);

            const otherExchanges = Object.keys(allServices).filter(k => k !== exchangeName) as ExchangeName[];
            const allHedgePositions: Record<string, IDetailedPosition[]> = {};

            await Promise.all(otherExchanges.map(async (exName) => {
                try {
                    allHedgePositions[exName] = await allServices[exName].getSimplePositions(this.userId);
                } catch (e) { allHedgePositions[exName] = []; }
            }));

            const sortedHedgeExchanges = Object.keys(allHedgePositions).sort((exA, exB) => {
                const levA = allLeverageData.find(d => d.name === exA)?.leverage || 0;
                const levB = allLeverageData.find(d => d.name === exB)?.leverage || 0;
                return levB - levA;
            });

            const tasks = positions.map(pos => async () => {
                const localLogs: string[] = [];
                const targetAsset = Helpers.getAssetName(pos.coin);
                const rawTargetQty = pos.size * alpha;
                let remainingQtyToClose = this.calculateSafeQuantity(rawTargetQty);
                if (remainingQtyToClose <= 0) return [];

                const closeSide = pos.side === 'L' ? 'SELL' : 'BUY';

                for (const hedgeExName of sortedHedgeExchanges) {
                    if (remainingQtyToClose <= 0) break;
                    const hedgePosList = allHedgePositions[hedgeExName];
                    const hedgePos = hedgePosList.find(p => Helpers.getAssetName(p.coin) === targetAsset);

                    if (hedgePos && hedgePos.side !== pos.side) {
                        let qtyForThisHedge = Math.min(remainingQtyToClose, hedgePos.size);
                        qtyForThisHedge = this.calculateSafeQuantity(qtyForThisHedge);
                        if (qtyForThisHedge <= 0) continue;

                        hedgePos.size -= qtyForThisHedge;
                        if (hedgePos.size < 0) hedgePos.size = 0;

                        const hedgeCloseSide = hedgePos.side === 'L' ? 'SELL' : 'BUY';
                        let currentHedgeExecuted = false;
                        let pendingHedgeLog: string | null = null;
                        let pendingHedgeError: string | null = null;

                        try {
                            const res = await Helpers.executeTrade(hedgeExName as ExchangeName, hedgePos.coin, hedgeCloseSide, qtyForThisHedge, this.services, this.userId);
                            if (res.success) {
                                currentHedgeExecuted = true;
                                pendingHedgeLog = `✅ Hedge closed on ${hedgeExName}: ${qtyForThisHedge}`;
                            } else {
                                pendingHedgeError = `⚠️ Hedge fail on ${hedgeExName}: ${res.error}`;
                                hedgePos.size += qtyForThisHedge;
                            }
                        } catch (e: any) {
                            pendingHedgeError = `⚠️ Hedge exc error on ${hedgeExName}: ${e.message}`;
                            hedgePos.size += qtyForThisHedge;
                        }

                        if (currentHedgeExecuted || ALLOW_UNHEDGED_CLOSE) {
                            try {
                                const mainRes = await Helpers.executeTrade(exchangeName, pos.coin, closeSide, qtyForThisHedge, this.services, this.userId);
                                if (mainRes.success) {
                                    const exCodeMain = exchangeName.charAt(0);
                                    const hedgeSymbol = currentHedgeExecuted ? hedgeExName.charAt(0) : 'NO_HEDGE';
                                    localLogs.push(`✂️ <b>${pos.coin} ${exCodeMain}-${hedgeSymbol}</b>: ${qtyForThisHedge}`);
                                    if (pendingHedgeLog) localLogs.push(pendingHedgeLog);
                                    if (pendingHedgeError) localLogs.push(pendingHedgeError);
                                    remainingQtyToClose -= qtyForThisHedge;
                                    remainingQtyToClose = this.calculateSafeQuantity(remainingQtyToClose);
                                } else {
                                    if (pendingHedgeLog) localLogs.push(pendingHedgeLog);
                                    if (pendingHedgeError) localLogs.push(pendingHedgeError);
                                    localLogs.push(`❌ Main Close Fail ${exchangeName} ${pos.coin}: ${mainRes.error}`);
                                }
                            } catch (e: any) {
                                if (pendingHedgeLog) localLogs.push(pendingHedgeLog);
                                if (pendingHedgeError) localLogs.push(pendingHedgeError);
                                localLogs.push(`❌ Main Exc Error: ${e.message}`);
                            }
                        }
                    }
                }

                if (remainingQtyToClose > 0 && ALLOW_UNHEDGED_CLOSE) {
                    if (remainingQtyToClose > 0) {
                        try {
                            const mainRes = await Helpers.executeTrade(exchangeName, pos.coin, closeSide, remainingQtyToClose, this.services, this.userId);
                            if (mainRes.success) {
                                const exCodeMain = exchangeName.charAt(0);
                                localLogs.push(`✂️ <b>${pos.coin} ${exCodeMain}-PANIC</b>: ${remainingQtyToClose} (Unhedged)`);
                                remainingQtyToClose = 0;
                            } else {
                                localLogs.push(`❌ Panic Close Fail ${exchangeName} ${pos.coin}: ${mainRes.error}`);
                            }
                        } catch (e: any) {
                            localLogs.push(`❌ Panic Exc Error: ${e.message}`);
                        }
                    }
                }
                return localLogs;
            });

            const isL2Exchange = ['Lighter', 'Extended', 'Paradex'].includes(exchangeName);
            const concurrency = isL2Exchange ? 1 : 5;
            // this.logger.log(`Reducing ${exchangeName} with concurrency: ${concurrency}`);
            const results = await this.runWithConcurrency(tasks, concurrency);
            return results.flat();

        } catch (e: any) {
            return [`🔥 Global Error reducing ${exchangeName}: ${e.message}`];
        }
    }

    // =========================================================================
    // --- ЛОГИКА ADL PROTECTION (HYPERLIQUID ONLY) ---
    // =========================================================================

    public async checkAndFixHyperliquidADL(): Promise<{ logs: string[], actionTaken: boolean }> {
        const logs: string[] = [];
        let actionTaken = false;

        try {
            const positions = await this.services.hl.getSimplePositions(this.userId);

            for (const pos of positions) {
                if (pos.unrealizedPnl === undefined || pos.unrealizedPnl <= 0) continue;
                const notional = parseFloat(pos.notional);
                if (notional === 0) continue;

                const currentRatio = pos.unrealizedPnl / notional;
                const notifKey = `ADL_${pos.coin}`;
                const now = Date.now();

                // --- 1. КРАСНАЯ ЗОНА (РЕЗКА) ---
                if (currentRatio > ADL_TRIGGER_PNL_RATIO) {
                    actionTaken = true;
                    logs.push(`⚠️ <b>ADL TRIGGER: ${pos.coin}</b> PnL Ratio: ${(currentRatio * 100).toFixed(1)}% (Limit: ${ADL_TRIGGER_PNL_RATIO * 100}%)`);

                    const rawCycleQty = pos.size * (1 - (ADL_TARGET_PNL_RATIO / currentRatio));
                    const cycleQty = this.calculateSafeQuantity(rawCycleQty);

                    if (cycleQty <= 0) {
                        logs.push(`ℹ️ Skipped ADL fix for ${pos.coin}: Qty too small.`);
                        continue;
                    }

                    logs.push(`♻️ <b>Fixing ADL for ${pos.coin}...</b> Cycling: ${cycleQty}`);

                    const closeSide = pos.side === 'L' ? 'SELL' : 'BUY';
                    const openSide = pos.side === 'L' ? 'BUY' : 'SELL';

                    const closeRes = await Helpers.executeTrade('Hyperliquid', pos.coin, closeSide, cycleQty, this.services, this.userId);

                    if (closeRes.success) {
                        await new Promise(r => setTimeout(r, 500));
                        const openRes = await Helpers.executeTrade('Hyperliquid', pos.coin, openSide, cycleQty, this.services, this.userId);

                        if (openRes.success) {
                            logs.push(`✅ <b>ADL Success ${pos.coin}:</b> Cycled ${cycleQty}.`);
                        } else {
                            logs.push(`❌ <b>ADL OPEN FAIL ${pos.coin}:</b> Closed but failed to reopen! Error: ${openRes.error}`);
                        }
                    } else {
                        logs.push(`❌ ADL Close Fail ${pos.coin}: ${closeRes.error}`);
                    }
                }
                // --- 2. ЖЕЛТАЯ ЗОНА (УВЕДОМЛЕНИЕ) ---
                else if (currentRatio > ADL_WARN_PNL_RATIO) {
                    const lastNotif = this.lastNotificationTime.get(notifKey) || 0;
                    if (now - lastNotif > NOTIFICATION_COOLDOWN_MS) {
                        logs.push(`⚠️ <b>ADL WARNING: ${pos.coin}</b> PnL Ratio: ${(currentRatio * 100).toFixed(1)}%`);
                        logs.push(`(Yellow Zone: ${ADL_WARN_PNL_RATIO * 100}% - ${ADL_TRIGGER_PNL_RATIO * 100}%). Consider fixing manually.`);
                        this.lastNotificationTime.set(notifKey, now);
                    }
                }
            }

        } catch (e: any) {
            logs.push(`🔥 Error in ADL Check: ${e.message}`);
        }

        return { logs, actionTaken };
    }

    // =========================================================================
    // --- УТИЛИТЫ ---
    // =========================================================================

    private calculateSafeQuantity(amount: number): number {
        const absAmount = Math.abs(amount);
        let result: number;

        if (absAmount >= 10) result = Math.floor(absAmount);
        else if (absAmount >= 1) result = Math.floor(absAmount * 10) / 10;
        else if (absAmount >= 0.1) return Math.floor(absAmount * 100) / 100;
        else if (absAmount >= 0.01) return Math.floor(absAmount * 1000) / 1000;
        else result = Math.floor(absAmount * 10000) / 10000;
        return parseFloat(result.toFixed(8));
    }

    private async runWithConcurrency<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
        const results: T[] = [];
        const executing: Promise<void>[] = [];

        // Жесткий таймаут на выполнение одной задачи
        // ОПТИМАЛЬНО: 20 сек (7с Lighter + 0.5с sleep + API overhead)
        const TIMEOUT_MS = 20000;

        for (const task of tasks) {
            // Обертка с таймаутом
            const taskWithTimeout = async () => {
                const timeoutPromise = new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('Task Timeout')), TIMEOUT_MS)
                );
                return Promise.race([task(), timeoutPromise]);
            };

            const p = taskWithTimeout()
                .then(result => {
                    results.push(result);
                })
                .catch(err => {
                    this.logger.error(`[User ${this.userId}] Task failed/timed out: ${err.message}`);
                    // Возвращаем ошибку в отчет, чтобы юзер видел её в ТГ
                    // Cast to T (подразумеваем, что T это string[] или совместимо, либо просто игнорируем типы для ошибки)
                    // Но так как T unknown, лучше просто добавить в results, если это string[]
                    results.push([`❌ Task Failed/Timeout: ${err.message}`] as unknown as T);
                });

            executing.push(p);

            if (executing.length >= concurrency) {
                await Promise.race(executing);
            }
        }
        await Promise.all(executing);
        return results;
    }
}
