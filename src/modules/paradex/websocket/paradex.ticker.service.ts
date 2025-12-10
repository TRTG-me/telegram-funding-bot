import WebSocket from 'ws';

type PriceUpdateCallback = (bid: string, ask: string) => void;

export class ParadexTickerService {
    private ws: WebSocket | null = null;
    private subscriptionId: number = 1;

    // Добавляем переменную для хранения текущего активного символа
    private activeSymbol: string | null = null;

    constructor() { }

    public start(symbol: string, callback: PriceUpdateCallback): Promise<void> {
        // Запоминаем, на что мы подписываемся (например, "BTC-USD-PERP")
        this.activeSymbol = symbol;

        return new Promise((resolve, reject) => {
            if (this.ws) {
                console.warn('Paradex WebSocket connection is already active. Re-subscribing...');
                // Если сокет уже есть, просто шлем новую подписку, но не пересоздаем сокет
                // Это лучше, чем просто игнорировать
                this.subscribe(symbol);
                resolve();
                return;
            }

            const connectionUrl = 'wss://ws.api.prod.paradex.trade/v1?/';
            this.ws = new WebSocket(connectionUrl);
            const currentConnection = this.ws;

            currentConnection.on('open', () => {
                console.log(`Connected to Paradex WebSocket for ${symbol}.`);
                this.subscribe(symbol);
                resolve();
            });

            currentConnection.on('error', (error) => {
                console.error('Paradex WebSocket error:', error);
                // Не обнуляем ws тут, чтобы close сработал и почистил всё
                reject(error);
            });

            currentConnection.on('close', (code, reason) => {
                console.log(`Paradex WebSocket disconnected: ${code} - ${reason.toString()}`);
                this.ws = null;
                this.activeSymbol = null; // Сбрасываем символ при отключении
            });

            currentConnection.on('message', (data: WebSocket.Data) => {
                try {
                    const message = JSON.parse(data.toString());

                    // Проверяем, что это сообщение подписки
                    if (message.method === 'subscription' && message.params) {

                        // === ФИЛЬТРАЦИЯ (ГЛАВНОЕ ИСПРАВЛЕНИЕ) ===
                        // Paradex присылает channel в формате "bbo.BTC-USD-PERP"
                        const incomingChannel = message.params.channel;
                        const expectedChannel = `bbo.${this.activeSymbol}`;

                        // Если данные пришли не по той монете, которую мы сейчас мониторим - ИГНОРИРУЕМ
                        if (incomingChannel !== expectedChannel) {
                            return;
                        }

                        if (message.params.data) {
                            const priceData = message.params.data;
                            const bestBid = priceData.bid;
                            const bestAsk = priceData.ask;
                            if (bestBid && bestAsk) {
                                callback(bestBid, bestAsk);
                            }
                        }
                    }
                } catch (error) {
                    console.error('Error parsing Paradex message:', error);
                }
            });
        });
    }

    // Вынес логику отправки сообщения в отдельный метод
    private subscribe(symbol: string) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        const subscriptionMessage = {
            jsonrpc: "2.0",
            method: "subscribe",
            params: { channel: `bbo.${symbol}` },
            id: this.subscriptionId++
        };
        this.ws.send(JSON.stringify(subscriptionMessage));
        // console.log('Paradex subscription sent:', symbol);
    }

    public stop(): void {
        if (this.ws) {
            console.log('Disconnecting from Paradex WebSocket...');

            // Пытаемся отписаться
            try {
                const unsubscribeMessage = {
                    jsonrpc: "2.0",
                    method: "unsubscribe_all",
                    params: {},
                    id: this.subscriptionId++
                };
                this.ws.send(JSON.stringify(unsubscribeMessage));
            } catch (e) {
                // Игнорируем ошибки при отправке в закрывающийся сокет
            }

            this.ws.close(1000, 'Client initiated stop');
            this.ws = null;
            this.activeSymbol = null;
        }
    }
}