import { Injectable, Logger } from '@nestjs/common'; // Добавил Logger
import axios from 'axios';
import { BinanceTickerService } from '../binance/websocket/binance.ticker.service';
import { HyperliquidTickerService } from '../hyperliquid/websocket/hyperliquid.ticker.service';
import { ParadexTickerService } from '../paradex/websocket/paradex.ticker.service';
import { ExtendedTickerService } from '../extended/websocket/extended.ticker.service';
import { LighterTickerService } from '../lighter/websocket/lighter.ticker.service';
// Добавляем сервис для правильного поиска ID
import { LighterService } from '../lighter/lighter.service';

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

@Injectable() // Важно для NestJS
export class BpService {
    private readonly logger = new Logger(BpService.name);

    private latestLongAsk: number | null = null;
    private latestShortBid: number | null = null;
    private calculationInterval: NodeJS.Timeout | null = null;

    private activeLongService: TickerService | null = null;
    private activeShortService: TickerService | null = null;

    // Флаг для защиты от Race Condition
    private isStopping = false;

    constructor(
        private binanceService: BinanceTickerService,
        private hyperliquidService: HyperliquidTickerService,
        private paradexService: ParadexTickerService,
        private extendedService: ExtendedTickerService,
        private lighterTickerService: LighterTickerService,
        private lighterDataService: LighterService, // <--- ИНЖЕКЦИЯ
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
        let finalCoinSymbol: string;
        const lowerCoin = coin.toLowerCase();

        if (lowerCoin === 'kbonk' || lowerCoin === '1000bonk') {
            if (exchange === 'Binance' || exchange === 'Lighter') {
                finalCoinSymbol = '1000BONK';
            } else {
                finalCoinSymbol = 'kBONK';
            }
        } else if (lowerCoin === 'xyz100' || lowerCoin === 'tech100m') {
            if (exchange === 'Extended') finalCoinSymbol = 'TECH100M';
            else if (exchange === 'Hyperliquid') finalCoinSymbol = 'XYZ100';
            else finalCoinSymbol = 'TECH100m';
        } else {
            finalCoinSymbol = coin.toUpperCase();
        }

        switch (exchange) {
            case 'Binance': return `${finalCoinSymbol}USDT`;
            case 'Extended': return `${finalCoinSymbol}-USD`;
            case 'Paradex': return `${finalCoinSymbol}-USD-PERP`;
            case 'Hyperliquid': return finalCoinSymbol;
            case 'Lighter':
                // Используем надежный метод из сервиса (он уже фильтрует перпы и кэширует)
                const id = this.lighterDataService.getMarketId(finalCoinSymbol);
                if (id !== null) return id.toString();
                throw new Error(`Market ${finalCoinSymbol} not found on Lighter.`);
        }
    }

    public async start(
        coin: string,
        longExchange: ExchangeName,
        shortExchange: ExchangeName,
        callback: PriceUpdateCallback
    ): Promise<void> {
        this.stop(); // Очистка перед стартом
        this.isStopping = false;

        try {
            // Форматируем символы (это асинхронно, может упасть)
            const [longSymbol, shortSymbol] = await Promise.all([
                this.formatSymbolFor(longExchange, coin),
                this.formatSymbolFor(shortExchange, coin)
            ]);

            // Если за время await пользователь нажал стоп - выходим
            if (this.isStopping) return;

            this.activeLongService = this.getServiceFor(longExchange);
            this.activeShortService = this.getServiceFor(shortExchange);

            this.logger.log(`Starting BP for ${coin}: ${longExchange} vs ${shortExchange}`);

            // Запускаем тикеры ПАРАЛЛЕЛЬНО, но с безопасным перехватом
            await Promise.all([
                this.activeLongService.start(longSymbol, (_, ask: string) => {
                    this.latestLongAsk = parseFloat(ask);
                }),
                this.activeShortService.start(shortSymbol, (bid: string, _) => {
                    this.latestShortBid = parseFloat(bid);
                })
            ]);

            // Еще одна проверка после await
            if (this.isStopping) {
                this.stop(); // Гарантированно закрываем, если успели открыться
                return;
            }

            console.log('BP Tickers connected.');

            this.calculationInterval = setInterval(() => {
                if (this.latestLongAsk !== null && this.latestShortBid !== null && this.latestLongAsk > 0 && this.latestShortBid > 0) {
                    const bp = ((this.latestShortBid - this.latestLongAsk) / this.latestShortBid) * 10000;
                    const data: BpCalculationData = {
                        longPrice: this.latestLongAsk,
                        shortPrice: this.latestShortBid,
                        bpValue: bp
                    };
                    callback(data);
                } else {
                    // Пока данных нет или они 0
                    callback(null);
                }
            }, 1000); // 1 сек интервал (безопаснее для callback)

        } catch (error: any) {
            this.logger.error(`Failed to start BP: ${error.message}`);
            this.stop();
            throw error; // Пробрасываем в контроллер для вывода юзеру
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
            if (this.activeShortService?.stop) this.activeShortService.stop();
        } catch (e) {
            console.error('Error closing sockets:', e);
        }

        this.activeLongService = null;
        this.activeShortService = null;
        this.latestLongAsk = null;
        this.latestShortBid = null;
        console.log('BP Service stopped.');
    }
}