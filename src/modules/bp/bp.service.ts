import axios from 'axios';
import { BinanceTickerService } from '../binance/websocket/binance.ticker.service';
import { HyperliquidTickerService } from '../hyperliquid/websocket/hyperliquid.ticker.service';
import { ParadexTickerService } from '../paradex/websocket/paradex.ticker.service';
import { ExtendedTickerService } from '../extended/websocket/extended.ticker.service';
import { LighterTickerService } from '../lighter/websocket/lighter.ticker.service';

export type ExchangeName = 'Binance' | 'Hyperliquid' | 'Paradex' | 'Extended' | 'Lighter';

// Интерфейс для структурированной передачи данных в контроллер
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

export class BpService {
    private latestLongAsk: number | null = null;
    private latestShortBid: number | null = null;
    private calculationInterval: NodeJS.Timeout | null = null;
    private activeLongService: TickerService | null = null;
    private activeShortService: TickerService | null = null;

    constructor(
        private binanceService: BinanceTickerService,
        private hyperliquidService: HyperliquidTickerService,
        private paradexService: ParadexTickerService,
        private extendedService: ExtendedTickerService,
        private lighterService: LighterTickerService,
    ) { }

    private getServiceFor(exchange: ExchangeName): TickerService {
        switch (exchange) {
            case 'Binance': return this.binanceService;
            case 'Hyperliquid': return this.hyperliquidService;
            case 'Paradex': return this.paradexService;
            case 'Extended': return this.extendedService;
            case 'Lighter': return this.lighterService;
        }
    }

    private async formatSymbolFor(exchange: ExchangeName, coin: string): Promise<string> {
        let finalCoinSymbol: string;
        const lowerCoin = coin.toLowerCase();

        if (lowerCoin === 'kbonk') {
            if (exchange === 'Binance' || exchange === 'Lighter') {
                finalCoinSymbol = '1000BONK';
            } else {
                finalCoinSymbol = 'kBONK';
            }
        } else {
            finalCoinSymbol = coin.toUpperCase();
        }

        switch (exchange) {
            case 'Binance': return `${finalCoinSymbol}USDT`;
            case 'Extended': return `${finalCoinSymbol}-USD`;
            case 'Paradex': return `${finalCoinSymbol}-USD-PERP`;
            case 'Hyperliquid': return finalCoinSymbol;
            case 'Lighter':
                try {
                    const response = await axios.get('https://mainnet.zklighter.elliot.ai/api/v1/orderBooks');
                    const market = response.data.order_books.find((book: any) => book.symbol === finalCoinSymbol);
                    if (market) return market.market_id.toString();
                    throw new Error(`Market ${finalCoinSymbol} not found on Lighter.`);
                } catch (error) {
                    console.error('Failed to get Lighter market_id:', error);
                    throw error;
                }
        }
    }

    public async start(
        coin: string,
        longExchange: ExchangeName,
        shortExchange: ExchangeName,
        callback: PriceUpdateCallback
    ): Promise<void> {
        this.stop();

        try {
            const longSymbol = await this.formatSymbolFor(longExchange, coin);
            const shortSymbol = await this.formatSymbolFor(shortExchange, coin);

            this.activeLongService = this.getServiceFor(longExchange);
            this.activeShortService = this.getServiceFor(shortExchange);

            console.log('Attempting to start both WebSocket connections...');

            const longPromise = this.activeLongService.start(longSymbol, (_, ask: string) => { this.latestLongAsk = parseFloat(ask); })
                .catch((error: Error) => { throw new Error(`[Биржа ${longExchange}] ${error.message}`); });

            const shortPromise = this.activeShortService.start(shortSymbol, (bid: string, _) => { this.latestShortBid = parseFloat(bid); })
                .catch((error: Error) => { throw new Error(`[Биржа ${shortExchange}] ${error.message}`); });

            await Promise.all([longPromise, shortPromise]);

            console.log('Both WebSocket connections established successfully.');

            this.calculationInterval = setInterval(() => {
                if (this.latestLongAsk !== null && this.latestShortBid !== null) {
                    const bp = ((this.latestShortBid - this.latestLongAsk) / this.latestShortBid) * 10000;
                    const data: BpCalculationData = {
                        longPrice: this.latestLongAsk,
                        shortPrice: this.latestShortBid,
                        bpValue: bp
                    };
                    callback(data);
                } else {
                    callback(null);
                }
            }, 500);

        } catch (error) {
            console.error('Failed to start BP calculation due to a connection error:', error);
            this.stop();
            throw error;
        }
    }

    public stop(): void {
        if (this.calculationInterval) {
            clearInterval(this.calculationInterval);
            this.calculationInterval = null;
        }

        if (this.activeLongService) this.activeLongService.stop();
        if (this.activeShortService) this.activeShortService.stop();

        this.activeLongService = null;
        this.activeShortService = null;
        this.latestLongAsk = null;
        this.latestShortBid = null;
        console.log('BP calculation stopped and active ticker services halted.');
    }
}