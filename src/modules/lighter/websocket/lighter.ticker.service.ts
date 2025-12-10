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

    // Добавляем переменную для хранения текущего активного ID маркета
    private activeMarketIndex: string | null = null;

    constructor() { }

    public start(marketIndex: string, callback: PriceUpdateCallback): Promise<void> {
        return new Promise((resolve, reject) => {
            // 1. УПРАВЛЕНИЕ СОЕДИНЕНИЕМ
            if (this.ws) {
                // Если уже подписаны на ТОТ ЖЕ маркет - всё ок
                if (this.activeMarketIndex === marketIndex && this.ws.readyState === WebSocket.OPEN) {
                    console.log(`Lighter WebSocket already connected to market ${marketIndex}.`);
                    resolve();
                    return;
                }

                // Если маркет ДРУГОЙ - закрываем старый сокет
                console.log(`Switching Lighter from ${this.activeMarketIndex} to ${marketIndex}. Reconnecting...`);
                this.stop();
            }

            // 2. ЗАПОМИНАЕМ НОВЫЙ МАРКЕТ
            this.activeMarketIndex = marketIndex;

            // Очищаем старое состояние стакана для нового маркета, чтобы начать с чистого листа
            this.orderBookStates.delete(marketIndex);

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
                // Защита: если пока коннектились, уже нажали стоп или сменили монету
                if (this.activeMarketIndex !== marketIndex) {
                    currentConnection.close();
                    return;
                }

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
                this.activeMarketIndex = null;
                reject(error);
            });

            currentConnection.on('close', (code, reason) => {
                console.log(`Lighter WebSocket disconnected: ${code} - ${reason.toString()}`);
                this.orderBookStates.delete(marketIndex);

                if (this.ws === currentConnection) {
                    this.ws = null;
                    this.activeMarketIndex = null;
                }

                if (code !== 1000) {
                    // reject сработает только при ошибке на этапе подключения
                }
            });

            currentConnection.on('message', (data: WebSocket.Data) => {
                // === ФИЛЬТРАЦИЯ ===
                // Если данные пришли для старого маркета (гонка данных) - игнорируем
                if (this.activeMarketIndex !== marketIndex) return;

                try {
                    const message = JSON.parse(data.toString());
                    const messageType = message.type;

                    switch (messageType) {
                        case 'ping':
                            currentConnection.send(JSON.stringify({ type: 'pong' }));
                            break;

                        case 'subscribed/order_book':
                            // Первоначальный снимок
                            console.log(`Received order book snapshot for market ${marketIndex}.`);
                            this.orderBookStates.set(marketIndex, message.order_book);
                            resolve(); // Успех
                            break;

                        case 'update/order_book':
                            // Дельта
                            this.handleOrderBookUpdate(marketIndex, message.order_book);
                            break;
                    }

                    // Отправка данных
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
        if (!currentState) {
            // Если пришел апдейт, а снепшота еще нет - игнорируем
            return;
        }

        this.updateSide(currentState.asks, delta.asks);
        this.updateSide(currentState.bids, delta.bids);

        // Пересортировка
        currentState.asks.sort((a, b) => parseFloat(a.price) - parseFloat(b.price)); // Аски по возрастанию
        currentState.bids.sort((a, b) => parseFloat(b.price) - parseFloat(a.price)); // Биды по убыванию
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
            this.ws.removeAllListeners();
            this.ws.close(1000, 'Client initiated stop');
            this.ws = null;
            this.activeMarketIndex = null;
            this.orderBookStates.clear();
        }
    }
}