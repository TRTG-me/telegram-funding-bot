import { Logger } from '@nestjs/common';
import { BinanceTickerService } from '../binance/websocket/binance.ticker.service';
import { HyperliquidTickerService } from '../hyperliquid/websocket/hyperliquid.ticker.service';
import { ParadexTickerService } from '../paradex/websocket/paradex.ticker.service';
import { ExtendedTickerService } from '../extended/websocket/extended.ticker.service';
import { LighterTickerService } from '../lighter/websocket/lighter.ticker.service';
import { LighterService } from '../lighter/lighter.service';
import { FundingApiService } from '../funding_api/funding_api.service';
import * as Helpers from '../auto_trade/auto_trade.helpers';
import { ExchangeName } from '../bp/bp.types';
import { PayBackResult } from './payback.types';

type TickerInstance =
    | BinanceTickerService
    | HyperliquidTickerService
    | ParadexTickerService
    | ExtendedTickerService
    | LighterTickerService;

const COMMISSIONS: Record<ExchangeName, number> = {
    'Paradex': 0,
    'Hyperliquid': 4.32,
    'Binance': 4.5,
    'Lighter': 2,
    'Extended': 2.25
};

export class PayBackSession {
    private readonly logger = new Logger(PayBackSession.name);

    private activeLongService: TickerInstance | null = null;
    private activeShortService: TickerInstance | null = null;

    private latestLongAsk: number | null = null;
    private latestShortBid: number | null = null;

    private bpSamples: number[] = [];
    private calculationInterval: NodeJS.Timeout | null = null;
    private timerTimeout: NodeJS.Timeout | null = null;
    private isStopping = false;

    constructor(
        public readonly userId: number,
        private readonly lighterDataService: LighterService,
        private readonly fundingApiService: FundingApiService
    ) { }

    private createTickerInstance(exchange: ExchangeName): TickerInstance {
        switch (exchange) {
            case 'Binance': return new BinanceTickerService();
            case 'Hyperliquid': return new HyperliquidTickerService();
            case 'Paradex': return new ParadexTickerService();
            case 'Extended': return new ExtendedTickerService();
            case 'Lighter': return new LighterTickerService();
            default: throw new Error(`Unknown exchange ${exchange}`);
        }
    }

    private async formatSymbolFor(exchange: ExchangeName, coin: string): Promise<string> {
        if (exchange === 'Lighter') {
            const symbol = Helpers.getUnifiedSymbol(exchange, coin, true);
            const id = await this.lighterDataService.getMarketId(symbol, this.userId);
            if (id !== null) return id.toString();
            throw new Error(`Market ${symbol} not found on Lighter.`);
        }
        return Helpers.getUnifiedSymbol(exchange, coin);
    }

    public async start(
        coin: string,
        longExchange: ExchangeName,
        shortExchange: ExchangeName,
        onFinished: (result: PayBackResult | null) => void
    ): Promise<void> {
        this.isStopping = false;

        try {
            const [longSymbol, shortSymbol] = await Promise.all([
                this.formatSymbolFor(longExchange, coin),
                this.formatSymbolFor(shortExchange, coin)
            ]);

            if (this.isStopping) return;

            this.activeLongService = this.createTickerInstance(longExchange);
            this.activeShortService = this.createTickerInstance(shortExchange);

            this.logger.log(`[User ${this.userId}] Starting Payback Test: ${coin} ${longExchange} vs ${shortExchange}`);

            const startSafe = async (service: TickerInstance, symbol: string, isLong: boolean) => {
                try {
                    await service.start(symbol, (bid: string, ask: string) => {
                        if (isLong) this.latestLongAsk = parseFloat(ask);
                        else this.latestShortBid = parseFloat(bid);
                    });
                } catch (e) {
                    throw e;
                } finally {
                    if (this.isStopping) service.stop();
                }
            };

            await Promise.all([
                startSafe(this.activeLongService, longSymbol, true),
                startSafe(this.activeShortService, shortSymbol, false)
            ]);

            if (this.isStopping) {
                this.stop();
                return;
            }

            // Record BP every 1s
            this.calculationInterval = setInterval(() => {
                if (this.isStopping || !this.activeLongService || !this.activeShortService) return;
                if (this.latestLongAsk && this.latestShortBid && this.latestLongAsk > 0 && this.latestShortBid > 0) {
                    const bp = ((this.latestShortBid - this.latestLongAsk) / this.latestShortBid) * 10000;
                    this.bpSamples.push(bp);
                }
            }, 1000);

            // Finish after 60s
            this.timerTimeout = setTimeout(async () => {
                if (this.isStopping) return;

                const count = this.bpSamples.length;
                if (count < 5) {
                    onFinished(null);
                } else {
                    const sum = this.bpSamples.reduce((a, b) => a + b, 0);
                    const averageBp = sum / count;

                    try {
                        const fundingInfo = await this.fundingApiService.getCoinAnalysis(coin, [longExchange, shortExchange]);
                        const comp = fundingInfo.comparisons.find(c =>
                            c.pair.includes(longExchange) && c.pair.includes(shortExchange)
                        );

                        let apr1d = 0;
                        let apr3d = 0;

                        if (comp) {
                            const isLongEx1 = comp.pair.startsWith(longExchange);
                            const res1d = comp.results.find(r => r.period === '1d');
                            const res3d = comp.results.find(r => r.period === '3d');

                            if (res1d) apr1d = isLongEx1 ? -res1d.diff : res1d.diff;
                            if (res3d) apr3d = isLongEx1 ? -res3d.diff : res3d.diff;
                        }

                        const totalCostBp = (COMMISSIONS[longExchange] || 0) + (COMMISSIONS[shortExchange] || 0) - averageBp;
                        const minApr = Math.min(apr1d, apr3d);
                        const dailyReturnBp = minApr / 3.65;
                        let paybackDays = dailyReturnBp > 0 ? totalCostBp / dailyReturnBp : 999;
                        if (totalCostBp <= 0 && dailyReturnBp > 0) paybackDays = 0;

                        onFinished({
                            coin,
                            longExchange,
                            shortExchange,
                            averageBp,
                            sampleCount: count,
                            totalCostBp,
                            dailyReturnBp,
                            paybackDays,
                            apr1d,
                            apr3d
                        });
                    } catch (err) {
                        this.logger.error(`Failed to fetch funding for payback calculation: ${err}`);
                        onFinished({
                            coin, longExchange, shortExchange, averageBp,
                            sampleCount: count, totalCostBp: 0, dailyReturnBp: 0, paybackDays: 0, apr1d: 0, apr3d: 0
                        });
                    }
                }
                this.stop();
            }, 60000);

        } catch (error: any) {
            this.logger.error(`[User ${this.userId}] Payback Session Error: ${error.message}`);
            this.stop();
            throw error;
        }
    }

    public stop() {
        if (this.isStopping) return;
        this.isStopping = true;

        if (this.calculationInterval) {
            clearInterval(this.calculationInterval);
            this.calculationInterval = null;
        }
        if (this.timerTimeout) {
            clearTimeout(this.timerTimeout);
            this.timerTimeout = null;
        }

        try {
            if (this.activeLongService) this.activeLongService.stop();
            if (this.activeShortService) this.activeShortService.stop();
        } catch (e) { }

        this.activeLongService = null;
        this.activeShortService = null;
        this.latestLongAsk = null;
        this.latestShortBid = null;
    }
}
