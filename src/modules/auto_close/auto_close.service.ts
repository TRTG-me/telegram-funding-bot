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
const TRIGGER_LEVERAGE = 5.8;       // Порог срабатывания (если плечо выше 5 -> режем)
const TARGET_LEVERAGE = 5.2;      // Цель (режем до 4.5)
const ALLOW_UNHEDGED_CLOSE = true;// Если хедж не найден/не сработал, закрывать ли основу?

// --- КОНФИГУРАЦИЯ ADL (Hyperliquid) ---
const ADL_TRIGGER_PNL_RATIO = 0.3; // Если PnL > 50% от позиции -> риск ADL
const ADL_TARGET_PNL_RATIO = 0.2;  // Срезаем, чтобы PnL стал 40%

// --- ТАЙМЕРЫ ---
const NORMAL_INTERVAL_MS = 60 * 1000;      // 1 минута (Спокойный режим)
const EMERGENCY_INTERVAL_MS = 20 * 1000;   // 20 секунд (Экстренный режим)
const EMERGENCY_COOLDOWN_MS = 5 * 60 * 1000; // 5 минут тишины перед возвратом в норму

@Injectable()
export class AutoCloseService {
    private readonly logger = new Logger(AutoCloseService.name);

    // Состояние мониторинга
    private isMonitoring = false;
    private isEmergencyMode = false;
    private lastActionTimestamp = 0;
    private monitoringTimeout: NodeJS.Timeout | null = null;

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

        // Безопасная отправка, чтобы ошибка Телеграма не убила цикл
        const safeNotify = async (msg: string) => {
            try { await notifyCallback(msg); }
            catch (e) { this.logger.error(`Notify failed: ${e}`); }
        };

        try {
            // 1. ПРОВЕРКА РИСКОВ (ЛЕВЕРЕДЖ)
            const { logs: riskLogs, actionTaken: riskAction } = await this.checkAndReduceRisk();

            // 2. ПРОВЕРКА ADL (HYPERLIQUID PNL)
            const { logs: adlLogs, actionTaken: adlAction } = await this.checkAndFixHyperliquidADL();

            const actionTaken = riskAction || adlAction;
            const now = Date.now();

            // 3. ЛОГИКА ПЕРЕКЛЮЧЕНИЯ РЕЖИМОВ
            if (actionTaken) {
                this.lastActionTimestamp = now;
                if (!this.isEmergencyMode) {
                    this.isEmergencyMode = true;
                    await safeNotify('🚨 <b>ЭКСТРЕННЫЙ РЕЖИМ ВКЛЮЧЕН</b>\nОбнаружены риски. Интервал проверки: <b>20 сек</b>.');
                }
            } else {
                if (this.isEmergencyMode) {
                    // Если прошло 5 минут без происшествий
                    if (now - this.lastActionTimestamp > EMERGENCY_COOLDOWN_MS) {
                        this.isEmergencyMode = false;
                        await safeNotify('✅ <b>Риски устранены.</b>\n5 минут тишины. Возврат к интервалу: <b>1 минута</b>.');
                    }
                }
            }

            // 4. ОТПРАВКА ЛОГОВ
            const allLogs = [...riskLogs, ...adlLogs].filter(l => !l.includes('✅ Все биржи в безопасности'));

            if (allLogs.length > 0) {
                await safeNotify(allLogs.join('\n'));
            } else if (actionTaken && (riskLogs.length > 0 || adlLogs.length > 0)) {
                // На случай если actionTaken=true, но логи стандартные
                await safeNotify([...riskLogs, ...adlLogs].join('\n'));
            }

        } catch (e: any) {
            this.logger.error(`Monitoring Loop Error: ${e.message}`);
            await safeNotify(`❌ Ошибка цикла мониторинга: ${e.message}`);
        } finally {
            // ГАРАНТИРОВАННЫЙ ПЕРЕЗАПУСК
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
                return { name, leverage: 0 };
            }
        };

        // Собираем данные
        const allData = await Promise.all(Object.keys(exchangeServices).map(name => getLeverageData(name as ExchangeName)));

        // Фильтруем опасные биржи
        const dangerExchanges = allData
            .filter(r => r.leverage >= TRIGGER_LEVERAGE)
            .sort((a, b) => b.leverage - a.leverage);

        if (dangerExchanges.length === 0) {
            return {
                logs: [`✅ Все биржи в безопасности (Leverage &lt; ${TRIGGER_LEVERAGE})`],
                actionTaken: false
            };
        }

        actionTaken = true;

        for (const dangerEx of dangerExchanges) {
            const freshData = await getLeverageData(dangerEx.name);
            if (freshData.leverage < TRIGGER_LEVERAGE) {
                logs.push(`ℹ️ Skipped ${dangerEx.name}: Leverage dropped to ${freshData.leverage.toFixed(2)}.`);
                continue;
            }

            logs.push(`🚨 <b>ALARM: ${dangerEx.name} Leverage: ${freshData.leverage.toFixed(2)}</b>`);

            const L1 = freshData.leverage;
            const L2 = TARGET_LEVERAGE;
            const alpha = (L1 - L2) / L1; // Упрощенная безопасная формула (без Кeff, чтобы наверняка)

            if (alpha <= 0.001) {
                logs.push(`⚠️ Alpha too small, skipping.`);
                continue;
            }

            logs.push(`🧮 Reducing by <b>${(alpha * 100).toFixed(2)}%</b>`);

            // Передаем allData для приоритезации хеджей
            const report = await this.reducePositionsOnExchange(dangerEx.name, alpha, exchangeServices, allData);
            logs.push(...report);
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
            // ОПТИМИЗАЦИЯ: Используем getSimplePositions (быстро, без фандинга)
            const positions: IDetailedPosition[] = await service.getSimplePositions();

            // Получаем позиции хеджеров
            const otherExchanges = Object.keys(allServices).filter(k => k !== exchangeName) as ExchangeName[];
            const allHedgePositions: Record<string, IDetailedPosition[]> = {};

            await Promise.all(otherExchanges.map(async (exName) => {
                try {
                    allHedgePositions[exName] = await allServices[exName].getSimplePositions();
                } catch (e) { allHedgePositions[exName] = []; }
            }));

            // СОРТИРОВКА: Сначала используем хеджи на биржах с высоким плечом
            const sortedHedgeExchanges = Object.keys(allHedgePositions).sort((exA, exB) => {
                const levA = allLeverageData.find(d => d.name === exA)?.leverage || 0;
                const levB = allLeverageData.find(d => d.name === exB)?.leverage || 0;
                return levB - levA; // Descending
            });

            // --- ЗАДАЧИ ---
            const tasks = positions.map(pos => async () => {
                const localLogs: string[] = [];

                // Нормализация (kBONK -> BONK) для сравнения
                const targetAsset = Helpers.getAssetName(pos.coin);

                const rawTargetQty = pos.size * alpha;
                let remainingQtyToClose = this.calculateSafeQuantity(rawTargetQty);
                if (remainingQtyToClose <= 0) return [];

                const closeSide = pos.side === 'L' ? 'SELL' : 'BUY';

                // --- КАСКАДНЫЙ ПОИСК ХЕДЖЕЙ ---
                for (const hedgeExName of sortedHedgeExchanges) {
                    if (remainingQtyToClose <= 0) break;

                    const hedgePosList = allHedgePositions[hedgeExName];
                    const hedgePos = hedgePosList.find(p => Helpers.getAssetName(p.coin) === targetAsset);

                    if (hedgePos && hedgePos.side !== pos.side) {
                        let qtyForThisHedge = Math.min(remainingQtyToClose, hedgePos.size);
                        qtyForThisHedge = this.calculateSafeQuantity(qtyForThisHedge);

                        if (qtyForThisHedge <= 0) continue;

                        // Race Condition Fix: вычитаем из памяти
                        hedgePos.size -= qtyForThisHedge;
                        if (hedgePos.size < 0) hedgePos.size = 0;

                        const hedgeCloseSide = hedgePos.side === 'L' ? 'SELL' : 'BUY';
                        let currentHedgeExecuted = false;
                        let pendingHedgeLog: string | null = null;
                        let pendingHedgeError: string | null = null;

                        // 1. Закрываем Хедж
                        try {
                            const res = await Helpers.executeTrade(
                                hedgeExName as ExchangeName,
                                hedgePos.coin,
                                hedgeCloseSide,
                                qtyForThisHedge,
                                this.services
                            );

                            if (res.success) {
                                currentHedgeExecuted = true;
                                pendingHedgeLog = `✅ Hedge closed on ${hedgeExName}: ${qtyForThisHedge}`;
                            } else {
                                pendingHedgeError = `⚠️ Hedge fail on ${hedgeExName}: ${res.error}`;
                                hedgePos.size += qtyForThisHedge; // Rollback при ошибке
                            }
                        } catch (e: any) {
                            pendingHedgeError = `⚠️ Hedge exc error on ${hedgeExName}: ${e.message}`;
                            hedgePos.size += qtyForThisHedge; // Rollback
                        }

                        // 2. Закрываем Основу
                        if (currentHedgeExecuted || ALLOW_UNHEDGED_CLOSE) {
                            try {
                                const mainRes = await Helpers.executeTrade(
                                    exchangeName,
                                    pos.coin,
                                    closeSide,
                                    qtyForThisHedge,
                                    this.services
                                );

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
                return localLogs;
            });

            // Для L2 лучше 1 поток
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
            // ОПТИМИЗАЦИЯ: Используем getSimplePositions (он теперь возвращает PnL и Notional)
            const positions = await this.hyperliquidService.getSimplePositions();

            for (const pos of positions) {
                // Пропускаем, если нет PnL (другие биржи) или ношнл 0
                console.log(`Checking ADL for ${pos.coin}: PnL=${pos.unrealizedPnl}, Notional=${pos.notional}`);
                if (pos.unrealizedPnl === undefined || pos.unrealizedPnl <= 0) continue;

                const notional = parseFloat(pos.notional);
                if (notional === 0) continue;

                // Считаем Ratio: PnL / Notional
                const currentRatio = pos.unrealizedPnl / notional;
                console.log(`ADL Check ${pos.coin}: PnL=${pos.unrealizedPnl}, Notional=${notional}, Ratio=${currentRatio}`);

                if (currentRatio > ADL_TRIGGER_PNL_RATIO) {
                    actionTaken = true;
                    logs.push(`⚠️ <b>ADL WARNING: ${pos.coin}</b> PnL Ratio: ${(currentRatio * 100).toFixed(1)}%`);

                    // Расчет цикла
                    const rawCycleQty = pos.size * (1 - (ADL_TARGET_PNL_RATIO / currentRatio));
                    const cycleQty = this.calculateSafeQuantity(rawCycleQty);

                    if (cycleQty <= 0) {
                        logs.push(`ℹ️ Skipped ADL fix for ${pos.coin}: Qty too small.`);
                        continue;
                    }

                    logs.push(`♻️ <b>Fixing ADL for ${pos.coin}...</b> Cycling: ${cycleQty}`);

                    const closeSide = pos.side === 'L' ? 'SELL' : 'BUY';
                    const openSide = pos.side === 'L' ? 'BUY' : 'SELL';

                    // 1. Закрываем
                    const closeRes = await Helpers.executeTrade('Hyperliquid', pos.coin, closeSide, cycleQty, this.services);

                    if (closeRes.success) {
                        // Пауза перед открытием (защита от Sequence/Nonce errors)
                        await new Promise(r => setTimeout(r, 500));

                        // 2. Открываем обратно
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
        if (absAmount >= 10) return Math.floor(absAmount);
        else if (absAmount >= 1) return Math.floor(absAmount * 10) / 10;
        else if (absAmount >= 0.1) return Math.floor(absAmount * 100) / 100;
        else if (absAmount >= 0.01) return Math.floor(absAmount * 1000) / 1000;
        else return Math.floor(absAmount * 10000) / 10000;
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