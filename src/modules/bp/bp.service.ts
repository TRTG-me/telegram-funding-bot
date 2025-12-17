import { Injectable, Logger } from '@nestjs/common';
import { BinanceTickerService } from '../binance/websocket/binance.ticker.service';
import { HyperliquidTickerService } from '../hyperliquid/websocket/hyperliquid.ticker.service';
import { ParadexTickerService } from '../paradex/websocket/paradex.ticker.service';
import { ExtendedTickerService } from '../extended/websocket/extended.ticker.service';
import { LighterTickerService } from '../lighter/websocket/lighter.ticker.service';
import { LighterService } from '../lighter/lighter.service';
// Импортируем наш новый хелпер
import * as Helpers from '../auto_trade/auto_trade.helpers';

export type ExchangeName = 'Binance' | 'Hyperliquid' | 'Paradex' | 'Extended' | 'Lighter';

export interface BpCalculationData {
    longPrice: number;
    shortPrice: number;
    bpValue: number;
}
type PriceUpdateCallback = (data: BpCalculationData | null) => void;

type TickerService =
    | BinanceTickerService
    | HyperliquidTickerService
    | ParadexTickerService
    | ExtendedTickerService
    | LighterTickerService;

@Injectable()
export class BpService {
    private readonly logger = new Logger(BpService.name);

    private latestLongAsk: number | null = null;
    private latestShortBid: number | null = null;
    private calculationInterval: NodeJS.Timeout | null = null;

    private activeLongService: TickerService | null = null;
    private activeShortService: TickerService | null = null;

    private isStopping = false;

    constructor(
        private binanceService: BinanceTickerService,
        private hyperliquidService: HyperliquidTickerService,
        private paradexService: ParadexTickerService,
        private extendedService: ExtendedTickerService,
        private lighterTickerService: LighterTickerService,
        private lighterDataService: LighterService,
    ) { }

    private getServiceFor(exchange: ExchangeName): TickerService {
        switch (exchange) {
            case 'Binance': return this.binanceService;
            case 'Hyperliquid': return this.hyperliquidService;
            case 'Paradex': return this.paradexService;
            case 'Extended': return this.extendedService;
            case 'Lighter': return this.lighterTickerService;
        }
    }

    private async formatSymbolFor(exchange: ExchangeName, coin: string): Promise<string> {
        // Lighter требует особого подхода: нужно найти ID по тикеру
        if (exchange === 'Lighter') {
            // true = получаем "чистый" тикер (например 1000BONK) без суффиксов
            const symbol = Helpers.getUnifiedSymbol(exchange, coin, true);

            // Ищем ID в кэше LighterService
            const id = this.lighterDataService.getMarketId(symbol);
            if (id !== null) return id.toString();

            throw new Error(`Market ${symbol} not found on Lighter.`);
        }

        // Для остальных бирж просто используем хелпер
        return Helpers.getUnifiedSymbol(exchange, coin);
    }

    public async start(
        coin: string,
        longExchange: ExchangeName,
        shortExchange: ExchangeName,
        callback: PriceUpdateCallback
    ): Promise<void> {
        this.stop();
        this.isStopping = false;

        try {
            const [longSymbol, shortSymbol] = await Promise.all([
                this.formatSymbolFor(longExchange, coin),
                this.formatSymbolFor(shortExchange, coin)
            ]);

            if (this.isStopping) return;

            const longService = this.getServiceFor(longExchange);
            const shortService = this.getServiceFor(shortExchange);

            this.activeLongService = longService;
            this.activeShortService = shortService;

            this.logger.log(`Starting BP for ${coin}: ${longExchange} (${longSymbol}) vs ${shortExchange} (${shortSymbol})`);

            // Вспомогательная функция для безопасного старта
            const startSafe = async (service: TickerService, symbol: string, onTick: (b: string, a: string) => void) => {
                try {
                    await service.start(symbol, onTick);
                } catch (e) {
                    throw e; // Ошибку прокидываем, чтобы Promise.all упал
                } finally {
                    // Если пока мы подключались, кто-то нажал стоп (или упал соседний сокет),
                    // мы принудительно отключаем этот сервис
                    if (this.isStopping) {
                        console.log(`⚠️ Post-connect cleanup for ${symbol}`);
                        service.stop();
                    }
                }
            };

            // Запускаем параллельно
            await Promise.all([
                startSafe(longService, longSymbol, (_, ask: string) => {
                    this.latestLongAsk = parseFloat(ask);
                }),
                startSafe(shortService, shortSymbol, (bid: string, _) => {
                    this.latestShortBid = parseFloat(bid);
                })
            ]);

            if (this.isStopping) {
                this.stop();
                return;
            }

            console.log('✅ BP Tickers connected successfully.');

            this.calculationInterval = setInterval(() => {
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
            this.logger.error(`🔥 CRITICAL BP ERROR: ${error.message}`);
            this.stop();
            throw error;
        }
    }

    public stop(): void {
        this.isStopping = true;

        if (this.calculationInterval) {
            clearInterval(this.calculationInterval);
            this.calculationInterval = null;
        }

        try {
            if (this.activeLongService?.stop) this.activeLongService.stop();
        } catch (e) { console.error('Error closing Long socket:', e); }

        try {
            if (this.activeShortService?.stop) this.activeShortService.stop();
        } catch (e) { console.error('Error closing Short socket:', e); }

        this.activeLongService = null;
        this.activeShortService = null;
        this.latestLongAsk = null;
        this.latestShortBid = null;
        console.log('🛑 BP Service fully stopped.');
    }
}