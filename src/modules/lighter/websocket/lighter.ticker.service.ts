import WebSocket from 'ws';

// --- Новые интерфейсы для строгой типизации ---
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
    // --- НОВОЕ: Хранилище состояний ордербуков для каждого рынка ---
    private orderBookStates = new Map<string, OrderBook>();

    constructor() {
        console.log('LighterTickerService initialized.');
    }

    public start(marketIndex: string, callback: PriceUpdateCallback): void {
        if (this.ws) {
            console.warn('Lighter WebSocket connection is already active.');
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

        currentConnection.on('message', (data: WebSocket.Data) => {
            try {
                const message = JSON.parse(data.toString());
                const messageType = message.type;

                // --- НОВОЕ: Обработка сообщений как в Python SDK ---
                switch (messageType) {
                    case 'ping':
                        // --- ИСПРАВЛЕНИЕ: Отправляем JSON pong, а не фрейм ---
                        console.log('Received ping from Lighter, sending JSON pong.');
                        currentConnection.send(JSON.stringify({ type: 'pong' }));
                        break;

                    case 'subscribed/order_book':
                        // Это наш первоначальный снимок (snapshot)
                        console.log(`Received order book snapshot for market ${marketIndex}.`);
                        this.orderBookStates.set(marketIndex, message.order_book);
                        break;

                    case 'update/order_book':
                        // Это дельта (изменение)
                        this.handleOrderBookUpdate(marketIndex, message.order_book);
                        break;
                }

                // После любого обновления или снимка, отправляем лучшие цены
                const currentState = this.orderBookStates.get(marketIndex);
                if (currentState && currentState.bids.length > 0 && currentState.asks.length > 0) {
                    callback(currentState.bids[0].price, currentState.asks[0].price);
                }

            } catch (error) {
                console.error('Error parsing Lighter message:', error);
            }
        });

        currentConnection.on('close', (code, reason) => {
            console.log(`Lighter WebSocket disconnected: ${code} - ${reason.toString()}`);
            this.orderBookStates.delete(marketIndex); // Очищаем состояние
            this.ws = null;
        });

        currentConnection.on('error', (error) => {
            console.error('Lighter WebSocket error:', error);
            this.ws = null;
        });
    }

    // --- НОВЫЙ МЕТОД: Применение дельт к состоянию ордербука ---
    private handleOrderBookUpdate(marketIndex: string, delta: OrderBook): void {
        const currentState = this.orderBookStates.get(marketIndex);
        if (!currentState) {
            console.error(`Received update for market ${marketIndex}, but no initial state exists.`);
            return;
        }

        // Обновляем asks и bids
        this.updateSide(currentState.asks, delta.asks);
        this.updateSide(currentState.bids, delta.bids);

        // Пересортировываем, чтобы лучшие цены всегда были первыми
        currentState.asks.sort((a, b) => parseFloat(a.price) - parseFloat(b.price)); // Аски по возрастанию
        currentState.bids.sort((a, b) => parseFloat(b.price) - parseFloat(a.price)); // Биды по убыванию
    }

    // --- НОВЫЙ МЕТОД: Логика обновления одной стороны стакана (bids или asks) ---
    private updateSide(existingLevels: OrderLevel[], newLevels: OrderLevel[]): void {
        for (const newLevel of newLevels) {
            const index = existingLevels.findIndex(level => level.price === newLevel.price);

            if (index !== -1) {
                // Уровень цен уже существует, обновляем его размер
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
            this.ws.close();
            this.ws = null;
        } else {
            console.warn('Attempted to stop a non-existent Lighter WebSocket connection.');
        }
    }
}