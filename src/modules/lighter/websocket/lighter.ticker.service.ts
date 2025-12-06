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
    // Хранилище состояний ордербуков для каждого рынка
    private orderBookStates = new Map<string, OrderBook>();

    constructor() {

    }

    public start(marketIndex: string, callback: PriceUpdateCallback): Promise<void> {
        return new Promise((resolve, reject) => {
            if (this.ws) {
                console.warn('Lighter WebSocket connection is already active.');
                resolve();
                return;
            }

            const connectionUrl = 'wss://mainnet.zklighter.elliot.ai/stream';
            const options = {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.36',
                    'Origin': 'https://mainnet.zklighter.elliot.ai'
                }
            };

            this.ws = new WebSocket(connectionUrl, options);
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
                reject(error);
            });

            currentConnection.on('close', (code, reason) => {
                console.log(`Lighter WebSocket disconnected: ${code} - ${reason.toString()}`);
                this.orderBookStates.delete(marketIndex);
                if (code !== 1000) {
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
                            // Это наш первоначальный снимок (snapshot), сохраняем его
                            console.log(`Received order book snapshot for market ${marketIndex}. Subscription successful.`);
                            this.orderBookStates.set(marketIndex, message.order_book);
                            resolve(); // Сообщаем об успехе только после получения снимка
                            break;

                        case 'update/order_book':
                            // Это дельта (изменение), применяем ее к нашему состоянию
                            this.handleOrderBookUpdate(marketIndex, message.order_book);
                            break;
                    }

                    const currentState = this.orderBookStates.get(marketIndex);
                    if (currentState && currentState.bids.length > 0 && currentState.asks.length > 0) {
                        // Отправляем лучшие цены из ОБНОВЛЕННОГО И ОТСОРТИРОВАННОГО стакана
                        callback(currentState.bids[0].price, currentState.asks[0].price);
                    }
                } catch (error) {
                    console.error('Error parsing Lighter message:', error);
                }
            });
        });
    }

    // --- ВОЗВРАЩАЕМ ЛОГИКУ ОБРАБОТКИ ДЕЛЬТ ---
    private handleOrderBookUpdate(marketIndex: string, delta: OrderBook): void {
        const currentState = this.orderBookStates.get(marketIndex);
        if (!currentState) {
            console.error(`Received update for market ${marketIndex}, but no initial state exists.`);
            return;
        }

        // Применяем изменения к asks и bids
        this.updateSide(currentState.asks, delta.asks);
        this.updateSide(currentState.bids, delta.bids);

        // **КРИТИЧЕСКИ ВАЖНЫЙ ШАГ**: Пересортировываем стакан после каждого обновления
        currentState.asks.sort((a, b) => parseFloat(a.price) - parseFloat(b.price)); // Аски по возрастанию
        currentState.bids.sort((a, b) => parseFloat(b.price) - parseFloat(a.price)); // Биды по убыванию
    }

    private updateSide(existingLevels: OrderLevel[], newLevels: OrderLevel[]): void {
        for (const newLevel of newLevels) {
            const index = existingLevels.findIndex(level => level.price === newLevel.price);

            if (index !== -1) {
                // Уровень цен уже существует, обновляем его
                if (parseFloat(newLevel.size) > 0) {
                    existingLevels[index].size = newLevel.size;
                } else {
                    // Если размер 0, удаляем этот уровень цен
                    existingLevels.splice(index, 1);
                }
            } else if (parseFloat(newLevel.size) > 0) {
                // Это новый уровень цен, добавляем его
                existingLevels.push(newLevel);
            }
        }
    }

    public stop(): void {
        if (this.ws) {
            console.log('Disconnecting from Lighter WebSocket...');
            this.ws.close(1000, 'Client initiated stop');
            this.ws = null;
        }
    }
}