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
    }

    /**
     * Запускает WebSocket-поток и возвращает Promise, который
     * разрешается при успехе или отклоняется при ошибке.
     */
    public start(symbol: string, callback: PriceUpdateCallback): Promise<void> {
        // --- ГЛАВНОЕ ИЗМЕНЕНИЕ: Оборачиваем всю логику в Promise ---
        return new Promise(async (resolve, reject) => {
            if (this.connection) {
                console.warn('Binance WebSocket connection is already active.');
                resolve(); // Если уже подключено, считаем это успехом.
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
                    if (data && data.b && data.b.length > 0 && data.a && data.a.length > 0) {
                        const bestBid = data.b[0][0];
                        const bestAsk = data.a[0][0];
                        callback(bestBid, bestAsk);
                    }
                });

                // Добавляем обработчик неожиданного закрытия для надежности
                this.connection.on('close', (code: number) => {
                    if (code !== 1000) { // 1000 - это нормальное закрытие через .stop()
                        console.error(`Binance WebSocket disconnected unexpectedly with code: ${code}`);
                        this.connection = null;
                        // Отклоняем Promise, если соединение было прервано
                        reject(new Error(`Binance disconnected unexpectedly with code: ${code}`));
                    }
                });

                console.log(`Subscribed to partial book depth stream for ${symbol}.`);
                // --- СООБЩАЕМ ОБ УСПЕХЕ ---
                // Promise разрешается после успешного подключения и подписки.
                resolve();

            } catch (error) {
                console.error('Failed to start Binance WebSocket stream:', error);
                this.connection = null;
                // --- СООБЩАЕМ О ПРОВАЛЕ ---
                // Promise отклоняется, если произошла ошибка при подключении.
                reject(error);
            }
        });
    }

    /**
     * Останавливает и отключает WebSocket-поток.
     */
    public async stop(): Promise<void> {
        if (this.connection && typeof this.connection.disconnect === 'function') {
            console.log('Disconnecting from Binance WebSocket...');
            try {
                // Устанавливаем код 1000 для нормального закрытия
                await this.connection.disconnect(1000);
                console.log('Binance WebSocket disconnected successfully.');
            } catch (error) {
                console.error('Error during Binance WebSocket disconnection:', error);
            } finally {
                this.connection = null;
            }
        } else {
            // Убираем вывод в консоль, чтобы не было спама, если сервис не был активен
            // console.warn('Attempted to stop a non-existent Binance WebSocket connection.');
        }
    }
}