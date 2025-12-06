import WebSocket from 'ws';

type PriceUpdateCallback = (bid: string, ask: string) => void;

export class ExtendedTickerService {
    private ws: WebSocket | null = null;

    constructor() {

    }

    /**
     * Запускает WebSocket-поток и возвращает Promise, который
     * разрешается при успехе или отклоняется при ошибке.
     */
    public start(symbol: string, callback: PriceUpdateCallback): Promise<void> {
        // --- ГЛАВНОЕ ИЗМЕНЕНИЕ: Оборачиваем всю логику в Promise ---
        return new Promise((resolve, reject) => {
            if (this.ws) {
                console.warn('Extended Exchange WebSocket connection is already active.');
                resolve(); // Если уже подключено, считаем это успехом.
                return;
            }

            const connectionUrl = `wss://api.starknet.extended.exchange/stream.extended.exchange/v1/orderbooks/${symbol.toUpperCase()}?depth=1`;
            const options = {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.36'
                }
            };

            console.log(`Attempting to connect to Extended Exchange at: ${connectionUrl}`);
            this.ws = new WebSocket(connectionUrl, options);
            const currentConnection = this.ws;

            currentConnection.on('open', () => {
                console.log(`Successfully connected to Extended Exchange WebSocket for ${symbol}. Waiting for data...`);
                // --- СООБЩАЕМ ОБ УСПЕХЕ ---
                // Promise разрешается после успешного открытия соединения.
                resolve();
            });

            currentConnection.on('error', (error) => {
                console.error('Extended Exchange WebSocket error:', error);
                this.ws = null;
                // --- СООБЩАЕМ О ПРОВАЛЕ ---
                // Promise отклоняется, если произошла ошибка.
                reject(error);
            });

            currentConnection.on('close', (code, reason) => {
                console.log(`Extended Exchange WebSocket disconnected: ${code} - ${reason.toString()}`);
                if (code !== 1000) { // 1000 - это нормальное закрытие через .stop()
                    // --- СООБЩАЕМ О ПРОВАЛЕ ---
                    // Отклоняем Promise, если соединение было прервано неожиданно.
                    reject(new Error(`Extended Exchange disconnected unexpectedly: ${code}`));
                }
                this.ws = null;
            });

            // Обработчик сообщений остается без изменений
            currentConnection.on('message', (data: WebSocket.Data) => {
                try {
                    const message = JSON.parse(data.toString());
                    if (message.type === 'SNAPSHOT' && message.data) {
                        const priceData = message.data;
                        if (priceData.b && priceData.b.length > 0 && priceData.a && priceData.a.length > 0) {
                            const bestBid = priceData.b[0].p;
                            const bestAsk = priceData.a[0].p;
                            if (bestBid && bestAsk) {
                                callback(bestBid, bestAsk);
                            }
                        }
                    }
                } catch (error) {
                    console.error('Error parsing Extended Exchange message:', error);
                }
            });
        });
    }

    public stop(): void {
        if (this.ws) {
            console.log('Disconnecting from Extended Exchange WebSocket...');
            // Указываем код 1000 для "нормального" закрытия соединения
            this.ws.close(1000, 'Client initiated stop');
            this.ws = null;
        } else {
            // Убираем вывод в консоль, чтобы не было спама, если сервис не был активен
            // console.warn('Attempted to stop a non-existent Extended Exchange WebSocket connection.');
        }
    }
}