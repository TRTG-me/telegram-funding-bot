import { Injectable, Logger } from '@nestjs/common';
import { BinanceService } from '../binance/binance.service';
import { HyperliquidService } from '../hyperliquid/hyperliquid.service';
import { ParadexService } from '../paradex/paradex.service';
import { LighterService } from '../lighter/lighter.service';
import { ExtendedService } from '../extended/extended.service';
import * as Helpers from '../auto_trade/auto_trade.helpers';
import { ITradingServices } from '../auto_trade/auto_trade.helpers';
import { ExchangeName } from '../auto_trade/auto_trade.service';
import { IDetailedPosition } from '../../common/interfaces';

// --- КОНФИГУРАЦИЯ РИСКОВ ---
const TARGET_LEVERAGE = 5.7;        // Цель (куда возвращаемся)
const WARN_LEVERAGE = 5.8;          // Желтая зона (только уведомление)
const TRIGGER_LEVERAGE = 6;       // Красная зона (автоматическая резка)
const ALLOW_UNHEDGED_CLOSE = true;

// --- КОНФИГУРАЦИЯ ADL (Hyperliquid) ---
const ADL_TARGET_PNL_RATIO = 0.2;   // Цель (куда возвращаем PnL)
const ADL_WARN_PNL_RATIO = 0.4;     // Желтая зона ADL (уведомление)
const ADL_TRIGGER_PNL_RATIO = 0.5;  // Красная зона ADL (резка)

// --- ТАЙМЕРЫ ---
const NORMAL_INTERVAL_MS = 30 * 1000;
const EMERGENCY_INTERVAL_MS = 20 * 1000;
const EMERGENCY_COOLDOWN_MS = 5 * 60 * 1000;
const NOTIFICATION_COOLDOWN_MS = 1 * 60 * 1000; // Спамить не чаще раза в 5 мин

@Injectable()
export class AutoCloseService {
    private readonly logger = new Logger(AutoCloseService.name);

    private isMonitoring = false;
    private isEmergencyMode = false;
    private lastActionTimestamp = 0;
    private monitoringTimeout: NodeJS.Timeout | null = null;

    // Хранилище времени последнего уведомления (Key -> Timestamp)
    // Key для плеча: "LEV_Hyperliquid"
    // Key для ADL: "ADL_BTC"
    private lastNotificationTime = new Map<string, number>();

    constructor(
        private binanceService: BinanceService,
        private hyperliquidService: HyperliquidService,
        private paradexService: ParadexService,
        private lighterService: LighterService,
        private extendedService: ExtendedService
    ) { }

    public get isMonitoringActive(): boolean {
        return this.isMonitoring;
    }

    private get services(): ITradingServices {
        return {
            binance: this.binanceService,
            hl: this.hyperliquidService,
            paradex: this.paradexService,
            extended: this.extendedService,
            lighter: this.lighterService,
        };
    }

    // =========================================================================
    // --- УПРАВЛЕНИЕ МОНИТОРИНГОМ ---
    // =========================================================================

    public startMonitoring(notifyCallback: (msg: string) => Promise<void>) {
        if (this.isMonitoring) {
            return notifyCallback('⚠️ Мониторинг уже запущен.');
        }

        this.isMonitoring = true;
        this.isEmergencyMode = false;
        this.lastActionTimestamp = 0;
        this.lastNotificationTime.clear();

        notifyCallback('🛡 <b>Auto-Close + ADL Protection запущен.</b>\nИнтервал проверки: 1 минута.');
        this.logger.log('Started Auto-Close monitoring.');

        this.runMonitoringLoop(notifyCallback);
    }

    public stopMonitoring() {
        this.isMonitoring = false;
        if (this.monitoringTimeout) {
            clearTimeout(this.monitoringTimeout);
            this.monitoringTimeout = null;
        }
        this.logger.log('Stopped Auto-Close monitoring.');
    }

    private async runMonitoringLoop(notifyCallback: (msg: string) => Promise<void>) {
        if (!this.isMonitoring) return;

        const safeNotify = async (msg: string) => {
            try { await notifyCallback(msg); }
            catch (e) { this.logger.error(`Notify failed: ${e}`); }
        };

        try {
            // 1. ПРОВЕРКА РИСКОВ (ЛЕВЕРЕДЖ)
            const { logs: riskLogs, actionTaken: riskAction } = await this.checkAndReduceRisk();
            console.log(`Risk Check Completed ${new Date().toLocaleString('ru-RU')}`);
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
                    await safeNotify('🚨 <b>ЭКСТРЕННЫЙ РЕЖИМ ВКЛЮЧЕН</b>\nСработал триггер резки. Интервал: <b>20 сек</b>.');
                }
            } else {
                if (this.isEmergencyMode) {
                    if (now - this.lastActionTimestamp > EMERGENCY_COOLDOWN_MS) {
                        this.isEmergencyMode = false;
                        await safeNotify('✅ <b>Ситуация стабилизировалась.</b>\nВозврат к интервалу: <b>1 минута</b>.');
                    }
                }
            }

            // 4. ОТПРАВКА ЛОГОВ
            // Объединяем логи (там могут быть и уведомления о WARN, и отчеты о CUT)
            const allLogs = [...riskLogs, ...adlLogs].filter(l => !l.includes('✅ Все биржи в безопасности'));

            if (allLogs.length > 0) {
                await safeNotify(allLogs.join('\n'));
            } else if (actionTaken && (riskLogs.length > 0 || adlLogs.length > 0)) {
                await safeNotify([...riskLogs, ...adlLogs].join('\n'));
            }

        } catch (e: any) {
            this.logger.error(`Monitoring Loop Error: ${e.message}`);
            await safeNotify(`❌ Ошибка цикла мониторинга: ${e.message}`);
        } finally {
            if (this.isMonitoring) {
                const delay = this.isEmergencyMode ? EMERGENCY_INTERVAL_MS : NORMAL_INTERVAL_MS;
                this.monitoringTimeout = setTimeout(() => this.runMonitoringLoop(notifyCallback), delay);
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
            'Binance': this.binanceService,
            'Hyperliquid': this.hyperliquidService,
            'Paradex': this.paradexService,
            'Lighter': this.lighterService,
            'Extended': this.extendedService
        };

        const getLeverageData = async (name: ExchangeName) => {
            try {
                const data = await exchangeServices[name].calculateLeverage();
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
            // logs.push(`✅ Все биржи в безопасности (Max: ${maxLeverage.toFixed(2)})`);
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
                console.log(alpha)
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
            const positions: IDetailedPosition[] = await service.getSimplePositions();

            const otherExchanges = Object.keys(allServices).filter(k => k !== exchangeName) as ExchangeName[];
            const allHedgePositions: Record<string, IDetailedPosition[]> = {};

            await Promise.all(otherExchanges.map(async (exName) => {
                try {
                    allHedgePositions[exName] = await allServices[exName].getSimplePositions();
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
                            const res = await Helpers.executeTrade(hedgeExName as ExchangeName, hedgePos.coin, hedgeCloseSide, qtyForThisHedge, this.services);
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
                                const mainRes = await Helpers.executeTrade(exchangeName, pos.coin, closeSide, qtyForThisHedge, this.services);
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
                            const mainRes = await Helpers.executeTrade(exchangeName, pos.coin, closeSide, remainingQtyToClose, this.services);
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
            this.logger.log(`Reducing ${exchangeName} with concurrency: ${concurrency}`);
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
            const positions = await this.hyperliquidService.getSimplePositions();

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

                    const closeRes = await Helpers.executeTrade('Hyperliquid', pos.coin, closeSide, cycleQty, this.services);

                    if (closeRes.success) {
                        await new Promise(r => setTimeout(r, 500));
                        const openRes = await Helpers.executeTrade('Hyperliquid', pos.coin, openSide, cycleQty, this.services);

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
        // ФИНАЛЬНАЯ ЧИСТКА
        // toFixed убирает мусор (1.12000001 -> "1.12")
        // parseFloat превращает обратно в чистое число 1.12
        // Используем 8 знаков, чтобы не потерять точность крипты
        return parseFloat(result.toFixed(8));
    }

    private async runWithConcurrency<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
        const results: T[] = [];
        const executing: Promise<void>[] = [];

        for (const task of tasks) {
            const p = task().then(result => {
                results.push(result);
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