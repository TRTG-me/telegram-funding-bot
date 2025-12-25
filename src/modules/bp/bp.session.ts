import { Logger } from '@nestjs/common';
import { BinanceTickerService } from '../binance/websocket/binance.ticker.service';
import { HyperliquidTickerService } from '../hyperliquid/websocket/hyperliquid.ticker.service';
import { ParadexTickerService } from '../paradex/websocket/paradex.ticker.service';
import { ExtendedTickerService } from '../extended/websocket/extended.ticker.service';
import { LighterTickerService } from '../lighter/websocket/lighter.ticker.service';
import { LighterService } from '../lighter/lighter.service';
import * as Helpers from '../auto_trade/auto_trade.helpers';
// ИЗМЕНЕНИЕ ЗДЕСЬ: Импорт из bp.types
import { ExchangeName, BpCalculationData } from './bp.types';

type PriceUpdateCallback = (data: BpCalculationData | null) => void;

type TickerInstance =
    | BinanceTickerService
    | HyperliquidTickerService
    | ParadexTickerService
    | ExtendedTickerService
    | LighterTickerService;

export class BpSession {
    private readonly logger = new Logger(BpSession.name);

    private activeLongService: TickerInstance | null = null;
    private activeShortService: TickerInstance | null = null;

    private latestLongAsk: number | null = null;
    private latestShortBid: number | null = null;
    private lastPriceUpdate: number = Date.now(); // H1 Fix

    private calculationInterval: NodeJS.Timeout | null = null;
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
        callback: PriceUpdateCallback
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

            this.logger.log(`[User ${this.userId}] Starting BP: ${longExchange} vs ${shortExchange}`);

            const startSafe = async (service: TickerInstance, symbol: string, isLong: boolean) => {
                try {
                    await service.start(symbol, (bid: string, ask: string) => {
                        this.lastPriceUpdate = Date.now(); // H1 Fix
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

            this.calculationInterval = setInterval(() => {
                if (this.isStopping) return;

                // H1: Проверка на зависание вебсокета
                if (Date.now() - this.lastPriceUpdate > 30000) {
                    this.logger.error(`[User ${this.userId}] BP Session Timeout: No price updates for 30s.`);
                    this.stop();
                    // Мы не можем бросить ошибку из интервала, чтобы поймал вызывающий.
                    // Но мы можем вызвать callback с null и остановить.
                    callback(null);
                    return;
                }

                if (this.latestLongAsk && this.latestShortBid && this.latestLongAsk > 0 && this.latestShortBid > 0) {
                    const bp = ((this.latestShortBid - this.latestLongAsk) / this.latestShortBid) * 10000;
                    callback({
                        longPrice: this.latestLongAsk,
                        shortPrice: this.latestShortBid,
                        bpValue: bp
                    });
                } else {
                    callback(null);
                }
            }, 1000);

        } catch (error: any) {
            this.logger.error(`[User ${this.userId}] BP Error: ${error.message}`);
            this.stop();
            throw error;
        }
    }

    public stop() {
        this.isStopping = true;
        if (this.calculationInterval) {
            clearInterval(this.calculationInterval);
            this.calculationInterval = null;
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