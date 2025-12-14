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

const TRIGGER_LEVERAGE = 4.8;
const TARGET_LEVERAGE = 4.5;
const ALLOW_UNHEDGED_CLOSE = true;

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

    private calculateSafeQuantity(amount: number): number {
        const absAmount = Math.abs(amount);
        if (absAmount >= 10) return Math.floor(absAmount);
        else if (absAmount >= 1) return Math.floor(absAmount * 10) / 10;
        else if (absAmount >= 0.1) return Math.floor(absAmount * 100) / 100;
        else return Math.floor(absAmount * 1000) / 1000;
    }

    /**
     * Выполняет задачи с ограничением параллелизма
     */
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

        // 1. Получаем первичный список бирж и их плечи
        const exchangeServices: Record<ExchangeName, any> = {
            'Binance': this.binanceService,
            'Hyperliquid': this.hyperliquidService,
            'Paradex': this.paradexService,
            'Lighter': this.lighterService,
            'Extended': this.extendedService
        };

        // Вспомогательная функция для получения данных одной биржи
        const getLeverageData = async (name: ExchangeName) => {
            try {
                const data = await exchangeServices[name].calculateLeverage();
                return { name, ...data };
            } catch (e) {
                return { name, leverage: 0, accountEquity: 0, P_MM_keff: 0 };
            }
        };

        // Получаем данные всех бирж сразу
        const allData = await Promise.all(Object.keys(exchangeServices).map(name => getLeverageData(name as ExchangeName)));

        // 2. Сортируем опасные биржи
        let dangerExchanges = allData
            .filter(r => r.leverage >= TRIGGER_LEVERAGE)
            .sort((a, b) => b.leverage - a.leverage);

        if (dangerExchanges.length === 0) {
            return ['✅ Все биржи в безопасности (Leverage < 5)'];
        }

        // 3. Обрабатываем ПОСЛЕДОВАТЕЛЬНО (чтобы пересчитывать риски)
        // Мы не используем Promise.all для бирж, потому что закрытие на одной может изменить ситуацию на другой (если они хеджируют друг друга)
        for (const dangerEx of dangerExchanges) {

            // --- RE-CHECK (Проверка актуальности) ---
            // Получаем свежее плечо перед действием. 
            // Вдруг пока мы резали первую биржу, эта тоже уменьшилась (если была хеджем)?
            const freshData = await getLeverageData(dangerEx.name);
            if (freshData.leverage < TRIGGER_LEVERAGE) {
                logs.push(`ℹ️ Skipped ${dangerEx.name}: Leverage dropped to ${freshData.leverage.toFixed(2)} automatically.`);
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

            const report = await this.reducePositionsOnExchange(dangerEx.name, alpha, exchangeServices);
            logs.push(...report);
        }

        return logs;
    }

    private async reducePositionsOnExchange(
        exchangeName: ExchangeName,
        alpha: number,
        allServices: Record<ExchangeName, any>
    ): Promise<string[]> {
        const service = allServices[exchangeName];

        try {
            const positions: IDetailedPosition[] = await service.getDetailedPositions();

            // Кэш хедж-позиций (получаем один раз)
            const otherExchanges = Object.keys(allServices).filter(k => k !== exchangeName) as ExchangeName[];
            const allHedgePositions: Record<string, IDetailedPosition[]> = {};
            await Promise.all(otherExchanges.map(async (exName) => {
                try {
                    allHedgePositions[exName] = await allServices[exName].getDetailedPositions();
                } catch (e) { allHedgePositions[exName] = []; }
            }));

            // --- ПОДГОТОВКА ЗАДАЧ ---
            // Создаем функции-задачи, но не запускаем их сразу
            const tasks = positions.map(pos => async () => {
                const localLogs: string[] = [];

                const rawReduceQty = pos.size * alpha;
                const cleanReduceQty = this.calculateSafeQuantity(rawReduceQty);

                if (cleanReduceQty <= 0) return [];

                const closeSide = pos.side === 'L' ? 'SELL' : 'BUY';
                let hedgeExFound: string | null = null;
                let hedgeActionExecuted = false;

                // Поиск хеджа
                for (const [hedgeExName, hedgePosList] of Object.entries(allHedgePositions)) {
                    const hedgePos = hedgePosList.find(p =>
                        p.coin === pos.coin || p.coin.includes(pos.coin) || pos.coin.includes(p.coin)
                    );

                    if (hedgePos && hedgePos.side !== pos.side) {
                        hedgeExFound = hedgeExName;
                        const hedgeCloseSide = hedgePos.side === 'L' ? 'SELL' : 'BUY';

                        try {
                            const res = await Helpers.executeTrade(
                                hedgeExName as ExchangeName,
                                hedgePos.coin,
                                hedgeCloseSide,
                                cleanReduceQty,
                                this.services
                            );

                            if (res.success) hedgeActionExecuted = true;
                            else localLogs.push(`⚠️ Hedge fail on ${hedgeExName}: ${res.error}`);
                        } catch (e: any) {
                            localLogs.push(`⚠️ Hedge exc error on ${hedgeExName}: ${e.message}`);
                        }
                        break;
                    }
                }

                // --- БЕЗОПАСНОСТЬ: ЗАКРЫВАТЬ ЛИ ОСНОВУ, ЕСЛИ ХЕДЖ НЕ ПРОШЕЛ? ---
                if (!hedgeActionExecuted && hedgeExFound && !ALLOW_UNHEDGED_CLOSE) {
                    localLogs.push(`⛔️ <b>SKIPPED Main Close ${pos.coin}</b>: Hedge failed, safe mode ON.`);
                    return localLogs;
                }

                // Закрытие основы
                try {
                    const mainRes = await Helpers.executeTrade(
                        exchangeName,
                        pos.coin,
                        closeSide,
                        cleanReduceQty,
                        this.services
                    );

                    if (mainRes.success) {
                        const hedgeInfo = hedgeExFound
                            ? `${hedgeExFound.charAt(0)} (${hedgeActionExecuted ? '✅' : '❌'})`
                            : 'NO HEDGE ⚠️';

                        const exCodeMain = exchangeName.charAt(0);
                        localLogs.push(`✂️ <b>${pos.coin} ${exCodeMain}-${hedgeInfo}</b>: ${cleanReduceQty}`);
                    } else {
                        localLogs.push(`❌ Main Close Fail ${exchangeName} ${pos.coin}: ${mainRes.error}`);
                    }

                } catch (e: any) {
                    localLogs.push(`❌ Main Exc Error: ${e.message}`);
                }

                return localLogs;
            });

            // --- ЗАПУСК С КОНТРОЛЕМ ПАРАЛЛЕЛЬНОСТИ ---

            // Для L2 бирж (Nonce problem) используем последовательное выполнение (concurrency = 1)
            // Для CEX (Binance, HL) можно быстрее (concurrency = 3-5)

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