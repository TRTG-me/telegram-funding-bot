import WebSocket from 'ws';

type PriceUpdateCallback = (bid: string, ask: string) => void;

export class HyperliquidTickerService {
    private ws: WebSocket | null = null;

    constructor() {
        console.log('HyperliquidTickerService initialized.');
    }

    /**
     * Запускает WebSocket-поток и возвращает Promise, который
     * разрешается при успехе или отклоняется при ошибке.
     */
    public start(symbol: string, callback: PriceUpdateCallback): Promise<void> {
        // --- ГЛАВНОЕ ИЗМЕНЕНИЕ: Оборачиваем всю логику в Promise ---
        return new Promise((resolve, reject) => {
            if (this.ws) {
                console.warn('Hyperliquid WebSocket connection is already active.');
                resolve(); // Если уже подключено, считаем это успехом.
                return;
            }

            this.ws = new WebSocket('wss://api.hyperliquid.xyz/ws');
            const currentConnection = this.ws;

            currentConnection.on('open', () => {
                console.log(`Connected to Hyperliquid WebSocket for ${symbol}.`);
                const subscriptionMessage = {
                    method: 'subscribe',
                    subscription: {
                        type: 'l2Book',
                        coin: symbol.toUpperCase()
                    },
                };
                currentConnection.send(JSON.stringify(subscriptionMessage));
                console.log('Subscription message sent:', JSON.stringify(subscriptionMessage));

                // --- СООБЩАЕМ ОБ УСПЕХЕ ---
                // Promise разрешается после успешного открытия и отправки подписки.
                resolve();
            });

            currentConnection.on('error', (error) => {
                console.error('Hyperliquid WebSocket error:', error);
                this.ws = null;
                // --- СООБЩАЕМ О ПРОВАЛЕ ---
                reject(error);
            });

            currentConnection.on('close', (code, reason) => {
                console.log(`Hyperliquid WebSocket disconnected: ${code} - ${reason.toString()}`);
                if (code !== 1000) { // 1000 - это нормальное закрытие через .stop()
                    // --- СООБЩАЕМ О ПРОВАЛЕ ---
                    reject(new Error(`Hyperliquid disconnected unexpectedly: ${code}`));
                }
                this.ws = null;
            });

            // Обработчик сообщений остается без изменений
            currentConnection.on('message', (data: WebSocket.Data) => {
                try {
                    const message = JSON.parse(data.toString());
                    if (message.channel === 'l2Book' && message.data) {
                        const bookData = message.data;
                        if (bookData.levels && bookData.levels.length === 2) {
                            const bestBid = bookData.levels[0][0].px;
                            const bestAsk = bookData.levels[1][0].px;
                            callback(bestBid, bestAsk);
                        }
                    }
                } catch (error) {
                    console.error('Error parsing Hyperliquid message:', error);
                }
            });
        });
    }

    public stop(): void {
        if (this.ws) {
            console.log('Disconnecting from Hyperliquid WebSocket...');
            // Указываем код 1000 для "нормального" закрытия соединения
            this.ws.close(1000, 'Client initiated stop');
            this.ws = null;
        } else {
            // Убираем вывод в консоль, чтобы не было спама, если сервис не был активен
            // console.warn('Attempted to stop a non-existent Hyperliquid WebSocket connection.');
        }
    }
}