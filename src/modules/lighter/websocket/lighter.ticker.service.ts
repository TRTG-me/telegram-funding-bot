import WebSocket from 'ws';

// --- Интерфейсы для строгой типизации ---
interface OrderLevel {
    price: string;
    size: string;
}

interface OrderBook {
    asks: OrderLevel[];
    bids: OrderLevel[];
}

type PriceUpdateCallback = (bid: string, ask: string) => void;

export class LighterTickerService {
    private ws: WebSocket | null = null;
    private orderBookStates = new Map<string, OrderBook>();

    constructor() {
        console.log('LighterTickerService initialized.');
    }

    /**
     * Запускает WebSocket-поток и возвращает Promise, который
     * разрешается при успехе или отклоняется при ошибке.
     */
    public start(marketIndex: string, callback: PriceUpdateCallback): Promise<void> {
        // --- ГЛАВНОЕ ИЗМЕНЕНИЕ: Оборачиваем всю логику в Promise ---
        return new Promise((resolve, reject) => {
            if (this.ws) {
                console.warn('Lighter WebSocket connection is already active.');
                resolve();
                return;
            }

            const connectionUrl = 'wss://mainnet.zklighter.elliot.ai/stream';
            this.ws = new WebSocket(connectionUrl);
            const currentConnection = this.ws;

            currentConnection.on('open', () => {
                console.log(`Successfully connected to Lighter WebSocket. Subscribing to market ${marketIndex}...`);
                const subscriptionMessage = {
                    type: "subscribe",
                    channel: `order_book/${marketIndex}`
                };
                currentConnection.send(JSON.stringify(subscriptionMessage));
            });

            currentConnection.on('error', (error) => {
                console.error('Lighter WebSocket error:', error);
                this.ws = null;
                // --- СООБЩАЕМ О ПРОВАЛЕ ---
                reject(error);
            });

            currentConnection.on('close', (code, reason) => {
                console.log(`Lighter WebSocket disconnected: ${code} - ${reason.toString()}`);
                this.orderBookStates.delete(marketIndex);
                if (code !== 1000) {
                    // --- СООБЩАЕМ О ПРОВАЛЕ ---
                    reject(new Error(`Lighter disconnected unexpectedly: ${code}`));
                }
                this.ws = null;
            });

            currentConnection.on('message', (data: WebSocket.Data) => {
                try {
                    const message = JSON.parse(data.toString());
                    const messageType = message.type;

                    switch (messageType) {
                        case 'ping':
                            currentConnection.send(JSON.stringify({ type: 'pong' }));
                            break;
                        case 'subscribed/order_book':
                            console.log(`Received order book snapshot for market ${marketIndex}. Subscription successful.`);
                            this.orderBookStates.set(marketIndex, message.order_book);
                            // --- СООБЩАЕМ ОБ УСПЕХЕ ---
                            // Promise разрешается только после получения первого снимка.
                            resolve();
                            break;
                        case 'update/order_book':
                            this.handleOrderBookUpdate(marketIndex, message.order_book);
                            break;
                    }

                    const currentState = this.orderBookStates.get(marketIndex);
                    if (currentState && currentState.bids.length > 0 && currentState.asks.length > 0) {
                        callback(currentState.bids[0].price, currentState.asks[0].price);
                    }
                } catch (error) {
                    console.error('Error parsing Lighter message:', error);
                }
            });
        });
    }

    private handleOrderBookUpdate(marketIndex: string, delta: OrderBook): void {
        const currentState = this.orderBookStates.get(marketIndex);
        if (!currentState) return;
        this.updateSide(currentState.asks, delta.asks);
        this.updateSide(currentState.bids, delta.bids);
        currentState.asks.sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
        currentState.bids.sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
    }

    private updateSide(existingLevels: OrderLevel[], newLevels: OrderLevel[]): void {
        for (const newLevel of newLevels) {
            const index = existingLevels.findIndex(level => level.price === newLevel.price);
            if (index !== -1) {
                if (parseFloat(newLevel.size) > 0) {
                    existingLevels[index].size = newLevel.size;
                } else {
                    existingLevels.splice(index, 1);
                }
            } else if (parseFloat(newLevel.size) > 0) {
                existingLevels.push(newLevel);
            }
        }
    }

    public stop(): void {
        if (this.ws) {
            console.log('Disconnecting from Lighter WebSocket...');
            this.ws.close(1000, 'Client initiated stop');
            this.ws = null;
        } else {
            // console.warn('Attempted to stop a non-existent Lighter WebSocket connection.');
        }
    }
}