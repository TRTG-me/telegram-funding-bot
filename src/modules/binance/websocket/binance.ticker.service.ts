import {
    DerivativesTradingUsdsFutures,
    DERIVATIVES_TRADING_USDS_FUTURES_WS_STREAMS_PROD_URL
} from '@binance/derivatives-trading-usds-futures';

// Определяем тип для callback-функции
type PriceUpdateCallback = (bid: string, ask: string) => void;

export class BinanceTickerService {
    private client: DerivativesTradingUsdsFutures;
    private connection: any = null;

    // Храним активный символ для фильтрации "чужих" пакетов
    private activeSymbol: string | null = null;

    constructor() {
        this.client = new DerivativesTradingUsdsFutures({
            configurationWebsocketStreams: {
                wsURL: process.env.WS_STREAMS_URL ?? DERIVATIVES_TRADING_USDS_FUTURES_WS_STREAMS_PROD_URL,
            },
        });
    }

    /**
     * Запускает WebSocket-поток и возвращает Promise
     */
    public start(symbol: string, callback: PriceUpdateCallback): Promise<void> {
        // 1. Запоминаем текущий активный символ (в верхнем регистре, т.к. Binance шлет так)
        this.activeSymbol = symbol.toUpperCase();

        return new Promise(async (resolve, reject) => {
            if (this.connection) {
                console.warn('Binance WebSocket connection is already active.');
                // Даже если соединение активно, мы обновили activeSymbol выше,
                // поэтому фильтр начнет пропускать только новую монету (если подписка обновилась).
                resolve();
                return;
            }

            try {
                console.log(`Attempting to connect to Binance WebSocket for ${symbol}...`);
                this.connection = await this.client.websocketStreams.connect();
                console.log('Binance WebSocket connection established.');

                const stream = this.connection.partialBookDepthStreams({
                    symbol: symbol.toLowerCase(),
                    levels: 5,
                    updateSpeed: '100ms',
                });

                stream.on('message', (data: any) => {
                    // === ФИЛЬТРАЦИЯ (Race Condition Fix) ===
                    // Binance в поле 's' присылает символ (например "BTCUSDT").
                    // Если пришел пакет не для той монеты, которую мы сейчас ждем — игнорируем.
                    if (data.s && data.s.toUpperCase() !== this.activeSymbol) {
                        return;
                    }

                    if (data && data.b && data.b.length > 0 && data.a && data.a.length > 0) {
                        const bestBid = data.b[0][0];
                        const bestAsk = data.a[0][0];
                        callback(bestBid, bestAsk);
                    }
                });

                this.connection.on('close', (code: number) => {
                    // Сбрасываем активный символ при разрыве
                    this.activeSymbol = null;

                    if (code !== 1000) {
                        console.error(`Binance WebSocket disconnected unexpectedly with code: ${code}`);
                        this.connection = null;
                        reject(new Error(`Binance disconnected unexpectedly with code: ${code}`));
                    }
                });

                console.log(`Subscribed to partial book depth stream for ${symbol}.`);
                resolve();

            } catch (error) {
                console.error('Failed to start Binance WebSocket stream:', error);
                this.connection = null;
                this.activeSymbol = null;
                reject(error);
            }
        });
    }

    /**
     * Останавливает и отключает WebSocket-поток.
     */
    public async stop(): Promise<void> {
        // Сбрасываем символ, чтобы даже если прилетят остаточные пакеты, они не прошли фильтр
        this.activeSymbol = null;

        if (this.connection && typeof this.connection.disconnect === 'function') {
            console.log('Disconnecting from Binance WebSocket...');
            try {
                await this.connection.disconnect(1000);
                console.log('Binance WebSocket disconnected successfully.');
            } catch (error) {
                console.error('Error during Binance WebSocket disconnection:', error);
            } finally {
                this.connection = null;
            }
        }
    }
}