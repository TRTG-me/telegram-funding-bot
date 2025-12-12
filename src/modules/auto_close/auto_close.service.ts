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

const TRIGGER_LEVERAGE = 4.2;
const TARGET_LEVERAGE = 3.7;

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

    public async checkAndReduceRisk(): Promise<string[]> {
        const logs: string[] = [];

        const exchangeServices: Record<ExchangeName, any> = {
            'Binance': this.binanceService,
            'Hyperliquid': this.hyperliquidService,
            'Paradex': this.paradexService,
            'Lighter': this.lighterService,
            'Extended': this.extendedService
        };

        const promises = Object.entries(exchangeServices).map(async ([name, service]) => {
            try {
                const data = await service.calculateLeverage();
                return { name: name as ExchangeName, ...data };
            } catch (e) {
                return { name: name as ExchangeName, leverage: 0, accountEquity: 0, P_MM_keff: 0 };
            }
        });

        const results = await Promise.all(promises);

        const dangerExchanges = results
            .filter(r => r.leverage >= TRIGGER_LEVERAGE)
            .sort((a, b) => b.leverage - a.leverage);

        if (dangerExchanges.length === 0) {
            return ['✅ Все биржи в безопасности (Leverage &lt; 5)'];
        }

        // Обрабатываем опасные биржи (тут можно тоже параллельно, но лучше последовательно по биржам)
        for (const dangerEx of dangerExchanges) {
            logs.push(`🚨 <b>ALARM: ${dangerEx.name} Leverage: ${dangerEx.leverage.toFixed(2)}</b>`);

            const L1 = dangerEx.leverage;
            const L2 = TARGET_LEVERAGE;
            const K = dangerEx.P_MM_keff || 0;

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

            // Получаем хеджи параллельно
            const otherExchanges = Object.keys(allServices).filter(k => k !== exchangeName) as ExchangeName[];
            const allHedgePositions: Record<string, IDetailedPosition[]> = {};

            await Promise.all(otherExchanges.map(async (exName) => {
                try {
                    allHedgePositions[exName] = await allServices[exName].getDetailedPositions();
                } catch (e) {
                    allHedgePositions[exName] = [];
                }
            }));

            // =======================================================
            // 🔥 ПАРАЛЛЕЛЬНОЕ ВЫПОЛНЕНИЕ (Promise.all)
            // =======================================================
            const tasks = positions.map(async (pos) => {
                const localLogs: string[] = []; // Логи для конкретной пары

                const rawReduceQty = pos.size * alpha;
                const cleanReduceQty = this.calculateSafeQuantity(rawReduceQty);

                if (cleanReduceQty <= 0) return []; // Возвращаем пустой лог

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

                // Закрытие основы (Параллельно с другими парами, но после хеджа)
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

            // Ждем выполнения ВСЕХ задач одновременно
            const results = await Promise.all(tasks);

            // Объединяем массивы логов в один плоский список
            return results.flat();

        } catch (e: any) {
            return [`🔥 Global Error reducing ${exchangeName}: ${e.message}`];
        }
    }
}