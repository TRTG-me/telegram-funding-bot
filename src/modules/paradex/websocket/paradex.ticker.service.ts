import WebSocket from 'ws';

type PriceUpdateCallback = (bid: string, ask: string) => void;

export class ParadexTickerService {
    private ws: WebSocket | null = null;
    private subscriptionId: number = 1;

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
                console.warn('Paradex WebSocket connection is already active.');
                resolve(); // Если уже подключено, считаем это успехом.
                return;
            }

            const connectionUrl = 'wss://ws.api.prod.paradex.trade/v1?/';
            this.ws = new WebSocket(connectionUrl);
            const currentConnection = this.ws;

            currentConnection.on('open', () => {
                console.log(`Connected to Paradex WebSocket for ${symbol}.`);
                const subscriptionMessage = {
                    jsonrpc: "2.0",
                    method: "subscribe",
                    params: { channel: `bbo.${symbol}` },
                    id: this.subscriptionId++
                };
                currentConnection.send(JSON.stringify(subscriptionMessage));
                console.log('Paradex subscription message sent:', JSON.stringify(subscriptionMessage));

                // --- СООБЩАЕМ ОБ УСПЕХЕ ---
                // Promise разрешается после успешного открытия и отправки подписки.
                resolve();
            });

            currentConnection.on('error', (error) => {
                console.error('Paradex WebSocket error:', error);
                this.ws = null;
                // --- СООБЩАЕМ О ПРОВАЛЕ ---
                reject(error);
            });

            currentConnection.on('close', (code, reason) => {
                console.log(`Paradex WebSocket disconnected: ${code} - ${reason.toString()}`);
                if (code !== 1000) { // 1000 - это нормальное закрытие через .stop()
                    // --- СООБЩАЕМ О ПРОВАЛЕ ---
                    reject(new Error(`Paradex disconnected unexpectedly: ${code}`));
                }
                this.ws = null;
            });

            // Обработчик сообщений остается без изменений
            currentConnection.on('message', (data: WebSocket.Data) => {
                try {
                    const message = JSON.parse(data.toString());
                    if (message.method === 'subscription' && message.params && message.params.data) {
                        const priceData = message.params.data;
                        const bestBid = priceData.bid;
                        const bestAsk = priceData.ask;
                        if (bestBid && bestAsk) {
                            callback(bestBid, bestAsk);
                        }
                    }
                } catch (error) {
                    console.error('Error parsing Paradex message:', error);
                }
            });
        });
    }

    public stop(): void {
        if (this.ws) {
            console.log('Disconnecting from Paradex WebSocket...');
            // Отправляем сообщение об отписке перед закрытием
            const unsubscribeMessage = {
                jsonrpc: "2.0",
                method: "unsubscribe_all",
                params: {},
                id: this.subscriptionId++
            };
            this.ws.send(JSON.stringify(unsubscribeMessage));

            // Указываем код 1000 для "нормального" закрытия соединения
            this.ws.close(1000, 'Client initiated stop');
            this.ws = null;
        } else {
            // console.warn('Attempted to stop a non-existent Paradex WebSocket connection.');
        }
    }
}