import { Logger } from '@nestjs/common';
import { BinanceTickerService } from '../binance/websocket/binance.ticker.service';
import { HyperliquidTickerService } from '../hyperliquid/websocket/hyperliquid.ticker.service';
import { ParadexTickerService } from '../paradex/websocket/paradex.ticker.service';
import { ExtendedTickerService } from '../extended/websocket/extended.ticker.service';
import { LighterTickerService } from '../lighter/websocket/lighter.ticker.service';
import { LighterService } from '../lighter/lighter.service';
import * as Helpers from '../auto_trade/auto_trade.helpers';
import { ExchangeName } from '../bp/bp.types';
import { TestBpResult } from './test_bp.types';

type TickerInstance =
    | BinanceTickerService
    | HyperliquidTickerService
    | ParadexTickerService
    | ExtendedTickerService
    | LighterTickerService;

export class TestBpSession {
    private readonly logger = new Logger(TestBpSession.name);

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
        private readonly lighterDataService: LighterService
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
            const id = this.lighterDataService.getMarketId(symbol);
            if (id !== null) return id.toString();
            throw new Error(`Market ${symbol} not found on Lighter.`);
        }
        return Helpers.getUnifiedSymbol(exchange, coin);
    }

    public async start(
        coin: string,
        longExchange: ExchangeName,
        shortExchange: ExchangeName,
        onFinished: (result: TestBpResult | null) => void
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

            this.logger.log(`[User ${this.userId}] Starting Test BP: ${coin} ${longExchange} vs ${shortExchange}`);

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
            this.timerTimeout = setTimeout(() => {
                if (this.isStopping) return;

                const count = this.bpSamples.length;
                if (count < 5) { // Minimum samples to consider it valid
                    onFinished(null);
                } else {
                    const sum = this.bpSamples.reduce((a, b) => a + b, 0);
                    onFinished({
                        coin,
                        longExchange,
                        shortExchange,
                        averageBp: sum / count,
                        sampleCount: count
                    });
                }
                this.stop();
            }, 60000);

        } catch (error: any) {
            this.logger.error(`[User ${this.userId}] Test BP Error: ${error.message}`);
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
        } catch (e) { console.error(e); }

        this.activeLongService = null;
        this.activeShortService = null;
        this.latestLongAsk = null;
        this.latestShortBid = null;
    }
}
