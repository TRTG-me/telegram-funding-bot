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

const TRIGGER_LEVERAGE = 3.5;   // Порог срабатывания
const TARGET_LEVERAGE = 3;  // Целевое плечо
const ALLOW_UNHEDGED_CLOSE = true; // Закрывать ли основу, если хедж не прошел?

@Injectable()
export class AutoCloseService {
    private readonly logger = new Logger(AutoCloseService.name);

    constructor(
        private binanceService: BinanceService,
        private hyperliquidService: HyperliquidService,
        private paradexService: ParadexService,
        private lighterService: LighterService,
        private extendedService: ExtendedService
    ) { }

    private get services(): ITradingServices {
        return {
            binance: this.binanceService,
            hl: this.hyperliquidService,
            paradex: this.paradexService,
            extended: this.extendedService,
            lighter: this.lighterService,
        };
    }


    private normalizeToAsset(symbol: string): string {
        let s = symbol.toUpperCase();

        // 1. Убираем суффиксы
        s = s.replace(/-USD-PERP$/, '')
            .replace(/-USD$/, '')
            .replace(/-PERP$/, '')
            .replace(/USDT$/, '')
            .replace(/USDC$/, '');

        // 2. Убираем префиксы (1000, k, K)
        // Если начинается на 1000 -> убираем
        if (s.startsWith('1000')) {
            s = s.substring(4);
        }

        // Если начинается на K и длина > 3 (чтобы не сломать KDA, но поймать KBONK)
        // KBONK (5 chars) -> BONK
        // KDA (3 chars) -> KDA (не трогаем)
        if (s.startsWith('K') && s.length > 3) {
            s = s.substring(1);
        }

        // 3. Обернутые токены
        if (s === 'WETH') return 'ETH';
        if (s === 'WBTC') return 'BTC';

        return s;
    }

    private calculateSafeQuantity(amount: number): number {
        const absAmount = Math.abs(amount);
        if (absAmount >= 10) return Math.floor(absAmount);
        else if (absAmount >= 1) return Math.floor(absAmount * 10) / 10;
        else if (absAmount >= 0.1) return Math.floor(absAmount * 100) / 100;
        else return Math.floor(absAmount * 100000) / 100000;
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

    public async checkAndReduceRisk(): Promise<string[]> {
        const logs: string[] = [];

        // 1. Сбор данных
        const exchangeServices: Record<ExchangeName, any> = {
            'Binance': this.binanceService,
            'Hyperliquid': this.hyperliquidService,
            'Paradex': this.paradexService,
            'Lighter': this.lighterService,
            'Extended': this.extendedService
        };

        interface ExchangeData {
            name: ExchangeName;
            leverage: number;
            accountEquity: number;
            P_MM_keff: number;
        }

        const getLeverageData = async (name: ExchangeName): Promise<ExchangeData> => {
            try {
                const data = await exchangeServices[name].calculateLeverage();
                return { name, ...data };
            } catch (e) {
                return { name, leverage: 0, accountEquity: 0, P_MM_keff: 0 };
            }
        };

        const allData = await Promise.all(Object.keys(exchangeServices).map(name => getLeverageData(name as ExchangeName)));

        // 2. Фильтрация
        const dangerExchanges = allData
            .filter(r => r.leverage >= TRIGGER_LEVERAGE)
            .sort((a, b) => b.leverage - a.leverage);

        if (dangerExchanges.length === 0) {
            return [`✅ Все биржи в безопасности (Leverage &lt; ${TRIGGER_LEVERAGE})`];
        }

        // 3. Обработка
        for (const dangerEx of dangerExchanges) {
            const freshData = await getLeverageData(dangerEx.name);
            if (freshData.leverage < TRIGGER_LEVERAGE) {
                logs.push(`ℹ️ Skipped ${dangerEx.name}: Leverage dropped to ${freshData.leverage.toFixed(2)}.`);
                continue;
            }

            logs.push(`🚨 <b>ALARM: ${dangerEx.name} Leverage: ${freshData.leverage.toFixed(2)}</b>`);

            const L1 = freshData.leverage;
            const L2 = TARGET_LEVERAGE;
            const K = freshData.P_MM_keff || 0;

            let alpha = 0;
            const denominator = L1 * (1 + L2 * K);

            if (denominator !== 0) alpha = (L1 - L2) / denominator;
            else alpha = (L1 - L2) / L1;

            if (alpha > 1) alpha = 1;
            if (alpha < 0) alpha = 0;

            logs.push(`🧮 Alpha calculated: <b>${(alpha * 100).toFixed(2)}%</b> reduction.`);

            if (alpha <= 0.001) {
                logs.push(`⚠️ Alpha too small, skipping.`);
                continue;
            }

            const report = await this.reducePositionsOnExchange(dangerEx.name, alpha, exchangeServices, allData);
            logs.push(...report);
        }

        return logs;
    }

    private async reducePositionsOnExchange(
        exchangeName: ExchangeName,
        alpha: number,
        allServices: Record<ExchangeName, any>,
        allLeverageData: { name: ExchangeName, leverage: number }[]
    ): Promise<string[]> {
        const service = allServices[exchangeName];

        try {
            const positions: IDetailedPosition[] = await service.getDetailedPositions();

            const otherExchanges = Object.keys(allServices).filter(k => k !== exchangeName) as ExchangeName[];
            const allHedgePositions: Record<string, IDetailedPosition[]> = {};

            await Promise.all(otherExchanges.map(async (exName) => {
                try {
                    allHedgePositions[exName] = await allServices[exName].getDetailedPositions();
                } catch (e) { allHedgePositions[exName] = []; }
            }));

            // Сортировка хеджей по плечу (сначала высокие)
            const sortedHedgeExchanges = Object.keys(allHedgePositions).sort((exA, exB) => {
                const levA = allLeverageData.find(d => d.name === exA)?.leverage || 0;
                const levB = allLeverageData.find(d => d.name === exB)?.leverage || 0;
                return levB - levA;
            });

            // --- ЗАДАЧИ ---
            const tasks = positions.map(pos => async () => {
                const localLogs: string[] = [];

                // 1. Получаем "Чистое" имя актива (например BONK)
                const targetAsset = this.normalizeToAsset(pos.coin);

                const rawTargetQty = pos.size * alpha;

                let remainingQtyToClose = this.calculateSafeQuantity(rawTargetQty);
                if (remainingQtyToClose <= 0) return [];

                const closeSide = pos.side === 'L' ? 'SELL' : 'BUY';

                // --- ПОИСК ХЕДЖА ---
                for (const hedgeExName of sortedHedgeExchanges) {
                    if (remainingQtyToClose <= 0) break;

                    const hedgePosList = allHedgePositions[hedgeExName];

                    // Ищем актив с таким же "Чистым" именем
                    const hedgePos = hedgePosList.find(p => {
                        return this.normalizeToAsset(p.coin) === targetAsset;
                    });

                    if (hedgePos && hedgePos.side !== pos.side) {
                        let qtyForThisHedge = Math.min(remainingQtyToClose, hedgePos.size);
                        qtyForThisHedge = this.calculateSafeQuantity(qtyForThisHedge);

                        if (qtyForThisHedge <= 0) continue;

                        // Race condition fix
                        hedgePos.size -= qtyForThisHedge;
                        if (hedgePos.size < 0) hedgePos.size = 0;

                        const hedgeCloseSide = hedgePos.side === 'L' ? 'SELL' : 'BUY';

                        let currentHedgeExecuted = false;
                        let pendingHedgeLog: string | null = null;
                        let pendingHedgeError: string | null = null;

                        // Исполнение хеджа
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
                                hedgePos.size += qtyForThisHedge; // Rollback
                            }
                        } catch (e: any) {
                            pendingHedgeError = `⚠️ Hedge exc error on ${hedgeExName}: ${e.message}`;
                            hedgePos.size += qtyForThisHedge; // Rollback
                        }

                        // Исполнение основы
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

            // --- ЗАПУСК ---
            const isL2Exchange = ['Lighter', 'Extended', 'Paradex'].includes(exchangeName);
            const concurrency = isL2Exchange ? 1 : 5;

            this.logger.log(`Reducing ${exchangeName} with concurrency: ${concurrency}`);

            const results = await this.runWithConcurrency(tasks, concurrency);
            return results.flat();

        } catch (e: any) {
            return [`🔥 Global Error reducing ${exchangeName}: ${e.message}`];
        }
    }
}