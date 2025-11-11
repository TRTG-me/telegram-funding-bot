// ВАШИ РАБОЧИЕ ИМПОРТЫ ОСТАЮТСЯ БЕЗ ИЗМЕНЕНИЙ
import {
    DerivativesTradingUsdsFutures,
    DERIVATIVES_TRADING_USDS_FUTURES_WS_STREAMS_PROD_URL
} from '@binance/derivatives-trading-usds-futures';

// Определяем тип для callback-функции
type PriceUpdateCallback = (bid: string, ask: string) => void;

export class BinanceTickerService {
    private client: DerivativesTradingUsdsFutures;
    private connection: any = null; // Используем 'any' для объекта соединения

    constructor() {
        this.client = new DerivativesTradingUsdsFutures({
            configurationWebsocketStreams: {
                wsURL: process.env.WS_STREAMS_URL ?? DERIVATIVES_TRADING_USDS_FUTURES_WS_STREAMS_PROD_URL,
            },
        });
        console.log('BinanceTickerService initialized.');
    }

    /**
     * Запускает WebSocket-поток для отслеживания цен.
     */
    public async start(symbol: string, callback: PriceUpdateCallback): Promise<void> {
        if (this.connection) {
            console.warn('WebSocket connection is already active.');
            return;
        }

        try {
            console.log(`Attempting to connect to WebSocket for ${symbol}...`);
            this.connection = await this.client.websocketStreams.connect();
            console.log('WebSocket connection established.');

            const stream = this.connection.partialBookDepthStreams({
                symbol: symbol.toLowerCase(),
                levels: 5,
                updateSpeed: '100ms',
            });

            stream.on('message', (data: any) => {
                if (data && data.b && data.b.length > 0 && data.a && data.a.length > 0) {
                    const bestBid = data.b[0][0];
                    const bestAsk = data.a[0][0];
                    callback(bestBid, bestAsk);
                }
            });

            console.log(`Subscribed to partial book depth stream for ${symbol}.`);

        } catch (error) {
            console.error('Failed to start WebSocket stream:', error);
            this.connection = null;
        }
    }

    /**
     * Останавливает и отключает WebSocket-поток.
     */
    public async stop(): Promise<void> {
        if (this.connection && typeof this.connection.disconnect === 'function') {
            console.log('Disconnecting WebSocket...');
            try {
                await this.connection.disconnect();
                console.log('WebSocket disconnected successfully.');
            } catch (error) {
                console.error('Error during WebSocket disconnection:', error);
            } finally {
                this.connection = null;
            }
        } else {
            console.warn('Attempted to stop a non-existent or invalid WebSocket connection.');
        }
    }
}