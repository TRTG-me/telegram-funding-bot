import axios from 'axios';
import { BinanceTickerService } from '../binance/websocket/binance.ticker.service';
import { HyperliquidTickerService } from '../hyperliquid/websocket/hyperliquid.ticker.service';
import { ParadexTickerService } from '../paradex/websocket/paradex.ticker.service';
import { ExtendedTickerService } from '../extended/websocket/extended.ticker.service';
import { LighterTickerService } from '../lighter/websocket/lighter.ticker.service';

export type ExchangeName = 'Binance' | 'Hyperliquid' | 'Paradex' | 'Extended' | 'Lighter';
type PriceUpdateCallback = (bpValue: number | null) => void;

// Определяем общий тип для всех наших тикер-сервисов
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

    // Храним ссылки на активные в данный момент сервисы
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
        const upperCoin = coin.toUpperCase();
        switch (exchange) {
            case 'Binance': return `${upperCoin}USDT`;
            case 'Extended': return `${upperCoin}-USD`;
            case 'Paradex': return `${upperCoin}-USD-PERP`;
            case 'Hyperliquid': return upperCoin;
            case 'Lighter':
                try {
                    const response = await axios.get('https://mainnet.zklighter.elliot.ai/api/v1/orderBooks');
                    const market = response.data.order_books.find((book: any) => book.symbol === upperCoin);
                    if (market) return market.market_id.toString();
                    throw new Error(`Market ${upperCoin} not found on Lighter.`);
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
        this.stop(); // Гарантируем чистый старт

        try {
            const longSymbol = await this.formatSymbolFor(longExchange, coin);
            const shortSymbol = await this.formatSymbolFor(shortExchange, coin);

            this.activeLongService = this.getServiceFor(longExchange);
            this.activeShortService = this.getServiceFor(shortExchange);

            console.log('Attempting to start both WebSocket connections...');
            // Запускаем оба подключения параллельно и ждем, пока ОБА не завершатся успешно.
            // Если хотя бы один выдаст ошибку, Promise.all немедленно прервется и перейдет в catch.
            await Promise.all([
                this.activeLongService.start(longSymbol, (_, ask: string) => { this.latestLongAsk = parseFloat(ask); }),
                this.activeShortService.start(shortSymbol, (bid: string, _) => { this.latestShortBid = parseFloat(bid); })
            ]);
            console.log('Both WebSocket connections established successfully.');

            // Запускаем цикл расчетов только после успешного подключения
            this.calculationInterval = setInterval(() => {
                if (this.latestLongAsk !== null && this.latestShortBid !== null) {
                    const bp = ((this.latestShortBid - this.latestLongAsk) / this.latestShortBid) * 10000;
                    callback(bp);
                } else {
                    callback(null);
                }
            }, 500);

        } catch (error) {
            console.error('Failed to start BP calculation due to a connection error:', error);
            // Если что-то пошло не так, останавливаем все, что могло запуститься
            this.stop();
            // Пробрасываем ошибку выше, чтобы контроллер мог ее поймать и уведомить пользователя
            throw error;
        }
    }

    public stop(): void {
        if (this.calculationInterval) {
            clearInterval(this.calculationInterval);
            this.calculationInterval = null;
        }

        // Останавливаем только те сервисы, которые были активны
        if (this.activeLongService) this.activeLongService.stop();
        if (this.activeShortService) this.activeShortService.stop();

        // Сбрасываем состояние
        this.activeLongService = null;
        this.activeShortService = null;
        this.latestLongAsk = null;
        this.latestShortBid = null;
        console.log('BP calculation stopped and active ticker services halted.');
    }
}